// Called by the real billing integration (real PostgreSQL, local fake of the Stripe API), twice in CI to prove teardown.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { platformBilling } from './billing.mjs';
import { appServer } from './http.mjs';
import { transaction } from './sms-auth.mjs';

/**
 * An application changes its own customers' plans and add-ons for their organization administrator: the Hub
 * customer center's quote, confirmation and Checkout flow, reached with the application key.
 */
export async function exerciseAppPlanChanges({ admin, pool, billing, command, rpc, stripe, stripeBase, carebaseKey, breatheKey, tenantIds, suffix }) {
  const key = () => randomUUID();
  const bearer = 'Bearer ' + carebaseKey;
  const purchasing = platformBilling({ pool, secretKey: 'sk_test_hub', apiBase: stripeBase, publicOrigin: 'https://hub.test', log: { warn() {} }, customerPurchasingEnabled: true });
  assert.equal(await purchasing.start(), true);
  const created = [];
  try {
    // A per-facility plan and add-on, and a plan sold only to small homes.
    const product = async (name, kind, entitlement_key) => (await command({ action: 'product.create', app: 'carebase', name: `${name} ${suffix}`, description: '', kind, unit_label: 'facility', entitlement_key, request_key: key() })).id;
    const monthly = async (productId, amount) => (await command({ action: 'price.create', product: productId, pricing_model: 'per_unit', type: 'recurring', interval: 'month', unit_amount: amount, nickname: '', tenant_id: null, request_key: key() })).id;
    const plan = await monthly(await product('App plan', 'plan', 'core'), 10000);
    const addon = await monthly(await product('App add-on', 'addon', 'emar'), 2500);
    const smallHome = await monthly(await product('App small home', 'plan', 'small_home'), 6000);

    const organization = async (name, account) => {
      const tenant = (await rpc('create_tenant', { p_record: { name: `${name} ${suffix}`, slug: `${name.toLowerCase().replaceAll(' ', '-')}-${suffix}`, industry: '' } })).id;
      tenantIds.push(tenant); created.push(tenant);
      await command({ action: 'account.link', tenant_id: tenant, app: 'carebase', account, expected_version: 0 });
      return tenant;
    };
    const facilities = [{ id: 'site-a', name: 'Synthetic Assisted Living A' }, { id: 'site-b', name: 'Synthetic Assisted Living B' }];
    const body = (account, request, overrides = {}) => ({ account, return_url: 'https://carebase.test/app/billing', actor: { id: 'native-admin-1' },
      scope: { facilities, plan_size: null }, request, ...overrides });

    // An organization that already pays for two facilities by card.
    const paying = randomUUID();
    const payingTenant = await organization('App plans paying', paying);
    await command({ action: 'customer.save', tenant_id: payingTenant, email: 'app-plans@test.invalid', name: 'Synthetic app plans', expected_version: 0, request_key: key() });
    const subscription = (await command({ action: 'subscription.create', tenant_id: payingTenant, app: 'carebase', items: [{ price: plan, quantity: 2 }], trial_days: 0,
      collection_method: 'charge_automatically', days_until_due: 30, coupon: null, promotion_code: null, request_key: key() })).id;
    stripe.pay(subscription);
    await command({ action: 'customer.sync', tenant_id: payingTenant });

    // Only this application's key, for one of its own linked accounts, reaches a customer's plan.
    await assert.rejects(billing.appPlanChanges('Bearer cmb_' + 'x'.repeat(43), body(paying, { action: 'workspace' })), error => error.status === 401);
    await assert.rejects(billing.appPlanChanges(bearer, body(randomUUID(), { action: 'workspace' })), error => error.status === 404, 'an unlinked account has no plan to change');
    await assert.rejects(billing.appPlanChanges('Bearer ' + breatheKey, body(paying, { action: 'workspace' })), error => error.status === 404, 'another application\'s key cannot reach this customer');
    for (const invalid of [{ ...body(paying, { action: 'workspace' }), extra: true }, body(paying, { action: 'workspace', connection_id: randomUUID() }),
      body(paying, { action: 'activate_facility_billing', confirmed: true, expected_version: 0 }), body(paying, { action: 'workspace' }, { return_url: 'http://carebase.test/app/billing' }),
      body(paying, { action: 'workspace' }, { actor: { id: 'native-admin-1', role: 'platform_admin' } }),
      body(paying, { action: 'workspace' }, { scope: { facilities: [...facilities, facilities[0]], plan_size: null } })])
      await assert.rejects(billing.appPlanChanges(bearer, invalid), error => error.status === 400, JSON.stringify(invalid));

    // Reading and pricing a change work while purchasing is off.
    const space = await billing.appPlanChanges(bearer, body(paying, { action: 'workspace' }));
    assert.deepEqual([space.mode, space.role, space.purchasing_enabled, space.subscription.status, space.pending_checkout], ['legacy', 'organization_admin', false, 'active', null]);
    assert.deepEqual(space.allocations.map(row => [row.facility_id, row.facility_name, row.plan, row.addons]), [['site-a', 'Synthetic Assisted Living A', plan, []], ['site-b', 'Synthetic Assisted Living B', plan, []]]);
    assert.ok([plan, addon, smallHome].every(id => space.catalog.some(price => price.id === id)));
    for (const hidden of ['connection_id', 'tenant_id', 'customer']) assert.equal(hidden in space, false, `${hidden} stays inside the Hub`);
    const requestId = key();
    const quoteRequest = { action: 'quote', facility_id: null, plan, addons: [addon], request_id: requestId };
    const quote = await billing.appPlanChanges(bearer, body(paying, quoteRequest));
    assert.deepEqual([quote.due_now, quote.has_immediate_change, quote.has_scheduled_change, quote.facility_name], [5000, true, false, 'All facilities in this organization']);
    assert.deepEqual(quote.summary.map(line => [line.quantity, line.amount]).sort((x, y) => x[1] - y[1]), [[2, 5000], [2, 20000]]);
    assert.equal((await billing.appPlanChanges(bearer, body(paying, quoteRequest))).id, quote.id, 'a retried quote request returns the same quote');
    const { product_id: carebase, ...stored } = (await admin.query('select product_id,app_actor,actor_id,session_id,connection_id,state from private.customer_billing_quotes where id=$1', [quote.id])).rows[0];
    assert.deepEqual(stored, { app_actor: 'native-admin-1', actor_id: null, session_id: null, connection_id: null, state: 'preview' });
    const save = (actor, intent) => transaction(pool, async db => (await db.query('select private.app_save_customer_billing_quote($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) as result',
      [carebase, paying, actor, randomUUID(), null, requestId, '{}', JSON.stringify({ intent }), 0, null])).rows[0].result);
    await assert.rejects(save('native-admin-1', { plan, addons: [] }), error => error.code === '22023', 'a retried request cannot change the selection');
    assert.deepEqual(await save('native-admin-2', { plan, addons: [] }), {}, 'request ids belong to one administrator');

    // Size-limited plans need the application's size facts, as in the customer center; a downgrade waits for renewal.
    const small = { action: 'quote', facility_id: null, plan: smallHome, addons: [], request_id: key() };
    await assert.rejects(billing.appPlanChanges(bearer, body(paying, small)), error => error.status === 400 && /could not confirm/.test(error.message));
    const fits = { small_home_bed_limit: 20, active_facilities: 2, small_home_eligible: true, single_facility_eligible: false,
      facilities: facilities.map(site => ({ facility_id: site.id, licensed_beds: 12, small_home: true })) };
    const downgrade = await billing.appPlanChanges(bearer, body(paying, { ...small, request_id: key() }, { scope: { facilities, plan_size: fits } }));
    assert.deepEqual([downgrade.has_immediate_change, downgrade.has_scheduled_change, downgrade.due_now], [false, true, 0]);
    assert.ok(downgrade.effective_at, 'a downgrade takes effect at renewal');

    // Confirming is refused while purchasing is off, before Stripe is asked to change anything.
    const changes = () => stripe.requests.filter(request => request.method === 'POST' && request.path === `/v1/subscriptions/${subscription}`).length;
    const before = changes();
    await assert.rejects(billing.appPlanChanges(bearer, body(paying, { action: 'confirm', quote_id: quote.id, confirmed: true })), error => error.status === 503);
    assert.equal(changes(), before);
    // Only the administrator who reviewed the quote can confirm it.
    await assert.rejects(purchasing.appPlanChanges(bearer, body(paying, { action: 'confirm', quote_id: quote.id, confirmed: true }, { actor: { id: 'native-admin-2' } })), error => error.status === 403);
    const applied = await purchasing.appPlanChanges(bearer, body(paying, { action: 'confirm', quote_id: quote.id, confirmed: true }));
    assert.deepEqual(applied, { state: 'applied' });
    assert.deepEqual(stripe.store.subscriptions.get(subscription).items.data.map(item => [item.price.id, item.quantity]).sort(), [[addon, 2], [plan, 2]].sort());
    const purchase = stripe.requests.filter(request => request.method === 'POST' && request.path === `/v1/subscriptions/${subscription}`).at(-1);
    assert.deepEqual([purchase.idempotencyKey, purchase.params.proration_behavior], [`hub-customer-${quote.id}-purchase`, 'always_invoice']);
    assert.deepEqual(await purchasing.appPlanChanges(bearer, body(paying, { action: 'confirm', quote_id: quote.id, confirmed: true })), { state: 'applied' }, 'a retried confirmation changes nothing');
    assert.equal(changes(), before + 1);
    const after = await purchasing.appPlanChanges(bearer, body(paying, { action: 'workspace' }));
    assert.deepEqual([after.purchasing_enabled, after.allocations[0].addons], [true, [addon]]);

    // An organization with no subscription yet pays for its first plan in Stripe Checkout and returns to the app.
    const starting = randomUUID();
    const startingTenant = await organization('App plans starting', starting);
    const fresh = await billing.appPlanChanges(bearer, body(starting, { action: 'workspace' }));
    assert.deepEqual([fresh.subscription, fresh.pending_checkout], [null, null]);
    const first = await billing.appPlanChanges(bearer, body(starting, { action: 'quote', facility_id: null, plan, addons: [], request_id: key() }));
    assert.deepEqual([first.kind, first.due_now], ['checkout', 20000]);
    await assert.rejects(billing.appPlanChanges(bearer, body(starting, { action: 'confirm', quote_id: first.id, confirmed: true })), error => error.status === 503);
    assert.equal(stripe.store.checkout_sessions.size, 0, 'no Checkout is created while purchasing is off');
    const pending = await purchasing.appPlanChanges(bearer, body(starting, { action: 'confirm', quote_id: first.id, confirmed: true }));
    assert.equal(pending.state, 'pending_payment');
    assert.equal(new URL(pending.url).origin, 'https://checkout.stripe.com');
    const session = [...stripe.store.checkout_sessions.values()].at(-1);
    assert.deepEqual([session.success_url, session.cancel_url], ['https://carebase.test/app/billing?checkout=returned', 'https://carebase.test/app/billing?checkout=cancelled']);
    assert.equal(stripe.store.customers.get(session.customer).metadata.hub_tenant_id, startingTenant);
    const waiting = await billing.appPlanChanges(bearer, body(starting, { action: 'workspace' }));
    assert.deepEqual([waiting.pending_checkout.id, waiting.pending_checkout.state, waiting.pending_checkout.due_now], [first.id, 'pending_payment', 20000]);
    // Another administrator of the same organization can check or cancel it, with purchasing off, and nobody else can.
    const other = { actor: { id: 'native-admin-2' } };
    assert.deepEqual(await billing.appPlanChanges(bearer, body(starting, { action: 'checkout_resume', quote_id: first.id }, other)), { state: 'pending_payment', url: pending.url });
    await assert.rejects(billing.appPlanChanges(bearer, body(paying, { action: 'checkout_resume', quote_id: first.id })), error => error.status === 403, 'one organization cannot reach another\'s Checkout');
    // Only a Stripe Checkout page is ever handed to the application.
    const original = session.url;
    session.url = 'https://checkout.stripe.com.example.invalid/c/pay/' + session.id;
    await assert.rejects(billing.appPlanChanges(bearer, body(starting, { action: 'checkout_resume', quote_id: first.id })), error => error.status === 503);
    session.url = original;
    assert.deepEqual(await billing.appPlanChanges(bearer, body(starting, { action: 'checkout_cancel', quote_id: first.id, confirmed: true }, other)), { state: 'failed' });
    assert.equal(session.status, 'expired');
    assert.equal((await billing.appPlanChanges(bearer, body(starting, { action: 'workspace' }))).pending_checkout, null);

    // Every request is recorded with the application, account, administrator and action, never names or emails.
    const audit = (await admin.query("select tenant_id,actor_id,metadata from private.audit_events where action='billing.plan_change.app' and tenant_id=any($1::uuid[]) order by id", [created])).rows;
    assert.ok(audit.length >= 15);
    assert.ok(audit.every(row => row.actor_id === null && row.metadata.app === 'carebase' && ['native-admin-1', 'native-admin-2'].includes(row.metadata.actor)));
    assert.ok(audit.some(row => row.tenant_id === payingTenant && row.metadata.account === paying && row.metadata.action === 'confirm' && row.metadata.outcome === 'applied' && row.metadata.quote === quote.id));
    assert.ok(audit.some(row => row.metadata.action === 'confirm' && row.metadata.outcome === 'refused' && row.metadata.status === 503));
    assert.ok(audit.some(row => row.tenant_id === startingTenant && row.metadata.action === 'checkout_cancel' && row.metadata.outcome === 'failed'));
    for (const text of ['Synthetic', '@test.invalid']) assert.equal(JSON.stringify(audit).includes(text), false, text);

    // The route is the same function behind an application-only HTTP boundary.
    const server = appServer({ billing, origins: ['https://hub.test'] });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const url = `http://127.0.0.1:${server.address().port}/api/apps/billing`;
      const post = headers => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: bearer, ...headers }, body: JSON.stringify(body(paying, { action: 'workspace' })) });
      const response = await post({});
      assert.equal(response.status, 200);
      assert.equal((await response.json()).allocations.length, 2);
      for (const headers of [{ Origin: 'https://hub.test' }, { Cookie: 'session=not-an-app-key' }]) assert.equal((await post(headers)).status, 403);
    } finally { await new Promise(resolve => server.close(resolve)); }
    console.log('Application plan changes: application key and own-account scope, browser refusal, workspace and quotes with purchasing off, refused confirmation, administrator-bound quotes, plan fit, paid add-on, first-plan Checkout return, organization-wide Checkout recovery, Checkout address check and bounded audit passed.');
  } finally {
    await admin.query('delete from private.customer_billing_quotes where tenant_id=any($1::uuid[])', [created]);
  }
}
