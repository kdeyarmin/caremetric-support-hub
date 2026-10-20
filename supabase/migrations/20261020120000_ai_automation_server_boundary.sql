-- The AI auto-resolution loop through the Hub server role.
--
-- The loop (server/ai-automation.mjs) runs on the Hub server pool, which connects as
-- hub_app_server: noinherit, nobypassrls, and granted only the SMS and delegation
-- tables. It holds no privilege on support cases, messages, notes, the automation
-- state, published content or the audit log, so every raw query the loop issued
-- failed with "permission denied" and the sweep only logged that it would retry.
--
-- The server role's table privileges stay exactly as they are. Instead the loop gets
-- one narrow security definer operation per store step, executable by hub_app_server
-- only and refusing every other session user:
--   * eligible_cases / claim apply the eligibility rules themselves (recent portal
--     case, still open, no staff reply yet, never automated before);
--   * every later step acts only on a case that is already under automation, at the
--     stage where that step belongs in the loop;
--   * every write is authored by the AI assistant identity, never a human staffer;
--   * automation state keeps its rules here: finished stages are final and the
--     attempt count never decreases (the two-attempt cap is the table constraint).
--
-- Automation stays OFF after this migration: the server loop only runs when
-- HUB_AI_AUTOMATION_ENABLED=true and ANTHROPIC_API_KEY is configured.

create function private.ai_automation_case_eligible(p_case_id uuid)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select exists (
    select 1
    from hub.support_cases support_case
    where support_case.id = p_case_id
      and support_case.source = 'portal'
      and support_case.status in ('open', 'in_progress')
      and support_case.created_at > now() - interval '7 days'
      and not exists (select 1 from hub.case_ai_automation automation where automation.case_id = support_case.id)
      and not exists (
        select 1 from hub.case_messages message
        where message.case_id = support_case.id
          and message.author_role in ('support_agent', 'support_manager', 'platform_admin')
      )
  );
$$;

-- Locks and returns the automation state of a case, or raises when the case is not
-- under automation or not at one of the stages where the calling step belongs.
create function private.ai_automation_state_for_step(p_case_id uuid, p_stages text[])
returns hub.case_ai_automation
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_state hub.case_ai_automation%rowtype;
begin
  select * into v_state
  from hub.case_ai_automation
  where case_id = p_case_id
  for update;
  if not found then
    raise exception 'This support case is not under AI automation.' using errcode = 'P0001';
  end if;
  if not (v_state.stage = any (p_stages)) then
    raise exception 'AI automation on this case is not at a stage that allows this step.' using errcode = 'P0001';
  end if;
  return v_state;
end;
$$;

create function private.ai_automation_eligible_cases()
returns setof uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if session_user <> 'hub_app_server' then
    raise exception 'Application server required.' using errcode = '42501';
  end if;
  return query
  select support_case.id
  from hub.support_cases support_case
  where support_case.source = 'portal'
    and support_case.status in ('open', 'in_progress')
    and support_case.created_at > now() - interval '7 days'
    and private.ai_automation_case_eligible(support_case.id)
  order by support_case.created_at asc, support_case.id asc
  limit 10;
end;
$$;

create function private.ai_automation_claim(p_case_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_claimed integer;
begin
  if session_user <> 'hub_app_server' then
    raise exception 'Application server required.' using errcode = '42501';
  end if;
  if not private.ai_automation_case_eligible(p_case_id) then
    return false;
  end if;
  insert into hub.case_ai_automation (case_id)
  values (p_case_id)
  on conflict (case_id) do nothing;
  get diagnostics v_claimed = row_count;
  return v_claimed > 0;
end;
$$;

create function private.ai_automation_active_cases()
returns setof uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if session_user <> 'hub_app_server' then
    raise exception 'Application server required.' using errcode = '42501';
  end if;
  return query
  select automation.case_id
  from hub.case_ai_automation automation
  where automation.stage in ('attempt_due', 'awaiting_response', 'escalate_due')
  order by automation.updated_at asc, automation.case_id asc
  limit 25;
end;
$$;

-- The case, its loop state and its full thread (customer messages and internal
-- notes), for a case under automation only. Null for any other case.
create function private.ai_automation_work(p_case_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_state hub.case_ai_automation%rowtype;
  v_case hub.support_cases%rowtype;
begin
  if session_user <> 'hub_app_server' then
    raise exception 'Application server required.' using errcode = '42501';
  end if;
  select * into v_state from hub.case_ai_automation where case_id = p_case_id;
  if not found then
    return null;
  end if;
  select * into v_case from hub.support_cases where id = p_case_id;
  if not found then
    return null;
  end if;
  return jsonb_build_object(
    'caseId', v_case.id,
    'subject', v_case.subject,
    'productId', v_case.product_id,
    'status', v_case.status,
    'priority', v_case.priority,
    'state', jsonb_build_object(
      'stage', v_state.stage,
      'attempts', v_state.attempts,
      'lastSeenCustomerMessageId', v_state.last_seen_customer_message_id,
      'lastCustomerResponse', v_state.last_customer_response,
      'followUpDueAt', v_state.follow_up_due_at,
      'followUpSentAt', v_state.follow_up_sent_at
    ),
    'messages', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', message.id,
        'authorId', message.author_id,
        'authorName', message.author_display_name,
        'authorRole', message.author_role,
        'body', message.body,
        'createdAt', message.created_at
      ) order by message.created_at, message.id)
      from hub.case_messages message
      where message.case_id = p_case_id
    ), '[]'::jsonb),
    'notes', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', note.id,
        'authorName', note.author_display_name,
        'authorRole', note.author_role,
        'body', note.body,
        'createdAt', note.created_at
      ) order by note.created_at, note.id)
      from private.case_notes note
      where note.case_id = p_case_id
    ), '[]'::jsonb)
  );
end;
$$;

-- The list_published_content publication filters for the case's product, restricted
-- to customer-safe articles: automated replies must never draw on staff-only content,
-- and there is no caller session to scope access with here.
create function private.ai_automation_knowledge(p_case_id uuid)
returns table (title text, summary text, body text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if session_user <> 'hub_app_server' then
    raise exception 'Application server required.' using errcode = '42501';
  end if;
  return query
  select revision.title, revision.summary, revision.body_markdown
  from hub.case_ai_automation automation
  join hub.support_cases support_case on support_case.id = automation.case_id
  join hub.content_publications publication on publication.product_id = support_case.product_id
  join hub.content_items item on item.id = publication.item_id
  join hub.content_revisions revision on revision.id = publication.revision_id and revision.item_id = publication.item_id
  join hub.products product on product.id = publication.product_id
  where automation.case_id = p_case_id
    and item.status = 'published'
    and revision.review_state = 'approved'
    and product.status <> 'retired' and product.support_enabled
    and (revision.product_overlay_id is null or revision.product_overlay_id = publication.product_id)
    and publication.published_at <= now()
    and (publication.expires_at is null or publication.expires_at > now())
    and item.access_level in ('public', 'customer')
    and item.kind = 'article'
  order by publication.published_at desc
  limit 12;
end;
$$;

-- An automated attempt or follow-up nudge, posted to the customer as the AI
-- assistant. Never on a resolved or closed case.
create function private.ai_automation_post_message(p_case_id uuid, p_body text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status hub.case_status;
  v_message_id uuid;
begin
  if session_user <> 'hub_app_server' then
    raise exception 'Application server required.' using errcode = '42501';
  end if;
  if p_body is null or char_length(btrim(p_body)) = 0 or char_length(p_body) > 5000 then
    raise exception 'An automated reply of 1 to 5000 characters is required.' using errcode = '22023';
  end if;
  perform private.ai_automation_state_for_step(p_case_id, array['attempt_due', 'awaiting_response']);
  select status into v_status from hub.support_cases where id = p_case_id for update;
  if v_status in ('resolved', 'closed') then
    raise exception 'Automated replies are never posted on a resolved or closed case.' using errcode = 'P0001';
  end if;

  insert into hub.case_messages (case_id, author_id, author_display_name, author_role, body)
  values (p_case_id, 'a1a00000-a1a0-4000-8000-000000000001', 'CareMetric AI Assistant', 'ai_assistant', p_body)
  returning id into v_message_id;

  update hub.support_cases
  set last_message_at = now(),
      status = case when status in ('open', 'in_progress') then 'waiting_on_customer'::hub.case_status else status end
  where id = p_case_id;

  return v_message_id;
end;
$$;

-- The internal escalation note for staff, posted as the AI assistant.
create function private.ai_automation_post_note(p_case_id uuid, p_body text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_note_id uuid;
begin
  if session_user <> 'hub_app_server' then
    raise exception 'Application server required.' using errcode = '42501';
  end if;
  if p_body is null or char_length(btrim(p_body)) = 0 or char_length(p_body) > 5000 then
    raise exception 'An escalation note of 1 to 5000 characters is required.' using errcode = '22023';
  end if;
  perform private.ai_automation_state_for_step(p_case_id, array['attempt_due', 'escalate_due']);

  insert into private.case_notes (case_id, author_id, author_display_name, author_role, body)
  values (p_case_id, 'a1a00000-a1a0-4000-8000-000000000001', 'CareMetric AI Assistant', 'ai_assistant', p_body)
  returning id into v_note_id;

  return v_note_id;
end;
$$;

-- Hands the case to staff: back in progress at high priority, audited as the AI
-- assistant. A resolved or closed case is left as it is.
create function private.ai_automation_escalate(p_case_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_case hub.support_cases%rowtype;
begin
  if session_user <> 'hub_app_server' then
    raise exception 'Application server required.' using errcode = '42501';
  end if;
  perform private.ai_automation_state_for_step(p_case_id, array['attempt_due', 'escalate_due']);

  update hub.support_cases
  set status = 'in_progress'::hub.case_status,
      priority = 'high'::hub.case_priority,
      resolved_at = null
  where id = p_case_id
    and status not in ('resolved', 'closed')
  returning * into v_case;
  if not found then
    return;
  end if;

  insert into private.audit_events (actor_id, action, entity_type, entity_id, tenant_id, product_id, case_id, changed_columns)
  values ('a1a00000-a1a0-4000-8000-000000000001', 'case.updated', 'support_case', v_case.id,
          v_case.tenant_id, v_case.product_id, v_case.id, array['status', 'priority']);
end;
$$;

-- Resolves the case after the customer's reply was classified as fixed, audited as
-- the AI assistant. A resolved or closed case is left as it is.
create function private.ai_automation_resolve(p_case_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_case hub.support_cases%rowtype;
begin
  if session_user <> 'hub_app_server' then
    raise exception 'Application server required.' using errcode = '42501';
  end if;
  perform private.ai_automation_state_for_step(p_case_id, array['awaiting_response']);

  update hub.support_cases
  set status = 'resolved'::hub.case_status,
      resolved_at = coalesce(resolved_at, now())
  where id = p_case_id
    and status not in ('resolved', 'closed')
  returning * into v_case;
  if not found then
    return;
  end if;

  insert into private.audit_events (actor_id, action, entity_type, entity_id, tenant_id, product_id, case_id, changed_columns)
  values ('a1a00000-a1a0-4000-8000-000000000001', 'case.ai_auto_resolved', 'support_case', v_case.id,
          v_case.tenant_id, v_case.product_id, v_case.id, array['status']);
end;
$$;

-- Records a loop transition: the classification outcome, an attempt, a follow-up, an
-- escalation or a halt. Only the named loop fields can change, a finished stage is
-- final, the attempt count never decreases, and referenced messages must belong to
-- this case.
create function private.ai_automation_save_state(p_case_id uuid, p_patch jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_state hub.case_ai_automation%rowtype;
  v_next hub.case_ai_automation%rowtype;
  v_field text;
begin
  if session_user <> 'hub_app_server' then
    raise exception 'Application server required.' using errcode = '42501';
  end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then
    raise exception 'An automation state change is required.' using errcode = '22023';
  end if;
  for v_field in select jsonb_object_keys(p_patch) loop
    if v_field <> all (array[
      'stage', 'attempts', 'lastAttemptAt', 'lastAiMessageId', 'lastSeenCustomerMessageId',
      'lastCustomerResponse', 'followUpDueAt', 'followUpSentAt', 'respondedAt', 'responseSource',
      'escalatedAt', 'haltReason'
    ]) then
      raise exception 'Unsupported automation state field.' using errcode = '22023';
    end if;
  end loop;

  v_state := private.ai_automation_state_for_step(p_case_id, array['attempt_due', 'awaiting_response', 'escalate_due']);
  v_next := v_state;
  if p_patch ? 'stage' then v_next.stage := p_patch ->> 'stage'; end if;
  if p_patch ? 'attempts' then v_next.attempts := (p_patch ->> 'attempts')::integer; end if;
  if p_patch ? 'lastAttemptAt' then v_next.last_attempt_at := (p_patch ->> 'lastAttemptAt')::timestamptz; end if;
  if p_patch ? 'lastAiMessageId' then v_next.last_ai_message_id := (p_patch ->> 'lastAiMessageId')::uuid; end if;
  if p_patch ? 'lastSeenCustomerMessageId' then v_next.last_seen_customer_message_id := (p_patch ->> 'lastSeenCustomerMessageId')::uuid; end if;
  if p_patch ? 'lastCustomerResponse' then v_next.last_customer_response := p_patch ->> 'lastCustomerResponse'; end if;
  if p_patch ? 'followUpDueAt' then v_next.follow_up_due_at := (p_patch ->> 'followUpDueAt')::timestamptz; end if;
  if p_patch ? 'followUpSentAt' then v_next.follow_up_sent_at := (p_patch ->> 'followUpSentAt')::timestamptz; end if;
  if p_patch ? 'respondedAt' then v_next.responded_at := (p_patch ->> 'respondedAt')::timestamptz; end if;
  if p_patch ? 'responseSource' then v_next.response_source := p_patch ->> 'responseSource'; end if;
  if p_patch ? 'escalatedAt' then v_next.escalated_at := (p_patch ->> 'escalatedAt')::timestamptz; end if;
  if p_patch ? 'haltReason' then v_next.halt_reason := p_patch ->> 'haltReason'; end if;

  if v_next.attempts is null or v_next.attempts < v_state.attempts then
    raise exception 'Automated attempts never decrease.' using errcode = '22023';
  end if;
  if v_next.last_ai_message_id is distinct from v_state.last_ai_message_id
     and v_next.last_ai_message_id is not null
     and not exists (
       select 1 from hub.case_messages message
       where message.id = v_next.last_ai_message_id
         and message.case_id = p_case_id
         and message.author_role = 'ai_assistant'
     ) then
    raise exception 'The automated reply must belong to this case.' using errcode = '22023';
  end if;
  if v_next.last_seen_customer_message_id is distinct from v_state.last_seen_customer_message_id
     and v_next.last_seen_customer_message_id is not null
     and not exists (
       select 1 from hub.case_messages message
       where message.id = v_next.last_seen_customer_message_id
         and message.case_id = p_case_id
     ) then
    raise exception 'The customer message must belong to this case.' using errcode = '22023';
  end if;

  update hub.case_ai_automation
  set stage = v_next.stage,
      attempts = v_next.attempts,
      last_attempt_at = v_next.last_attempt_at,
      last_ai_message_id = v_next.last_ai_message_id,
      last_seen_customer_message_id = v_next.last_seen_customer_message_id,
      last_customer_response = v_next.last_customer_response,
      follow_up_due_at = v_next.follow_up_due_at,
      follow_up_sent_at = v_next.follow_up_sent_at,
      responded_at = v_next.responded_at,
      response_source = v_next.response_source,
      escalated_at = v_next.escalated_at,
      halt_reason = v_next.halt_reason
  where case_id = p_case_id;
end;
$$;

revoke all on function
  private.ai_automation_case_eligible(uuid),
  private.ai_automation_state_for_step(uuid, text[]),
  private.ai_automation_eligible_cases(),
  private.ai_automation_claim(uuid),
  private.ai_automation_active_cases(),
  private.ai_automation_work(uuid),
  private.ai_automation_knowledge(uuid),
  private.ai_automation_post_message(uuid, text),
  private.ai_automation_post_note(uuid, text),
  private.ai_automation_escalate(uuid),
  private.ai_automation_resolve(uuid),
  private.ai_automation_save_state(uuid, jsonb)
from public, anon, authenticated, service_role, hub_app_server;

grant execute on function
  private.ai_automation_eligible_cases(),
  private.ai_automation_claim(uuid),
  private.ai_automation_active_cases(),
  private.ai_automation_work(uuid),
  private.ai_automation_knowledge(uuid),
  private.ai_automation_post_message(uuid, text),
  private.ai_automation_post_note(uuid, text),
  private.ai_automation_escalate(uuid),
  private.ai_automation_resolve(uuid),
  private.ai_automation_save_state(uuid, jsonb)
to hub_app_server;
