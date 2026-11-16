begin;
select plan(13);

-- Both settings exist and start unset: checking is off and so is the guard until the owner saves them.
select is((select kind from private.hub_settings where key = 'growth.presend_check'), 'text', 'Checking addresses is a text choice');
select is((select kind from private.hub_settings where key = 'growth.bounce_guard_percent'), 'number', 'The bounce guard is a number');
select is(private.growth_presend_mode(), 'off', 'Checking addresses starts off');
select is((private.growth_bounce_guard() ->> 'on')::boolean, false, 'The bounce guard starts off');

-- A mailbox that does not exist has its own eligibility, and the server still writes only to permitted contacts.
select ok(position('undeliverable' in (select pg_get_constraintdef(oid) from pg_constraint
  where conrelid = 'private.growth_contacts'::regclass and conname = 'growth_contacts_eligibility_check')) > 0, 'Contacts may be undeliverable');
select ok(position('c.eligibility<>''permitted''' in pg_get_functiondef('private.growth_claim_message(uuid,uuid)'::regprocedure)) > 0,
  'The send claim writes only to permitted contacts');

-- The guard's table and helpers are closed; only the server asks and records; only a signed-in owner reads and resumes the guard.
select ok((select relrowsecurity from pg_class where oid = 'private.growth_send_guard'::regclass)
  and not has_table_privilege('hub_app_server', 'private.growth_send_guard', 'select')
  and not has_table_privilege('authenticated', 'private.growth_send_guard', 'select'), 'Nobody reads the guard table directly');
select ok(not has_function_privilege('hub_app_server', 'private.growth_bounce_guard()', 'execute')
  and not has_function_privilege('hub_app_server', 'private.growth_hold_for(uuid,text)', 'execute')
  and not has_function_privilege('authenticated', 'private.growth_presend_mode()', 'execute'), 'The guard''s helpers are closed to every role');
select ok(has_function_privilege('hub_app_server', 'private.growth_send_hold(uuid)', 'execute')
  and has_function_privilege('hub_app_server', 'private.growth_mailbox_record(uuid,text)', 'execute')
  and not has_function_privilege('authenticated', 'private.growth_mailbox_record(uuid,text)', 'execute')
  and not has_function_privilege('service_role', 'private.growth_mailbox_candidates(integer)', 'execute'), 'Only the server asks about and records addresses');
select ok(has_function_privilege('authenticated', 'hub.growth_send_guard_resume()', 'execute')
  and not has_function_privilege('anon', 'hub.growth_send_guard_resume()', 'execute')
  and not has_function_privilege('anon', 'hub.growth_send_guard()', 'execute'), 'Only a signed-in owner reads and resumes the guard');
select throws_ok($$ select private.growth_mailbox_candidates(5) $$, '42501', null, 'Outside the server role nothing is handed out');

-- The Marketing Manager checks addresses every half hour, and the feature is declared.
select is((select every_seconds from private.agent_schedules where agent_key = 'marketing_manager' and task_kind = 'growth.verify'), 1800, 'Addresses are checked every half hour');
select ok(hub.get_backend_contract() -> 'features' ? 'platform.agents.growth-address-check.v1', 'The address check feature is declared');

select * from finish();
rollback;
