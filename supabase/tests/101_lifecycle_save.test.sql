begin;
select plan(6);

select is((select kind from private.hub_settings where key = 'growth.save_emails'), 'flag', 'The win-back and cancellation switch exists');
select ok(position('''cancel_save''' in pg_get_constraintdef((select oid from pg_constraint where conrelid = 'private.agent_actions'::regclass and conname = 'agent_actions_email_send_check'))) > 0
  and position('''trial_ended''' in pg_get_constraintdef((select oid from pg_constraint where conrelid = 'private.agent_actions'::regclass and conname = 'agent_actions_email_send_check'))) > 0,
  'A customer email may be a cancellation or a win-back email');
select ok(position('cancel_save' in pg_get_constraintdef((select oid from pg_constraint where conrelid = 'private.agent_lifecycle_emails'::regclass and conname = 'agent_lifecycle_emails_template_check'))) > 0
  and position('trial_ended' in pg_get_constraintdef((select oid from pg_constraint where conrelid = 'private.agent_lifecycle_emails'::regclass and conname = 'agent_lifecycle_emails_period_key_check'))) > 0,
  'The send ledger records both');
select ok(position('interval ''14 days''' in pg_get_functiondef('private.agent_lifecycle_json(integer,text,text,integer)'::regprocedure)) > 0
  and position('''paused''' in pg_get_functiondef('private.agent_lifecycle_json(integer,text,text,integer)'::regprocedure)) > 0,
  'The facts include plans being cancelled and trials that ended in the last 14 days');
select ok(not exists (select 1 from unnest(array['anon', 'authenticated', 'service_role', 'hub_app_server']) r
                      where has_function_privilege(r, 'private.agent_lifecycle_json(integer,text,text,integer)', 'execute')),
  'The facts helper stays internal to its operation');
select ok(hub.get_backend_contract() -> 'features' ? 'platform.agents.lifecycle-save.v1', 'The cancellation and win-back emails are declared');

select * from finish();
rollback;
