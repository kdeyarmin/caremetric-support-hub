begin;
select plan(9);

select is((select kind from private.hub_settings where key = 'growth.enrichment_provider'), 'text', 'The contact-data service is a choice');
select is(private.growth_enrichment_cap(), 10, 'Ten lookups a day until the owner saves a number');
update private.hub_settings set value = '9999' where key = 'growth.enrichment_daily_credits';
select is(private.growth_enrichment_cap(), 500, 'Never more than five hundred a day');
select ok((select relrowsecurity from pg_class where oid = 'private.growth_people'::regclass), 'People have row level security');
select ok(not has_table_privilege('hub_app_server', 'private.growth_people', 'select'), 'The server reads people only through functions');
select ok(has_function_privilege('hub_app_server', 'private.growth_enrichment_reserve(integer)', 'execute')
  and not has_function_privilege('authenticated', 'private.growth_enrichment_reserve(integer)', 'execute'), 'Only the server reserves credits');
select ok(not has_function_privilege('hub_app_server', 'private.growth_import_rows(jsonb,uuid)', 'execute'), 'Importing goes through the owner or the signed endpoint');
select ok(position('hub.authorize_app_command()' in pg_get_functiondef('hub.growth_people_decide(uuid[],text)'::regprocedure)) > 0, 'Only the owner decides on found people');
select ok(hub.get_backend_contract() -> 'features' ? 'platform.agents.growth-people.v1', 'The people feature is declared');

select * from finish();
rollback;
