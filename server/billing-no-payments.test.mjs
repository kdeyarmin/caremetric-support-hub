import { expect, it, vi } from 'vitest';
import { platformBilling } from './billing.mjs';

it.each([
  ['entitlements', { account: 'synthetic-agency' }],
  ['facilityEntitlements', { version: 1, account: 'synthetic-agency', facility_ids: [] }],
  ['usage', { account: 'synthetic-agency', metric: 'users', quantity: 1, request_key: '99000000-0000-4000-8000-000000000004' }],
  ['trial', { account: 'synthetic-agency', name: 'Synthetic agency', email: null, plan: null }],
])('refuses PennSync %s before contacting the payment provider', async (method, request) => {
  const fetchImpl = vi.fn(() => { throw new Error('Unexpected provider request'); });
  const query = vi.fn(async sql => {
    if (sql.includes('private.billing_authenticate_app')) return { rows: [{ app: { slug: 'pennsync', product_id: '00000000-0000-4000-8000-000000000003' } }] };
    if (['begin', 'rollback', "set local statement_timeout='12s'"].includes(sql)) return { rows: [] };
    throw new Error('Unexpected billing operation');
  });
  const release = vi.fn();
  const pool = { connect: async () => ({ query, release }) };
  const billing = platformBilling({ pool, secretKey: 'sk_test_synthetic', publicOrigin: 'https://hub.test', fetchImpl });

  await expect(billing[method](`Bearer cmb_${'a'.repeat(43)}`, request)).rejects.toMatchObject({ status: 403, message: 'PennSync does not accept payments.' });
  expect(fetchImpl).not.toHaveBeenCalled();
  expect(release).toHaveBeenCalledOnce();
});
