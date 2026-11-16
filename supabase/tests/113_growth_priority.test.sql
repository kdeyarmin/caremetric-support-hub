begin;
select plan(28);

-- Stage 2 of the AI workforce review of 2026-11-17 (20261117190000_growth_priority.sql).
select ok(hub.get_backend_contract() -> 'features' ? 'platform.agents.growth-priority.v1', 'The growth priority feature is declared');
select ok(has_function_privilege('hub_app_server', 'private.growth_defer_action(uuid,integer,text)', 'execute')
  and has_function_privilege('hub_app_server', 'private.growth_quiet_candidates(integer)', 'execute')
  and not has_function_privilege('authenticated', 'private.growth_defer_action(uuid,integer,text)', 'execute')
  and not has_function_privilege('service_role', 'private.growth_quiet_candidates(integer)', 'execute'), 'Only the server defers an email or lists quiet prospects');
select ok(not has_function_privilege('hub_app_server', 'private.growth_priority_band(uuid)', 'execute')
  and not has_function_privilege('hub_app_server', 'private.growth_next_send_at(timestamptz)', 'execute')
  and not has_function_privilege('hub_app_server', 'private.growth_action_score(uuid)', 'execute'), 'The helpers are closed to every role');
select is((select count(*)::int from private.hub_settings where key in ('growth.send_priority', 'growth.send_from_hour', 'growth.send_until_hour',
  'growth.short_first_email', 'growth.quiet_followup', 'growth.sales_context') and value is null), 6, 'The six settings start off or empty');
select ok(position('outside_hours' in pg_get_functiondef('private.growth_claim_message(uuid,uuid)'::regprocedure)) > 0
  and position('c.eligibility = ''permitted'')' in pg_get_functiondef('private.growth_brief_next(integer)'::regprocedure)) > 0,
  'The claim holds cold email outside the send hours, and a brief needs an agency that can be emailed');

-- Send hours: none set, any time; 8 to 16 Eastern on weekdays.
select is(private.growth_next_send_at('2026-11-15 13:00-05'), '2026-11-15 13:00-05'::timestamptz, 'With no hours set an email may go at any time');
update private.hub_settings set value = '8' where key = 'growth.send_from_hour';
update private.hub_settings set value = '16' where key = 'growth.send_until_hour';
select is(private.growth_next_send_at('2026-11-16 12:00-05'), '2026-11-16 12:00-05'::timestamptz, 'Inside the hours an email goes now');
select is(private.growth_next_send_at('2026-11-15 13:00-05'), '2026-11-16 08:00-05'::timestamptz, 'On a Sunday afternoon it waits for Monday at 8');
select is(private.growth_next_send_at('2026-11-20 16:00-05'), '2026-11-23 08:00-05'::timestamptz, 'At 4 pm on a Friday it waits for Monday at 8');
update private.hub_settings set value = '17' where key = 'growth.send_from_hour';
select is(private.growth_next_send_at('2026-11-15 13:00-05'), '2026-11-15 13:00-05'::timestamptz, 'Hours that end before they start are not used');

-- Bands: a follow-up to an agency that opened its report, a first email with a brief to a confirmed named person, with a brief only, the rest.
insert into private.growth_organizations (id, name, domain) values
  ('e1120000-0000-4000-8000-0000000001a1', 'Band One', 'band-one.example.test'), ('e1120000-0000-4000-8000-0000000001a2', 'Band Two', 'band-two.example.test'),
  ('e1120000-0000-4000-8000-0000000001a3', 'Band Three', 'band-three.example.test'), ('e1120000-0000-4000-8000-0000000001a4', 'Band Four', 'band-four.example.test');
insert into private.growth_contacts (id, organization_id, email, name, source_kind, eligibility, verified_at, mailbox_result) values
  ('e1120000-0000-4000-8000-0000000001b1', 'e1120000-0000-4000-8000-0000000001a1', 'info@band-one.example.test', '', 'role_address', 'permitted', now(), null),
  ('e1120000-0000-4000-8000-0000000001b2', 'e1120000-0000-4000-8000-0000000001a2', 'jane@band-two.example.test', 'Jane Doe', 'enriched', 'permitted', now(), 'verified'),
  ('e1120000-0000-4000-8000-0000000001b3', 'e1120000-0000-4000-8000-0000000001a3', 'info@band-three.example.test', '', 'role_address', 'permitted', now(), null),
  ('e1120000-0000-4000-8000-0000000001b4', 'e1120000-0000-4000-8000-0000000001a4', 'info@band-four.example.test', '', 'role_address', 'permitted', now(), null);
insert into private.growth_opportunities (id, organization_id, contact_id, product, stage, owner_agent, memory, next_at) values
  ('e1120000-0000-4000-8000-0000000001c1', 'e1120000-0000-4000-8000-0000000001a1', 'e1120000-0000-4000-8000-0000000001b1', 'caremetric-intel', 'contacted', 'marketing_manager', '{}', now() + interval '4 days'),
  ('e1120000-0000-4000-8000-0000000001c2', 'e1120000-0000-4000-8000-0000000001a2', 'e1120000-0000-4000-8000-0000000001b2', 'caremetric-intel', 'qualified', 'marketing_manager', '{}', now()),
  ('e1120000-0000-4000-8000-0000000001c3', 'e1120000-0000-4000-8000-0000000001a3', 'e1120000-0000-4000-8000-0000000001b3', 'caremetric-intel', 'qualified', 'marketing_manager', '{}', now()),
  ('e1120000-0000-4000-8000-0000000001c4', 'e1120000-0000-4000-8000-0000000001a4', 'e1120000-0000-4000-8000-0000000001b4', 'caremetric-intel', 'qualified', 'marketing_manager', '{}', now());
insert into private.growth_briefs (opportunity_id, writer, research, model, prompt_version) values
  ('e1120000-0000-4000-8000-0000000001c2', '{}', '{}', 'test', 'brief.test'), ('e1120000-0000-4000-8000-0000000001c3', '{}', '{}', 'test', 'brief.test');
insert into private.growth_messages (opportunity_id, contact_id, purpose, subject, body, opportunity_version, contact_version, policy_version, unsubscribe_hash, status, attempted_at)
  values ('e1120000-0000-4000-8000-0000000001c1', 'e1120000-0000-4000-8000-0000000001b1', 'marketing', 'Your county', 'Body.', 1, 1, 1, repeat('e', 64), 'accepted', now() - interval '2 days');
select is(array[private.growth_priority_band('e1120000-0000-4000-8000-0000000001c1'), private.growth_priority_band('e1120000-0000-4000-8000-0000000001c2'),
  private.growth_priority_band('e1120000-0000-4000-8000-0000000001c3'), private.growth_priority_band('e1120000-0000-4000-8000-0000000001c4')], array[4, 2, 3, 4],
  'Before its report is opened a follow-up is in the last band; a brief and a confirmed named person come second, a brief third');

-- A first report open, with the switch on, brings the follow-up forward to the policy's gap (72 hours after the first email here).
update private.hub_settings set value = 'true' where key = 'growth.send_priority';
insert into private.customer_activity_events (product, organization_id, event_key, kind, occurred_at)
  values ('caremetric-intel', 'e1120000-0000-4000-8000-0000000001a1', 'report_view:9200001', 'report_viewed', now());
update private.growth_opportunities set memory = jsonb_build_object('reportViewedAt', now()::text) where id = 'e1120000-0000-4000-8000-0000000001c1';
select ok((select next_at between now() + interval '23 hours' and now() + interval '25 hours' from private.growth_opportunities where id = 'e1120000-0000-4000-8000-0000000001c1'),
  'A first report open brings the second email forward to the policy''s gap after the first');
select is(private.growth_priority_band('e1120000-0000-4000-8000-0000000001c1'), 1, 'A follow-up to an agency that opened its report comes first');

-- Stub only the session-user guard (as 099 and 103 do); the rollback restores it.
create or replace function private.require_hub_app_server() returns void
language plpgsql stable set search_path='' as $$ begin return; end; $$;
insert into private.growth_organizations(id, name, domain, discovered_at) values
  ('e1120000-0000-4000-8000-0000000007a1', 'Opened Agency', 'opened-agency.example.test', now()),
  ('e1120000-0000-4000-8000-0000000007a2', 'Unopened Agency', 'unopened-agency.example.test', now()),
  ('e1120000-0000-4000-8000-0000000007a3', 'Review Page Agency', 'review-page-agency.example.test', now());
insert into private.growth_contacts(id, organization_id, email, name, role, eligibility, verified_at, source_kind) values
  ('e1120000-0000-4000-8000-0000000007b1', 'e1120000-0000-4000-8000-0000000007a1', 'info@opened-agency.example.test', '', 'Public business address', 'permitted', now(), 'role_address'),
  ('e1120000-0000-4000-8000-0000000007b2', 'e1120000-0000-4000-8000-0000000007a2', 'info@unopened-agency.example.test', '', 'Public business address', 'permitted', now(), 'role_address'),
  ('e1120000-0000-4000-8000-0000000007b3', 'e1120000-0000-4000-8000-0000000007a3', 'info@review-page-agency.example.test', '', 'Public business address', 'permitted', now(), 'role_address');
insert into private.growth_opportunities(id, organization_id, contact_id, product, stage, owner_agent) values
  ('e1120000-0000-4000-8000-0000000007c1', 'e1120000-0000-4000-8000-0000000007a1', 'e1120000-0000-4000-8000-0000000007b1', 'caremetric-intel', 'contacted', 'marketing_manager'),
  ('e1120000-0000-4000-8000-0000000007c2', 'e1120000-0000-4000-8000-0000000007a2', 'e1120000-0000-4000-8000-0000000007b2', 'caremetric-intel', 'contacted', 'marketing_manager'),
  ('e1120000-0000-4000-8000-0000000007c3', 'e1120000-0000-4000-8000-0000000007a3', 'e1120000-0000-4000-8000-0000000007b3', 'caremetric-intel', 'contacted', 'marketing_manager');
insert into private.growth_messages(opportunity_id, contact_id, purpose, subject, body, opportunity_version, contact_version, policy_version, status,
    unsubscribe_hash, attempted_at, model_generated, variant, arms)
  values
  ('e1120000-0000-4000-8000-0000000007c1', 'e1120000-0000-4000-8000-0000000007b1', 'marketing', 'Your county', 'Your report: https://www.caremetricintel.com/report/abc.defghijklmnopqrstuvwx',
    1, 1, 1, 'accepted', repeat('a', 64), now() - interval '2 days', true, 'report', '{"length":"report","length_basis":"applied_v1","trigger":"cms_record","weakness":"too_long"}'),
  ('e1120000-0000-4000-8000-0000000007c2', 'e1120000-0000-4000-8000-0000000007b2', 'marketing', 'Your county', 'Your report: https://www.caremetricintel.com/report/xyz.defghijklmnopqrstuvwx',
    1, 1, 1, 'accepted', repeat('b', 64), now() - interval '2 days', true, 'report', '{"length":"report","length_basis":"applied_v1","trigger":"cms_record","weakness":"too_long"}'),
  ('e1120000-0000-4000-8000-0000000007c3', 'e1120000-0000-4000-8000-0000000007b3', 'marketing', 'Your county', 'A free review: https://www.caremetricintel.com/market-review',
    1, 1, 1, 'accepted', repeat('c', 64), now() - interval '2 days', true, 'control', '{"length":"control","length_basis":"applied_v1","trigger":"web","weakness":"none"}'),
  ('e1120000-0000-4000-8000-0000000007c3', 'e1120000-0000-4000-8000-0000000007b3', 'marketing', 'Your county', 'A draft nobody sent.',
    2, 1, 1, 'draft', repeat('d', 64), null, true, 'control', '{"length":"control","length_basis":"applied_v1","trigger":"web","weakness":"generic_opening"}');
-- The first agency opened its report an hour after its email; the third opened a page that is not its report (never counted: no link).
insert into private.customer_activity_events(product, organization_id, event_key, kind, occurred_at) values
  ('caremetric-intel', 'e1120000-0000-4000-8000-0000000007a1', 'report_view:9100001', 'report_viewed', now() - interval '2 days' + interval '1 hour'),
  ('caremetric-intel', 'e1120000-0000-4000-8000-0000000007a3', 'report_view:9100002', 'report_viewed', now() - interval '1 day');
select is((select (a ->> 'reported')::int from jsonb_array_elements(private.growth_learning_facts('caremetric-intel', 90) -> 'arms') a
  where a ->> 'arm' = 'length' and a ->> 'value' = 'report'), 2, 'Both report-led emails linked the agency''s own report');
select is((select (a ->> 'opened')::int from jsonb_array_elements(private.growth_learning_facts('caremetric-intel', 90) -> 'arms') a
  where a ->> 'arm' = 'length' and a ->> 'value' = 'report'), 1, 'One of them was opened after it was sent');
select is((select (a ->> 'reported')::int + (a ->> 'opened')::int from jsonb_array_elements(private.growth_learning_facts('caremetric-intel', 90) -> 'arms') a
  where a ->> 'arm' = 'length' and a ->> 'value' = 'control'), 0, 'An email without the agency''s report link counts neither, whatever the agency opened');
select is((private.growth_learning_facts('caremetric-intel', 90) ->> 'opened')::int, 1, 'The product''s opened emails are counted once');
select is(private.growth_learning_facts('caremetric-intel', 90) -> 'weaknesses', '{"too_long": 2, "generic_opening": 1}'::jsonb,
  'The reader''s weaknesses are counted over drafts too, and "none" is left out');
select is(private.growth_learning_facts('carebase', 90) -> 'weaknesses', '{}'::jsonb, 'Another product''s weaknesses are its own');

-- A prospect who replied, was answered five days ago and has not written since is a quiet prospect; a word from them since ends it.
insert into private.growth_organizations (id, name, domain) values ('e1120000-0000-4000-8000-0000000003a1', 'Quiet Agency', 'quiet-agency.example.test');
insert into private.growth_contacts (id, organization_id, email, name, source_kind, eligibility, verified_at)
  values ('e1120000-0000-4000-8000-0000000003b1', 'e1120000-0000-4000-8000-0000000003a1', 'info@quiet-agency.example.test', '', 'role_address', 'permitted', now());
insert into private.growth_opportunities (id, organization_id, contact_id, product, stage, owner_agent)
  values ('e1120000-0000-4000-8000-0000000003c1', 'e1120000-0000-4000-8000-0000000003a1', 'e1120000-0000-4000-8000-0000000003b1', 'caremetric-intel', 'engaged', 'marketing_manager');
insert into private.communications (id, channel, source_system, source_key, subject, contact_email, product_id)
  values ('e1120000-0000-4000-8000-0000000003d1', 'email', 'hub.email', 'test:quiet', 'Re: Your county', 'info@quiet-agency.example.test', '00000000-0000-4000-8000-000000000006');
insert into private.communication_messages (communication_id, direction, body, delivery, delivery_channel, created_at) values
  ('e1120000-0000-4000-8000-0000000003d1', 'inbound', 'How does the report work?', 'received', null, now() - interval '6 days'),
  ('e1120000-0000-4000-8000-0000000003d1', 'outbound', 'Here is how it works.', 'sent', 'email', now() - interval '5 days');
insert into private.customer_activity_events (product, organization_id, event_key, kind, occurred_at, facts)
  values ('caremetric-intel', 'e1120000-0000-4000-8000-0000000003a1', 'inquiry:quiet-test', 'reply', now() - interval '6 days',
    jsonb_build_object('communicationId', 'e1120000-0000-4000-8000-0000000003d1'));
select is((select x ->> 'step' from jsonb_array_elements(private.growth_quiet_candidates(50)) x where x ->> 'opportunityId' = 'e1120000-0000-4000-8000-0000000003c1'), '1',
  'Answered five days ago and quiet since: the first follow-up is due');
insert into private.communication_messages (communication_id, direction, body, delivery, created_at)
  values ('e1120000-0000-4000-8000-0000000003d1', 'inbound', 'Thanks, we will look.', 'received', now() - interval '1 day');
select ok(not exists (select 1 from jsonb_array_elements(private.growth_quiet_candidates(50)) x where x ->> 'opportunityId' = 'e1120000-0000-4000-8000-0000000003c1'),
  'A word from the prospect since our answer ends the follow-ups');

select ok(has_function_privilege('hub_app_server', 'private.sales_growth_context(uuid,uuid)', 'execute')
  and not has_function_privilege('authenticated', 'private.sales_growth_context(uuid,uuid)', 'execute')
  and not has_function_privilege('service_role', 'private.sales_growth_context(uuid,uuid)', 'execute')
  and not has_function_privilege('hub_app_server', 'private.sales_growth_context_read(uuid,uuid)', 'execute'),
  'Only the server reads a prospect''s context, and the reading itself is closed');
select ok(pg_get_functiondef('private.sales_growth_context_read(uuid,uuid)'::regprocedure) !~ '\mresearch\M',
  'The Sales Executive never reads the brief''s research part');

insert into private.growth_organizations (id, name, domain) values ('00000000-0000-4000-8000-0000000002b1', 'Context Test Home Health', 'context-test.example.org');
insert into private.growth_opportunities (id, organization_id, product, stage, memory)
  values ('00000000-0000-4000-8000-0000000002b2', '00000000-0000-4000-8000-0000000002b1', 'caremetric-intel', 'contacted', '{}'::jsonb);
insert into private.growth_contacts (id, organization_id, email, source_kind, eligibility)
  values ('00000000-0000-4000-8000-0000000002b3', '00000000-0000-4000-8000-0000000002b1', 'director@context-test.example.org', 'enriched', 'permitted');
insert into private.growth_briefs (opportunity_id, writer, research, model, prompt_version)
  values ('00000000-0000-4000-8000-0000000002b2',
    '{"summary":"A home health agency serving two counties.","angle":"referral_growth","pains":[{"question":"Which hospitals send the most?","capability":"x"}],
      "hook":{"sentence":"It opened a second office this fall.","sourceUrl":"https://context-test.example.org/news"},"triggers":[]}',
    '{"leaders":[{"name":"Jane Doe","title":"Owner"}],"fit":90}', 'test', 'brief.test');
insert into private.growth_messages (id, opportunity_id, contact_id, purpose, subject, body, opportunity_version, contact_version, policy_version, unsubscribe_hash, status, attempted_at, arms)
  values ('00000000-0000-4000-8000-0000000002b4', '00000000-0000-4000-8000-0000000002b2', '00000000-0000-4000-8000-0000000002b3', 'marketing', 'Your county''s referral sources',
    'Body.', 1, 1, 1, repeat('a', 64), 'delivered', now() - interval '3 days', '{"form":"short"}'),
    ('00000000-0000-4000-8000-0000000002b5', '00000000-0000-4000-8000-0000000002b2', '00000000-0000-4000-8000-0000000002b3', 'marketing', 'A second note',
    'Body.', 1, 1, 1, repeat('a', 64), 'delivered', now() - interval '1 day', '{}'),
    ('00000000-0000-4000-8000-0000000002b6', '00000000-0000-4000-8000-0000000002b2', '00000000-0000-4000-8000-0000000002b3', 'marketing', 'Not yet answered',
    'Body.', 1, 1, 1, repeat('a', 64), 'delivered', now() + interval '1 hour', '{}');
insert into private.communications (id, channel, source_system, source_key, subject, contact_email, product_id)
  values ('00000000-0000-4000-8000-0000000002b7', 'email', 'hub.email', 'test:context', 'Re: A second note', 'Director@Context-Test.example.org',
    '00000000-0000-4000-8000-000000000006');
insert into private.communication_messages (id, communication_id, direction, body, delivery, provider_message_id)
  values ('00000000-0000-4000-8000-0000000002b8', '00000000-0000-4000-8000-0000000002b7', 'inbound', 'Tell me more.', 'received', 'email:context-test');

select is(private.sales_growth_context_read('00000000-0000-4000-8000-0000000002b7', '00000000-0000-4000-8000-0000000002b8') -> 'answered',
  '{"touch":2,"purpose":"marketing","subject":"A second note"}'::jsonb, 'The answered email is the latest one sent before the reply, with its touch number');
select is(private.sales_growth_context_read('00000000-0000-4000-8000-0000000002b7', '00000000-0000-4000-8000-0000000002b8') -> 'brief',
  '{"summary":"A home health agency serving two counties.","angle":"referral_growth","pains":["Which hospitals send the most?"],"hook":"It opened a second office this fall."}'::jsonb,
  'The brief is its writer part''s plain fields, never a leader or the fit');
select is(private.sales_growth_context_read('00000000-0000-4000-8000-0000000002b7', '00000000-0000-4000-8000-0000000002b8') -> 'reportOpened', 'false'::jsonb,
  'An unopened report reads false');
update private.growth_opportunities set memory = jsonb_build_object('reportViewedAt', now()::text) where id = '00000000-0000-4000-8000-0000000002b2';
select is(private.sales_growth_context_read('00000000-0000-4000-8000-0000000002b7', '00000000-0000-4000-8000-0000000002b8') -> 'reportOpened', 'true'::jsonb,
  'An opened report reads true, and nothing more about the open');
update private.growth_organizations set internal = true where id = '00000000-0000-4000-8000-0000000002b1';
select is(private.sales_growth_context_read('00000000-0000-4000-8000-0000000002b7', '00000000-0000-4000-8000-0000000002b8'), null::jsonb,
  'An internal organization has no prospect context');

select * from finish();
rollback;
