import { z } from "zod";

/**
 * What the Hub returns for the Leads screen: `POST /api/rpc/list_leads` (a page) and `POST /api/admin/leads/status`
 * (one lead). A lead carries the contact's details and short facts only. What the visitor wrote lives only in the
 * lead's conversation in Communications, never here. The server integration test parses the real database output
 * with these same schemas, so the stored JSON cannot change on one side alone.
 */
export const leadKinds = ["demo_request", "consultation", "contact", "trial_signup", "newsletter", "savings_model", "county_report"] as const;
export const leadSources = ["carebase", "intel", "advisors"] as const;
export const leadStatuses = ["new", "contacted", "qualified", "won", "lost", "spam"] as const;
export type LeadKind = (typeof leadKinds)[number];
export type LeadSource = (typeof leadSources)[number];
export type LeadStatus = (typeof leadStatuses)[number];

export const leadKindLabels: Record<LeadKind, string> = {
  demo_request: "Demo request", consultation: "Consultation request", contact: "Contact request", trial_signup: "Trial sign-up",
  newsletter: "Newsletter sign-up", savings_model: "Savings calculator", county_report: "County report",
};
export const leadSourceLabels: Record<LeadSource, string> = { carebase: "CareBase", intel: "Intel", advisors: "Healthcare Advisors" };
export const leadStatusLabels: Record<LeadStatus, string> = {
  new: "New", contacted: "Contacted", qualified: "Qualified", won: "Won", lost: "Lost", spam: "Spam",
};

/**
 * A lead's address, exactly as the Hub's intake and its table check it (20261103120000_lead_desk.sql): lowercase letters,
 * digits and . _ ' + - in dot-separated parts before one @, and dot-separated labels of letters, digits and hyphens
 * after it. Nothing that means something in a URL or a mailto: link (? & # % / \ , ; : = and the like).
 */
export const leadEmailPattern = /^[a-z0-9_'+-]+(\.[a-z0-9_'+-]+)*@[a-z0-9-]+(\.[a-z0-9-]+)+$/;

const instant = z.string().min(10).max(64);
const optional = z.string().nullable();
export const leadSchema = z.object({
  id: z.uuid(),
  source: z.enum(leadSources),
  kind: z.enum(leadKinds),
  externalId: z.string().min(1).max(100),
  /** A probe from the AI team's end-to-end form check. Never a real person. */
  test: z.boolean(),
  occurredAt: instant,
  receivedAt: instant,
  contact: z.object({ name: optional, email: z.string().min(3).max(320).regex(leadEmailPattern), phone: optional, organization: optional, role: optional }),
  details: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  attribution: z.object({
    utmSource: optional, utmMedium: optional, utmCampaign: optional, utmTerm: optional, utmContent: optional,
    referrerHost: optional, landingPath: optional, firstSeenAt: instant.nullable(),
  }),
  productId: z.uuid().nullable(),
  conversation: z.object({ id: z.uuid(), reference: z.string().regex(/^CM-\d+$/), status: z.enum(["new", "open", "waiting", "closed"]) }).nullable(),
  status: z.enum(leadStatuses),
  createdAt: instant,
  /** Handed back untouched with a status change so the database can refuse a stale one. */
  updatedAt: instant,
});
export const leadPageSchema = z.object({
  items: z.array(leadSchema), total: z.number().int().nonnegative(), offset: z.number().int().nonnegative(), limit: z.number().int().positive(),
  /** The deepest offset hub.list_leads serves. The screen reads it from each page and stops paging there. */
  maxOffset: z.number().int().nonnegative(),
});
export type Lead = z.infer<typeof leadSchema>;
export type LeadPage = z.infer<typeof leadPageSchema>;

/** Where the person came from, in a few words: the campaign first, then the site that sent them and the page they landed on. */
export function attributionSummary(attribution: Lead["attribution"]): string {
  const campaign = [attribution.utmSource, attribution.utmMedium].filter(Boolean).join(" / ");
  const parts = [
    campaign ? `${campaign}${attribution.utmCampaign ? ` (${attribution.utmCampaign})` : ""}` : attribution.utmCampaign ?? "",
    attribution.referrerHost ? `from ${attribution.referrerHost}` : "",
    attribution.landingPath ? `landed on ${attribution.landingPath}` : "",
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : "Direct or not recorded";
}

/** A detail key as words: facilityCount → "Facility count", the way the conversation's message lists it. */
export function detailLabel(key: string): string {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function detailValue(value: string | number | boolean): string {
  return typeof value === "boolean" ? (value ? "Yes" : "No") : String(value);
}
