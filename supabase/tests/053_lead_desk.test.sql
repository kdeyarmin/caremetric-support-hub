begin;
select plan(131);

-- ---- The boundary: who may reach what ------------------------------------------------------------------------------
select ok(coalesce((select relrowsecurity from pg_class where oid = 'private.leads'::regclass), false), 'The leads table has row level security');

select ok(not bool_or(has_table_privilege(role_name, 'private.leads', 'select,insert,update,delete,truncate,references,trigger')
    or has_any_column_privilege(role_name, 'private.leads', 'select,insert,update,references')),
  'No browser, service or server role reaches the leads table directly')
from unnest(array['public', 'anon', 'authenticated', 'service_role', 'hub_app_server']) as role_name;

select ok(coalesce((select p.prosecdef and coalesce(p.proconfig @> array['search_path=""'], false) from pg_proc p where p.oid = 'private.lead_intake(text,jsonb)'::regprocedure), false),
  'Lead intake is a security definer with a pinned empty search path');
select ok(has_function_privilege('hub_app_server', 'private.lead_intake(text,jsonb)', 'execute'), 'The Hub server role records leads');
select ok(not bool_or(has_function_privilege(role_name, 'private.lead_intake(text,jsonb)', 'execute')),
  'No browser or service role records a lead')
from unnest(array['public', 'anon', 'authenticated', 'service_role']) as role_name;

select ok(coalesce((select p.prosecdef and coalesce(p.proconfig @> array['search_path=""'], false) from pg_proc p where p.oid = 'private.lead_retention(integer)'::regprocedure), false),
  'Lead retention is a security definer with a pinned empty search path');
select ok(has_function_privilege('hub_app_server', 'private.lead_retention(integer)', 'execute'), 'The Hub server role runs lead retention');
select ok(not bool_or(has_function_privilege(role_name, 'private.lead_retention(integer)', 'execute')),
  'No browser or service role runs lead retention')
from unnest(array['public', 'anon', 'authenticated', 'service_role']) as role_name;

select ok(bool_and(coalesce(p.proconfig @> array['search_path=""'], false)) and count(*) = 5,
  'Every lead helper pins an empty search path')
from unnest(array['private.lead_text(jsonb,integer)', 'private.lead_instant(jsonb)', 'private.lead_json(uuid)', 'private.lead_record(text,jsonb)',
  'private.lead_retention_batch(integer)']) as helper
join pg_proc p on p.oid = to_regprocedure(helper);
select ok(not bool_or(has_function_privilege(role_name, helper, 'execute')),
  'No role, the Hub server included, runs a lead helper directly')
from unnest(array['private.lead_text(jsonb,integer)', 'private.lead_instant(jsonb)', 'private.lead_json(uuid)', 'private.lead_record(text,jsonb)',
  'private.lead_retention_batch(integer)']) as helper
cross join unnest(array['public', 'anon', 'authenticated', 'service_role', 'hub_app_server']) as role_name;

select ok(bool_and(p.prosecdef and coalesce(p.proconfig @> array['search_path=""'], false)
    and has_function_privilege('authenticated', operation, 'execute')
    and not has_function_privilege('anon', operation, 'execute')
    and not has_function_privilege('service_role', operation, 'execute')) and count(*) = 2,
  'The owner operations are security definers that only signed-in sessions may call')
from unnest(array['hub.list_leads(text,text,boolean,integer,integer)', 'hub.update_lead_status(uuid,text,timestamp with time zone)']) as operation
join pg_proc p on p.oid = to_regprocedure(operation);
select ok(position('hub.authorize_app_admin()' in pg_get_functiondef('hub.list_leads(text,text,boolean,integer,integer)'::regprocedure)) > 0
    and position('hub.authorize_app_command()' in pg_get_functiondef('hub.update_lead_status(uuid,text,timestamp with time zone)'::regprocedure)) > 0,
  'Reading leads needs the administrator session and changing one the command session');

select throws_ok($$select private.lead_intake('carebase', '{}'::jsonb)$$, '42501', 'Application server required.',
  'Lead intake refuses every session user but the Hub server');
select throws_ok($$select private.lead_retention(500)$$, '42501', 'Application server required.',
  'Lead retention refuses every session user but the Hub server');
set local role anon;
select throws_ok($$select private.lead_intake('carebase', '{}'::jsonb)$$, '42501', null, 'An anonymous caller cannot record a lead');
select throws_ok($$select private.lead_retention()$$, '42501', null, 'An anonymous caller cannot run lead retention');
select throws_ok($$select hub.list_leads(null, null, false, 0, 25)$$, '42501', null, 'An anonymous caller cannot list leads');
reset role;

insert into auth.users (id, email, is_anonymous) values ('99530000-0000-4000-8000-000000000001', 'lead-desk-contract@test.invalid', false);
set local request.jwt.claims = '{"sub":"99530000-0000-4000-8000-000000000001","role":"authenticated"}';
set local role authenticated;
select throws_ok($$select private.lead_record('carebase', '{}'::jsonb)$$, '42501', null, 'A signed-in account cannot run the intake helper');
select throws_ok($$select private.lead_retention(500)$$, '42501', null, 'A signed-in account cannot run lead retention');
select throws_ok($$select private.lead_retention_batch(500)$$, '42501', null, 'nor its batch helper');
select throws_ok($$select hub.list_leads(null, null, false, 0, 25)$$, '28000', 'Current administrator session required.',
  'Listing leads without an administrator session fails closed');
select throws_ok($$select hub.update_lead_status(gen_random_uuid(), 'contacted', now())$$, '28000', 'Current administrator session required.',
  'Changing a lead without an administrator session fails closed');
reset role;

select ok(hub.get_backend_contract() -> 'features' @> '["support.leads.v1"]'::jsonb, 'The lead desk is declared in release metadata');

-- ---- Conversations accept the new website sources, and nothing else changed ----------------------------------------
select lives_ok($$insert into private.communications (channel, source_system, source_key, subject) values ('web_form', 'intel.web', 'lead-desk-check', 'Check')$$,
  'A conversation can come from the Intel website');
select throws_ok($$insert into private.communications (channel, source_system, source_key, subject) values ('web_form', 'breathe.web', 'lead-desk-check', 'Check')$$,
  '23514', null, 'An unknown source is still refused');
select throws_ok($$insert into private.communications (channel, source_system, source_key, subject, chat_token_hash) values ('chat', 'carebase.web', 'lead-desk-chat', 'Check', repeat('a', 64))$$,
  '23514', null, 'Only website chat may use the chat channel');

-- ---- Validation: every way a lead can break the contract is 22023 "Invalid lead." -----------------------------------
create temporary table lead_base (doc jsonb) on commit drop;
insert into lead_base values ('{
  "version": 1, "source": "carebase", "kind": "demo_request", "externalId": "lead-desk-test-1", "occurredAt": "2026-11-01T12:00:00.000Z", "test": false,
  "contact": {"name": "Jordan Rivera", "email": " Jordan.Rivera@Sunrise.Example ", "phone": "(202) 555-0101", "organization": "Sunrise Assisted Living Facility", "role": "Administrator"},
  "details": {"facilityCount": 3, "plan": "complete", "trialRequested": true},
  "message": "LEAD-DESK-CANARY We would like a demo for three ALFs.",
  "attribution": {"utmSource": "google", "utmMedium": "cpc", "utmCampaign": "fall", "referrerHost": "WWW.Google.com", "landingPath": "/pricing", "firstSeenAt": "2026-10-30T09:00:00.000Z"}
}');

create temporary table invalid_leads (n integer primary key, source text, doc jsonb, description text) on commit drop;
insert into invalid_leads
select n, coalesce(source, 'carebase'), doc, description from (values
  (1, null, (select doc || '{"extra": 1}' from lead_base), 'An unknown top-level key'),
  (2, null, (select doc || '{"version": 2}' from lead_base), 'Another contract version'),
  (3, null, (select doc || '{"version": "1"}' from lead_base), 'A version that is not the number 1'),
  (4, 'intel', (select doc from lead_base), 'A body whose source is not the signed source'),
  (5, 'breathe', (select doc || '{"source": "breathe"}' from lead_base), 'A product that does not forward leads'),
  (6, null, (select doc || '{"kind": "webinar"}' from lead_base), 'An unknown kind'),
  (7, null, (select doc || '{"externalId": "has space"}' from lead_base), 'An external id with a space'),
  (8, null, (select doc || jsonb_build_object('externalId', repeat('a', 101)) from lead_base), 'An external id over 100 characters'),
  (9, null, (select doc - 'externalId' from lead_base), 'A lead without an external id'),
  (10, null, (select doc || jsonb_build_object('occurredAt', to_char((now() + interval '6 minutes') at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')) from lead_base), 'A lead more than five minutes in the future'),
  (11, null, (select doc || '{"occurredAt": "2026-11-01T12:00:00"}' from lead_base), 'A time without its offset'),
  (12, null, (select doc || '{"occurredAt": "2026-02-30T12:00:00Z"}' from lead_base), 'A date the calendar does not have'),
  (13, null, (select doc || '{"test": "true"}' from lead_base), 'A test flag that is not a boolean'),
  (14, null, (select doc - 'contact' from lead_base), 'A lead without a contact'),
  (15, null, (select jsonb_set(doc, '{contact}', (doc -> 'contact') - 'email') from lead_base), 'A contact without an email address'),
  (16, null, (select jsonb_set(doc, '{contact,email}', '"not an address"') from lead_base), 'An email address that does not look like one'),
  (17, null, (select jsonb_set(doc, '{contact,email}', '"jordan@localhost"') from lead_base), 'An email address without a domain'),
  (18, null, (select jsonb_set(doc, '{contact,title}', '"CEO"') from lead_base), 'An unknown contact field'),
  (19, null, (select jsonb_set(doc, '{contact,name}', to_jsonb(repeat('n', 201))) from lead_base), 'A name over 200 characters'),
  (20, null, (select jsonb_set(doc, '{contact,phone}', to_jsonb(repeat('1', 41))) from lead_base), 'A phone number over 40 characters'),
  (21, null, (select jsonb_set(doc, '{contact,role}', to_jsonb(repeat('r', 101))) from lead_base), 'A role over 100 characters'),
  (22, null, (select jsonb_set(doc, '{contact,organization}', '42') from lead_base), 'An organization that is not text'),
  (23, null, (select doc || jsonb_build_object('details', (select jsonb_object_agg('fact' || i, i) from generate_series(1, 13) i)) from lead_base), 'Thirteen details'),
  (24, null, (select doc || '{"details": {"facility": {"beds": 40}}}' from lead_base), 'A nested detail'),
  (25, null, (select doc || '{"details": {"facility-count": 3}}' from lead_base), 'A detail key outside the pattern'),
  (26, null, (select doc || '{"details": {"beds": null}}' from lead_base), 'A detail that is null'),
  (27, null, (select doc || jsonb_build_object('details', jsonb_build_object('notes', repeat('d', 201))) from lead_base), 'A detail over 200 characters'),
  (28, null, (select doc || jsonb_build_object('message', repeat('m', 4001)) from lead_base), 'A message over 4,000 characters'),
  (29, null, (select doc || '{"message": ["hello"]}' from lead_base), 'A message that is not text'),
  (30, null, (select jsonb_set(doc, '{attribution,gclid}', '"abc"') from lead_base), 'An unknown attribution field'),
  (31, null, (select jsonb_set(doc, '{attribution,referrerHost}', '"www.google.com/search?q=alf"') from lead_base), 'A referrer that is more than a host name'),
  (32, null, (select jsonb_set(doc, '{attribution,landingPath}', '"/pricing?plan=complete"') from lead_base), 'A landing path with a query string'),
  (33, null, (select jsonb_set(doc, '{attribution,landingPath}', '"pricing"') from lead_base), 'A landing path that is not a path'),
  (34, null, (select jsonb_set(doc, '{attribution,utmTerm}', to_jsonb(repeat('u', 201))) from lead_base), 'A UTM value over 200 characters'),
  (35, null, (select jsonb_set(doc, '{attribution,firstSeenAt}', '"yesterday"') from lead_base), 'A first visit that is not a time'),
  (36, 'advisors', (select doc || '{"source": "advisors", "kind": "consultation", "externalId": "CM-abc"}' from lead_base), 'An Advisors inquiry without its CM- reference'),
  (37, null, '[1, 2, 3]'::jsonb, 'A body that is not an object'),
  -- An address that would turn a mailto: link into more than one address: URL and mail-header characters.
  (38, null, (select jsonb_set(doc, '{contact,email}', '"jordan@example.org?bcc=other%40example.net"') from lead_base), 'An address carrying mail headers'),
  (39, null, (select jsonb_set(doc, '{contact,email}', '"jordan&co@example.org"') from lead_base), 'An address with an ampersand'),
  (40, null, (select jsonb_set(doc, '{contact,email}', '"jordan#1@example.org"') from lead_base), 'An address with a number sign'),
  (41, null, (select jsonb_set(doc, '{contact,email}', '"jordan%40ops@example.org"') from lead_base), 'An address with a percent sign'),
  (42, null, (select jsonb_set(doc, '{contact,email}', '"jordan/ops@example.org"') from lead_base), 'An address with a slash'),
  (43, null, (select jsonb_set(doc, '{contact,email}', to_jsonb('jordan\ops@example.org'::text)) from lead_base), 'An address with a backslash'),
  (44, null, (select jsonb_set(doc, '{contact,email}', '"jordan@example.org,other@example.net"') from lead_base), 'Two addresses separated by a comma'),
  (45, null, (select jsonb_set(doc, '{contact,email}', '"jordan@example.org;other@example.net"') from lead_base), 'Two addresses separated by a semicolon'),
  (46, null, (select jsonb_set(doc, '{contact,email}', '"jordan=ops@example.org"') from lead_base), 'An address with an equals sign'),
  (47, null, (select jsonb_set(doc, '{contact,email}', '"jordan@example.org:25"') from lead_base), 'An address with a port'),
  (48, null, (select jsonb_set(doc, '{contact,email}', '"\"jordan rivera\"@example.org"') from lead_base), 'A quoted local part'),
  (49, null, (select jsonb_set(doc, '{contact,email}', '"Jordan <jordan@example.org>"') from lead_base), 'A display name with the address'),
  (50, null, (select jsonb_set(doc, '{contact,email}', '"jordan@[192.0.2.1]"') from lead_base), 'An address at a bracketed IP address'),
  (51, null, (select jsonb_set(doc, '{contact,email}', '"jordan..rivera@example.org"') from lead_base), 'An address with an empty part')
) as cases (n, source, doc, description);

select throws_ok(format('select private.lead_record(%L, %L::jsonb)', source, doc), '22023', 'Invalid lead.', 'Refused: ' || lower(left(description, 1)) || substr(description, 2))
from invalid_leads order by n;
select is((select count(*) from private.leads where external_id like 'lead-desk-%' or external_id like 'CM-abc%'), 0::bigint, 'No refused lead left a row');

-- ---- A demo request: one lead, one conversation, the message only in the conversation ------------------------------
create temporary table recorded (label text primary key, result jsonb) on commit drop;
insert into recorded select 'demo', private.lead_record('carebase', doc) from lead_base;

select ok((select (result ->> 'duplicate')::boolean = false and result ->> 'conversation' ~ '^CM-[0-9]+$' and (select count(*) from jsonb_object_keys(result)) = 3 from recorded where label = 'demo'),
  'A new lead answers with its id, not a duplicate, and its conversation reference');
select is((select row(l.source, l.kind, l.external_id, l.test, l.contact_email, l.contact_name, l.organization, l.role, l.referrer_host, l.landing_path, l.status)::text
    from private.leads l join recorded r on r.label = 'demo' and l.id = (r.result ->> 'id')::uuid),
  row('carebase', 'demo_request', 'lead-desk-test-1', false, 'jordan.rivera@sunrise.example', 'Jordan Rivera', 'Sunrise Assisted Living Facility', 'Administrator', 'www.google.com', '/pricing', 'new')::text,
  'The lead keeps the contact, with the address trimmed and lowercased, and its first touch');
select is((select l.details from private.leads l join recorded r on r.label = 'demo' and l.id = (r.result ->> 'id')::uuid),
  '{"facilityCount": 3, "plan": "complete", "trialRequested": true}'::jsonb, 'The details are kept as facts');
select is((select l.product_id from private.leads l join recorded r on r.label = 'demo' and l.id = (r.result ->> 'id')::uuid),
  (select id from hub.products where slug = 'carebase'), 'A CareBase lead belongs to CareBase');
select ok((select position('LEAD-DESK-CANARY' in to_jsonb(l)::text) = 0 from private.leads l join recorded r on r.label = 'demo' and l.id = (r.result ->> 'id')::uuid),
  'The message is never stored on the lead');

select is((select row(c.channel, c.source_system, c.source_key, c.status, c.inquiry_type, c.subject, c.contact_email, c.organization)::text
    from private.communications c join private.leads l on l.communication_id = c.id join recorded r on r.label = 'demo' and l.id = (r.result ->> 'id')::uuid),
  row('web_form', 'carebase.web', 'lead-desk-test-1', 'new', 'sales', 'Demo request: Sunrise Assisted Living Facility', 'jordan.rivera@sunrise.example', 'Sunrise Assisted Living Facility')::text,
  'A demo request opens a new sales conversation from the CareBase website');
select is((select 'CM-' || c.reference from private.communications c join private.leads l on l.communication_id = c.id join recorded r on r.label = 'demo' and l.id = (r.result ->> 'id')::uuid),
  (select result ->> 'conversation' from recorded where label = 'demo'), 'The answer names that conversation');
select is((select string_agg(m.direction || '|' || m.delivery || '|' || m.provider_message_id || '|' || m.body, ';')
    from private.communication_messages m join private.leads l on l.communication_id = m.communication_id join recorded r on r.label = 'demo' and l.id = (r.result ->> 'id')::uuid),
  E'inbound|received|carebase.web:lead-desk-test-1|LEAD-DESK-CANARY We would like a demo for three ALFs.\n\nRole: Administrator\nFacility count: 3\nPlan: complete\nTrial requested: Yes',
  'The visitor''s message and the facts arrive as one inbound message');
select is((select a.metadata from private.audit_events a join recorded r on r.label = 'demo' and a.entity_id = (r.result ->> 'id')::uuid where a.action = 'lead.received'),
  '{"source": "carebase", "kind": "demo_request", "test": false}'::jsonb, 'The audit event names the source, kind and test flag only');
select ok((select bool_and(a.actor_id is null and position('LEAD-DESK-CANARY' in a.metadata::text) = 0 and position('sunrise' in lower(a.metadata::text)) = 0)
    from private.audit_events a join recorded r on r.label = 'demo' and a.entity_id = (r.result ->> 'id')::uuid),
  'No visitor detail reaches the audit log');

-- ---- A repeat is a duplicate and changes nothing ---------------------------------------------------------------------
insert into recorded select 'repeat', private.lead_record('carebase', doc || '{"kind": "contact", "contact": {"email": "someone.else@example.com"}, "message": "Different text"}') from lead_base;
select is((select result from recorded where label = 'repeat'),
  (select jsonb_build_object('id', result -> 'id', 'duplicate', true, 'conversation', result -> 'conversation') from recorded where label = 'demo'),
  'A repeat of the same external id answers with the first lead as a duplicate');
select is((select row(count(*), min(l.kind), min(l.contact_email))::text from private.leads l where l.source = 'carebase' and l.external_id = 'lead-desk-test-1'),
  row(1, 'demo_request', 'jordan.rivera@sunrise.example')::text, 'The repeat changed nothing');
select is((select count(*) from private.communication_messages m join private.communications c on c.id = m.communication_id
    where c.source_system = 'carebase.web' and c.source_key = 'lead-desk-test-1'), 1::bigint, 'The repeat added no message');
select is((select count(*) from private.audit_events a join recorded r on r.label = 'demo' and a.entity_id = (r.result ->> 'id')::uuid), 1::bigint,
  'The repeat wrote no audit event');
select lives_ok($$select private.lead_record('intel', (select doc || '{"source": "intel"}' from lead_base))$$,
  'The same external id from another product is a different lead');

-- ---- A sign-up gets a conversation too (the Sales Executive follows up), and probes never do --------------------------
insert into recorded select 'newsletter', private.lead_record('intel', doc || '{"source": "intel", "kind": "newsletter", "externalId": "lead-desk-test-news"}') from lead_base;
select ok((select result ->> 'conversation' ~ '^CM-[0-9]+$' from recorded where label = 'newsletter'), 'A newsletter sign-up opens a conversation');
select is((select row(c.subject, c.inquiry_type, c.source_system, l.product_id = (select id from hub.products where slug = 'caremetric-intel'), left(m.body, 29))::text
    from private.leads l join recorded r on r.label = 'newsletter' and l.id = (r.result ->> 'id')::uuid
    join private.communications c on c.id = l.communication_id join private.communication_messages m on m.communication_id = c.id),
  row('Newsletter sign-up: Sunrise Assisted Living Facility', 'sales', 'intel.web', true, 'Signed up for the newsletter.')::text,
  'It is a sales conversation from the Intel website that says what the visitor did, under CareMetric Intel');

insert into recorded select 'probe', private.lead_record('carebase', doc || '{"externalId": "probe-1762171200", "test": true, "contact": {"email": "probe@caremetric.invalid"}}') from lead_base;
select is((select result -> 'conversation' from recorded where label = 'probe'), 'null'::jsonb, 'A test lead never opens a conversation, even for a demo request');
select is((select count(*) from private.communications where source_key = 'probe-1762171200'), 0::bigint, 'No conversation exists for the probe');
select is((select a.metadata from private.audit_events a join recorded r on r.label = 'probe' and a.entity_id = (r.result ->> 'id')::uuid),
  '{"source": "carebase", "kind": "demo_request", "test": true}'::jsonb, 'The probe is audited as a test');
select lives_ok($$select private.lead_record('advisors', (select doc || '{"source": "advisors", "kind": "consultation", "externalId": "probe-1762171200", "test": true}' from lead_base))$$,
  'An Advisors probe uses probe-<timestamp>, as the contract says');

-- Optional fields may be JSON null, and a lead may carry nothing but its contact's address.
insert into recorded select 'minimal', private.lead_record('carebase',
  '{"version": 1, "source": "carebase", "kind": "contact", "externalId": "lead-desk-test-min", "occurredAt": "2026-11-01T12:00:00+00:00", "contact": {"email": "min@example.org", "name": null}, "details": null, "message": null, "attribution": null, "test": null}');
select is((select row(l.contact_name, l.details, l.utm_source, l.test)::text from private.leads l join recorded r on r.label = 'minimal' and l.id = (r.result ->> 'id')::uuid),
  row(null::text, '{}'::jsonb, null::text, false)::text, 'Absent and null optional fields are stored as empty');
select is((select row(c.subject, c.inquiry_type)::text || '|' || (select m.body from private.communication_messages m where m.communication_id = c.id)
    from private.communications c join private.leads l on l.communication_id = c.id join recorded r on r.label = 'minimal' and l.id = (r.result ->> 'id')::uuid),
  row('Contact request: min@example.org', 'sales')::text || '|No message was included with this request.',
  'A contact request with nothing to say still opens a conversation that says so');

-- Addresses: the punctuation real addresses use is accepted, and the table itself refuses one with URL characters.
insert into recorded select 'address', private.lead_record('intel', doc || '{"source": "intel", "kind": "newsletter", "externalId": "lead-desk-test-address",
  "contact": {"email": " O''Brien.Ops+Leads_2026@Mail-1.Example.co.uk "}}') from lead_base;
select is((select l.contact_email from private.leads l join recorded r on r.label = 'address' and l.id = (r.result ->> 'id')::uuid),
  'o''brien.ops+leads_2026@mail-1.example.co.uk', 'An address with an apostrophe, plus, underscore, hyphen and subdomains is kept, trimmed and lowercased');
select throws_ok($$insert into private.leads (source, kind, external_id, occurred_at, contact_email)
    values ('carebase', 'contact', 'lead-desk-test-direct', now(), 'jordan@example.org?bcc=other@example.net')$$,
  '23514', null, 'The table refuses an address with URL characters even when it is written directly');

-- ---- Advisors: a consultation already imported is linked, not copied ----------------------------------------------
-- The same rows hub.import_communications writes for an Advisors request (it needs the Hub server's administrator session).
with imported as (
  insert into private.communications (channel, source_system, source_key, status, product_id, inquiry_type, subject, contact_name, contact_email, organization)
  values ('web_form', 'advisors.web', 'CM-0A0B0C0D0E53', 'open', (select id from hub.products where slug = 'advisors'), 'advisors',
    'Consultation request from Lakeside Hospice', 'Robin Park', 'robin@lakeside.example', 'Lakeside Hospice')
  returning id)
insert into private.communication_messages (communication_id, direction, body, delivery, provider_message_id)
select id, 'inbound', 'Imported request.', 'received', 'advisors.web:CM-0A0B0C0D0E53' from imported;

insert into recorded select 'advisors-imported', private.lead_record('advisors', doc || '{"source": "advisors", "kind": "consultation", "externalId": "CM-0A0B0C0D0E53",
  "contact": {"name": "Robin Park", "email": "robin@lakeside.example", "organization": "Lakeside Hospice"}, "details": {"service": "strategy", "sector": "Hospice"}}') from lead_base;
select is((select l.communication_id from private.leads l join recorded r on r.label = 'advisors-imported' and l.id = (r.result ->> 'id')::uuid),
  (select id from private.communications where source_system = 'advisors.web' and source_key = 'CM-0A0B0C0D0E53'),
  'The lead is linked to the conversation the import already made');
select is((select result ->> 'conversation' from recorded where label = 'advisors-imported'),
  (select 'CM-' || reference from private.communications where source_system = 'advisors.web' and source_key = 'CM-0A0B0C0D0E53'),
  'and the answer names it');
select is((select row(count(*), min(c.subject), min(c.status))::text from private.communications c where c.source_system = 'advisors.web' and c.source_key = 'CM-0A0B0C0D0E53'),
  row(1, 'Consultation request from Lakeside Hospice', 'open')::text, 'No second conversation was made and staff work was not touched');
select is((select string_agg(m.body, ';') from private.communication_messages m join private.communications c on c.id = m.communication_id
    where c.source_system = 'advisors.web' and c.source_key = 'CM-0A0B0C0D0E53'), 'Imported request.', 'No second copy of the request was added');

insert into recorded select 'advisors-new', private.lead_record('advisors', doc || '{"source": "advisors", "kind": "consultation", "externalId": "CM-0A0B0C0D0E54",
  "contact": {"name": "Sam Lee", "email": "sam@meadow.example", "organization": "Meadow Home Health"}, "details": {"service": "strategy", "sector": "Home health"}, "message": "Please call."}') from lead_base;
select is((select row(c.source_system, c.inquiry_type, c.subject, c.product_id = (select id from hub.products where slug = 'advisors'))::text
    from private.communications c join private.leads l on l.communication_id = c.id join recorded r on r.label = 'advisors-new' and l.id = (r.result ->> 'id')::uuid),
  row('advisors.web', 'advisors', 'Consultation request: Meadow Home Health', true)::text,
  'A new consultation opens an Advisors conversation under the key the import uses');
select is((select m.provider_message_id from private.communication_messages m join private.leads l on l.communication_id = m.communication_id
    join recorded r on r.label = 'advisors-new' and l.id = (r.result ->> 'id')::uuid), 'advisors.web:CM-0A0B0C0D0E54',
  'Its message carries the import''s provider key, so a later import skips it');
with import_attempt as (
  insert into private.communications (channel, source_system, source_key, subject)
  values ('web_form', 'advisors.web', 'CM-0A0B0C0D0E54', 'Consultation request from Meadow Home Health')
  on conflict (source_system, source_key) do nothing
  returning id)
select is((select count(*) from import_attempt), 0::bigint, 'The import''s own insert then skips it');

-- Several leads above carried the canary, some with no name, role or organization, and one was linked to an imported request.
select ok(not exists (select 1 from private.leads l where position('LEAD-DESK-CANARY' in to_jsonb(l)::text) > 0)
    and not exists (select 1 from private.communications c where position('LEAD-DESK-CANARY' in to_jsonb(c)::text) > 0)
    and not exists (select 1 from private.audit_events a where position('LEAD-DESK-CANARY' in to_jsonb(a)::text) > 0),
  'What a visitor wrote is in no lead, conversation field or audit event');
select is((select count(*) from private.communication_messages where position('LEAD-DESK-CANARY' in body) > 0), 4::bigint,
  'It is only in the inbound messages of the conversations that were opened');

-- ---- The owner's view ------------------------------------------------------------------------------------------------
select is((select array_agg(k order by k) from jsonb_object_keys(private.lead_json((select (result ->> 'id')::uuid from recorded where label = 'demo'))) k),
  array['attribution', 'contact', 'conversation', 'createdAt', 'details', 'externalId', 'id', 'kind', 'occurredAt', 'productId', 'receivedAt', 'source', 'status', 'test', 'updatedAt'],
  'The owner''s view of a lead has a fixed shape');
select is((select private.lead_json((select (result ->> 'id')::uuid from recorded where label = 'demo')) -> 'conversation' ->> 'reference'),
  (select result ->> 'conversation' from recorded where label = 'demo'), 'It links the lead''s conversation by reference');
select ok((select position('LEAD-DESK-CANARY' in private.lead_json((result ->> 'id')::uuid)::text) = 0 from recorded where label = 'demo'),
  'The owner''s view of a lead never carries the message');

-- ---- Retention: a lead twelve months after it arrived, a website conversation twelve months after its last message --
-- Some conversations above are dated 2026-11-01 and fall due a year later; one batch first clears whatever is already
-- due, so the counts below are exact whenever this runs.
select ok((private.lead_retention_batch(5000) ->> 'more')::boolean is false, 'One batch of 5,000 clears whatever was already due');
create temporary table retention_audit_floor on commit drop as select coalesce(max(id), 0) as id from private.audit_events;
create temporary table retention_fixture (label text primary key, id uuid not null) on commit drop;

-- Website conversations, by last message: an imported Advisors request 14 months idle, a CareBase one 13 months idle, an
-- Intel one a second past twelve months, one exactly twelve months idle, and one opened three years ago but answered last
-- month. Then an old conversation from every other channel.
with made as (
  insert into private.communications (channel, source_system, source_key, subject, chat_token_hash, created_at, updated_at, last_message_at)
  values
    ('web_form', 'advisors.web', 'CM-0A0B0C0D0E99', 'Retention: imported request', null, now() - interval '20 months', now() - interval '20 months', now() - interval '14 months'),
    ('web_form', 'carebase.web', 'retention-idle', 'Retention: idle request', null, now() - interval '13 months', now() - interval '13 months', now() - interval '13 months'),
    ('web_form', 'intel.web', 'retention-edge', 'Retention: just past the line', null, now() - interval '13 months', now() - interval '13 months', now() - interval '12 months 1 second'),
    ('web_form', 'intel.web', 'retention-line', 'Retention: on the line', null, now() - interval '13 months', now() - interval '13 months', now() - interval '12 months'),
    ('web_form', 'carebase.web', 'retention-active', 'Retention: answered last month', null, now() - interval '3 years', now() - interval '1 month', now() - interval '1 month'),
    ('email', 'hub.email', 'retention-mail', 'Retention: old email', null, now() - interval '3 years', now() - interval '3 years', now() - interval '3 years'),
    ('sms', 'hub.sms', 'retention-sms', 'Retention: old text', null, now() - interval '3 years', now() - interval '3 years', now() - interval '3 years'),
    ('chat', 'hub.chat', 'retention-chat', 'Retention: old chat', repeat('9', 64), now() - interval '3 years', now() - interval '3 years', now() - interval '3 years'),
    ('phone', 'breathe.phone', 'retention-phone', 'Retention: old call', null, now() - interval '3 years', now() - interval '3 years', now() - interval '3 years')
  returning id, source_key)
insert into retention_fixture select source_key, id from made;
insert into private.communication_messages (communication_id, direction, body, delivery, delivery_channel, created_at)
select f.id, m.direction, m.body, m.delivery, m.delivery_channel, m.at
from retention_fixture f join (values
  ('CM-0A0B0C0D0E99', 'inbound', 'RETENTION-CANARY imported request', 'received', null::text, now() - interval '14 months'),
  ('retention-idle', 'inbound', 'RETENTION-CANARY idle request', 'received', null, now() - interval '13 months 1 day'),
  ('retention-idle', 'outbound', 'Our answer, long ago', 'sent', 'email', now() - interval '13 months'),
  ('retention-edge', 'inbound', 'A request a second past the line', 'received', null, now() - interval '12 months 1 second'),
  ('retention-line', 'inbound', 'A request on the line', 'received', null, now() - interval '12 months'),
  ('retention-active', 'inbound', 'An old question', 'received', null, now() - interval '3 years'),
  ('retention-active', 'outbound', 'An answer last month', 'sent', 'email', now() - interval '1 month'),
  ('retention-mail', 'inbound', 'An old email', 'received', null, now() - interval '3 years')
) as m (label, direction, body, delivery, delivery_channel, at) on m.label = f.label;

-- Leads, by arrival: 25 months (it named the conversation answered last month), 13 months, a second past twelve months,
-- exactly twelve months, eleven months, and last month (an Advisors lead linked to the imported request).
with made as (
  insert into private.leads (source, kind, external_id, occurred_at, received_at, contact_email, contact_name, communication_id)
  values
    ('carebase', 'demo_request', 'retention-oldest', now() - interval '25 months', now() - interval '25 months', 'oldest@retention.example', 'Retention Oldest',
      (select id from retention_fixture where label = 'retention-active')),
    ('intel', 'newsletter', 'retention-old', now() - interval '13 months', now() - interval '13 months', 'old@retention.example', null, null),
    ('carebase', 'trial_signup', 'retention-edge', now() - interval '12 months 1 second', now() - interval '12 months 1 second', 'edge@retention.example', null, null),
    ('intel', 'contact', 'retention-line', now() - interval '12 months', now() - interval '12 months', 'line@retention.example', null, null),
    ('carebase', 'contact', 'retention-new', now() - interval '11 months', now() - interval '11 months', 'new@retention.example', null, null),
    ('advisors', 'consultation', 'CM-0A0B0C0D0E99', now() - interval '1 month', now() - interval '1 month', 'linked@retention.example', 'Retention Linked',
      (select id from retention_fixture where label = 'CM-0A0B0C0D0E99'))
  returning id, external_id)
insert into retention_fixture select 'lead:' || external_id, id from made;

create temporary table retention_runs (n integer primary key, result jsonb) on commit drop;
insert into retention_runs values (1, private.lead_retention_batch(2));
select is((select result from retention_runs where n = 1), '{"leads": 2, "conversations": 2, "more": true}'::jsonb,
  'A batch of two deletes two leads and two website conversations and says more are due');
select is((select array_agg(f.label order by f.label collate "C") from retention_fixture f
    where not exists (select 1 from private.leads l where l.id = f.id) and not exists (select 1 from private.communications c where c.id = f.id)),
  array['CM-0A0B0C0D0E99', 'lead:retention-old', 'lead:retention-oldest', 'retention-idle'],
  'They are the leads received longest ago and the conversations idle longest');
select is((select count(*) from private.communication_messages m join retention_fixture f on f.id = m.communication_id where f.label in ('CM-0A0B0C0D0E99', 'retention-idle')),
  0::bigint, 'The deleted conversations'' messages went with them');
select ok(not exists (select 1 from private.communication_messages where position('RETENTION-CANARY' in body) > 0),
  'Nothing those visitors wrote is left');
select is((select l.communication_id from private.leads l join retention_fixture f on f.id = l.id where f.label = 'lead:CM-0A0B0C0D0E99'), null::uuid,
  'A recent lead that named a deleted conversation stays, without the link');
select is((select count(*) from private.communication_messages m join retention_fixture f on f.id = m.communication_id where f.label = 'retention-active'),
  2::bigint, 'Deleting a lead leaves its conversation, answered last month, with every message');

insert into retention_runs values (2, private.lead_retention_batch(2));
select is((select result from retention_runs where n = 2), '{"leads": 1, "conversations": 1, "more": false}'::jsonb,
  'The next batch takes what is a second past twelve months and says nothing more is due');
insert into retention_runs values (3, private.lead_retention_batch(500));
select is((select result from retention_runs where n = 3), '{"leads": 0, "conversations": 0, "more": false}'::jsonb, 'Then there is nothing to do');
select is((select array_agg(f.label order by f.label collate "C") from retention_fixture f
    where exists (select 1 from private.leads l where l.id = f.id) or exists (select 1 from private.communications c where c.id = f.id)),
  array['lead:CM-0A0B0C0D0E99', 'lead:retention-line', 'lead:retention-new', 'retention-active', 'retention-chat', 'retention-line', 'retention-mail',
    'retention-phone', 'retention-sms'],
  'Kept: leads received twelve months ago or less, the website conversations with a message in that time, and every other channel''s');
select ok(exists (select 1 from retention_fixture f join private.leads l on l.id = f.id where f.label = 'lead:retention-line')
    and exists (select 1 from retention_fixture f join private.communications c on c.id = f.id where f.label = 'retention-line')
    and not exists (select 1 from retention_fixture f where f.label in ('lead:retention-edge', 'retention-edge')
      and (exists (select 1 from private.leads l where l.id = f.id) or exists (select 1 from private.communications c where c.id = f.id))),
  'Twelve months to the second is kept and a second more is deleted');
select is((select array_agg(a.metadata order by a.id) from private.audit_events a where a.action = 'lead.retention' and a.id > (select id from retention_audit_floor)),
  array['{"leads": 2, "conversations": 2}'::jsonb, '{"leads": 1, "conversations": 1}'::jsonb],
  'Each batch that deleted something wrote one audit event with the two counts only; the empty one wrote none');
select ok((select bool_and(a.actor_id is null and a.entity_type = 'lead' and a.entity_id is null and a.product_id is null)
    from private.audit_events a where a.action = 'lead.retention' and a.id > (select id from retention_audit_floor)),
  'Those events name no actor, product or row');

select throws_ok($$select private.lead_retention_batch(0)$$, '22023', 'Choose a batch of 1 to 5,000 rows.', 'A batch of no rows is refused');
select throws_ok($$select private.lead_retention_batch(5001)$$, '22023', 'Choose a batch of 1 to 5,000 rows.', 'A batch of more than 5,000 rows is refused');
select throws_ok($$select private.lead_retention_batch(null)$$, '22023', 'Choose a batch of 1 to 5,000 rows.', 'A batch without a size is refused');

select * from finish();
rollback;
