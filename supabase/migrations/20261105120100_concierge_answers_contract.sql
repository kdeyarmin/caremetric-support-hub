-- Additive deployment gate for support answers. Declaring the feature changes no behavior by itself (the Concierge answers on its own
-- only when the owner's "support_answers" autonomy step adds the kind to its list): it states that `communication.answer` is a checked
-- action kind whose shape admits only cited, model-drafted answers with no identifiers going back by email or chat; that the one
-- operation that records an answer is a security definer with a pinned empty search path executable by the Hub server role alone, that
-- it re-checks the Concierge's trust (active, on Act, holding its row) for an answer nobody approved, sends only to the conversation the
-- action names, and authors the message as the AI assistant; and that the AI
-- assistant profile exists. Every test fails closed. The gate refuses to declare the feature if any of it has drifted.
do $$
declare
  contract jsonb := hub.get_backend_contract();
  signature text := 'private.agent_answer_begin(uuid,integer,text[])';
  definition text;
begin
  if (contract @> '{"api_version":4,"features":["platform.agents.concierge.v1","platform.agents.hardening.v1","support.communications.v1","platform.agents.autonomy.v1"]}'::jsonb) is not true then
    raise exception 'Apply the Support Concierge, the AI team hardening, the communications inbox and autonomy steps first' using errcode = '55000';
  end if;

  if not coalesce((select position('''communication.answer''' in pg_get_constraintdef(oid)) > 0 from pg_constraint
                   where conrelid = 'private.agent_actions'::regclass and conname = 'agent_actions_kind_check'), false)
    or not coalesce((select position('''drafted''' in pg_get_constraintdef(oid)) > 0 and position('''phi''' in pg_get_constraintdef(oid)) > 0
                       and position('sources' in pg_get_constraintdef(oid)) > 0 from pg_constraint
                     where conrelid = 'private.agent_actions'::regclass and conname = 'agent_actions_communication_answer_check'), false) then
    raise exception 'Support answers must be a checked action kind that admits only cited drafted answers with no identifiers' using errcode = '55000';
  end if;

  if to_regprocedure(signature) is null
    or not coalesce((select p.prosecdef and coalesce(p.proconfig @> array['search_path=""'], false) from pg_proc p where p.oid = to_regprocedure(signature)), false)
    or has_function_privilege('anon', signature, 'EXECUTE') or has_function_privilege('authenticated', signature, 'EXECUTE')
    or has_function_privilege('service_role', signature, 'EXECUTE')
    or not has_function_privilege('hub_app_server', signature, 'EXECUTE') then
    raise exception 'Recording an answer must be a security definer executable by the Hub server only' using errcode = '55000';
  end if;
  definition := pg_get_functiondef(to_regprocedure(signature));
  if position('private.require_hub_app_server()' in definition) = 0
    or position('decided_by is null' in definition) = 0 or position('communication.answer' in definition) = 0
    or position('v_agent.status is distinct from ''active''' in definition) = 0
    or position('v_agent.autonomy is distinct from ''act''' in definition) = 0
    or position('where key = v_action.agent_key for share' in definition) = 0
    or position('target_mismatch' in definition) = 0
    or position('a1a00000-a1a0-4000-8000-000000000001' in definition) = 0 then
    raise exception 'Recording an answer must re-check the Concierge''s trust and author it as the AI assistant' using errcode = '55000';
  end if;
  if not exists (select 1 from hub.profiles where id = 'a1a00000-a1a0-4000-8000-000000000001') then
    raise exception 'The CareMetric AI Assistant profile must exist' using errcode = '55000';
  end if;

  if not (contract -> 'features' @> '["platform.agents.concierge-autosend.v1"]'::jsonb) then
    contract := jsonb_set(contract, '{features}', (contract -> 'features') || '["platform.agents.concierge-autosend.v1"]'::jsonb);
  end if;
  execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L',
    'select ' || quote_literal(contract::text) || '::jsonb');
end $$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon, authenticated;
