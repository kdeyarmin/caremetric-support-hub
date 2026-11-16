-- Stripe's trial card answers (20261116020000_billing_trial_cards.sql): closed to every role, recorded and read by the Hub server
-- only, kept per tenant, all-or-nothing across the subscriptions named, and forgotten when a check finds no card.
begin;
select plan(17);

select ok((select relrowsecurity from pg_class where oid = 'private.billing_trial_cards'::regclass), 'The trial card table has row-level security');
select ok(not has_table_privilege(r, 'private.billing_trial_cards', 'select, insert, update, delete'), 'The trial card table is closed to ' || r)
  from unnest(array['anon', 'authenticated', 'service_role', 'hub_app_server']) r;
select ok(has_function_privilege('hub_app_server', 'private.billing_trial_card_record(uuid,text[],boolean)', 'execute'), 'The server can record an answer');
select ok(has_function_privilege('hub_app_server', 'private.billing_trial_card_confirmed(uuid,text[])', 'execute'), 'The server can read an answer');
select ok(not has_function_privilege('authenticated', 'private.billing_trial_card_confirmed(uuid,text[])', 'execute'), 'A browser cannot read an answer');
select throws_ok($$select private.billing_trial_card_confirmed('97610000-0000-4000-8000-000000000001', array['sub_trialCardsA'])$$,
  '42501', 'Application server required.', 'Reading is the Hub server''s alone');
select ok(hub.get_backend_contract() -> 'features' @> '["billing.trial-cards.v1"]'::jsonb, 'The contract declares billing.trial-cards.v1');

insert into hub.tenants(id, slug, name, status) values
  ('97610000-0000-4000-8000-000000000001', 'trial-cards-a', 'Trial Cards A', 'active'),
  ('97610000-0000-4000-8000-000000000002', 'trial-cards-b', 'Trial Cards B', 'active');
insert into private.billing_customers(tenant_id, stripe_customer_id, livemode, seen_at) values
  ('97610000-0000-4000-8000-000000000001', 'cus_trialCardsA', true, now()),
  ('97610000-0000-4000-8000-000000000002', 'cus_trialCardsB', true, now());
insert into private.billing_subscriptions(stripe_subscription_id, tenant_id, stripe_customer_id, status, collection_method, livemode, stripe_created, seen_at) values
  ('sub_trialCardsA', '97610000-0000-4000-8000-000000000001', 'cus_trialCardsA', 'trialing', 'charge_automatically', true, now(), now()),
  ('sub_paidCardsA', '97610000-0000-4000-8000-000000000001', 'cus_trialCardsA', 'active', 'charge_automatically', true, now(), now());

-- Supabase's postgres test login cannot SET SESSION AUTHORIZATION to hub_app_server. After checking the real boundary above, stub only
-- that guard for the behavioral assertions in this transaction; ROLLBACK restores it with the fixtures.
create or replace function private.require_hub_app_server() returns void
language plpgsql stable set search_path='' as $$ begin return; end; $$;

select ok(not private.billing_trial_card_confirmed('97610000-0000-4000-8000-000000000001', array['sub_trialCardsA']), 'Nothing is confirmed until Stripe confirms it');
select private.billing_trial_card_record('97610000-0000-4000-8000-000000000001', array['sub_trialCardsA'], true);
select ok(private.billing_trial_card_confirmed('97610000-0000-4000-8000-000000000001', array['sub_trialCardsA']), 'A confirmed card is kept');
select ok(not private.billing_trial_card_confirmed('97610000-0000-4000-8000-000000000002', array['sub_trialCardsA']), 'It is kept for its own tenant only');
select private.billing_trial_card_record('97610000-0000-4000-8000-000000000002', array['sub_trialCardsA'], true);
select is((select tenant_id from private.billing_trial_cards where stripe_subscription_id = 'sub_trialCardsA'),
  '97610000-0000-4000-8000-000000000001'::uuid, 'Another tenant cannot take a confirmation over');
select ok(not private.billing_trial_card_confirmed('97610000-0000-4000-8000-000000000001', array['sub_trialCardsA', 'sub_paidCardsA']),
  'Every subscription named must be confirmed, and only while it is trialing');
select private.billing_trial_card_record('97610000-0000-4000-8000-000000000001', array['sub_trialCardsA'], false);
select ok(not private.billing_trial_card_confirmed('97610000-0000-4000-8000-000000000001', array['sub_trialCardsA']), 'A check that finds no card forgets it');
select throws_ok($$select private.billing_trial_card_record('97610000-0000-4000-8000-000000000001', array['not-a-subscription'], true)$$,
  '22023', 'Name the tenant and its trialing subscriptions.', 'Only Stripe subscription ids are recorded');

select * from finish();
rollback;
