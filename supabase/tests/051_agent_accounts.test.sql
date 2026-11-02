begin;
select plan(47);

-- ---------------------------------------------------------------------------------------
-- The boundary: one operation for the Hub server role, two internal helpers for nobody.
-- ---------------------------------------------------------------------------------------
select ok(p.prosecdef and p.proconfig @> array['search_path=""'],
  'The account snapshot is a security definer with a pinned empty search path')
from pg_proc p where p.oid = to_regprocedure('private.agent_accounts_snapshot(integer)');

select ok(p.proconfig @> array['search_path=""'] and not p.prosecdef,
  'The helpers pin an empty search path and run as their caller, the snapshot')
from pg_proc p where p.oid in (to_regprocedure('private.agent_accounts_json(integer)'), to_regprocedure('private.agent_subscription_facts(private.billing_subscriptions)'));

select ok(has_function_privilege('hub_app_server', 'private.agent_accounts_snapshot(integer)', 'execute'),
  'The Hub server role executes the account snapshot');

select ok(not bool_or(has_function_privilege(role_name, 'private.agent_accounts_snapshot(integer)', 'execute')),
  'No browser, service or public role executes the account snapshot')
from unnest(array['public', 'anon', 'authenticated', 'service_role']) as role_name;

select ok(not bool_or(has_function_privilege(role_name, signature, 'execute')),
  'No role at all, the Hub server included, executes the helpers directly')
from unnest(array['public', 'anon', 'authenticated', 'service_role', 'hub_app_server']) as role_name
cross join unnest(array['private.agent_accounts_json(integer)', 'private.agent_subscription_facts(private.billing_subscriptions)']) as signature;

select throws_ok('select private.agent_accounts_snapshot()', '42501', 'Application server required.',
  'Reading the snapshot refuses every session user other than the Hub server');

set local role authenticated;
select throws_ok('select private.agent_accounts_snapshot(10)', '42501', 'permission denied for function agent_accounts_snapshot',
  'Signed-in users cannot read the snapshot');
reset role;
set local role anon;
select throws_ok('select private.agent_accounts_snapshot(10)', '42501', null, 'Anonymous callers cannot read the snapshot');
reset role;

select ok(hub.get_backend_contract() -> 'features' @> '["platform.agents.accounts.v1"]'::jsonb,
  'The Account Manager is declared in release metadata');

select ok((select count(*) = 1 from private.agents where key = 'account_manager' and status = 'paused' and autonomy = 'observe' and model_tier = 'fast' and daily_budget_cents = 50),
  'The Account Manager is seeded paused and observe-only, on the fast tier with a 50 cent budget');
select ok((select count(*) = 1 from private.agent_schedules where agent_key = 'account_manager' and task_kind = 'accounts.weekly' and cadence = 'daily'
    and at_local = '07:15' and timezone = 'America/New_York' and not requires_session and next_run_at > now()),
  'Its weekly report is scheduled daily at 07:15 Eastern, with no owner session needed');

-- ---------------------------------------------------------------------------------------
-- Fixtures: invented accounts, a canary contact address and Stripe identifiers that must not appear.
-- ---------------------------------------------------------------------------------------
insert into auth.users(id, email, is_anonymous) values ('97510000-0000-4000-8000-000000000001', 'requester@example.invalid', false);
insert into hub.tenants(id, slug, name, status) values
  ('97510000-0000-4000-8000-000000000010', 'accounts-zeta', 'Zeta Account', 'active'),
  ('97510000-0000-4000-8000-000000000011', 'accounts-alpha', 'Alpha Account', 'active'),
  ('97510000-0000-4000-8000-000000000012', 'accounts-gamma', 'Gamma Test Mode', 'active'),
  ('97510000-0000-4000-8000-000000000013', 'accounts-delta', 'Delta No Billing', 'active');
insert into hub.tenant_products(tenant_id, product_id, plan_code, status)
  select t.id, p.id, 'core', 'active' from hub.tenants t cross join hub.products p
  where t.slug = 'accounts-zeta' and p.slug in ('carebase', 'pennsync');

update private.billing_settings set livemode = true;
insert into private.billing_customers(tenant_id, stripe_customer_id, email, name, delinquent, balance, livemode, seen_at) values
  ('97510000-0000-4000-8000-000000000010', 'cus_zetaCanary1', 'canary.contact@example.test', 'Canary Contact Name', false, 123, true, now()),
  ('97510000-0000-4000-8000-000000000011', 'cus_alphaCanary1', '', '', false, 0, true, now()),
  ('97510000-0000-4000-8000-000000000012', 'cus_gammaCanary1', 'test.mode@example.test', 'Test Mode', false, 0, false, now());
insert into private.billing_coupons(stripe_coupon_id, percent_off, duration, valid, livemode, stripe_created, seen_at) values
  ('cpn_pct20', 20, 'forever', true, true, now(), now());
insert into private.billing_coupons(stripe_coupon_id, percent_off, duration, valid, deleted, livemode, stripe_created, seen_at) values
  ('cpn_deleted', 10, 'forever', false, true, true, now(), now());
insert into private.billing_coupons(stripe_coupon_id, percent_off, duration, valid, livemode, stripe_created, seen_at) values
  ('cpn_testmode', 10, 'forever', true, false, now(), now());

insert into private.billing_subscriptions(stripe_subscription_id, tenant_id, stripe_customer_id, product_id, status, collection_method, current_period_end, discounts, livemode, stripe_created, seen_at)
  select 'sub_zetaCanary1', '97510000-0000-4000-8000-000000000010', 'cus_zetaCanary1', p.id, 'active', 'charge_automatically', now() + interval '20 days',
    '[{"id":"di_zetaCanary1","coupon":"cpn_pct20","promotion_code":null}]'::jsonb, true, now() - interval '120 days', now()
  from hub.products p where p.slug = 'carebase';
insert into private.billing_subscriptions(stripe_subscription_id, tenant_id, stripe_customer_id, product_id, status, collection_method, canceled_at, ended_at, livemode, stripe_created, seen_at)
  select 'sub_zetaCanary2', '97510000-0000-4000-8000-000000000010', 'cus_zetaCanary1', p.id, 'canceled', 'charge_automatically', now() - interval '3 days', now() - interval '3 days', true, now() - interval '300 days', now()
  from hub.products p where p.slug = 'carebase';
insert into private.billing_subscriptions(stripe_subscription_id, tenant_id, stripe_customer_id, product_id, status, collection_method, trial_end, livemode, stripe_created, seen_at)
  select 'sub_alphaCanary1', '97510000-0000-4000-8000-000000000011', 'cus_alphaCanary1', p.id, 'trialing', 'charge_automatically', now() + interval '3 days', true, now() - interval '5 days', now()
  from hub.products p where p.slug = 'breathe';
insert into private.billing_subscriptions(stripe_subscription_id, tenant_id, stripe_customer_id, product_id, status, collection_method, livemode, stripe_created, seen_at)
  select 'sub_gammaCanary1', '97510000-0000-4000-8000-000000000012', 'cus_gammaCanary1', p.id, 'active', 'charge_automatically', false, now() - interval '60 days', now()
  from hub.products p where p.slug = 'carebase';
insert into private.billing_subscription_items(stripe_item_id, stripe_subscription_id, stripe_price_id, stripe_product_id, quantity, unit_amount, currency, recurring_interval, interval_count) values
  ('si_zetaCanary1', 'sub_zetaCanary1', 'price_zetaCanaryA', 'prod_zetaCanaryA', 2, 4900, 'usd', 'month', 1),
  ('si_zetaCanary2', 'sub_zetaCanary1', 'price_zetaCanaryB', 'prod_zetaCanaryB', 1, 2000, 'usd', 'month', 1),
  ('si_alphaCanary1', 'sub_alphaCanary1', 'price_alphaCanaryA', 'prod_alphaCanaryA', 1, 4900, 'usd', 'month', 1);

insert into private.billing_invoices(stripe_invoice_id, tenant_id, stripe_customer_id, stripe_subscription_id, status, currency, total, subtotal, amount_due, amount_paid, amount_remaining, due_date, livemode, stripe_created, seen_at) values
  ('in_zetaCanary1', '97510000-0000-4000-8000-000000000010', 'cus_zetaCanary1', 'sub_zetaCanary1', 'open', 'usd', 4900, 4900, 4900, 0, 4900, now() - interval '10 days', true, now() - interval '40 days', now()),
  ('in_zetaCanary2', '97510000-0000-4000-8000-000000000010', 'cus_zetaCanary1', 'sub_zetaCanary1', 'open', 'usd', 2000, 2000, 2000, 0, 2000, now() - interval '1 day', true, now() - interval '30 days', now()),
  ('in_zetaCanary3', '97510000-0000-4000-8000-000000000010', 'cus_zetaCanary1', 'sub_zetaCanary1', 'open', 'usd', 1500, 1500, 1500, 0, 1500, null, true, now() - interval '5 days', now()),
  ('in_zetaCanary4', '97510000-0000-4000-8000-000000000010', 'cus_zetaCanary1', 'sub_zetaCanary1', 'paid', 'usd', 4900, 4900, 4900, 4900, 0, null, true, now() - interval '20 days', now()),
  ('in_zetaCanary5', '97510000-0000-4000-8000-000000000010', 'cus_zetaCanary1', 'sub_zetaCanary1', 'draft', 'usd', 900, 900, 900, 0, 900, null, true, now() - interval '2 days', now()),
  ('in_zetaCanary6', '97510000-0000-4000-8000-000000000010', 'cus_zetaCanary1', null, 'open', 'usd', 700, 700, 700, 0, 700, now() - interval '30 days', false, now() - interval '60 days', now());

insert into private.billing_usage_reports(product_id, tenant_id, metric, quantity, request_key, outcome, reported_at)
  select p.id, '97510000-0000-4000-8000-000000000010', 'facility', r.quantity, gen_random_uuid(), 'updated', now() - r.age
  from hub.products p cross join (values (10, interval '40 days'), (12, interval '30 days'), (14, interval '10 days'), (15, interval '1 day')) as r(quantity, age)
  where p.slug = 'carebase';
insert into private.billing_usage_reports(product_id, tenant_id, metric, quantity, request_key, outcome, reported_at)
  select p.id, '97510000-0000-4000-8000-000000000010', 'seat', 5, gen_random_uuid(), 'unchanged', now() - interval '2 days' from hub.products p where p.slug = 'carebase';
insert into private.billing_usage_reports(product_id, tenant_id, metric, quantity, request_key, outcome, reported_at)
  select p.id, '97510000-0000-4000-8000-000000000010', 'facility', 99, gen_random_uuid(), 'updated', now() - interval '1 day' from hub.products p where p.slug = 'pennsync';

insert into hub.support_cases(id, tenant_id, product_id, requester_id, requester_display_name, subject, status, priority, created_at, resolved_at)
  select gen_random_uuid(), '97510000-0000-4000-8000-000000000010', p.id, '97510000-0000-4000-8000-000000000001', 'Requester', 'A subject that must not travel', c.status::hub.case_status, c.priority::hub.case_priority, now() - c.age,
    case when c.status in ('resolved', 'closed') then now() - interval '1 day' end
  from hub.products p join (values
    ('carebase', 'open', 'normal', interval '2 days'), ('carebase', 'open', 'low', interval '9 days'), ('carebase', 'in_progress', 'urgent', interval '4 days'),
    ('carebase', 'waiting_on_customer', 'high', interval '6 days'), ('carebase', 'resolved', 'normal', interval '12 days'), ('pennsync', 'open', 'urgent', interval '30 days')
  ) as c(slug, status, priority, age) on c.slug = p.slug;

-- ---------------------------------------------------------------------------------------
-- What the snapshot says.
-- ---------------------------------------------------------------------------------------
create temp table snap as select private.agent_accounts_json(10) as j;

select is((select j ->> 'mode' from snap), 'live', 'It says which Stripe mode it reads');
select is((select (j ->> 'total')::integer from snap), 2, 'Only live accounts with a customer or a subscription count: not the test-mode one, not the one with no billing');
select is((select jsonb_agg(a ->> 'name') from snap, jsonb_array_elements(j -> 'accounts') a), '["Alpha Account", "Zeta Account"]'::jsonb, 'Accounts come by name');
select is((select (j ->> 'truncated')::boolean from snap), false, 'A list that fits is not truncated');
select is((select jsonb_build_array((private.agent_accounts_json(1) ->> 'truncated')::boolean, jsonb_array_length(private.agent_accounts_json(1) -> 'accounts'), (private.agent_accounts_json(1) ->> 'total')::integer)),
  '[true, 1, 2]'::jsonb, 'A longer list is cut at the limit and says so');

select is((select array_agg(k order by k) from snap, jsonb_object_keys((j -> 'accounts' -> 1)) k),
  array['cases', 'createdAt', 'customer', 'invoices', 'name', 'products', 'slug', 'status', 'subscriptions', 'usage'],
  'An account has exactly the whitelisted keys');
select is((select array_agg(k order by k) from snap, jsonb_object_keys(j -> 'accounts' -> 1 -> 'customer') k), array['balanceCents', 'delinquent', 'hasEmail'],
  'The customer is three flags, never a name or an address');
select is((select array_agg(k order by k) from snap, jsonb_object_keys(j -> 'accounts' -> 1 -> 'subscriptions' -> 0) k),
  array['app', 'cancel_at', 'cancel_at_period_end', 'canceled_at', 'collection_method', 'created', 'current_period_end', 'discounts', 'ended_at', 'items', 'status', 'trial_end'],
  'A subscription has exactly the whitelisted keys, with no identifier');
select is((select array_agg(k order by k) from snap, jsonb_object_keys(j -> 'accounts' -> 1 -> 'subscriptions' -> 0 -> 'items' -> 0) k),
  array['currency', 'interval', 'interval_count', 'kind', 'product', 'quantity', 'unit_amount'], 'An item has exactly the whitelisted keys');
select is((select array_agg(k order by k) from snap, jsonb_object_keys(j -> 'accounts' -> 1 -> 'invoices') k),
  array['latestPaidAt', 'oldestOverdueDue', 'open', 'overdue', 'remainingCents'], 'Invoices are aggregates only');
select is((select array_agg(k order by k) from snap, jsonb_object_keys(j -> 'accounts' -> 1 -> 'usage' -> 0) k),
  array['app', 'baseline', 'baselineAt', 'latest', 'latestAt', 'metric'], 'A usage entry has exactly the whitelisted keys');
select is((select array_agg(k order by k) from snap, jsonb_object_keys(j -> 'accounts' -> 1 -> 'cases') k),
  array['highOrUrgent', 'oldestOpenAt', 'waitingOnCustomer', 'waitingOnYou'], 'Cases are counts and one time');

select ok((select j::text !~ '(canary\.contact|Canary Contact Name|test\.mode@|requester@example|A subject that must not travel|(cus|sub|in|si|price|di)_[A-Za-z0-9]{4,})' from snap),
  'No contact address, name, case subject, or Stripe customer, subscription, invoice, item, price or discount identifier is anywhere in the snapshot');

select is((select j -> 'accounts' -> 1 -> 'customer' from snap), '{"delinquent": false, "hasEmail": true, "balanceCents": 123}'::jsonb, 'A customer with an address is flagged hasEmail and nothing more');
select is((select j -> 'accounts' -> 0 -> 'customer' ->> 'hasEmail' from snap), 'false', 'A customer with a blank address is flagged without one');
select is((select j -> 'accounts' -> 1 -> 'products' from snap), '[{"slug": "carebase", "status": "active", "planCode": "core"}]'::jsonb, 'Products are the live ones only: a retired product is left out');

select is((select jsonb_array_length(j -> 'accounts' -> 1 -> 'subscriptions') from snap), 2, 'Every subscription of the account is listed, canceled ones included');
select is((select s -> 'items' from snap, jsonb_array_elements(j -> 'accounts' -> 1 -> 'subscriptions') s where s ->> 'status' = 'active'),
  '[{"kind": "plan", "product": "prod_zetaCanaryA", "currency": "usd", "interval": "month", "quantity": 2, "unit_amount": 4900, "interval_count": 1}, {"kind": "plan", "product": "prod_zetaCanaryB", "currency": "usd", "interval": "month", "quantity": 1, "unit_amount": 2000, "interval_count": 1}]'::jsonb,
  'Items carry what the revenue maths reads, with the product id that coupons are scoped by');
select is((select s -> 'discounts' from snap, jsonb_array_elements(j -> 'accounts' -> 1 -> 'subscriptions') s where s ->> 'status' = 'active'), '[{"coupon": "cpn_pct20"}]'::jsonb,
  'A discount is its coupon id alone');
select is((select j -> 'coupons' from snap), '[{"id": "cpn_pct20", "applies_to": [], "amount_off": null, "percent_off": 20.00}]'::jsonb, 'Coupons are the live, undeleted ones the maths needs');

select is((select (j -> 'accounts' -> 1 -> 'invoices') - 'oldestOverdueDue' - 'latestPaidAt' from snap), '{"open": 3, "overdue": 2, "remainingCents": 8400}'::jsonb,
  'Open invoices count as overdue three days after their due date, or after they were created when they have none; other modes and drafts are ignored');
select ok((select (j -> 'accounts' -> 1 -> 'invoices' ->> 'oldestOverdueDue')::timestamptz between now() - interval '10 days 1 minute' and now() - interval '9 days 23 hours'
    and (j -> 'accounts' -> 1 -> 'invoices' ->> 'latestPaidAt')::timestamptz between now() - interval '20 days 1 minute' and now() - interval '19 days 23 hours' from snap),
  'The oldest overdue date and the latest paid time are the invoices'' own');

select is((select jsonb_agg(jsonb_build_object('metric', u ->> 'metric', 'latest', u -> 'latest', 'baseline', u -> 'baseline') order by u ->> 'metric') from snap, jsonb_array_elements(j -> 'accounts' -> 1 -> 'usage') u),
  '[{"metric": "facility", "latest": 15, "baseline": 12}, {"metric": "seat", "latest": 5, "baseline": null}]'::jsonb,
  'Usage is the latest report against the newest one at least 28 days older, with no baseline when there is none, and a retired product''s reports are left out');

select is((select (j -> 'accounts' -> 1 -> 'cases') - 'oldestOpenAt' from snap), '{"waitingOnYou": 3, "highOrUrgent": 1, "waitingOnCustomer": 1}'::jsonb,
  'Cases are counted by who they wait on, and a retired product''s case is left out');
select ok((select (j -> 'accounts' -> 1 -> 'cases' ->> 'oldestOpenAt')::timestamptz between now() - interval '9 days 1 minute' and now() - interval '8 days 23 hours' from snap),
  'The oldest open case is a time, never a subject');

select is((select j -> 'accounts' -> 0 -> 'subscriptions' -> 0 ->> 'status' from snap), 'trialing', 'A trial is listed as one');
select is((select jsonb_array_length(j -> 'accounts' -> 0 -> 'usage') from snap), 0, 'An account with no usage reports has none listed');

-- The Stripe mode filter is the Billing workspace's.
update private.billing_settings set livemode = null;
select is((select jsonb_build_array(private.agent_accounts_json(10) ->> 'mode', (private.agent_accounts_json(10) ->> 'total')::integer)), '["unverified", 3]'::jsonb,
  'While the mode is unverified everything is read, and the answer says so');
update private.billing_settings set livemode = false;
select is((select jsonb_build_array(private.agent_accounts_json(10) ->> 'mode', (private.agent_accounts_json(10) ->> 'total')::integer, private.agent_accounts_json(10) -> 'accounts' -> 0 ->> 'name')), '["test", 1, "Gamma Test Mode"]'::jsonb,
  'In test mode only test data is read');
update private.billing_settings set livemode = true;

-- Closed tenants are reported with their status, and retired products never count.
update hub.tenants set status = 'closed' where slug = 'accounts-zeta';
select is((select private.agent_accounts_json(10) -> 'accounts' -> 1 ->> 'status'), 'closed', 'A closed tenant is still listed, with its status, for the report to judge');
update hub.tenants set status = 'active' where slug = 'accounts-zeta';

-- ---------------------------------------------------------------------------------------
-- Through the server operation, as the Hub server role. That role cannot call pgTAP, so what it does is
-- recorded in a temp table and checked afterwards.
-- ---------------------------------------------------------------------------------------
create function pg_temp.attempt(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return 'ok';
exception when others then
  return sqlstate || ': ' || sqlerrm;
end;
$$;
set local session authorization hub_app_server;
create temp table server_results as select
  pg_temp.attempt('select private.agent_accounts_snapshot(0)') as below,
  pg_temp.attempt('select private.agent_accounts_snapshot(501)') as above,
  pg_temp.attempt('select private.agent_accounts_snapshot(null)') as missing,
  private.agent_accounts_snapshot(10) as snapshot,
  jsonb_array_length(private.agent_accounts_snapshot() -> 'accounts') as default_count;
reset session authorization;
select is((select below from server_results), '22023: Choose a limit between 1 and 500.', 'A limit below 1 is refused');
select is((select above from server_results), '22023: Choose a limit between 1 and 500.', 'A limit above 500 is refused');
select is((select missing from server_results), '22023: Choose a limit between 1 and 500.', 'No limit is refused');
select is((select snapshot - 'generatedAt' from server_results), (select j - 'generatedAt' from snap), 'The server role gets exactly what the helper builds');
select is((select default_count from server_results), 2, 'The default limit covers a small book');

select * from finish();
rollback;
