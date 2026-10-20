begin;
select plan(10);

create temporary table automation_operations(signature text primary key) on commit drop;
insert into automation_operations values
  ('private.ai_automation_eligible_cases()'), ('private.ai_automation_claim(uuid)'),
  ('private.ai_automation_active_cases()'), ('private.ai_automation_work(uuid)'),
  ('private.ai_automation_knowledge(uuid)'), ('private.ai_automation_post_message(uuid,text)'),
  ('private.ai_automation_post_note(uuid,text)'), ('private.ai_automation_escalate(uuid)'),
  ('private.ai_automation_resolve(uuid)'), ('private.ai_automation_save_state(uuid,jsonb)');

select ok(bool_and(p.prosecdef and p.proconfig @> array['search_path=""']) and count(*) = 10,
  'Every automation operation is a security definer with a pinned empty search path')
from automation_operations operation
join pg_proc p on p.oid = to_regprocedure(operation.signature);

select ok(bool_and(has_function_privilege('hub_app_server', signature, 'execute')),
  'The Hub server role executes every automation operation')
from automation_operations;

select ok(not bool_or(has_function_privilege(role_name, signature, 'execute')),
  'No browser, service or public role executes an automation operation')
from automation_operations
cross join unnest(array['public', 'anon', 'authenticated', 'service_role']) as role_name;

select ok(not bool_or(has_function_privilege(role_name, signature, 'execute')),
  'The eligibility and stage helpers stay internal to the operations')
from unnest(array['private.ai_automation_case_eligible(uuid)', 'private.ai_automation_state_for_step(uuid,text[])']) as signature
cross join unnest(array['public', 'anon', 'authenticated', 'service_role', 'hub_app_server']) as role_name;

select ok(not bool_or(has_table_privilege('hub_app_server', relation, 'select,insert,update,delete,truncate')
    or has_any_column_privilege('hub_app_server', relation, 'select,insert,update')),
  'The Hub server role still holds no direct privilege on case, content or audit tables')
from unnest(array['hub.support_cases', 'hub.case_messages', 'private.case_notes', 'hub.case_ai_automation',
  'private.audit_events', 'hub.content_publications', 'hub.content_items', 'hub.content_revisions']) as relation;

-- The test session user is not the Hub server, so every operation refuses it.
select throws_ok('select * from private.ai_automation_eligible_cases()', '42501', 'Application server required.',
  'Automation operations refuse every session user other than the Hub server');
select throws_ok($$select private.ai_automation_post_message('00000000-0000-4000-8000-000000000000', 'Synthetic reply')$$,
  '42501', 'Application server required.', 'Only the Hub server can post an automated reply');

-- The failure policy's state: a streak that starts at zero and a backoff time.
select col_default_is('hub', 'case_ai_automation', 'consecutive_failures', '0',
  'A case under automation starts without a failure streak');
select col_type_is('hub', 'case_ai_automation', 'retry_at', 'timestamp with time zone',
  'A failing case records when the sweep may retry it');

set local role authenticated;
select throws_ok($$select private.ai_automation_claim('00000000-0000-4000-8000-000000000000')$$,
  '42501', 'permission denied for function ai_automation_claim', 'Authenticated users cannot claim cases for automation');
reset role;

select * from finish();
rollback;
