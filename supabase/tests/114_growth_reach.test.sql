begin;
select plan(18);

-- Stage 3 of the AI workforce review of 2026-11-17 (20261117210000_growth_reach.sql).
select ok(hub.get_backend_contract() -> 'features' ? 'platform.agents.growth-reach.v1', 'The growth reach feature is declared');
select is((select count(*)::int from private.hub_settings where key in ('growth.roster_site_research', 'growth.roster_site_research_per_day',
  'growth.roster_site_research_cents', 'growth.live_evaluation') and value is null), 4, 'The four stage 3 settings start off or at their defaults');

-- Website search for roster agencies not found: 9 assertions. Seeds its own rows inside the test file's transaction, which rolls back.
-- Stub only the session-user guard (as 103 and 113 do); the rollback restores it.
select ok(has_function_privilege('hub_app_server', 'private.growth_roster_site_next(integer,integer)', 'execute')
  and has_function_privilege('hub_app_server', 'private.growth_roster_site_record(text,jsonb)', 'execute')
  and not has_function_privilege('authenticated', 'private.growth_roster_site_next(integer,integer)', 'execute')
  and not has_function_privilege('service_role', 'private.growth_roster_site_record(text,jsonb)', 'execute'),
  'Only the server hands out website searches and records what they found');
select ok(position('''suggested''' in pg_get_functiondef('hub.growth_roster(integer)'::regprocedure)) > 0
  and position('hub.authorize_app_admin()' in pg_get_functiondef('hub.growth_roster(integer)'::regprocedure)) > 0,
  'The Growth screen shows the suggested sites, and stays the owner''s read');
create or replace function private.require_hub_app_server() returns void language plpgsql stable set search_path = '' as $$ begin return; end; $$;
update private.growth_roster_sync set period = '2026Q3', states = array['PA'];
insert into private.growth_roster_targets (ccn, name, setting, city, state, period, claim, rank, status, reason) values
  ('E1S0001', 'Site Test Home Health', 'home_health', 'Erie', 'PA', '2026Q3', 'CMS record.', 90, 'unresolved', 'no_site'),
  ('E1S0002', 'Site Test Hospice', 'hospice', 'Erie', 'PA', '2026Q3', 'CMS record.', 80, 'unresolved', 'not_confirmed'),
  ('E1S0003', 'Site Test Waiting', 'home_health', 'Erie', 'PA', '2026Q3', 'CMS record.', 99, 'new', null),
  ('E1S0004', 'Site Test Retry', 'home_health', 'Erie', 'PA', '2026Q3', 'CMS record.', 98, 'unresolved', 'retry');
select is((select array_agg(x ->> 'ccn' order by x ->> 'ccn') from jsonb_array_elements(private.growth_roster_site_next(10, 50)) x where x ->> 'ccn' like 'E1S%'),
  array['E1S0001', 'E1S0002'], 'Only agencies not found for no site or an unconfirmed one are searched for, never a waiting one or a retry');
select is(jsonb_array_length(private.growth_roster_site_next(10, 50)), 0, 'An agency handed out is not handed out again within the hour');
select throws_ok($$ select private.growth_roster_site_record('E1S0002', '{"outcome":"unresolved","suggestions":["not a domain!"]}') $$, '22023',
  'Invalid suggested website', 'A suggestion must be a plain domain');
select is(private.growth_roster_site_record('E1S0002', '{"outcome":"unresolved","suggestions":["Sitetesthospice.org","sitetesthospice.org"]}') ->> 'suggested', '1',
  'A suggestion is kept once, lower-cased, and the agency is searched again only after 30 days');
select is((select status || ':' || reason || ':' || array_to_string(site_suggestions, ',') from private.growth_roster_targets where ccn = 'E1S0002'),
  'unresolved:not_confirmed:sitetesthospice.org', 'An unconfirmed suggestion changes nothing else about the agency');
select is(private.growth_roster_site_record('E1S0001', jsonb_build_object('outcome', 'graduated', 'domain', 'site-test-hh.example.org',
    'confirmation', 'phone', 'evidence', '[]'::jsonb)) ->> 'graduated', 'true', 'A confirmed site graduates the agency');
select is((select t.status || ':' || o.domain || ':' || (t.site_searched_at is not null)::text from private.growth_roster_targets t
    join private.growth_organizations o on o.id = t.organization_id where t.ccn = 'E1S0001'),
  'graduated:site-test-hh.example.org:true', 'It graduates through the roster''s own path, with the site as its organization''s domain');

-- The live writing evaluation: 7 assertions. Paste inside the stage 3 test's begin … finish(); rollback (add 7 to its plan). It stubs only the
-- session-user guard (as 103 does) after the privilege checks; the rollback restores it.
select ok(has_function_privilege('hub_app_server', 'private.growth_live_eval_state(text)', 'execute')
  and has_function_privilege('hub_app_server', 'private.growth_live_eval_record(text,text,jsonb)', 'execute')
  and has_function_privilege('hub_app_server', 'private.growth_live_evaluation_latest(timestamptz)', 'execute')
  and not has_function_privilege('authenticated', 'private.growth_live_eval_record(text,text,jsonb)', 'execute')
  and not has_function_privilege('service_role', 'private.growth_live_eval_state(text)', 'execute')
  and not has_function_privilege('anon', 'private.growth_live_evaluation_latest(timestamptz)', 'execute'),
  'Only the server reads and records the live writing evaluation');
select ok(not has_table_privilege('hub_app_server', 'private.growth_live_eval_cases', 'select')
  and not has_table_privilege('authenticated', 'private.growth_live_eval_cases', 'select'),
  'The live evaluation''s grades are closed to every role');
select ok(exists (select 1 from private.agent_schedules where agent_key = 'marketing_manager' and task_kind = 'growth.evaluate_live'
  and cadence = 'daily' and at_local = '06:50' and timezone = 'America/New_York'), 'The live evaluation is scheduled every morning at 06:50 Eastern');

create or replace function private.require_hub_app_server() returns void language plpgsql stable set search_path = '' as $$ begin return; end; $$;
select is(array[private.growth_live_eval_record('week:2026-11-16', 'web.brief.short', '{"ok": true, "wouldReply": 4}'),
  private.growth_live_eval_record('week:2026-11-16', 'web.brief.short', '{"ok": false}')], array[true, false],
  'A case is graded once for its run');
select is(private.growth_live_eval_state('week:2026-11-16') -> 'cases', '[{"key": "web.brief.short", "result": {"ok": true, "wouldReply": 4}}]'::jsonb,
  'A run reads back its own grades');
insert into private.agent_evaluations (product, version, passed, results, created_at) values
  ('caremetric-intel', 'growth.live.1', false, '{"summary": {"average": 3.1}}', now() - interval '2 days'),
  ('caremetric-intel', 'growth.1', true, '{"cases": 30}', now() - interval '1 hour'),
  ('caremetric-intel', 'growth.live.1', true, '{"summary": {"average": 3.9}}', now() - interval '1 day');
select is(private.growth_live_evaluation_latest(now() - interval '8 days') -> 'results', '{"summary": {"average": 3.9}}'::jsonb,
  'The scorecard reads the latest live evaluation, never the send gate''s growth.1');
select throws_ok($$ select private.growth_live_eval_record('week:soon', 'web.brief.short', '{}') $$, '22023', null, 'A run key that is neither a week nor a task is refused');

select * from finish();
rollback;
