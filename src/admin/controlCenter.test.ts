import { describe, expect, it, vi } from "vitest";
import type { PortfolioOperationName, PortfolioProduct } from "../../supabase/functions/_shared/portfolioProtocol";
import type { ContentItem, Product, SupportCase } from "../domain";
import type { ReadinessProduct } from "../support/readiness";
import type { PhoneRow } from "../support/phoneRegistryModel";
import { applicationCards, channelCards, goLiveChecks, headline, hubProductFor, loadCommunicationsSnapshot, phoneSummary } from "./controlCenter";
import type { CommunicationsSnapshot } from "./controlCenter";
import type { RollupAppSnapshot } from "./portfolioRollup";

const product = (slug: string, id = `id-${slug}`): Product => ({ id, slug, name: slug, description: "", status: "active", color: "#000" });
const products = ["carebase", "breathe", "pennsync", "caremetric-emr", "caremetric-go", "caremetric-intel", "advisors"].map(slug => product(slug));
const app = (id: PortfolioProduct, operations: PortfolioOperationName[] | null, extra: Partial<RollupAppSnapshot> = {}): RollupAppSnapshot => ({
  product: id, capabilities: operations ? { apiVersion: 1, operations, sourceRevision: "abc1234" } : null,
  overview: { state: "not-advertised" }, billing: { state: "not-advertised" }, money: [], ...extra,
});
const supportCase = (productId: string, status: SupportCase["status"], priority: SupportCase["priority"] = "normal"): SupportCase => ({
  id: `${productId}-${status}-${priority}-${Math.random()}`, caseNumber: 1, tenantId: "t", tenantName: "Tenant", productId, requesterId: "r", requesterName: "Pat", subject: "Help", category: "general",
  priority, status, source: "portal", assignedTo: null, assignedToName: null, appVersion: null, route: null, createdAt: "2026-10-20T00:00:00Z", updatedAt: "2026-10-20T00:00:00Z", lastMessageAt: "2026-10-20T00:00:00Z", aiStage: null, aiAttempts: null,
});
const article = (productIds: string[], status: ContentItem["status"] = "published"): ContentItem => ({
  id: `a-${productIds.join("-")}-${status}`, contentKey: "k", kind: "article", title: "T", summary: "S", body: null, status, accessLevel: "public", productIds, audience: [], locale: "en-US", revision: 1, sourceSystem: "support_hub", routePattern: null,
});
const snapshot = (byProduct: Record<string, number>, byChannel: Partial<Record<string, number>> = {}, status?: CommunicationsSnapshot["status"]): CommunicationsSnapshot => ({
  status: status ?? { sms: { inbound: false, replies: false }, email: { inbound: true, replies: true }, chat: { enabled: false }, phone: { sync: true }, webForm: { sync: true } },
  all: { waiting: Object.values(byProduct).reduce((sum, n) => sum + n, 0), statusCounts: {} },
  byChannel: { phone: { waiting: byChannel.phone ?? 0, statusCounts: {} }, sms: { waiting: byChannel.sms ?? 0, statusCounts: {} }, email: { waiting: byChannel.email ?? 0, statusCounts: {} }, chat: { waiting: byChannel.chat ?? 0, statusCounts: {} }, web_form: { waiting: byChannel.web_form ?? 0, statusCounts: {} } },
  byProduct: Object.fromEntries(Object.entries(byProduct).map(([id, waiting]) => [id, { waiting, statusCounts: {} }])),
});
const readiness = (slug: string, change: Partial<ReadinessProduct> = {}): ReadinessProduct => ({ id: `id-${slug}`, slug, name: slug, status: "active", supportEnabled: true, activeTenantCount: 4, usableMemberCount: 6, readyTenantCount: 2, publishedItemCount: 9, ...change });

describe("control center model", () => {
  it("maps every administration connection to its Hub product, including Intel's different slug", () => {
    expect(hubProductFor("intel", products)?.slug).toBe("caremetric-intel");
    expect(hubProductFor("carebase", products)?.id).toBe("id-carebase");
    expect(hubProductFor("breathe", [])).toBeNull();
  });

  it("builds one card per application from live reads and Hub records without inventing figures", () => {
    const cases = [supportCase("id-carebase", "open", "urgent"), supportCase("id-carebase", "in_progress"), supportCase("id-carebase", "closed"), supportCase("id-breathe", "open")];
    const content = [article(["id-carebase"]), article(["id-carebase", "id-breathe"]), article(["id-carebase"], "draft")];
    const [carebase, breathe, go, advisors] = applicationCards({
      apps: [
        app("carebase", ["overview", "organizations.list", "users.list", "commands.preview", "commands.apply", "billing.overview", "billing.subscriptions.list"], {
          overview: { state: "ready", data: { organizationCount: 12, activeUserCount: 40 } },
          billing: { state: "ready", data: { source: "application_database", subscriptionCount: 5, statusCounts: [{ status: "active", count: 5 }] } },
        }),
        app("breathe", null),
        app("caremetric-go", ["users.list", "billing.overview", "billing.subscriptions.list"], { billing: { state: "ready", data: { source: "application_database", subscriptionCount: 3, statusCounts: [{ status: "active", count: 3 }] } } }),
        app("advisors", ["overview", "inquiries.list"], { overview: { state: "ready", data: { organizationCount: null, activeUserCount: null, inquiryCount: 7, openInquiryCount: 2 } } }),
      ],
      products, cases, content, communications: snapshot({ "id-carebase": 3, "id-breathe": 1 }), readiness: [readiness("carebase"), readiness("caremetric-go", { supportEnabled: false })],
      aiUsage: { days: 30, since: "2026-09-21T00:00:00Z", loadedAt: "2026-10-21T00:00:00Z", totals: { calls: 12, failedCalls: 1, staffCalls: 8, automationCalls: 4, inputTokens: 100, outputTokens: 50 }, unattributedCalls: 0,
        products: [{ productId: "id-carebase", slug: "carebase", name: "carebase", calls: 12, failedCalls: 1, staffCalls: 8, automationCalls: 4, inputTokens: 100, outputTokens: 50, tenants: [] }], features: [] },
    });

    expect(carebase.name).toBe("CareBase (PennTrain)");
    expect(carebase.connection).toEqual({ state: "verified", sourceRevision: "abc1234" });
    expect(carebase.health.state).toBe("ready");
    expect(carebase.health.metrics.map(metric => metric.label)).toEqual(["Organizations", "Active application profiles"]);
    expect(carebase.subscriptions).toEqual({ state: "ready", data: { count: 5, statusCounts: [{ status: "active", count: 5 }], sharedWith: null }, note: null });
    expect(carebase.directory).toEqual({ state: "available", label: "Organizations, users and access controls", organizations: true, users: true, accessControls: true });
    expect(carebase.integration.endpointHost).toBe("cmcarebase.com");
    expect(carebase.integration.rollout.state).toBe("in_progress");
    expect(carebase.support).toEqual({ productId: "id-carebase", openCases: 2, urgentCases: 1, conversations: 3, publishedArticles: 2, appSpecificArticles: 1, aiCalls: 12 });
    expect(carebase.intake.state).toBe("ready");
    expect(carebase.intake.note).toBe("2 of 4 active customers ready · 6 SMS-verified members");
    expect(carebase.links).toEqual({
      workspace: "/admin/apps?product=carebase", organizations: "/admin/apps?product=carebase&view=organizations", users: "/admin/apps?product=carebase&view=users",
      billing: "/admin/apps?product=carebase&view=billing", inquiries: "/admin/apps?product=carebase&view=inquiries",
      communications: "/communications?product=carebase", cases: "/cases?product=carebase", knowledge: "/knowledge?product=carebase",
    });

    // A silent connection: nothing is estimated, but the Hub's own support records still show.
    expect(breathe.connection.state).toBe("unavailable");
    expect(breathe.health).toEqual({ state: "unavailable", metrics: [] });
    expect(breathe.subscriptions).toEqual({ state: "unavailable", data: null, note: null });
    expect(breathe.directory.state).toBe("unavailable");
    // A product absent from the ledger made no recorded AI calls; an unavailable ledger would be null instead.
    expect(breathe.support).toEqual({ productId: "id-breathe", openCases: 1, urgentCases: 0, conversations: 1, publishedArticles: 1, appSpecificArticles: 0, aiCalls: 0 });
    expect(breathe.intake).toEqual({ state: "not-provided", data: null, note: "Not registered for customer support intake" });
    expect(breathe.integration.sources).toEqual([]);

    // Go shares EMR's records and says so; a disabled support product is reported as disabled.
    expect(go.subscriptions.data?.sharedWith).toBe("caremetric-emr");
    expect(go.subscriptions.note).toBe("Shared with CareMetric EMR · never counted twice");
    expect(go.directory).toEqual({ state: "partial", label: "Users only", organizations: false, users: true, accessControls: false });
    expect(go.intake.note).toBe("Support is disabled for this application");

    // Advisors is a consulting practice.
    expect(advisors.health.metrics.map(metric => [metric.label, metric.value])).toEqual([["Consultation requests · retained 365 days", 7], ["Open consultation requests", 2]]);
    expect(advisors.subscriptions.state).toBe("not-applicable");
    expect(advisors.directory.state).toBe("not-applicable");
    expect(advisors.intake.state).toBe("not-applicable");
    expect(advisors.integration.sources).toEqual(["Consultation request import"]);
  });

  it("marks reads the connection never advertised as not provided and failed reads as unavailable", () => {
    const [emr, pennsync] = applicationCards({
      apps: [app("caremetric-emr", ["users.list"]), app("pennsync", ["overview", "billing.overview"], { overview: { state: "unavailable" }, billing: { state: "unavailable" } })],
      products, cases: [], content: [], communications: null, readiness: null, aiUsage: null,
    });
    expect(emr.health.state).toBe("not-provided");
    expect(emr.subscriptions).toEqual({ state: "not-provided", data: null, note: "Not provided by this connection yet" });
    expect(emr.support?.conversations).toBeNull();
    expect(emr.support?.aiCalls).toBeNull();
    expect(emr.intake).toEqual({ state: "unavailable", data: null, note: "Customer intake readiness could not be loaded" });
    expect(pennsync.health.state).toBe("unavailable");
    expect(pennsync.subscriptions).toEqual({ state: "unavailable", data: null, note: "The billing read failed" });
  });

  it("reports the phone-line import as an inbox feed for Breathe only when its connection advertises it", () => {
    const [withFeed, withoutFeed] = applicationCards({ apps: [app("breathe", ["phone.messages.list"]), app("breathe", ["overview"])], products, cases: [], content: [], communications: null, readiness: null, aiUsage: null });
    expect(withFeed.integration.sources).toEqual(["Phone-line messages import"]);
    expect(withoutFeed.integration.sources).toEqual([]);
  });

  it("totals the portfolio the way the rollup does and leaves unavailable inbox figures null", () => {
    const apps = [
      app("carebase", ["billing.overview"], { billing: { state: "ready", data: { source: "application_database", subscriptionCount: 5, statusCounts: [{ status: "active", count: 5 }] } } }),
      app("caremetric-emr", ["billing.overview"], { billing: { state: "ready", data: { source: "application_database", subscriptionCount: 4, statusCounts: [{ status: "active", count: 4 }] } } }),
      app("caremetric-go", ["billing.overview"], { billing: { state: "ready", data: { source: "application_database", subscriptionCount: 4, statusCounts: [{ status: "active", count: 4 }] } } }),
      app("breathe", null),
    ];
    const cases = [supportCase("id-carebase", "open", "urgent"), supportCase("id-breathe", "waiting_on_customer"), supportCase("id-breathe", "resolved")];
    const live = headline({ apps, products, cases, content: [], communications: snapshot({ "id-carebase": 2, "id-breathe": 1 }, { sms: 1 }), readiness: null, aiUsage: null });
    expect(live).toEqual({ connected: 3, total: 4, subscriptions: 9, subscriptionApps: ["CareBase", "CareMetric EMR"], conversations: 3, openCases: 2, urgentCases: 1, channelsLive: 3, channelsTotal: 5 });
    const silent = headline({ apps: [app("breathe", null)], products, cases: [], content: [], communications: null, readiness: null, aiUsage: null });
    expect(silent).toMatchObject({ connected: 0, total: 1, subscriptions: null, subscriptionApps: [], conversations: null, channelsLive: null });
  });

  it("describes each channel with its waiting count and inbox link", () => {
    const cards = channelCards(snapshot({}, { phone: 2, sms: 1, email: 0, chat: 0, web_form: 4 }));
    expect(cards.map(card => [card.channel, card.ready, card.waiting, card.href])).toEqual([
      ["phone", true, 2, "/communications?channel=phone"], ["sms", false, 1, "/communications?channel=sms"], ["email", true, 0, "/communications?channel=email"],
      ["chat", false, 0, "/communications?channel=chat"], ["web_form", true, 4, "/communications?channel=web_form"],
    ]);
    expect(cards[1].detail).toBe("Not connected");
    expect(cards[2].detail).toBe("Receiving and replying");
  });

  it("loads channel status and waiting counts through the inbox reads staff use, one bounded page each", async () => {
    const status = { sms: { inbound: true, replies: false }, email: { inbound: false, replies: false }, chat: { enabled: true }, phone: { sync: true }, webForm: { sync: true } };
    const list = vi.fn(async (filter: { status?: string; channel?: string; productId?: string; offset: number; limit: number }) => ({
      items: [], total: filter.channel === "sms" ? 2 : filter.productId === "id-breathe" ? 3 : filter.productId ? 0 : 5, limit: filter.limit, offset: filter.offset, statusCounts: { new: 1 },
    }));
    const retired: Product = { ...product("retired-app"), status: "retired" };
    const result = await loadCommunicationsSnapshot({ channels: async () => status, list }, [products[0], products[1], retired], new AbortController().signal);
    expect(result.status).toEqual(status);
    expect(result.all.waiting).toBe(5);
    expect(result.byChannel.sms.waiting).toBe(2);
    expect(result.byProduct).toEqual({ "id-carebase": { waiting: 0, statusCounts: { new: 1 } }, "id-breathe": { waiting: 3, statusCounts: { new: 1 } } });
    expect(list).toHaveBeenCalledTimes(1 + 5 + 2);
    for (const [filter] of list.mock.calls) expect(filter).toMatchObject({ status: "active", offset: 0, limit: 1 });
    expect(list).not.toHaveBeenCalledWith(expect.objectContaining({ productId: retired.id }), expect.anything());
  });

  it("summarizes the phone inventory with the registry's own review rules", () => {
    const row = (change: Partial<PhoneRow>): PhoneRow => ({
      id: crypto.randomUUID(), version: 1, updated_at: "2026-10-20T00:00:00Z", number: "+12025550100", label: "Main", provider: "Twilio", account: "", tenant: "", account_type: "unknown", account_sid: "", parent_account_sid: "",
      business_profile_status: "approved", messaging_registration: "", migration_status: "active", purpose: "Support", apps: "", owner: "", lifecycle: "active", usage_status: "observed",
      voice_status: "configured", voice_routing: "", sms_status: "configured", sms_routing: "", last_used_on: "", reviewed_on: "2026-10-01", evidence: "Call log", notes: "", ...change,
    });
    expect(phoneSummary([row({}), row({ sms_status: "pending" }), row({ lifecycle: "retired", usage_status: "unknown" })])).toEqual({ total: 3, active: 2, needsReview: 2, textingAttention: 1 });
    expect(phoneSummary([])).toEqual({ total: 0, active: 0, needsReview: 0, textingAttention: 0 });
  });

  it("summarizes the AI go-live report without exposing anything but key presence", () => {
    const checks = goLiveChecks({
      checkedAt: "2026-10-21T00:00:00Z", migrations: { complete: false, items: [{ version: "1", name: "a", applied: true }, { version: "2", name: "b", applied: false }] },
      anthropicKey: { present: true }, aiAutomation: { enabled: false }, helpDomain: { hostname: "help.caremetric.ai", resolves: true, targets: ["support-hub-web-production.up.railway.app"] },
    });
    expect(checks).toEqual([
      { label: "Production migrations", done: false, detail: "1 of 2 applied" },
      { label: "Anthropic API key", done: true, detail: "Configured on the Hub service" },
      { label: "AI automation", done: false, detail: "Off until enabled on the Hub service" },
      { label: "help.caremetric.ai", done: true, detail: "Resolves to support-hub-web-production.up.railway.app" },
    ]);
  });
});
