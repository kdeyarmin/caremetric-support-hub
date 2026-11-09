-- Additive deployment gate for the public article feed (20261109130000_public_articles.sql). Declaring the feature changes no
-- behavior by itself: until it is declared, the Hub server does not answer /api/public/articles. It states that the read exists,
-- is a security definer with a pinned empty search path that checks for the Hub server first, and is executable by the Hub server
-- alone. Every test fails closed.
do $$
declare
  contract jsonb := hub.get_backend_contract();
  feature constant text := 'content.public-articles.v1';
  signature constant text := 'private.public_articles(text)';
begin
  if (contract @> '{"api_version":4}'::jsonb) is not true then
    raise exception 'Apply the version 4 backend contract first' using errcode = '55000';
  end if;

  if to_regprocedure(signature) is null
    or not coalesce((select p.prosecdef and coalesce(p.proconfig @> array['search_path=""'], false) from pg_proc p where p.oid = to_regprocedure(signature)), false)
    or has_function_privilege('anon', signature, 'EXECUTE') or has_function_privilege('authenticated', signature, 'EXECUTE')
    or has_function_privilege('service_role', signature, 'EXECUTE')
    or not has_function_privilege('hub_app_server', signature, 'EXECUTE')
    or position('private.require_hub_app_server()' in pg_get_functiondef(to_regprocedure(signature))) = 0 then
    raise exception 'Reading the public articles must be a security definer executable by the Hub server only' using errcode = '55000';
  end if;

  if not (contract -> 'features' @> to_jsonb(array[feature])) then
    contract := jsonb_set(contract, '{features}', (contract -> 'features') || to_jsonb(array[feature]));
  end if;
  execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L',
    'select ' || quote_literal(contract::text) || '::jsonb');
end $$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon, authenticated;
