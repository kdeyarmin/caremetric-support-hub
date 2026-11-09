-- Additive deployment gate for the Creative Director. Declaring the feature changes no behavior by itself (the agent is seeded paused,
-- its two autonomy steps start off, and the Hub registers its work only when HUB_CREATIVE_ENABLED is also true): it states that the five
-- tables are closed to every role; that the agent and its four schedules exist; that its three action kinds and its target are checked
-- kinds owned by the Creative Director alone, and an asset with a compliance warning can never be automatically approved; that a decision
-- on a proposed asset updates it (the trigger); that every server operation is a security definer with a pinned empty search path,
-- executable by the Hub server alone; that every owner operation authorizes the owner's session itself; that the helpers are executable
-- by no role; and that the two autonomy steps exist and hand over nothing with a warning. Every test fails closed.
do $$
declare
  contract jsonb := hub.get_backend_contract();
  feature constant text := 'platform.agents.creative.v1';
  kinds_def text;
  check_def text;
  signature text;
  server_ops constant text[] := array[
    'private.creative_plan_inputs(integer)', 'private.creative_brief_create(jsonb)', 'private.creative_brief_context(uuid)',
    'private.creative_brief_finish(uuid,text,jsonb)', 'private.creative_drafts_save(uuid,uuid,jsonb)', 'private.creative_render_claim(integer,integer,text[])',
    'private.creative_render_jobs(integer)', 'private.creative_render_job(uuid,jsonb)', 'private.creative_render_finish(uuid,text,bytea,text,jsonb,jsonb)',
    'private.creative_ready(integer,text[])', 'private.creative_asset_proposed(uuid,uuid)', 'private.creative_brand_file(uuid)', 'private.creative_handoff(uuid,integer)',
    'private.creative_retire(uuid,integer)', 'private.creative_approved(text,text,integer)', 'private.creative_mark_live(uuid,text)', 'private.creative_public_file(text)',
    'private.creative_live_assets(text[])', 'private.creative_performance_save(jsonb)', 'private.creative_learnings_save(jsonb)',
    'private.creative_leads(timestamp with time zone,timestamp with time zone)', 'private.creative_open_targets()', 'private.creative_brief_facts()'];
  owner_reads constant text[] := array['hub.get_creative_studio(jsonb)', 'hub.get_creative_file(uuid)'];
  owner_changes constant text[] := array['hub.set_brand_kit(text,jsonb,integer)', 'hub.add_brand_file(text,text,text,bytea,text,boolean)',
    'hub.remove_brand_file(uuid)', 'hub.create_creative_brief(jsonb,uuid)'];
  helpers constant text[] := array['private.creative_today_start()', 'private.creative_token()', 'private.creative_brand_kit_json(private.brand_kits)',
    'private.creative_asset_json(private.creative_assets)', 'private.creative_brief_json(private.creative_briefs)', 'private.creative_landing(text,text,uuid,uuid)',
    'private.creative_action_decided()'];
  definer constant text := 'select p.prosecdef and coalesce(p.proconfig @> array[''search_path=""''], false) from pg_proc p where p.oid = $1::regprocedure';
  pinned boolean;
  role_name text;
  table_name text;
begin
  if (contract @> '{"api_version":4,"features":["platform.agents.v1","platform.agents.hardening.v1","platform.agents.autonomy.v1","platform.agents.social.v1","platform.agents.marketing.v1","support.leads.v1"]}'::jsonb) is not true then
    raise exception 'Apply the AI team control plane, its hardening, autonomy steps, the Social Media Manager, the marketing switches and the lead desk first' using errcode = '55000';
  end if;

  foreach table_name in array array['private.brand_kits', 'private.creative_briefs', 'private.creative_assets', 'private.creative_files', 'private.creative_learnings'] loop
    if to_regclass(table_name) is null or not (select relrowsecurity from pg_class where oid = to_regclass(table_name))
      or exists (select 1 from pg_policies where schemaname || '.' || tablename = table_name) then
      raise exception 'Creative tables must exist with row level security and no policy' using errcode = '55000';
    end if;
    foreach role_name in array array['anon', 'authenticated', 'service_role', 'hub_app_server'] loop
      if has_table_privilege(role_name, table_name, 'select') or has_table_privilege(role_name, table_name, 'insert')
        or has_table_privilege(role_name, table_name, 'update') or has_table_privilege(role_name, table_name, 'delete') then
        raise exception 'Creative tables must be closed to every role' using errcode = '55000';
      end if;
    end loop;
  end loop;

  if not exists (select 1 from private.agents where key = 'creative_director') then
    raise exception 'The Creative Director must be seeded' using errcode = '55000';
  end if;
  if (select count(*) from private.agent_schedules where agent_key = 'creative_director' and not requires_session
      and task_kind in ('creative.plan', 'creative.render', 'creative.refresh', 'creative.report')) <> 4 then
    raise exception 'The Creative Director''s four schedules must exist' using errcode = '55000';
  end if;

  kinds_def := coalesce((select pg_get_constraintdef(oid) from pg_constraint where conrelid = 'private.agent_actions'::regclass and conname = 'agent_actions_kind_check'), '');
  if position('''creative.asset''' in kinds_def) = 0 or position('''creative.asset_review''' in kinds_def) = 0 or position('''creative.retire''' in kinds_def) = 0
    or position('''creative_asset''' in coalesce((select pg_get_constraintdef(oid) from pg_constraint where conrelid = 'private.agent_actions'::regclass and conname = 'agent_actions_target_kind_check'), '')) = 0 then
    raise exception 'The creative action kinds and target must be checked kinds' using errcode = '55000';
  end if;
  check_def := coalesce((select pg_get_constraintdef(oid) from pg_constraint where conrelid = 'private.agent_actions'::regclass and conname = 'agent_actions_creative_check' and convalidated), '');
  if position('creative_director' in check_def) = 0 or position('creative.asset_review' in check_def) = 0 or position('auto_approved' in check_def) = 0 then
    raise exception 'Creative actions must belong to the Creative Director and an asset with a warning must never be automatic' using errcode = '55000';
  end if;
  if not exists (select 1 from pg_trigger where tgrelid = 'private.agent_actions'::regclass and tgname = 'agent_actions_creative_decided' and tgenabled <> 'D') then
    raise exception 'A decision on a proposed asset must update it' using errcode = '55000';
  end if;

  foreach signature in array server_ops loop
    execute definer into pinned using signature;
    if to_regprocedure(signature) is null or not coalesce(pinned, false)
      or has_function_privilege('anon', signature, 'EXECUTE') or has_function_privilege('authenticated', signature, 'EXECUTE')
      or has_function_privilege('service_role', signature, 'EXECUTE') or not has_function_privilege('hub_app_server', signature, 'EXECUTE')
      or position('private.require_hub_app_server()' in pg_get_functiondef(to_regprocedure(signature))) = 0 then
      raise exception 'Every creative server operation must be a security definer executable by the Hub server only (%)', signature using errcode = '55000';
    end if;
  end loop;
  foreach signature in array owner_reads || owner_changes loop
    execute definer into pinned using signature;
    if to_regprocedure(signature) is null or not coalesce(pinned, false)
      or has_function_privilege('anon', signature, 'EXECUTE') or has_function_privilege('service_role', signature, 'EXECUTE')
      or not has_function_privilege('authenticated', signature, 'EXECUTE')
      or position(case when signature = any(owner_reads) then 'hub.authorize_app_admin()' else 'hub.authorize_app_command()' end
        in pg_get_functiondef(to_regprocedure(signature))) = 0 then
      raise exception 'Every creative owner operation must authorize the owner''s session itself (%)', signature using errcode = '55000';
    end if;
  end loop;
  foreach signature in array helpers loop
    if to_regprocedure(signature) is null or has_function_privilege('anon', signature, 'EXECUTE') or has_function_privilege('authenticated', signature, 'EXECUTE')
      or has_function_privilege('service_role', signature, 'EXECUTE') or has_function_privilege('hub_app_server', signature, 'EXECUTE') then
      raise exception 'Creative helpers must be executable by no role (%)', signature using errcode = '55000';
    end if;
  end loop;

  if (select count(*) from private.agent_autonomy_steps where category in ('creative_assets', 'creative_retire') and requires_feature = feature) <> 2
    or exists (select 1 from private.agent_autonomy_steps where changes::text like '%creative.asset_review%') then
    raise exception 'The two creative autonomy steps must exist, and none may hand over an asset with a warning' using errcode = '55000';
  end if;

  if not (contract -> 'features' @> to_jsonb(array[feature])) then
    contract := jsonb_set(contract, '{features}', (contract -> 'features') || to_jsonb(array[feature]));
  end if;
  execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L',
    'select ' || quote_literal(contract::text) || '::jsonb');
end $$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon, authenticated;
