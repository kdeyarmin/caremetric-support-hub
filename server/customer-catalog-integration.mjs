// Exercise the maintained SQL response and the browser/server contract together.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { normalizers } from './stripe.mjs';
import { transaction } from './sms-auth.mjs';
import { customerBillingWorkspace } from '../src/billing/customerBillingProtocol.ts';

export async function exerciseCustomerCatalog({ admin, pool, privateRpc, connection }) {
  const suffix = randomUUID().replaceAll('-', '');
  const products = [], prices = [];
  let scope;
  const cases = [
    { name: 'core', kind: 'plan', entitlement: 'core', expected: true },
    { name: 'complete', kind: 'plan', entitlement: 'complete', expected: false },
    { name: 'addon', kind: 'addon', entitlement: 'train', expected: false },
    { name: 'enabled', kind: 'plan', entitlement: 'custom', allows: 'true', expected: true },
    { name: 'disabled', kind: 'plan', entitlement: 'custom', allows: 'false', expected: false },
  ];
  const mirror = (kind, object) => transaction(pool, async db => {
    const result = await db.query('select private.billing_sync($1,$2::jsonb,now()) as outcome', [kind, JSON.stringify(normalizers[kind](object))]);
    assert.equal(result.rows[0].outcome, 'applied');
  });
  try {
    for (const entry of cases) {
      const product = `prod_catalog${entry.name}${suffix}`, price = `price_catalog${entry.name}${suffix}`;
      products.push(product); prices.push(price);
      await mirror('product', { id: product, name: `Synthetic ${entry.name}`, active: true, unit_label: 'facility', livemode: false,
        metadata: { app: 'carebase', kind: entry.kind, entitlement: entry.entitlement, ...(entry.allows === undefined ? {} : { allows_addons: entry.allows }) } });
      await mirror('price', { id: price, product, active: true, unit_amount: 1000, currency: 'usd', livemode: false,
        recurring: { interval: 'month', interval_count: 1 }, metadata: { pricing_model: 'per_unit' } });
    }
    const workspace = customerBillingWorkspace.parse(await privateRpc('customer_billing_context', [connection.id]));
    for (const [index, entry] of cases.entries()) {
      assert.equal(workspace.catalog.find(price => price.id === prices[index])?.allows_addons, entry.expected,
        `${entry.name} metadata produces the published boolean contract`);
    }
    scope = { tenant: workspace.tenant_id, product: (await admin.query("select id from hub.products where slug='carebase'")).rows[0].id };
    assert.equal(workspace.mode, 'legacy');
    await admin.query("insert into private.facility_billing_configuration(tenant_id,product_id,mode) values($1,$2,'facility')", [scope.tenant, scope.product]);
    await admin.query("insert into private.facility_billing_allocations(tenant_id,product_id,facility_id,facility_name,plan_price) values($1,$2,'site-a','Synthetic site',$3)", [scope.tenant, scope.product, prices[0]]);
    const facilityWorkspace = () => privateRpc('customer_billing_context', [connection.id]).then(value => customerBillingWorkspace.parse(value));
    assert.deepEqual((await facilityWorkspace()).allocations[0].pending_addons, [], 'a new allocation has no pending add-ons');
    await admin.query("update private.facility_billing_allocations set pending_addons=$3,pending_at=now()+interval '1 month' where tenant_id=$1 and product_id=$2", [scope.tenant, scope.product, [prices[2]]]);
    assert.deepEqual((await facilityWorkspace()).allocations[0].pending_addons, [prices[2]], 'a scheduled selection preserves its actual add-ons');
    await admin.query('update private.facility_billing_allocations set pending_addons=null,pending_at=null where tenant_id=$1 and product_id=$2', [scope.tenant, scope.product]);
    assert.deepEqual((await facilityWorkspace()).allocations[0].pending_addons, [], 'clearing a schedule retains the published array contract');
  } finally {
    if (scope) {
      await admin.query('delete from private.facility_billing_allocations where tenant_id=$1 and product_id=$2', [scope.tenant, scope.product]);
      await admin.query('delete from private.facility_billing_configuration where tenant_id=$1 and product_id=$2', [scope.tenant, scope.product]);
    }
    await admin.query('delete from private.billing_prices where stripe_price_id=any($1)', [prices]);
    await admin.query('delete from private.billing_products where stripe_product_id=any($1)', [products]);
  }
}
