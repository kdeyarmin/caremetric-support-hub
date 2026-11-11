do $$
declare
  contract jsonb := hub.get_backend_contract();
  feature constant text := 'platform.social-connections.v1';
  signature text;
begin
  if not (contract -> 'features' @> '["platform.settings.v1","platform.agents.social.v1"]'::jsonb)
    or not (select relrowsecurity from pg_class where oid = 'private.social_connections'::regclass)
    or exists(select 1 from pg_policies where schemaname = 'private' and tablename = 'social_connections')
    or (select count(*) from private.social_connections) <> 2
    or exists(select 1 from unnest(array['anon','authenticated','service_role','hub_app_server']) role_name
      where has_table_privilege(role_name,'private.social_connections','select,insert,update,delete,truncate')) then
    raise exception 'Social connections must be private and settings must exist' using errcode = '55000';
  end if;
  foreach signature in array array['private.social_connection_values()', 'private.save_social_connection(text,uuid,text,jsonb)'] loop
    if not (select prosecdef and coalesce(proconfig @> array['search_path=""'],false) from pg_proc where oid = signature::regprocedure)
      or has_function_privilege('anon',signature,'execute') or has_function_privilege('authenticated',signature,'execute')
      or has_function_privilege('service_role',signature,'execute') or not has_function_privilege('hub_app_server',signature,'execute')
      or position('private.require_hub_app_server()' in pg_get_functiondef(signature::regprocedure)) = 0 then
      raise exception 'Social credentials must be restricted to the application server' using errcode = '55000';
    end if;
  end loop;
  if position('hub.authorize_app_command()' in pg_get_functiondef('private.save_social_connection(text,uuid,text,jsonb)'::regprocedure)) = 0 then
    raise exception 'Saving credentials must require a current owner session' using errcode = '55000';
  end if;
  if not (contract -> 'features' @> to_jsonb(array[feature])) then contract := jsonb_set(contract,'{features}',(contract -> 'features') || to_jsonb(array[feature])); end if;
  execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L','select ' || quote_literal(contract::text) || '::jsonb');
end $$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon, authenticated;
