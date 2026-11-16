begin;
select plan(10);

-- The five settings exist; the brief and the writer's top model start off.
select is((select kind from private.hub_settings where key = 'growth.account_brief'), 'flag', 'Account briefs are a switch');
select is((select kind from private.hub_settings where key = 'growth.quality_writer'), 'flag', 'The top-model writer is a switch');
select is((select kind from private.hub_settings where key = 'growth.draft_critic'), 'flag', 'The reader''s review is a switch');
select ok((select count(*) = 2 from private.hub_settings where key in ('growth.brief_per_day', 'growth.brief_cents') and kind = 'number'), 'The daily number and ceiling are numbers');

-- Briefs and their log are closed; only the server hands out, saves and reads the writer part; only a signed-in owner reads both parts.
select ok((select relrowsecurity from pg_class where oid = 'private.growth_briefs'::regclass)
  and not has_table_privilege('hub_app_server', 'private.growth_briefs', 'select')
  and not has_table_privilege('authenticated', 'private.growth_brief_log', 'select'), 'Nobody reads briefs directly');
select ok(has_function_privilege('hub_app_server', 'private.growth_brief_next(integer)', 'execute')
  and has_function_privilege('hub_app_server', 'private.growth_brief_writer(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'private.growth_brief_save(uuid,jsonb)', 'execute'), 'Only the server hands out, saves and reads briefs');
select ok(position('research' in pg_get_functiondef('private.growth_brief_writer(uuid)'::regprocedure)) = 0, 'The writer never reads the research part');
select ok(has_function_privilege('authenticated', 'hub.growth_brief(uuid)', 'execute') and not has_function_privilege('anon', 'hub.growth_brief(uuid)', 'execute'), 'Only a signed-in owner reads a brief');

-- The Marketing Manager briefs every 20 minutes, and the feature is declared.
select is((select every_seconds from private.agent_schedules where agent_key = 'marketing_manager' and task_kind = 'growth.brief'), 1200, 'Briefs are written every 20 minutes');
select ok(hub.get_backend_contract() -> 'features' ? 'platform.agents.growth-brief.v1', 'The brief feature is declared');

select * from finish();
rollback;
