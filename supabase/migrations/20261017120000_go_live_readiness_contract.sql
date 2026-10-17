-- Additive deployment gate for the AI go-live readiness panel: the Hub admin
-- surface that reports, at view time, whether the AI case assistance release is
-- fully live (production migrations applied, the Anthropic key present on the
-- Hub service, the automation toggle enabled, and help.caremetric.ai
-- resolving). The panel itself is served by the Hub server and reads the live
-- state directly; this gate only registers the capability in the backend
-- contract, like every reviewed release before it. Registering the feature
-- changes no behavior: the panel reports only and never applies a migration,
-- sets a key, flips the toggle, or touches DNS.
do $$ declare contract jsonb:=hub.get_backend_contract(); begin
  if (contract @> '{"api_version":4,"features":["support.ai-assistance.v1","support.ai-automation.v1"]}'::jsonb) is not true then
    raise exception 'Apply the AI case assistance contract first' using errcode='55000';
  end if;
  if not (contract->'features' @> '["support.go-live-readiness.v1"]'::jsonb) then
    contract:=jsonb_set(contract,'{features}',(contract->'features')||'["support.go-live-readiness.v1"]'::jsonb);
  end if;
  execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L','select '||quote_literal(contract::text)||'::jsonb');
end $$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon,authenticated;
