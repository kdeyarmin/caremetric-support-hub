import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { transaction } from './sms-auth.mjs';
import { appServer } from './http.mjs';

/** Shares the disposable paid subscription from the real billing integration. */
export async function exerciseFacilityEntitlements({ admin, pool, billing, bearer, breatheKey, tenant, product, account, plan, addon, stripe }) {
  const request = { version: 1, account, facility_ids: ['site-a', 'site-b', 'unknown-site'] };
  const read = input => billing.facilityEntitlements(bearer, input ?? request);
  const server = appServer({ billing, origins: [] });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/apps/facility-entitlements`;
    const headers = { 'Content-Type': 'application/json', Authorization: bearer };
    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(request) });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).contract, 'caremetric.facility-entitlements.v1');
    for (const extra of [{ Origin: 'https://hub.test' }, { Cookie: 'session=not-an-app-key' }]) {
      const refused = await fetch(url, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(request) });
      assert.equal(refused.status, 403, 'browser state cannot authorize an application entitlement read');
    }
    assert.equal((await fetch(url, { headers })).status, 403, 'the endpoint is POST only');
    assert.equal((await fetch(url + '?account=another', { method: 'POST', headers, body: JSON.stringify(request) })).status, 403);
  } finally { await new Promise(resolve => server.close(resolve)); }
  const legacy = await read();
  assert.equal(legacy.billing_mode, 'legacy');
  assert.ok(legacy.facilities.every(site => site.entitled), 'legacy plans retain the existing organization-wide basis');
  assert.equal((await billing.facilityEntitlements('Bearer ' + breatheKey, request)).facilities.some(site => site.entitled), false, 'another application cannot borrow this account');
  await assert.rejects(read({ ...request, version: 2 }), error => error.status === 400);
  await assert.rejects(read({ ...request, facility_ids: ['site-a', 'site-a'] }), error => error.status === 400);
  await assert.rejects(billing.facilityEntitlements('Bearer cmb_' + 'z'.repeat(43), request), error => error.status === 401);
  try {
    await admin.query("insert into private.facility_billing_configuration(tenant_id,product_id,mode) values($1,$2,'facility')", [tenant, product]);
    await admin.query(`insert into private.facility_billing_allocations(tenant_id,product_id,facility_id,facility_name,plan_price,addon_prices)
      values($1,$2,'site-a','Synthetic site A',$3,array[$4]),($1,$2,'site-b','Synthetic site B',$3,'{}')`, [tenant, product, plan, addon]);
    const snapshot = await read();
    assert.equal(snapshot.billing_mode, 'facility');
    assert.ok(snapshot.revision > legacy.revision);
    assert.equal(snapshot.cache_ttl_seconds, 300);
    const sites = new Map(snapshot.facilities.map(site => [site.id, site]));
    assert.deepEqual(sites.get('site-a').products.map(p => p.key).sort(), ['core', 'emar']);
    assert.deepEqual(sites.get('site-b').products.map(p => p.key), ['core']);
    assert.deepEqual([sites.get('unknown-site').entitled, sites.get('unknown-site').products], [false, []]);
    const root = await billing.entitlements(bearer, { account });
    assert.deepEqual([root.billing_mode, root.status, root.organization_status, root.entitled, root.products], ['facility', 'incomplete', 'active', false, []], 'old workers cannot turn a scoped answer into blanket paid access');
    const other = await read({ ...request, account: randomUUID() });
    assert.ok(other.facilities.every(site => !site.entitled && !site.products.length), 'an unknown organization has no licenses');
    const writes = stripe.requests.filter(r => r.method === 'POST').length;
    const key = randomUUID();
    assert.equal((await billing.usage(bearer, { account, metric: 'facility', quantity: 99, request_key: key })).outcome, 'facility_managed');
    assert.equal((await billing.usage(bearer, { account, metric: 'facility', quantity: 99, request_key: key })).duplicate, true);
    assert.equal(stripe.requests.filter(r => r.method === 'POST').length, writes, 'old global usage cannot overwrite mixed facility quantities');
    await assert.rejects(billing.usage(bearer, { account, metric: 'facility', quantity: 98, request_key: key }), error => error.status === 400);
    // Six allocations cannot borrow five paid units, even when the requested page contains one.
    await admin.query(`insert into private.facility_billing_allocations(tenant_id,product_id,facility_id,facility_name,plan_price)
      select $1,$2,'extra-'||n,'Synthetic extra',$3 from generate_series(1,4)n`, [tenant, product, plan]);
    const underpaid = await read();
    assert.ok(underpaid.revision > snapshot.revision);
    assert.ok(underpaid.facilities.every(site => !site.entitled), 'capacity checks include allocations outside the requested page');
    assert.deepEqual((await read({ ...request, facility_ids: [] })).facilities, []);
    await assert.rejects(pool.query('select * from private.facility_entitlement_revisions'));
    await assert.rejects(pool.query('select * from private.billing_usage_reservations'));
  } finally {
    await admin.query('delete from private.facility_billing_allocations where tenant_id=$1 and product_id=$2', [tenant, product]);
    await admin.query('delete from private.facility_billing_configuration where tenant_id=$1 and product_id=$2', [tenant, product]);
  }
  // Commit the reservation before network I/O. Another quantity report must wait for recovery.
  const key = randomUUID();
  const prepare = quantity => transaction(pool, async db => (await db.query('select private.prepare_scoped_billing_usage($1,$2,$3,$4,$5) as value', [product, account, 'facility', quantity, key])).rows[0].value);
  const reserved = await prepare(6);
  assert.equal(reserved.targets.items.length, 2);
  assert.deepEqual(await prepare(6), reserved, 'identical retries retain their immutable original targets');
  await assert.rejects(prepare(7), error => error.code === '22023');
  await assert.rejects(billing.usage(bearer, { account, metric: 'facility', quantity: 7, request_key: randomUUID() }), error => error.status === 409);
  assert.equal((await billing.usage(bearer, { account, metric: 'facility', quantity: 6, request_key: key })).outcome, 'updated');
  assert.equal((await billing.usage(bearer, { account, metric: 'facility', quantity: 5, request_key: randomUUID() })).outcome, 'updated');
}
