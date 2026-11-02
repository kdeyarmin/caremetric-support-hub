begin;
select plan(5);

select is((select array[status, autonomy, model_tier] from private.agents where key = 'seo_analyst'),
  array['paused', 'observe', 'fast'], 'The SEO Analyst is seeded paused and observe-only');
select is((select daily_budget_cents from private.agents where key = 'seo_analyst'), 50, 'The SEO Analyst has a small daily budget');
select is((select array[cadence, at_local::text, timezone] from private.agent_schedules where agent_key = 'seo_analyst' and task_kind = 'seo.weekly'),
  array['daily', '06:30:00', 'America/New_York'], 'The weekly check is scheduled for every morning at 06:30 Eastern, and the server does its work on Mondays');
select ok(not (select requires_session from private.agent_schedules where agent_key = 'seo_analyst' and task_kind = 'seo.weekly'),
  'The weekly check reads only public pages, so it never waits for the owner''s session');
select ok(hub.get_backend_contract() -> 'features' @> '["platform.agents.seo.v1"]'::jsonb, 'The SEO Analyst is declared in release metadata');

select * from finish();
rollback;
