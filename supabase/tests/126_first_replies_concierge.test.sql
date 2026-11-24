begin;
select plan(12);

-- The Support Concierge answers a message that names no product (20261124151000_first_replies_concierge.sql, the Nov 24 follow-up).
select ok(not exists (select 1 from unnest(array['anon', 'authenticated', 'service_role', 'hub_app_server']) r
                      where has_function_privilege(r, 'private.communication_sender_product(text)', 'execute')),
  'The sender''s product is internal to the inbound message function and the Concierge''s snapshot');
select ok(has_function_privilege('hub_app_server', 'private.ingest_inbound_communication(text,text,text,bigint,text,text,text,text,text,text)', 'execute')
  and not has_function_privilege('authenticated', 'private.ingest_inbound_communication(text,text,text,bigint,text,text,text,text,text,text)', 'execute'),
  'The inbound message function keeps its grants');

-- Fixtures: a CareBase customer, a website lead about Intel, a test lead, someone who asked about two products, and a roster prospect.
insert into hub.tenants (id, slug, name) values ('01260000-0000-4000-8000-000000000001', 'first-replies-126', 'Synthetic Care Home');
insert into private.billing_customers (tenant_id, stripe_customer_id, email, livemode, seen_at) values
  ('01260000-0000-4000-8000-000000000001', 'cus_firstreplies126', ' Owner@Customer-126.example ', true, now());
insert into private.billing_subscriptions (stripe_subscription_id, tenant_id, stripe_customer_id, product_id, status, collection_method,
    cancel_at_period_end, trial_start, trial_end, livemode, stripe_created, seen_at)
  select 'sub_firstreplies126', '01260000-0000-4000-8000-000000000001', 'cus_firstreplies126', p.id, 'trialing', 'charge_automatically', false,
    now() - interval '1 day', now() + interval '29 days', true, now() - interval '1 day', now()
  from hub.products p where p.slug = 'carebase';
insert into private.leads (kind, source, external_id, status, test, occurred_at, received_at, contact_email, product_id)
  select 'contact', 'intel', x.ext, 'new', x.test, now(), now(), x.email, p.id
  from (values ('fr126-intel', false, 'pat@lead-126.example', 'caremetric-intel'), ('fr126-test', true, 'qa@test-126.example', 'caremetric-intel'),
               ('fr126-two-a', false, 'both@lead-126.example', 'caremetric-intel'), ('fr126-two-b', false, 'both@lead-126.example', 'carebase')) x(ext, test, email, slug)
  join hub.products p on p.slug = x.slug;
insert into private.growth_organizations (id, name, domain) values ('01260000-0000-4000-8000-000000000002', 'Synthetic Hospice', 'prospect-126.example');
insert into private.growth_contacts (id, organization_id, email, eligibility) values
  ('01260000-0000-4000-8000-000000000003', '01260000-0000-4000-8000-000000000002', 'info@prospect-126.example', 'permitted');
insert into private.growth_opportunities (id, organization_id, product, contact_id, stage) values
  ('01260000-0000-4000-8000-000000000004', '01260000-0000-4000-8000-000000000002', 'caremetric-intel', '01260000-0000-4000-8000-000000000003', 'contacted');

select is(private.communication_sender_product('owner@customer-126.example'), (select id from hub.products where slug = 'carebase'),
  'A customer writes about the product of their account');
select is(private.communication_sender_product(' PAT@lead-126.example'), (select id from hub.products where slug = 'caremetric-intel'),
  'Someone who asked on a website writes about the product they asked about');
select is(private.communication_sender_product('info@prospect-126.example'), (select id from hub.products where slug = 'caremetric-intel'),
  'A prospect answering a cold email writes about the product of the outreach');
select is(private.communication_sender_product('both@lead-126.example'), null::uuid, 'Two products is nobody can tell, never a guess');
select is(private.communication_sender_product('qa@test-126.example'), null::uuid, 'A test lead says nothing');
select is(private.communication_sender_product('stranger@unknown-126.example'), null::uuid, 'A stranger has no product');

-- A new conversation takes the sender's product when its address named none, and the address's product when it did. (Each is created
-- first: a conversation inserted while a statement scans the table is not visible to that scan.)
create temp table fr126 on commit drop as
select private.ingest_inbound_communication('email', '<fr126-1@mail.example>', '<fr126-1@mail.example>', null, null, 'A question',
         'How do I export a report?', 'Pat Example', 'pat@lead-126.example', null) as unnamed,
       null::jsonb as named;
update fr126 set named = private.ingest_inbound_communication('email', '<fr126-2@mail.example>', '<fr126-2@mail.example>', null, 'carebase',
         'A question', 'How do I export a report?', 'Pat Example', 'pat@lead-126.example', null);
select is((select c.product_id from private.communications c where c.id = (select (unnamed ->> 'id')::uuid from fr126)),
  (select id from hub.products where slug = 'caremetric-intel'), 'An email from a known sender takes their product');
select is((select c.product_id from private.communications c where c.id = (select (named ->> 'id')::uuid from fr126)),
  (select id from hub.products where slug = 'carebase'), 'A "+product" address still decides');

-- The Concierge's snapshot names the sender's product for a conversation without one.
insert into private.communications (id, channel, source_system, source_key, subject, contact_email)
values ('01260000-0000-4000-8000-000000000005', 'email', 'hub.email', 'fr126-old', 'A question', 'info@prospect-126.example');
insert into private.communication_messages (communication_id, direction, body, delivery)
values ('01260000-0000-4000-8000-000000000005', 'inbound', 'Do you cover Erie County?', 'received');
create or replace function private.require_hub_app_server() returns void language plpgsql stable set search_path = '' as $$ begin return; end; $$;
select is(private.agent_communication_snapshot('01260000-0000-4000-8000-000000000005', null, 0, 100) ->> 'senderProduct', 'caremetric-intel',
  'A conversation opened without a product reads the sender''s');
update private.communications set product_id = (select id from hub.products where slug = 'carebase') where id = '01260000-0000-4000-8000-000000000005';
select ok((private.agent_communication_snapshot('01260000-0000-4000-8000-000000000005', null, 0, 100) ->> 'senderProduct') is null,
  'A conversation with its own product reads no other');

select * from finish();
rollback;
