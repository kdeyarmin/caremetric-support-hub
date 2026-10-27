import { z } from 'zod';

export const selfServiceApps = ['carebase', 'breathe', 'pennsync', 'caremetric-emr', 'caremetric-intel'] as const;
export const sourceId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
export const permission = z.enum(['employee.recovery', 'billing.manage', 'support.manage']);
export const facilitySchema = z.object({ id: sourceId, name: z.string().trim().min(1).max(180), permissions: z.array(permission).max(3) }).strict();
export const connectionProof = z.object({
  account: sourceId, user: sourceId, account_name: z.string().trim().min(2).max(180), display_name: z.string().trim().min(1).max(120),
  role: z.enum(['member', 'facility_admin', 'organization_admin']), facilities: z.array(facilitySchema).max(1000),
  capabilities: z.array(z.enum(['training.profile.v1', 'employee.recovery.v1', 'facility.entitlements.v1'])).max(3),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.facilities.map(facility => facility.id)).size !== value.facilities.length) ctx.addIssue({ code: 'custom', message: 'Duplicate facility.' });
});
export type ConnectionProof = z.infer<typeof connectionProof>;
export const recordStatuses = ['current', 'expiring', 'expired', 'pending_review', 'assigned', 'missing', 'historical', 'rejected', 'not_applicable'] as const;
export const profileRecord = z.object({
  source: z.string().min(1).max(64), id: sourceId, title: z.string().min(1).max(500),
  kind: z.enum(['training', 'certificate', 'credential', 'assignment', 'outside_training']),
  completed_on: z.string().nullable(), expires_on: z.string().nullable(), warning_days: z.number().int().min(0).max(3650),
  status: z.enum(recordStatuses), href: z.string().max(2048).nullable(),
  source_revision: z.string().max(128).optional(), verification_status: z.string().max(64).optional(),
}).strict();
export type ProfileRecord = z.infer<typeof profileRecord>;
export const profilePage = z.object({ records: z.array(profileRecord).max(500), next_cursor: z.number().int().min(0).nullable(), generated_at: z.string() }).strict();
export const nativeOperation = z.discriminatedUnion('action', [
  z.object({ action: z.literal('scope.read') }).strict(),
  z.object({ action: z.literal('profile.read'), cursor: z.number().int().min(0).max(1_000_000) }).strict(),
  z.object({ action: z.literal('employees.list') }).strict(),
  z.object({ action: z.literal('diagnostics.read') }).strict(),
  z.object({ action: z.literal('billing.authorize'), facility_id: sourceId.nullable() }).strict(),
  z.object({ action: z.literal('recovery.execute'), target: sourceId, recovery_action: z.enum(['unlock', 'reset_link', 'resend_invitation', 'temporary_password']),
    reason: z.string().trim().min(10).max(500), request_id: z.uuid() }).strict(),
]);
export type NativeOperation = z.infer<typeof nativeOperation>;
export const selfServiceRequest = z.discriminatedUnion('action', [
  z.object({ action: z.literal('workspace') }).strict(),
  z.object({ action: z.literal('connect'), token: z.string().regex(/^cmc_[A-Za-z0-9_-]{43}$/), confirmed: z.literal(true) }).strict(),
  z.object({ action: z.literal('native'), connection_id: z.uuid(), operation: nativeOperation }).strict(),
  z.object({ action: z.literal('prepare'), connection_id: z.uuid(), operation: nativeOperation }).strict(),
  z.object({ action: z.literal('confirm'), confirmation_id: z.uuid() }).strict(),
]);
export const connectionSchema = z.object({ id: z.uuid(), tenant_id: z.uuid(), app: z.enum(selfServiceApps), name: z.string(), role: connectionProof.shape.role,
  facilities: z.array(facilitySchema), capabilities: z.array(z.string()), connected_at: z.string() });
export const workspaceSchema = z.object({ connections: z.array(connectionSchema), loaded_at: z.string() });
export type SelfServiceWorkspace = z.infer<typeof workspaceSchema>;

/** Native URLs come from the fixed application adapter, and must stay on its HTTPS origin. */
export function trustedRecordHref(value: string | null, origin: string): string | null {
  if (!value) return null;
  try { const url = new URL(value, origin); return url.origin === origin && url.protocol === 'https:' && !url.username && !url.password ? url.href : null; } catch { return null; }
}
export function deduplicateProfile(records: ProfileRecord[]): ProfileRecord[] {
  const bySource = new Map<string, ProfileRecord>();
  for (const record of records) bySource.set(`${record.source}:${record.id}`, record);
  return [...bySource.values()].sort((a, b) => (a.expires_on ?? '9999').localeCompare(b.expires_on ?? '9999') || a.title.localeCompare(b.title));
}
