begin;
select plan(9);

-- The daily number is a setting, empty until the owner saves one (the server then uses 40).
select is((select kind from private.hub_settings where key = 'growth.roster_match_daily'), 'number', 'The web prospects matched a day are a number');
select is((select value from private.hub_settings where key = 'growth.roster_match_daily'), null::jsonb, 'The daily number starts unset');

-- The table is closed to every role; only the Hub server hands out and records matches.
select ok((select relrowsecurity from pg_class where oid = 'private.growth_roster_matches'::regclass), 'Matches have row level security');
select ok(not has_table_privilege('hub_app_server', 'private.growth_roster_matches', 'select')
  and not has_table_privilege('authenticated', 'private.growth_roster_matches', 'select'), 'Nobody reads the match table directly');
select ok(has_function_privilege('hub_app_server', 'private.growth_roster_match_next(integer,integer)', 'execute')
  and not has_function_privilege('authenticated', 'private.growth_roster_match_next(integer,integer)', 'execute')
  and not has_function_privilege('service_role', 'private.growth_roster_match_next(integer,integer)', 'execute'), 'Only the server hands out prospects to match');
select ok(has_function_privilege('hub_app_server', 'private.growth_roster_match_record(uuid,jsonb)', 'execute')
  and not has_function_privilege('anon', 'private.growth_roster_match_record(uuid,jsonb)', 'execute'), 'Only the server records a match');
select throws_ok($$ select private.growth_roster_match_next(5, 40) $$, '42501', null, 'Outside the server role nothing is handed out');

-- The Marketing Manager matches every hour, and the feature is declared.
select is((select every_seconds from private.agent_schedules where agent_key = 'marketing_manager' and task_kind = 'growth.match'), 3600, 'Matching runs every hour');
select ok(hub.get_backend_contract() -> 'features' ? 'platform.agents.growth-roster-match.v1', 'The match feature is declared');

select * from finish();
rollback;
