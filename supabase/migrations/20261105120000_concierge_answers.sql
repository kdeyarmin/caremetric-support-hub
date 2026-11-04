-- Support answers the AI team sends on its own. The owner chose (2026-11-04) to let the Support Concierge answer questions its
-- published guides cover without asking, after a supervised week (the "support_answers" autonomy step adds this kind to its list).
--
-- An answer is its own action kind, `communication.answer`, kept apart from `communication.reply` (which stays the reply the owner
-- sends with their own session: fixed acknowledgments, the patient-information template, and anything an answer may not be).
-- The database decides what may be an answer at all: drafted by the model from the guides, citing at least one, with no identifier
-- found in the customer's message, going back by email or chat. Anything else cannot be stored as this kind.
--
-- An answer is recorded in the conversation as written by the CareMetric AI Assistant (not as the owner), before it is sent, under the
-- action's request key, so a retry can never send twice. Approved by the owner during the supervised week, or approved automatically
-- once the step is automatic, it goes out without the owner's session; the operation below checks again, inside the same
-- transaction, that it may: the Concierge is still trusted with answers (when nobody approved it), the conversation is not closed,
-- and the customer has not written again since the answer was drafted.

-- ---------------------------------------------------------------------------------------
-- 1. The action kind. The kind check is widened, never narrowed (read from the constraint itself, as every earlier change did).
-- ---------------------------------------------------------------------------------------
do $$
declare
  v_kinds text[];
begin
  select coalesce(array_agg(distinct m[1]), array[]::text[]) into v_kinds
  from pg_constraint c cross join lateral regexp_matches(pg_get_constraintdef(c.oid), '''([^'']+)''', 'g') m
  where c.conrelid = 'private.agent_actions'::regclass and c.conname = 'agent_actions_kind_check';
  if not v_kinds @> array['communication.reply', 'communication.note', 'communication.update', 'incident.open', 'incident.resolve', 'import.run']
    or exists (select 1 from unnest(v_kinds) value where value !~ '^[a-z][a-z0-9_.]{1,60}$') then
    raise exception 'The agent action kinds could not be read' using errcode = '55000';
  end if;
  execute format('alter table private.agent_actions drop constraint agent_actions_kind_check, add constraint agent_actions_kind_check check (kind in (%s))',
    (select string_agg(quote_literal(k), ', ' order by k) from (select distinct unnest(v_kinds || array['communication.answer']) as k) x));
end $$;

-- What an answer is. Exactly these facts; a missing one fails the check (coalesce) instead of passing as unknown.
alter table private.agent_actions add constraint agent_actions_communication_answer_check check (
  kind <> 'communication.answer' or coalesce(
    target_kind = 'communication'
    and (input - array['communicationId', 'reference', 'channel', 'route', 'basedOnMessageId', 'body', 'classification', 'template', 'sources']) = '{}'::jsonb
    and input ->> 'template' = 'drafted'
    and input -> 'classification' ->> 'drafted' = 'true'
    and input -> 'classification' ->> 'phi' = 'false'
    and jsonb_typeof(input -> 'sources') = 'array' and jsonb_array_length(input -> 'sources') between 1 and 5
    and input ->> 'route' in ('email', 'chat')
    and coalesce(input ->> 'communicationId', '') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and coalesce(input ->> 'basedOnMessageId', '') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and jsonb_typeof(input -> 'reference') = 'number' and target_id = 'CM-' || (input ->> 'reference')
    and char_length(coalesce(input ->> 'body', '')) between 1 and 5000, false));

-- ---------------------------------------------------------------------------------------
-- 2. Recording an answer before it is sent (server only). Returns what to send, the earlier attempt to settle, or why not.
-- ---------------------------------------------------------------------------------------
create function private.agent_answer_begin(p_action_id uuid, p_execution integer, p_available text[]) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_action private.agent_actions%rowtype;
  v_agent private.agents%rowtype;
  v_communication private.communications%rowtype;
  v_existing private.communication_messages%rowtype;
  v_head uuid;
  v_route text;
  v_to text;
  v_message uuid;
  v_author constant uuid := 'a1a00000-a1a0-4000-8000-000000000001';
begin
  perform private.require_hub_app_server();
  select * into v_action from private.agent_actions where id = p_action_id for update;
  if not found or v_action.kind <> 'communication.answer' then
    raise exception 'Unknown answer.' using errcode = 'P0002';
  end if;
  if v_action.status <> 'executing' or (p_execution is not null and v_action.executions <> p_execution) then
    raise exception 'That answer is not being sent.' using errcode = '55000';
  end if;
  select * into v_communication from private.communications where id = (v_action.input ->> 'communicationId')::uuid for update;
  if not found then
    return jsonb_build_object('state', 'refused', 'code', 'conversation_missing');
  end if;
  -- An answer already recorded under this action's key is settled, whatever the thread has done since: it was written for the thread as it was.
  select * into v_existing from private.communication_messages m where m.communication_id = v_communication.id and m.request_key = v_action.request_key;
  if found then
    return jsonb_build_object('state', 'replay', 'messageId', v_existing.id, 'delivery', v_existing.delivery, 'deliveryChannel', v_existing.delivery_channel);
  end if;
  -- Nobody approved it: the Concierge must still be trusted with answers, now, not only when it proposed this one.
  if v_action.decided_by is null then
    select * into v_agent from private.agents where key = v_action.agent_key;
    if v_agent.status is distinct from 'active' or v_agent.autonomy is distinct from 'act'
      or jsonb_typeof(v_agent.config -> 'auto_approve_kinds') is distinct from 'array'
      or not ((v_agent.config -> 'auto_approve_kinds') ? 'communication.answer') then
      return jsonb_build_object('state', 'refused', 'code', 'answers_off');
    end if;
  end if;
  if v_communication.status = 'closed' then
    return jsonb_build_object('state', 'refused', 'code', 'conversation_closed');
  end if;
  -- The customer must not have written again (and nobody else answered) since the answer was drafted.
  select m.id into v_head from private.communication_messages m
  where m.communication_id = v_communication.id and m.direction in ('inbound', 'outbound')
  order by m.created_at desc, m.id desc limit 1;
  if v_head is distinct from (v_action.input ->> 'basedOnMessageId')::uuid then
    return jsonb_build_object('state', 'refused', 'code', 'thread_changed');
  end if;
  -- The route drafted for must still be the conversation's own and available: chat answers a chat; email needs an address and a sender.
  v_route := v_action.input ->> 'route';
  if v_route = 'chat' and v_communication.channel = 'chat' then
    v_to := null;
  elsif v_route = 'email' and v_communication.channel <> 'chat' and v_communication.contact_email is not null and 'email' = any(coalesce(p_available, '{}')) then
    v_to := v_communication.contact_email;
  else
    return jsonb_build_object('state', 'refused', 'code', 'reply_refused');
  end if;
  insert into private.communication_messages(communication_id, direction, body, author_id, author_name, delivery, delivery_channel, request_key)
  values (v_communication.id, 'outbound', v_action.input ->> 'body', v_author, (select display_name from hub.profiles where id = v_author),
    case when v_route = 'chat' then 'sent' else 'pending' end, v_route, v_action.request_key)
  returning id into v_message;
  update private.communications set status = 'waiting', last_message_at = clock_timestamp(), updated_at = clock_timestamp() where id = v_communication.id;
  insert into private.audit_events(actor_id, action, entity_type, entity_id, metadata)
  values (v_author, 'communication.reply', 'communication', v_communication.id, jsonb_build_object('message_id', v_message, 'channel', v_route,
    'agent', v_action.agent_key, 'action_id', v_action.id, 'approved', case when v_action.decided_by is null then 'automatic' else 'owner' end));
  return jsonb_build_object('state', 'ready', 'messageId', v_message, 'delivery', case when v_route = 'chat' then 'sent' else 'pending' end,
    'deliveryChannel', v_route, 'to', v_to, 'reference', v_communication.reference, 'channel', v_communication.channel, 'body', v_action.input ->> 'body');
end;
$$;
revoke all on function private.agent_answer_begin(uuid, integer, text[]) from public, anon, authenticated, service_role, hub_app_server;
grant execute on function private.agent_answer_begin(uuid, integer, text[]) to hub_app_server;
