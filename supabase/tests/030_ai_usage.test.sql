begin;
select plan(9);

select has_table('private', 'ai_usage', 'The AI usage ledger exists');
select ok((select relrowsecurity from pg_class where oid = 'private.ai_usage'::regclass),
  'The ledger enforces row level security');
select ok(not bool_or(has_table_privilege(role_name, 'private.ai_usage', 'select,insert,update,delete')
    or has_any_column_privilege(role_name, 'private.ai_usage', 'select,insert,update')),
  'No browser, service or server role touches the ledger directly')
from unnest(array['public', 'anon', 'authenticated', 'service_role', 'hub_app_server']) as role_name;

select ok(has_function_privilege('hub_app_server', 'private.record_ai_usage(uuid,text,text,text,text,integer,integer,integer)', 'execute'),
  'The Hub server role records AI usage');
select ok(not bool_or(has_function_privilege(role_name, 'private.record_ai_usage(uuid,text,text,text,text,integer,integer,integer)', 'execute')),
  'No browser, service or public role records AI usage')
from unnest(array['public', 'anon', 'authenticated', 'service_role']) as role_name;

-- The test session user is not the Hub server, so recording refuses it.
select throws_ok($$select private.record_ai_usage(null, 'staff', 'case_summary', 'claude-haiku-5-5', 'completed', 120, 45, 900)$$,
  '42501', 'Application server required.', 'Recording refuses every session user other than the Hub server');

select ok(has_function_privilege('authenticated', 'hub.get_ai_usage_summary(integer)', 'execute')
  and not has_function_privilege('anon', 'hub.get_ai_usage_summary(integer)', 'execute'),
  'The usage summary is a signed-in read');
set local role authenticated;
select throws_ok('select hub.get_ai_usage_summary(30)', '28000', 'Current administrator session required.',
  'The usage summary requires the current administrator session');
reset role;

select ok(hub.get_backend_contract()->'features' @> '["support.ai-usage.v1"]'::jsonb,
  'The AI usage ledger is declared in release metadata');

select * from finish();
rollback;
