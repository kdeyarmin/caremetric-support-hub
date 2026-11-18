begin;
select plan(8);

-- The owner's three settings exist; their defaults are the server's (the summary on, 5 PM, approval requests in the summary).
select is((select string_agg(key || ':' || kind, ',' order by key) from private.hub_settings
           where key in ('agents.daily_summary', 'agents.summary_hour', 'agents.approvals_right_away')),
          'agents.approvals_right_away:flag,agents.daily_summary:flag,agents.summary_hour:number', 'The summary''s three settings exist');

-- A message can be held for the summary, and only a held one says why.
select lives_ok($$ insert into private.owner_notifications (dedupe_key, channel, severity, subject, body, status, attention)
  values ('pgtap:summary:held', 'email', 'info', 'News', 'Body', 'held', 'update') $$, 'A held message is recorded with its attention');
select throws_ok($$ insert into private.owner_notifications (dedupe_key, channel, severity, subject, body, status)
  values ('pgtap:summary:bare', 'email', 'info', 'News', 'Body', 'held') $$, '23514', null, 'A held message must say why');
select throws_ok($$ insert into private.owner_notifications (dedupe_key, channel, severity, subject, body, status, attention)
  values ('pgtap:summary:sent', 'email', 'info', 'News', 'Body', 'sent', 'update') $$, '23514', null, 'Only a held message says why');

-- Holding and the summary's facts are the Hub server's alone.
select ok(has_function_privilege('hub_app_server', 'private.agent_notify_hold(uuid,text)', 'execute')
  and has_function_privilege('hub_app_server', 'private.agent_summary_facts(timestamptz,timestamptz)', 'execute')
  and not has_function_privilege('authenticated', 'private.agent_notify_hold(uuid,text)', 'execute')
  and not has_function_privilege('anon', 'private.agent_summary_facts(timestamptz,timestamptz)', 'execute')
  and not has_function_privilege('service_role', 'private.agent_summary_facts(timestamptz,timestamptz)', 'execute'), 'Only the server holds a message or reads the summary');
select throws_ok($$ select private.agent_summary_facts(now() - interval '1 day', now()) $$, '42501', null, 'Outside the server role nothing is read');

-- The Chief of Staff's summary is scheduled, and the feature is declared.
select ok(exists (select 1 from private.agent_schedules where agent_key = 'chief_of_staff' and task_kind = 'summary.daily' and cadence = 'daily'),
  'The end-of-day summary is scheduled');
select ok(hub.get_backend_contract() -> 'features' ? 'platform.agents.owner-summary.v1', 'The end-of-day summary feature is declared');

select * from finish();
rollback;
