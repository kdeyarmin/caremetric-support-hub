import { describe, expect, it } from 'vitest';
import { aggregateFacilityLines, planFacilityChange } from './facilityAllocations';
import type { FacilityAllocation, SellablePrice } from './customerBillingProtocol';
const price = (id: string, amount: number, kind: 'plan' | 'addon' = 'plan', key = id): SellablePrice => ({ id, product: id, name: id, description: '', amount, kind, key, features: [], allows_addons: key === 'core', active: true, currency: 'usd', interval: 'month', interval_count: 1, model: 'per_unit', unit_label: 'facility' });
const catalog = [price('core', 19900), price('complete', 64900), price('train', 9900, 'addon'), price('workforce', 9900, 'addon')];
const row = (facility_id: string, addons: string[] = []): FacilityAllocation => ({ facility_id, facility_name: facility_id, plan: 'core', addons, version: 1 });
const cadence = { interval: 'month', currency: 'usd' };
describe('facility subscription changes', () => {
  it('consolidates only the facilities that selected each price', () => {
    expect(aggregateFacilityLines([row('a', ['train']), row('b', ['workforce'])], new Map(catalog.map(item => [item.id, item])))).toEqual([{ price: 'core', quantity: 2 }, { price: 'train', quantity: 1 }, { price: 'workforce', quantity: 1 }]);
  });
  it('adds a module immediately without changing another facility', () => {
    const result = planFacilityChange([row('a'), row('b')], row('a', ['train']), catalog, cadence);
    expect(result.hasImmediateChange).toBe(true); expect(result.hasScheduledChange).toBe(false); expect(result.immediate[1]).toEqual(row('b'));
  });
  it('keeps removed modules until renewal when an admin adds and removes in one change', () => {
    const result = planFacilityChange([row('a', ['train'])], row('a', ['workforce']), catalog, cadence);
    expect(result.immediate[0].addons.sort()).toEqual(['train', 'workforce']); expect(result.next[0].addons).toEqual(['workforce']); expect(result.hasScheduledChange).toBe(true);
  });
  it('activates a bundle upgrade without charging redundant included modules', () => {
    const result = planFacilityChange([row('a', ['train'])], { ...row('a'), plan: 'complete' }, catalog, cadence);
    expect(result.immediateLines).toEqual([{ price: 'complete', quantity: 1 }]); expect(result.hasImmediateChange).toBe(true);
  });
  it('schedules a downgrade and preserves another facility’s pending selection', () => {
    const current = [{ ...row('a'), plan: 'complete' }, { ...row('b', ['train']), pending_at: '2026-11-01', pending_plan: 'core', pending_addons: [] }];
    const result = planFacilityChange(current, row('a'), catalog, cadence);
    expect(result.hasImmediateChange).toBe(false); expect(result.next[1].addons).toEqual([]); expect(result.next[0].plan).toBe('core');
  });
  it('preserves a grandfathered price while adding another module', () => {
    const grandfathered = catalog.map(item => item.id === 'core' ? { ...item, active: false } : item);
    expect(planFacilityChange([row('a')], row('a', ['train']), grandfathered, cadence).immediateLines).toContainEqual({ price: 'core', quantity: 1 });
  });
  it('keeps flat organization prices at quantity one', () => {
    const flat = { ...price('flat', 23900), model: 'flat' as const };
    expect(aggregateFacilityLines([{ ...row('a'), plan: 'flat' }, { ...row('b'), plan: 'flat' }], new Map([['flat', flat]]))).toEqual([{ price: 'flat', quantity: 1 }]);
  });
  it('refuses incompatible add-ons, inactive prices, and a changed billing cadence', () => {
    expect(() => planFacilityChange([row('a')], { ...row('a', ['train']), plan: 'complete' }, catalog, cadence)).toThrow(/already includes/);
    expect(() => planFacilityChange([row('a')], row('a', ['train']), catalog.map(item => item.id === 'train' ? { ...item, active: false } : item), cadence)).toThrow(/active price/);
    expect(() => planFacilityChange([row('a')], row('a', ['train']), catalog, { ...cadence, interval: 'year' })).toThrow(/billing cycle/);
  });
});
