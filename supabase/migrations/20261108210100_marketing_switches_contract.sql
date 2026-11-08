-- Additive deployment gate for the owner's marketing switches. Declaring the feature changes no behavior by itself: until it is
-- declared, the Hub markets CareMetric Intel only. It states that the switches exist for the three products, closed to every role;
-- that the server read is a security definer with a pinned empty search path executable by the Hub server alone; and that the owner
-- operations exist, authorize the owner's session themselves and are closed to anonymous callers. Every test fails closed.
do $$
declare
  contract jsonb := hub.get_backend_contract();
  feature constant text := 'platform.agents.marketing.v1';
  signature constant text := 'private.marketed_products()';
begin
  if (contract @> '{"api_version":4,"features":["platform.agents.v1","platform.agents.hardening.v1","platform.agents.customer-growth.v1"]}'::jsonb) is not true then
    raise exception 'Apply the AI team control plane, its hardening and customer growth first' using errcode = '55000';
  end if;

  if to_regclass('private.marketing_products') is null
    or not (select relrowsecurity from pg_class where oid = 'private.marketing_products'::regclass)
    or (select count(*) from private.marketing_products where product in ('caremetric-intel', 'carebase', 'advisors')) <> 3
    or exists (select 1 from unnest(array['anon', 'authenticated', 'service_role', 'hub_app_server']) role_name
               where has_table_privilege(role_name, 'private.marketing_products', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')) then
    raise exception 'The marketing switches must exist for the three products and be closed to every role' using errcode = '55000';
  end if;

  if to_regprocedure(signature) is null
    or not coalesce((select p.prosecdef and coalesce(p.proconfig @> array['search_path=""'], false) from pg_proc p where p.oid = to_regprocedure(signature)), false)
    or has_function_privilege('anon', signature, 'EXECUTE') or has_function_privilege('authenticated', signature, 'EXECUTE')
    or has_function_privilege('service_role', signature, 'EXECUTE')
    or not has_function_privilege('hub_app_server', signature, 'EXECUTE')
    or position('private.require_hub_app_server()' in pg_get_functiondef(to_regprocedure(signature))) = 0 then
    raise exception 'Reading the marketed products must be a security definer executable by the Hub server only' using errcode = '55000';
  end if;

  if to_regprocedure('hub.get_marketing_products()') is null or to_regprocedure('hub.set_marketing_product(text,boolean,timestamptz)') is null
    or has_function_privilege('anon', 'hub.get_marketing_products()', 'EXECUTE')
    or has_function_privilege('anon', 'hub.set_marketing_product(text,boolean,timestamptz)', 'EXECUTE')
    or position('hub.authorize_app_admin()' in pg_get_functiondef('hub.get_marketing_products()'::regprocedure)) = 0
    or position('hub.authorize_app_command()' in pg_get_functiondef('hub.set_marketing_product(text,boolean,timestamptz)'::regprocedure)) = 0 then
    raise exception 'The owner''s marketing switches must authorize the owner''s session and be closed to anonymous callers' using errcode = '55000';
  end if;

  if not (contract -> 'features' @> to_jsonb(array[feature])) then
    contract := jsonb_set(contract, '{features}', (contract -> 'features') || to_jsonb(array[feature]));
  end if;
  execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L',
    'select ' || quote_literal(contract::text) || '::jsonb');
end $$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon, authenticated;
