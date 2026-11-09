begin;
select plan(16);

select ok(hub.get_backend_contract() -> 'features' @> '["platform.agents.creative.v1"]'::jsonb, 'The Creative Director is declared in release metadata');

select is((select jsonb_build_array(display_name, status, autonomy, model_tier, daily_budget_cents, config -> 'auto_approve_kinds') from private.agents where key = 'creative_director'),
  '["Creative Director", "paused", "propose", "quality", 300, []]'::jsonb, 'The Creative Director starts paused, in Propose, on the quality tier, trusted with nothing');

select is((select array_agg(task_kind order by task_kind) from private.agent_schedules where agent_key = 'creative_director' and not requires_session),
  array['creative.plan', 'creative.refresh', 'creative.render', 'creative.report'], 'Its plan, render, refresh and report are scheduled');

select is((select jsonb_object_agg(category, jsonb_build_array(status, changes -> 0 -> 'values')) from private.agent_autonomy_steps where category in ('creative_assets', 'creative_retire')),
  '{"creative_assets": ["off", ["creative.asset"]], "creative_retire": ["off", ["creative.retire"]]}'::jsonb,
  'Two hand-overs ship, both off, and neither hands over an asset with a warning');

select is((select count(*)::integer from private.brand_kits where brand_name = 'CareMetric' and primary_color is null and background_color is null and text_color is null
  and logo_file_id is null and heading_font is null and voice_notes = ''), 2, 'Both brand kits start blank, named CareMetric');

select ok(not has_table_privilege('hub_app_server', 'private.creative_assets', 'select') and not has_table_privilege('authenticated', 'private.creative_files', 'select')
  and not has_table_privilege('service_role', 'private.brand_kits', 'update') and not has_table_privilege('anon', 'private.creative_briefs', 'select'),
  'The creative tables are closed to every role');

select ok((select p.prosecdef and coalesce(p.proconfig @> array['search_path=""'], false) from pg_proc p where p.oid = 'private.creative_handoff(uuid,integer)'::regprocedure)
  and has_function_privilege('hub_app_server', 'private.creative_handoff(uuid,integer)', 'execute')
  and not has_function_privilege('authenticated', 'private.creative_handoff(uuid,integer)', 'execute') and not has_function_privilege('service_role', 'private.creative_handoff(uuid,integer)', 'execute'),
  'Handing an asset over is a Hub-server-only security definer');
select throws_ok($$select private.creative_open_targets()$$, '42501', null, 'Any other session is refused the server operations');
select throws_ok($$select private.creative_public_file(repeat('a', 64))$$, '42501', null, 'Any other session is refused a public file');
select ok(has_function_privilege('authenticated', 'hub.get_creative_studio(jsonb)', 'execute') and not has_function_privilege('anon', 'hub.get_creative_studio(jsonb)', 'execute'),
  'Only a signed-in session may ask for the Creative screen, which authorizes the owner itself');

-- Shape: a creative action belongs to the Creative Director, names an asset, and an asset with a warning is never automatic.
insert into private.agent_tasks (id, agent_key, kind, request_key, status) values
  ('0075aaaa-0000-4000-8000-000000000001', 'creative_director', 'creative.render', 'pgtap-075-render', 'queued'),
  ('0075aaaa-0000-4000-8000-000000000002', 'chief_of_staff', 'brief.daily', 'pgtap-075-brief', 'queued');
select lives_ok($$insert into private.agent_actions (task_id, agent_key, kind, target_kind, target_id, preview, input, status)
  values ('0075aaaa-0000-4000-8000-000000000001', 'creative_director', 'creative.asset_review', 'creative_asset', '0075bbbb-0000-4000-8000-000000000001', 'Review', '{}', 'proposed')$$,
  'A proposed asset with a warning is recorded');
select throws_ok($$insert into private.agent_actions (task_id, agent_key, kind, target_kind, target_id, preview, input, status)
  values ('0075aaaa-0000-4000-8000-000000000001', 'creative_director', 'creative.asset_review', 'creative_asset', '0075bbbb-0000-4000-8000-000000000002', 'Review', '{}', 'auto_approved')$$,
  '23514', null, 'An automatically approved asset with a warning is refused');
select lives_ok($$insert into private.agent_actions (task_id, agent_key, kind, target_kind, target_id, preview, input, status)
  values ('0075aaaa-0000-4000-8000-000000000001', 'creative_director', 'creative.asset', 'creative_asset', '0075bbbb-0000-4000-8000-000000000003', 'Pass', '{}', 'auto_approved')$$,
  'An asset that passed every check may be approved automatically once handed over');
select throws_ok($$insert into private.agent_actions (task_id, agent_key, kind, target_kind, target_id, preview, input, status)
  values ('0075aaaa-0000-4000-8000-000000000002', 'chief_of_staff', 'creative.asset', 'creative_asset', '0075bbbb-0000-4000-8000-000000000004', 'Pass', '{}', 'proposed')$$,
  '23514', null, 'Another agent cannot propose a creative action');
select throws_ok($$insert into private.agent_actions (task_id, agent_key, kind, target_kind, target_id, preview, input, status)
  values ('0075aaaa-0000-4000-8000-000000000001', 'creative_director', 'creative.retire', 'creative_asset', 'not-an-asset', 'Retire', '{}', 'proposed')$$,
  '23514', null, 'A creative action names an asset');

-- An audience is never described by a health condition.
select throws_ok($$insert into private.creative_briefs (product, goal, audience, platforms, source, request_key)
  values ('carebase', 'Drive trials', 'Patients with diabetes', array['meta'], 'owner', 'pgtap-075-brief-health')$$,
  '23514', null, 'An audience may not name a health condition');

select * from finish();
rollback;
