-- Additive deployment gate for the Hub's settings. Declaring the feature tells the Hub server to read its switches and values from the
-- database instead of Railway variables (copying each variable's value in once). Until it is declared the server keeps reading the
-- variables, so the server can be deployed before this migration is applied. It states that the settings exist, closed to every role;
-- that the server operations are security definers with a pinned empty search path executable by the Hub server alone; and that the
-- owner operations exist, authorize the owner's session themselves and are closed to anonymous callers. Every test fails closed.
do $$
declare
  contract jsonb := hub.get_backend_contract();
  feature constant text := 'platform.settings.v1';
  signature text;
begin
  if (contract @> '{"api_version":4}'::jsonb) is not true then
    raise exception 'Apply the version 4 release contract first' using errcode = '55000';
  end if;

  if to_regclass('private.hub_settings') is null
    or not (select relrowsecurity from pg_class where oid = 'private.hub_settings'::regclass)
    or (select count(*) from private.hub_settings) < 32
    or exists (select 1 from unnest(array['anon', 'authenticated', 'service_role', 'hub_app_server']) role_name
               where has_table_privilege(role_name, 'private.hub_settings', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')) then
    raise exception 'The Hub settings must exist and be closed to every role' using errcode = '55000';
  end if;

  foreach signature in array array['private.hub_settings_values()', 'private.hub_settings_import(jsonb)'] loop
    if to_regprocedure(signature) is null
      or not coalesce((select p.prosecdef and coalesce(p.proconfig @> array['search_path=""'], false) from pg_proc p where p.oid = to_regprocedure(signature)), false)
      or has_function_privilege('anon', signature, 'EXECUTE') or has_function_privilege('authenticated', signature, 'EXECUTE')
      or has_function_privilege('service_role', signature, 'EXECUTE')
      or not has_function_privilege('hub_app_server', signature, 'EXECUTE')
      or position('private.require_hub_app_server()' in pg_get_functiondef(to_regprocedure(signature))) = 0 then
      raise exception 'The server''s settings operations must be security definers executable by the Hub server only' using errcode = '55000';
    end if;
  end loop;

  if to_regprocedure('hub.get_hub_settings()') is null or to_regprocedure('hub.set_hub_setting(text,jsonb,timestamptz)') is null
    or has_function_privilege('anon', 'hub.get_hub_settings()', 'EXECUTE')
    or has_function_privilege('anon', 'hub.set_hub_setting(text,jsonb,timestamptz)', 'EXECUTE')
    or position('hub.authorize_app_admin()' in pg_get_functiondef('hub.get_hub_settings()'::regprocedure)) = 0
    or position('hub.authorize_app_command()' in pg_get_functiondef('hub.set_hub_setting(text,jsonb,timestamptz)'::regprocedure)) = 0 then
    raise exception 'The owner''s settings must authorize the owner''s session and be closed to anonymous callers' using errcode = '55000';
  end if;

  if not (contract -> 'features' @> to_jsonb(array[feature])) then
    contract := jsonb_set(contract, '{features}', (contract -> 'features') || to_jsonb(array[feature]));
  end if;
  execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L',
    'select ' || quote_literal(contract::text) || '::jsonb');
end $$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon, authenticated;
