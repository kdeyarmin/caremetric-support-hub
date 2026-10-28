import { z } from 'zod';
import { selfServiceApps, sourceId } from '../self-service/protocol.ts';

export const facilityEntitlementRequest = z.object({
  version: z.literal(1), account: sourceId,
  facility_ids: z.array(sourceId).max(1000).refine(ids => new Set(ids).size === ids.length, 'Choose each facility once.'),
}).strict();

export const facilityEntitlementSnapshot = z.object({
  contract: z.literal('caremetric.facility-entitlements.v1'), app: z.enum(selfServiceApps), account: sourceId,
  billing_mode: z.enum(['legacy', 'facility']), revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  checked_at: z.iso.datetime({ offset: true }), cache_ttl_seconds: z.number().int().min(1).max(300),
  facilities: z.array(z.object({ id: sourceId, status: z.enum(['none', 'trialing', 'active', 'past_due', 'paused', 'unpaid', 'incomplete', 'suspended']), entitled: z.boolean(),
    products: z.array(z.object({ key: z.string(), kind: z.enum(['plan', 'addon']), quantity: z.number().int().positive(),
      unit_label: z.string(), package_id: z.string(),
    })).max(20),
  })).max(1000),
});
export type FacilityEntitlementSnapshot = z.infer<typeof facilityEntitlementSnapshot>;
