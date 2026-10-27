import { z } from 'zod';
import { sourceId } from '../self-service/protocol.ts';

export const customerBillingRequest = z.discriminatedUnion('action', [
  z.object({ action: z.literal('workspace'), connection_id: z.uuid() }).strict(),
  z.object({ action: z.literal('activate_facility_billing'), connection_id: z.uuid(), confirmed: z.literal(true), expected_version: z.number().int().nonnegative() }).strict(),
  z.object({ action: z.literal('quote'), connection_id: z.uuid(), facility_id: sourceId.nullable(), plan: z.string().min(1).max(255).nullable(), addons: z.array(z.string().min(1).max(255)).max(20), request_id: z.uuid() }).strict(),
  z.object({ action: z.literal('confirm'), quote_id: z.uuid(), confirmed: z.literal(true) }).strict(),
]);
export const sellablePrice = z.object({ id: z.string(), product: z.string(), name: z.string(), description: z.string(), kind: z.enum(['plan', 'addon']),
  key: z.string(), features: z.array(z.string()), allows_addons: z.boolean(), active: z.boolean(),
  amount: z.number().int().nonnegative(), currency: z.string().length(3), interval: z.enum(['month', 'year']),
  model: z.enum(['flat', 'per_unit']), unit_label: z.string(), interval_count: z.number().int().positive(),
});
export type SellablePrice = z.infer<typeof sellablePrice>;
export const allocation = z.object({ facility_id: sourceId, facility_name: z.string(), plan: z.string().nullable(), addons: z.array(z.string()), version: z.number().int(),
  pending_plan: z.string().nullable().optional(), pending_addons: z.array(z.string()).optional(), pending_at: z.string().nullable().optional() });
export type FacilityAllocation = z.infer<typeof allocation>;
export const customerBillingWorkspace = z.object({ connection_id: z.uuid(), tenant_id: z.uuid(), app: z.string(), role: z.string(),
  mode: z.enum(['legacy', 'facility']), can_activate: z.boolean(), configuration_version: z.number().int(),
  purchasing_enabled: z.boolean().default(false),
  billing_revision: z.number().int().nonnegative().default(0),
  facilities: z.array(z.object({ id: sourceId, name: z.string(), permissions: z.array(z.string()) })),
  allocations: z.array(allocation), catalog: z.array(sellablePrice),
  subscription: z.object({ id: z.string(), version: z.number().int(), status: z.string(), current_period_end: z.string().nullable(), interval: z.enum(['month', 'year']), currency: z.string(),
    items: z.array(z.object({ id: z.string(), price: z.string(), quantity: z.number().int() })) }).nullable(),
  customer: z.string().nullable(), loaded_at: z.string(),
});
export type CustomerBillingWorkspace = z.infer<typeof customerBillingWorkspace>;
export const customerQuoteSchema = z.object({ id: z.uuid(), facility_name: z.string(), due_now: z.number().int(), currency: z.string(), recurring_subtotal: z.number().int(),
  effective_at: z.string().nullable(), expires_at: z.string(), has_immediate_change: z.boolean(), has_scheduled_change: z.boolean(),
  cancels_scheduled_change: z.boolean().default(false),
  summary: z.array(z.object({ name: z.string(), quantity: z.number().int(), amount: z.number().int() })) });
export type CustomerQuote = z.infer<typeof customerQuoteSchema>;
