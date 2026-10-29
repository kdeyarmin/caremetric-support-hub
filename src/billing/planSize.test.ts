import { describe, expect, it } from 'vitest';
import type { SellablePrice } from './customerBillingProtocol';
import { assertPlanFits, isSizeLimitedPlan } from './planSize';

const plan = (key: string, name = key): SellablePrice => ({ id: `price_${key}`, product: `prod_${key}`, name, description: '', kind: 'plan', key, features: [],
  allows_addons: false, active: true, amount: 1000, currency: 'usd', interval: 'month', interval_count: 1, model: 'per_unit', unit_label: 'facility' });
const facts = (overrides: Record<string, unknown> = {}) => ({ plan_size: { small_home_bed_limit: 20, active_facilities: 2, small_home_eligible: false,
  single_facility_eligible: false, facilities: [
    { facility_id: 'site-a', licensed_beds: 12, small_home: true },
    { facility_id: 'site-b', licensed_beds: 40, small_home: false },
  ], ...overrides } });

describe('plan size limits', () => {
  it('leaves plans without a size limit alone, with or without facts', () => {
    expect(isSizeLimitedPlan(plan('core'))).toBe(false);
    expect(() => assertPlanFits(plan('core'), { authorized: true }, null)).not.toThrow();
    expect(() => assertPlanFits(plan('compliance_suite'), null, null)).not.toThrow();
    expect(() => assertPlanFits(undefined, null, null)).not.toThrow();
  });
  it.each(['small_home', 'small_home_complete', 'train_single_facility'])('refuses %s when the application does not confirm the size', key => {
    expect(isSizeLimitedPlan(plan(key))).toBe(true);
    expect(() => assertPlanFits(plan(key), { authorized: true }, null)).toThrow(/could not confirm/);
    expect(() => assertPlanFits(plan(key), { authorized: true, plan_size: { active_facilities: 1 } }, null)).toThrow(/could not confirm/);
  });
  it('sells Train Single Facility only to an organization with one active facility', () => {
    expect(() => assertPlanFits(plan('train_single_facility', 'Train Single Facility'), facts(), null)).toThrow('Train Single Facility is for organizations with one active facility. This organization has 2.');
    expect(() => assertPlanFits(plan('train_single_facility'), facts({ active_facilities: 1, single_facility_eligible: true }), null)).not.toThrow();
  });
  it('sells an organization-wide small-home plan only when every facility is under the bed limit', () => {
    expect(() => assertPlanFits(plan('small_home', 'Small Home'), facts(), null)).toThrow(/Small Home is for licensed homes with fewer than 20 beds/);
    expect(() => assertPlanFits(plan('small_home_complete'), facts({ small_home_eligible: true }), null)).not.toThrow();
  });
  it('checks only the facility being billed for a per-facility small-home plan', () => {
    expect(() => assertPlanFits(plan('small_home'), facts(), 'site-a')).not.toThrow();
    expect(() => assertPlanFits(plan('small_home'), facts(), 'site-b')).toThrow(/fewer than 20 beds/);
    expect(() => assertPlanFits(plan('small_home'), facts(), 'site-unknown')).toThrow(/fewer than 20 beds/);
  });
});
