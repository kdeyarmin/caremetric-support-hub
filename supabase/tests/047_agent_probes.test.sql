begin;
select plan(12);

-- The boundary: a closed table and one server-only operation, exactly like the rest of the control plane.
select ok(to_regclass('private.agent_probe_state') is not null
    and (select relrowsecurity from pg_class where oid = to_regclass('private.agent_probe_state')),
  'The probe state table exists with row level security');

select ok(not bool_or(has_table_privilege(role_name, 'private.agent_probe_state', 'select,insert,update,delete,truncate')
    or has_any_column_privilege(role_name, 'private.agent_probe_state', 'select,insert,update')),
  'No browser, service or server role touches the probe state table directly')
from unnest(array['public', 'anon', 'authenticated', 'service_role', 'hub_app_server']) as role_name;

select ok(p.prosecdef and p.proconfig @> array['search_path=""'],
  'The probe operation is a security definer with a pinned empty search path')
from pg_proc p where p.oid = to_regprocedure('private.agent_probe_record(text,boolean,integer,integer,text,integer,text)');

select ok(has_function_privilege('hub_app_server', 'private.agent_probe_record(text,boolean,integer,integer,text,integer,text)', 'execute'),
  'The Hub server role executes the probe operation');

select ok(not bool_or(has_function_privilege(role_name, 'private.agent_probe_record(text,boolean,integer,integer,text,integer,text)', 'execute')),
  'No browser, service or public role executes the probe operation')
from unnest(array['public', 'anon', 'authenticated', 'service_role']) as role_name;

-- The test session user is not the Hub server, so the operation refuses it.
select throws_ok($$select private.agent_probe_record('hub', true, 200, 10)$$, '42501', 'Application server required.',
  'Recording a probe refuses every session user other than the Hub server');

set local role authenticated;
select throws_ok($$select private.agent_probe_record('hub', true, 200, 10)$$, '42501', 'permission denied for function agent_probe_record',
  'Signed-in users cannot record a probe');
reset role;

-- Row rules the operation relies on.
select throws_ok($$insert into private.agent_probe_state (target_key) values ('Bad Key')$$, '23514', null, 'Probe targets are lowercase identifiers');
select throws_ok($$insert into private.agent_probe_state (target_key, state) values ('hub', 'sideways')$$, '23514', null, 'A product is unknown, up or down');
select throws_ok($$insert into private.agent_probe_state (target_key, last_failure) values ('hub', 'The page said <html>')$$, '23514', null,
  'A failure is one fixed word, never page content');
select throws_ok($$insert into private.agent_probe_state (target_key, consecutive_failures) values ('hub', -1)$$, '23514', null,
  'Failures in a row cannot be negative');

select ok(hub.get_backend_contract() -> 'features' @> '["platform.agents.probes.v1"]'::jsonb,
  'The health probes are declared in release metadata');

select * from finish();
rollback;
