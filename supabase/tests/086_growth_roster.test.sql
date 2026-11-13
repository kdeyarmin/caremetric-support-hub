begin;
select plan(12);

-- The roster settings exist, off and empty until the owner saves them.
select is((select kind from private.hub_settings where key = 'growth.roster'), 'flag', 'Finding prospects from the roster is a switch');
select is((select kind from private.hub_settings where key = 'growth.roster_states'), 'list', 'The roster''s states are a list');
select is((select kind from private.hub_settings where key = 'growth.roster_daily_resolutions'), 'number', 'The daily look-ups are a number');
select is((select value from private.hub_settings where key = 'growth.roster'), null::jsonb, 'The roster starts off');

-- The tables are closed to every role; only the Hub server runs the roster's functions.
select ok((select relrowsecurity from pg_class where oid = 'private.growth_roster_targets'::regclass), 'Roster targets have row level security');
select ok(not has_table_privilege('hub_app_server', 'private.growth_roster_targets', 'select'), 'The server reads targets only through functions');
select ok(not has_table_privilege('authenticated', 'private.growth_roster_sync', 'select'), 'Signed-in users cannot read the roster read state');
select ok(has_function_privilege('hub_app_server', 'private.growth_roster_next(integer,integer)', 'execute')
  and not has_function_privilege('authenticated', 'private.growth_roster_next(integer,integer)', 'execute'), 'Only the server hands out agencies to look up');
select ok(not has_function_privilege('hub_app_server', 'private.growth_roster_evidence(text)', 'execute'), 'Nobody writes roster evidence directly');
select ok(position('hub.authorize_app_admin()' in pg_get_functiondef('hub.growth_roster(integer)'::regprocedure)) > 0, 'The roster read is the owner''s');

-- The Marketing Manager reads the roster every half hour, and the feature is declared.
select is((select every_seconds from private.agent_schedules where agent_key = 'marketing_manager' and task_kind = 'growth.roster'), 1800, 'The roster runs every half hour');
select ok(hub.get_backend_contract() -> 'features' ? 'platform.agents.growth-roster.v1', 'The roster feature is declared');

select * from finish();
rollback;
