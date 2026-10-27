// Real PostgreSQL, real Hub sessions and a local fake of the Stripe API. Never run against a hosted database.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { digest } from './sms-auth.mjs';
import { gateway } from './gateway.mjs';
import { platformBilling } from './billing.mjs';
import { signStripePayload } from './stripe.mjs';
import { fakeStripe } from './fixtures/fake-stripe.mjs';

const databaseUrl = process.env.HUB_TEST_DATABASE_URL;
const local = new URL(databaseUrl); assert.equal(local.hostname, '127.0.0.1'); assert.equal(local.port, '54322');
const admin = new pg.Pool({ connectionString: databaseUrl });
await admin.query("alter role hub_app_server login password 'ephemeral-test-only'");
const appUrl = new URL(databaseUrl); appUrl.username = 'hub_app_server'; appUrl.password = 'ephemeral-test-only';
const pool = new pg.Pool({ connectionString: appUrl.href }); const api = gateway(pool);
const owner = randomUUID(), member = randomUUID();
const ownerToken = 'billing-owner-' + randomUUID(), staleToken = 'billing-stale-' + randomUUID(), memberToken = 'billing-member-' + randomUUID();
const suffix = randomUUID().slice(0, 8);
const tenantIds = [];
const stripe = fakeStripe();
const other = fakeStripe({ accountId: 'acct_someoneelse' });
const webhookSecret = 'whsec_' + randomUUID().replaceAll('-', '');
const rpc = (name, args = {}, token = ownerToken) => api.rpc(name, args, token);
const key = () => randomUUID();
const product = async slug => (await admin.query('select id from hub.products where slug=$1', [slug])).rows[0].id;
let billing;
const command = (input, token = ownerToken) => billing.command(token, input);
const workspace = () => rpc('billing_workspace');
const customer = id => rpc('billing_customer', { p_tenant_id: id });
const sendEvent = async (event, secret = webhookSecret, target = billing) => {
  const raw = Buffer.from(JSON.stringify(event));
  return target.webhook(raw, signStripePayload(raw.toString(), secret));
};
const contractMigration = await readFile(new URL('../supabase/migrations/20261027120100_platform_billing_contract.sql', import.meta.url), 'utf8');

try {
  // The deployment gate is idempotent and refuses an opened table or function.
  const contractConnection = await admin.connect();
  try {
    const current = (await contractConnection.query('select hub.get_backend_contract() as data')).rows[0].data;
    assert.ok(current.features.includes('billing.platform.v1'));
    for (const retired of ['billing.portal.v1', 'billing.checkout.v1', 'platform.admin.tenants.v1']) assert.equal(current.features.includes(retired), false, retired);
    await contractConnection.query(contractMigration);
    assert.deepEqual((await contractConnection.query('select hub.get_backend_contract() as data')).rows[0].data, current, 'declaration is idempotent');
    for (const change of [
      'alter table private.billing_subscriptions disable row level security',
      'grant select on private.billing_invoices to authenticated',
      'grant select on private.billing_customers to hub_app_server',
      'grant execute on function private.billing_sync(text,jsonb,timestamptz) to authenticated',
      'grant execute on function private.billing_entitlements(uuid,uuid) to hub_app_server',
      'grant execute on function hub.billing_workspace() to anon',
      "create or replace function hub.billing_customer(p_tenant_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$ begin return null; end $$",
    ]) {
      await contractConnection.query('begin');
      try { await contractConnection.query(change); await assert.rejects(contractConnection.query(contractMigration), error => error.code === '55000', change); }
      finally { await contractConnection.query('rollback'); }
    }
  } finally { contractConnection.release(); }

  await admin.query("insert into auth.users(id,email,is_anonymous) values($1,'billing-owner@test.invalid',false),($2,'billing-member@test.invalid',false)", [owner, member]);
  await admin.query("insert into private.staff_permissions(user_id,permission) values($1,'platform.admin')", [owner]);
  await admin.query("insert into private.sms_identities(user_id,phone_e164,verified_at) values($1,'+12025550931',now()),($2,'+12025550932',now())", [owner, member]);
  for (const [user, token, hours] of [[owner, ownerToken, '0'], [owner, staleToken, '9'], [member, memberToken, '0']]) {
    await admin.query("insert into private.sms_sessions(id,token_hash,user_id,identity_version,created_at,expires_at) select $1,$2,user_id,identity_version,now()-make_interval(hours=>$4::int),now()+interval '1 hour' from private.sms_identities where user_id=$3", [randomUUID(), digest(token), user, hours]);
  }

  // A key for another Stripe account is refused before any change.
  const stranger = platformBilling({ pool, secretKey: 'sk_test_stranger', apiBase: await other.listen(), publicOrigin: 'https://hub.test', log: { warn() {} } });
  assert.equal(await stranger.start(), false);
  assert.equal(stranger.status().state, 'account_mismatch');
  await assert.rejects(stranger.command(ownerToken, { action: 'catalog.sync' }), error => error.status === 503 && /different Stripe account/.test(error.message));
  await other.close();

  billing = platformBilling({ pool, secretKey: 'sk_test_hub', webhookSecrets: [webhookSecret], apiBase: await stripe.listen(), publicOrigin: 'https://hub.test', log: { warn() {} } });
  assert.equal(await billing.start(), true);
  assert.equal((await workspace()).mode, 'test');
  assert.ok(stripe.requests.every(request => request.version === '2026-02-25.clover'), 'every call pins the API version');

  // Reads need the current administrator session; changes need the command session.
  await assert.rejects(rpc('billing_workspace', {}, null));
  await assert.rejects(rpc('billing_workspace', {}, memberToken));
  assert.equal((await rpc('billing_workspace', {}, staleToken)).mode, 'test', 'an older session can still read');
  await assert.rejects(pool.query('select * from private.billing_subscriptions'), 'the server role has no direct table access');
  const tenant = (await rpc('create_tenant', { p_record: { name: 'Synthetic Billing Agency ' + suffix, slug: 'synthetic-billing-' + suffix, industry: 'Home health' } })).id;
  tenantIds.push(tenant);
  await assert.rejects(rpc('create_tenant', { p_record: { name: 'Reserved', slug: 'carebase-' + suffix, industry: '' } }));
  await assert.rejects(command({ action: 'customer.save', tenant_id: tenant, email: 'billing@test.invalid', name: 'Synthetic', expected_version: 0, request_key: key() }, staleToken), 'changes need a command session started within eight hours');
  await assert.rejects(command({ action: 'customer.save', tenant_id: tenant, email: 'billing@test.invalid', name: 'Synthetic', expected_version: 0, request_key: key() }, memberToken));
  await assert.rejects(command({ action: 'customer.save', tenant_id: tenant, email: 'not-an-email', name: 'Synthetic', expected_version: 0, request_key: key() }), error => error.status === 400);
  await assert.rejects(command({ action: 'customer.save', tenant_id: tenant, email: 'billing@test.invalid', name: 'Synthetic', expected_version: 0, request_key: key(), extra: true }), error => error.status === 400);

  // Billing contact: one Stripe customer per tenant, tagged with the tenant.
  const contactKey = key();
  await command({ action: 'customer.save', tenant_id: tenant, email: 'billing@test.invalid', name: 'Synthetic Billing', expected_version: 0, request_key: contactKey });
  let detail = await customer(tenant);
  assert.match(detail.customer.id, /^cus_/);
  assert.equal(stripe.store.customers.get(detail.customer.id).metadata.hub_tenant_id, tenant);
  await assert.rejects(command({ action: 'customer.save', tenant_id: tenant, email: 'b@test.invalid', name: 'X', expected_version: 0, request_key: key() }), error => error.status === 409, 'a stale version never overwrites');
  await command({ action: 'customer.save', tenant_id: tenant, email: 'accounts@test.invalid', name: 'Synthetic Billing', expected_version: detail.customer.version, request_key: key() });
  assert.equal(stripe.store.customers.size, 1, 'an update never creates a second customer');

  // Catalog: per-facility plan and add-on, monthly and annual.
  const plan = (await command({ action: 'product.create', app: 'carebase', name: 'Core ' + suffix, description: 'Base plan', kind: 'plan', unit_label: 'facility', entitlement_key: 'core', request_key: key() })).id;
  const addon = (await command({ action: 'product.create', app: 'carebase', name: 'eMAR ' + suffix, description: '', kind: 'addon', unit_label: 'facility', entitlement_key: 'emar', request_key: key() })).id;
  const planMonthly = (await command({ action: 'price.create', product: plan, pricing_model: 'per_unit', type: 'recurring', interval: 'month', unit_amount: 19900, nickname: 'Core monthly', tenant_id: null, request_key: key() })).id;
  await command({ action: 'price.create', product: plan, pricing_model: 'per_unit', type: 'recurring', interval: 'year', unit_amount: 199000, nickname: '', tenant_id: null, request_key: key() });
  const addonMonthly = (await command({ action: 'price.create', product: addon, pricing_model: 'per_unit', type: 'recurring', interval: 'month', unit_amount: 14900, nickname: '', tenant_id: null, request_key: key() })).id;
  const fee = (await command({ action: 'product.create', app: 'carebase', name: 'Onboarding ' + suffix, description: '', kind: 'fee', unit_label: '', entitlement_key: '', request_key: key() })).id;
  const onboarding = (await command({ action: 'price.create', product: fee, pricing_model: 'flat', type: 'one_time', interval: null, unit_amount: 50000, nickname: '', tenant_id: null, request_key: key() })).id;
  let space = await workspace();
  assert.equal(space.products.find(item => item.id === plan).entitlement_key, 'core');
  assert.equal(space.prices.find(item => item.id === planMonthly).pricing_model, 'per_unit');
  assert.deepEqual(stripe.store.prices.get(planMonthly).metadata, { app: 'carebase', pricing_model: 'per_unit', billing_metric: 'facility' });

  // Subscribe: plan plus add-on, three facilities, the onboarding fee on the first invoice, invoices emailed.
  const subscriptionKey = key();
  const create = { action: 'subscription.create', tenant_id: tenant, app: 'carebase', items: [{ price: planMonthly, quantity: 3 }, { price: addonMonthly, quantity: 3 }, { price: onboarding, quantity: 1 }], trial_days: 0, collection_method: 'send_invoice', days_until_due: 30, coupon: null, promotion_code: null, request_key: subscriptionKey };
  await assert.rejects(command({ ...create, items: [{ price: onboarding, quantity: 1 }], request_key: key() }), error => error.status === 400, 'a subscription needs a recurring price');
  const subscriptionId = (await command(create)).id;
  assert.equal((await command(create)).id, subscriptionId, 'a retried request key never creates a second subscription');
  assert.equal(stripe.store.subscriptions.size, 1);
  await assert.rejects(command({ ...create, items: [{ price: planMonthly, quantity: 1 }], app: 'breathe', request_key: key() }), error => error.status === 400, 'a price must belong to the chosen application');
  detail = await customer(tenant);
  let sub = detail.subscriptions[0];
  assert.deepEqual([sub.app, sub.status, sub.items.length, sub.items.map(item => item.quantity)], ['carebase', 'active', 2, [3, 3]]);
  assert.equal(detail.invoices[0].status, 'open');
  assert.equal(detail.invoices[0].total, 19900 * 3 + 14900 * 3 + 50000, 'the one-time fee is on the first invoice, not a subscription item');
  assert.deepEqual(stripe.requests.find(request => request.path === '/v1/subscriptions' && request.params.add_invoice_items).params.add_invoice_items, [{ price: onboarding, quantity: '1' }]);
  assert.equal((await admin.query('select count(*)::int as n from hub.tenant_products where tenant_id=$1', [tenant])).rows[0].n, 1, 'a subscribed application becomes a tenant application');

  // Applications: key, account link, entitlements, usage.
  const carebaseKey = (await command({ action: 'app_key.issue', app: 'carebase' })).key;
  assert.match(carebaseKey, /^cmb_[A-Za-z0-9_-]{43}$/);
  const bearer = 'Bearer ' + carebaseKey;
  const account = randomUUID();
  await assert.rejects(billing.entitlements('Bearer cmb_' + 'x'.repeat(43), { account }), error => error.status === 401);
  let entitlement = await billing.entitlements(bearer, { account });
  assert.deepEqual([entitlement.linked, entitlement.entitled, entitlement.status], [false, false, 'none'], 'an unlinked account has nothing, never everything');
  await command({ action: 'account.link', tenant_id: tenant, app: 'carebase', account, expected_version: 0 });
  entitlement = await billing.entitlements(bearer, { account });
  assert.deepEqual([entitlement.linked, entitlement.entitled, entitlement.status, entitlement.cache_ttl_seconds], [true, true, 'active', 300]);
  assert.deepEqual(entitlement.products.map(item => [item.key, item.kind, item.quantity]).sort(), [['core', 'plan', 3], ['emar', 'addon', 3]]);
  const breatheKey = (await command({ action: 'app_key.issue', app: 'breathe' })).key;
  assert.equal((await billing.entitlements('Bearer ' + breatheKey, { account })).linked, false, 'a key answers only for its own application');

  const usageKey = key();
  let usage = await billing.usage(bearer, { account, metric: 'facility', quantity: 5, request_key: usageKey });
  assert.deepEqual([usage.outcome, usage.items_updated], ['updated', 2]);
  assert.deepEqual([...stripe.store.subscriptions.get(subscriptionId).items.data.map(item => item.quantity)], [5, 5]);
  assert.ok(stripe.requests.filter(request => request.path.startsWith('/v1/subscription_items/')).every(request => request.params.proration_behavior === 'none'));
  usage = await billing.usage(bearer, { account, metric: 'facility', quantity: 5, request_key: usageKey });
  assert.equal(usage.duplicate, true, 'a retried report is a no-op');
  assert.equal((await billing.usage(bearer, { account, metric: 'facility', quantity: 5, request_key: key() })).outcome, 'unchanged');
  assert.equal((await billing.usage(bearer, { account: randomUUID(), metric: 'facility', quantity: 5, request_key: key() })).outcome, 'not_linked');

  // Change a price: grandfather the add-on, move the plan now with proration.
  space = await workspace();
  const addonPrice = space.prices.find(item => item.id === addonMonthly);
  const addonNew = (await command({ action: 'price.change', price: addonMonthly, unit_amount: 15900, migrate: 'grandfather', expected_version: addonPrice.version, request_key: key() })).id;
  assert.equal(stripe.store.prices.get(addonMonthly).active, false, 'the old price is archived, never deleted');
  assert.equal(stripe.store.prices.get(addonNew).metadata.hub_replaces, addonMonthly);
  assert.ok(stripe.store.subscriptions.get(subscriptionId).items.data.some(item => item.price.id === addonMonthly), 'grandfathered subscribers keep their price');
  const planPrice = (await workspace()).prices.find(item => item.id === planMonthly);
  const moved = await command({ action: 'price.change', price: planMonthly, unit_amount: 21900, migrate: 'prorate', expected_version: planPrice.version, request_key: key() });
  assert.deepEqual([moved.migrated, moved.failed], [1, 0]);
  assert.ok(stripe.store.subscriptions.get(subscriptionId).items.data.some(item => item.price.id === moved.id && item.quantity === 5), 'moved subscribers keep their quantity');
  assert.equal(stripe.requests.filter(request => request.path.startsWith('/v1/subscription_items/') && request.params.price === moved.id)[0].params.proration_behavior, 'create_prorations');
  await assert.rejects(command({ action: 'price.change', price: planMonthly, unit_amount: 1, migrate: 'grandfather', expected_version: planPrice.version, request_key: key() }), error => error.status === 400, 'an archived price cannot change again');

  // Discounts: an application-limited coupon, a promotion code, apply and remove.
  const coupon = (await command({ action: 'coupon.create', name: 'Partner 20', percent_off: 20, amount_off: null, duration: 'forever', duration_in_months: null, max_redemptions: 10, redeem_by: null, app: 'carebase', products: [], request_key: key() })).id;
  assert.ok(stripe.store.coupons.get(coupon).applies_to.products.includes(plan), 'an application coupon applies to its products');
  const code = (await command({ action: 'promotion_code.create', coupon, code: 'SAVE' + suffix.slice(0, 4).toUpperCase(), max_redemptions: 5, expires_at: null, first_time_transaction: false, minimum_amount: null, tenant_id: tenant, request_key: key() })).id;
  assert.equal(stripe.store.promotion_codes.get(code).customer, detail.customer.id);
  sub = (await customer(tenant)).subscriptions[0];
  await command({ action: 'subscription.discount', subscription: subscriptionId, op: 'apply', coupon, promotion_code: null, expected_version: sub.version, request_key: key() });
  sub = (await customer(tenant)).subscriptions[0];
  assert.equal(sub.discounts[0].coupon, coupon);
  await command({ action: 'subscription.discount', subscription: subscriptionId, op: 'remove', coupon, promotion_code: null, expected_version: sub.version, request_key: key() });
  sub = (await customer(tenant)).subscriptions[0];
  assert.deepEqual(sub.discounts, []);
  await command({ action: 'subscription.discount', subscription: subscriptionId, op: 'apply', coupon: null, promotion_code: code, expected_version: sub.version, request_key: key() });
  sub = (await customer(tenant)).subscriptions[0];
  assert.deepEqual([sub.discounts[0].coupon, sub.discounts[0].promotion_code], [coupon, code]);
  space = await workspace();
  assert.equal(space.promotion_codes.find(item => item.id === code).times_redeemed, 1);
  await command({ action: 'promotion_code.update', promotion_code: code, active: false, expected_version: space.promotion_codes.find(item => item.id === code).version, request_key: key() });
  assert.equal(stripe.store.promotion_codes.get(code).active, false);

  // A customer-specific price, visible only on this customer.
  const custom = (await command({ action: 'price.create', product: plan, pricing_model: 'per_unit', type: 'recurring', interval: 'month', unit_amount: 9900, nickname: 'Negotiated', tenant_id: tenant, request_key: key() })).id;
  detail = await customer(tenant);
  assert.deepEqual(detail.custom_prices.map(item => item.id), [custom]);
  assert.equal((await workspace()).prices.some(item => item.id === custom), false);
  sub = detail.subscriptions[0];
  const planItem = sub.items.find(item => item.kind === 'plan');
  await command({ action: 'subscription.item.update', subscription: subscriptionId, item: planItem.id, price: custom, quantity: null, proration: 'none', expected_version: sub.version, request_key: key() });
  sub = (await customer(tenant)).subscriptions[0];
  assert.equal(sub.items.find(item => item.id === planItem.id).custom, true);
  const otherTenant = (await rpc('create_tenant', { p_record: { name: 'Other Billing ' + suffix, slug: 'other-billing-' + suffix, industry: '' } })).id;
  tenantIds.push(otherTenant);
  await command({ action: 'customer.save', tenant_id: otherTenant, email: 'other@test.invalid', name: 'Other', expected_version: 0, request_key: key() });
  await assert.rejects(command({ ...create, tenant_id: otherTenant, items: [{ price: custom, quantity: 1 }], request_key: key() }), error => error.status === 400, "another customer's custom price is refused");

  // Quantity, trial, pause, cancel.
  await command({ action: 'subscription.item.update', subscription: subscriptionId, item: planItem.id, price: null, quantity: 7, proration: 'create_prorations', expected_version: sub.version, request_key: key() });
  sub = (await customer(tenant)).subscriptions[0];
  assert.equal(sub.items.find(item => item.id === planItem.id).quantity, 7);
  // A one-time fee added later goes on the next invoice and never becomes a subscription item.
  await command({ action: 'subscription.item.add', subscription: subscriptionId, price: onboarding, quantity: 1, proration: 'none', expected_version: sub.version, request_key: key() });
  assert.equal(stripe.store.subscriptions.get(subscriptionId).pending_fees, 50000);
  sub = (await customer(tenant)).subscriptions[0];
  assert.equal(sub.items.length, 2);
  const trialEnd = new Date(Date.now() + 20 * 86400000).toISOString().slice(0, 10);
  await command({ action: 'subscription.trial', subscription: subscriptionId, trial_end: trialEnd, expected_version: sub.version, request_key: key() });
  sub = (await customer(tenant)).subscriptions[0];
  assert.equal(sub.status, 'trialing');
  assert.equal((await billing.entitlements(bearer, { account })).status, 'trialing');
  await command({ action: 'subscription.pause', subscription: subscriptionId, behavior: 'void', resumes_at: null, expected_version: sub.version, request_key: key() });
  sub = (await customer(tenant)).subscriptions[0];
  assert.equal(sub.pause_behavior, 'void');
  await command({ action: 'subscription.resume', subscription: subscriptionId, expected_version: sub.version, request_key: key() });
  sub = (await customer(tenant)).subscriptions[0];
  assert.equal(sub.pause_behavior, null);
  await command({ action: 'subscription.cancel', subscription: subscriptionId, when: 'period_end', prorate: false, expected_version: sub.version, request_key: key() });
  sub = (await customer(tenant)).subscriptions[0];
  assert.equal(sub.cancel_at_period_end, true);
  assert.equal((await billing.entitlements(bearer, { account })).cancel_at_period_end, true);
  await command({ action: 'subscription.cancel', subscription: subscriptionId, when: 'undo', prorate: false, expected_version: sub.version, request_key: key() });
  sub = (await customer(tenant)).subscriptions[0];
  assert.equal(sub.cancel_at_period_end, false);

  // Invoices: an emailed payment link, and the admin's view of the customer portal.
  detail = await customer(tenant);
  const invoice = detail.invoices.find(item => item.status === 'open');
  const sent = await command({ action: 'invoice.send', invoice: invoice.id, expected_version: invoice.version, request_key: key() });
  assert.deepEqual([sent.id, sent.url.startsWith('https://invoice.stripe.com/')], ['emailed', true]);
  assert.match((await command({ action: 'customer.portal', tenant_id: tenant })).url, /^https:\/\/billing\.stripe\.com\//);

  // The webhook keeps the mirror in sync: verified, applied once, any order.
  const before = stripe.events.length;
  stripe.pay(subscriptionId);
  const paid = stripe.events.slice(before);
  for (const event of paid) assert.deepEqual(await sendEvent(event), { received: true });
  for (const event of paid) assert.deepEqual(await sendEvent(event), { received: true, duplicate: true });
  assert.equal((await customer(tenant)).invoices.find(item => item.id === invoice.id).status, 'paid');
  await assert.rejects(sendEvent(paid[0], 'whsec_wrong'), error => error.status === 400);
  const raw = Buffer.from(JSON.stringify(paid[0]));
  await assert.rejects(billing.webhook(raw, signStripePayload(raw.toString(), webhookSecret, Math.floor(Date.now() / 1000) - 3600)), error => error.status === 400, 'an old signature is refused');
  const events = (await admin.query('select count(*)::int as n from private.billing_webhook_events where stripe_event_id=any($1)', [paid.map(event => event.id)])).rows[0].n;
  assert.equal(events, paid.length);
  // Without a key the webhook applies the event's own snapshot, newest first wins.
  const webhookOnly = platformBilling({ pool, webhookSecrets: [webhookSecret], publicOrigin: 'https://hub.test', log: { warn() {} } });
  const snapshot = structuredClone(stripe.store.subscriptions.get(subscriptionId));
  snapshot.discounts = [];
  const newer = { id: 'evt_' + randomUUID().replaceAll('-', ''), object: 'event', type: 'customer.subscription.updated', created: Math.floor(Date.now() / 1000) - 60, livemode: false, data: { object: { ...snapshot, cancel_at_period_end: true } } };
  const older = { ...newer, id: 'evt_' + randomUUID().replaceAll('-', ''), created: newer.created - 600, data: { object: { ...snapshot, cancel_at_period_end: false } } };
  // The mirror last saw this subscription an hour ago; both events arrive after that, out of order.
  await admin.query("update private.billing_subscriptions set seen_at=now()-interval '1 hour' where stripe_subscription_id=$1", [subscriptionId]);
  await sendEvent(newer, webhookSecret, webhookOnly);
  await sendEvent(older, webhookSecret, webhookOnly);
  assert.equal((await customer(tenant)).subscriptions[0].cancel_at_period_end, true, 'a late, older event never overwrites newer state');
  await command({ action: 'customer.sync', tenant_id: tenant });
  assert.equal((await customer(tenant)).subscriptions[0].cancel_at_period_end, false, 'a refresh from Stripe restores the truth');

  // Tenant administrators: their own billing and the Stripe customer portal, nothing else.
  const carebase = await product('carebase');
  await admin.query("insert into hub.tenant_product_memberships(tenant_id,product_id,user_id,role) values($1,$2,$3,'tenant_admin')", [tenant, carebase, member]);
  const mine = await rpc('my_billing', {}, memberToken);
  assert.deepEqual(mine.tenants.map(item => item.id), [tenant]);
  assert.equal(mine.tenants[0].invoices.length > 0, true);
  assert.equal(JSON.stringify(mine).includes('cus_'), false, 'customers never see Stripe identifiers');
  assert.match((await billing.customerPortal(memberToken, { tenant_id: tenant })).url, /^https:\/\/billing\.stripe\.com\//);
  await assert.rejects(billing.customerPortal(memberToken, { tenant_id: otherTenant }), error => error.status === 403);
  await assert.rejects(billing.customerPortal(null, { tenant_id: tenant }), error => error.status === 401);
  assert.deepEqual((await rpc('my_billing', {}, ownerToken)).tenants, [], 'a platform administrator is not a tenant administrator');

  // Self-service trials: one tenant, customer and trial per application account.
  const launch = (await command({ action: 'product.create', app: 'breathe', name: 'Launch ' + suffix, description: '', kind: 'plan', unit_label: '', entitlement_key: 'launch', request_key: key() })).id;
  await command({ action: 'price.create', product: launch, pricing_model: 'flat', type: 'recurring', interval: 'month', unit_amount: 79900, nickname: '', tenant_id: null, request_key: key() });
  const breatheAccount = randomUUID();
  const trial = await billing.trial('Bearer ' + breatheKey, { account: breatheAccount, name: 'Trial DME ' + suffix, email: 'owner@test.invalid', plan: 'launch' });
  assert.deepEqual([trial.linked, trial.entitled, trial.status, trial.products[0].key], [true, true, 'trialing', 'launch']);
  const again = await billing.trial('Bearer ' + breatheKey, { account: breatheAccount, name: 'Trial DME ' + suffix, email: 'owner@test.invalid', plan: 'launch' });
  assert.equal(again.tenant_id, trial.tenant_id);
  tenantIds.push(trial.tenant_id);
  const trialSubscription = [...stripe.store.subscriptions.values()].find(item => item.metadata.hub_source === 'app_trial');
  assert.equal(stripe.requests.find(request => request.path === '/v1/subscriptions' && request.params.metadata?.hub_source === 'app_trial').params.trial_settings.end_behavior.missing_payment_method, 'cancel');
  assert.equal([...stripe.store.subscriptions.values()].filter(item => item.metadata.hub_source === 'app_trial').length, 1);
  assert.equal(trialSubscription.trial_end - trialSubscription.trial_start, 14 * 86400);
  await assert.rejects(billing.trial('Bearer ' + breatheKey, { account: randomUUID(), name: 'No Plan', email: null, plan: 'missing-plan' }), error => error.status === 409);

  // On boot the Hub catches up with what changed in Stripe without it: a product
  // made in the Dashboard, and a customer created there for a Hub tenant.
  const adopted = (await rpc('create_tenant', { p_record: { name: 'Adopted Agency ' + suffix, slug: 'adopted-billing-' + suffix, industry: '' } })).id;
  tenantIds.push(adopted);
  stripe.store.products.set('prod_dashboard_' + suffix, { id: 'prod_dashboard_' + suffix, object: 'product', name: 'Dashboard plan', description: null, active: true,
    metadata: { app: 'caremetric-intel', kind: 'plan', entitlement: 'starter' }, unit_label: null, created: Math.floor(Date.now() / 1000), livemode: false });
  stripe.store.customers.set('cus_dashboard' + suffix, { id: 'cus_dashboard' + suffix, object: 'customer', email: 'adopted@test.invalid', name: 'Adopted',
    metadata: { hub_tenant_id: adopted }, delinquent: false, balance: 0, created: Math.floor(Date.now() / 1000), livemode: false });
  const reconciled = await billing.reconcile();
  assert.equal(reconciled.failed, 0);
  assert.ok(reconciled.synced > 5);
  assert.equal((await workspace()).products.find(item => item.id === 'prod_dashboard_' + suffix).app, 'caremetric-intel');
  assert.equal((await customer(adopted)).customer.id, 'cus_dashboard' + suffix);
  assert.equal((await customer(trial.tenant_id)).subscriptions.length, 1, 'reconciling never duplicates what the mirror has');

  // Suspending a tenant withdraws entitlements; canceling ends them.
  const suspendedFrom = (await customer(tenant)).updated_at;
  await rpc('save_tenant', { p_tenant_id: tenant, p_record: { name: 'Synthetic Billing Agency ' + suffix, industry: '', status: 'suspended' }, p_expected_updated_at: suspendedFrom });
  assert.deepEqual([(await billing.entitlements(bearer, { account })).entitled, (await billing.entitlements(bearer, { account })).status], [false, 'suspended']);
  await rpc('save_tenant', { p_tenant_id: tenant, p_record: { name: 'Synthetic Billing Agency ' + suffix, industry: '', status: 'active' }, p_expected_updated_at: (await customer(tenant)).updated_at });
  sub = (await customer(tenant)).subscriptions[0];
  await command({ action: 'subscription.cancel', subscription: subscriptionId, when: 'immediately', prorate: false, expected_version: sub.version, request_key: key() });
  entitlement = await billing.entitlements(bearer, { account });
  assert.deepEqual([entitlement.entitled, entitlement.status, entitlement.products], [false, 'none', []]);

  // Coupon lifecycle and key revocation.
  space = await workspace();
  await command({ action: 'coupon.update', coupon, name: 'Partner twenty', expected_version: space.coupons.find(item => item.id === coupon).version, request_key: key() });
  space = await workspace();
  await command({ action: 'coupon.delete', coupon, expected_version: space.coupons.find(item => item.id === coupon).version, request_key: key() });
  assert.equal((await workspace()).coupons.some(item => item.id === coupon), false);
  const keyId = (await workspace()).app_keys.find(item => item.app === 'carebase' && !item.revoked_at).id;
  await command({ action: 'app_key.revoke', key_id: keyId });
  await assert.rejects(billing.entitlements(bearer, { account }), error => error.status === 401);
  await command({ action: 'account.unlink', tenant_id: tenant, app: 'carebase', expected_version: (await customer(tenant)).links[0].version });
  assert.deepEqual((await customer(tenant)).links, []);

  // The audit trail carries actions, states, amounts and identifiers, never names, emails or free text.
  const audit = (await admin.query("select action,metadata from private.audit_events where action like 'billing.%' and (actor_id=$1 or tenant_id=any($2::uuid[]))", [owner, tenantIds])).rows;
  for (const action of ['billing.customer.save', 'billing.subscription.create', 'billing.price.change', 'billing.price.migrate', 'billing.discount.apply', 'billing.usage.updated', 'billing.trial.start', 'billing.subscription.cancel'])
    assert.ok(audit.some(row => row.action === action), action);
  const auditText = JSON.stringify(audit);
  for (const text of ['billing@test.invalid', 'accounts@test.invalid', 'Synthetic', 'Negotiated', 'Partner', 'Trial DME']) assert.equal(auditText.includes(text), false, text);

  await admin.query('update private.staff_permissions set revoked_at=now() where user_id=$1', [owner]);
  await assert.rejects(workspace()); await assert.rejects(command({ action: 'catalog.sync' }));
  await admin.query('update private.staff_permissions set revoked_at=null where user_id=$1', [owner]);
  console.log('Platform billing: Stripe account pinning, administrator and command sessions, catalog, subscriptions, price changes (grandfather and migrate), coupons, promotion codes, custom prices, quantities, trials, pause, cancel, invoices, portal, webhook idempotency and ordering, entitlements, usage, self-service trials and bounded audit passed.');
} finally {
  await stripe.close();
  const tenantsArray = tenantIds;
  for (const table of ['billing_usage_reports', 'billing_account_links', 'billing_invoices']) await admin.query(`delete from private.${table} where tenant_id=any($1::uuid[])`, [tenantsArray]);
  await admin.query('delete from private.billing_subscriptions where tenant_id=any($1::uuid[])', [tenantsArray]);
  await admin.query('delete from private.billing_prices where tenant_id=any($1::uuid[]) or livemode=false', [tenantsArray]);
  await admin.query('delete from private.billing_promotion_codes where livemode=false');
  await admin.query('delete from private.billing_coupons where livemode=false');
  await admin.query('delete from private.billing_prices where livemode=false');
  await admin.query('delete from private.billing_products where livemode=false');
  await admin.query('delete from private.billing_customers where tenant_id=any($1::uuid[])', [tenantsArray]);
  await admin.query('delete from private.billing_webhook_events where livemode=false');
  await admin.query('delete from private.billing_app_keys where created_by=$1', [owner]);
  await admin.query('update private.billing_settings set livemode=null,stripe_account_id=null,verified_at=null');
  await admin.query('delete from private.federated_tenants where hub_tenant_id=any($1::uuid[])', [tenantsArray]);
  await admin.query('delete from hub.tenants where id=any($1::uuid[])', [tenantsArray]);
  await admin.query("delete from private.audit_events where actor_id in ($1,$2) or tenant_id=any($3::uuid[]) or action like 'billing.app_key.%'", [owner, member, tenantsArray]);
  await admin.query('delete from private.sms_sessions where user_id in ($1,$2)', [owner, member]);
  await admin.query('delete from private.sms_identities where user_id in ($1,$2)', [owner, member]);
  await admin.query('delete from private.staff_permissions where user_id in ($1,$2)', [owner, member]);
  await admin.query('delete from auth.users where id in ($1,$2)', [owner, member]);
  await pool.end(); await admin.end();
}
