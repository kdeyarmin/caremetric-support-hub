begin;
select plan(17);

select ok(not exists (select 1 from unnest(array['anon', 'authenticated', 'service_role', 'hub_app_server']) r
                      where has_function_privilege(r, 'private.growth_ensure_customer(uuid,text)', 'execute')),
  'No role may call customer linking directly');

-- Fixtures: four prospects (two with a contact and an Intel opportunity), and one tenant per case.
insert into private.growth_organizations (id, name, domain) values
  ('a0000000-0000-4000-8000-000000000001', 'Alpha Home Care', 'alpha-trial-link.example'),
  ('a0000000-0000-4000-8000-000000000002', 'Beta Hospice', 'beta-trial-link.example'),
  ('a0000000-0000-4000-8000-000000000003', 'Gamma Agency', 'gamma-trial-link.example'),
  ('a0000000-0000-4000-8000-000000000004', 'Delta Care', 'delta-trial-link.example');
update private.growth_organizations set internal = true where id = 'a0000000-0000-4000-8000-000000000003';
insert into private.growth_contacts (id, organization_id, email, eligibility) values
  ('c0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'owner@alpha-trial-link.example', 'permitted'),
  ('c0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000002', 'info@beta-trial-link.example', 'permitted');
insert into private.growth_opportunities (id, organization_id, product, contact_id, stage) values
  ('b0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'caremetric-intel', 'c0000000-0000-4000-8000-000000000001', 'contacted'),
  ('b0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000002', 'caremetric-intel', 'c0000000-0000-4000-8000-000000000002', 'contacted'),
  ('b0000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000002', 'carebase', 'c0000000-0000-4000-8000-000000000002', 'qualified');
insert into hub.tenants (id, slug, name) values
  ('d0000000-0000-4000-8000-000000000001', 'trial-link-alpha', 'Alpha Home Care'),
  ('d0000000-0000-4000-8000-000000000002', 'trial-link-beta', 'Beta Hospice'),
  ('d0000000-0000-4000-8000-000000000003', 'trial-link-gamma', 'Gamma Agency'),
  ('d0000000-0000-4000-8000-000000000004', 'trial-link-personal', 'Personal Agency'),
  ('d0000000-0000-4000-8000-000000000005', 'trial-link-test', 'Test Agency');
insert into private.billing_customers (tenant_id, stripe_customer_id, email, livemode, seen_at) values
  ('d0000000-0000-4000-8000-000000000001', 'cus_triallinkalpha', ' Owner@Alpha-Trial-Link.example ', true, now()),
  ('d0000000-0000-4000-8000-000000000002', 'cus_triallinkbeta', 'director@beta-trial-link.example', true, now()),
  ('d0000000-0000-4000-8000-000000000003', 'cus_triallinkgamma', 'x@gamma-trial-link.example', true, now()),
  ('d0000000-0000-4000-8000-000000000004', 'cus_triallinkpersonal', 'agency.owner@gmail.com', true, now()),
  ('d0000000-0000-4000-8000-000000000005', 'cus_triallinktest', 'owner@delta-trial-link.example', false, now());

-- The sign-up address is a contact's: that prospect becomes the customer's organization.
select is(private.growth_ensure_customer('d0000000-0000-4000-8000-000000000001', 'caremetric-intel'),
  'a0000000-0000-4000-8000-000000000001'::uuid, 'A trial from a contact''s address keeps the prospect''s organization');
select is((select tenant_id from private.growth_organizations where id = 'a0000000-0000-4000-8000-000000000001'),
  'd0000000-0000-4000-8000-000000000001'::uuid, 'The prospect is now the tenant''s organization');
select results_eq($$select owner_agent, stage, contact_id from private.growth_opportunities where id = 'b0000000-0000-4000-8000-000000000001'$$,
  $$values ('account_manager'::text, 'nurture'::text, 'c0000000-0000-4000-8000-000000000001'::uuid)$$,
  'The Account Manager takes the opportunity, with the contact who signed up');
select is((select metadata from private.audit_events where action = 'growth.customer_linked' and entity_id = 'a0000000-0000-4000-8000-000000000001'),
  '{"match": "contact", "product": "caremetric-intel"}'::jsonb, 'The link is audited without the address');
select is(private.growth_ensure_customer('d0000000-0000-4000-8000-000000000001', 'carebase'),
  'a0000000-0000-4000-8000-000000000001'::uuid, 'The other product joins the same organization');

-- A colleague at the same business domain: linked, and the colleague is the contact, for review.
select is(private.growth_ensure_customer('d0000000-0000-4000-8000-000000000002', 'caremetric-intel'),
  'a0000000-0000-4000-8000-000000000002'::uuid, 'A trial from the prospect''s business domain keeps its organization');
select results_eq($$select organization_id, eligibility from private.growth_contacts where email = 'director@beta-trial-link.example'$$,
  $$values ('a0000000-0000-4000-8000-000000000002'::uuid, 'review'::text)$$, 'The person who signed up joins for review');
select is((select contact_id from private.growth_opportunities where id = 'b0000000-0000-4000-8000-000000000002'),
  (select id from private.growth_contacts where email = 'director@beta-trial-link.example'),
  'Customer email goes to the person who signed up, not the person cold-emailed');
select is((select metadata->>'match' from private.audit_events where action = 'growth.customer_linked' and entity_id = 'a0000000-0000-4000-8000-000000000002'),
  'domain', 'A domain link is audited as such');
select is(private.growth_ensure_customer('d0000000-0000-4000-8000-000000000002', 'carebase'),
  'a0000000-0000-4000-8000-000000000002'::uuid, 'A later signal for the other product finds the linked organization');

-- The other product, handed over by a later signal, gets the same contact: the person who signed up.
select is((select contact_id from private.growth_opportunities where id = 'b0000000-0000-4000-8000-000000000003'),
  (select id from private.growth_contacts where email = 'director@beta-trial-link.example'),
  'The other product''s opportunity also goes to the person who signed up when it is handed over');

-- No link: an internal organization, a personal mail domain, a test-mode customer. (Each placeholder is made in its own statement:
-- a statement does not see rows its own function call inserted.)
do $$ begin
  perform private.growth_ensure_customer('d0000000-0000-4000-8000-000000000003', 'caremetric-intel');
  perform private.growth_ensure_customer('d0000000-0000-4000-8000-000000000004', 'caremetric-intel');
  perform private.growth_ensure_customer('d0000000-0000-4000-8000-000000000005', 'caremetric-intel');
end $$;
select matches((select domain from private.growth_organizations where tenant_id = 'd0000000-0000-4000-8000-000000000003'),
  '^customer-.*\.invalid$', 'An internal organization is never linked');
select matches((select domain from private.growth_organizations where tenant_id = 'd0000000-0000-4000-8000-000000000004'),
  '^customer-.*\.invalid$', 'A personal mail domain never links a business');
select matches((select domain from private.growth_organizations where tenant_id = 'd0000000-0000-4000-8000-000000000005'),
  '^customer-.*\.invalid$', 'A test-mode billing customer never links');
select ok(position('growth.customer_linked' in pg_get_functiondef('private.growth_ensure_customer(uuid,text)'::regprocedure)) > 0,
  'Customer linking is in place');
select ok(position('tenant_id is null and not internal' in pg_get_functiondef('private.growth_discover(text,jsonb)'::regprocedure)) > 0
  and has_function_privilege('hub_app_server', 'private.growth_discover(text,jsonb)', 'execute')
  and not has_function_privilege('authenticated', 'private.growth_discover(text,jsonb)', 'execute'),
  'Discovery never prospects a customer''s organization, and keeps its grants');

select * from finish();
rollback;
