-- Declares platform.agents.growth-address-service.v1 once the address check, people finder and work recovery features are declared;
-- the service's checks are reserved by the Hub server alone, only while the owner's switch is on; its daily number and counts are closed
-- to every role; its two settings have rows; and an address the service confirmed is recorded as such.
do $$
declare
  contract jsonb := hub.get_backend_contract();
  feature constant text := 'platform.agents.growth-address-service.v1';
  fn constant text := 'private.growth_address_service_reserve(integer)';
begin
  if (contract @> '{"api_version":4,"features":["platform.settings.v1","platform.agents.growth-address-check.v1","platform.agents.growth-people-finder.v1","platform.agents.work-recovery.v1"]}'::jsonb) is not true then
    raise exception 'Apply the address check, people finder and work recovery migrations first' using errcode = '55000';
  end if;
  if to_regprocedure(fn) is null or not has_function_privilege('hub_app_server', fn, 'execute')
    or exists (select 1 from unnest(array['anon', 'authenticated', 'service_role']) r where has_function_privilege(r, fn, 'execute'))
    or position('private.require_hub_app_server()' in pg_get_functiondef(fn::regprocedure)) = 0
    or position('growth.address_service''' in pg_get_functiondef(fn::regprocedure)) = 0 then
    raise exception 'Only the Hub server may reserve the verification service''s checks, and only while the owner''s switch is on' using errcode = '55000';
  end if;
  if to_regprocedure('private.growth_address_service_cap()') is null
    or exists (select 1 from unnest(array['anon', 'authenticated', 'service_role', 'hub_app_server']) r
               where has_function_privilege(r, 'private.growth_address_service_cap()', 'execute')) then
    raise exception 'The verification service''s daily number must be closed to every role' using errcode = '55000';
  end if;
  if to_regclass('private.growth_address_service_days') is null
    or not (select relrowsecurity from pg_class where oid = 'private.growth_address_service_days'::regclass)
    or exists (select 1 from unnest(array['anon', 'authenticated', 'service_role', 'hub_app_server']) r
               where has_table_privilege(r, 'private.growth_address_service_days', 'select')) then
    raise exception 'The verification service''s daily counts must be closed to every role' using errcode = '55000';
  end if;
  if (select count(*) from private.hub_settings where (key, kind) in (('growth.address_service', 'flag'), ('growth.address_service_daily', 'number'))) <> 2 then
    raise exception 'The verification service''s settings must exist' using errcode = '55000';
  end if;
  if position('''service''' in pg_get_functiondef('private.growth_person_address(uuid,text,text,text,text)'::regprocedure)) = 0
    or not exists (select 1 from pg_constraint c where c.conrelid = 'private.growth_people'::regclass and c.contype = 'c'
                     and position('''service''' in pg_get_constraintdef(c.oid)) > 0) then
    raise exception 'An address the verification service confirmed must be recorded as such' using errcode = '55000';
  end if;
  if not (contract -> 'features' @> to_jsonb(array[feature])) then
    contract := jsonb_set(contract, '{features}', (contract -> 'features') || to_jsonb(array[feature]));
  end if;
  execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L',
    'select ' || quote_literal(contract::text) || '::jsonb');
end $$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon, authenticated;
