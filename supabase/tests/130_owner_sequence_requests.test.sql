begin;
select plan(6);

-- Requests an operator queues for the owner (20261127200000_owner_sequence_requests.sql).
select ok((hub.get_backend_contract() -> 'features') ? 'platform.agents.owner-sequence-requests.v1', 'The owner sequence requests feature is declared');
select ok(not bool_or(has_table_privilege(role_name, 'private.owner_sequence_requests', 'SELECT,INSERT,UPDATE,DELETE')),
  'The requests are closed to every role, the Hub server included')
from unnest(array['anon', 'authenticated', 'service_role', 'hub_app_server']) role_name;
select throws_ok('select private.owner_sequence_request_next()', '42501', 'Application server required.', 'Only the Hub server takes a request');
select ok(not bool_or(has_function_privilege(role_name, fn, 'execute')), 'The shared save, check and approval cannot be run directly')
from unnest(array['anon', 'authenticated', 'service_role', 'hub_app_server']) role_name,
  unnest(array['private.owner_sequence_save(uuid,jsonb)', 'private.owner_sequence_check_people(jsonb)', 'private.owner_sequence_approve_as(uuid,uuid,integer,text)']) fn;
set local role authenticated;
select throws_ok($$select hub.owner_sequence_create('{}'::jsonb)$$, '28000', null, 'Saving a sequence still needs the owner''s session');
reset role;
select ok(position('platform.admin' in pg_get_functiondef('private.owner_sequence_request_next()'::regprocedure)) > 0,
  'A request is prepared only for a CareMetric admin');

select * from finish();
rollback;
