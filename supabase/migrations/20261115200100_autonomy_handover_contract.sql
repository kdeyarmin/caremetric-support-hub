-- Declares platform.agents.autonomy-handover.v1 once the four hand-over steps of 20261115200000_autonomy_handover.sql exist and every rule
-- behind them is in place. Declaring the feature changes no behavior by itself: the steps ship held, and only switching one to automatic
-- (the owner on the AI team page, or private.agent_autonomy_apply) hands its work over. It states that the steps exist with the values
-- they add; that a campaign or founder post is approved automatically only while its step is automatic (the trigger) and the other checks
-- on those kinds remain; that an automatically approved action is re-checked when carried out; that live campaigns reserve their share of
-- the owner's monthly number in a table closed to every role; that a named person's address is permitted on its own only under the
-- hand-over and never past an unsubscribe or an opt-out; that a memo is used on its own only under the hand-over, audited as the owner's
-- choice is; and that a founder post handed back to wait for its slot keeps the approval it had. Every test fails closed.
do $$
declare
  contract jsonb := hub.get_backend_contract();
  feature constant text := 'platform.agents.autonomy-handover.v1';
  signature text;
  role_name text;
  definition text;
begin
  if (contract @> '{"api_version":4,"features":["platform.agents.autonomy.v1","platform.agents.growth-autonomy.v1","platform.agents.growth-learning.v1","platform.agents.growth-people-finder.v1","platform.agents.founder-posts.v1","platform.agents.ads.v1","platform.agents.watchdog.v1"]}'::jsonb) is not true then
    raise exception 'Apply autonomy steps, growth autonomy, the learning memo, the people finder, founder posts, paid ads and the watchdog first' using errcode = '55000';
  end if;

  -- The four steps, each requiring this feature, with exactly the values they add.
  if (select count(*) from private.agent_autonomy_steps where requires_feature = feature and (category, changes) in (
      ('named_contacts', '[{"agent": "marketing_manager", "config_key": "auto_approve_kinds", "values": ["growth.named_contact"]}]'::jsonb),
      ('learning_memo', '[{"agent": "marketing_manager", "config_key": "auto_approve_kinds", "values": ["growth.learning_memo"]}]'::jsonb),
      ('ad_campaigns', '[{"agent": "social_manager", "config_key": "auto_approve_kinds", "values": ["social.campaign_create", "social.google_campaign"]}]'::jsonb),
      ('founder_posts', '[{"agent": "social_manager", "config_key": "auto_approve_kinds", "values": ["social.founder_post"]}]'::jsonb))) <> 4 then
    raise exception 'The four hand-over steps must exist with their values' using errcode = '55000';
  end if;

  -- Campaigns and founder posts: their other checks stay; an automatic approval only while the step is automatic.
  definition := coalesce((select pg_get_constraintdef(oid) from pg_constraint where conrelid = 'private.agent_actions'::regclass
    and conname = 'agent_actions_campaign_check' and convalidated), '');
  if position('social_manager' in definition) = 0 or position('social.google_campaign' in definition) = 0 or position('(meta|linkedin|google)' in definition) = 0 then
    raise exception 'A new campaign must stay the Social Media Manager''s, one per platform, product and month' using errcode = '55000';
  end if;
  definition := coalesce((select pg_get_constraintdef(oid) from pg_constraint where conrelid = 'private.agent_actions'::regclass
    and conname = 'agent_actions_founder_post_check' and convalidated), '');
  if position('social_manager' in definition) = 0 or position('founder:' in definition) = 0 then
    raise exception 'A founder post must stay the Social Media Manager''s, naming its week''s slot' using errcode = '55000';
  end if;
  if not exists (select 1 from pg_trigger t where t.tgrelid = 'private.agent_actions'::regclass and t.tgname = 'agent_actions_handover_guard'
      and t.tgenabled = 'O' and not t.tgisinternal and t.tgfoid = 'private.agent_actions_handover_guard()'::regprocedure
      and position('auto_approved' in pg_get_triggerdef(t.oid)) > 0 and position('social.founder_post' in pg_get_triggerdef(t.oid)) > 0
      and position('social.campaign_create' in pg_get_triggerdef(t.oid)) > 0 and position('social.google_campaign' in pg_get_triggerdef(t.oid)) > 0
      and position('INSERT OR UPDATE OF status' in pg_get_triggerdef(t.oid)) > 0) then
    raise exception 'A campaign or founder post must be approved automatically only while its step is automatic' using errcode = '55000';
  end if;
  definition := pg_get_functiondef('private.agent_actions_handover_guard()'::regprocedure);
  if position('agent_autonomy_steps' in definition) = 0 or position('status = ''automatic''' in definition) = 0 or position('''23514''' in definition) = 0
    or not coalesce((select p.prosecdef and coalesce(p.proconfig @> array['search_path=""'], false) from pg_proc p where p.oid = 'private.agent_actions_handover_guard()'::regprocedure), false) then
    raise exception 'The hand-over guard must read the steps with a pinned search path' using errcode = '55000';
  end if;

  -- Server operations: security definer, pinned search path, Hub server only.
  foreach signature in array array['private.agent_action_trusted(uuid,integer)', 'private.ads_launch_reserve(uuid,integer,integer,integer,integer)',
    'private.ads_launch_release(uuid,integer)', 'private.growth_person_address(uuid,text,text,text,text)', 'private.growth_learning_propose(text,text,jsonb)',
    'private.social_schedule(uuid,integer)'] loop
    if to_regprocedure(signature) is null
      or not coalesce((select p.prosecdef and coalesce(p.proconfig @> array['search_path=""'], false) from pg_proc p where p.oid = to_regprocedure(signature)), false)
      or has_function_privilege('anon', signature, 'EXECUTE') or has_function_privilege('authenticated', signature, 'EXECUTE')
      or has_function_privilege('service_role', signature, 'EXECUTE')
      or not has_function_privilege('hub_app_server', signature, 'EXECUTE')
      or position('private.require_hub_app_server()' in pg_get_functiondef(to_regprocedure(signature))) = 0 then
      raise exception 'Hand-over server operation boundary invalid: %', signature using errcode = '55000';
    end if;
  end loop;
  foreach role_name in array array['anon', 'authenticated', 'service_role', 'hub_app_server'] loop
    if has_function_privilege(role_name, 'private.agent_actions_handover_guard()', 'EXECUTE') or has_function_privilege(role_name, 'private.ads_setting_cents(text)', 'EXECUTE') then
      raise exception 'The hand-over helpers must stay internal' using errcode = '55000';
    end if;
  end loop;

  -- Carried out: an automatic approval is checked again, the step included.
  definition := pg_get_functiondef('private.agent_action_trusted(uuid,integer)'::regprocedure);
  if position('v_agent.autonomy = ''act''' in definition) = 0 or position('auto_approve_kinds' in definition) = 0 or position('agent_autonomy_steps' in definition) = 0
    or position('v_action.executions <> p_execution' in definition) = 0 then
    raise exception 'An action approved automatically must be re-checked when it is carried out' using errcode = '55000';
  end if;

  -- Live campaigns: reserved within the owner's monthly number and daily limit, in their own month, only under the hand-over.
  if not coalesce((select relrowsecurity from pg_class where oid = to_regclass('private.ads_launch_reservations')), false) then
    raise exception 'The launch reservations must exist with row level security' using errcode = '55000';
  end if;
  foreach role_name in array array['anon', 'authenticated', 'service_role', 'hub_app_server'] loop
    if has_table_privilege(role_name, 'private.ads_launch_reservations', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
      or has_any_column_privilege(role_name, 'private.ads_launch_reservations', 'SELECT,INSERT,UPDATE,REFERENCES') then
      raise exception 'The launch reservations must remain closed to every browser, service and server role' using errcode = '55000';
    end if;
  end loop;
  definition := pg_get_functiondef('private.ads_launch_reserve(uuid,integer,integer,integer,integer)'::regprocedure);
  if position('''ads.monthly_budget_cents''' in definition) = 0 or position('''social.max_daily_budget_cents''' in definition) = 0
    or position('month_over' in definition) = 0 or position('owner_approved' in definition) = 0 or position('for share' in definition) = 0
    or position('category = ''ad_campaigns'' and status = ''automatic''' in definition) = 0 or position('pg_advisory_xact_lock' in definition) = 0 then
    raise exception 'A live campaign must reserve its share of the owner''s monthly number under the hand-over' using errcode = '55000';
  end if;

  -- Named people: permitted on their own only under the hand-over, never past an unsubscribe or an opt-out.
  definition := pg_get_functiondef('private.growth_person_address(uuid,text,text,text,text)'::regprocedure);
  if position('''growth.named_contact''' in definition) = 0 or position('email_suppressions' in definition) = 0 or position('opted_out' in definition) = 0
    or position('''negative_reply'', ''not_now''' in definition) = 0 or position('''published'', ''mail_server''' in definition) = 0
    or position('growth.person_permitted' in definition) = 0 or position('''review'', now(), p_source_url, ''enriched''' in definition) = 0
    or position('if v_auto then' in definition) = 0 or position('set eligibility = ''permitted''' in definition) = 0 then
    raise exception 'A named person''s address must be permitted on its own only under the hand-over' using errcode = '55000';
  end if;

  -- The memo: used on its own only under the hand-over, audited as the owner's choice is.
  definition := pg_get_functiondef('private.growth_learning_propose(text,text,jsonb)'::regprocedure);
  if position('''growth.learning_memo''' in definition) = 0 or position('growth.memo_activated' in definition) = 0 or position('v_agent.autonomy = ''act''' in definition) = 0 then
    raise exception 'A memo must be used on its own only under the hand-over' using errcode = '55000';
  end if;

  -- A founder post handed back keeps the approval it had; it still waits for its slot.
  definition := pg_get_functiondef('private.social_schedule(uuid,integer)'::regprocedure);
  if position('kind = ''social.founder_post''' in definition) = 0 or position('case when decided_by is null then ''auto_approved'' else ''approved'' end' in definition) = 0 then
    raise exception 'A founder post handed back must keep its approval and wait for its slot' using errcode = '55000';
  end if;

  if not (contract -> 'features' @> to_jsonb(array[feature])) then
    contract := jsonb_set(contract, '{features}', (contract -> 'features') || to_jsonb(array[feature]));
  end if;
  execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L',
    'select ' || quote_literal(contract::text) || '::jsonb');
end $$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon, authenticated;
