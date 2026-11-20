-- Customer invitations (20261120120000_customer_invitations.sql): closed to every role, run by the Hub server only; an invitation names one
-- published plan price of its application, accepting it makes its own tenant, an application sign-up with its code is linked to that tenant
-- instead of starting a trial, a sign-up whose email matches an activated invitation is held for the owner, and only an unpaid
-- invitation can be revoked.
begin;
select plan(34);

select ok((select relrowsecurity from pg_class where oid = 'private.customer_invitations'::regclass), 'The invitations table has row-level security');
select ok(not has_table_privilege(r, 'private.customer_invitations', 'select, insert, update, delete'), 'The invitations table is closed to ' || r)
  from unnest(array['anon', 'authenticated', 'service_role', 'hub_app_server']) r;
select ok(has_function_privilege('hub_app_server', 'private.customer_invitation_claim(uuid,text,text,text)', 'execute')
  and has_function_privilege('hub_app_server', 'private.customer_invitation_create(uuid,jsonb,uuid,text,timestamptz)', 'execute')
  and not has_function_privilege('authenticated', 'private.customer_invitation_create(uuid,jsonb,uuid,text,timestamptz)', 'execute')
  and not has_function_privilege('anon', 'private.customer_invitation_find(text,text,boolean)', 'execute')
  and not has_function_privilege('service_role', 'private.customer_invitation_claim(uuid,text,text,text)', 'execute')
  and not has_function_privilege('hub_app_server', 'private.customer_invitation_link(uuid,text,text,uuid,text)', 'execute'),
  'Only the Hub server runs the invitation functions, and nobody links an account outside them');
select throws_ok($$select private.customer_invitations_list()$$, '42501', 'Application server required.', 'Listing is the Hub server''s alone');
select is((select string_agg(key || ':' || kind, ',' order by key) from private.hub_settings where key like 'billing.invite\_%'),
  'billing.invite_breathe_signup:text,billing.invite_carebase_signup:text,billing.invite_days:number,billing.invite_intel_signup:text',
  'The four invitation settings exist');
select ok(hub.get_backend_contract() -> 'features' @> '["billing.customer-invitations.v1"]'::jsonb, 'The contract declares billing.customer-invitations.v1');

-- A published CareBase plan with a monthly per-facility price, a CareBase add-on and a Breathe plan.
insert into private.billing_products(stripe_product_id, product_id, name, active, kind, entitlement_key, unit_label, livemode, stripe_created, seen_at) values
  ('prod_invCore', '00000000-0000-4000-8000-000000000001', 'CareBase Core', true, 'plan', 'core', 'facility', false, now(), now()),
  ('prod_invAddon', '00000000-0000-4000-8000-000000000001', 'eMAR', true, 'addon', 'emar', 'facility', false, now(), now()),
  ('prod_invBreathe', '00000000-0000-4000-8000-000000000002', 'Breathe Pro', true, 'plan', 'pro', '', false, now(), now());
insert into private.billing_prices(stripe_price_id, stripe_product_id, active, currency, unit_amount, pricing_model, type, recurring_interval, interval_count, livemode, stripe_created, seen_at) values
  ('price_invCore', 'prod_invCore', true, 'usd', 19900, 'per_unit', 'recurring', 'month', 1, false, now(), now()),
  ('price_invAddon', 'prod_invAddon', true, 'usd', 14900, 'per_unit', 'recurring', 'month', 1, false, now(), now()),
  ('price_invBreathe', 'prod_invBreathe', true, 'usd', 49900, 'flat', 'recurring', 'month', 1, false, now(), now());

-- Supabase's postgres test login cannot SET SESSION AUTHORIZATION to hub_app_server. After checking the real boundary above, stub only
-- that guard for the behavioral assertions in this transaction; ROLLBACK restores it with the fixtures.
create or replace function private.require_hub_app_server() returns void
language plpgsql stable set search_path='' as $$ begin return; end; $$;

create temporary table inv as select private.customer_invitation_create(null, jsonb_build_object('app', 'carebase', 'contact_name', ' Jane Doe ',
  'contact_email', 'Jane@Maple.example', 'organization_name', 'Maple Grove', 'price', 'price_invCore', 'quantity', 3, 'discount_percent', 50,
  'discount_duration', 'repeating', 'discount_months', 12, 'note', 'Welcome aboard.'), '12500000-0000-4000-8000-000000000001', repeat('a', 64), now() + interval '30 days') as v;
select is((select v ->> 'status' from inv), 'pending', 'A new invitation is pending');
select is((select (v ->> 'unit_amount')::integer || ':' || (v ->> 'quantity') || ':' || (v ->> 'contact_email') || ':' || (v ->> 'contact_name') from inv),
  '19900:3:jane@maple.example:Jane Doe', 'It keeps the authorized price and quantity, and a trimmed contact');
select ok(not (select v ? 'token_hash' or v ? 'customer' from inv), 'The owner''s view never carries the link''s hash or a Stripe customer');
select is((select private.customer_invitation_create(null, jsonb_build_object('app', 'carebase', 'contact_name', 'Jane Doe',
  'contact_email', 'jane@maple.example', 'organization_name', 'Maple Grove', 'price', 'price_invCore', 'quantity', 3, 'discount_percent', 50,
  'discount_duration', 'repeating', 'discount_months', 12, 'note', 'Welcome aboard.'), '12500000-0000-4000-8000-000000000001', repeat('c', 64), now() + interval '30 days') ->> 'id'),
  (select v ->> 'id' from inv), 'Sending the same request again returns the same invitation');
select throws_ok($$select private.customer_invitation_create(null, jsonb_build_object('app', 'carebase', 'contact_name', 'A', 'contact_email', 'a@b.example',
  'organization_name', 'Org', 'price', 'price_invAddon', 'quantity', 1, 'discount_percent', 0, 'discount_duration', 'forever', 'discount_months', null, 'note', ''),
  gen_random_uuid(), repeat('b', 64), now() + interval '1 day')$$, '22023', 'Choose an active, published plan price of this application.', 'An add-on is not a plan');
select throws_ok($$select private.customer_invitation_create(null, jsonb_build_object('app', 'breathe', 'contact_name', 'A', 'contact_email', 'a@b.example',
  'organization_name', 'Org', 'price', 'price_invCore', 'quantity', 1, 'discount_percent', 0, 'discount_duration', 'forever', 'discount_months', null, 'note', ''),
  gen_random_uuid(), repeat('b', 64), now() + interval '1 day')$$, '22023', 'Choose an active, published plan price of this application.', 'A price of another application is refused');
select throws_ok($$select private.customer_invitation_create(null, jsonb_build_object('app', 'breathe', 'contact_name', 'A', 'contact_email', 'a@b.example',
  'organization_name', 'Org', 'price', 'price_invBreathe', 'quantity', 2, 'discount_percent', 0, 'discount_duration', 'forever', 'discount_months', null, 'note', ''),
  gen_random_uuid(), repeat('b', 64), now() + interval '1 day')$$, '22023', null, 'A flat price is sold once');
select throws_ok($$select private.customer_invitation_create(null, jsonb_build_object('app', 'breathe', 'contact_name', 'A', 'contact_email', 'a@b.example',
  'organization_name', 'Org', 'price', 'price_invBreathe', 'quantity', 1, 'discount_percent', 100.5, 'discount_duration', 'forever', 'discount_months', null, 'note', ''),
  gen_random_uuid(), repeat('b', 64), now() + interval '1 day')$$, '22023', null, 'A discount is at most 100 percent');

-- Accepting makes the invitation's own tenant once; paying records the subscription.
create temporary table ids as select (v ->> 'id')::uuid as id from inv;
select ok((select private.customer_invitation_tenant(id) from ids) = (select private.customer_invitation_tenant(id) from ids), 'The tenant is made once');
select is((select status::text from hub.tenants where id = (select tenant_id from private.customer_invitations where id = (select id from ids))), 'active',
  'The tenant is active and named for the organization');
select lives_ok($$select private.customer_invitation_progress((select id from ids), 'customer', '{"customer":"cus_invMaple"}')$$, 'The Stripe customer is recorded');
select throws_ok($$select private.customer_invitation_progress((select id from ids), 'customer', '{"customer":"cus_other"}')$$, '55000', null,
  'Another customer cannot replace it');
select lives_ok($$select private.customer_invitation_progress((select id from ids), 'checkout', '{"checkout":"cs_test_inv1","attempt":1}')$$, 'A Checkout is recorded');
select is((select private.customer_invitation_find('checkout', 'cs_test_inv1', false) ->> 'id'), (select id::text from ids), 'The webhook finds it by its session');
select lives_ok($$select private.customer_invitation_progress((select id from ids), 'active', '{"subscription":"sub_invMaple"}')$$, 'Paying activates it');
select is((select private.customer_invitation_progress(id, 'ready_email', '{}') ->> 'send' from ids), 'true', 'The ready email is claimed once');
select is((select private.customer_invitation_progress(id, 'ready_email', '{}') ->> 'send' from ids), 'false', '... and never twice');
select throws_ok($$select private.customer_invitation_owner(null, (select id from ids), 'revoke', (select version from private.customer_invitations where id = (select id from ids)), null, null)$$,
  '55000', null, 'A paid invitation cannot be revoked');

-- An application sign-up without the code, with the invitation's email: held for the owner, never a second trial.
select is((select private.customer_invitation_claim('00000000-0000-4000-8000-000000000001', 'org-held-123456', 'JANE@maple.example', null) ->> 'outcome'), 'held',
  'A sign-up with the invitation''s email is held');
select is((select private.customer_invitation_claim('00000000-0000-4000-8000-000000000001', 'org-other-999999', 'someone@else.example', null) ->> 'outcome'), 'none',
  'Any other sign-up starts its ordinary trial');
select is((select pending_account_hint from private.customer_invitations where id = (select id from ids)), '123456', 'The owner sees which account is waiting');

-- With the code, the account is linked to the invitation's tenant (and a retry answers the same); a second account cannot reuse it.
select is((select private.customer_invitation_claim('00000000-0000-4000-8000-000000000001', 'org-maple-abcdef', null, repeat('a', 64)) ->> 'outcome'), 'linked',
  'A sign-up with the code is linked');
select is(private.billing_resolve_account('00000000-0000-4000-8000-000000000001', 'org-maple-abcdef'),
  (select tenant_id from private.customer_invitations where id = (select id from ids)), 'The application account resolves to the invitation''s tenant');
select is((select private.customer_invitation_claim('00000000-0000-4000-8000-000000000001', 'org-maple-abcdef', null, repeat('a', 64)) ->> 'outcome'), 'linked',
  'A retried sign-up answers the same');
select throws_ok($$select private.customer_invitation_claim('00000000-0000-4000-8000-000000000001', 'org-thief-000000', null, repeat('a', 64))$$, '22023', null,
  'Another account cannot use a claimed invitation');

select * from finish();
rollback;
