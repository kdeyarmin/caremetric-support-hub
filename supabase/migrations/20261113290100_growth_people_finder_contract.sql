-- Declares platform.agents.growth-people-finder.v1 once people can come from the business's website and the NPI registry, a found
-- address records how it was found, only the Hub server records one, every one waits for the owner and honours unsubscribes, and only
-- the owner reads the people waiting.
do $$
declare
  contract jsonb := hub.get_backend_contract();
  feature constant text := 'platform.agents.growth-people-finder.v1';
  fn constant text := 'private.growth_person_address(uuid,text,text,text,text)';
begin
  if (contract @> '{"api_version":4,"features":["platform.agents.growth-people.v1"]}'::jsonb) is not true then
    raise exception 'Apply the people migrations first' using errcode = '55000';
  end if;
  if position('''website''' in coalesce((select pg_get_constraintdef(oid) from pg_constraint where conrelid = 'private.growth_people'::regclass
      and conname = 'growth_people_source_check'), '')) = 0
    or position('''npi_registry''' in coalesce((select pg_get_constraintdef(oid) from pg_constraint where conrelid = 'private.growth_people'::regclass
      and conname = 'growth_people_source_check'), '')) = 0
    or not exists (select 1 from information_schema.columns where table_schema = 'private' and table_name = 'growth_people' and column_name = 'address_found') then
    raise exception 'People must be recordable from the website and the NPI registry, with how their address was found' using errcode = '55000';
  end if;
  if not has_function_privilege('hub_app_server', fn, 'execute')
    or exists (select 1 from unnest(array['anon', 'authenticated', 'service_role']) r where has_function_privilege(r, fn, 'execute')) then
    raise exception 'Only the Hub server may record a found address' using errcode = '55000';
  end if;
  if position('''review'', now(), p_source_url, ''enriched''' in pg_get_functiondef(fn::regprocedure)) = 0
    or position('email_suppressions' in pg_get_functiondef(fn::regprocedure)) = 0
    or position('''agencies''' in pg_get_functiondef('private.growth_people_candidates(integer)'::regprocedure)) = 0 then
    raise exception 'A found address must wait for the owner and honour unsubscribes' using errcode = '55000';
  end if;
  if position('hub.authorize_app_admin()' in pg_get_functiondef('hub.growth_people(integer)'::regprocedure)) = 0
    or position('address_found' in pg_get_functiondef('hub.growth_people(integer)'::regprocedure)) = 0
    or has_function_privilege('anon', 'hub.growth_people(integer)', 'execute') then
    raise exception 'Only the owner reads the people waiting, with how each address was found' using errcode = '55000';
  end if;
  if not (contract -> 'features' @> to_jsonb(array[feature])) then
    contract := jsonb_set(contract, '{features}', (contract -> 'features') || to_jsonb(array[feature]));
  end if;
  execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L',
    'select ' || quote_literal(contract::text) || '::jsonb');
end $$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon, authenticated;
