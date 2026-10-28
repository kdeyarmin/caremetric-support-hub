// Exercise the real customer HTTP/SMS/database boundary on disposable local data.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { appServer } from './http.mjs';
import { gateway } from './gateway.mjs';
import { selfService, nativeSelfService } from './self-service.mjs';
import { smsAuth, sessionCookie, digest, transaction, withSession } from './sms-auth.mjs';
import { exerciseCustomerCheckout } from './customer-checkout-integration.mjs';
import { exerciseCustomerCatalog } from './customer-catalog-integration.mjs';

const databaseUrl = process.env.HUB_TEST_DATABASE_URL;
const local = new URL(databaseUrl);
assert.equal(local.hostname, '127.0.0.1'); assert.equal(local.port, '54322');
const admin = new pg.Pool({ connectionString: databaseUrl });
await admin.query("alter role hub_app_server login password 'ephemeral-test-only'");
const appUrl = new URL(databaseUrl); appUrl.username = 'hub_app_server'; appUrl.password = 'ephemeral-test-only';
const pool = new pg.Pool({ connectionString: appUrl.href });
const product = (await admin.query("select id from hub.products where slug='carebase'")).rows[0].id;
const keyId = randomUUID(), key = `cmb_${randomBytes(32).toString('base64url')}`;
const supportOwner = randomUUID();
const account = `selfservice_${randomUUID()}`, nativeUser = `user_${randomUUID()}`;
let nativeProof = { account, user: nativeUser, account_name: 'Disposable self-service facility group', display_name: 'Synthetic customer',
  role: 'facility_admin', facilities: [{ id: 'site-a', name: 'Synthetic site A', permissions: ['employee.recovery', 'billing.manage', 'support.manage'] }], capabilities: ['training.profile.v1', 'employee.recovery.v1'] };
const provider = { send: async () => randomUUID(), verify: async (_id, _phone, code) => code === '123456' };
const nativeCalls = [];
let unavailable = false, tenant, customerId, ticket;
const secret = 'temporary-test-secret-never-audited';
const customer = selfService({ pool, provider, publicOrigin: 'https://hub.test', fetchImpl: async (url, options) => {
  if (unavailable) throw new Error('Synthetic source outage');
  assert.equal(url, nativeSelfService.carebase.endpoint);
  assert.equal(options.redirect, 'error'); assert.equal(options.headers.Cookie, undefined);
  // A wrong app cannot consume the capability, and successful use consumes it once.
  await assert.rejects(customer.consume(options.headers.Authorization, 'breathe'));
  const authority = await customer.consume(options.headers.Authorization, 'carebase');
  await assert.rejects(customer.consume(options.headers.Authorization, 'carebase'));
  const { operation } = JSON.parse(options.body);
  assert.deepEqual(authority.operation, operation); assert.equal(authority.account, account); assert.equal(authority.user, nativeUser);
  nativeCalls.push(operation);
  if (operation.action === 'scope.read') return Response.json(nativeProof);
  if (operation.action === 'diagnostics.read') return Response.json({ checks: [{ name: 'Application connection', status: 'available' }, { name: 'Protected membership', status: 'available' }], links: [] });
  if (operation.action === 'profile.read') return Response.json({ generated_at: new Date().toISOString(), next_cursor: null, records: [
    { source: 'carebase.credentials', id: 'credential-a', title: 'Synthetic first-aid credential', kind: 'credential', completed_on: '2026-01-01', expires_on: null, warning_days: 90, status: 'current', href: 'https://outside.invalid/evidence' },
  ] });
  if (operation.action === 'recovery.execute') return Response.json({ request_id: operation.request_id, state: 'issued', temporary_password: secret });
  return Response.json({ authorized: true, facility_id: operation.facility_id ?? null, capabilities: [] });
} });
const server = appServer({ auth: smsAuth({ pool, provider }), gateway: gateway(pool), selfService: customer, origins: ['https://hub.test'] });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`, jar = {};
async function call(path, body, headers = {}, browser = true) {
  const response = await fetch(`${origin}/api/${path}`, { method: 'POST', headers: {
    'Content-Type': 'application/json', ...(browser ? { Origin: 'https://hub.test', Cookie: Object.entries(jar).map(([name, value]) => `${name}=${value}`).join('; ') } : {}), ...headers,
  }, body: JSON.stringify(body) });
  for (const value of response.headers.getSetCookie()) { const [pair] = value.split(';'), index = pair.indexOf('='); jar[pair.slice(0, index)] = pair.slice(index + 1); }
  return { status: response.status, body: await response.json() };
}
const privateRpc = (name, values) => withSession(pool, jar[sessionCookie], async db => {
  await db.query('reset role');
  return (await db.query(`select private.${name}(${values.map((_, index) => `$${index + 1}`).join(',')}) as result`, values)).rows[0].result;
});
try {
  // Intake deliberately requires a usable support owner. Native customer
  // linking must never grant those platform privileges to the customer.
  await admin.query("insert into auth.users(id,email,is_anonymous) values($1,'self-service-owner@test.invalid',false)", [supportOwner]);
  await admin.query("insert into private.staff_permissions(user_id,permission) values($1,'platform.admin')", [supportOwner]);
  await admin.query("insert into private.sms_identities(user_id,phone_e164,verified_at) values($1,'+12025550852',now())", [supportOwner]);
  await admin.query('insert into private.billing_app_keys(id,product_id,key_hash,key_hint) values($1,$2,$3,$4)', [keyId, product, digest(key), key.slice(-4)]);
  assert.equal((await call('apps/connect', nativeProof, { Authorization: `Bearer ${key}` })).status, 403, 'native proofs cannot come from a browser');
  assert.equal((await call('apps/connect', { ...nativeProof, role: 'platform_admin' }, { Authorization: `Bearer ${key}` }, false)).status, 400);
  const issued = await call('apps/connect', nativeProof, { Authorization: `Bearer ${key}` }, false);
  assert.equal(issued.status, 200); const token = new URL(issued.body.url).hash.slice(1);
  const started = await call('self-service/connect/start', { token, phone: '+12025550851', consent: true });
  assert.equal(started.status, 200);
  assert.equal((await call('self-service/connect/verify', { challenge_id: started.body.challenge_id, code: '000000' })).status, 401);
  assert.equal((await call('self-service/connect/verify', { challenge_id: started.body.challenge_id, code: '123456' })).status, 200);
  const connection = (await call('self-service', { action: 'workspace' })).body.connections[0];
  assert.equal(connection.app, 'carebase'); assert.equal(connection.role, 'facility_admin'); tenant = connection.tenant_id;
  customerId = (await admin.query('select user_id from private.sms_sessions where token_hash=$1', [digest(jar[sessionCookie])])).rows[0].user_id;
  await exerciseCustomerCatalog({ admin, pool, privateRpc, connection });
  assert.equal((await admin.query('select count(*)::int as count from private.staff_permissions where user_id=$1', [customerId])).rows[0].count, 0, 'linking never grants operator authority');
  assert.equal((await call('self-service', { action: 'connect', token, confirmed: true })).status, 403, 'a handoff is consumed once');
  const diagnosticRequest = { action: 'diagnostic_support', connection_id: connection.id, request_id: randomUUID(), confirmed: true };
  assert.equal((await call('self-service', { ...diagnosticRequest, confirmed: false })).status, 400, 'a support ticket requires the customer action');
  assert.equal((await call('self-service', { ...diagnosticRequest, connection_id: randomUUID() })).status, 403, 'diagnostic tickets cannot use another connection');
  const diagnosticCase = await call('self-service', diagnosticRequest);
  assert.equal(diagnosticCase.status, 200); assert.equal(diagnosticCase.body.tool_state, 'available');
  const diagnosticCount = nativeCalls.filter(op => op.action === 'diagnostics.read').length;
  const diagnosticReplay = await call('self-service', diagnosticRequest);
  assert.equal(diagnosticReplay.body.case_id, diagnosticCase.body.case_id);
  assert.equal(nativeCalls.filter(op => op.action === 'diagnostics.read').length, diagnosticCount, 'a ticket retry does not rerun its diagnostic');
  assert.equal((await admin.query('select facility_shared from hub.support_cases where id=$1', [diagnosticCase.body.case_id])).rows[0].facility_shared, false, 'diagnostics create a private case');
  assert.equal((await admin.query('select count(*)::int as count from private.diagnostic_support_requests where actor_id=$1', [customerId])).rows[0].count, 1);
  const requestKey = randomUUID();
  const support = { p_tenant_id: tenant, p_product_id: product, p_subject: 'Synthetic self-service request', p_category: 'general', p_priority: 'normal', p_body: 'Synthetic nonclinical customer request', p_app_version: null, p_route: null, p_contains_phi: false, p_request_key: requestKey, p_facility_id: 'site-a', p_shared: true };
  const created = await call('rpc/create_facility_support_case', support);
  if (created.status === 500) {
    try { await gateway(pool).rpc('create_facility_support_case', support, jar[sessionCookie]); }
    catch (error) { throw new Error(`Synthetic facility ticket failed: ${error.code ?? 'unknown'} ${error.message}`); }
  }
  assert.equal(created.status, 200, 'new verified customers can open support without operator onboarding'); ticket = created.body.id;
  assert.ok(ticket);
  const escalation = { p_case_id: ticket, p_request_key: randomUUID() };
  assert.equal((await call('rpc/request_human_support', { ...escalation, p_case_id: randomUUID() })).status, 403, 'invisible cases cannot be escalated');
  assert.equal((await call('rpc/request_human_support', escalation)).status, 200, 'customers can immediately request a human');
  assert.equal((await call('rpc/request_human_support', escalation)).body.replayed, true, 'escalation retries do not duplicate the request');
  assert.deepEqual((await admin.query('select stage,attempts,halt_reason from hub.case_ai_automation where case_id=$1', [ticket])).rows[0], { stage: 'halted', attempts: 0, halt_reason: 'human_requested' });
  assert.equal((await admin.query("select count(*)::int as count from hub.case_messages where case_id=$1 and body='Human support requested. Please have a support team member follow up on this case.'", [ticket])).rows[0].count, 1);
  assert.equal((await call('rpc/create_facility_support_case', { ...support, p_shared: false })).status, 400, 'a replay cannot change ticket privacy');
  await admin.query('update private.case_intake_settings set enabled=false where tenant_id=$1 and product_id=$2', [tenant, product]);
  const relink = await call('apps/connect', nativeProof, { Authorization: `Bearer ${key}` }, false);
  assert.equal((await call('self-service', { action: 'connect', token: new URL(relink.body.url).hash.slice(1), confirmed: true })).status, 200);
  assert.equal((await admin.query('select enabled from private.case_intake_settings where tenant_id=$1 and product_id=$2', [tenant, product])).rows[0].enabled, false, 'reconnecting cannot override an explicit support intake closure');
  const profile = await call('self-service', { action: 'native', connection_id: connection.id, operation: { action: 'profile.read', cursor: 0 } });
  assert.equal(profile.status, 200); assert.equal(profile.body.records[0].href, null, 'untrusted evidence links are removed');
  const recovery = { action: 'recovery.execute', target: 'employee-a', recovery_action: 'temporary_password', reason: 'Verified employee identity in person', request_id: randomUUID() };
  assert.equal((await call('self-service', { action: 'native', connection_id: connection.id, operation: recovery })).status, 400, 'access changes require confirmation');
  const prepared = await call('self-service', { action: 'prepare', connection_id: connection.id, operation: recovery });
  assert.equal(prepared.status, 200);
  assert.equal((await call('self-service', { action: 'confirm', confirmation_id: prepared.body.confirmation_id, target: 'employee-b' })).status, 400, 'the confirmed target cannot be replaced');
  const confirmed = await call('self-service', { action: 'confirm', confirmation_id: prepared.body.confirmation_id });
  assert.equal(confirmed.status, 200); assert.equal(confirmed.body.temporary_password, secret);
  assert.deepEqual(nativeCalls.at(-1), recovery);
  assert.equal((await call('self-service', { action: 'confirm', confirmation_id: prepared.body.confirmation_id })).status, 403, 'confirmation cannot execute twice');
  assert.equal(JSON.stringify((await admin.query('select metadata from private.audit_events where actor_id=$1', [customerId])).rows).includes(secret), false);
  assert.equal((await admin.query('select count(*)::int as count from private.self_service_operations where user_id=$1 and result_state=\'succeeded\'', [customerId])).rows[0].count >= 2, true);

  // Quote retry identity is the selection, not a newly calculated timestamp.
  const quoteId = randomUUID(), request = randomUUID();
  const execution = { mode: 'facility', intent: { plan: 'price_core', addons: [] }, immediate: [], next: [], renewal: '2027-01-01T00:00:00Z' };
  const saved = await privateRpc('save_customer_billing_quote', [quoteId, connection.id, 'site-a', request, JSON.stringify({ id: quoteId }), JSON.stringify(execution), 0, null]);
  assert.equal(saved.id, quoteId);
  assert.equal((await privateRpc('save_customer_billing_quote', [randomUUID(), connection.id, 'site-a', request, '{}', JSON.stringify({ ...execution, prorationDate: 123 }), 0, null])).id, quoteId);
  await assert.rejects(privateRpc('save_customer_billing_quote', [randomUUID(), connection.id, 'site-a', request, '{}', JSON.stringify({ ...execution, intent: { plan: null, addons: [] } }), 0, null]), /request changed/);
  const pendingUsage = randomUUID();
  await admin.query("insert into private.billing_usage_reservations(product_id,request_key,tenant_id,metric,quantity,targets) values($1,$2,$3,'facility',1,'{\"items\":[]}')", [product, pendingUsage, tenant]);
  try {
    await assert.rejects(privateRpc('claim_customer_billing_quote', [quoteId, true]), /quantity report needs reconciliation/, 'a purchase cannot race an uncertain legacy quantity update');
    await admin.query("update private.self_service_connections set role='organization_admin',capabilities='[\"facility.entitlements.v1\"]' where id=$1", [connection.id]);
    await assert.rejects(privateRpc('activate_facility_billing', [connection.id, 0, '[]']), /quantity report needs reconciliation/, 'scope activation cannot race an uncertain legacy quantity update');
  } finally {
    await admin.query("delete from private.billing_usage_reservations where product_id=$1 and request_key=$2", [product, pendingUsage]);
    await admin.query("update private.self_service_connections set role='facility_admin',capabilities=$2::jsonb where id=$1", [connection.id, JSON.stringify(nativeProof.capabilities)]);
  }
  assert.equal((await privateRpc('claim_customer_billing_quote', [quoteId, true])).state, 'confirming');
  await transaction(pool, db => db.query('select private.mark_customer_purchase_started($1)', [quoteId]));
  await transaction(pool, db => db.query('select private.record_customer_payment_invoice($1,$2)', [quoteId, 'in_syntheticReceipt']));
  await assert.rejects(transaction(pool, db => db.query('select private.record_customer_payment_invoice($1,$2)', [quoteId, 'in_anotherReceipt'])), /receipt changed/);
  const receipt = await privateRpc('claim_customer_billing_quote', [quoteId, false]);
  assert.equal(receipt.payment_invoice, 'in_syntheticReceipt'); assert.ok(receipt.payment_request_started_at);
  await transaction(pool, db => db.query("select private.settle_customer_billing_quote($1,'failed')", [quoteId]));

  // An old preview cannot overwrite a later schedule, even before provider mirrors refresh.
  const allocation = { facility_id: 'site-a', facility_name: 'Synthetic site A', plan: 'price_core', addons: [] };
  const scheduledId = randomUUID(), staleId = randomUUID(), replacementId = randomUUID();
  const revision = (await privateRpc('customer_billing_context', [connection.id])).billing_revision;
  const scheduleExecution = { ...execution, billing_revision: revision, immediate: [allocation], next: [{ ...allocation, plan: 'price_basic' }] };
  const saveSchedule = (id, intent) => privateRpc('save_customer_billing_quote', [id, connection.id, 'site-a', randomUUID(), JSON.stringify({ id }), JSON.stringify(intent), 0, null]);
  await saveSchedule(scheduledId, scheduleExecution); await saveSchedule(staleId, scheduleExecution);
  await privateRpc('claim_customer_billing_quote', [scheduledId, true]);
  await transaction(pool, db => db.query("select private.settle_customer_billing_quote($1,'scheduled','sub_synthetic','sched_synthetic')", [scheduledId]));
  await assert.rejects(privateRpc('claim_customer_billing_quote', [staleId, true]), /Another purchase changed/);
  const replacement = { ...scheduleExecution, billing_revision: revision + 1, next: [{ ...allocation, plan: 'price_plus' }] };
  await saveSchedule(replacementId, replacement); await privateRpc('claim_customer_billing_quote', [replacementId, true]);
  await transaction(pool, db => db.query("select private.settle_customer_billing_quote($1,'scheduled','sub_synthetic','sched_synthetic')", [replacementId]));
  assert.equal((await admin.query('select state from private.customer_billing_quotes where id=$1', [scheduledId])).rows[0].state, 'superseded');
  await transaction(pool, db => db.query("select private.settle_customer_billing_quote($1,'applied','sub_synthetic')", [scheduledId]));
  assert.deepEqual((await admin.query('select plan_price,pending_plan,pending_quote_id from private.facility_billing_allocations where tenant_id=$1 and product_id=$2', [tenant, product])).rows,
    [{ plan_price: 'price_core', pending_plan: 'price_plus', pending_quote_id: replacementId }]);
  await transaction(pool, db => db.query("select private.settle_customer_billing_quote($1,'failed','sub_synthetic')", [replacementId]));
  assert.deepEqual((await admin.query('select plan_price,pending_plan,pending_at,pending_quote_id from private.facility_billing_allocations where tenant_id=$1 and product_id=$2', [tenant, product])).rows,
    [{ plan_price: 'price_core', pending_plan: null, pending_at: null, pending_quote_id: null }]);
  const cancelId = randomUUID(), keepId = randomUUID();
  const currentRevision = (await privateRpc('customer_billing_context', [connection.id])).billing_revision;
  await saveSchedule(cancelId, { ...scheduleExecution, billing_revision: currentRevision, next: [{ ...allocation, plan: null }] });
  await privateRpc('claim_customer_billing_quote', [cancelId, true]);
  await transaction(pool, db => db.query("select private.settle_customer_billing_quote($1,'scheduled','sub_synthetic','sched_synthetic')", [cancelId]));
  await saveSchedule(keepId, { ...scheduleExecution, billing_revision: currentRevision + 1, cancelSchedule: true, next: [allocation] });
  await privateRpc('claim_customer_billing_quote', [keepId, true]);
  await transaction(pool, db => db.query("select private.settle_customer_billing_quote($1,'applied','sub_synthetic')", [keepId]));
  assert.equal((await admin.query('select state from private.customer_billing_quotes where id=$1', [cancelId])).rows[0].state, 'superseded');
  assert.deepEqual((await admin.query('select plan_price,pending_plan,pending_at from private.facility_billing_allocations where tenant_id=$1 and product_id=$2', [tenant, product])).rows,
    [{ plan_price: 'price_core', pending_plan: null, pending_at: null }]);

  nativeProof = { ...nativeProof, role: 'organization_admin' };
  assert.equal((await call('self-service', { action: 'workspace' })).body.connections[0].role, 'organization_admin');
  await exerciseCustomerCheckout({ admin, pool, privateRpc, connection, tenant, product, customerId, account });
  nativeProof = { ...nativeProof, role: 'member', facilities: nativeProof.facilities.map(site => ({ ...site, permissions: [] })) };
  assert.equal((await call('self-service', { action: 'workspace' })).body.connections[0].role, 'member');
  assert.equal((await call('self-service', { action: 'prepare', connection_id: connection.id, operation: recovery })).status, 403, 'native demotion removes cached recovery authority');
  nativeProof = { ...nativeProof, role: 'organization_admin' };
  assert.equal((await call('self-service', { action: 'workspace' })).body.connections[0].role, 'organization_admin');
  unavailable = true;
  assert.equal((await call('self-service', { action: 'workspace' })).body.connections[0].role, 'member', 'a source outage cannot keep granting cached administration');
  assert.equal(await withSession(pool, jar[sessionCookie], async db => (await db.query('select count(*)::int as count from hub.support_case_queue where id=$1', [ticket])).rows[0].count), 1, 'requesters retain their own historical tickets during a source outage');
  await admin.query('update private.case_intake_settings set enabled=true where tenant_id=$1 and product_id=$2', [tenant, product]);
  const outageCase = await call('self-service', { ...diagnosticRequest, request_id: randomUUID() });
  assert.equal(outageCase.status, 200, 'source outages can be reported through a private customer case');
  assert.equal(outageCase.body.tool_state, 'unavailable');
  assert.ok(outageCase.body.case_id !== diagnosticCase.body.case_id);
  await admin.query('update private.sms_sessions set revoked_at=now() where user_id=$1', [customerId]);
  assert.equal((await call('self-service', { action: 'workspace' })).status, 401);
  console.log('Customer self-service: app-key ingress, real SMS linking, one-use scope-bound capabilities, confirmation, safe evidence links, immutable quote intent/payment receipts, role revocation, source outages and secret-free audit passed.');
} finally {
  await new Promise(resolve => server.close(resolve));
  if (!customerId) customerId = (await admin.query("select user_id from private.sms_identities where phone_e164='+12025550851'")).rows[0]?.user_id;
  if (!tenant) tenant = (await admin.query('select c.tenant_id from private.self_service_connections c where c.source_account=$1', [account])).rows[0]?.tenant_id;
  if (customerId) {
    await admin.query('delete from private.self_service_case_requests where actor_id=$1', [customerId]);
    await admin.query('delete from hub.support_cases where requester_id=$1', [customerId]);
    if (tenant) await admin.query('delete from private.facility_billing_allocations where tenant_id=$1 and product_id=$2', [tenant, product]);
    await admin.query('delete from private.customer_billing_quotes where actor_id=$1', [customerId]);
    await admin.query('delete from private.self_service_operations where user_id=$1', [customerId]);
    await admin.query('delete from private.self_service_connections where user_id=$1', [customerId]);
    await admin.query('delete from private.federated_principals where hub_user_id=$1', [customerId]);
    await admin.query('delete from private.audit_events where actor_id=$1', [customerId]);
    await admin.query('delete from private.sms_sessions where user_id=$1', [customerId]);
    await admin.query('delete from private.sms_identities where user_id=$1', [customerId]);
  }
  await admin.query('delete from private.sms_challenges where self_service_token_hash in(select token_hash from private.self_service_handoffs where proof->>\'account\'=$1)', [account]);
  await admin.query('delete from private.self_service_handoffs where proof->>\'account\'=$1', [account]);
  await admin.query('delete from private.billing_app_keys where id=$1', [keyId]);
  if (tenant) {
    await admin.query('delete from private.federated_tenants where hub_tenant_id=$1', [tenant]);
    await admin.query('delete from private.billing_account_links where tenant_id=$1', [tenant]);
    await admin.query('delete from hub.tenants where id=$1', [tenant]);
  }
  if (customerId) await admin.query('delete from auth.users where id=$1', [customerId]);
  await admin.query('delete from private.staff_permissions where user_id=$1', [supportOwner]);
  await admin.query('delete from private.sms_identities where user_id=$1', [supportOwner]);
  await admin.query('delete from auth.users where id=$1', [supportOwner]);
  await pool.end(); await admin.end();
}
