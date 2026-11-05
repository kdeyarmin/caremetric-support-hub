begin;
select plan(24);

select ok(hub.get_backend_contract() -> 'features' @> '["platform.agents.offers.v1"]'::jsonb, 'Offers are declared in release metadata');

-- The boundary: both tables closed to every role, the server operations the Hub server's alone, the owner operations self-authorizing.
select ok(bool_and(c.relrowsecurity), 'The offer menu and the record of offers have row level security')
from pg_class c where c.oid in ('private.agent_offer_menu'::regclass, 'private.agent_offer_uses'::regclass);
select ok(not bool_or(has_table_privilege(role_name, t, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')), 'No browser, service or server role can touch the offer tables')
from unnest(array['anon', 'authenticated', 'service_role', 'hub_app_server']) role_name cross join unnest(array['private.agent_offer_menu', 'private.agent_offer_uses']) t;
select ok(bool_and(has_function_privilege('hub_app_server', signature, 'execute'))
  and not bool_or(has_function_privilege(role_name, signature, 'execute')), 'Only the Hub server reads candidates, makes and settles offers')
from unnest(array['private.agent_offer_candidates(integer)', 'private.agent_offer_begin(uuid,integer)', 'private.agent_offer_settle(uuid,text)',
  'private.agent_offer_request(uuid,integer,jsonb)']) signature
cross join unnest(array['public', 'anon', 'authenticated', 'service_role']) role_name;
select ok(not bool_or(has_function_privilege(role_name, signature, 'execute')), 'The offer helpers are executable by no role')
from unnest(array['private.agent_offer_month_start()', 'private.agent_offer_use_json(private.agent_offer_uses,text)',
  'private.agent_offer_menu_json(private.agent_offer_menu)', 'private.agent_offer_coupon_usable(text)']) signature
cross join unnest(array['anon', 'authenticated', 'service_role', 'hub_app_server']) role_name;
select throws_ok('select private.agent_offer_candidates(10)', '42501', 'Application server required.', 'Reading candidates needs the Hub server');
select throws_ok('select private.agent_offer_begin(gen_random_uuid(), 1)', '42501', 'Application server required.', 'Making an offer needs the Hub server');
select throws_ok($$select private.agent_offer_settle(gen_random_uuid(), 'applied')$$, '42501', 'Application server required.', 'Settling an offer needs the Hub server');
set local role authenticated;
select throws_ok('select hub.get_agent_offers()', '28000', null, 'A signed-in user without an administrator session cannot read the menu');
select throws_ok($$select hub.set_agent_offer('trial_extension_14', true, 5, now())$$, '28000', null, 'A signed-in user without a command session cannot change the menu');
select throws_ok($$select hub.add_agent_offer('More days', 'trial_extension', 7, null, array['carebase'], 7, 5)$$, '28000', null, 'Nor add to it');
reset role;
set local role anon;
select throws_ok('select hub.get_agent_offers()', '42501', null, 'Anonymous callers cannot read the menu');
reset role;

-- The action kind and its shape.
select ok(position('''offer.apply''' in (select pg_get_constraintdef(oid) from pg_constraint where conrelid = 'private.agent_actions'::regclass and conname = 'agent_actions_kind_check')) > 0
  and position('''communication.answer''' in (select pg_get_constraintdef(oid) from pg_constraint where conrelid = 'private.agent_actions'::regclass and conname = 'agent_actions_kind_check')) > 0
  and position('''email.send''' in (select pg_get_constraintdef(oid) from pg_constraint where conrelid = 'private.agent_actions'::regclass and conname = 'agent_actions_kind_check')) > 0,
  'offer.apply is an allowed action kind and the kinds earlier changes added are kept');
insert into private.agent_tasks (id, agent_key, kind, request_key, status, attempts, lease_until)
values ('a6a6a6a6-0000-4000-8000-000000000001', 'account_manager', 'accounts.offers', 'pgtap-offers', 'running', 1, now() + interval '5 minutes');
select lives_ok($$insert into private.agent_actions (agent_key, task_id, kind, target_kind, target_id, preview, input, status, expires_at)
  values ('account_manager', 'a6a6a6a6-0000-4000-8000-000000000001', 'offer.apply', 'billing_account', 'maple-grove', 'Offer',
    '{"offer": "trial_extension_14", "tenant": "maple-grove", "product": "carebase", "subscription": "sub_123"}', 'proposed', now() + interval '7 days')$$,
  'An offer naming its offer, account, product and subscription is admitted');
select throws_ok($$insert into private.agent_actions (agent_key, task_id, kind, target_kind, target_id, preview, input, status, expires_at)
  values ('account_manager', 'a6a6a6a6-0000-4000-8000-000000000001', 'offer.apply', 'billing_account', 'oak-hill', 'Offer',
    '{"offer": "trial_extension_14", "tenant": "maple-grove", "product": "carebase", "subscription": "sub_123"}', 'proposed', now() + interval '7 days')$$,
  '23514', null, 'The card''s account and the offer''s account must be the same');
select throws_ok($$insert into private.agent_actions (agent_key, task_id, kind, target_kind, target_id, preview, input, status, expires_at)
  values ('account_manager', 'a6a6a6a6-0000-4000-8000-000000000001', 'offer.apply', 'billing_account', 'pine-lake', 'Offer',
    '{"offer": "trial_extension_14", "tenant": "pine-lake", "product": "carebase", "subscription": "sub_123", "trialDays": 90}', 'proposed', now() + interval '7 days')$$,
  '23514', null, 'What an offer gives comes from the menu, never from the proposal');

-- The seeded menu: one trial extension, switched off.
select results_eq($$select kind, trial_days, window_days, monthly_cap, enabled from private.agent_offer_menu where key = 'trial_extension_14'$$,
  $$values ('trial_extension'::text, 14, 7, 10, false)$$, 'The seeded 14-day trial extension starts switched off, at most 10 a month');
select throws_ok($$insert into private.agent_offer_menu (key, label, kind, apps, monthly_cap) values ('bad_offer', 'No days', 'trial_extension', array['carebase'], 5)$$,
  '23514', null, 'A trial extension must say how many days');
select throws_ok($$insert into private.agent_offer_menu (key, label, kind, trial_days, coupon_id, apps, monthly_cap) values ('bad_offer', 'Both', 'coupon', 7, 'SPRING20', array['carebase'], 5)$$,
  '23514', null, 'A coupon offer gives a coupon and nothing else');
select throws_ok($$insert into private.agent_offer_menu (key, label, kind, trial_days, apps, monthly_cap) values ('bad_offer', 'Too many', 'trial_extension', 7, array['carebase'], 51)$$,
  '23514', null, 'A monthly cap is at most 50');

-- Once per account: a second use of the same offer is refused unless the first was refused by Stripe.
insert into hub.tenants(id, slug, name, status) values ('a6a6a6a6-0000-4000-8000-000000000010', 'pgtap-offers', 'Offer Account', 'active');
insert into private.agent_offer_uses (offer_key, tenant_id, stripe_subscription_id, action_id, kind, trial_end_before, trial_end_after, status, settled_at)
values ('trial_extension_14', 'a6a6a6a6-0000-4000-8000-000000000010', 'sub_1', gen_random_uuid(), 'trial_extension', now(), now() + interval '14 days', 'refused', now());
select lives_ok($$insert into private.agent_offer_uses (offer_key, tenant_id, stripe_subscription_id, action_id, kind, trial_end_before, trial_end_after)
  values ('trial_extension_14', 'a6a6a6a6-0000-4000-8000-000000000010', 'sub_1', gen_random_uuid(), 'trial_extension', now(), now() + interval '14 days')$$,
  'An offer Stripe refused does not use up the account''s one offer');
select throws_ok($$insert into private.agent_offer_uses (offer_key, tenant_id, stripe_subscription_id, action_id, kind, trial_end_before, trial_end_after)
  values ('trial_extension_14', 'a6a6a6a6-0000-4000-8000-000000000010', 'sub_1', gen_random_uuid(), 'trial_extension', now(), now() + interval '14 days')$$,
  '23505', null, 'An account gets each offer once');

-- The Account Manager looks daily, and the "offers" autonomy step hands over exactly offer.apply.
select ok(exists (select 1 from private.agent_schedules where agent_key = 'account_manager' and task_kind = 'accounts.offers' and cadence = 'daily'
  and at_local = '08:40' and not requires_session), 'The Account Manager looks for qualifying accounts every morning');
select is((select changes from private.agent_autonomy_steps where category = 'offers'),
  '[{"agent": "account_manager", "config_key": "auto_approve_kinds", "values": ["offer.apply"]}]'::jsonb, 'The offers step hands over exactly offer.apply');

select * from finish();
rollback;
