begin;
select plan(15);

-- Answer people, and tell the owner the truth (20261117240000_support_truth.sql, team review 2026-11-17, stage 5).
select ok(hub.get_backend_contract() -> 'features' ? 'platform.agents.support-truth.v1', 'Stage 5 is declared');
select ok(exists (select 1 from private.hub_settings where key = 'agents.auto_acknowledge' and kind = 'flag' and value is null),
  'The acknowledgment switch has a row, off until the owner turns it on');
select ok(has_function_privilege('hub_app_server', 'private.agent_acknowledge_begin(uuid,integer,text[])', 'execute')
  and not has_function_privilege('authenticated', 'private.agent_acknowledge_begin(uuid,integer,text[])', 'execute')
  and not has_function_privilege('service_role', 'private.agent_acknowledge_begin(uuid,integer,text[])', 'execute'),
  'Only the server records an acknowledgment');
select ok(not has_function_privilege('hub_app_server', 'private.agent_growth_acknowledgment(uuid)', 'execute'),
  'The acknowledgment test is internal to its operations');

-- The acknowledgment kind admits the standard text, exactly.
create temporary table ack_input (input jsonb) on commit drop;
insert into ack_input values (jsonb_build_object('communicationId', '11111111-1111-4111-8111-111111111117', 'reference', 117, 'channel', 'email',
  'route', 'email', 'basedOnMessageId', '22222222-2222-4222-8222-222222222217', 'template', 'standard', 'classification', '{"category": "general", "phi": false}'::jsonb,
  'body', E'Hello,\n\nThank you for contacting CareMetric Support. We have your message and a member of our team will review it and reply here.'));
select lives_ok($$ insert into private.agent_actions (agent_key, kind, target_kind, target_id, preview, input, status)
  select 'support_concierge', 'communication.acknowledge', 'communication', 'CM-117', 'Hello', input, 'proposed' from ack_input $$,
  'The standard acknowledgment is an acknowledgment');
select throws_ok($$ insert into private.agent_actions (agent_key, kind, target_kind, target_id, preview, input, status)
  select 'support_concierge', 'communication.acknowledge', 'communication', 'CM-117', 'Hello', jsonb_set(input, '{body}', '"Hello, we will call you tomorrow."'), 'proposed' from ack_input $$,
  '23514', null, 'Any other words are refused');
select throws_ok($$ insert into private.agent_actions (agent_key, kind, target_kind, target_id, preview, input, status)
  select 'support_concierge', 'communication.acknowledge', 'communication', 'CM-117', 'Hello', jsonb_set(input, '{route}', '"sms"'), 'proposed' from ack_input $$,
  '23514', null, 'So is a text');
select ok((select changes::text like '%communication.acknowledge%' from private.agent_autonomy_steps where category = 'support_answers'),
  'The support answers step hands the acknowledgment over with the answers');

-- An acknowledgment is not an answer: a lead whose conversation has only the acknowledgment still waits for its first reply.
insert into private.communications (id, channel, source_system, source_key, subject, contact_email)
values ('33333333-3333-4333-8333-333333333317', 'email', 'hub.email', 'truth-lead', 'A question', 'pat@agency.example');
insert into private.communication_messages (communication_id, direction, body, delivery, created_at)
values ('33333333-3333-4333-8333-333333333317', 'inbound', 'Do you cover Erie County?', 'received', now() - interval '2 hours');
insert into private.agent_actions (agent_key, kind, target_kind, target_id, preview, input, status, request_key)
select 'support_concierge', 'communication.reply', 'communication', 'CM-118', 'Hello', jsonb_set(input, '{reference}', '118'), 'executed', '44444444-4444-4444-8444-444444444417'
  from ack_input;
insert into private.communication_messages (communication_id, direction, body, delivery, delivery_channel, request_key, created_at)
values ('33333333-3333-4333-8333-333333333317', 'outbound', 'Hello, thank you.', 'sent', 'email', '44444444-4444-4444-8444-444444444417', now() - interval '1 hour');
insert into private.leads (kind, source, external_id, communication_id, status, test, occurred_at, received_at, contact_email)
values ('contact', 'intel', 'truth-117', '33333333-3333-4333-8333-333333333317', 'new', false, now() - interval '2 hours', now() - interval '2 hours', 'pat@agency.example');
select is((select count(*)::integer from private.agent_growth_waiting() where reference = (select reference from private.communications where id = '33333333-3333-4333-8333-333333333317')), 1,
  'A lead answered only by the acknowledgment still waits for its first reply');
insert into private.communication_messages (communication_id, direction, body, delivery, delivery_channel, created_at)
values ('33333333-3333-4333-8333-333333333317', 'outbound', 'Yes, Intel covers every county in Pennsylvania.', 'sent', 'email', now() - interval '30 minutes');
select is((select count(*)::integer from private.agent_growth_waiting() where reference = (select reference from private.communications where id = '33333333-3333-4333-8333-333333333317')), 0,
  'A real answer ends the wait');

-- The Concierge's snapshot says whether the sender's account is trialing, as flags only.
select ok(position('''account''' in pg_get_functiondef('private.agent_communication_snapshot(uuid,uuid,integer,integer)'::regprocedure)) > 0,
  'The Concierge''s snapshot carries the account''s flags');

-- The watchdog, scorecard and strategist facts.
create or replace function private.require_hub_app_server() returns void language plpgsql stable set search_path = '' as $$ begin return; end; $$;
select ok((private.agent_watchdog_facts() -> 'agents' -> 0) ?& array['lastTaskAt', 'shortestSeconds', 'tasks14d', 'worked14d', 'skipped14d'],
  'The watchdog reads when each agent last finished a task, its cadence and its last 14 days');
select ok(private.agent_scorecard_facts_json(now() - interval '7 days', now()) ? 'marketingSpendCents', 'The scorecard counts the Marketing Manager''s spend apart');
select ok((private.growth_strategy_facts_json(now() - interval '7 days', now()) -> 'conversion') ?& array['noCard', 'trialsLost'],
  'The strategist counts sign-ups with no card and trials lost unpaid');
select lives_ok($$ insert into private.agent_strategy_notes (week, constraint_key, headline, why, move, watch, chosen_by, prompt_version)
  values ('2026-11-09', 'paying', 'One trial ended with nothing paid.', 'It ended.', 'Turn on the ended-trial check-in.', 'paid', 'rules', 'strategist.3') $$,
  'The strategist''s notes accept trials ending unpaid');

select * from finish();
rollback;
