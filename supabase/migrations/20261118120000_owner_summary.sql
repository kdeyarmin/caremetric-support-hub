-- The end-of-day summary (owner decision 2026-11-18): "I'm getting several emails every morning. I only want emails when something
-- needs my decision or for me to do something. What would be nice would be 1 email at the end of the day of just a summary of what was
-- done that day, what came in, what went out (just a summary) and if anything needs my decision."
--
-- Why. Each agent emails its own reports and approval requests as soon as they are ready: the morning brief at 07:00, then the social
-- plan, creative, ad review, ads plan and creative refresh between 08:15 and 09:45, besides news through the day. The owner could miss
-- the one that mattered among them.
--
-- 1. Settings -> AI team: "One end-of-day summary" (agents.daily_summary, on unless the owner turns it off: the server's default),
--    "Summary time" (agents.summary_hour, 12 to 23 Eastern, 17 unless set) and "Email approval requests right away"
--    (agents.approvals_right_away, off unless set).
-- 2. private.owner_notifications gains the status `held`: a message recorded for the summary instead of sent, with its `attention`
--    (decision: a routine batch waiting for approval; update: news). private.agent_notify_hold records a pending email as held; only an
--    email that is not urgent can be held. Held is settled: housekeeping leaves it, and a retried task finds it as a duplicate.
-- 3. private.agent_summary_facts(since, until): the window's work (tasks, runs and AI spend, by agent), what came in (customer messages
--    in Communications, by channel), what went out (replies sent from Communications, approved actions carried out, by kind), the
--    approvals waiting now by kind, and the owner's alerts held or sent in the window (subjects, which never quote a customer). Hub
--    server only, at most eight days.
-- 4. The Chief of Staff's summary.daily task, fired at noon Eastern; the server keeps it queued until the owner's hour.
--
-- Nothing is sent by this migration. 20261118120100_owner_summary_contract.sql declares platform.agents.owner-summary.v1, and the server
-- holds nothing and sends no summary until it is declared.
set local lock_timeout = '10s';

insert into private.hub_settings (key, kind) values
  ('agents.daily_summary', 'flag'),
  ('agents.summary_hour', 'number'),
  ('agents.approvals_right_away', 'flag')
on conflict (key) do nothing;

-- The status check, whatever its name, admits `held`; a held row says why it was held, and no other row does.
do $$
declare
  v_name text;
begin
  for v_name in
    select conname from pg_constraint
    where conrelid = 'private.owner_notifications'::regclass and contype = 'c'
      and pg_get_constraintdef(oid) like '%status%' and pg_get_constraintdef(oid) like '%''suppressed''%'
  loop
    execute format('alter table private.owner_notifications drop constraint %I', v_name);
  end loop;
end $$;
alter table private.owner_notifications add constraint owner_notifications_status_check
  check (status in ('pending', 'sent', 'failed', 'unknown', 'suppressed', 'held'));
alter table private.owner_notifications add column if not exists attention text;
alter table private.owner_notifications drop constraint if exists owner_notifications_held_attention;
alter table private.owner_notifications add constraint owner_notifications_held_attention
  check ((status = 'held') = (attention is not null) and (attention is null or attention in ('decision', 'update')));
create index if not exists owner_notifications_held on private.owner_notifications (created_at) where status = 'held';

-- Records an email that has just been begun (pending) as held for the summary. Never a text, never an urgent alert.
create or replace function private.agent_notify_hold(p_id uuid, p_attention text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_status text;
begin
  perform private.require_hub_app_server();
  if p_attention is null or p_attention not in ('decision', 'update') then
    raise exception 'Hold a decision or an update.' using errcode = '22023';
  end if;
  update private.owner_notifications
  set status = 'held', attention = p_attention
  where id = p_id and status = 'pending' and channel = 'email' and severity <> 'urgent'
  returning status into v_status;
  if not found then
    raise exception 'Unknown, settled or urgent notification.' using errcode = 'P0002';
  end if;
  return v_status;
end;
$$;
revoke all on function private.agent_notify_hold(uuid, text) from public, anon, authenticated, service_role;
grant execute on function private.agent_notify_hold(uuid, text) to hub_app_server;

-- The summary's facts. Counts, kinds, agent names, times and the owner's own alert subjects (which carry references and counts, never a
-- customer's words): no message text, contact or amount of money. Conversations are found through their last activity, so only the
-- window's threads are read.
create or replace function private.agent_summary_facts(p_since timestamptz, p_until timestamptz) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_inbound jsonb;
  v_outbound jsonb;
begin
  perform private.require_hub_app_server();
  if p_since is null or p_until is null or p_until <= p_since or p_until - p_since > interval '8 days' then
    raise exception 'Choose a window of at most eight days.' using errcode = '22023';
  end if;

  with thread as (
    select m.direction, m.delivery, m.communication_id, c.channel, c.created_at as opened_at
    from private.communications c
    join private.communication_messages m on m.communication_id = c.id and m.created_at >= p_since and m.created_at < p_until
    where c.last_message_at >= p_since
  )
  select
    jsonb_build_object(
      'messages', count(*) filter (where direction = 'inbound'),
      'conversations', count(distinct communication_id) filter (where direction = 'inbound'),
      'newConversations', count(distinct communication_id) filter (where direction = 'inbound' and opened_at >= p_since and opened_at < p_until),
      'byChannel', coalesce((select jsonb_object_agg(x.channel, x.n) from (
        select t.channel, count(distinct t.communication_id) as n from thread t where t.direction = 'inbound' group by t.channel) x), '{}'::jsonb)),
    jsonb_build_object(
      'messages', count(*) filter (where direction = 'outbound' and delivery = 'sent'),
      'conversations', count(distinct communication_id) filter (where direction = 'outbound' and delivery = 'sent'))
  into v_inbound, v_outbound
  from thread;

  return jsonb_build_object(
    'since', p_since, 'until', p_until, 'generatedAt', now(),
    'day', jsonb_build_object(
      'runs', (select count(*) from private.agent_runs where started_at >= p_since and started_at < p_until),
      'tasksDone', (select count(*) from private.agent_tasks where status = 'done' and finished_at >= p_since and finished_at < p_until),
      'tasksFailed', (select count(*) from private.agent_tasks where status = 'failed' and finished_at >= p_since and finished_at < p_until),
      'actionsExecuted', (select count(*) from private.agent_actions where status = 'executed' and executed_at >= p_since and executed_at < p_until),
      'incidentsOpened', (select count(*) from private.agent_tasks where kind = 'probe.incident' and created_at >= p_since and created_at < p_until),
      'incidentsClosed', (select count(*) from private.agent_tasks where kind = 'probe.recovery' and created_at >= p_since and created_at < p_until),
      'spendCents', (select coalesce(sum(cost_cents), 0) from private.agent_runs where started_at >= p_since and started_at < p_until)),
    -- By agent, the work that took a run (a check that found nothing new records none), busiest first.
    'work', (select coalesce(jsonb_agg(jsonb_build_object('agent', a.key, 'name', a.display_name, 'runs', w.runs, 'spendCents', w.spend)
                                       order by w.runs desc, a.key), '[]'::jsonb)
             from (select r.agent_key, count(*) as runs, coalesce(sum(r.cost_cents), 0) as spend from private.agent_runs r
                   where r.started_at >= p_since and r.started_at < p_until group by r.agent_key) w
             join private.agents a on a.key = w.agent_key),
    'executed', (select coalesce(jsonb_object_agg(x.kind, x.n), '{}'::jsonb) from (
                   select kind, count(*) as n from private.agent_actions
                   where status = 'executed' and executed_at >= p_since and executed_at < p_until group by kind) x),
    'waiting', (select coalesce(jsonb_object_agg(x.kind, x.n), '{}'::jsonb) from (
                  select kind, count(*) as n from private.agent_actions where status = 'proposed' and expires_at > now() group by kind) x),
    'inbound', v_inbound,
    'outbound', v_outbound,
    'notifications', jsonb_build_object(
      'held', (select coalesce(jsonb_agg(jsonb_build_object('subject', n.subject, 'attention', n.attention, 'agent', n.agent_key, 'name', a.display_name, 'at', n.created_at)
                                         order by n.created_at), '[]'::jsonb)
               from (select * from private.owner_notifications
                     where status = 'held' and created_at >= p_since and created_at < p_until order by created_at desc limit 25) n
               left join private.agents a on a.key = n.agent_key),
      'heldCount', (select count(*) from private.owner_notifications where status = 'held' and created_at >= p_since and created_at < p_until),
      -- Emails that went at once: not the summary or the brief themselves.
      'sent', (select coalesce(jsonb_agg(jsonb_build_object('subject', n.subject, 'severity', n.severity, 'at', n.created_at) order by n.created_at), '[]'::jsonb)
               from (select * from private.owner_notifications
                     where channel = 'email' and status = 'sent' and created_at >= p_since and created_at < p_until
                       and dedupe_key not like 'summary:%' and dedupe_key not like 'brief:%'
                     order by created_at desc limit 15) n),
      'sentCount', (select count(*) from private.owner_notifications
                    where channel = 'email' and status = 'sent' and created_at >= p_since and created_at < p_until
                      and dedupe_key not like 'summary:%' and dedupe_key not like 'brief:%'))
  );
end;
$$;
revoke all on function private.agent_summary_facts(timestamptz, timestamptz) from public, anon, authenticated, service_role;
grant execute on function private.agent_summary_facts(timestamptz, timestamptz) to hub_app_server;

-- The Chief of Staff's end-of-day summary. It fires at noon Eastern and the server keeps it queued until the owner's hour, so the owner
-- can choose the hour on the Settings page without a schedule change.
insert into private.agent_schedules (agent_key, task_kind, cadence, every_seconds, at_local, timezone, requires_session, next_run_at)
values ('chief_of_staff', 'summary.daily', 'daily', null, '12:00', 'America/New_York', false,
        private.agent_schedule_next('daily', null, '12:00', 'America/New_York', now(), null))
on conflict (agent_key, task_kind) do nothing;
