begin;
select plan(11);

-- State launches: the owner picks a state and the AI team builds it in Instantly (20261128100000_state_launches.sql).
select ok((hub.get_backend_contract() -> 'features') ? 'platform.agents.state-launches.v1', 'The state launches feature is declared');
select is((select count(*)::int from private.hub_settings where key in ('outreach.instantly', 'outreach.instantly_senders', 'outreach.instantly_daily_limit',
  'outreach.instantly_states', 'outreach.local_counties', 'outreach.hunter_per_launch')), 6, 'The six state launch settings exist');
select ok(not coalesce((select value = 'true'::jsonb from private.hub_settings where key = 'outreach.instantly'), false),
  'Building state launches stays off until the owner turns it on');
select ok(not has_table_privilege('hub_app_server', 'private.state_launches', 'select')
  and not has_table_privilege('hub_app_server', 'private.state_launch_targets', 'select')
  and not has_table_privilege('authenticated', 'private.state_launch_targets', 'select'), 'The launches and their facilities are closed to every role');
select ok(has_function_privilege('hub_app_server', 'private.state_launch_event(text,text,text)', 'execute')
  and not has_function_privilege('authenticated', 'private.state_launch_event(text,text,text)', 'execute')
  and not has_function_privilege('anon', 'private.state_launch_next()', 'execute'), 'Only the Hub server records what Instantly reports and claims a launch');
select throws_ok($$select private.state_launch_next()$$, '42501', null, 'A launch is claimed only on the Hub server''s connection');
select ok(not has_function_privilege('anon', 'hub.state_launch_request(text)', 'execute')
  and position('authorize_app_command' in pg_get_functiondef('hub.state_launch_approve(uuid)'::regprocedure)) > 0, 'Launching a state needs the owner');
select ok(position('owner_sequence_check_people' in pg_get_functiondef('private.state_launch_leads(uuid)'::regprocedure)) > 0,
  'Every person found is checked against the do-not-contact list before a campaign');
select ok(exists (select 1 from private.agent_schedules where agent_key = 'marketing_manager' and task_kind = 'outreach.launch'),
  'The Marketing Manager''s state launch task is scheduled');
select is((select jsonb_build_object('status', status, 'campaigns', (select count(*) from jsonb_object_keys(campaigns)), 'leads', summary -> 'leads')
  from private.state_launches where state = 'PA'), '{"status": "ready", "campaigns": 5, "leads": 576}'::jsonb,
  'Pennsylvania, built by hand, is the first launch: ready with its five campaigns');
select throws_ok($$insert into private.state_launches (state) values ('OH')$$, '23505', null,
  'One state at a time: no second launch while Pennsylvania is open');

select * from finish();
rollback;
