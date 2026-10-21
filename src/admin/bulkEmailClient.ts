import { z } from 'zod';
import { appRequest } from '../lib/appSession';

/** Applications whose administration connection exposes a user directory (users.list). */
export const directorySlugs = ['carebase', 'breathe', 'caremetric-emr', 'pennsync', 'caremetric-intel', 'caremetric-go'] as const;
export const maxSubject = 150, maxBody = 20000;

const count = z.number().int().min(0);
const valueCount = z.object({ value: z.string(), users: count, withEmail: count });
const sourceSchema = z.object({
  productId: z.guid(), productName: z.string(), productSlug: z.string(),
  total: count.nullable(), read: count, nextOffset: count, loaded: z.boolean(), truncated: z.boolean(),
  roles: z.array(z.string()), statuses: z.array(z.string()), roleCounts: z.array(valueCount), statusCounts: z.array(valueCount),
});
export type EmailSource = z.infer<typeof sourceSchema>;
export const campaignStatuses = ['loading', 'ready', 'sending', 'sent', 'cancelled'] as const;
export type CampaignStatus = typeof campaignStatuses[number];
export const campaignSchema = z.object({
  id: z.guid(), status: z.enum(campaignStatuses), subject: z.string(), body: z.string(), version: z.number().int().positive(),
  createdAt: z.string(), updatedAt: z.string(), queuedAt: z.string().nullable(), completedAt: z.string().nullable(),
  recipientCount: count, sources: z.array(sourceSchema),
  audience: z.object({ selectedUsers: count, withoutEmail: count, unsubscribed: count, recipients: count }).nullable(),
  delivery: z.object({ queued: count, sending: count, sent: count, failed: count, unknown: count, cancelled: count }),
  unsubscribed: count,
});
export type Campaign = z.infer<typeof campaignSchema>;
const summarySchema = z.object({
  id: z.guid(), status: z.enum(campaignStatuses), subject: z.string(), recipientCount: count,
  createdAt: z.string(), queuedAt: z.string().nullable(), completedAt: z.string().nullable(), applications: z.array(z.string()),
  delivery: z.object({ outstanding: count, sent: count, failed: count, unknown: count, cancelled: count }), unsubscribed: count,
});
export type CampaignSummary = z.infer<typeof summarySchema>;
const listSchema = z.object({ campaigns: z.array(summarySchema), loadedAt: z.string() });
/** Roles and statuses to include, per application, keyed by product id. */
export type Selection = Record<string, { roles: string[]; statuses: string[] }>;

const post = (action: string, body: unknown, signal?: AbortSignal) => appRequest<unknown>(`admin/bulk-email/${action}`, body, signal);
export const bulkEmailClient = {
  async list(signal?: AbortSignal) { return listSchema.parse(await post('list', {}, signal)); },
  async get(id: string, signal?: AbortSignal) { return campaignSchema.parse(await post('get', { id }, signal)); },
  async create(productIds: string[]) { return campaignSchema.parse(await post('create', { productIds })); },
  /** Reads up to ten more directory pages; call again while the campaign is loading. */
  async load(id: string, signal?: AbortSignal) { return campaignSchema.parse(await post('load', { id }, signal)); },
  async save(campaign: Campaign, subject: string, body: string, selection: Selection) {
    return campaignSchema.parse(await post('save', { id: campaign.id, subject, body, selection, version: campaign.version }));
  },
  async test(campaign: Campaign, to: string) { return z.object({ delivery: z.enum(['sent', 'failed', 'unknown']) }).parse(await post('test', { id: campaign.id, to })); },
  /** Sends to exactly the recipient count the administrator reviewed; a different count is refused. */
  async send(campaign: Campaign, recipients: number) { return campaignSchema.parse(await post('send', { id: campaign.id, version: campaign.version, recipients })); },
  async cancel(campaign: Campaign) { return campaignSchema.parse(await post('cancel', { id: campaign.id })); },
};
export type BulkEmailClient = typeof bulkEmailClient;

export function selectionOf(campaign: Campaign): Selection {
  return Object.fromEntries(campaign.sources.map(source => [source.productId, { roles: [...source.roles], statuses: [...source.statuses] }]));
}
export function sameSelection(a: Selection, b: Selection) {
  const sorted = (values: string[]) => [...values].sort().join('\u0000');
  return Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([id, choice]) =>
    !!b[id] && sorted(choice.roles) === sorted(b[id].roles) && sorted(choice.statuses) === sorted(b[id].statuses));
}
/** "org_admin" → "Org admin". The raw value stays visible in the title for exactness. */
export function valueLabel(value: string) {
  const words = value.replace(/[_-]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : value;
}
export const statusLabels: Record<CampaignStatus, string> = { loading: 'Reading users', ready: 'Draft', sending: 'Sending', sent: 'Sent', cancelled: 'Cancelled' };
/** Plain text without control characters other than line breaks and tabs. */
export function plainBody(value: string) {
  return [...value].every(char => { const code = char.charCodeAt(0); return code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127); });
}
