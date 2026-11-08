-- Additive deployment gate for the Social Media Manager. Declaring the feature changes no behavior by itself (the agent is seeded
-- paused and its three autonomy steps start off, and nothing reaches Meta until the owner configures a token): it states that the
-- agent and its four schedules exist; that its six action kinds and four targets are checked kinds, owned by the Social Media Manager
-- alone, and that a budget change can never be automatically approved; that the read of open targets and the post schedule hold are
-- security definers with a pinned empty search path executable by the Hub server alone; and that the three autonomy steps exist and hand over no budget change.
-- Every test fails closed.
do $$
declare
  contract jsonb := hub.get_backend_contract();
  feature constant text := 'platform.agents.social.v1';
  signature constant text := 'private.social_open_targets()';
  kinds_def text;
  check_def text;
begin
  if (contract @> '{"api_version":4,"features":["platform.agents.v1","platform.agents.hardening.v1","platform.agents.autonomy.v1","platform.agents.customer-growth.v1"]}'::jsonb) is not true then
    raise exception 'Apply the AI team control plane, its hardening, autonomy steps and customer growth first' using errcode = '55000';
  end if;

  if not exists (select 1 from private.agents where key = 'social_manager') then
    raise exception 'The Social Media Manager must be seeded' using errcode = '55000';
  end if;
  if (select count(*) from private.agent_schedules where agent_key = 'social_manager' and not requires_session
      and task_kind in ('social.inbox', 'social.plan', 'social.ads', 'social.report')) <> 4 then
    raise exception 'The Social Media Manager''s four schedules must exist' using errcode = '55000';
  end if;

  kinds_def := coalesce((select pg_get_constraintdef(oid) from pg_constraint where conrelid = 'private.agent_actions'::regclass and conname = 'agent_actions_kind_check'), '');
  if position('''social.post''' in kinds_def) = 0 or position('''social.reply''' in kinds_def) = 0 or position('''social.moderate''' in kinds_def) = 0
    or position('''social.ad_pause''' in kinds_def) = 0 or position('''social.ad_create''' in kinds_def) = 0 or position('''social.ad_budget''' in kinds_def) = 0
    or position('''social_adset''' in coalesce((select pg_get_constraintdef(oid) from pg_constraint where conrelid = 'private.agent_actions'::regclass and conname = 'agent_actions_target_kind_check'), '')) = 0 then
    raise exception 'The social action kinds and targets must be checked kinds' using errcode = '55000';
  end if;
  check_def := coalesce((select pg_get_constraintdef(oid) from pg_constraint where conrelid = 'private.agent_actions'::regclass and conname = 'agent_actions_social_check' and convalidated), '');
  if position('social_manager' in check_def) = 0 or position('social.ad_budget' in check_def) = 0 or position('auto_approved' in check_def) = 0 then
    raise exception 'Social actions must belong to the Social Media Manager and a budget change must never be automatic' using errcode = '55000';
  end if;

  if to_regprocedure('private.social_schedule(uuid,integer)') is null
    or not coalesce((select p.prosecdef and coalesce(p.proconfig @> array['search_path=""'], false) from pg_proc p where p.oid = 'private.social_schedule(uuid,integer)'::regprocedure), false)
    or has_function_privilege('anon', 'private.social_schedule(uuid,integer)', 'EXECUTE') or has_function_privilege('authenticated', 'private.social_schedule(uuid,integer)', 'EXECUTE')
    or has_function_privilege('service_role', 'private.social_schedule(uuid,integer)', 'EXECUTE')
    or not has_function_privilege('hub_app_server', 'private.social_schedule(uuid,integer)', 'EXECUTE')
    or position('kind = ''social.post''' in pg_get_functiondef('private.social_schedule(uuid,integer)'::regprocedure)) = 0
    or position('private.require_hub_app_server()' in pg_get_functiondef('private.social_schedule(uuid,integer)'::regprocedure)) = 0 then
    raise exception 'Scheduling a post must be a security definer for the Hub server only, and hold posts alone' using errcode = '55000';
  end if;

  if to_regprocedure(signature) is null
    or not coalesce((select p.prosecdef and coalesce(p.proconfig @> array['search_path=""'], false) from pg_proc p where p.oid = to_regprocedure(signature)), false)
    or has_function_privilege('anon', signature, 'EXECUTE') or has_function_privilege('authenticated', signature, 'EXECUTE')
    or has_function_privilege('service_role', signature, 'EXECUTE')
    or not has_function_privilege('hub_app_server', signature, 'EXECUTE')
    or position('private.require_hub_app_server()' in pg_get_functiondef(to_regprocedure(signature))) = 0 then
    raise exception 'Reading open social targets must be a security definer executable by the Hub server only' using errcode = '55000';
  end if;

  if (select count(*) from private.agent_autonomy_steps where category in ('social_posts', 'social_replies', 'ad_tuning') and requires_feature = feature) <> 3
    or exists (select 1 from private.agent_autonomy_steps where changes::text like '%social.ad_budget%') then
    raise exception 'The three social autonomy steps must exist, and none may hand over a budget change' using errcode = '55000';
  end if;

  if not (contract -> 'features' @> to_jsonb(array[feature])) then
    contract := jsonb_set(contract, '{features}', (contract -> 'features') || to_jsonb(array[feature]));
  end if;
  execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L',
    'select ' || quote_literal(contract::text) || '::jsonb');
end $$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon, authenticated;
