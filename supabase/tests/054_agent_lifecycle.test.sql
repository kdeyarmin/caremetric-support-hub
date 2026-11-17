begin;
select plan(49);

create temporary table lifecycle_operations(signature text primary key) on commit drop;
insert into lifecycle_operations values
  ('private.agent_lifecycle_snapshot(integer,text,text,integer)'),
  ('private.agent_lifecycle_begin_send(uuid,integer,text)'),
  ('private.agent_lifecycle_finish_send(uuid,text,text)'),
  ('private.agent_action_propose(uuid,uuid,text,text,text,text,jsonb)'),
  ('private.email_unsubscribe(text,boolean)');

-- ---------------------------------------------------------------------------------------
-- The boundary: a closed ledger, server-only operations, and a helper nobody may call.
-- ---------------------------------------------------------------------------------------
select ok(coalesce((select relrowsecurity from pg_class where oid = to_regclass('private.agent_lifecycle_emails')), false),
  'The customer email ledger exists with row level security');
select ok(not bool_or(has_table_privilege(role_name, 'private.agent_lifecycle_emails', 'select,insert,update,delete,truncate')
    or has_any_column_privilege(role_name, 'private.agent_lifecycle_emails', 'select,insert,update')),
  'No browser, service or server role reaches the ledger directly')
from unnest(array['public', 'anon', 'authenticated', 'service_role', 'hub_app_server']) as role_name;

select ok(bool_and(p.prosecdef and coalesce(p.proconfig @> array['search_path=""'], false)) and count(*) = 5,
  'Every customer email operation, and the two it replaced, is a security definer with a pinned empty search path')
from lifecycle_operations operation join pg_proc p on p.oid = to_regprocedure(operation.signature);
select ok(bool_and(has_function_privilege('hub_app_server', operation.signature, 'execute')),
  'The Hub server role executes every customer email operation')
from lifecycle_operations operation;
select ok(not bool_or(has_function_privilege(role_name, operation.signature, 'execute')),
  'No browser, service or public role executes a customer email operation')
from lifecycle_operations operation cross join unnest(array['public', 'anon', 'authenticated', 'service_role']) as role_name;

select ok(coalesce((select p.proconfig @> array['search_path=""'] and not p.prosecdef from pg_proc p
    where p.oid = to_regprocedure('private.agent_lifecycle_json(integer,text,text,integer)')), false),
  'The facts helper pins an empty search path and runs as its caller');
select ok(not bool_or(has_function_privilege(role_name, 'private.agent_lifecycle_json(integer,text,text,integer)', 'execute')),
  'No role at all, the Hub server included, executes the facts helper directly')
from unnest(array['public', 'anon', 'authenticated', 'service_role', 'hub_app_server']) as role_name;

select throws_ok('select private.agent_lifecycle_snapshot()', '42501', 'Application server required.',
  'Reading the facts refuses every session user other than the Hub server');
select throws_ok($$select private.agent_lifecycle_begin_send(gen_random_uuid(), 1, repeat('a', 64))$$, '42501', 'Application server required.',
  'Asking for an address refuses every session user other than the Hub server');
select throws_ok($$select private.agent_lifecycle_begin_send(gen_random_uuid(), null, null)$$, '42501', 'Application server required.',
  'Even the look that changes nothing refuses every session user other than the Hub server');
select throws_ok($$select private.agent_lifecycle_finish_send(gen_random_uuid(), 'sent', null)$$, '42501', 'Application server required.',
  'Recording a delivery refuses every session user other than the Hub server');
select throws_ok($$select private.email_unsubscribe(repeat('a', 64), true)$$, '42501', 'Application server required.',
  'The one unsubscribe operation still refuses every session user other than the Hub server');

set local role authenticated;
select throws_ok('select private.agent_lifecycle_snapshot(10)', '42501', 'permission denied for function agent_lifecycle_snapshot',
  'Signed-in users cannot read the facts');
select throws_ok($$select private.agent_lifecycle_begin_send(gen_random_uuid(), 1, repeat('a', 64))$$, '42501', 'permission denied for function agent_lifecycle_begin_send',
  'Signed-in users cannot ask for an address');
reset role;
set local role anon;
select throws_ok('select private.agent_lifecycle_snapshot(10)', '42501', null, 'Anonymous callers cannot read the facts');
select throws_ok($$select private.agent_lifecycle_finish_send(gen_random_uuid(), 'sent', null)$$, '42501', null, 'Anonymous callers cannot record a delivery');
reset role;

select ok(hub.get_backend_contract() -> 'features' @> '["platform.agents.lifecycle.v1"]'::jsonb,
  'The customer emails are declared in release metadata');
select ok((select count(*) = 1 from private.agent_schedules where agent_key = 'account_manager' and task_kind = 'accounts.lifecycle' and cadence = 'daily'
    and at_local = '08:20' and timezone = 'America/New_York' and not requires_session and next_run_at > now()),
  'The customer emails run daily at 08:20 Eastern, with no owner session needed');
select is((select config -> 'auto_send_templates' from private.agents where key = 'account_manager'), '[]'::jsonb,
  'No template is sent on its own until the owner lists it');
select ok((select config ? 'auto_approve_kinds' and config ->> 'effort' = 'low' from private.agents where key = 'account_manager'),
  'The setting was added beside the agent''s other settings, which are kept');

-- ---------------------------------------------------------------------------------------
-- The action: a checked shape with no room for an address, once per period.
-- ---------------------------------------------------------------------------------------
create temporary table lifecycle_input(template text primary key, input jsonb) on commit drop;
insert into lifecycle_input
  select template, jsonb_build_object('template', template, 'tenant', 'lifecycle-alpha', 'tenantName', 'Alpha Home', 'product', 'carebase',
    'productName', 'CareMetric CareBase', 'helpUrl', 'https://cmcarebase.com/app/help', 'bookingUrl', null,
    'periodKey', 'account:' || template || ':lifecycle-alpha:carebase', 'textHash', repeat('a', 64))
  from unnest(array['welcome', 'setup_nudge', 'trial_checkin', 'testimonial_ask']) template;

select lives_ok($$insert into private.agent_actions (agent_key, kind, target_kind, target_id, preview, input, status)
    select 'account_manager', 'email.send', 'billing_account', 'lifecycle-alpha', 'Subject: Welcome', input, 'rejected' from lifecycle_input where template = 'welcome'$$,
  'A customer email with exactly its facts is a valid action');
select throws_ok($$insert into private.agent_actions (agent_key, kind, target_kind, target_id, preview, input)
    select 'account_manager', 'email.send', 'billing_account', 'lifecycle-alpha', 'Subject: Again', input from lifecycle_input where template = 'welcome'$$,
  '23505', null, 'The same template is never proposed twice for the same account and product, whichever task proposes it');
select throws_ok($$insert into private.agent_actions (agent_key, kind, target_kind, target_id, preview, input)
    select 'account_manager', 'email.send', 'billing_account', 'lifecycle-alpha', 'Subject: S', input || '{"to": "someone@example.test"}' from lifecycle_input where template = 'setup_nudge'$$,
  '23514', null, 'An action cannot carry an address, or anything outside its facts');
select throws_ok($$insert into private.agent_actions (agent_key, kind, target_kind, target_id, preview, input)
    select 'account_manager', 'email.send', 'communication', 'lifecycle-alpha', 'Subject: S', input from lifecycle_input where template = 'setup_nudge'$$,
  '23514', null, 'A customer email is aimed at a billing account');
select throws_ok($$insert into private.agent_actions (agent_key, kind, target_kind, target_id, preview, input)
    select 'account_manager', 'email.send', 'billing_account', 'lifecycle-beta', 'Subject: S', input from lifecycle_input where template = 'setup_nudge'$$,
  '23514', null, 'Its target is the account its facts name');
select throws_ok($$insert into private.agent_actions (agent_key, kind, target_kind, target_id, preview, input)
    select 'account_manager', 'email.send', 'billing_account', 'lifecycle-alpha', 'Subject: S', jsonb_set(input, '{periodKey}', '"account:welcome:lifecycle-alpha:carebase"') from lifecycle_input where template = 'setup_nudge'$$,
  '23514', null, 'Its period key is its own template, account and product');
select throws_ok($$insert into private.agent_actions (agent_key, kind, target_kind, target_id, preview, input)
    select 'account_manager', 'email.send', 'billing_account', 'lifecycle-alpha', 'Subject: S', input - 'textHash' from lifecycle_input where template = 'setup_nudge'$$,
  '23514', null, 'A missing fact fails the check instead of passing it as unknown');
select throws_ok($$insert into private.agent_actions (agent_key, kind, target_kind, target_id, preview, input)
    select 'account_manager', 'email.send', 'billing_account', 'lifecycle-alpha', 'Subject: S', jsonb_set(input, '{bookingUrl}', '"javascript:alert(1)"') from lifecycle_input where template = 'setup_nudge'$$,
  '23514', null, 'A booking link is an https address or nothing');
select throws_ok($$insert into private.agent_actions (agent_key, kind, target_kind, target_id, preview, input)
    select 'account_manager', 'email.send', 'billing_account', 'lifecycle-alpha', 'Subject: S', jsonb_set(input, '{template}', '"improvised"') from lifecycle_input where template = 'setup_nudge'$$,
  '23514', null, 'Only the four templates exist');
select lives_ok($$insert into private.agent_actions (agent_key, kind, target_kind, target_id, preview, input)
    values ('platform_engineer', 'incident.open', 'probe_target', 'carebase', 'CareBase is down', '{}'::jsonb)$$,
  'Every kind the table allowed before is still allowed');

select throws_ok($$insert into private.agent_lifecycle_emails (action_id, period_key, template, email_hash, unsubscribe_hash)
    select id, 'account:welcome:Not A Slug:carebase', 'welcome', repeat('b', 64), repeat('c', 64) from private.agent_actions where target_id = 'lifecycle-alpha' limit 1$$,
  '23514', null, 'A recorded send carries a well-formed period key');
select throws_ok($$insert into private.agent_lifecycle_emails (action_id, period_key, template, email_hash, unsubscribe_hash, status)
    select id, 'account:welcome:lifecycle-alpha:carebase', 'welcome', repeat('b', 64), repeat('c', 64), 'sent' from private.agent_actions where target_id = 'lifecycle-alpha' limit 1$$,
  '23514', null, 'A send is settled with the time it was settled, and only then');
select throws_ok($$insert into private.agent_lifecycle_emails (action_id, period_key, template, email_hash, unsubscribe_hash)
    select id, 'account:welcome:lifecycle-alpha:carebase', 'welcome', 'canary.alpha@example.test', repeat('c', 64) from private.agent_actions where target_id = 'lifecycle-alpha' limit 1$$,
  '23514', null, 'The ledger keeps an address only as its hash');

-- ---------------------------------------------------------------------------------------
-- The facts: invented accounts and a canary address that must never come out.
-- ---------------------------------------------------------------------------------------
insert into auth.users(id, email, is_anonymous) values ('97530000-0000-4000-8000-000000000001', 'requester@example.invalid', false);
insert into hub.tenants(id, slug, name, status) values
  ('97530000-0000-4000-8000-000000000010', 'lifecycle-alpha', 'Alpha Home', 'active'),
  ('97530000-0000-4000-8000-000000000011', 'lifecycle-beta', 'Beta Agency', 'active'),
  ('97530000-0000-4000-8000-000000000012', 'lifecycle-gamma', 'Gamma Test Mode', 'active'),
  ('97530000-0000-4000-8000-000000000013', 'lifecycle-delta', 'Delta Paying', 'active'),
  ('97530000-0000-4000-8000-000000000014', 'lifecycle-epsilon', 'Epsilon Long Paying', 'active'),
  ('97530000-0000-4000-8000-000000000015', 'lifecycle-zeta', 'Zeta Cancelling', 'active'),
  ('97530000-0000-4000-8000-000000000016', 'lifecycle-eta', 'Eta Suspended', 'suspended'),
  ('97530000-0000-4000-8000-000000000017', 'lifecycle-theta', 'Theta Replaced Subscription', 'active'),
  ('97530000-0000-4000-8000-000000000018', 'lifecycle-iota', 'Iota Long Customer', 'active');
update private.billing_settings set livemode = true;
insert into private.billing_customers(tenant_id, stripe_customer_id, email, name, livemode, seen_at) values
  ('97530000-0000-4000-8000-000000000010', 'cus_lcAlpha', 'canary.alpha@example.test', 'Canary Contact', true, now()),
  ('97530000-0000-4000-8000-000000000011', 'cus_lcBeta', '', '', true, now()),
  ('97530000-0000-4000-8000-000000000012', 'cus_lcGamma', 'canary.gamma@example.test', '', false, now()),
  ('97530000-0000-4000-8000-000000000013', 'cus_lcDelta', 'canary.delta@example.test', '', true, now()),
  ('97530000-0000-4000-8000-000000000014', 'cus_lcEpsilon', 'canary.epsilon@example.test', '', true, now()),
  ('97530000-0000-4000-8000-000000000015', 'cus_lcZeta', ' Canary.Zeta@Example.test ', '', true, now()),
  ('97530000-0000-4000-8000-000000000016', 'cus_lcEta', 'canary.eta@example.test', '', true, now()),
  ('97530000-0000-4000-8000-000000000017', 'cus_lcTheta', 'canary.theta@example.test', '', true, now()),
  ('97530000-0000-4000-8000-000000000018', 'cus_lcIota', 'canary.iota@example.test', '', true, now());
insert into private.email_suppressions(email_hash) values (encode(extensions.digest('canary.zeta@example.test', 'sha256'), 'hex'));

insert into private.billing_subscriptions(stripe_subscription_id, tenant_id, stripe_customer_id, product_id, status, collection_method, cancel_at_period_end,
    trial_start, trial_end, livemode, stripe_created, seen_at)
  select s.id, s.tenant::uuid, s.customer, p.id, s.status, 'charge_automatically', s.cancelling, now() - s.started, now() + s.ends, s.live, now() - s.started, now()
  from (values
    ('sub_lcAlpha', '97530000-0000-4000-8000-000000000010', 'cus_lcAlpha', 'carebase', 'trialing', false, interval '1 day', interval '29 days', true),
    ('sub_lcBeta', '97530000-0000-4000-8000-000000000011', 'cus_lcBeta', 'caremetric-intel', 'trialing', false, interval '4 days', interval '10 days', true),
    ('sub_lcGamma', '97530000-0000-4000-8000-000000000012', 'cus_lcGamma', 'carebase', 'trialing', false, interval '1 day', interval '29 days', false),
    ('sub_lcDelta', '97530000-0000-4000-8000-000000000013', 'cus_lcDelta', 'carebase', 'active', false, interval '80 days', interval '-50 days', true),
    ('sub_lcEpsilon', '97530000-0000-4000-8000-000000000014', 'cus_lcEpsilon', 'carebase', 'active', false, interval '150 days', interval '-120 days', true),
    ('sub_lcZeta', '97530000-0000-4000-8000-000000000015', 'cus_lcZeta', 'carebase', 'trialing', true, interval '2 days', interval '28 days', true),
    ('sub_lcEta', '97530000-0000-4000-8000-000000000016', 'cus_lcEta', 'carebase', 'trialing', false, interval '1 day', interval '29 days', true)
  ) as s(id, tenant, customer, product, status, cancelling, started, ends, live)
  join hub.products p on p.slug = s.product;
-- Two accounts that replaced a subscription. Theta first paid 70 days ago on a subscription it has since cancelled (its test-mode one
-- paid earlier still, and never counts); Iota first paid 120 days ago, so a subscription it started 55 days ago does not make it new.
insert into private.billing_subscriptions(stripe_subscription_id, tenant_id, stripe_customer_id, product_id, status, collection_method, canceled_at, ended_at,
    livemode, stripe_created, seen_at)
  select s.id, s.tenant::uuid, s.customer, p.id, s.status, 'charge_automatically', s.ended, s.ended, s.live, now() - s.created_ago, now()
  from (values
    ('sub_lcThetaOld', '97530000-0000-4000-8000-000000000017', 'cus_lcTheta', 'canceled', now() - interval '15 days', true, interval '100 days'),
    ('sub_lcThetaNew', '97530000-0000-4000-8000-000000000017', 'cus_lcTheta', 'active', null::timestamptz, true, interval '15 days'),
    ('sub_lcThetaTest', '97530000-0000-4000-8000-000000000017', 'cus_lcTheta', 'canceled', now() - interval '60 days', false, interval '120 days'),
    ('sub_lcIotaOld', '97530000-0000-4000-8000-000000000018', 'cus_lcIota', 'canceled', now() - interval '55 days', true, interval '150 days'),
    ('sub_lcIotaNew', '97530000-0000-4000-8000-000000000018', 'cus_lcIota', 'active', null::timestamptz, true, interval '55 days')
  ) as s(id, tenant, customer, status, ended, live, created_ago)
  join hub.products p on p.slug = 'carebase';
insert into private.billing_invoices(stripe_invoice_id, tenant_id, stripe_customer_id, stripe_subscription_id, status, currency, total, subtotal, amount_due, amount_paid, amount_remaining, livemode, stripe_created, seen_at)
  select i.id, i.tenant::uuid, i.customer, i.subscription, 'paid', 'usd', 4900, 4900, 4900, 4900, 0, i.live, now() - i.age, now()
  from (values
    ('in_lcThetaOld', '97530000-0000-4000-8000-000000000017', 'cus_lcTheta', 'sub_lcThetaOld', true, interval '70 days'),
    ('in_lcThetaNew', '97530000-0000-4000-8000-000000000017', 'cus_lcTheta', 'sub_lcThetaNew', true, interval '10 days'),
    ('in_lcThetaTest', '97530000-0000-4000-8000-000000000017', 'cus_lcTheta', 'sub_lcThetaTest', false, interval '85 days'),
    ('in_lcIotaOld', '97530000-0000-4000-8000-000000000018', 'cus_lcIota', 'sub_lcIotaOld', true, interval '120 days'),
    ('in_lcIotaNew', '97530000-0000-4000-8000-000000000018', 'cus_lcIota', 'sub_lcIotaNew', true, interval '50 days')
  ) as i(id, tenant, customer, subscription, live, age);
insert into private.billing_invoices(stripe_invoice_id, tenant_id, stripe_customer_id, stripe_subscription_id, status, currency, total, subtotal, amount_due, amount_paid, amount_remaining, livemode, stripe_created, seen_at) values
  ('in_lcDelta0', '97530000-0000-4000-8000-000000000013', 'cus_lcDelta', 'sub_lcDelta', 'paid', 'usd', 0, 0, 0, 0, 0, true, now() - interval '80 days', now()),
  ('in_lcDelta1', '97530000-0000-4000-8000-000000000013', 'cus_lcDelta', 'sub_lcDelta', 'paid', 'usd', 4900, 4900, 4900, 4900, 0, true, now() - interval '50 days', now()),
  ('in_lcDelta2', '97530000-0000-4000-8000-000000000013', 'cus_lcDelta', 'sub_lcDelta', 'paid', 'usd', 4900, 4900, 4900, 4900, 0, true, now() - interval '20 days', now()),
  ('in_lcEpsilon', '97530000-0000-4000-8000-000000000014', 'cus_lcEpsilon', 'sub_lcEpsilon', 'paid', 'usd', 4900, 4900, 4900, 4900, 0, true, now() - interval '120 days', now());
insert into private.billing_usage_reports(product_id, tenant_id, metric, quantity, request_key, outcome, reported_at)
  select p.id, '97530000-0000-4000-8000-000000000013', 'facility', 2, gen_random_uuid(), 'updated', now() - interval '3 days' from hub.products p where p.slug = 'carebase';
-- The usage API accepts zero: Beta reported that it has nothing yet.
insert into private.billing_usage_reports(product_id, tenant_id, metric, quantity, request_key, outcome, reported_at)
  select p.id, '97530000-0000-4000-8000-000000000011', 'agency', 0, gen_random_uuid(), 'updated', now() - interval '1 day' from hub.products p where p.slug = 'caremetric-intel';
insert into hub.tenant_products(tenant_id, product_id, plan_code, status)
  select '97530000-0000-4000-8000-000000000013', p.id, 'core', 'active' from hub.products p where p.slug = 'carebase';
insert into hub.support_cases(id, tenant_id, product_id, requester_id, requester_display_name, subject, status, priority, resolved_at)
  select gen_random_uuid(), '97530000-0000-4000-8000-000000000013', p.id, '97530000-0000-4000-8000-000000000001', 'Requester', 'A subject that must not travel', c.status::hub.case_status, c.priority::hub.case_priority,
    case when c.status in ('resolved', 'closed') then now() - interval '1 day' end
  from hub.products p cross join (values ('open', 'urgent'), ('waiting_on_customer', 'high'), ('open', 'normal'), ('resolved', 'urgent')) as c(status, priority)
  where p.slug = 'carebase';

create temporary table lifecycle_snap on commit drop as select private.agent_lifecycle_json(10, null, null, 0) as j;
create temporary table lifecycle_rows on commit drop as
  select a ->> 'tenant' as tenant, a from lifecycle_snap, jsonb_array_elements(j -> 'accounts') a where a ->> 'tenant' like 'lifecycle-%';

select is((select array_agg(tenant order by tenant) from lifecycle_rows), array['lifecycle-alpha', 'lifecycle-beta', 'lifecycle-delta', 'lifecycle-theta', 'lifecycle-zeta'],
  'Live trials and accounts paying for at most 90 days: not test mode, not a suspended tenant, not an account that has paid for longer');
select ok(not exists (select 1 from lifecycle_rows where tenant = 'lifecycle-iota'),
  'An account that first paid long ago is not made new by a newer subscription');
select is((select array_agg(k order by k) from lifecycle_rows, jsonb_object_keys(a) k where tenant = 'lifecycle-alpha'),
  -- The trial path's facts (20261117230000_trial_path.sql): activeAt, cardConfirmedAt, countyChosen and firstValueAt.
  array['activeAt', 'cancelling', 'cardConfirmedAt', 'countyChosen', 'created', 'emails', 'firstPaidAt', 'firstValueAt', 'hasEmail', 'hasUsage', 'openUrgentCases', 'product', 'productName', 'status', 'suppressed', 'tenant', 'tenantName', 'trialEnd', 'trialStart'],
  'Each row has exactly the whitelisted facts');
select ok((select j::text !~ '(canary\.|Canary|example\.test|requester@|A subject that must not travel|(cus|sub|in)_lc)' from lifecycle_snap),
  'No address, contact name, case subject or Stripe identifier is anywhere in the facts');
select is((select jsonb_build_object('hasEmail', a -> 'hasEmail', 'suppressed', a -> 'suppressed', 'emails', a -> 'emails', 'status', a -> 'status', 'productName', a -> 'productName')
    from lifecycle_rows where tenant = 'lifecycle-alpha'),
  '{"hasEmail": true, "suppressed": false, "status": "trialing", "productName": "CareMetric CareBase", "emails": {"welcome": "rejected", "setup_nudge": null, "trial_checkin": null, "testimonial_ask": null, "cancel_save": null, "trial_ended": null, "card_reminder": null, "midtrial_nudge": null, "value_followup": null}}'::jsonb,
  'A trial says it has an address, and what became of each template''s email (read by its period key)');
select is((select a -> 'hasEmail' from lifecycle_rows where tenant = 'lifecycle-beta'), 'false'::jsonb, 'A blank billing address is no address');
select is((select a -> 'hasUsage' from lifecycle_rows where tenant = 'lifecycle-beta'), 'false'::jsonb,
  'A usage report of zero is no usage, so it never holds back the setup offer');
select ok((select (a ->> 'firstPaidAt')::timestamptz between now() - interval '70 days 1 minute' and now() - interval '69 days 23 hours' and a ->> 'status' = 'active'
    from lifecycle_rows where tenant = 'lifecycle-theta'),
  'The first payment is the account''s earliest paid invoice for the product, on a subscription it has since replaced, and never a test-mode one');
select is((select jsonb_build_array(a -> 'cancelling', a -> 'suppressed', a -> 'hasEmail') from lifecycle_rows where tenant = 'lifecycle-zeta'), '[true, true, true]'::jsonb,
  'A trial being cancelled says so, and an address that unsubscribed (hashed as bulk email hashes it, spacing and case aside) is flagged');
select ok((select (a ->> 'firstPaidAt')::timestamptz between now() - interval '50 days 1 minute' and now() - interval '49 days 23 hours'
    and a ->> 'status' = 'active' and (a ->> 'openUrgentCases')::integer = 2 and (a -> 'hasUsage')::boolean from lifecycle_rows where tenant = 'lifecycle-delta'),
  'A paying account''s first paid invoice is its first one with money paid; open high or urgent cases are counted; usage reports are seen');
select is((select jsonb_build_array((j ->> 'truncated')::boolean, jsonb_array_length(j -> 'accounts')) from (select private.agent_lifecycle_json(1, null, null, 0) as j) x), '[true, 1]'::jsonb,
  'A longer list is cut at the limit and says so');
select is((select jsonb_agg(e.a order by page, e.ord) from generate_series(0, 2) page,
    jsonb_array_elements(private.agent_lifecycle_json(2, null, null, page * 2) -> 'accounts') with ordinality as e(a, ord)),
  (select j -> 'accounts' from lifecycle_snap),
  'Pages read in turn give the same rows, in the same order, as one long read, so no account is left behind a page');
select is((select jsonb_agg((private.agent_lifecycle_json(2, null, null, page * 2) ->> 'truncated')::boolean order by page) from generate_series(0, 2) page),
  '[true, true, false]'::jsonb, 'Each page says whether more rows follow it');
select is((select jsonb_agg(a ->> 'tenant') from jsonb_array_elements(private.agent_lifecycle_json(10, 'lifecycle-beta', 'caremetric-intel', 0) -> 'accounts') a), '["lifecycle-beta"]'::jsonb,
  'The facts of one account and product can be read alone, for the check at send time');

-- The Stripe mode rule is the Billing workspace's, narrowed to live records: nothing from test mode, ever.
update private.billing_settings set livemode = false;
select is((select jsonb_build_array(j ->> 'mode', (select count(*) from jsonb_array_elements(j -> 'accounts') a where a ->> 'tenant' like 'lifecycle-%')) from (select private.agent_lifecycle_json(10, null, null, 0) as j) x),
  '["test", 0]'::jsonb, 'While the verified mode is test there is nothing to email');
update private.billing_settings set livemode = null;
select is((select jsonb_build_array(j ->> 'mode', (select count(*) from jsonb_array_elements(j -> 'accounts') a where a ->> 'tenant' like 'lifecycle-%')) from (select private.agent_lifecycle_json(10, null, null, 0) as j) x),
  '["unverified", 5]'::jsonb, 'While the mode is unverified only live records are read');

-- The server operations themselves (validation, the address lookup, the cap, the per-template rule and the unsubscribe link) are
-- exercised in server/agents-lifecycle-integration.mjs, which logs in as the real Hub server role: pgTAP cannot become it.

select * from finish();
rollback;
