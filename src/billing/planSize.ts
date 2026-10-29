import { z } from 'zod';
import type { SellablePrice } from './customerBillingProtocol';

/**
 * Size facts the application reports with purchasing authority. CareBase reads licensed beds from
 * each facility's licence in force; the Hub never stores or guesses them.
 */
export const planSizeFacts = z.object({
  small_home_bed_limit: z.number().int().positive(),
  active_facilities: z.number().int().nonnegative(),
  small_home_eligible: z.boolean(),
  single_facility_eligible: z.boolean(),
  facilities: z.array(z.object({ facility_id: z.string(), licensed_beds: z.number().int().nullable(), small_home: z.boolean() })),
});
export type PlanSizeFacts = z.infer<typeof planSizeFacts>;

const smallHomePlans = new Set(['small_home', 'small_home_complete']);
const singleFacilityPlans = new Set(['train_single_facility']);

export const isSizeLimitedPlan = (plan: Pick<SellablePrice, 'key'> | undefined | null) =>
  Boolean(plan && (smallHomePlans.has(plan.key) || singleFacilityPlans.has(plan.key)));

/**
 * Refuses a size-limited plan the organization does not fit. `facilityId` is the facility being
 * billed for a per-facility purchase, or null for the organization-wide subscription. Missing or
 * malformed facts refuse the plan: an unconfirmed size is never treated as a fit.
 */
export function assertPlanFits(plan: SellablePrice | undefined | null, authority: unknown, facilityId: string | null): void {
  if (!plan || !isSizeLimitedPlan(plan)) return;
  const facts = planSizeFacts.safeParse((authority as { plan_size?: unknown } | null | undefined)?.plan_size);
  if (!facts.success) throw new Error(`${plan.name} depends on your facilities' size, which your application could not confirm. Refresh billing, or contact support to buy this plan.`);
  const size = facts.data;
  if (singleFacilityPlans.has(plan.key) && !size.single_facility_eligible) {
    throw new Error(`${plan.name} is for organizations with one active facility. This organization has ${size.active_facilities}.`);
  }
  if (smallHomePlans.has(plan.key)) {
    const fits = facilityId === null ? size.small_home_eligible
      : size.facilities.some(site => site.facility_id === facilityId && site.small_home);
    if (!fits) {
      throw new Error(`${plan.name} is for licensed homes with fewer than ${size.small_home_bed_limit} beds. In CareBase, record a current licence showing fewer than ${size.small_home_bed_limit} licensed beds for every facility on this plan.`);
    }
  }
}
