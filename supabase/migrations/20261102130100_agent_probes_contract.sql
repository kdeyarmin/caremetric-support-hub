-- Additive deployment gate for the Platform Engineer's health probes. Declaring the feature
-- changes no behavior: the probe table stays closed to every browser, service and server role,
-- and the one operation that writes it stays reachable only by the Hub server role. The gate
-- refuses to declare the feature if either has drifted.
do $$
declare
  contract jsonb := hub.get_backend_contract();
  role_name text;
  signature text := 'private.agent_probe_record(text,boolean,integer,integer,text,integer,text)';
begin
  if (contract @> '{"api_version":4,"features":["platform.agents.v1"]}'::jsonb) is not true then
    raise exception 'Apply the AI team control plane first' using errcode = '55000';
  end if;

  if to_regclass('private.agent_probe_state') is null
    or not (select relrowsecurity from pg_class where oid = to_regclass('private.agent_probe_state')) then
    raise exception 'The probe state table must exist with row level security' using errcode = '55000';
  end if;
  foreach role_name in array array['anon', 'authenticated', 'service_role', 'hub_app_server'] loop
    if has_table_privilege(role_name, 'private.agent_probe_state', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
      or has_any_column_privilege(role_name, 'private.agent_probe_state', 'SELECT,INSERT,UPDATE') then
      raise exception 'The probe state table must remain closed to every browser, service and server role' using errcode = '55000';
    end if;
  end loop;

  if to_regprocedure(signature) is null
    or not (select p.prosecdef and p.proconfig @> array['search_path=""'] from pg_proc p where p.oid = to_regprocedure(signature))
    or has_function_privilege('anon', signature, 'EXECUTE') or has_function_privilege('authenticated', signature, 'EXECUTE')
    or has_function_privilege('service_role', signature, 'EXECUTE')
    or not has_function_privilege('hub_app_server', signature, 'EXECUTE') then
    raise exception 'The probe operation must be security definer and executable by the Hub server only' using errcode = '55000';
  end if;

  if not (contract -> 'features' @> '["platform.agents.probes.v1"]'::jsonb) then
    contract := jsonb_set(contract, '{features}', (contract -> 'features') || '["platform.agents.probes.v1"]'::jsonb);
  end if;
  execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L',
    'select ' || quote_literal(contract::text) || '::jsonb');
end $$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon, authenticated;
