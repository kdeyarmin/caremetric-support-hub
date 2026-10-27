// Called by the real SMS/HTTP self-service fixture, twice in CI to verify teardown.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { normalizers, signStripePayload, STRIPE_ACCOUNT_ID } from './stripe.mjs';
import { transaction } from './sms-auth.mjs';
import { platformBilling } from './billing.mjs';

export async function exerciseCustomerCheckout({ admin, pool, privateRpc, connection, tenant, product, customerId, account }) {
  const suffix = randomUUID().replaceAll('-', ''), otherTenant = randomUUID(), otherConnection = randomUUID();
  const customer = `cus_${suffix}`, price = `price_${suffix}`, stripeProduct = `prod_${suffix}`;
  const subscription = `sub_${suffix}`, malformed = `sub_unknown${suffix}`, invoice = `in_${suffix}`, checkout = `cs_test_${suffix}`;
  const worker = (name, args) => transaction(pool, async db => (await db.query(`select private.${name}(${args.map((_, i) => `$${i + 1}`).join(',')}) as result`, args)).rows[0].result);
  const mirror = (kind, object) => worker('billing_sync', [kind, JSON.stringify(normalizers[kind](object)), new Date()]);
  const entitlement = () => worker('billing_app_entitlements', [product, account]);
  try {
    await mirror('customer', { id: customer, metadata: { hub_tenant_id: tenant }, name: 'Synthetic Checkout customer', livemode: false });
    await mirror('product', { id: stripeProduct, name: 'Synthetic Checkout plan', active: true, metadata: { app: 'carebase', kind: 'plan', entitlement: 'core' }, unit_label: 'facility', livemode: false });
    await mirror('price', { id: price, product: stripeProduct, active: true, unit_amount: 1000, currency: 'usd', recurring: { interval: 'month', interval_count: 1 }, metadata: { pricing_model: 'per_unit' }, livemode: false });
    const revision = (await privateRpc('customer_billing_context', [connection.id])).billing_revision;
    const execution = { kind: 'checkout', mode: 'legacy', app: 'carebase', customer, billing_revision: revision, facility_id: null,
      lines: [{ price, quantity: 1 }], maximumDue: 1000, currency: 'usd', intent: { plan: price, addons: [] } };
    const candidates = [randomUUID(), randomUUID()];
    for (const id of candidates) await privateRpc('save_customer_billing_quote', [id, connection.id, null, randomUUID(), JSON.stringify({ id, due_now: 1000, currency: 'usd' }), JSON.stringify(execution), 0, null]);
    const claims = await Promise.allSettled(candidates.map(id => privateRpc('claim_customer_billing_quote', [id, true])));
    assert.equal(claims.filter(result => result.status === 'fulfilled').length, 1, 'simultaneous checkouts reserve exactly one subscription start');
    assert.equal(claims.filter(result => result.status === 'rejected')[0].reason.code, '40001');
    const id = candidates[claims.findIndex(result => result.status === 'fulfilled')];
    await assert.rejects(worker('lock_customer_subscription_start', [tenant, product]), error => error.code === '40001', 'native trial creation refuses a committed checkout reservation');
    await worker('bind_customer_checkout', [id, customer, checkout]);
    await assert.rejects(worker('bind_customer_checkout', [id, customer, `${checkout}changed`]), error => error.code === '40001');
    await assert.rejects(worker('settle_customer_billing_quote', [id, 'applied', subscription, null, checkout]), error => error.code === '42501', 'a browser return or unpaid mirror cannot settle Checkout');

    await admin.query("insert into hub.tenants(id,slug,name) values($1,$2,'Synthetic other billing organization')", [otherTenant, `checkout-${suffix}`]);
    await admin.query('insert into hub.tenant_products(tenant_id,product_id) values($1,$2)', [otherTenant, product]);
    await admin.query("insert into hub.tenant_product_memberships(tenant_id,product_id,user_id,role,case_scope) values($1,$2,$3,'customer','own')", [otherTenant, product, customerId]);
    await admin.query("insert into private.self_service_connections(id,user_id,tenant_id,product_id,source_account,source_user,role,facilities,capabilities) values($1,$2,$3,$4,$5,$6,'organization_admin','[]','[]')", [otherConnection, customerId, otherTenant, product, `checkout-other-${suffix}`, `native-${suffix}`]);
    await assert.rejects(privateRpc('customer_checkout_status', [id, otherConnection]), error => error.code === '42501', 'an administrator cannot resume another organization’s checkout');
    await admin.query("update private.self_service_connections set role='facility_admin' where id=$1", [connection.id]);
    await assert.rejects(privateRpc('customer_checkout_status', [id, connection.id]), error => error.code === '42501', 'a facility administrator cannot manage the shared payer');
    await admin.query("update private.self_service_connections set role='organization_admin' where id=$1", [connection.id]);
    // Recovery authorizes the current connection rather than the original browser session.
    const priorSession = randomUUID();
    await admin.query("insert into private.sms_sessions(id,token_hash,user_id,identity_version,expires_at) select $1,$2,user_id,identity_version,now()+interval '1 hour' from private.sms_sessions where user_id=$3 limit 1", [priorSession, `checkout${suffix}`, customerId]);
    await admin.query('update private.customer_billing_quotes set session_id=$1 where id=$2', [priorSession, id]);
    assert.equal((await privateRpc('customer_checkout_status', [id, connection.id])).checkout, checkout, 'a newly verified session can recover the organization’s pending payment');
    await admin.query('update private.customer_billing_quotes set session_id=(select id from private.sms_sessions where token_hash<>$1 and user_id=$2 order by created_at limit 1) where id=$3', [`checkout${suffix}`, customerId, id]);
    await admin.query('delete from private.sms_sessions where id=$1', [priorSession]);

    const item = { id: `si_${suffix}`, price: { id: price, product: stripeProduct, unit_amount: 1000, currency: 'usd', recurring: { interval: 'month', interval_count: 1 } }, quantity: 1 };
    const sub = { id: subscription, customer, status: 'active', metadata: { app: 'carebase', hub_tenant_id: tenant, hub_checkout_quote: id }, items: { data: [item] }, livemode: false };
    await mirror('subscription', sub);
    assert.equal((await entitlement()).entitled, false, 'even an active subscription webhook cannot bypass the initial receipt gate');
    await mirror('subscription', { ...sub, id: malformed, metadata: { app: 'carebase', hub_checkout_quote: 'malformed' }, items: { data: [{ ...item, id: `si_unknown${suffix}` }] } });
    await mirror('subscription', { ...sub, id: malformed, metadata: { app: 'carebase' }, items: { data: [{ ...item, id: `si_unknown${suffix}` }] } });
    assert.equal((await entitlement()).entitled, false, 'removing malformed checkout metadata cannot clear a payment hold');
    const payment = { id: invoice, customer, subscription, metadata: { app: 'carebase' }, status: 'open', currency: 'usd', total: 1000,
      subtotal: 1000, amount_due: 1000, amount_paid: 0, amount_remaining: 1000, livemode: false };
    let paymentStatus = 'unpaid', providerUnavailable = false;
    const webhookSecret = `whsec_synthetic_${suffix}`;
    const billing = platformBilling({ pool, secretKey: 'rk_test_synthetic', webhookSecrets: [webhookSecret], publicOrigin: 'https://hub.test',
      log: { warn() {} }, fetchImpl: async url => {
        const path = new URL(url).pathname;
        if (path === '/v1/account') return Response.json({ id: STRIPE_ACCOUNT_ID });
        if (providerUnavailable) throw new Error('Synthetic provider outage');
        if (path === `/v1/checkout/sessions/${checkout}`) return Response.json({ id: checkout, object: 'checkout.session', mode: 'subscription', customer,
          client_reference_id: id, metadata: sub.metadata, status: 'complete', payment_status: paymentStatus, currency: 'usd', amount_total: 1000, subscription, invoice });
        if (path === `/v1/checkout/sessions/${checkout}/line_items`) return Response.json({ data: [{ price: { id: price }, quantity: 1 }], has_more: false });
        if (path === `/v1/subscriptions/${subscription}`) return Response.json(sub);
        if (path === `/v1/invoices/${invoice}`) return Response.json({ ...payment, status: 'paid', amount_paid: 1000, amount_remaining: 0, billing_reason: 'subscription_create' });
        throw new Error(`Unexpected synthetic provider request ${path}`);
      } });
    const event = { id: `evt_checkout${suffix}`, type: 'checkout.session.completed', created: Math.floor(Date.now() / 1000), livemode: false,
      data: { object: { id: checkout, object: 'checkout.session', payment_status: 'paid' } } };
    const raw = Buffer.from(JSON.stringify(event));
    await assert.rejects(billing.webhook(raw, 'invalid'), error => error.status === 400);
    await billing.webhook(raw, signStripePayload(raw, webhookSecret));
    assert.equal((await entitlement()).entitled, false, 'a signed event saying paid cannot bypass the latest unpaid provider receipt');
    await mirror('invoice', payment);
    await assert.rejects(worker('complete_customer_checkout', [id, checkout, subscription, invoice]), error => error.code === '40001', 'an open invoice does not grant access');
    await mirror('invoice', { ...payment, status: 'paid', amount_paid: 1000, amount_remaining: 0 });
    await mirror('subscription', { ...sub, items: { data: [{ ...item, quantity: 2 }] } });
    await assert.rejects(worker('complete_customer_checkout', [id, checkout, subscription, invoice]), error => error.code === '40001', 'a paid invoice cannot grant a different quantity');
    await mirror('subscription', sub);
    paymentStatus = 'paid'; providerUnavailable = true;
    await assert.rejects(billing.webhook(raw, signStripePayload(raw, webhookSecret)), error => error.status === 503, 'a provider outage keeps a duplicate event retryable');
    providerUnavailable = false;
    assert.equal((await billing.webhook(raw, signStripePayload(raw, webhookSecret))).duplicate, true, 'a duplicate event retries receipt settlement after an outage');
    await worker('complete_customer_checkout', [id, checkout, subscription, invoice]);
    const entitled = await entitlement(); assert.equal(entitled.entitled, true);
    assert.deepEqual(entitled.products.map(row => row.subscription), [subscription], 'only the receipt-backed subscription grants access');
    assert.equal((await admin.query("select count(*)::int as count from private.audit_events where actor_id=$1 and action='billing.customer.applied' and metadata->>'quote'=$2", [customerId, id])).rows[0].count, 1, 'duplicate receipts apply once');
    await mirror('subscription', { ...sub, status: 'canceled' });
    assert.equal((await entitlement()).entitled, false, 'cancellation still revokes operational access after payment');
    // An ordinary existing subscription has no hold and keeps the published legacy rules.
    await mirror('subscription', { ...sub, metadata: { app: 'carebase' }, id: `sub_legacy${suffix}`, items: { data: [{ ...item, id: `si_legacy${suffix}` }] } });
    assert.equal((await entitlement()).entitled, true, 'legacy paid subscriptions keep their original access without migration purchases');
    console.log('Customer Checkout PostgreSQL: concurrent starts, trial refusal, renewed sessions, cross-organization/role refusal, exact paid receipts, persistent holds, duplicate receipts and legacy access passed.');
  } finally {
    await admin.query('delete from private.billing_invoices where stripe_customer_id=$1', [customer]);
    await admin.query('delete from private.billing_subscriptions where stripe_customer_id=$1', [customer]);
    await admin.query('delete from private.billing_prices where stripe_price_id=$1', [price]);
    await admin.query('delete from private.billing_products where stripe_product_id=$1', [stripeProduct]);
    await admin.query('delete from private.billing_customers where stripe_customer_id=$1', [customer]);
    await admin.query('delete from private.billing_webhook_events where stripe_event_id=$1', [`evt_checkout${suffix}`]);
    await admin.query('delete from private.self_service_connections where id=$1', [otherConnection]);
    await admin.query('delete from hub.tenants where id=$1', [otherTenant]);
  }
}
