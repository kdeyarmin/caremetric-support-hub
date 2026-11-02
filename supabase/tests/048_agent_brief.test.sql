begin;
select plan(7);

-- The boundary: one read for the Hub server role, and nobody else.
select ok(p.prosecdef and p.proconfig @> array['search_path=""'],
  'The brief facts operation is a security definer with a pinned empty search path')
from pg_proc p where p.oid = to_regprocedure('private.agent_brief_facts()');

select ok(has_function_privilege('hub_app_server', 'private.agent_brief_facts()', 'execute'),
  'The Hub server role executes the brief facts operation');

select ok(not bool_or(has_function_privilege(role_name, 'private.agent_brief_facts()', 'execute')),
  'No browser, service or public role executes the brief facts operation')
from unnest(array['public', 'anon', 'authenticated', 'service_role']) as role_name;

select throws_ok('select private.agent_brief_facts()', '42501', 'Application server required.',
  'Reading the brief facts refuses every session user other than the Hub server');

set local role authenticated;
select throws_ok('select private.agent_brief_facts()', '42501', 'permission denied for function agent_brief_facts',
  'Signed-in users cannot read the brief facts');
reset role;
set local role anon;
select throws_ok('select private.agent_brief_facts()', '42501', null, 'Anonymous callers cannot read the brief facts');
reset role;

select ok(hub.get_backend_contract() -> 'features' @> '["platform.agents.brief.v1"]'::jsonb,
  'The morning brief is declared in release metadata');

select * from finish();
rollback;
