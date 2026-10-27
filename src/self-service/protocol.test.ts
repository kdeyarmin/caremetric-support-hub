import { describe, expect, it } from 'vitest';
import { connectionProof, deduplicateProfile, nativeOperation, selfServiceRequest, trustedRecordHref, type ProfileRecord } from './protocol';

const proof = { account: 'org-a', user: 'native-user', account_name: 'Facility group', display_name: 'Test user', role: 'facility_admin', facilities: [{ id: 'facility-a', name: 'Facility A', permissions: ['employee.recovery'] }], capabilities: ['training.profile.v1'] };
describe('verified customer contracts', () => {
  it('accepts an all-role profile without an employee roster or facility', () => {
    expect(connectionProof.parse({ ...proof, role: 'member', facilities: [] }).facilities).toEqual([]);
  });
  it('refuses platform roles, invented permissions, and duplicated facilities', () => {
    for (const value of [{ ...proof, role: 'platform_admin' }, { ...proof, facilities: [{ ...proof.facilities[0], permissions: ['account.admin'] }] }, { ...proof, facilities: [proof.facilities[0], proof.facilities[0]] }]) expect(connectionProof.safeParse(value).success).toBe(false);
  });
  it('keeps targets and mutations inside a closed versioned operation', () => {
    expect(nativeOperation.safeParse({ action: 'recovery.execute', target: 'employee-a', recovery_action: 'unlock', request_id: crypto.randomUUID(), reason: 'Verified by the facility', endpoint: 'https://evil.invalid' }).success).toBe(false);
    expect(selfServiceRequest.safeParse({ action: 'connect', token: `cmc_${'a'.repeat(43)}`, confirmed: false }).success).toBe(false);
  });
  it('only links evidence on the fixed HTTPS application origin', () => {
    expect(trustedRecordHref('/account/profile', 'https://native.invalid')).toBe('https://native.invalid/account/profile');
    for (const href of ['https://evil.invalid/proof', 'javascript:alert(1)', '//evil.invalid', 'https://user@native.invalid/proof', 'http://native.invalid/proof']) expect(trustedRecordHref(href, 'https://native.invalid')).toBeNull();
  });
  it('deduplicates source identity while retaining historical renewals', () => {
    const current: ProfileRecord = { source: 'native', id: 'credential-new', title: 'License', kind: 'credential', completed_on: '2026-01-01', expires_on: null, warning_days: 90, status: 'current', href: null };
    const historical: ProfileRecord = { ...current, id: 'credential-old', status: 'historical', expires_on: '2025-01-01' };
    const otherSource: ProfileRecord = { ...current, source: 'other-native' };
    expect(deduplicateProfile([historical, current, current, otherSource])).toHaveLength(3);
    expect(deduplicateProfile([historical, current]).filter(row => row.status === 'historical')).toEqual([historical]);
  });
});
