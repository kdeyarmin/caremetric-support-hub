-- Additive deployment gate for article publishing on its own. Declaring the feature changes no behavior by itself (articles publish
-- unapproved only when the owner's "articles" autonomy step adds content.publish to the Content Marketer's list): it states that the
-- publishing operation is still a security definer with a pinned empty search path executable by the Hub server role alone, that it
-- still authors as the AI assistant, and that an article nobody approved is published only after re-checking, at publication, that
-- the Content Marketer is active, on Act and trusted with content.publish, holding its row until publication. Every test fails closed.
do $$
declare
  contract jsonb := hub.get_backend_contract();
  signature text := 'private.agent_content_publish(uuid,integer)';
  definition text;
begin
  if (contract @> '{"api_version":4,"features":["platform.agents.content.v1","platform.agents.hardening.v1","platform.agents.autonomy.v1"]}'::jsonb) is not true then
    raise exception 'Apply the Content Marketer, the AI team hardening and autonomy steps first' using errcode = '55000';
  end if;
  if to_regprocedure(signature) is null
    or not coalesce((select p.prosecdef and coalesce(p.proconfig @> array['search_path=""'], false) from pg_proc p where p.oid = to_regprocedure(signature)), false)
    or has_function_privilege('anon', signature, 'EXECUTE') or has_function_privilege('authenticated', signature, 'EXECUTE')
    or has_function_privilege('service_role', signature, 'EXECUTE')
    or not has_function_privilege('hub_app_server', signature, 'EXECUTE') then
    raise exception 'Publishing an article must be a security definer executable by the Hub server only' using errcode = '55000';
  end if;
  definition := pg_get_functiondef(to_regprocedure(signature));
  if position('private.require_hub_app_server()' in definition) = 0
    or position('a1a00000-a1a0-4000-8000-000000000001' in definition) = 0
    or position('decided_by is null' in definition) = 0
    or position('auto_approve_kinds' in definition) = 0 or position('content.publish' in definition) = 0
    or position('approval_required' in definition) = 0
    or position('v_agent.status is distinct from ''active''' in definition) = 0
    or position('v_agent.autonomy is distinct from ''act''' in definition) = 0
    or position('where key = v_action.agent_key for share' in definition) = 0 then
    raise exception 'An article nobody approved must be published only while the Content Marketer is trusted with publishing' using errcode = '55000';
  end if;
  if not exists (select 1 from private.agents where key = 'content_marketer') then
    raise exception 'The Content Marketer must exist' using errcode = '55000';
  end if;

  if not (contract -> 'features' @> '["platform.agents.content-autopublish.v1"]'::jsonb) then
    contract := jsonb_set(contract, '{features}', (contract -> 'features') || '["platform.agents.content-autopublish.v1"]'::jsonb);
  end if;
  execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L',
    'select ' || quote_literal(contract::text) || '::jsonb');
end $$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon, authenticated;
