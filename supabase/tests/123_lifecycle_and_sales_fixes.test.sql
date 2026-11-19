begin;
select plan(8);

-- Repairs from the 2026-11-18 audit (20261118210000_lifecycle_and_sales_fixes.sql).
select ok(not has_function_privilege('hub_app_server', 'private.agent_lifecycle_json(integer,text,text,integer)', 'execute')
  and not has_function_privilege('authenticated', 'private.agent_lifecycle_json(integer,text,text,integer)', 'execute')
  and not has_function_privilege('hub_app_server', 'private.sales_growth_context_read(uuid,uuid)', 'execute')
  and not has_function_privilege('hub_app_server', 'private.growth_strategy_facts_json(timestamptz,timestamptz)', 'execute'),
  'The internal helpers stay closed to every role');
select ok(has_function_privilege('hub_app_server', 'private.agent_lifecycle_begin_send(uuid,integer,text)', 'execute')
  and not has_function_privilege('authenticated', 'private.agent_lifecycle_begin_send(uuid,integer,text)', 'execute')
  and not has_function_privilege('service_role', 'private.agent_lifecycle_begin_send(uuid,integer,text)', 'execute'),
  'Only the Hub server begins a customer lifecycle email send');

-- 1. Internal and CareMetric/owner trials are omitted from Account Manager facts, send claims, and strategist noCard counts.
update private.hub_settings set value = '"owner@example.net"' where key = 'agents.owner_email';
insert into hub.tenants (id, slug, name) values
  ('12300000-0000-4000-8000-000000000001', 'audit-owner-trial', 'Owner Trial'),
  ('12300000-0000-4000-8000-000000000002', 'audit-caremetric-trial', 'CareMetric Trial'),
  ('12300000-0000-4000-8000-000000000003', 'audit-marked-internal', 'Marked Internal'),
  ('12300000-0000-4000-8000-000000000004', 'audit-external-trial', 'External Trial');
insert into private.billing_customers (tenant_id, stripe_customer_id, email, livemode, seen_at) values
  ('12300000-0000-4000-8000-000000000001', 'cus_audit123a', 'Owner@Example.net', true, now()),
  ('12300000-0000-4000-8000-000000000002', 'cus_audit123b', 'tester@caremetric.ai', true, now()),
  ('12300000-0000-4000-8000-000000000003', 'cus_audit123c', 'staff@external-test.example', true, now()),
  ('12300000-0000-4000-8000-000000000004', 'cus_audit123d', 'admin@real-agency.example', true, now());
insert into private.growth_organizations (id, name, domain, tenant_id, internal) values
  ('12300000-0000-4000-8000-000000000013', 'Marked Internal', 'external-test.example', '12300000-0000-4000-8000-000000000003', true);
insert into private.billing_subscriptions (stripe_subscription_id, tenant_id, stripe_customer_id, product_id, status, collection_method, livemode, stripe_created, seen_at, trial_start, trial_end)
select v.sub, v.tenant::uuid, v.cus, p.id, 'trialing', 'charge_automatically', true, now() - interval '2 days', now(), now() - interval '2 days', now() + interval '28 days'
  from (values
    ('sub_audit123a', '12300000-0000-4000-8000-000000000001', 'cus_audit123a'),
    ('sub_audit123b', '12300000-0000-4000-8000-000000000002', 'cus_audit123b'),
    ('sub_audit123c', '12300000-0000-4000-8000-000000000003', 'cus_audit123c'),
    ('sub_audit123d', '12300000-0000-4000-8000-000000000004', 'cus_audit123d')) v(sub, tenant, cus)
  join hub.products p on p.slug = 'caremetric-intel';

select is((private.agent_lifecycle_json(10, 'audit-owner-trial', 'caremetric-intel', 0) ->> 'total')::integer, 0,
  'An Intel sign-up from the owner''s address is omitted from Account Manager facts even without a growth_organizations row');
select is((private.agent_lifecycle_json(10, 'audit-caremetric-trial', 'caremetric-intel', 0) ->> 'total')::integer, 0,
  'An Intel sign-up from a CareMetric domain is omitted from Account Manager facts');
select is((private.agent_lifecycle_json(10, 'audit-marked-internal', 'caremetric-intel', 0) ->> 'total')::integer, 0,
  'An organization marked internal on Growth is omitted from Account Manager facts');
select is((private.agent_lifecycle_json(10, 'audit-external-trial', 'caremetric-intel', 0) ->> 'total')::integer, 1,
  'An external customer trial remains visible to the Account Manager');

-- Strategist noCard count leaves out the three internal sign-ups and counts only the external one.
select is((private.growth_strategy_facts_json(now() - interval '3 days', now()) #>> '{conversion,noCard}')::integer, 1,
  'The strategist counts only external sign-ups without a card');

-- 2. The Sales Executive's growth context includes a prospect in the 'trial' stage.
insert into private.growth_organizations (id, name, domain) values ('12300000-0000-4000-8000-000000000021', 'Trial Stage Agency', 'trial-stage.example.org');
insert into private.growth_opportunities (id, organization_id, product, stage, memory)
  values ('12300000-0000-4000-8000-000000000022', '12300000-0000-4000-8000-000000000021', 'caremetric-intel', 'trial', jsonb_build_object('reportViewedAt', now()::text));
insert into private.growth_contacts (id, organization_id, email, source_kind, eligibility)
  values ('12300000-0000-4000-8000-000000000023', '12300000-0000-4000-8000-000000000021', 'director@trial-stage.example.org', 'enriched', 'permitted');
insert into private.growth_briefs (opportunity_id, writer, research, model, prompt_version)
  values ('12300000-0000-4000-8000-000000000022',
    '{"summary":"A home health agency in its trial.","angle":"referral_growth","pains":[],"triggers":[]}', '{}', 'test', 'brief.test');
insert into private.communications (id, channel, source_system, source_key, subject, contact_email, product_id)
  values ('12300000-0000-4000-8000-000000000024', 'email', 'hub.email', 'test:trial-context', 'Re: Trial question', 'director@trial-stage.example.org',
    '00000000-0000-4000-8000-000000000006');
insert into private.communication_messages (id, communication_id, direction, body, delivery, provider_message_id)
  values ('12300000-0000-4000-8000-000000000025', '12300000-0000-4000-8000-000000000024', 'inbound', 'Can we walk through our county?', 'received', 'email:trial-context');

select is(private.sales_growth_context_read('12300000-0000-4000-8000-000000000024', '12300000-0000-4000-8000-000000000025') #>> '{brief,summary}',
  'A home health agency in its trial.',
  'A prospect in the trial stage carries its account brief into the Sales Executive context');

select * from finish();
rollback;
