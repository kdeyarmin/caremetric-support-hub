begin;
select plan(8);

-- The owner's switch exists and starts off.
select is((select kind from private.hub_settings where key = 'agents.strategist'), 'flag', 'The strategist is a switch');
select is((select value from private.hub_settings where key = 'agents.strategist'), null, 'The strategist starts off');

-- The notes and the funnel helper are closed; only the server reads the funnel and saves and reads a note.
select ok((select relrowsecurity from pg_class where oid = 'private.agent_strategy_notes'::regclass)
  and not has_table_privilege('hub_app_server', 'private.agent_strategy_notes', 'select')
  and not has_table_privilege('authenticated', 'private.agent_strategy_notes', 'select')
  and not has_function_privilege('hub_app_server', 'private.growth_strategy_facts_json(timestamptz,timestamptz)', 'execute'), 'Nobody reads the notes or the funnel helper directly');
select ok(has_function_privilege('hub_app_server', 'private.growth_strategy_facts(timestamptz,timestamptz)', 'execute')
  and has_function_privilege('hub_app_server', 'private.agent_strategy_save(date,jsonb)', 'execute')
  and has_function_privilege('hub_app_server', 'private.agent_strategy_note(date)', 'execute')
  and not has_function_privilege('authenticated', 'private.growth_strategy_facts(timestamptz,timestamptz)', 'execute')
  and not has_function_privilege('service_role', 'private.agent_strategy_save(date,jsonb)', 'execute'), 'Only the server reads the funnel and the notes');
select throws_ok($$ select private.growth_strategy_facts(now() - interval '7 days', now()) $$, '42501', null, 'Outside the server role nothing is read');

-- A note is for a week, from its Monday, and names a known constraint with a figure to watch (none for "none").
select throws_ok($$ insert into private.agent_strategy_notes (week, constraint_key, headline, why, move, watch, chosen_by, prompt_version)
  values ('2026-11-10', 'reach', 'h', 'w', 'm', 'strongNoContact', 'rules', 'strategist.1') $$, '23514', null, 'A note starts on a Monday');

-- The Chief of Staff names the constraint before the scorecard, and the feature is declared.
select ok((select at_local from private.agent_schedules where agent_key = 'chief_of_staff' and task_kind = 'strategy.weekly')
  < (select at_local from private.agent_schedules where agent_key = 'chief_of_staff' and task_kind = 'scorecard.weekly'), 'The strategist runs before the scorecard');
select ok(hub.get_backend_contract() -> 'features' ? 'platform.agents.strategist.v1', 'The strategist feature is declared');

select * from finish();
rollback;
