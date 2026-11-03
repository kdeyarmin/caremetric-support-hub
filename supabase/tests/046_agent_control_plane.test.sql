begin;
select plan(41);

create temporary table agent_tables(relation text primary key) on commit drop;
insert into agent_tables values ('private.agents'), ('private.agent_schedules'), ('private.agent_tasks'),
  ('private.agent_runs'), ('private.agent_actions'), ('private.owner_notifications');

create temporary table agent_server_operations(signature text primary key) on commit drop;
insert into agent_server_operations values
  ('private.agent_budget(text)'), ('private.agent_schedule_fire(integer,text[])'), ('private.agent_maintenance()'),
  ('private.agent_task_enqueue(text,text,text,jsonb,integer,timestamp with time zone,text,text,boolean)'),
  ('private.agent_task_claim(integer,integer)'), ('private.agent_task_heartbeat(uuid,integer)'),
  ('private.agent_task_finish(uuid,text,jsonb,text,timestamp with time zone)'),
  ('private.agent_session_tasks(integer)'), ('private.agent_session_task_claim(uuid,integer)'),
  ('private.agent_run_start(uuid,text,text)'), ('private.agent_run_finish(uuid,text,jsonb,text,text)'),
  ('private.agent_action_propose(uuid,uuid,text,text,text,text,jsonb)'), ('private.agent_actions_ready(integer)'),
  ('private.agent_action_execution(uuid)'), ('private.agent_action_executed(uuid,boolean,jsonb)'),
  ('private.agent_notify_begin(text,text,text,text,text,text,uuid)'), ('private.agent_notify_finish(uuid,text,text)'),
  ('private.owner_contact()');

create temporary table agent_helpers(signature text primary key) on commit drop;
insert into agent_helpers values
  ('private.agent_day_start()'), ('private.agent_spent_today_cents(text)'), ('private.agent_budget_json(text)'),
  ('private.agent_schedule_next(text,integer,time without time zone,text,timestamp with time zone,timestamp with time zone)'),
  ('private.agent_task_json(uuid)'), ('private.agent_summary_json(text)'), ('private.agent_close_task_if_settled(uuid)');

create temporary table agent_owner_reads(signature text primary key) on commit drop;
insert into agent_owner_reads values
  ('hub.get_agent_team()'), ('hub.list_agent_activity(text,text,integer,integer)'), ('hub.list_audit_events(text,integer,integer)');
create temporary table agent_owner_changes(signature text primary key) on commit drop;
insert into agent_owner_changes values
  ('hub.set_agent_status(text,text,timestamp with time zone)'), ('hub.set_agent_autonomy(text,text,timestamp with time zone)'),
  ('hub.set_agent_budget(text,integer,timestamp with time zone)'), ('hub.decide_agent_action(uuid,text,text)'),
  ('hub.request_agent_task(text,text)'), ('hub.cancel_agent_task(uuid)');

-- The boundary: closed tables, server-only operations, internal helpers, owner operations.
select ok(bool_and(to_regclass(relation) is not null and (select relrowsecurity from pg_class where oid = to_regclass(relation))),
  'Every AI team table exists with row level security')
from agent_tables;

select ok(not bool_or(has_table_privilege(role_name, relation, 'select,insert,update,delete,truncate')
    or has_any_column_privilege(role_name, relation, 'select,insert,update')),
  'No browser, service or server role touches an AI team table directly')
from agent_tables cross join unnest(array['public', 'anon', 'authenticated', 'service_role', 'hub_app_server']) as role_name;

select ok(bool_and(p.prosecdef and p.proconfig @> array['search_path=""']) and count(*) = 18,
  'Every server operation is a security definer with a pinned empty search path')
from agent_server_operations operation join pg_proc p on p.oid = to_regprocedure(operation.signature);

select ok(bool_and(has_function_privilege('hub_app_server', signature, 'execute')),
  'The Hub server role executes every server operation')
from agent_server_operations;

select ok(not bool_or(has_function_privilege(role_name, signature, 'execute')),
  'No browser, service or public role executes a server operation')
from agent_server_operations cross join unnest(array['public', 'anon', 'authenticated', 'service_role']) as role_name;

select ok(count(distinct signature) = 7 and not bool_or(has_function_privilege(role_name, signature, 'execute')),
  'The helpers stay internal to the operations, even from the Hub server role')
from agent_helpers cross join unnest(array['public', 'anon', 'authenticated', 'service_role', 'hub_app_server']) as role_name;

select ok(bool_and(has_function_privilege('authenticated', signature, 'execute')),
  'Signed-in sessions can call every owner operation')
from (select signature from agent_owner_reads union all select signature from agent_owner_changes) owner_operation;

select ok(not bool_or(has_function_privilege(role_name, signature, 'execute')),
  'Neither the public nor anonymous callers can call an owner operation')
from (select signature from agent_owner_reads union all select signature from agent_owner_changes) owner_operation
cross join unnest(array['public', 'anon']) as role_name;

select ok(count(*) = 3 and bool_and(position('hub.authorize_app_admin()' in pg_get_functiondef(to_regprocedure(signature))) > 0),
  'Owner reads require the current administrator session')
from agent_owner_reads;

select ok(count(*) = 6 and bool_and(position('hub.authorize_app_command()' in pg_get_functiondef(to_regprocedure(signature))) > 0),
  'Owner changes require the current administrator command session')
from agent_owner_changes;

-- The test session user is not the Hub server, so every server operation refuses it.
select throws_ok('select private.agent_task_claim(1, 60)', '42501', 'Application server required.',
  'Claiming work refuses every session user other than the Hub server');
select throws_ok($$select private.agent_notify_begin('email', 'info', 'Subject', 'Body', 'key')$$, '42501', 'Application server required.',
  'Recording an owner notification refuses every session user other than the Hub server');
select throws_ok('select private.owner_contact()', '42501', 'Application server required.',
  'Looking up the owner contact refuses every session user other than the Hub server');

set local role authenticated;
select throws_ok('select hub.get_agent_team()', '28000', 'Current administrator session required.',
  'The team view requires the current administrator session');
select throws_ok($$select hub.decide_agent_action('00000000-0000-4000-8000-000000000000', 'approve', null)$$, '28000',
  'Current administrator session required.', 'A decision requires the current administrator session');
select throws_ok('select private.agent_task_claim(1, 60)', '42501', 'permission denied for function agent_task_claim',
  'Signed-in users cannot claim agent work');
reset role;
set local role anon;
select throws_ok('select hub.get_agent_team()', '42501', 'permission denied for function get_agent_team',
  'Anonymous callers cannot read the team');
reset role;

-- The agents exist, paused, with the starting settings the plan names.
select is((select array_agg(key order by key) from private.agents),
  array['account_manager', 'chief_of_staff', 'content_marketer', 'growth_manager', 'platform_engineer', 'seo_analyst', 'support_concierge'], 'The AI team''s agents are seeded');
select ok((select bool_and(status = 'paused') from private.agents), 'Every seeded agent starts paused');
select is((select jsonb_object_agg(key, jsonb_build_array(autonomy, model_tier, daily_budget_cents)) from private.agents),
  '{"account_manager": ["observe", "fast", 50], "chief_of_staff": ["act", "draft", 100], "content_marketer": ["propose", "draft", 150], "growth_manager": ["observe", "fast", 50], "platform_engineer": ["act", "fast", 50], "seo_analyst": ["observe", "fast", 50], "support_concierge": ["propose", "draft", 300]}'::jsonb,
  'Autonomy, model tier and daily budget start at the planned levels');
select is((select config -> 'auto_approve_kinds' from private.agents where key = 'platform_engineer'),
  '["incident.open", "incident.resolve"]'::jsonb, 'Only incident records are approved without the owner, and only for the on-call agent');
select is((select count(*) from private.agent_schedules where agent_key = 'support_concierge' and requires_session), 2::bigint,
  'The two application imports wait for the owner''s session');
select is((select (next_run_at at time zone 'America/New_York')::time from private.agent_schedules where task_kind = 'brief.daily'),
  '07:00:00'::time, 'The daily brief is scheduled for 07:00 Eastern');

-- Schedule arithmetic: strictly after now, stable through daylight-saving changes and downtime.
select is(private.agent_schedule_next('daily', null, '07:00', 'America/New_York', '2026-11-02 11:30:00+00', null),
  '2026-11-02 12:00:00+00'::timestamptz, 'Before 07:00 Eastern the brief is due that morning');
select is(private.agent_schedule_next('daily', null, '07:00', 'America/New_York', '2026-11-02 13:00:00+00', null),
  '2026-11-03 12:00:00+00'::timestamptz, 'After 07:00 Eastern the brief is due the next morning');
select is(private.agent_schedule_next('daily', null, '07:00', 'America/New_York', '2026-11-02 12:00:00+00', null),
  '2026-11-03 12:00:00+00'::timestamptz, 'At exactly 07:00 the next run is strictly later');
select is(private.agent_schedule_next('daily', null, '07:00', 'America/New_York', '2026-03-07 14:00:00+00', null),
  '2026-03-08 11:00:00+00'::timestamptz, 'The brief stays at 07:00 local when the clocks go forward');
select is(private.agent_schedule_next('daily', null, '07:00', 'America/New_York', '2026-10-31 14:00:00+00', null),
  '2026-11-01 12:00:00+00'::timestamptz, 'The brief stays at 07:00 local when the clocks go back');
select is(private.agent_schedule_next('daily', null, '07:00', 'UTC', '2026-11-02 08:00:00+00', null),
  '2026-11-03 07:00:00+00'::timestamptz, 'A UTC schedule ignores Eastern time');
select is(private.agent_schedule_next('interval', 300, null, 'America/New_York', '2026-11-02 12:07:30+00', '2026-11-02 12:00:00+00'),
  '2026-11-02 12:10:00+00'::timestamptz, 'An interval schedule stays on its own grid');
select is(private.agent_schedule_next('interval', 300, null, 'America/New_York', '2026-11-02 12:10:00+00', '2026-11-02 12:00:00+00'),
  '2026-11-02 12:15:00+00'::timestamptz, 'At a grid point the next run is strictly later');
select is(private.agent_schedule_next('interval', 300, null, 'America/New_York', '2026-11-02 22:02:30+00', '2026-11-02 12:00:00+00'),
  '2026-11-02 22:05:00+00'::timestamptz, 'After downtime an interval schedule resumes on its grid without a backlog');
select is(private.agent_day_start() at time zone 'America/New_York', date_trunc('day', now() at time zone 'America/New_York'),
  'The budget day starts at midnight Eastern');

-- Row rules the operations rely on.
select throws_ok($$insert into private.agents (key, display_name, role_summary) values ('Bad Key', 'Bad', 'Bad')$$, '23514',
  null, 'Agent keys are lowercase identifiers');
select throws_ok($$update private.agents set autonomy = 'root' where key = 'chief_of_staff'$$, '23514',
  null, 'Autonomy is observe, propose or act');
select throws_ok($$insert into private.agent_schedules (agent_key, task_kind, cadence, every_seconds, timezone)
  values ('chief_of_staff', 'bad.zone', 'interval', 300, 'Mars/Phobos')$$, '23514', null, 'Schedules run in a supported time zone');
select throws_ok($$insert into private.agent_schedules (agent_key, task_kind, cadence) values ('chief_of_staff', 'bad.cadence', 'interval')$$,
  '23514', null, 'An interval schedule states its interval');

insert into private.agent_tasks (agent_key, kind, request_key) values ('chief_of_staff', 'brief.daily', 'test-request-1');
select throws_ok($$insert into private.agent_tasks (agent_key, kind, request_key) values ('chief_of_staff', 'brief.daily', 'test-request-1')$$,
  '23505', null, 'A request key enqueues its task once');

insert into private.agent_actions (task_id, agent_key, kind, target_kind, target_id, preview)
select id, 'chief_of_staff', 'communication.note', 'communication', 'CM-1', 'Preview' from private.agent_tasks where request_key = 'test-request-1';
select throws_ok($$insert into private.agent_actions (task_id, agent_key, kind, target_kind, target_id, preview)
  select id, 'chief_of_staff', 'communication.note', 'communication', 'CM-1', 'Preview again' from private.agent_tasks where request_key = 'test-request-1'$$,
  '23505', null, 'A task proposes the same action on the same target once');

insert into private.owner_notifications (dedupe_key, channel, severity, subject, body) values ('test-alert', 'email', 'info', 'Subject', 'Body');
select throws_ok($$insert into private.owner_notifications (dedupe_key, channel, severity, subject, body) values ('test-alert', 'email', 'info', 'Subject', 'Body')$$,
  '23505', null, 'An alert is recorded once per channel');

select ok(hub.get_backend_contract() -> 'features' @> '["platform.agents.v1"]'::jsonb,
  'The AI team control plane is declared in release metadata');

select * from finish();
rollback;
