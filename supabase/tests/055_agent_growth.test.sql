begin;
select plan(65);

-- ---------------------------------------------------------------------------------------
-- The boundary: six operations for the Hub server role, seven internal helpers for nobody.
-- ---------------------------------------------------------------------------------------
create temp table growth_operations(signature text) on commit drop;
insert into growth_operations values
  ('private.agent_growth_pending(integer,integer)'), ('private.agent_growth_lead(uuid)'), ('private.agent_growth_mark_seen(uuid[])'),
  ('private.agent_growth_unanswered(integer,integer)'), ('private.agent_growth_facts(timestamp with time zone,timestamp with time zone)'),
  ('private.agent_lead_probe_seen(text,timestamp with time zone)');
create temp table growth_helpers(signature text) on commit drop;
insert into growth_helpers values
  ('private.agent_growth_product(text)'), ('private.agent_growth_waiting()'), ('private.agent_growth_pending_json(integer,integer)'), ('private.agent_growth_lead_json(uuid)'),
  ('private.agent_growth_mark_seen_rows(uuid[])'), ('private.agent_growth_unanswered_json(integer,integer)'),
  ('private.agent_growth_facts_json(timestamp with time zone,timestamp with time zone)'), ('private.agent_growth_probe_seen(text,timestamp with time zone)');

select is((select count(*) from growth_operations o join pg_proc p on p.oid = to_regprocedure(o.signature)
  where p.prosecdef and p.proconfig @> array['search_path=""']), 6::bigint,
  'Every Growth Manager operation is a security definer with a pinned empty search path');
select is((select count(*) from growth_operations o where position('private.require_hub_app_server()' in pg_get_functiondef(to_regprocedure(o.signature))) > 0), 6::bigint,
  'Every operation refuses every session user but the Hub server');
select ok((select bool_and(has_function_privilege('hub_app_server', signature, 'execute')) from growth_operations),
  'The Hub server role executes every operation');
select ok(not (select bool_or(has_function_privilege(role_name, o.signature, 'execute')) from growth_operations o
  cross join unnest(array['public', 'anon', 'authenticated', 'service_role']) as role_name),
  'No browser, service or public role executes an operation');
select is((select count(*) from growth_helpers h join pg_proc p on p.oid = to_regprocedure(h.signature)
  where not p.prosecdef and p.proconfig @> array['search_path=""']), 8::bigint,
  'Every helper pins an empty search path and runs as its caller');
select ok(not (select bool_or(has_function_privilege(role_name, h.signature, 'execute')) from growth_helpers h
  cross join unnest(array['public', 'anon', 'authenticated', 'service_role', 'hub_app_server']) as role_name),
  'No role at all, the Hub server included, executes a helper directly');

select throws_ok('select private.agent_growth_pending(10, 24)', '42501', 'Application server required.', 'Pending leads refuse any session user but the Hub server');
select throws_ok('select private.agent_growth_lead(gen_random_uuid())', '42501', 'Application server required.', 'A lead refuses any session user but the Hub server');
select throws_ok('select private.agent_growth_mark_seen(array[]::uuid[])', '42501', 'Application server required.', 'Marking refuses any session user but the Hub server');
select throws_ok('select private.agent_growth_unanswered(60, 10)', '42501', 'Application server required.', 'Unanswered leads refuse any session user but the Hub server');
select throws_ok($$select private.agent_growth_facts(now() - interval '1 day', now())$$, '42501', 'Application server required.', 'The facts refuse any session user but the Hub server');
select throws_ok($$select private.agent_lead_probe_seen('carebase', now())$$, '42501', 'Application server required.', 'The probe check refuses any session user but the Hub server');

set local role authenticated;
select throws_ok('select private.agent_growth_pending(10, 24)', '42501', 'permission denied for function agent_growth_pending', 'Signed-in users cannot list leads through the agent');
select throws_ok('select * from private.agent_growth_waiting()', '42501', null, 'Signed-in users cannot run a helper');
reset role;
set local role anon;
select throws_ok($$select private.agent_growth_facts(now() - interval '1 day', now())$$, '42501', null, 'Anonymous callers cannot read the facts');
reset role;

select ok(hub.get_backend_contract() -> 'features' @> '["platform.agents.growth.v1"]'::jsonb, 'The Growth Manager is declared in release metadata');
select ok(exists (select 1 from pg_attribute where attrelid = 'private.leads'::regclass and attname = 'growth_seen_at' and not attisdropped),
  'Leads record when the Growth Manager saw them');
select ok(not (select bool_or(has_table_privilege(role_name, 'private.leads', 'SELECT,INSERT,UPDATE,DELETE')) from unnest(array['anon', 'authenticated', 'service_role', 'hub_app_server']) as role_name),
  'The leads table stays closed to every role');
select ok(position('''sourceSystem''' in pg_get_functiondef('private.agent_communication_snapshot(uuid,uuid,integer,integer)'::regprocedure)) > 0
  and position('private.require_hub_app_server()' in pg_get_functiondef('private.agent_communication_snapshot(uuid,uuid,integer,integer)'::regprocedure)) > 0,
  'The Concierge''s snapshot names the system a conversation came from, and still only for the Hub server');

-- The agent and its schedules.
select ok((select count(*) = 1 from private.agents where key = 'growth_manager' and display_name = 'Growth Manager' and status = 'paused' and autonomy = 'observe'
    and model_tier = 'fast' and daily_budget_cents = 50 and tool_allowlist = array['notify_owner']),
  'The Growth Manager is seeded paused and observe-only, on the fast tier with a 50 cent budget and one tool');
select is((select config from private.agents where key = 'growth_manager'),
  '{"followup_minutes": [60, 1440], "quiet_hours": {"start": "21:00", "end": "07:00", "timezone": "America/New_York"}}'::jsonb,
  'Its settings: reminders after an hour and a day, quiet from 21:00 to 07:00 Eastern');
select ok(char_length((select role_summary from private.agents where key = 'growth_manager')) between 50 and 400, 'Its role is described in plain words that fit the Team screen');
select is((select jsonb_object_agg(task_kind, jsonb_build_array(cadence, every_seconds, at_local::text, timezone, requires_session)) from private.agent_schedules where agent_key = 'growth_manager'),
  '{"growth.leads": ["interval", 300, null, "America/New_York", false], "growth.followup": ["interval", 900, null, "America/New_York", false], "growth.weekly": ["daily", null, "07:30:00", "America/New_York", false]}'::jsonb,
  'New leads every five minutes, reminders every fifteen, the weekly report each morning at 07:30 Eastern, none needing the owner''s session');
select ok((select count(*) = 1 from private.agent_schedules where agent_key = 'platform_engineer' and task_kind = 'probe.forms' and cadence = 'interval' and every_seconds = 21600 and not requires_session),
  'The Platform Engineer checks the lead forms every six hours');

-- ---------------------------------------------------------------------------------------
-- Fixtures, through the lead desk's own intake (private.lead_record), then aged by hand.
-- ---------------------------------------------------------------------------------------
create temp table lead_ids(name text primary key, id uuid, conversation uuid) on commit drop;
create function pg_temp.lead(p_name text, p_source text, p_kind text, p_external text, p_extra jsonb default '{}'::jsonb) returns uuid
language plpgsql as $$
declare v jsonb;
begin
  v := private.lead_record(p_source, jsonb_build_object('version', 1, 'source', p_source, 'kind', p_kind, 'externalId', p_external,
    'occurredAt', to_jsonb(now()), 'contact', jsonb_build_object('name', 'Canary Contact Name', 'email', 'canary.visitor@example.test', 'phone', '+12025550123', 'role', 'Canary Role')) || p_extra);
  insert into lead_ids values (p_name, (v ->> 'id')::uuid, (select communication_id from private.leads where id = (v ->> 'id')::uuid));
  return (v ->> 'id')::uuid;
end;
$$;
create function pg_temp.id(p_name text) returns uuid language sql as $$ select id from lead_ids where name = p_name $$;
create function pg_temp.aged(p_name text, p_age interval) returns void language sql as $$
  update private.leads set received_at = now() - p_age where id = (select id from lead_ids where name = p_name);
  update private.communication_messages set created_at = now() - p_age where communication_id = (select conversation from lead_ids where name = p_name);
$$;

do $$
begin
  perform pg_temp.lead('demo', 'carebase', 'demo_request', 'growth-test-demo', jsonb_build_object('message', 'CANARY message text',
    'attribution', jsonb_build_object('utmSource', 'Google', 'utmMedium', 'cpc', 'utmCampaign', 'fall-launch', 'referrerHost', 'www.google.com', 'landingPath', '/pricing')));
  perform pg_temp.lead('trial', 'intel', 'trial_signup', 'growth-test-trial', jsonb_build_object('contact', jsonb_build_object('email', 'canary.trial@example.test', 'organization', 'Trial Org'),
    'details', jsonb_build_object('plan', 'complete', 'facilityCount', 3, 'a1', 'x', 'a2', 'x', 'a3', 'x', 'a4', repeat('y', 150), 'z9', 'last'),
    'attribution', jsonb_build_object('referrerHost', 'news.example.com', 'landingPath', '/pricing')));
  perform pg_temp.lead('newsletter', 'carebase', 'newsletter', 'growth-test-news');
  perform pg_temp.lead('contact', 'intel', 'contact', 'growth-test-contact', jsonb_build_object('attribution', jsonb_build_object('utmSource', 'google', 'utmCampaign', 'fall-launch')));
  perform pg_temp.lead('probe', 'carebase', 'demo_request', 'probe-1700000000', jsonb_build_object('test', true));
  perform pg_temp.lead('consult', 'advisors', 'consultation', 'CM-ABCDEF012345');
  perform pg_temp.lead('old', 'carebase', 'demo_request', 'growth-test-old');
  perform pg_temp.aged('demo', interval '3 hours');
  perform pg_temp.aged('contact', interval '30 minutes');
  perform pg_temp.aged('consult', interval '2 hours');
  perform pg_temp.aged('old', interval '3 days');
  perform pg_temp.aged('trial', interval '1 hour');
end $$;
-- The consultation was answered 45 minutes after it arrived.
insert into private.communication_messages (communication_id, direction, body, delivery, delivery_channel, created_at)
  select conversation, 'outbound', 'Thanks, happy to help.', 'sent', 'email', now() - interval '75 minutes' from lead_ids where name = 'consult';

-- ---------------------------------------------------------------------------------------
-- Pending: new leads that are not tests, oldest first, ids and enums only.
-- ---------------------------------------------------------------------------------------
create temp table pending as select private.agent_growth_pending_json(50, 24) as j;
select is((select array_agg(e ->> 'kind' order by ord) from pending, jsonb_array_elements(j) with ordinality as x(e, ord) where (e ->> 'id')::uuid in (select id from lead_ids)),
  array['demo_request', 'consultation', 'trial_signup', 'contact', 'newsletter'], 'Pending leads come oldest first, from the last day, never a test or an older lead');
select is((select array_agg(distinct k order by k) from pending, jsonb_array_elements(j) e, jsonb_object_keys(e) k), array['id', 'kind', 'source'],
  'A pending lead is an id, a kind and a product, nothing more');
select is(jsonb_array_length(private.agent_growth_pending_json(2, 24)), 2, 'The list stops at its limit');
select is((select count(*)::int from jsonb_array_elements(private.agent_growth_pending_json(100, 96)) e where (e ->> 'id')::uuid in (select id from lead_ids)), 6,
  'A wider window reaches the older lead, never the test');

-- Seeing: marked once, and the owner's version of the lead is untouched.
create temp table before_seen as select id, updated_at from private.leads where id in (pg_temp.id('demo'), pg_temp.id('trial'));
select is(private.agent_growth_mark_seen_rows(array[pg_temp.id('demo'), pg_temp.id('trial')]), 2, 'Marking reports how many leads were newly seen');
select is(private.agent_growth_mark_seen_rows(array[pg_temp.id('demo'), pg_temp.id('trial')]), 0, 'Marking again changes nothing');
select is(private.agent_growth_mark_seen_rows(array[]::uuid[]), 0, 'An empty list marks nothing');
select ok((select bool_and(l.updated_at = b.updated_at) from private.leads l join before_seen b using (id)),
  'Seeing a lead never changes its version, so the owner''s Leads screen is never refused because of it');
select is((select array_agg(e ->> 'kind' order by ord) from jsonb_array_elements(private.agent_growth_pending_json(100, 24)) with ordinality as x(e, ord) where (e ->> 'id')::uuid in (select id from lead_ids)),
  array['consultation', 'contact', 'newsletter'], 'A seen lead is no longer pending');

-- ---------------------------------------------------------------------------------------
-- One lead, as an alert may name it.
-- ---------------------------------------------------------------------------------------
create temp table one_trial as select private.agent_growth_lead_json(pg_temp.id('trial')) as j;
select is((select j - 'id' - 'receivedAt' from one_trial),
  '{"kind": "trial_signup", "source": "intel", "test": false, "productSlug": "caremetric-intel", "organization": "Trial Org", "reference": null,
    "details": {"a1": "x", "a2": "x", "a3": "x", "a4": "yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy", "facilityCount": 3, "plan": "complete"},
    "attribution": {"source": "news.example.com", "medium": null, "campaign": null, "landingPath": "/pricing"}}'::jsonb,
  'A lead carries its kind, product, organization, the first six facts (clipped) and where the visitor came from');
select ok((select j::text !~ 'canary|Canary|2025550123|CANARY' from one_trial) and (select j::text !~ 'canary|Canary|2025550123|CANARY' from (select private.agent_growth_lead_json(pg_temp.id('demo')) as j) d),
  'Never the contact''s name, address, phone number or role, nor the message');
select is((select (j -> 'attribution' ->> 'source') || ' ' || (j ->> 'reference' ~ '^CM-[0-9]+$')::text from (select private.agent_growth_lead_json(pg_temp.id('demo')) as j) d),
  'google true', 'A source label is lowercased, and a lead with a conversation names its reference');
select is(private.agent_growth_lead_json(pg_temp.id('newsletter')) -> 'attribution' ->> 'source', 'direct', 'A lead with no source is a direct visit');
select is(private.agent_growth_lead_json(gen_random_uuid()), null, 'An unknown lead is null');

-- ---------------------------------------------------------------------------------------
-- Unanswered: lead conversations nobody has answered, most recent first.
-- ---------------------------------------------------------------------------------------
select is((select array_agg(e ->> 'kind' || ':' || (e ->> 'minutesWaiting') order by ord) from jsonb_array_elements(private.agent_growth_unanswered_json(60, 100)) with ordinality as x(e, ord) where (e ->> 'leadId')::uuid in (select id from lead_ids)),
  array['demo_request:180', 'demo_request:4320'], 'Past an hour: the demo request and the older one, never the answered consultation, the newer contact or a test');
select is((select array_agg(e ->> 'kind' order by ord) from jsonb_array_elements(private.agent_growth_unanswered_json(1, 100)) with ordinality as x(e, ord) where (e ->> 'leadId')::uuid in (select id from lead_ids)),
  array['contact', 'demo_request', 'demo_request'], 'Past a minute: the contact request too, the most recent first');
select is(jsonb_array_length(private.agent_growth_unanswered_json(1, 1)), 1, 'The list stops at its limit');
select is((select array_agg(distinct k order by k) from jsonb_array_elements(private.agent_growth_unanswered_json(1, 50)) e, jsonb_object_keys(e) k),
  array['kind', 'leadId', 'minutesWaiting', 'product', 'reference'], 'An unanswered lead is its id, kind, product, reference and wait');
select is((select e ->> 'product' from jsonb_array_elements(private.agent_growth_unanswered_json(1, 50)) e where e ->> 'kind' = 'contact'), 'caremetric-intel',
  'The product is the registered product');
select is((select (e ->> 'reference') = 'CM-' || c.reference from jsonb_array_elements(private.agent_growth_unanswered_json(60, 50)) e
  join private.leads l on l.id = (e ->> 'leadId')::uuid join private.communications c on c.id = l.communication_id where l.id = pg_temp.id('demo')), true,
  'The reference is the conversation''s');

-- A note counts as handled; so does a lead the owner moved along, and a closed conversation.
insert into private.communication_messages (communication_id, direction, body, delivery, created_at)
  select conversation, 'note', 'Called them.', 'recorded', now() from lead_ids where name = 'old';
update private.leads set status = 'contacted' where id = pg_temp.id('contact');
select is((select array_agg(e ->> 'kind' order by ord) from jsonb_array_elements(private.agent_growth_unanswered_json(1, 100)) with ordinality as x(e, ord) where (e ->> 'leadId')::uuid in (select id from lead_ids)),
  array['demo_request'], 'An internal note after the message, or a lead marked contacted, is no longer waiting');
update private.communications set status = 'closed' where id = (select conversation from lead_ids where name = 'demo');
select is((select count(*)::int from jsonb_array_elements(private.agent_growth_unanswered_json(1, 100)) e where (e ->> 'leadId')::uuid in (select id from lead_ids)), 0,
  'A closed conversation is no longer waiting');
update private.communications set status = 'open' where id = (select conversation from lead_ids where name = 'demo');
update private.leads set status = 'new' where id = pg_temp.id('contact');
-- A reply written before the visitor's message does not answer it.
insert into private.communication_messages (communication_id, direction, body, delivery, delivery_channel, created_at)
  select conversation, 'outbound', 'Earlier message.', 'sent', 'email', now() - interval '5 hours' from lead_ids where name = 'demo';
select is((select count(*)::int from jsonb_array_elements(private.agent_growth_unanswered_json(60, 100)) e where (e ->> 'leadId')::uuid in (select id from lead_ids)), 1,
  'Only a reply after the lead''s first message counts as an answer');

-- ---------------------------------------------------------------------------------------
-- Facts for the reports: counts only, test leads never among them.
-- ---------------------------------------------------------------------------------------
insert into hub.tenants(id, slug, name, status) values ('97540000-0000-4000-8000-000000000010', 'growth-trials', 'Growth Trials', 'active');
insert into private.billing_customers(tenant_id, stripe_customer_id, email, name, livemode, seen_at)
  values ('97540000-0000-4000-8000-000000000010', 'cus_growthTrials1', '', '', true, now());
insert into private.billing_subscriptions(stripe_subscription_id, tenant_id, stripe_customer_id, status, collection_method, trial_start, trial_end, livemode, stripe_created, seen_at) values
  ('sub_growthTrialNew', '97540000-0000-4000-8000-000000000010', 'cus_growthTrials1', 'trialing', 'charge_automatically', now() - interval '2 days', now() + interval '12 days', true, now() - interval '2 days', now()),
  ('sub_growthConverted', '97540000-0000-4000-8000-000000000010', 'cus_growthTrials1', 'active', 'charge_automatically', now() - interval '20 days', now() - interval '1 day', true, now() - interval '20 days', now()),
  ('sub_growthLapsed', '97540000-0000-4000-8000-000000000010', 'cus_growthTrials1', 'canceled', 'charge_automatically', now() - interval '20 days', now() - interval '2 days', true, now() - interval '20 days', now()),
  ('sub_growthTestMode', '97540000-0000-4000-8000-000000000010', 'cus_growthTrials1', 'active', 'charge_automatically', now() - interval '3 days', now() - interval '1 day', false, now() - interval '3 days', now()),
  ('sub_growthOldTrial', '97540000-0000-4000-8000-000000000010', 'cus_growthTrials1', 'trialing', 'charge_automatically', now() - interval '30 days', now() + interval '1 day', true, now() - interval '30 days', now());

create temp table facts as select private.agent_growth_facts_json(now() - interval '7 days', now() + interval '1 minute') as j;
-- Leads from earlier runs or other suites may share the window: compare with what the fixtures alone add.
create temp table mine as select l.* from private.leads l where l.id in (select id from lead_ids);
select is((select (j -> 'leads' ->> 'total')::int from facts) - (select count(*)::int from private.leads where not test and received_at >= now() - interval '7 days' and id not in (select id from lead_ids)),
  6, 'Six leads in the week: every fixture but the test');
select is((select j -> 'leads' -> 'byKind' from facts) - 'demo_request' - 'trial_signup' - 'consultation' - 'contact' - 'newsletter' - 'savings_model' - 'county_report', '{}'::jsonb,
  'Every kind is counted, and only the kinds there are');
select ok((select (j -> 'leads' -> 'byKind' ->> 'demo_request')::int >= 2 and (j -> 'leads' -> 'byKind' ->> 'trial_signup')::int >= 1 from facts),
  'Two demo requests (the test is not one) and a trial');
select ok((select exists (select 1 from jsonb_array_elements(j -> 'leads' -> 'bySource') e where e ->> 'source' = 'google' and (e ->> 'count')::int >= 2)
    and exists (select 1 from jsonb_array_elements(j -> 'leads' -> 'bySource') e where e ->> 'source' = 'news.example.com')
    and exists (select 1 from jsonb_array_elements(j -> 'leads' -> 'bySource') e where e ->> 'source' = 'direct') from facts),
  'Sources are utm_source, else the referring host, else direct, without case');
select ok((select exists (select 1 from jsonb_array_elements(j -> 'leads' -> 'campaigns') e where e ->> 'campaign' = 'fall-launch' and (e ->> 'count')::int >= 2)
    and exists (select 1 from jsonb_array_elements(j -> 'leads' -> 'landingPaths') e where e ->> 'path' = '/pricing' and (e ->> 'count')::int >= 2)
    and jsonb_array_length(j -> 'leads' -> 'campaigns') <= 5 and jsonb_array_length(j -> 'leads' -> 'landingPaths') <= 5 from facts),
  'The top five campaigns and landing pages, with their counts');
select ok((select exists (select 1 from jsonb_array_elements(j -> 'leads' -> 'byProduct') e where e ->> 'product' = 'caremetric-intel') from facts),
  'Products are the registered products');
select is((select j -> 'trials' from facts) - 'started', '{"subscriptions": 1, "converted": 1}'::jsonb,
  'One live trial began in the week and one converted; a test-mode, cancelled or older trial does not count');
select ok((select (j -> 'trials' ->> 'started')::int >= 1 from facts), 'Trial sign-ups are counted');
select ok((select (j -> 'replies' ->> 'replied')::int >= 1 and (j -> 'replies' ->> 'medianMinutes') is not null from facts), 'The first replies are measured');
select is((private.agent_growth_facts_json(now() - interval '150 minutes', now() - interval '90 minutes') -> 'replies'), '{"replied": 1, "medianMinutes": 45}'::jsonb,
  'The consultation''s first reply took 45 minutes');
select ok((select (j -> 'unanswered' ->> 'count')::int >= 2 and (j -> 'unanswered' ->> 'oldestMinutes')::int >= 180
    and (j -> 'unanswered' -> 'byKind' ->> 'demo_request')::int >= 1 from facts),
  'What is unanswered now is counted, with the oldest wait and the kinds');
select ok((select j::text !~ 'canary|Canary|2025550123|CANARY|Trial Org' from facts), 'The facts hold no contact detail, message or organization');
select is((private.agent_growth_facts_json(now() + interval '1 day', now() + interval '2 days') -> 'leads' ->> 'total'), '0', 'A window with no leads counts none');
select is((private.agent_growth_facts_json(now() + interval '1 day', now() + interval '2 days') -> 'replies' ->> 'medianMinutes'), null, 'And has no median');

-- ---------------------------------------------------------------------------------------
-- The end of a lead form check.
-- ---------------------------------------------------------------------------------------
select ok(private.agent_growth_probe_seen('carebase', now() - interval '10 minutes'), 'A test lead from CareBase arrived in the last ten minutes');
select ok(not private.agent_growth_probe_seen('intel', now() - interval '10 minutes'), 'None from Intel');
select ok(not private.agent_growth_probe_seen('carebase', now() + interval '1 minute'), 'And nothing arrived after now');
select ok(not exists (select 1 from jsonb_array_elements(private.agent_growth_pending_json(100, 720)) e where (e ->> 'id')::uuid = pg_temp.id('probe'))
  and not exists (select 1 from jsonb_array_elements(private.agent_growth_unanswered_json(1, 100)) e where (e ->> 'leadId')::uuid = pg_temp.id('probe')),
  'A test lead is never pending and never chased');

select * from finish();
rollback;
