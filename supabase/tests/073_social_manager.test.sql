begin;
select plan(12);

select ok(hub.get_backend_contract() -> 'features' @> '["platform.agents.social.v1"]'::jsonb, 'The Social Media Manager is declared in release metadata');

select is((select jsonb_build_array(display_name, status, autonomy, model_tier, daily_budget_cents, config -> 'auto_approve_kinds') from private.agents where key = 'social_manager'),
  '["Social Media Manager", "paused", "propose", "draft", 400, []]'::jsonb, 'The Social Media Manager starts paused, in Propose, trusted with nothing');

select is((select array_agg(task_kind order by task_kind) from private.agent_schedules where agent_key = 'social_manager' and not requires_session),
  array['social.ads', 'social.inbox', 'social.plan', 'social.report'], 'Its inbox, plan, ad review and report are scheduled');

select is((select jsonb_object_agg(category, jsonb_build_array(status, changes -> 0 -> 'values')) from private.agent_autonomy_steps where category in ('social_posts', 'social_replies', 'ad_tuning')),
  '{"ad_tuning": ["off", ["social.ad_pause", "social.ad_create"]], "social_posts": ["off", ["social.post"]], "social_replies": ["off", ["social.reply", "social.moderate"]]}'::jsonb,
  'Three hand-overs ship, all off, and none hands over a budget change');

select ok((select p.prosecdef and coalesce(p.proconfig @> array['search_path=""'], false) from pg_proc p where p.oid = 'private.social_open_targets()'::regprocedure),
  'The open-target read is a security definer with a pinned empty search path');
select ok(has_function_privilege('hub_app_server', 'private.social_open_targets()', 'execute')
  and not has_function_privilege('anon', 'private.social_open_targets()', 'execute') and not has_function_privilege('authenticated', 'private.social_open_targets()', 'execute')
  and not has_function_privilege('service_role', 'private.social_open_targets()', 'execute'), 'Only the Hub server reads it');
select throws_ok($$select private.social_open_targets()$$, '42501', null, 'Any other session is refused');
select ok((select p.prosecdef and coalesce(p.proconfig @> array['search_path=""'], false) from pg_proc p where p.oid = 'private.social_schedule(uuid,integer)'::regprocedure)
  and has_function_privilege('hub_app_server', 'private.social_schedule(uuid,integer)', 'execute')
  and not has_function_privilege('authenticated', 'private.social_schedule(uuid,integer)', 'execute') and not has_function_privilege('service_role', 'private.social_schedule(uuid,integer)', 'execute'),
  'Holding a post until its time slot is a Hub-server-only security definer');
select throws_ok($$select private.social_schedule(gen_random_uuid(), null)$$, '42501', null, 'Any other session is refused a hold');

-- Shape: a social action belongs to the Social Media Manager and names its target; a budget change is never automatic.
insert into private.agent_tasks (id, agent_key, kind, request_key, status) values
  ('0073aaaa-0000-4000-8000-000000000001', 'social_manager', 'social.ads', 'pgtap-073-ads', 'queued'),
  ('0073aaaa-0000-4000-8000-000000000002', 'chief_of_staff', 'brief.daily', 'pgtap-073-brief', 'queued');
select lives_ok($$insert into private.agent_actions (task_id, agent_key, kind, target_kind, target_id, preview, input, status)
  values ('0073aaaa-0000-4000-8000-000000000001', 'social_manager', 'social.ad_budget', 'social_adset', '120200000000001', 'Raise the budget', '{}', 'proposed')$$,
  'A proposed budget change is recorded');
select throws_ok($$insert into private.agent_actions (task_id, agent_key, kind, target_kind, target_id, preview, input, status)
  values ('0073aaaa-0000-4000-8000-000000000001', 'social_manager', 'social.ad_budget', 'social_adset', '120200000000002', 'Raise the budget', '{}', 'auto_approved')$$,
  '23514', null, 'An automatically approved budget change is refused');
select throws_ok($$insert into private.agent_actions (task_id, agent_key, kind, target_kind, target_id, preview, input, status)
  values ('0073aaaa-0000-4000-8000-000000000002', 'chief_of_staff', 'social.post', 'social_post', 'post-1', 'A post', '{}', 'proposed')$$,
  '23514', null, 'Another agent cannot propose a social action');

select * from finish();
rollback;
