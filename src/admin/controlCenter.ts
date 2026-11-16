import { isHubAdminApp } from '../hubScope';
import { adminRegistry } from "../../supabase/functions/_shared/adminRegistry";
import type { PortfolioOperationName, PortfolioProduct } from "../../supabase/functions/_shared/portfolioProtocol";
import type { ContentItem, Product, SupportCase } from "../domain";
import { defaultIntegrationRollout, integrationRolloutBySlug } from "../data/integrationRollout";
import type { IntegrationRollout } from "../data/integrationRollout";
import { channels, describeChannels } from "../support/communicationsClient";
import type { Channel, ChannelStatus, ChannelSummary, CommunicationsClient } from "../support/communicationsClient";
import { knowledgeCoverage } from "../support/knowledgeCoverage";
import type { ReadinessProduct } from "../support/readiness";
import { phoneNeedsReview, phoneTextingNeedsAttention } from "../support/phoneRegistryModel";
import type { PhoneRow } from "../support/phoneRegistryModel";
import { applicationLabel, overviewMetrics } from "./overviewMetrics";
import type { OverviewMetric } from "./overviewMetrics";
import { buildPortfolioRollup } from "./portfolioRollup";
import { accessControls } from "./coverageMatrix";
import type { RollupAppSnapshot } from "./portfolioRollup";
import type { GoLiveReadinessReport } from "./readinessProtocol";
import type { AiUsageSummary } from "./aiUsageClient";

/**
 * The control center reads every application, channel and Hub service through
 * the clients the dedicated workspaces already use, then lays the results side
 * by side. Nothing here estimates: a read that failed or was never advertised
 * stays visibly unavailable, exactly as the portfolio rollup treats it.
 */

/** The Hub product slug each administration connection belongs to. Only Intel's differs from its connection id. */
export const hubProductSlugs: Record<PortfolioProduct, string> = {
  carebase: "carebase", breathe: "breathe", "caremetric-emr": "caremetric-emr", pennsync: "pennsync",
  intel: "caremetric-intel", "caremetric-go": "caremetric-go", advisors: "advisors",
};
export function hubProductFor(product: PortfolioProduct, products: readonly Product[]): Product | null {
  return products.find(item => item.slug === hubProductSlugs[product]) ?? null;
}

/** Conversations that still need staff attention (every status except closed), with the per-status breakdown the inbox shows. */
export interface ConversationCounts { waiting: number; statusCounts: Record<string, number> }
export interface CommunicationsSnapshot {
  status: ChannelStatus;
  all: ConversationCounts;
  byChannel: Record<Channel, ConversationCounts>;
  /** Keyed by Hub product id. Retired products are not queried. */
  byProduct: Record<string, ConversationCounts>;
}
export type CommunicationsReader = Pick<CommunicationsClient, "channels" | "list">;

async function conversationCounts(client: CommunicationsReader, filter: { channel?: Channel; productId?: string }, signal: AbortSignal): Promise<ConversationCounts> {
  // One row is enough: the inbox read returns the filtered total and status counts alongside the page.
  const page = await client.list({ status: "active", ...filter, offset: 0, limit: 1 }, signal);
  return { waiting: page.total, statusCounts: page.statusCounts };
}

/** Channel status plus waiting counts for every channel and every application, through the same inbox reads staff use. */
export async function loadCommunicationsSnapshot(client: CommunicationsReader, products: readonly Product[], signal: AbortSignal): Promise<CommunicationsSnapshot> {
  const listed = products.filter(product => product.status !== "retired" && isHubAdminApp(product.slug));
  const [status, all, channelCounts, productCounts] = await Promise.all([
    client.channels(signal),
    conversationCounts(client, {}, signal),
    Promise.all(channels.map(channel => conversationCounts(client, { channel }, signal))),
    Promise.all(listed.map(product => conversationCounts(client, { productId: product.id }, signal))),
  ]);
  return {
    status, all,
    byChannel: Object.fromEntries(channels.map((channel, index) => [channel, channelCounts[index]])) as Record<Channel, ConversationCounts>,
    byProduct: Object.fromEntries(listed.map((product, index) => [product.id, productCounts[index]])),
  };
}

export interface ChannelCard extends ChannelSummary { waiting: number; href: string }
/** The five customer channels with their live status and how many conversations each has waiting. */
export function channelCards(snapshot: CommunicationsSnapshot): ChannelCard[] {
  return describeChannels(snapshot.status).map(summary => ({ ...summary, waiting: snapshot.byChannel[summary.channel].waiting, href: `/communications?channel=${summary.channel}` }));
}

export type CardState = "ready" | "unavailable" | "not-provided" | "not-applicable";
export type ConnectionState = "verified" | "unavailable" | "pending";
export interface SubscriptionSummary { count: number; statusCounts: Array<{ status: string; count: number }>; sharedWith: PortfolioProduct | null; mrrCents: number }
export interface DirectorySummary { state: "available" | "partial" | "missing" | "unavailable" | "not-applicable"; label: string; organizations: boolean; users: boolean; accessControls: boolean }
export interface IntegrationSummary { rollout: IntegrationRollout; connection: ConnectionState; endpointHost: string | null; sources: string[] }
export interface SupportSummary { productId: string; openCases: number; urgentCases: number; conversations: number | null; publishedArticles: number; appSpecificArticles: number; /** AI calls in the usage period, or null when the ledger read is unavailable. */ aiCalls: number | null }
export interface IntakeSummary { supportEnabled: boolean; readyTenants: number; activeTenants: number; smsMembers: number }
export interface ApplicationLinks { workspace: string; organizations: string; users: string; billing: string; inquiries: string; communications: string | null; cases: string | null; knowledge: string | null }
export interface ApplicationCard {
  product: PortfolioProduct;
  name: string;
  scope: string;
  hubProduct: Product | null;
  connection: { state: ConnectionState; sourceRevision: string | null };
  health: { state: CardState; metrics: OverviewMetric[] };
  subscriptions: { state: CardState; data: SubscriptionSummary | null; note: string | null };
  directory: DirectorySummary;
  integration: IntegrationSummary;
  /** Null when the Hub has no product registered for this connection, so no cases, conversations or articles can belong to it. */
  support: SupportSummary | null;
  intake: { state: CardState; data: IntakeSummary | null; note: string };
  /** What the owner can change in the application from the Hub, from what its live connection advertises. */
  controls: { state: "available" | "view-only" | "unavailable" | "not-applicable"; label: string };
  links: ApplicationLinks;
}

export interface ControlCenterInput {
  apps: readonly RollupAppSnapshot[];
  products: readonly Product[];
  cases: readonly SupportCase[];
  content: readonly ContentItem[];
  /** Null when the inbox reads failed (or have not answered); counts are then unavailable, never zero. */
  communications: CommunicationsSnapshot | null;
  /** Null when the customer intake readiness read failed (or have not answered). */
  readiness: readonly ReadinessProduct[] | null;
  /** Null when the AI usage ledger read failed (or has not answered). */
  aiUsage: AiUsageSummary | null;
}

const has = (app: RollupAppSnapshot, operation: PortfolioOperationName) => app.capabilities?.operations.includes(operation) === true;
const openCase = (item: SupportCase) => !["resolved", "closed"].includes(item.status);
const unavailableDirectory: DirectorySummary = { state: "unavailable", label: "Connection unavailable", organizations: false, users: false, accessControls: false };

/** One card per application, derived only from what each live connection and the Hub's own records provide. */
export function applicationCards(input: ControlCenterInput): ApplicationCard[] {
  const coverage = knowledgeCoverage([...input.products], [...input.content]);
  return input.apps.map(app => {
    const { product } = app;
    const registry = adminRegistry[product];
    const advisors = product === "advisors";
    const hubProduct = hubProductFor(product, input.products);
    const connected = app.capabilities !== null;
    const connectionState: ConnectionState = !registry.endpoint ? "pending" : connected ? "verified" : "unavailable";
    const connection = { state: connectionState, sourceRevision: app.capabilities?.sourceRevision ?? null };

    const health: ApplicationCard["health"] = app.overview.state === "ready" ? { state: "ready", metrics: overviewMetrics(product, app.overview.data) }
      : !connected ? { state: "unavailable", metrics: [] }
      : app.overview.state === "not-advertised" ? { state: "not-provided", metrics: [] }
      : { state: "unavailable", metrics: [] };

    // Subscriptions come from the Hub's own billing (Stripe mirror), so they read even when the connection is down.
    const subscriptions: ApplicationCard["subscriptions"] = advisors ? { state: "not-applicable", data: null, note: "Consulting practice · engagement fees are set by written proposal" }
      : app.billing.state === "ready" ? {
        state: "ready",
        data: { count: app.billing.data.subscriptionCount, statusCounts: app.billing.data.statusCounts, sharedWith: null, mrrCents: app.billing.data.mrrCents },
        note: "Billed by the Hub",
      }
      : { state: "unavailable", data: null, note: "Hub billing could not be loaded" };

    const organizations = has(app, "organizations.list"), users = has(app, "users.list");
    const access = accessControls(app);
    const changes = connected && access.state === "available";
    // Users have access controls in CareBase and Intel (the access dialog) and in Breathe (its own staff review, when advertised).
    const accessControlsFor = changes && (product === "carebase" || product === "intel" || product === "breathe" && has(app, "staff.access.apply"));
    const directory: DirectorySummary = advisors ? { state: "not-applicable", label: "No software accounts", organizations: false, users: false, accessControls: false }
      : !connected ? unavailableDirectory
      : organizations && users ? { state: "available", label: changes ? "Organizations, users and access controls" : "Organizations and users", organizations, users, accessControls: changes }
      : users ? { state: "partial", label: accessControlsFor ? "Users and access controls" : "Users only", organizations, users, accessControls: accessControlsFor }
      : organizations ? { state: "partial", label: "Organizations only", organizations, users, accessControls: changes }
      : { state: "missing", label: "Not provided yet", organizations, users, accessControls: false };
    const controls: ApplicationCard["controls"] = advisors ? { state: connected ? "available" : "unavailable", label: "Consultation requests: status, notes and delete" }
      : !connected ? { state: "unavailable", label: "Unavailable until the connection answers" }
      : access.state === "available" ? { state: "available", label: access.label }
      : { state: "view-only", label: "View only from the Hub" };

    const rollout = integrationRolloutBySlug[hubProductSlugs[product]] ?? defaultIntegrationRollout;
    const sources = [
      ...(product === "breathe" && has(app, "phone.messages.list") ? ["Phone-line messages import"] : []),
      ...(advisors && has(app, "inquiries.list") ? ["Consultation request import"] : []),
    ];
    const integration: IntegrationSummary = { rollout, connection: connectionState, endpointHost: registry.endpoint ? new URL(registry.endpoint).host : null, sources };

    const open = hubProduct ? input.cases.filter(item => item.productId === hubProduct.id && openCase(item)) : [];
    const articles = hubProduct ? coverage.find(item => item.product.id === hubProduct.id) : undefined;
    const support: SupportSummary | null = hubProduct ? {
      productId: hubProduct.id,
      openCases: open.length,
      urgentCases: open.filter(item => item.priority === "urgent").length,
      conversations: input.communications?.byProduct[hubProduct.id]?.waiting ?? null,
      publishedArticles: articles?.published ?? 0,
      appSpecificArticles: articles?.appSpecific ?? 0,
      aiCalls: input.aiUsage ? input.aiUsage.products.find(item => item.productId === hubProduct.id)?.calls ?? 0 : null,
    } : null;

    const readiness = hubProduct && input.readiness ? input.readiness.find(item => item.id === hubProduct.id) ?? null : null;
    const intake: ApplicationCard["intake"] = advisors ? { state: "not-applicable", data: null, note: "Consulting practice · no customer accounts" }
      : input.readiness === null ? { state: "unavailable", data: null, note: "Customer intake readiness could not be loaded" }
      : !readiness ? { state: "not-provided", data: null, note: "Not registered for customer support intake" }
      : {
        state: "ready",
        data: { supportEnabled: readiness.supportEnabled, readyTenants: readiness.readyTenantCount, activeTenants: readiness.activeTenantCount, smsMembers: readiness.usableMemberCount },
        note: readiness.supportEnabled ? `${readiness.readyTenantCount} of ${readiness.activeTenantCount} active customers ready · ${readiness.usableMemberCount} SMS-verified members` : "Support is disabled for this application",
      };

    const workspace = `/admin/apps?product=${product}`;
    const links: ApplicationLinks = {
      workspace, organizations: `${workspace}&view=organizations`, users: `${workspace}&view=users`, billing: `/admin/billing?app=${hubProductSlugs[product]}`, inquiries: `${workspace}&view=inquiries`,
      communications: hubProduct ? `/communications?product=${hubProduct.slug}` : null,
      cases: hubProduct ? `/cases?product=${hubProduct.slug}` : null,
      knowledge: hubProduct ? `/knowledge?product=${hubProduct.slug}` : null,
    };
    return { product, name: applicationLabel(product), scope: registry.userScope, hubProduct, connection, health, subscriptions, directory, integration, support, intake, controls, links };
  });
}

export interface Headline {
  connected: number;
  total: number;
  /** Subscriptions the Hub bills across every application, or null when Hub billing could not be read. */
  subscriptions: number | null;
  subscriptionApps: string[];
  /** Conversations waiting across every channel and application, or null when the inbox read is unavailable. */
  conversations: number | null;
  openCases: number;
  urgentCases: number;
  channelsLive: number | null;
  channelsTotal: number;
}

/** Portfolio-wide figures; subscriptions come from the Hub's billing, one record per Stripe subscription. */
export function headline(input: ControlCenterInput): Headline {
  const totals = buildPortfolioRollup(input.apps);
  const open = input.cases.filter(openCase);
  return {
    connected: totals.connectionsVerified,
    total: totals.connectionsTotal,
    subscriptions: totals.subscriptionTotal,
    subscriptionApps: totals.billingReportingApps.map(product => adminRegistry[product].name),
    conversations: input.communications?.all.waiting ?? null,
    openCases: open.length,
    urgentCases: open.filter(item => item.priority === "urgent").length,
    channelsLive: input.communications ? describeChannels(input.communications.status).filter(item => item.ready).length : null,
    channelsTotal: channels.length,
  };
}

export interface PhoneSummary { total: number; active: number; needsReview: number; textingAttention: number }
/** The phone registry's own inventory counters (its "Need review" tile and filter use phoneNeedsReview too), so the control center
 * and the registry page always agree. */
export function phoneSummary(rows: readonly PhoneRow[]): PhoneSummary {
  return {
    total: rows.length,
    active: rows.filter(row => row.lifecycle === "active").length,
    needsReview: rows.filter(phoneNeedsReview).length,
    textingAttention: rows.filter(phoneTextingNeedsAttention).length,
  };
}

export interface ServiceCheck { label: string; done: boolean; detail: string }
/** The four AI go-live prerequisites, summarized from the live report. The Anthropic key is presence only. */
export function goLiveChecks(report: GoLiveReadinessReport): ServiceCheck[] {
  const applied = report.migrations.items.filter(item => item.applied).length;
  return [
    { label: "Production migrations", done: report.migrations.complete, detail: `${applied} of ${report.migrations.items.length} applied` },
    { label: "Anthropic API key", done: report.anthropicKey.present, detail: report.anthropicKey.present ? "Configured on the Hub service" : "Not configured on the Hub service" },
    { label: "AI automation", done: report.aiAutomation.enabled, detail: report.aiAutomation.enabled ? "Customer auto-resolution loop is on" : "Off until switched on in Settings → Customer support → AI answers on new support cases" },
    { label: report.helpDomain.hostname, done: report.helpDomain.resolves, detail: report.helpDomain.resolves ? `Resolves to ${report.helpDomain.targets.join(", ")}` : "DNS record not found yet" },
  ];
}
