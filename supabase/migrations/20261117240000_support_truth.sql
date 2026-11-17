-- Answer people, and tell the owner the truth (AI workforce review 2026-11-17, team review, stage 5;
-- docs/AI_WORKFORCE_REVIEW_2026-11-17_TEAM.md).
--
-- 1. The support acknowledgment can go out on its own. A new action kind, `communication.acknowledge`, admits only the Concierge's
--    standard acknowledgment, word for word, to a conversation by email or chat, with no identifier found. It is proposed only while
--    Settings -> AI team -> "Send the support acknowledgment on its own" is on (agents.auto_acknowledge, off until the owner turns it on),
--    and the support answers step hands it over with the answers (added to the Concierge's list now if that step is already automatic).
--    private.agent_acknowledge_begin records it as the CareMetric AI Assistant before it is sent, as answers are, and checks again that
--    it may go: the switch is on (for one nobody approved), the Concierge is still trusted with it, the conversation is open and has not
--    moved, and the sender is a person (not a machine, the Hub itself, a colleague, or an answer to the owner's own email).
-- 2. An acknowledgment is not an answer: the lead waiting for its first reply, the reminders and the first-reply figure no longer count
--    the fixed acknowledgment (standard or sales) as the reply (private.agent_growth_acknowledgment).
-- 3. The Concierge's snapshot says whether the sender's billing account is in a trial or paying (flags only, never the address), so a
--    customer's question that says "trial" is not filed as a sale.
-- 4. Customer success plans a self-service trial's customer emails already cover (onboarding, activation, trial) and that cannot be
--    sent (no permitted contact) are closed instead of piling up open.
-- 5. The watchdog's facts say when each agent last finished a task, how often it is scheduled, and what its last 14 days did, so a weekly
--    agent is not reported idle and one whose every run skipped is named with the reason.
-- 6. The scorecard counts the Marketing Manager's AI spend apart, for cost per trial.
-- 7. The strategist's facts count Intel sign-ups that never added a card and trials lost unpaid, and its notes accept the new constraint
--    `paying` (trials ending unpaid) and the figure `paid`.
--
-- 20261117240100_support_truth_contract.sql declares platform.agents.support-truth.v1; the Hub uses all of this only then.
set local lock_timeout = '10s';

-- The owner's switch.
insert into private.hub_settings (key, kind) values ('agents.auto_acknowledge', 'flag') on conflict (key) do nothing;

-- 1. The acknowledgment's own kind. -------------------------------------------------------------------------------------------------
do $$
declare
  v_kinds text[];
begin
  select coalesce(array_agg(distinct m[1]), array[]::text[]) into v_kinds
  from pg_constraint c cross join lateral regexp_matches(pg_get_constraintdef(c.oid), '''([^'']+)''', 'g') m
  where c.conrelid = 'private.agent_actions'::regclass and c.conname = 'agent_actions_kind_check';
  if not v_kinds @> array['communication.reply', 'communication.answer']
    or exists (select 1 from unnest(v_kinds) value where value !~ '^[a-z][a-z0-9_.]{1,60}$') then
    raise exception 'The agent action kinds could not be read' using errcode = '55000';
  end if;
  if not v_kinds @> array['communication.acknowledge'] then
    execute format('alter table private.agent_actions drop constraint agent_actions_kind_check, add constraint agent_actions_kind_check check (kind in (%s))',
      (select string_agg(quote_literal(k), ', ' order by k) from (select distinct unnest(v_kinds || array['communication.acknowledge']) as k) x));
  end if;
end $$;

-- What an acknowledgment is: the standard text, exactly, by email or chat, with nothing found in the message. A missing fact fails.
alter table private.agent_actions drop constraint if exists agent_actions_communication_acknowledge_check;
alter table private.agent_actions add constraint agent_actions_communication_acknowledge_check check (
  kind <> 'communication.acknowledge' or coalesce(
    target_kind = 'communication'
    and (input - array['communicationId', 'reference', 'channel', 'route', 'basedOnMessageId', 'body', 'classification', 'template']) = '{}'::jsonb
    and input ->> 'template' = 'standard'
    and input -> 'classification' ->> 'phi' = 'false'
    and not (input -> 'classification' ? 'drafted')
    and input ->> 'route' in ('email', 'chat')
    and input ->> 'body' = E'Hello,\n\nThank you for contacting CareMetric Support. We have your message and a member of our team will review it and reply here.'
    and coalesce(input ->> 'communicationId', '') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and coalesce(input ->> 'basedOnMessageId', '') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and jsonb_typeof(input -> 'reference') = 'number' and target_id = 'CM-' || (input ->> 'reference'), false));

-- The support answers step hands the acknowledgment over with the answers; if it already has, the Concierge's list gains it now.
do $$
declare v_step private.agent_autonomy_steps;
begin
  select * into v_step from private.agent_autonomy_steps where category = 'support_answers' for update;
  if not found then return; end if;
  if not exists (select 1 from jsonb_array_elements(v_step.changes) c, jsonb_array_elements_text(c -> 'values') v where v = 'communication.acknowledge') then
    update private.agent_autonomy_steps set changes = (
      select jsonb_agg(case when c ->> 'agent' = 'support_concierge' and c ->> 'config_key' = 'auto_approve_kinds'
                            then jsonb_set(c, '{values}', (c -> 'values') || '["communication.acknowledge"]'::jsonb) else c end)
      from jsonb_array_elements(v_step.changes) c)
    where category = 'support_answers';
    if v_step.status = 'automatic' then
      perform private.agent_autonomy_change('support_answers',
        '{"agent": "support_concierge", "config_key": "auto_approve_kinds", "values": ["communication.acknowledge"]}'::jsonb, true);
    end if;
  end if;
end $$;

-- Server: records an acknowledgment in its conversation (as the CareMetric AI Assistant) before it is sent, or says why not. As
-- private.agent_answer_begin, for the acknowledgment, with the owner's switch and the sender checked again.
create or replace function private.agent_acknowledge_begin(p_action_id uuid, p_execution integer, p_available text[]) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_action private.agent_actions%rowtype;
  v_agent private.agents%rowtype;
  v_communication private.communications%rowtype;
  v_existing private.communication_messages%rowtype;
  v_sender jsonb;
  v_head uuid;
  v_route text;
  v_to text;
  v_message uuid;
  v_author constant uuid := 'a1a00000-a1a0-4000-8000-000000000001';
begin
  perform private.require_hub_app_server();
  select * into v_action from private.agent_actions where id = p_action_id for update;
  if not found or v_action.kind <> 'communication.acknowledge' then
    raise exception 'Unknown acknowledgment.' using errcode = 'P0002';
  end if;
  if v_action.status <> 'executing' or (p_execution is not null and v_action.executions <> p_execution) then
    raise exception 'That acknowledgment is not being sent.' using errcode = '55000';
  end if;
  select * into v_communication from private.communications where id = (v_action.input ->> 'communicationId')::uuid for update;
  if not found then
    return jsonb_build_object('state', 'refused', 'code', 'conversation_missing');
  end if;
  if v_action.target_id is distinct from 'CM-' || v_communication.reference
    or (v_action.input ->> 'reference') is distinct from v_communication.reference::text then
    return jsonb_build_object('state', 'refused', 'code', 'target_mismatch');
  end if;
  select * into v_existing from private.communication_messages m where m.communication_id = v_communication.id and m.request_key = v_action.request_key;
  if found then
    return jsonb_build_object('state', 'replay', 'messageId', v_existing.id, 'delivery', v_existing.delivery, 'deliveryChannel', v_existing.delivery_channel);
  end if;
  -- Nobody approved it: the owner's switch must still be on, and the Concierge still trusted with it, now (its row held until commit).
  if v_action.decided_by is null then
    select * into v_agent from private.agents where key = v_action.agent_key for share;
    if v_agent.status is distinct from 'active' or v_agent.autonomy is distinct from 'act'
      or jsonb_typeof(v_agent.config -> 'auto_approve_kinds') is distinct from 'array'
      or not ((v_agent.config -> 'auto_approve_kinds') ? 'communication.acknowledge')
      or coalesce((select (s.value #>> '{}')::boolean from private.hub_settings s where s.key = 'agents.auto_acknowledge'), false) is not true then
      return jsonb_build_object('state', 'refused', 'code', 'acknowledge_off');
    end if;
  end if;
  if v_communication.status = 'closed' then
    return jsonb_build_object('state', 'refused', 'code', 'conversation_closed');
  end if;
  -- Only to a person: never a machine, the Hub's own sender, a colleague or an answer to the owner's own email.
  v_sender := private.agent_communication_snapshot(v_communication.id, null, 0, 100) -> 'sender';
  if coalesce((v_sender ->> 'machine')::boolean, false) or coalesce((v_sender ->> 'ours')::boolean, false)
    or coalesce((v_sender ->> 'internal')::boolean, false) or coalesce((v_sender ->> 'answersOurEmail')::boolean, false) then
    return jsonb_build_object('state', 'refused', 'code', 'not_a_person');
  end if;
  select m.id into v_head from private.communication_messages m
  where m.communication_id = v_communication.id and m.direction in ('inbound', 'outbound')
  order by m.created_at desc, m.id desc limit 1;
  if v_head is distinct from (v_action.input ->> 'basedOnMessageId')::uuid then
    return jsonb_build_object('state', 'refused', 'code', 'thread_changed');
  end if;
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
    'agent', v_action.agent_key, 'action_id', v_action.id, 'kind', 'acknowledge', 'approved', case when v_action.decided_by is null then 'automatic' else 'owner' end));
  return jsonb_build_object('state', 'ready', 'messageId', v_message, 'delivery', case when v_route = 'chat' then 'sent' else 'pending' end,
    'deliveryChannel', v_route, 'to', v_to, 'reference', v_communication.reference, 'channel', v_communication.channel, 'body', v_action.input ->> 'body');
end;
$$;
revoke all on function private.agent_acknowledge_begin(uuid, integer, text[]) from public, anon, authenticated, service_role, hub_app_server;
grant execute on function private.agent_acknowledge_begin(uuid, integer, text[]) to hub_app_server;

-- 2. An acknowledgment is not an answer. ---------------------------------------------------------------------------------------------
-- Whether a message is a fixed acknowledgment the AI team sent (the Concierge's or the Sales Executive's standard or sales template),
-- told by the action whose request key it carries.
create or replace function private.agent_growth_acknowledgment(p_request_key uuid) returns boolean
language sql stable set search_path = '' as $$
  select p_request_key is not null and exists (
    select 1 from private.agent_actions a
    where a.request_key = p_request_key and a.kind in ('communication.reply', 'communication.acknowledge')
      and a.input ->> 'template' in ('standard', 'sales'));
$$;
revoke all on function private.agent_growth_acknowledgment(uuid) from public, anon, authenticated, service_role, hub_app_server;

-- 2, 3, 5, 6 and 7: patches in place, each refused if the text it replaces has changed, and skipped once applied. -----------------------
do $$
declare d text;
begin
  -- 2. The lead still waiting for its first reply (reminders, "waiting for a first reply").
  d := pg_get_functiondef('private.agent_growth_waiting()'::regprocedure);
  if position('agent_growth_acknowledgment' in d) = 0 then
    if position('private.agent_growth_answers(a.direction, a.delivery) and (a.created_at, a.id) > (f.created_at, f.id)' in d) = 0 then
      raise exception 'The waiting leads changed; update this migration' using errcode = '55000';
    end if;
    execute replace(d, 'private.agent_growth_answers(a.direction, a.delivery) and (a.created_at, a.id) > (f.created_at, f.id)',
      'private.agent_growth_answers(a.direction, a.delivery) and not private.agent_growth_acknowledgment(a.request_key) and (a.created_at, a.id) > (f.created_at, f.id)');
  end if;
  -- 2. The first-reply figure.
  d := pg_get_functiondef('private.agent_growth_facts_json(timestamptz,timestamptz)'::regprocedure);
  if position('agent_growth_acknowledgment' in d) = 0 then
    if position('m.direction = ''outbound'' and m.delivery = ''sent'' and (m.created_at, m.id) > (f.created_at, f.id)' in d) = 0 then
      raise exception 'The weekly growth facts changed; update this migration' using errcode = '55000';
    end if;
    execute replace(d, 'm.direction = ''outbound'' and m.delivery = ''sent'' and (m.created_at, m.id) > (f.created_at, f.id)',
      'm.direction = ''outbound'' and m.delivery = ''sent'' and not private.agent_growth_acknowledgment(m.request_key) and (m.created_at, m.id) > (f.created_at, f.id)');
  end if;

  -- 3. The Concierge's snapshot: whether the sender's billing account is trialing or paying, as flags.
  d := pg_get_functiondef('private.agent_communication_snapshot(uuid,uuid,integer,integer)'::regprocedure);
  if position('''account''' in d) = 0 then
    if position('    ''messages'', v_messages);' in d) = 0 then
      raise exception 'The Concierge''s snapshot changed; update this migration' using errcode = '55000';
    end if;
    execute replace(d, '    ''messages'', v_messages);', $r$    -- Support truth (20261117240000_support_truth.sql): whether the sender's billing account is in a trial or paying, as flags.
    'account', case when v_address <> '' then (
      select jsonb_build_object('trialing', coalesce(bool_or(s.status = 'trialing'), false), 'paying', coalesce(bool_or(s.status = 'active'), false))
        from private.billing_customers bc join private.billing_subscriptions s on s.tenant_id = bc.tenant_id and s.livemode
       where lower(btrim(bc.email)) = v_address and not bc.deleted and bc.livemode) end,
    'messages', v_messages);$r$);
  end if;

  -- 5. The watchdog: when each agent last finished a task, how often it is scheduled, and what its last 14 days did.
  d := pg_get_functiondef('private.agent_watchdog_facts()'::regprocedure);
  if position('''lastTaskAt''' in d) = 0 then
    if position('''oldestOverdueAt'', (select min(t.due_at) from private.agent_tasks t where t.agent_key = g.key and t.status = ''queued'' and t.due_at < now())' in d) = 0 then
      raise exception 'The watchdog facts changed; update this migration' using errcode = '55000';
    end if;
    execute replace(d, '''oldestOverdueAt'', (select min(t.due_at) from private.agent_tasks t where t.agent_key = g.key and t.status = ''queued'' and t.due_at < now())',
      $r$'oldestOverdueAt', (select min(t.due_at) from private.agent_tasks t where t.agent_key = g.key and t.status = 'queued' and t.due_at < now()),
        -- Support truth (20261117240000_support_truth.sql): a finished task, even one that skipped, means the agent is alive.
        'lastTaskAt', (select max(t.finished_at) from private.agent_tasks t where t.agent_key = g.key and t.status = 'done'),
        'shortestSeconds', (select min(case when s.cadence = 'interval' then s.every_seconds else 86400 end) from private.agent_schedules s where s.agent_key = g.key and s.enabled),
        'tasks14d', (select count(*) from private.agent_tasks t where t.agent_key = g.key and t.status = 'done' and t.finished_at >= now() - interval '14 days'),
        'worked14d', (select count(*) from private.agent_tasks t where t.agent_key = g.key and t.status = 'done' and t.finished_at >= now() - interval '14 days'
          and not (coalesce(t.result, '{}'::jsonb) ? 'skipped') and coalesce(t.result ->> 'outcome', '') not in ('nothing_due', 'already_sent', 'already_attempted', 'observe_only')),
        'skipped14d', coalesce((select jsonb_object_agg(x.reason, x.n) from (
          select t.result ->> 'skipped' as reason, count(*) as n from private.agent_tasks t
           where t.agent_key = g.key and t.status = 'done' and t.finished_at >= now() - interval '14 days' and t.result ->> 'skipped' ~ '^[a-z][a-z0-9_]{0,59}$'
           group by 1 order by 2 desc limit 5) x), '{}'::jsonb)$r$);
  end if;

  -- 6. The scorecard: the Marketing Manager's AI spend, apart.
  d := pg_get_functiondef('private.agent_scorecard_facts_before_lifecycle(timestamptz,timestamptz)'::regprocedure);
  if position('marketingSpendCents' in d) = 0 then
    if position('''aiSpendCents'', (select coalesce(round(sum(r.cost_cents)), 0) from private.agent_runs r where r.started_at >= p_since and r.started_at < p_until)' in d) = 0 then
      raise exception 'The scorecard facts changed; update this migration' using errcode = '55000';
    end if;
    execute replace(d, '''aiSpendCents'', (select coalesce(round(sum(r.cost_cents)), 0) from private.agent_runs r where r.started_at >= p_since and r.started_at < p_until)',
      $r$'aiSpendCents', (select coalesce(round(sum(r.cost_cents)), 0) from private.agent_runs r where r.started_at >= p_since and r.started_at < p_until),
    'marketingSpendCents', (select coalesce(round(sum(r.cost_cents)), 0) from private.agent_runs r where r.agent_key = 'marketing_manager' and r.started_at >= p_since and r.started_at < p_until)$r$);
  end if;

  -- 7. The strategist: Intel sign-ups that never added a card (given a day), and counted trials lost unpaid, never internal ones.
  d := pg_get_functiondef('private.growth_strategy_facts_json(timestamptz,timestamptz)'::regprocedure);
  if position('''noCard''' in d) = 0 then
    if position('''paid'', coalesce((select n from firsts where kind = ''paid''), 0))' in d) = 0 then
      raise exception 'The strategist''s facts changed; update this migration' using errcode = '55000';
    end if;
    execute replace(d, '''paid'', coalesce((select n from firsts where kind = ''paid''), 0))', $r$'paid', coalesce((select n from firsts where kind = 'paid'), 0),
    'noCard', (select count(*) from private.billing_subscriptions s join hub.products p on p.id = s.product_id and p.slug = 'caremetric-intel'
       where s.livemode and s.trial_start is not null and s.stripe_created >= p_since and s.stripe_created < p_until and s.stripe_created < now() - interval '1 day'
         and not exists (select 1 from private.growth_trial_cards c where c.stripe_subscription_id = s.stripe_subscription_id)
         and not exists (select 1 from private.growth_organizations g where g.tenant_id = s.tenant_id and g.internal)),
    'trialsLost', (select count(*) from private.growth_billing_outbox b
       where b.kind = 'churned' and b.event_key like 'billing:trial_lost:%' and b.product = 'caremetric-intel' and b.occurred_at >= p_since and b.occurred_at < p_until
         and not exists (select 1 from private.growth_organizations g where g.tenant_id = b.tenant_id and g.internal)))$r$);
  end if;
end $$;

-- 7. The strategist's notes accept trials ending unpaid (`paying`) and the figure it is judged by (`paid`).
alter table private.agent_strategy_notes drop constraint if exists agent_strategy_notes_constraint_key_check;
alter table private.agent_strategy_notes add constraint agent_strategy_notes_constraint_key_check check (constraint_key in (
  'deliverability', 'supply', 'reach', 'permission', 'volume', 'engagement', 'conversion', 'activation', 'paying', 'budget', 'approvals', 'none'));
alter table private.agent_strategy_notes drop constraint if exists agent_strategy_notes_watch_check;
alter table private.agent_strategy_notes add constraint agent_strategy_notes_watch_check check (watch in (
  'bounceRate', 'ready', 'strongNoContact', 'awaitingPermission', 'firstSent', 'openRate', 'replies', 'trialStarts', 'activated', 'paid', 'budgetDays', 'approvals'));

-- 4. Success plans the customer emails cover, for a trial nobody may write to, are closed (the Hub stops planning them, growth/worker.mjs).
update private.customer_success_plans p
   set status = 'cancelled', outcome = 'The Account Manager''s customer emails cover this trial, and there is no permitted contact to write to (team review 2026-11-17, stage 5).',
       resolved_at = now()
  from private.growth_opportunities o
  left join private.growth_contacts c on c.id = o.contact_id
 where p.opportunity_id = o.id and p.status = 'open' and p.kind in ('onboarding', 'activation', 'trial')
   and o.owner_agent = 'account_manager' and coalesce(c.eligibility, 'none') <> 'permitted';
