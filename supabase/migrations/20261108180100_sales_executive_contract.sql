-- Additive deployment gate for the Sales Executive. Declaring the feature changes no behavior by itself (the agent is seeded paused):
-- it states that the agent and its weekly review schedule exist; that the one operation that hands a prospect's message to it is a
-- security definer with a pinned empty search path, executable by the Hub server alone, that refuses unless the Sales Executive is
-- active and not observe-only, never hands over billing or closed conversations, binds a growth contact only from a signed email and
-- enqueues only the Sales Executive's own reply task. Every test fails closed.
do $$
declare
  contract jsonb := hub.get_backend_contract();
  feature constant text := 'platform.agents.sales-executive.v1';
  signature constant text := 'private.sales_handoff(uuid,uuid)';
  definition text;
begin
  if (contract @> '{"api_version":4,"features":["platform.agents.customer-growth.v1","platform.agents.concierge.v1","platform.agents.hardening.v1","support.communications.v1","platform.agents.autonomy.v1"]}'::jsonb) is not true then
    raise exception 'Apply customer growth, the Support Concierge, the AI team hardening, the communications inbox and autonomy steps first' using errcode = '55000';
  end if;

  if not exists (select 1 from private.agents where key = 'sales_executive') then
    raise exception 'The Sales Executive must be seeded' using errcode = '55000';
  end if;
  if not exists (select 1 from private.agent_schedules where agent_key = 'sales_executive' and task_kind = 'sales.review' and cadence = 'daily' and not requires_session) then
    raise exception 'The Sales Executive''s weekly review must be scheduled' using errcode = '55000';
  end if;

  if to_regprocedure(signature) is null
    or not coalesce((select p.prosecdef and coalesce(p.proconfig @> array['search_path=""'], false) from pg_proc p where p.oid = to_regprocedure(signature)), false)
    or has_function_privilege('anon', signature, 'EXECUTE') or has_function_privilege('authenticated', signature, 'EXECUTE')
    or has_function_privilege('service_role', signature, 'EXECUTE')
    or not has_function_privilege('hub_app_server', signature, 'EXECUTE') then
    raise exception 'The sales hand-off must be a security definer executable by the Hub server only' using errcode = '55000';
  end if;
  definition := pg_get_functiondef(to_regprocedure(signature));
  if position('private.require_hub_app_server()' in definition) = 0
    or position('v_agent.status is distinct from ''active''' in definition) = 0
    or position('v_agent.autonomy = ''observe''' in definition) = 0
    or position('''billing''' in definition) = 0
    or position('provider_message_id like ''email:%''' in definition) = 0
    or position('private.agent_task_enqueue(''sales_executive'', ''sales.reply''' in definition) = 0 then
    raise exception 'The sales hand-off must check the Sales Executive, keep billing out, bind contacts from signed email only and enqueue only its own task' using errcode = '55000';
  end if;

  if not exists (select 1 from private.agent_autonomy_steps where category = 'sales_answers' and requires_feature = feature
      and changes = '[{"agent": "sales_executive", "config_key": "auto_approve_kinds", "values": ["communication.answer"]}]'::jsonb) then
    raise exception 'The "Sales answers" step must exist and hand over answers alone' using errcode = '55000';
  end if;

  if not (contract -> 'features' @> to_jsonb(array[feature])) then
    contract := jsonb_set(contract, '{features}', (contract -> 'features') || to_jsonb(array[feature]));
  end if;
  execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L',
    'select ' || quote_literal(contract::text) || '::jsonb');
end $$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon, authenticated;
