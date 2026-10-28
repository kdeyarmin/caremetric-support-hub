import { describe, expect, it } from 'vitest';
import { facilityEntitlementRequest, facilityEntitlementSnapshot } from './facilityEntitlements';

describe('versioned facility entitlement boundary', () => {
  it('requires a supported version and one copy of each native facility', () => {
    expect(facilityEntitlementRequest.safeParse({ version: 1, account: 'org-1', facility_ids: ['site-a', 'site-b'] }).success).toBe(true);
    for (const input of [
      { version: 2, account: 'org-1', facility_ids: [] },
      { version: 1, account: 'org-1', facility_ids: ['site-a', 'site-a'] },
      { version: 1, account: 'org-1', facility_ids: ['../other-org'] },
      { version: 1, account: 'org-1', facility_ids: [], entitled: true },
    ]) expect(facilityEntitlementRequest.safeParse(input).success).toBe(false);
  });
  const snapshot = { contract: 'caremetric.facility-entitlements.v1', app: 'carebase', account: 'org-1', billing_mode: 'facility',
    revision: 12, checked_at: '2026-10-28T12:00:00.000Z', cache_ttl_seconds: 300,
    facilities: [{ id: 'site-a', status: 'active', entitled: true, products: [{ key: 'core', kind: 'plan', quantity: 1, unit_label: 'facility', package_id: '' }] }] };
  it('refuses Go, unknown status, unsafe revisions, malformed dates and extended cache lifetimes', () => {
    expect(facilityEntitlementSnapshot.safeParse(snapshot).success).toBe(true);
    for (const input of [{ ...snapshot, app: 'caremetric-go' }, { ...snapshot, revision: Number.MAX_SAFE_INTEGER + 1 },
      { ...snapshot, checked_at: 'yesterday' }, { ...snapshot, cache_ttl_seconds: 301 },
      { ...snapshot, facilities: [{ ...snapshot.facilities[0], status: 'paid-ish' }] },
      { ...snapshot, facilities: [{ ...snapshot.facilities[0], products: [{ ...snapshot.facilities[0].products[0], quantity: 0 }] }] },
    ]) expect(facilityEntitlementSnapshot.safeParse(input).success).toBe(false);
  });
});
