begin;
select plan(9);

-- Repairs from the review of 2026-11-17's releases (20261117260000_review_repairs.sql).

-- 1. The level the audit trail gives an agent: the owner's latest choice, carried through the step changes audited since.
select ok(not has_function_privilege('hub_app_server', 'private.agent_autonomy_owner_level(text)', 'execute')
  and not has_function_privilege('authenticated', 'private.agent_autonomy_owner_level(text)', 'execute')
  and not has_function_privilege('service_role', 'private.agent_autonomy_owner_level(text)', 'execute'),
  'The owner''s recorded level is read by no role');
delete from private.audit_events where action in ('agent.autonomy', 'agent.autonomy_step');
select is(private.agent_autonomy_owner_level('account_manager'), null, 'An agent whose level the owner never chose has none on record');
insert into private.audit_events (actor_id, action, entity_type, metadata, created_at) values
  (null, 'agent.autonomy_step', 'agent', '{"category": "account_emails", "from": "supervised", "to": "automatic", "source": "schedule"}', now() - interval '10 days'),
  ('a1200000-0000-4000-8000-000000000001', 'agent.autonomy', 'agent', '{"agent": "account_manager", "from": "act", "to": "propose"}', now() - interval '5 days'),
  -- A restoration has no actor: it is not the owner's choice.
  (null, 'agent.autonomy', 'agent', '{"agent": "account_manager", "from": "propose", "to": "observe"}', now() - interval '4 days'),
  -- A step that does not name the agent changes nothing for it.
  (null, 'agent.autonomy_step', 'agent', '{"category": "articles", "from": "supervised", "to": "automatic", "source": "schedule"}', now() - interval '3 days');
select is(private.agent_autonomy_owner_level('account_manager'), 'propose',
  'Propose chosen after the step went automatic stays Propose, whatever set the agent to Act since');
insert into private.audit_events (actor_id, action, entity_type, metadata, created_at) values
  ('a1200000-0000-4000-8000-000000000001', 'agent.autonomy_step', 'agent', '{"category": "account_emails", "from": "held", "to": "automatic", "source": "owner"}', now() - interval '2 days');
select is(private.agent_autonomy_owner_level('account_manager'), 'act', 'Handing the step over again since makes Act the owner''s');
insert into private.audit_events (actor_id, action, entity_type, metadata, created_at) values
  ('a1200000-0000-4000-8000-000000000001', 'agent.autonomy', 'agent', '{"agent": "content_marketer", "from": "act", "to": "observe"}', now() - interval '6 days'),
  ('a1200000-0000-4000-8000-000000000001', 'agent.autonomy_step', 'agent', '{"category": "articles", "from": "automatic", "to": "held", "source": "owner"}', now() - interval '1 day');
select is(private.agent_autonomy_owner_level('content_marketer'), 'act',
  'A step handed over after the owner''s Observe makes it Act, and holding it later does not lower it');
insert into private.audit_events (actor_id, action, entity_type, metadata, created_at) values
  ('a1200000-0000-4000-8000-000000000001', 'agent.autonomy', 'agent', '{"agent": "content_marketer", "from": "act", "to": "observe"}', now() - interval '20 hours'),
  ('a1200000-0000-4000-8000-000000000001', 'agent.autonomy_step', 'agent', '{"category": "articles", "from": "automatic", "to": "held", "source": "owner"}', now() - interval '10 hours');
select is(private.agent_autonomy_owner_level('content_marketer'), 'propose', 'Holding a step moves an observing agent up to Propose');

-- 2. An acknowledgment is not an answer: a prospect who got only the fixed acknowledgment is not followed up as if answered.
create or replace function private.require_hub_app_server() returns void
language plpgsql stable set search_path='' as $$ begin return; end; $$;
select ok(position('private.agent_growth_acknowledgment(cm.request_key)' in pg_get_functiondef('private.growth_quiet_candidates(integer)'::regprocedure)) > 0
  and has_function_privilege('hub_app_server', 'private.growth_quiet_candidates(integer)', 'execute')
  and not has_function_privilege('authenticated', 'private.growth_quiet_candidates(integer)', 'execute'),
  'Quiet follow-ups leave the acknowledgment out, and stay the server''s');
insert into private.growth_organizations (id, name, domain) values ('a1200000-0000-4000-8000-0000000000a1', 'Acknowledged Agency', 'acknowledged-agency.example.test');
insert into private.growth_contacts (id, organization_id, email, name, source_kind, eligibility, verified_at)
  values ('a1200000-0000-4000-8000-0000000000b1', 'a1200000-0000-4000-8000-0000000000a1', 'info@acknowledged-agency.example.test', '', 'role_address', 'permitted', now());
insert into private.growth_opportunities (id, organization_id, contact_id, product, stage, owner_agent)
  values ('a1200000-0000-4000-8000-0000000000c1', 'a1200000-0000-4000-8000-0000000000a1', 'a1200000-0000-4000-8000-0000000000b1', 'caremetric-intel', 'engaged', 'marketing_manager');
insert into private.communications (id, channel, source_system, source_key, subject, contact_email, product_id)
  values ('a1200000-0000-4000-8000-0000000000d1', 'email', 'hub.email', 'test:acknowledged', 'Re: Your county', 'info@acknowledged-agency.example.test', '00000000-0000-4000-8000-000000000006');
insert into private.agent_actions (agent_key, kind, target_kind, target_id, preview, input, status, request_key)
values ('support_concierge', 'communication.reply', 'communication', 'CM-120', 'Hello', jsonb_build_object('communicationId', 'a1200000-0000-4000-8000-0000000000d1',
  'reference', 120, 'channel', 'email', 'route', 'email', 'basedOnMessageId', 'a1200000-0000-4000-8000-0000000000e1', 'template', 'standard',
  'classification', '{"category": "general", "phi": false}'::jsonb,
  'body', E'Hello,\n\nThank you for contacting CareMetric Support. We have your message and a member of our team will review it and reply here.'),
  'executed', 'a1200000-0000-4000-8000-0000000000f1');
insert into private.communication_messages (communication_id, direction, body, delivery, delivery_channel, request_key, created_at) values
  ('a1200000-0000-4000-8000-0000000000d1', 'inbound', 'How does the report work?', 'received', null, null, now() - interval '6 days'),
  ('a1200000-0000-4000-8000-0000000000d1', 'outbound', 'Hello, thank you.', 'sent', 'email', 'a1200000-0000-4000-8000-0000000000f1', now() - interval '5 days 12 hours');
insert into private.customer_activity_events (product, organization_id, event_key, kind, occurred_at, facts)
  values ('caremetric-intel', 'a1200000-0000-4000-8000-0000000000a1', 'inquiry:acknowledged-test', 'reply', now() - interval '6 days',
    jsonb_build_object('communicationId', 'a1200000-0000-4000-8000-0000000000d1'));
select ok(not exists (select 1 from jsonb_array_elements(private.growth_quiet_candidates(50)) x where x ->> 'opportunityId' = 'a1200000-0000-4000-8000-0000000000c1'),
  'Answered only by the acknowledgment: no follow-up on an answer never given');
insert into private.communication_messages (communication_id, direction, body, delivery, delivery_channel, created_at)
  values ('a1200000-0000-4000-8000-0000000000d1', 'outbound', 'Here is how it works.', 'sent', 'email', now() - interval '5 days');
select is((select x ->> 'step' from jsonb_array_elements(private.growth_quiet_candidates(50)) x where x ->> 'opportunityId' = 'a1200000-0000-4000-8000-0000000000c1'), '1',
  'A real answer five days ago, and quiet since: the first follow-up is due');

select * from finish();
rollback;
