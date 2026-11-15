-- Each cold touch also to the other decision-makers at the organization (20261115230000_growth_colleagues.sql).
begin;
select plan(43);

-- ---- The owner's number, the order of decision-makers, generic addresses ----------------------------------------------------------
select is((select kind from private.hub_settings where key = 'growth.people_per_organization'), 'number', 'The number of people is a number setting');
select is((select value from private.hub_settings where key = 'growth.people_per_organization'), null::jsonb, 'It starts not set');
select is(private.growth_people_per_organization(), 3, 'Not set, three people including the first contact');
update private.hub_settings set value = '9' where key = 'growth.people_per_organization';
select is(private.growth_people_per_organization(), 5, 'Held to five');
update private.hub_settings set value = '0' where key = 'growth.people_per_organization';
select is(private.growth_people_per_organization(), 1, 'Held to one: only the first contact');
update private.hub_settings set value = '2.5' where key = 'growth.people_per_organization';
select is(private.growth_people_per_organization(), 3, 'A number that is not whole is treated as not set');
update private.hub_settings set value = null where key = 'growth.people_per_organization';
select ok(private.growth_colleague_rank('Owner') < private.growth_colleague_rank('Administrator')
  and private.growth_colleague_rank('Administrator') < private.growth_colleague_rank('Director of Marketing')
  and private.growth_colleague_rank('Director of Marketing') < private.growth_colleague_rank('Office Manager')
  and private.growth_colleague_rank('Office Manager') < private.growth_colleague_rank('Nurse'),
  'Owner, administrator, business development or marketing, then other managers, then everyone else');
select is(private.growth_colleague_rank('Vice President of Operations'), private.growth_colleague_rank('Clinical Manager'), 'A vice president is not read as the president');
select ok(private.growth_generic_address('info@a.example') and private.growth_generic_address('Intake@a.example') and not private.growth_generic_address('jane.doe@a.example'),
  'A generic mailbox is never a person');

-- ---- Boundaries -----------------------------------------------------------------------------------------------------------------
select ok(not exists (select 1 from unnest(array['anon', 'authenticated', 'service_role']) r
            cross join unnest(array['private.growth_colleague_candidates(integer)', 'private.growth_colleague_draft(uuid,uuid,text)']) f
            where has_function_privilege(r, f, 'execute'))
  and has_function_privilege('hub_app_server', 'private.growth_colleague_candidates(integer)', 'execute')
  and has_function_privilege('hub_app_server', 'private.growth_colleague_draft(uuid,uuid,text)', 'execute'),
  'Only the Hub server lists and records colleague emails');
select ok(not exists (select 1 from unnest(array['anon', 'authenticated', 'service_role', 'hub_app_server']) r
            cross join unnest(array['private.growth_people_per_organization()', 'private.growth_colleague_pool(uuid)', 'private.growth_colleague_primary(uuid)',
              'private.growth_outreach_stopped(uuid)', 'private.growth_colleague_rank(text)', 'private.growth_generic_address(text)']) f
            where has_function_privilege(r, f, 'execute')), 'The helpers are closed to every role');
select throws_ok($$select private.growth_colleague_candidates(5)$$, '42501', 'Application server required.', 'The session-user boundary is enforced');
select ok(hub.get_backend_contract() -> 'features' ? 'platform.agents.growth-colleagues.v1', 'The feature is declared');
select ok(position('recipients' in pg_get_functiondef('hub.growth_detail(uuid)'::regprocedure)) > 0
  and position('hub.authorize_app_admin()' in pg_get_functiondef('hub.growth_detail(uuid)'::regprocedure)) > 0, 'Only the owner sees who received each touch');

-- Stub only the session-user guard (as 099 does); the rollback restores it with every fixture.
create or replace function private.require_hub_app_server() returns void
language plpgsql stable set search_path='' as $$ begin return; end; $$;

-- ---- One agency, a role address that got touch 1, and its people ----------------------------------------------------------------
update private.growth_policies set enabled = true, approved_claim = 'Fixture claim.' where product = 'caremetric-intel';
insert into private.growth_organizations(id, name, domain, discovered_at) values ('e1030000-0000-4000-8000-000000000001', 'Colleague Agency', 'colleague-agency.example.test', now());
insert into private.growth_contacts(id, organization_id, email, name, role, eligibility, verified_at, source_kind) values
  ('e1030000-0000-4000-8000-000000000010', 'e1030000-0000-4000-8000-000000000001', 'info@colleague-agency.example.test', '', 'Public business address', 'permitted', now(), 'role_address'),
  ('e1030000-0000-4000-8000-000000000011', 'e1030000-0000-4000-8000-000000000001', 'pat.office@colleague-agency.example.test', 'Pat Office', 'Office Manager', 'permitted', now(), 'enriched'),
  ('e1030000-0000-4000-8000-000000000012', 'e1030000-0000-4000-8000-000000000001', 'ann.admin@colleague-agency.example.test', 'Ann Admin', 'Administrator', 'permitted', now(), 'enriched'),
  ('e1030000-0000-4000-8000-000000000013', 'e1030000-0000-4000-8000-000000000001', 'owen.owner@colleague-agency.example.test', 'Owen Owner', 'Owner', 'permitted', now(), 'enriched'),
  ('e1030000-0000-4000-8000-000000000014', 'e1030000-0000-4000-8000-000000000001', 'mia.marketing@colleague-agency.example.test', 'Mia Marketing', 'Director of Marketing', 'permitted', now(), 'imported'),
  ('e1030000-0000-4000-8000-000000000015', 'e1030000-0000-4000-8000-000000000001', 'admissions@colleague-agency.example.test', 'Admissions', 'Admissions', 'permitted', now(), 'imported'),
  ('e1030000-0000-4000-8000-000000000016', 'e1030000-0000-4000-8000-000000000001', 'tom.typed@colleague-agency.example.test', 'Tom Typed', 'Owner', 'permitted', now(), 'owner'),
  ('e1030000-0000-4000-8000-000000000017', 'e1030000-0000-4000-8000-000000000001', 'rae.review@colleague-agency.example.test', 'Rae Review', 'President', 'review', now(), 'enriched');
insert into private.growth_opportunities(id, organization_id, contact_id, product, stage, owner_agent)
  values ('e1030000-0000-4000-8000-000000000020', 'e1030000-0000-4000-8000-000000000001', 'e1030000-0000-4000-8000-000000000010', 'caremetric-intel', 'contacted', 'marketing_manager');
insert into private.customer_success_plans(id, opportunity_id, trigger_key, kind, action, success_criterion, owner_agent, due_at)
  values ('e1030000-0000-4000-8000-000000000030', 'e1030000-0000-4000-8000-000000000020', 'outreach:0', 'outreach', 'Offer a next step.', 'A reply.', 'marketing_manager', now()),
         ('e1030000-0000-4000-8000-000000000031', 'e1030000-0000-4000-8000-000000000020', 'outreach:1', 'outreach', 'Offer a next step.', 'A reply.', 'marketing_manager', now());
insert into private.agent_tasks(id, agent_key, kind, request_key, status) values ('e1030000-0000-4000-8000-000000000040', 'marketing_manager', 'growth.pipeline', 'colleague-fixture', 'done');
insert into private.agent_actions(id, task_id, agent_key, kind, target_kind, target_id, preview, status) values
  ('e1030000-0000-4000-8000-000000000041', 'e1030000-0000-4000-8000-000000000040', 'marketing_manager', 'growth.message', 'growth_message', 'e1030000-0000-4000-8000-000000000050', 'Touch 1', 'executed'),
  ('e1030000-0000-4000-8000-000000000042', 'e1030000-0000-4000-8000-000000000040', 'marketing_manager', 'growth.message', 'growth_message', 'e1030000-0000-4000-8000-000000000060', 'Touch 2', 'executed');
insert into private.growth_messages(id, opportunity_id, work_id, contact_id, purpose, subject, body, citations, opportunity_version, contact_version, policy_version,
    status, unsubscribe_hash, action_id, attempted_at, model_generated, arms)
  select 'e1030000-0000-4000-8000-000000000050', 'e1030000-0000-4000-8000-000000000020', 'e1030000-0000-4000-8000-000000000030', 'e1030000-0000-4000-8000-000000000010',
    'marketing', 'Your county''s referrals', 'The approved words, with the agency''s own report link.', '[]', 1, 1, p.version, 'accepted', repeat('a', 64),
    'e1030000-0000-4000-8000-000000000041', now() - interval '1 hour', true, '{"trigger":"cms_record"}'
  from private.growth_policies p where p.product = 'caremetric-intel';

-- ---- Who touch 1 goes to ---------------------------------------------------------------------------------------------------------
select is(private.growth_colleague_primary('e1030000-0000-4000-8000-000000000050'), null, 'A sent cold touch may go to colleagues');
select is(array(select contact_id from private.growth_colleague_pool('e1030000-0000-4000-8000-000000000050')),
  array['e1030000-0000-4000-8000-000000000013', 'e1030000-0000-4000-8000-000000000012']::uuid[],
  'Three people: the first contact and the two best-ranked permitted named people (owner, administrator)');
update private.hub_settings set value = '5' where key = 'growth.people_per_organization';
select is(array(select contact_id from private.growth_colleague_pool('e1030000-0000-4000-8000-000000000050')),
  array['e1030000-0000-4000-8000-000000000013', 'e1030000-0000-4000-8000-000000000012', 'e1030000-0000-4000-8000-000000000014', 'e1030000-0000-4000-8000-000000000011']::uuid[],
  'Never a generic mailbox, a person typed in by the owner or one waiting for review, at most the owner''s number');
update private.hub_settings set value = '1' where key = 'growth.people_per_organization';
select is((select count(*)::integer from private.growth_colleague_pool('e1030000-0000-4000-8000-000000000050')), 0, 'One: only the first contact');
update private.hub_settings set value = null where key = 'growth.people_per_organization';
select is((select jsonb_agg(c -> 'contactId' order by c ->> 'contactId') from jsonb_array_elements(private.growth_colleague_candidates(20)) c
           where c ->> 'primaryId' = 'e1030000-0000-4000-8000-000000000050'),
  '["e1030000-0000-4000-8000-000000000012", "e1030000-0000-4000-8000-000000000013"]'::jsonb, 'The sweep is told both');
select is((select c ->> 'workId' from jsonb_array_elements(private.growth_colleague_candidates(20)) c where c ->> 'primaryId' = 'e1030000-0000-4000-8000-000000000050' limit 1),
  'e1030000-0000-4000-8000-000000000030', 'With the touch''s work, which the opt-out link is signed for');

-- ---- Recording them --------------------------------------------------------------------------------------------------------------
select throws_ok($$select private.growth_colleague_draft('e1030000-0000-4000-8000-000000000050', 'e1030000-0000-4000-8000-000000000013', 'not-a-hash')$$, '22023',
  'Invalid unsubscribe hash', 'Each colleague email needs its own signed opt-out');
select is(private.growth_colleague_draft('e1030000-0000-4000-8000-000000000050', 'e1030000-0000-4000-8000-000000000011', repeat('b', 64)) ->> 'reason', 'not_chosen',
  'Someone outside the chosen people is refused');
select is((private.growth_colleague_draft('e1030000-0000-4000-8000-000000000050', 'e1030000-0000-4000-8000-000000000013', repeat('c', 64)) ->> 'created')::boolean, true, 'The owner is recorded');
select is((private.growth_colleague_draft('e1030000-0000-4000-8000-000000000050', 'e1030000-0000-4000-8000-000000000013', repeat('c', 64)) ->> 'created')::boolean, false, 'Recording again returns the same email');
select private.growth_colleague_draft('e1030000-0000-4000-8000-000000000050', 'e1030000-0000-4000-8000-000000000012', repeat('d', 64));
select is((select count(*)::integer from private.growth_messages where primary_message_id = 'e1030000-0000-4000-8000-000000000050'), 2, 'One email per person');
select ok((select bool_and(m.subject = pm.subject and m.body = pm.body and m.citations = pm.citations and m.arms = pm.arms and m.model_generated and m.work_id is null
              and m.purpose = 'marketing' and m.status = 'draft' and m.unsubscribe_hash <> pm.unsubscribe_hash)
           from private.growth_messages m join private.growth_messages pm on pm.id = m.primary_message_id where m.primary_message_id = 'e1030000-0000-4000-8000-000000000050'),
  'The same approved words, its own opt-out, and no work of its own');
select is((select count(*)::integer from jsonb_array_elements(private.growth_colleague_candidates(20)) c where c ->> 'primaryId' = 'e1030000-0000-4000-8000-000000000050'), 2,
  'Recorded people are listed again until they are proposed');
update private.growth_messages set status = 'proposed' where primary_message_id = 'e1030000-0000-4000-8000-000000000050';
select ok(not exists (select 1 from jsonb_array_elements(private.growth_colleague_candidates(20)) c where c ->> 'primaryId' = 'e1030000-0000-4000-8000-000000000050'),
  'Proposed people are not listed again');
select throws_ok($$insert into private.growth_messages(opportunity_id, work_id, contact_id, purpose, subject, body, opportunity_version, contact_version, policy_version,
    unsubscribe_hash, primary_message_id) values ('e1030000-0000-4000-8000-000000000020', 'e1030000-0000-4000-8000-000000000030', 'e1030000-0000-4000-8000-000000000011',
    'marketing', 'x', 'x', 1, 1, 1, repeat('e', 64), 'e1030000-0000-4000-8000-000000000050')$$, '23514', null, 'A colleague email never holds a work of its own');

-- ---- Sent: touches still count once, and the opportunity does not move -----------------------------------------------------------
update private.growth_messages set status = 'sending', attempted_at = now() - interval '30 minutes', action_id = null where primary_message_id = 'e1030000-0000-4000-8000-000000000050';
select private.growth_finish_message(id, 'accepted', 'provider-' || left(id::text, 8)) from private.growth_messages where primary_message_id = 'e1030000-0000-4000-8000-000000000050';
select is((select version from private.growth_opportunities where id = 'e1030000-0000-4000-8000-000000000020'), 1, 'A colleague''s email does not move its opportunity');
select is((select (i ->> 'touches')::integer from jsonb_array_elements(private.growth_snapshot(0) -> 'items') i where i ->> 'id' = 'e1030000-0000-4000-8000-000000000020'), 1,
  'Three emails, one touch');
select is((select i ->> 'outreach_stopped' from jsonb_array_elements(private.growth_snapshot(0) -> 'items') i where i ->> 'id' = 'e1030000-0000-4000-8000-000000000020'), 'false',
  'The organization has not asked to stop');

-- ---- Touch 2 goes only to those who received touch 1 ------------------------------------------------------------------------------
-- The administrator's touch 1 soft-bounced: dropped from the sequence without stopping the rest.
select private.growth_delivery_event('colleague:soft', id, 'bounced', now(), false) from private.growth_messages
 where primary_message_id = 'e1030000-0000-4000-8000-000000000050' and contact_id = 'e1030000-0000-4000-8000-000000000012';
insert into private.growth_messages(id, opportunity_id, work_id, contact_id, purpose, subject, body, citations, opportunity_version, contact_version, policy_version,
    status, unsubscribe_hash, action_id, attempted_at)
  select 'e1030000-0000-4000-8000-000000000060', 'e1030000-0000-4000-8000-000000000020', 'e1030000-0000-4000-8000-000000000031', 'e1030000-0000-4000-8000-000000000010',
    'marketing', 'Another angle', 'Touch two.', '[]', 1, 1, p.version, 'accepted', repeat('f', 64), 'e1030000-0000-4000-8000-000000000042', now()
  from private.growth_policies p where p.product = 'caremetric-intel';
select is(array(select contact_id from private.growth_colleague_pool('e1030000-0000-4000-8000-000000000060')), array['e1030000-0000-4000-8000-000000000013']::uuid[],
  'Touch 2 goes to the people who received touch 1, and a bounced colleague is dropped');
select is(private.growth_colleague_primary('e1030000-0000-4000-8000-000000000050'), 'superseded', 'An earlier touch no longer goes to anyone');
select is((select (i ->> 'touches')::integer from jsonb_array_elements(private.growth_snapshot(0) -> 'items') i where i ->> 'id' = 'e1030000-0000-4000-8000-000000000020'), 2,
  'Two touches');
select private.growth_colleague_draft('e1030000-0000-4000-8000-000000000060', 'e1030000-0000-4000-8000-000000000013', repeat('1', 64));
select is((select status from private.growth_messages where primary_message_id = 'e1030000-0000-4000-8000-000000000060'), 'draft', 'The owner''s touch 2 waits to be proposed');

-- ---- A colleague's hard bounce drops only that person; an opt-out stops everyone ---------------------------------------------------
insert into private.growth_messages(opportunity_id, work_id, contact_id, purpose, subject, body, opportunity_version, contact_version, policy_version, status, unsubscribe_hash)
  values ('e1030000-0000-4000-8000-000000000020', 'e1030000-0000-4000-8000-000000000031', 'e1030000-0000-4000-8000-000000000010', 'marketing', 'Pending', 'Pending.', 2, 1, 1, 'proposed', repeat('2', 64));
select private.growth_delivery_event('colleague:hard', id, 'bounced', now(), true) from private.growth_messages
 where primary_message_id = 'e1030000-0000-4000-8000-000000000050' and contact_id = 'e1030000-0000-4000-8000-000000000012';
select is((select eligibility from private.growth_contacts where id = 'e1030000-0000-4000-8000-000000000012'), 'opted_out', 'A colleague''s hard bounce opts that person out');
select is((select count(*)::integer from private.growth_messages where opportunity_id = 'e1030000-0000-4000-8000-000000000020' and status in ('draft', 'proposed')), 2,
  'and stops nobody else''s email');
select private.growth_unsubscribe(unsubscribe_hash) from private.growth_messages
 where primary_message_id = 'e1030000-0000-4000-8000-000000000050' and contact_id = 'e1030000-0000-4000-8000-000000000013';
select is((select eligibility from private.growth_contacts where id = 'e1030000-0000-4000-8000-000000000013'), 'opted_out', 'Each colleague''s own link opts that person out');
select is((select count(*)::integer from private.growth_messages where opportunity_id = 'e1030000-0000-4000-8000-000000000020' and status in ('draft', 'proposed')), 0,
  'An opt-out by anyone there cancels every unsent email to everyone at the organization');
select ok(private.growth_outreach_stopped('e1030000-0000-4000-8000-000000000001'), 'and stops its cold outreach for good');
select is(private.growth_colleague_primary('e1030000-0000-4000-8000-000000000060'), 'stopped', 'No colleague gets a later touch');
select is((select i ->> 'outreach_stopped' from jsonb_array_elements(private.growth_snapshot(0) -> 'items') i where i ->> 'id' = 'e1030000-0000-4000-8000-000000000020'), 'true',
  'and the sweep plans no more outreach for it');

select * from finish();
rollback;
