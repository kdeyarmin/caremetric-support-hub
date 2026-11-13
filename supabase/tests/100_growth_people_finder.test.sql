begin;
select plan(7);

select ok(position('''website''' in (select pg_get_constraintdef(oid) from pg_constraint where conrelid = 'private.growth_people'::regclass and conname = 'growth_people_source_check')) > 0
  and position('''npi_registry''' in (select pg_get_constraintdef(oid) from pg_constraint where conrelid = 'private.growth_people'::regclass and conname = 'growth_people_source_check')) > 0
  and position('''apollo''' in (select pg_get_constraintdef(oid) from pg_constraint where conrelid = 'private.growth_people'::regclass and conname = 'growth_people_source_check')) > 0,
  'People come from the website and the NPI registry, and those recorded from Apollo stay');
select ok(has_function_privilege('hub_app_server', 'private.growth_person_address(uuid,text,text,text,text)', 'execute')
  and not exists (select 1 from unnest(array['anon', 'authenticated', 'service_role']) r where has_function_privilege(r, 'private.growth_person_address(uuid,text,text,text,text)', 'execute')),
  'Only the Hub server records a found address');
select ok(position('''review''' in pg_get_functiondef('private.growth_person_address(uuid,text,text,text,text)'::regprocedure)) > 0
  and position('email_suppressions' in pg_get_functiondef('private.growth_person_address(uuid,text,text,text,text)'::regprocedure)) > 0,
  'A found address waits for the owner and is never one that unsubscribed');
select ok(position('''agencies''' in pg_get_functiondef('private.growth_people_candidates(integer)'::regprocedure)) > 0
  and has_function_privilege('hub_app_server', 'private.growth_people_candidates(integer)', 'execute')
  and not has_function_privilege('authenticated', 'private.growth_people_candidates(integer)', 'execute'),
  'Candidates carry their roster agencies, for the server only');
select ok(position('address_found' in pg_get_functiondef('hub.growth_people(integer)'::regprocedure)) > 0
  and has_function_privilege('authenticated', 'hub.growth_people(integer)', 'execute') and not has_function_privilege('anon', 'hub.growth_people(integer)', 'execute'),
  'The owner sees how each waiting address was found');
select is((select count(*)::integer from private.hub_settings where key = 'growth.enrichment_provider' and value = '"apollo"'::jsonb), 0,
  'No saved choice still names Apollo');
select ok(hub.get_backend_contract() -> 'features' ? 'platform.agents.growth-people-finder.v1', 'The people finder feature is declared');

select * from finish();
rollback;
