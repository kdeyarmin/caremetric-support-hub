-- Additive deployment gate for the Chief of Staff's morning brief. Declaring the feature
-- changes no behavior: the one read the brief needs stays a security definer with a pinned empty
-- search path, executable by the Hub server role alone. The gate refuses to declare the feature
-- if that has drifted.
do $$
declare
  contract jsonb := hub.get_backend_contract();
  signature text := 'private.agent_brief_facts()';
begin
  if (contract @> '{"api_version":4,"features":["platform.agents.v1","platform.agents.probes.v1","billing.platform.v1"]}'::jsonb) is not true then
    raise exception 'Apply the AI team control plane, the health probes and platform billing first' using errcode = '55000';
  end if;

  if to_regprocedure(signature) is null
    or not (select p.prosecdef and p.proconfig @> array['search_path=""'] from pg_proc p where p.oid = to_regprocedure(signature))
    or has_function_privilege('anon', signature, 'EXECUTE') or has_function_privilege('authenticated', signature, 'EXECUTE')
    or has_function_privilege('service_role', signature, 'EXECUTE')
    or not has_function_privilege('hub_app_server', signature, 'EXECUTE') then
    raise exception 'The brief facts operation must be security definer and executable by the Hub server only' using errcode = '55000';
  end if;

  if not (contract -> 'features' @> '["platform.agents.brief.v1"]'::jsonb) then
    contract := jsonb_set(contract, '{features}', (contract -> 'features') || '["platform.agents.brief.v1"]'::jsonb);
  end if;
  execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L',
    'select ' || quote_literal(contract::text) || '::jsonb');
end $$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon, authenticated;
