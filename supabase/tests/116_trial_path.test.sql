begin;
select plan(16);

-- The trial path (20261117230000_trial_path.sql, team review 2026-11-17, stage 4).
select ok((select relrowsecurity from pg_class where oid = 'private.growth_trial_cards'::regclass)
  and not has_table_privilege('hub_app_server', 'private.growth_trial_cards', 'select')
  and not has_table_privilege('authenticated', 'private.growth_trial_cards', 'select'),
  'When each Intel trial''s card was first confirmed is closed to every role');
select ok(has_function_privilege('hub_app_server', 'private.agent_lifecycle_defer(uuid,integer,text)', 'execute')
  and not has_function_privilege('authenticated', 'private.agent_lifecycle_defer(uuid,integer,text)', 'execute')
  and not has_function_privilege('service_role', 'private.agent_lifecycle_defer(uuid,integer,text)', 'execute'),
  'Only the server lets a refused customer email wait');
select ok(position('''card_reminder''' in (select pg_get_constraintdef(oid) from pg_constraint
    where conrelid = 'private.agent_lifecycle_emails'::regclass and conname = 'agent_lifecycle_emails_template_check')) > 0
  and position('''value_followup''' in (select pg_get_constraintdef(oid) from pg_constraint
    where conrelid = 'private.agent_actions'::regclass and conname = 'agent_actions_email_send_check')) > 0,
  'The send ledger and the action check accept the trial path''s emails');
select ok(hub.get_backend_contract() -> 'features' ? 'platform.agents.trial-path.v1', 'The trial path is declared');

-- Two customers: an Intel trial and a CareBase trial.
insert into hub.tenants (id, slug, name) values
  ('11111111-1111-4111-8111-111111111116', 'trial-path-intel', 'Trial Path Intel'),
  ('22222222-2222-4222-8222-222222222216', 'trial-path-carebase', 'Trial Path CareBase'),
  ('33333333-3333-4333-8333-333333333316', 'trial-path-abandoned', 'Trial Path Abandoned');
insert into private.billing_customers (tenant_id, stripe_customer_id, email, livemode, seen_at) values
  ('11111111-1111-4111-8111-111111111116', 'cus_trialpath116a', 'owner@intel-trial.example', true, now()),
  ('22222222-2222-4222-8222-222222222216', 'cus_trialpath116b', 'owner@carebase-trial.example', true, now()),
  ('33333333-3333-4333-8333-333333333316', 'cus_trialpath116c', 'owner@abandoned.example', true, now());
insert into private.billing_subscriptions (stripe_subscription_id, tenant_id, stripe_customer_id, product_id, status, collection_method, livemode, stripe_created, seen_at, trial_start, trial_end)
select v.sub, v.tenant::uuid, v.cus, p.id, 'trialing', 'charge_automatically', true, now(), now(), now(), now() + interval '30 days'
  from (values ('sub_trialpath116a', '11111111-1111-4111-8111-111111111116', 'cus_trialpath116a', 'caremetric-intel'),
               ('sub_trialpath116b', '22222222-2222-4222-8222-222222222216', 'cus_trialpath116b', 'carebase'),
               ('sub_trialpath116c', '33333333-3333-4333-8333-333333333316', 'cus_trialpath116c', 'caremetric-intel')) v(sub, tenant, cus, product)
  join hub.products p on p.slug = v.product;

select is((select count(*)::integer from private.growth_billing_outbox where event_key in ('billing:trial:sub_trialpath116a', 'billing:trial:sub_trialpath116c')), 0,
  'An Intel subscription that is only trialing is not counted as a trial');
select is((select count(*)::integer from private.growth_billing_outbox where event_key = 'billing:trial:sub_trialpath116b' and kind = 'trial_started'), 1,
  'A CareBase trial, which needs no card, still counts when it starts');

-- Stripe confirms the Intel trial's card (as billing.mjs records it), then confirms it again on a later check.
insert into private.billing_trial_cards (stripe_subscription_id, tenant_id, confirmed_at)
values ('sub_trialpath116a', '11111111-1111-4111-8111-111111111116', now());
select is((select count(*)::integer from private.growth_billing_outbox where event_key = 'billing:trial:sub_trialpath116a' and kind = 'trial_started'), 1,
  'The card''s first confirmation starts the Intel trial');
update private.growth_trial_cards set first_confirmed_at = now() - interval '1 hour' where stripe_subscription_id = 'sub_trialpath116a';
update private.billing_trial_cards set confirmed_at = now() where stripe_subscription_id = 'sub_trialpath116a';
select is((select count(*)::integer from private.growth_billing_outbox where event_key = 'billing:trial:sub_trialpath116a'), 1,
  'A later confirmation counts nothing again');
select is((select first_confirmed_at from private.growth_trial_cards where stripe_subscription_id = 'sub_trialpath116a'), now() - interval '1 hour',
  'and keeps when the card was first confirmed');

-- The Account Manager's facts.
select is(private.agent_lifecycle_json(10, 'trial-path-intel', 'caremetric-intel', 0) #>> '{accounts,0,cardConfirmedAt}' is not null, true,
  'The facts carry when the trial''s card was first confirmed');
select is(private.agent_lifecycle_json(10, 'trial-path-abandoned', 'caremetric-intel', 0) #> '{accounts,0,cardConfirmedAt}', 'null'::jsonb,
  'and none for a sign-up that never added one');
select ok((private.agent_lifecycle_json(10, 'trial-path-intel', 'caremetric-intel', 0) #> '{accounts,0,emails}') ? 'card_reminder',
  'and what became of the trial path''s emails');

-- Both Intel trials end unpaid: the counted one is lost, the sign-up that never started is not.
update private.billing_subscriptions set status = 'canceled' where stripe_subscription_id in ('sub_trialpath116a', 'sub_trialpath116c');
select is((select count(*)::integer from private.growth_billing_outbox where event_key = 'billing:trial_lost:sub_trialpath116a' and kind = 'churned'), 1,
  'A counted trial that ended with nothing paid is recorded as lost');
select is((select count(*)::integer from private.growth_billing_outbox where event_key = 'billing:trial_lost:sub_trialpath116c'), 0,
  'A sign-up that never added its card was never a trial, so it is not lost either');
select is((select first_confirmed_at from private.growth_trial_cards where stripe_subscription_id = 'sub_trialpath116a') is not null, true,
  'The card''s confirmation outlives the trial');

-- The Sales hand-over includes a prospect in its trial; Intel's milestones are accepted.
select ok(position('''nurture'', ''trial'')' in pg_get_functiondef('private.sales_handoff(uuid,uuid)'::regprocedure)) > 0
  and position('county_chosen' in pg_get_functiondef('private.growth_app_event(text,jsonb)'::regprocedure)) > 0,
  'The Sales hand-over includes a trial, and Intel''s milestones are accepted');

select * from finish();
rollback;
