begin;
select plan(7);

-- The owner's two settings exist and start unset: the switch off, the daily number at its default.
select is((select count(*)::integer from private.hub_settings where (key, kind) in (('growth.address_service', 'flag'), ('growth.address_service_daily', 'number'))),
  2, 'The verification service has its switch and its daily number');
select is((select count(*)::integer from private.hub_settings where key in ('growth.address_service', 'growth.address_service_daily') and value is not null),
  0, 'Both start unset: the switch off');

-- Only the Hub server reserves a check; the daily number and the counts are closed to every role.
select ok(has_function_privilege('hub_app_server', 'private.growth_address_service_reserve(integer)', 'execute')
  and not has_function_privilege('authenticated', 'private.growth_address_service_reserve(integer)', 'execute')
  and not has_function_privilege('service_role', 'private.growth_address_service_reserve(integer)', 'execute')
  and not has_function_privilege('hub_app_server', 'private.growth_address_service_cap()', 'execute'), 'Only the server reserves a service check');
select ok((select relrowsecurity from pg_class where oid = 'private.growth_address_service_days'::regclass)
  and not has_table_privilege('hub_app_server', 'private.growth_address_service_days', 'select'), 'Nobody reads the daily counts directly');
select throws_ok($$ select private.growth_address_service_reserve(1) $$, '42501', null, 'Outside the server role nothing is reserved');

-- An address the service confirmed is recorded as such, and only one of the known ways.
select ok(position('''service''' in pg_get_functiondef('private.growth_person_address(uuid,text,text,text,text)'::regprocedure)) > 0
  and exists (select 1 from pg_constraint c where c.conrelid = 'private.growth_people'::regclass and c.contype = 'c'
    and pg_get_constraintdef(c.oid) like '%address_found%' and position('''service''' in pg_get_constraintdef(c.oid)) > 0),
  'A service-confirmed address is recorded as found by the service');
select ok(hub.get_backend_contract() -> 'features' ? 'platform.agents.growth-address-service.v1', 'The verification service feature is declared');

select * from finish();
rollback;
