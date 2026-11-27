begin;
select plan(5);

-- Hunter finds the owners' addresses for the owner's batches (20261127230000_growth_hunter.sql).
select ok((hub.get_backend_contract() -> 'features') ? 'platform.agents.growth-hunter.v1', 'The Hunter feature is declared');
select is((select count(*)::int from private.hub_settings where key in ('growth.hunter', 'growth.hunter_daily')), 2, 'The two Hunter settings exist');
select ok(not has_table_privilege('hub_app_server', 'private.growth_hunter_lookups', 'select'), 'The lookups are closed to the Hub server''s role');
select ok(has_function_privilege('hub_app_server', 'private.growth_hunter_begin(uuid,uuid)', 'execute')
  and not has_function_privilege('authenticated', 'private.growth_hunter_begin(uuid,uuid)', 'execute'), 'Only the Hub server reserves a lookup');
select ok(position('p_found <> ''hunter''' in pg_get_functiondef('private.growth_person_address(uuid,text,text,text,text)'::regprocedure)) > 0,
  'An address Hunter found is never permitted for the Marketing Manager on its own');

select * from finish();
rollback;
