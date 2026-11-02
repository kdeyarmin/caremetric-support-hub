begin;
select plan(14);

create temporary table hardening_operations(signature text primary key) on commit drop;
insert into hardening_operations values
  ('private.agent_task_heartbeat(uuid,integer,integer)'),
  ('private.agent_task_finish(uuid,text,jsonb,text,timestamp with time zone,integer)'),
  ('private.agent_actions_ready(integer,text[],text[])'),
  ('private.agent_action_executed(uuid,boolean,jsonb,integer)'),
  ('private.agent_action_release(uuid,integer)');

create temporary table hardening_wrappers(signature text primary key) on commit drop;
insert into hardening_wrappers values
  ('private.agent_task_heartbeat(uuid,integer)'),
  ('private.agent_task_finish(uuid,text,jsonb,text,timestamp with time zone)'),
  ('private.agent_actions_ready(integer)'),
  ('private.agent_action_executed(uuid,boolean,jsonb)');

-- The new columns, and the closed boundary around them.
select ok(
  (select count(*) from pg_attribute
   where not attisdropped and (attrelid, attname) in ((to_regclass('private.owner_notifications'), 'attempted_at'), (to_regclass('private.agent_actions'), 'executions'))) = 2,
  'Every notification attempt has its own time and every action start its own number');

select ok(not bool_or(has_column_privilege(role_name, relation, column_name, 'select,insert,update')),
  'No browser, service or server role reaches the new columns directly')
from (values ('private.owner_notifications', 'attempted_at'), ('private.agent_actions', 'executions')) as column_list(relation, column_name)
cross join unnest(array['public', 'anon', 'authenticated', 'service_role', 'hub_app_server']) as role_name;

select throws_ok($$insert into private.agent_actions (agent_key, kind, preview, executions) values ('chief_of_staff', 'communication.note', 'Preview', -1)$$,
  '23514', null, 'An action cannot have started a negative number of times');

insert into private.owner_notifications (dedupe_key, channel, severity, subject, body) values ('hardening-test-alert', 'email', 'info', 'Subject', 'Body');
select ok((select attempted_at is not null and attempted_at >= created_at from private.owner_notifications where dedupe_key = 'hardening-test-alert'),
  'A new notification starts with its first attempt time');

-- The new operations: security definer with a pinned empty search path, the Hub server role only.
select ok(bool_and(p.prosecdef and coalesce(p.proconfig @> array['search_path=""'], false)) and count(*) = 5,
  'Every new operation is a security definer with a pinned empty search path')
from hardening_operations operation join pg_proc p on p.oid = to_regprocedure(operation.signature);

select ok(not bool_or(has_function_privilege(role_name, operation.signature, 'execute')),
  'No browser or service role executes a new operation')
from hardening_operations operation cross join unnest(array['public', 'anon', 'authenticated', 'service_role']) as role_name;

select ok(bool_and(has_function_privilege('hub_app_server', operation.signature, 'execute')),
  'The Hub server role executes every new operation')
from hardening_operations operation;

select throws_ok($$select private.agent_task_heartbeat(gen_random_uuid(), 600, 1)$$, '42501', 'Application server required.',
  'A heartbeat from any other session user is refused');
select throws_ok($$select private.agent_task_finish(gen_random_uuid(), 'done', null, null, null, 1)$$, '42501', 'Application server required.',
  'Finishing a task as any other session user is refused');
select throws_ok($$select private.agent_actions_ready(10, null::text[], null::text[])$$, '42501', 'Application server required.',
  'Listing ready actions as any other session user is refused');
select throws_ok($$select private.agent_action_executed(gen_random_uuid(), true, null, 1)$$, '42501', 'Application server required.',
  'Settling an execution as any other session user is refused');
select throws_ok($$select private.agent_action_release(gen_random_uuid(), 1)$$, '42501', 'Application server required.',
  'Handing an execution back as any other session user is refused');

-- The signatures that existed before stay, as wrappers, so a server built earlier keeps working.
select ok(bool_and(p.prosecdef and coalesce(p.proconfig @> array['search_path=""'], false)
    and has_function_privilege('hub_app_server', wrapper.signature, 'execute')
    and not has_function_privilege('anon', wrapper.signature, 'execute')
    and not has_function_privilege('authenticated', wrapper.signature, 'execute')
    and not has_function_privilege('service_role', wrapper.signature, 'execute')) and count(*) = 4,
  'The earlier signatures remain, server-only')
from hardening_wrappers wrapper join pg_proc p on p.oid = to_regprocedure(wrapper.signature);

select ok(hub.get_backend_contract() -> 'features' @> '["platform.agents.hardening.v1"]'::jsonb,
  'The AI team hardening is declared in release metadata');

select * from finish();
rollback;
