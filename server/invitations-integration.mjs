// Customer invitations (docs/CUSTOMER_INVITATIONS.md) against real PostgreSQL, real Hub sessions and a local fake of the Stripe API.
// Never run against a hosted database.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { digest } from './sms-auth.mjs';
import { platformBilling } from './billing.mjs';
import { signStripePayload } from './stripe.mjs';
import { fakeStripe } from './fixtures/fake-stripe.mjs';
import { customerInvitations, invitationsFeature } from './customer-invitations.mjs';
import { testPhones } from './test-phones.mjs';
const phones = testPhones(import.meta.url);

const databaseUrl = process.env.HUB_TEST_DATABASE_URL;
const local = new URL(databaseUrl); assert.equal(local.hostname, '127.0.0.1'); assert.equal(local.port, '54322');
const admin = new pg.Pool({ connectionString: databaseUrl });
await admin.query("alter role hub_app_server login password 'ephemeral-test-only'");
const appUrl = new URL(databaseUrl); appUrl.username = 'hub_app_server'; appUrl.password = 'ephemeral-test-only';
const pool = new pg.Pool({ connectionString: appUrl.href });
const owner = randomUUID(), member = randomUUID();
const ownerToken = 'invite-owner-' + randomUUID(), memberToken = 'invite-member-' + randomUUID();
const suffix = randomUUID().slice(0, 8);
const stripe = fakeStripe();
const webhookSecret = 'whsec_' + randomUUID().replaceAll('-', '');
const features = new Set([invitationsFeature]);
const sent = [];
const mail = { configured: true, async send(message) { sent.push(message); return { delivery: 'sent', id: null }; } };
const settings = { 'billing.invite_days': 30, 'billing.invite_carebase_signup': 'https://cmcarebase.com/signup', 'billing.invite_breathe_signup': 'https://cmbreathe.com/breathe/signup' };
const key = () => randomUUID();
const tokenOf = message => /\/welcome\/([A-Za-z0-9_-]{43})/.exec(message.text)?.[1];
const inviteOf = message => /hub_invite=([A-Za-z0-9_-]{43})/.exec(message.text)?.[1];
const contractMigration = await readFile(new URL('../supabase/migrations/20261120120100_customer_invitations_contract.sql', import.meta.url), 'utf8');
let billing, invitations;

try {
  // The declaration is idempotent and refuses an opened table or a function another role can run.
  const contractConnection = await admin.connect();
  try {
    const current = (await contractConnection.query('select hub.get_backend_contract() as data')).rows[0].data;
    assert.ok(current.features.includes(invitationsFeature));
    await contractConnection.query(contractMigration);
    assert.deepEqual((await contractConnection.query('select hub.get_backend_contract() as data')).rows[0].data, current, 'declaration is idempotent');
    for (const change of [
      'alter table private.customer_invitations disable row level security',
      'grant select on private.customer_invitations to hub_app_server',
      'grant execute on function private.customer_invitation_claim(uuid,text,text,text) to authenticated',
      'grant execute on function private.customer_invitation_link(uuid,text,text,uuid,text) to hub_app_server',
      "delete from private.hub_settings where key='billing.invite_days'",
    ]) {
      await contractConnection.query('begin');
      try { await contractConnection.query(change); await assert.rejects(contractConnection.query(contractMigration), error => error.code === '55000', change); }
      finally { await contractConnection.query('rollback'); }
    }
  } finally { contractConnection.release(); }

  await admin.query("insert into auth.users(id,email,is_anonymous) values($1,'invite-owner@test.invalid',false),($2,'invite-member@test.invalid',false)", [owner, member]);
  await admin.query("insert into private.staff_permissions(user_id,permission) values($1,'platform.admin')", [owner]);
  await admin.query('insert into private.sms_identities(user_id,phone_e164,verified_at) values($1,$3,now()),($2,$4,now())', [owner, member, phones.owner, phones.member]);
  for (const [user, token] of [[owner, ownerToken], [member, memberToken]]) {
    await admin.query("insert into private.sms_sessions(id,token_hash,user_id,identity_version,created_at,expires_at) select $1,$2,user_id,identity_version,now(),now()+interval '1 hour' from private.sms_identities where user_id=$3", [randomUUID(), digest(token), user]);
  }

  const stripeBase = await stripe.listen();
  billing = platformBilling({ pool, secretKey: 'sk_test_hub', webhookSecrets: [webhookSecret], apiBase: stripeBase, publicOrigin: 'https://hub.test', features,
    log: { warn() {} }, onInvitationCheckout: sessionId => invitations.reconcileCheckout(sessionId) });
  assert.equal(await billing.start(), true);
  invitations = customerInvitations({ pool, stripe: billing.invitationStripe, mail, setting: name => settings[name] ?? null, publicOrigin: 'https://hub.test', enabled: true, log: { warn() {} } });
  const command = input => billing.command(ownerToken, input);
  const ownerCommand = (input, token = ownerToken) => invitations.admin(token, input);

  // The catalog: a per-facility CareBase plan and add-on, and a flat Breathe plan.
  const core = (await command({ action: 'product.create', app: 'carebase', name: 'Core ' + suffix, description: '', kind: 'plan', unit_label: 'facility', entitlement_key: 'core', request_key: key() })).id;
  const emar = (await command({ action: 'product.create', app: 'carebase', name: 'eMAR ' + suffix, description: '', kind: 'addon', unit_label: 'facility', entitlement_key: 'emar', request_key: key() })).id;
  const pro = (await command({ action: 'product.create', app: 'breathe', name: 'Breathe Pro ' + suffix, description: '', kind: 'plan', unit_label: '', entitlement_key: 'pro', request_key: key() })).id;
  const coreMonthly = (await command({ action: 'price.create', product: core, pricing_model: 'per_unit', type: 'recurring', interval: 'month', unit_amount: 19900, nickname: '', tenant_id: null, request_key: key() })).id;
  const emarMonthly = (await command({ action: 'price.create', product: emar, pricing_model: 'per_unit', type: 'recurring', interval: 'month', unit_amount: 14900, nickname: '', tenant_id: null, request_key: key() })).id;
  const proMonthly = (await command({ action: 'price.create', product: pro, pricing_model: 'flat', type: 'recurring', interval: 'month', unit_amount: 49900, nickname: '', tenant_id: null, request_key: key() })).id;
  const carebaseKey = (await command({ action: 'app_key.issue', app: 'carebase' })).key;
  const breatheKey = (await command({ action: 'app_key.issue', app: 'breathe' })).key;

  // Only the owner's command session may invite.
  const paidRecord = { app: 'carebase', contact_name: 'Jane Doe', contact_email: `Jane.${suffix}@Maple.test`, organization_name: 'Maple Grove ' + suffix,
    price: coreMonthly, quantity: 3, discount_percent: 50, discount_duration: 'repeating', discount_months: 12, note: 'Glad to have you.' };
  await assert.rejects(ownerCommand({ action: 'list' }, memberToken), 'a staff member without platform administration cannot invite');
  await assert.rejects(ownerCommand({ action: 'list' }, null));
  await assert.rejects(ownerCommand({ action: 'create', invitation: { ...paidRecord, price: emarMonthly }, request_key: key() }), error => error.status === 400, 'an add-on is not a plan');
  await assert.rejects(ownerCommand({ action: 'create', invitation: { ...paidRecord, app: 'breathe' }, request_key: key() }), error => error.status === 400, 'a price of another application');
  await assert.rejects(ownerCommand({ action: 'create', invitation: { ...paidRecord, discount_percent: 101 }, request_key: key() }), error => error.status === 400);

  // The preview is the email the customer will get, and creates nothing.
  const preview = await ownerCommand({ action: 'preview', invitation: paidRecord });
  assert.equal(preview.subject, 'Your invitation to CareMetric CareBase');
  assert.match(preview.html, /data-theme="carebase"/);
  assert.match(preview.text, /50% off for your first 12 months/);
  assert.match(preview.text, /\$298\.50 per month for your first 12 months, then \$597\.00 per month/);
  assert.equal((await ownerCommand({ action: 'list' })).invitations.filter(row => row.organization_name === paidRecord.organization_name).length, 0);

  // A paid invitation: created once per request, emailed in CareBase's look with the welcome link.
  const paidKey = key();
  const created = await ownerCommand({ action: 'create', invitation: paidRecord, request_key: paidKey });
  assert.equal(created.delivery, 'sent');
  assert.equal(created.invitation.status, 'pending');
  assert.equal(created.invitation.contact_email, paidRecord.contact_email.toLowerCase());
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, paidRecord.contact_email.toLowerCase());
  assert.equal(sent[0].fromName, 'CareMetric CareBase');
  const paidToken = tokenOf(sent[0]);
  assert.ok(paidToken, 'the email links to the welcome page');
  assert.match(sent[0].html, /https:\/\/hub\.test\/welcome\//);
  const replay = await ownerCommand({ action: 'create', invitation: paidRecord, request_key: paidKey });
  assert.equal(replay.invitation.id, created.invitation.id, 'a retried request never makes a second invitation');
  assert.equal(sent.length, 1, '... or sends a second email');

  // The welcome page shows the offer; an unknown link shows nothing.
  const page = await invitations.page(paidToken);
  assert.equal(page.status, 200);
  assert.match(page.html, /Accept and continue to secure payment/);
  assert.match(page.html, new RegExp(paidRecord.organization_name));
  assert.equal((await invitations.page('x'.repeat(43))).status, 404);
  assert.equal(stripe.store.customers.size, 0, 'looking changes nothing');

  // Stripe fails part-way: the customer is made and the coupon is not, then a Checkout is made but its answer is lost. Each time the
  // customer is told nothing was charged, and the retry carries on with what Stripe already made, sending the same parameters under the
  // same keys (the fake, like Stripe, refuses a key reused with different parameters).
  let restore = stripe.fail('POST', '/v1/coupons');
  let failed = await invitations.accept(paidToken);
  restore();
  assert.equal(failed.status, 503);
  assert.match(failed.html, /nothing was charged/);
  assert.equal(stripe.store.customers.size, 1, 'the customer Stripe made is kept');
  restore = stripe.fail('POST', '/v1/checkout/sessions', { after: true });
  failed = await invitations.accept(paidToken);
  restore();
  assert.equal(failed.status, 503);
  assert.equal([...stripe.store.coupons.values()].filter(row => row.metadata.hub_invitation === created.invitation.id).length, 1, 'the retry went on to the coupon');
  assert.equal(stripe.store.checkout_sessions.size, 1, 'Stripe made the session, though its answer was lost');

  // Accepting: the tenant, its Stripe customer, the invitation's own coupon and a Checkout with the discount applied.
  const checkout = await invitations.accept(paidToken);
  assert.match(checkout.redirect, /^https:\/\/checkout\.stripe\.com\//);
  const customerId = [...stripe.store.customers.values()].find(row => row.metadata.hub_invitation === created.invitation.id)?.id;
  assert.ok(customerId);
  const tenant = stripe.store.customers.get(customerId).metadata.hub_tenant_id;
  assert.equal(tenant, (await ownerCommand({ action: 'list' })).invitations.find(row => row.id === created.invitation.id).tenant_id, 'the customer names the invitation\'s tenant');
  const coupon = [...stripe.store.coupons.values()].find(row => row.metadata.hub_invitation === created.invitation.id);
  assert.deepEqual([coupon.percent_off, coupon.duration, coupon.duration_in_months, coupon.max_redemptions], [50, 'repeating', 12, 1]);
  assert.deepEqual(coupon.applies_to.products, [core]);
  const sessionRequest = stripe.requests.findLast(request => request.path === '/v1/checkout/sessions' && request.method === 'POST');
  assert.deepEqual(sessionRequest.params.discounts, [{ coupon: coupon.id }]);
  assert.deepEqual(sessionRequest.params.line_items, [{ price: coreMonthly, quantity: '3' }]);
  assert.equal(sessionRequest.params.success_url, `https://hub.test/welcome/${paidToken}?checkout=done`);
  assert.equal(sessionRequest.version, '2026-08-26.dahlia');
  assert.equal((await invitations.accept(paidToken)).redirect, checkout.redirect, 'accepting again reopens the same payment');
  assert.equal(stripe.store.checkout_sessions.size, 1);
  assert.equal(stripe.store.customers.size, 1);
  await assert.rejects(ownerCommand({ action: 'resend', id: created.invitation.id, expected_version: 0 }), error => error.status === 409, 'a stale version never sends');

  // Stripe completes the payment; its webhook records the plan even before the customer returns.
  const session = [...stripe.store.checkout_sessions.values()][0];
  const subscription = await (await fetch(`${stripeBase}/v1/subscriptions`, { method: 'POST', headers: { Authorization: 'Bearer sk_test_hub', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ customer: customerId, 'items[0][price]': coreMonthly, 'items[0][quantity]': '3', 'discounts[0][coupon]': coupon.id,
      'metadata[app]': 'carebase', 'metadata[hub_tenant_id]': tenant, 'metadata[hub_invitation]': created.invitation.id }) })).json();
  stripe.pay(subscription.id);
  Object.assign(session, { status: 'complete', payment_status: 'paid', subscription: subscription.id });
  const event = { id: 'evt_' + randomUUID().replaceAll('-', ''), object: 'event', type: 'checkout.session.completed', created: Math.floor(Date.now() / 1000), livemode: false,
    data: { object: { ...session, object: 'checkout.session' } } };
  const raw = Buffer.from(JSON.stringify(event));
  await billing.webhook(raw, signStripePayload(raw.toString(), webhookSecret));
  let listed = (await ownerCommand({ action: 'list' })).invitations.find(row => row.id === created.invitation.id);
  assert.equal(listed.status, 'active');
  assert.equal(listed.subscription, subscription.id);
  assert.equal(listed.tenant_id, tenant);

  // Back on the welcome page: the plan is active, and the sign-up email goes out once, with the invitation's code.
  const back = await invitations.page(paidToken, { checkout: 'done' });
  assert.match(back.html, /Your plan is active/);
  assert.match(back.html, new RegExp(`https://cmcarebase\\.com/signup\\?hub_invite=${paidToken}`));
  assert.equal(sent.length, 2);
  assert.equal(sent[1].subject, 'Your CareMetric CareBase plan is active: create your sign-in');
  assert.equal(inviteOf(sent[1]), paidToken);
  await invitations.page(paidToken);
  assert.equal(sent.length, 2, 'the sign-up email is sent once');
  await assert.rejects(ownerCommand({ action: 'revoke', id: listed.id, expected_version: listed.version }), error => error.status === 409, 'a paid invitation cannot be revoked');

  // A code that is not paid for yet is refused and starts nothing.
  const pendingInvite = await ownerCommand({ action: 'create', invitation: { ...paidRecord, contact_email: `pending.${suffix}@maple.test` }, request_key: key() });
  const pendingToken = tokenOf(sent.at(-1));
  const before = stripe.store.subscriptions.size;
  await assert.rejects(billing.trial('Bearer ' + carebaseKey, { account: 'org-early-' + suffix, name: 'Early', email: null, plan: null, invite: pendingToken }),
    error => error.status === 409, 'an unpaid invitation is refused');
  await assert.rejects(billing.trial('Bearer ' + carebaseKey, { account: 'org-early-' + suffix, name: 'Early', email: null, plan: null, invite: 'z'.repeat(43) }),
    error => error.status === 409, 'an unknown code is refused');
  assert.equal(stripe.store.subscriptions.size, before, 'no trial is started for an unusable code');
  assert.equal((await billing.entitlements('Bearer ' + carebaseKey, { account: 'org-early-' + suffix })).linked, false);
  await ownerCommand({ action: 'revoke', id: pendingInvite.invitation.id, expected_version: pendingInvite.invitation.version });

  // CareBase's sign-up passes the code: the new account joins the plan, never a trial.
  const subscriptionsBefore = stripe.store.subscriptions.size;
  const account = 'org-maple-' + suffix;
  const joined = await billing.trial('Bearer ' + carebaseKey, { account, name: 'Maple Grove', email: paidRecord.contact_email, plan: null, invite: paidToken });
  assert.equal(joined.tenant_id, tenant);
  assert.equal(joined.status, 'active');
  assert.equal(joined.entitled, true);
  assert.equal(stripe.store.subscriptions.size, subscriptionsBefore, 'no trial is started');
  assert.equal((await billing.trial('Bearer ' + carebaseKey, { account, name: 'Maple Grove', email: null, plan: null, invite: paidToken })).tenant_id, tenant, 'a retried sign-up answers the same');
  assert.equal((await billing.entitlements('Bearer ' + carebaseKey, { account })).entitled, true);
  await assert.rejects(billing.trial('Bearer ' + carebaseKey, { account: 'org-other-' + suffix, name: 'Other', email: null, plan: null, invite: paidToken }), error => error.status === 400,
    'another account cannot reuse the invitation');
  listed = (await ownerCommand({ action: 'list' })).invitations.find(row => row.id === created.invitation.id);
  assert.deepEqual([listed.status, listed.claim_method, listed.account_hint], ['claimed', 'code', account.slice(-6)]);
  assert.match((await invitations.page(paidToken)).html, /account is set up/);

  // A complimentary Breathe invitation: no Checkout and no card; the plan starts when they accept.
  const freeRecord = { app: 'breathe', contact_name: 'Dr. Sam Lee', contact_email: `sam.${suffix}@keystone.test`, organization_name: 'Keystone Sleep ' + suffix,
    price: proMonthly, quantity: 1, discount_percent: 100, discount_duration: 'forever', discount_months: null, note: '' };
  const free = await ownerCommand({ action: 'create', invitation: freeRecord, request_key: key() });
  const freeMail = sent.at(-1), sentBefore = sent.length;
  assert.match(freeMail.html, /data-theme="breathe"/);
  assert.match(freeMail.text, /Hi Dr\. Sam Lee,/);
  assert.match(freeMail.text, /nothing to pay and no card to enter/);
  const freeToken = tokenOf(freeMail);
  const sessionsBefore = stripe.store.checkout_sessions.size;
  const activated = await invitations.accept(freeToken);
  assert.equal(activated.redirect, `/welcome/${freeToken}`);
  assert.equal(stripe.store.checkout_sessions.size, sessionsBefore, 'Stripe Checkout is skipped');
  const comp = [...stripe.store.subscriptions.values()].find(row => row.metadata.hub_invitation === free.invitation.id);
  assert.equal(comp.collection_method, 'send_invoice');
  assert.equal(comp.status, 'active');
  assert.equal(comp.discounts[0].source.coupon.percent_off, 100);
  assert.equal(sent.length, sentBefore + 1, 'the sign-up email follows at once');
  assert.equal(inviteOf(sent.at(-1)), freeToken);
  assert.match(sent.at(-1).text, /https:\/\/cmbreathe\.com\/breathe\/signup\?plan=pro&hub_invite=/, 'Breathe\'s form is told the invited plan');
  assert.equal((await invitations.accept(freeToken)).redirect, `/welcome/${freeToken}`, 'accepting again changes nothing');
  assert.equal([...stripe.store.subscriptions.values()].filter(row => row.metadata.hub_invitation === free.invitation.id).length, 1);

  // Breathe's sign-up without the code, with the invited email: held for the owner, not a separate trial; the owner links it.
  const heldAccount = 'org-keystone-' + suffix;
  const held = await billing.trial('Bearer ' + breatheKey, { account: heldAccount, name: 'Keystone', email: freeRecord.contact_email.toUpperCase(), plan: null });
  assert.equal(held.entitled, false);
  assert.equal(held.status, 'none');
  assert.equal([...stripe.store.subscriptions.values()].filter(row => row.metadata.hub_source === 'app_trial').length, 0, 'no trial was started');
  let freeRow = (await ownerCommand({ action: 'list' })).invitations.find(row => row.id === free.invitation.id);
  assert.equal(freeRow.pending_account_hint, heldAccount.slice(-6));
  const linked = await ownerCommand({ action: 'link', id: freeRow.id, expected_version: freeRow.version });
  assert.deepEqual([linked.invitation.status, linked.invitation.claim_method], ['claimed', 'owner']);
  const entitled = await billing.entitlements('Bearer ' + breatheKey, { account: heldAccount });
  assert.equal(entitled.entitled, true);
  assert.equal(entitled.status, 'active');

  // Revoking and sending again: the old link stops working; a revoked link shows it was withdrawn.
  const third = await ownerCommand({ action: 'create', invitation: { ...freeRecord, contact_email: `third.${suffix}@keystone.test`, discount_percent: 0, discount_duration: 'forever' }, request_key: key() });
  const firstLink = tokenOf(sent.at(-1));
  const firstCheckout = await invitations.accept(firstLink);
  assert.match(firstCheckout.redirect, /^https:\/\/checkout\.stripe\.com\//, 'no discount: they pay the full price in Checkout');
  const firstSession = [...stripe.store.checkout_sessions.values()].find(row => row.metadata.hub_invitation === third.invitation.id);
  assert.equal(stripe.requests.filter(request => request.path === '/v1/coupons' && request.params.metadata?.hub_invitation === third.invitation.id).length, 0, 'no coupon at 0%');
  let thirdRow = (await ownerCommand({ action: 'list' })).invitations.find(row => row.id === third.invitation.id);
  assert.equal(thirdRow.status, 'checkout');
  const resent = await ownerCommand({ action: 'resend', id: third.invitation.id, expected_version: thirdRow.version });
  assert.equal(resent.delivery, 'sent');
  assert.equal(firstSession.status, 'expired', 'the open Checkout, which returns to the old link, is closed');
  const secondLink = tokenOf(sent.at(-1));
  assert.notEqual(firstLink, secondLink);
  assert.equal((await invitations.page(firstLink)).status, 404, 'the replaced link no longer opens');
  assert.equal((await invitations.page(secondLink)).status, 200);
  const secondCheckout = await invitations.accept(secondLink);
  assert.notEqual(secondCheckout.redirect, firstCheckout.redirect, 'a new Checkout is made');
  const secondSession = [...stripe.store.checkout_sessions.values()].find(row => row.metadata.hub_invitation === third.invitation.id && row.status === 'open');
  assert.equal(secondSession.success_url, `https://hub.test/welcome/${secondLink}?checkout=done`, '... and returns to the new link');
  thirdRow = (await ownerCommand({ action: 'list' })).invitations.find(row => row.id === third.invitation.id);
  const revoked = await ownerCommand({ action: 'revoke', id: third.invitation.id, expected_version: thirdRow.version });
  assert.equal(revoked.invitation.status, 'revoked');
  assert.equal(secondSession.status, 'expired', 'revoking closes an open Checkout first');
  assert.match((await invitations.page(secondLink)).html, /withdrawn/);
  assert.equal((await invitations.accept(secondLink)).redirect, `/welcome/${secondLink}`, 'a revoked invitation cannot be accepted');

  // The audit trail carries actions, states, amounts and identifiers, never names or emails.
  const audit = (await admin.query("select action,metadata from private.audit_events where action like 'billing.invitation.%' and (actor_id=$1 or metadata->>'invitation'=any($2::text[]))",
    [owner, [created.invitation.id, free.invitation.id, third.invitation.id]])).rows;
  for (const action of ['billing.invitation.create', 'billing.invitation.accept', 'billing.invitation.activate', 'billing.invitation.claim', 'billing.invitation.held', 'billing.invitation.resend', 'billing.invitation.revoke']) {
    assert.ok(audit.some(row => row.action === action), action);
  }
  const auditText = JSON.stringify(audit);
  for (const text of ['Jane', 'Maple', 'keystone.test', 'Sam Lee', 'Glad to have you']) assert.equal(auditText.includes(text), false, text);
  await assert.rejects(pool.query('select * from private.customer_invitations'), error => error.code === '42501', 'the table is closed to the server too');
  console.log('Customer invitations: owner-only commands, preview, idempotent create and themed email, paid acceptance through Checkout with the invitation\'s coupon, recovery when Stripe fails part-way, webhook activation, one sign-up email with the code, sign-up linked without a trial, complimentary activation without Checkout, held sign-ups linked by the owner, resend, revoke and bounded audit passed.');
} finally {
  await stripe.close();
  const tenants = (await admin.query('select tenant_id from private.customer_invitations where created_by=$1 and tenant_id is not null', [owner])).rows.map(row => row.tenant_id);
  await admin.query('delete from private.customer_invitations where created_by=$1', [owner]);
  for (const table of ['billing_account_links', 'billing_invoices']) await admin.query(`delete from private.${table} where tenant_id=any($1::uuid[])`, [tenants]);
  await admin.query('delete from private.billing_subscriptions where tenant_id=any($1::uuid[])', [tenants]);
  await admin.query('delete from private.billing_customers where tenant_id=any($1::uuid[])', [tenants]);
  await admin.query('delete from private.billing_coupons where livemode=false');
  await admin.query('delete from private.billing_prices where livemode=false');
  await admin.query('delete from private.billing_products where livemode=false');
  await admin.query('delete from private.billing_webhook_events where livemode=false');
  await admin.query('delete from private.billing_app_keys where created_by=$1', [owner]);
  await admin.query('update private.billing_settings set livemode=null,stripe_account_id=null,verified_at=null');
  await admin.query('delete from private.federated_tenants where hub_tenant_id=any($1::uuid[])', [tenants]);
  await admin.query('delete from hub.tenant_products where tenant_id=any($1::uuid[])', [tenants]);
  await admin.query('delete from hub.tenants where id=any($1::uuid[])', [tenants]);
  await admin.query("delete from private.audit_events where actor_id in ($1,$2) or tenant_id=any($3::uuid[]) or action like 'billing.app_key.%' or action like 'billing.invitation.%'", [owner, member, tenants]);
  await admin.query('delete from private.sms_sessions where user_id in ($1,$2)', [owner, member]);
  await admin.query('delete from private.sms_identities where user_id in ($1,$2)', [owner, member]);
  await admin.query('delete from private.staff_permissions where user_id in ($1,$2)', [owner, member]);
  await admin.query('delete from auth.users where id in ($1,$2)', [owner, member]);
  await pool.end(); await admin.end();
}
