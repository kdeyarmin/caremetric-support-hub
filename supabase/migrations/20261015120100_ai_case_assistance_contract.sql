-- Additive deployment gate for AI case assistance and the auto-resolution loop: staff
-- AI actions are served by the Hub server, the customer answers an AI resolution
-- through hub.record_ai_resolution_response, and the case queue carries the loop
-- stage. A frontend or server that relies on these must not deploy against a backend
-- that predates the AI migration.
do $$ declare contract jsonb:=hub.get_backend_contract(); begin
  if (contract @> '{"api_version":4,"features":["support.readiness.v1"]}'::jsonb) is not true then
    raise exception 'Apply the Hub support readiness release first' using errcode='55000';
  end if;
  if to_regprocedure('hub.record_ai_resolution_response(uuid,boolean,uuid)') is null
    or position('ai_stage' in pg_get_viewdef('hub.support_case_queue'::regclass)) = 0
    or position('ai_assistant' in pg_get_constraintdef(
         (select oid from pg_constraint where conname = 'case_messages_author_role_check'))) = 0 then
    raise exception 'Apply the AI case assistance migration first' using errcode='55000';
  end if;
  if not (contract->'features' @> '["support.ai-assistance.v1"]'::jsonb) then
    contract:=jsonb_set(contract,'{features}',(contract->'features')||'["support.ai-assistance.v1"]'::jsonb);
  end if;
  if not (contract->'features' @> '["support.ai-automation.v1"]'::jsonb) then
    contract:=jsonb_set(contract,'{features}',(contract->'features')||'["support.ai-automation.v1"]'::jsonb);
  end if;
  execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L','select '||quote_literal(contract::text)||'::jsonb');
end $$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon,authenticated;
