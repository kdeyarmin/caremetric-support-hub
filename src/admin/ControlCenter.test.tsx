// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type { PortfolioCapabilities, PortfolioOverview, PortfolioProduct } from "../../supabase/functions/_shared/portfolioProtocol";
import type { Subscription } from "../billing/billingModel";
import type { ContentItem, Product, SupportCase } from "../domain";
import type { ChannelStatus } from "../support/communicationsClient";
import type { PhoneRegistryClient } from "../support/phoneRegistryModel";
import type { ReadinessClient as SupportReadinessClient } from "../support/readiness";
import { ControlCenter } from "./ControlCenter";
import type { ControlCenterClients } from "./ControlCenter";
import type { PortfolioClient } from "./portfolioClient";
import type { ReadinessClient as GoLiveClient } from "./readinessClient";
import type { AiUsageClient, AiUsageSummary } from "./aiUsageClient";
import type { IntegrationSetupClient, IntegrationSetupReport } from "./integrationSetupClient";

// DOM tests inject every data client; initialize the app's ordinary explicit preview configuration.
vi.hoisted(() => { vi.stubEnv("VITE_DEMO_MODE", "true"); });
afterEach(cleanup);

const product = (slug: string, name: string, n: number): Product => ({ id: `00000000-0000-4000-8000-00000000000${n}`, slug, name, description: "", status: "active", color: "#264491" });
const products: Product[] = [
  product("carebase", "CareMetric CareBase", 1), product("breathe", "CareMetric Breathe", 2), product("pennsync", "PennSync", 3), product("caremetric-emr", "CareMetric EMR", 4),
  product("caremetric-go", "CareMetric Go", 5), product("caremetric-intel", "CareMetric Intel", 6), product("advisors", "CareMetric Healthcare Advisors", 7),
];
const supportCase = (productId: string, status: SupportCase["status"], priority: SupportCase["priority"] = "normal"): SupportCase => ({
  id: crypto.randomUUID(), caseNumber: 1, tenantId: "t", tenantName: "Tenant", productId, requesterId: "r", requesterName: "Pat", subject: "Help", category: "general",
  priority, status, source: "portal", assignedTo: null, assignedToName: null, appVersion: null, route: null, createdAt: "2026-10-20T00:00:00Z", updatedAt: "2026-10-20T00:00:00Z", lastMessageAt: "2026-10-20T00:00:00Z", aiStage: null, aiAttempts: null,
});
const article = (productIds: string[]): ContentItem => ({ id: crypto.randomUUID(), contentKey: "k", kind: "article", title: "T", summary: "S", body: null, status: "published", accessLevel: "public", productIds, audience: [], locale: "en-US", revision: 1, sourceSystem: "support_hub", routePattern: null });
const data = { products, cases: [supportCase(products[0].id, "open", "urgent"), supportCase(products[0].id, "in_progress"), supportCase(products[1].id, "resolved")], content: [article([products[0].id]), article(products.map(item => item.id))] };

interface ProductReads { capabilities?: PortfolioCapabilities; overview?: PortfolioOverview }
function fakePortfolio(reads: Partial<Record<PortfolioProduct, ProductReads>>): PortfolioClient {
  const unexpected = () => Promise.reject(new Error("Unexpected fixture read"));
  return {
    capabilities: vi.fn<PortfolioClient["capabilities"]>(async ({ product }) => { const entry = reads[product]; if (!entry?.capabilities) throw { code: "unconfigured" }; return entry.capabilities; }),
    overview: vi.fn<PortfolioClient["overview"]>(async ({ product }) => { const entry = reads[product]; if (!entry?.overview) throw { code: "upstream" }; return entry.overview; }),
    organizations: unexpected, users: unexpected,
  };
}
const channelStatus: ChannelStatus = { sms: { inbound: false, replies: false }, email: { inbound: true, replies: false }, chat: { enabled: true }, phone: { sync: true }, webForm: { sync: true } };
function fakeCommunications(status = channelStatus) {
  return {
    channels: vi.fn(async () => status),
    list: vi.fn(async (filter: { channel?: string; productId?: string; offset: number; limit: number }) => ({
      items: [], total: filter.channel === "sms" ? 1 : filter.channel ? 0 : filter.productId === products[0].id ? 2 : filter.productId ? 0 : 4, limit: filter.limit, offset: filter.offset, statusCounts: {},
    })),
  };
}
const usageSummary: AiUsageSummary = {
  days: 30, since: "2026-09-21T00:00:00Z", loadedAt: "2026-10-21T00:00:00Z", totals: { calls: 14, failedCalls: 1, staffCalls: 9, automationCalls: 5, inputTokens: 12000, outputTokens: 3400 }, unattributedCalls: 0,
  products: [
    { productId: products[0].id, slug: "carebase", name: "CareMetric CareBase", calls: 12, failedCalls: 1, staffCalls: 8, automationCalls: 4, inputTokens: 10000, outputTokens: 3000,
      tenants: [{ tenantId: "00000000-0000-4000-8000-0000000000a1", name: "Cedar Care", calls: 9, failedCalls: 0, inputTokens: 8000, outputTokens: 2400 }] },
    { productId: products[1].id, slug: "breathe", name: "CareMetric Breathe", calls: 2, failedCalls: 0, staffCalls: 1, automationCalls: 1, inputTokens: 2000, outputTokens: 400, tenants: [] },
  ],
  features: [{ feature: "case_summary", calls: 8, inputTokens: 6000, outputTokens: 1000 }, { feature: "automation_attempt", calls: 6, inputTokens: 6000, outputTokens: 2400 }],
};
const setupReport: IntegrationSetupReport = { checkedAt: "2026-10-21T00:00:00Z", integrations: [
  { id: "anthropic", name: "AI assistance (Anthropic)", purpose: "Staff summaries, drafts and the auto-resolution loop.", docs: "docs/CONTROL_CENTER.md", ready: true, complete: false, variables: [
    { name: "ANTHROPIC_API_KEY", secret: true, required: true, purpose: "Key", set: true, satisfied: true },
    { name: "HUB_AI_AUTOMATION_ENABLED", secret: false, required: false, purpose: "Flag", set: true, satisfied: false, value: "false" },
    { name: "HUB_AI_DRAFT_TIER", secret: false, required: false, purpose: "Tier", set: false, satisfied: false, value: null } ] },
  { id: "chat", name: "Website chat", purpose: "The chat panel on every Help page.", docs: "docs/UNIFIED_COMMUNICATIONS.md", ready: false, complete: false, variables: [
    { name: "HUB_CHAT_ENABLED", secret: false, required: true, purpose: "Flag", set: true, satisfied: false, value: "false" } ] },
] };
const subscription = (app: Subscription["app"], n: number): Subscription => ({
  id: `sub_${app}${n}`, tenant_id: "00000000-0000-4000-8000-0000000000aa", customer: "cus_1", app, status: "active", collection_method: "send_invoice",
  cancel_at_period_end: false, cancel_at: null, canceled_at: null, ended_at: null, current_period_start: null, current_period_end: null, trial_start: null, trial_end: null,
  pause_behavior: null, pause_resumes_at: null, discounts: [], created: "2026-10-27T00:00:00Z", version: 1,
  items: [{ id: `si_${n}`, price: "price_1", product: "prod_1", quantity: 1, unit_amount: 19900, currency: "usd", interval: "month", interval_count: 1, product_name: "Core", kind: "plan", unit_label: "facility", pricing_model: "per_unit", custom: false }],
});
const connectedClients = () => ({
  billing: vi.fn(async () => ({ coupons: [], subscriptions: [1, 2, 3, 4, 5].map(n => subscription("carebase", n)) })),
  hub: { listCases: vi.fn(async () => data.cases), listContent: vi.fn(async () => data.content) },
  aiUsage: { summary: vi.fn(async (days: number) => ({ ...usageSummary, days })) } as AiUsageClient,
  integrationSetup: { report: vi.fn(async () => setupReport) } as IntegrationSetupClient,
  portfolio: fakePortfolio({
    carebase: {
      capabilities: { apiVersion: 1, operations: ["overview", "organizations.list", "users.list", "commands.preview", "commands.apply"], sourceRevision: "abc1234" },
      overview: { organizationCount: 12, activeUserCount: 40 },
    },
    advisors: { capabilities: { apiVersion: 1, operations: ["overview", "inquiries.list"], sourceRevision: null }, overview: { organizationCount: null, activeUserCount: null, inquiryCount: 7, openInquiryCount: 2 } },
  }),
  supportReadiness: { summary: vi.fn(async () => ({ products: [{ id: products[0].id, slug: "carebase", name: "CareBase", status: "active", supportEnabled: true, activeTenantCount: 4, usableMemberCount: 6, readyTenantCount: 2, publishedItemCount: 9 }], loadedAt: "2026-10-21T00:00:00Z" })) } as unknown as SupportReadinessClient,
  goLive: { report: vi.fn(async () => ({ checkedAt: "2026-10-21T00:00:00Z", migrations: { complete: false, items: [{ version: "1", name: "a", applied: true }, { version: "2", name: "b", applied: false }] }, anthropicKey: { present: true }, aiAutomation: { enabled: false }, helpDomain: { hostname: "help.caremetric.ai", resolves: false, targets: [] } })) } as GoLiveClient,
  phones: { list: vi.fn(async () => ({ loaded_at: "2026-10-21T00:00:00Z", rows: [
    { id: crypto.randomUUID(), version: 1, updated_at: "2026-10-20T00:00:00Z", number: "+18775212890", label: "Support line", provider: "Twilio", account: "", tenant: "", account_type: "unknown", account_sid: "", parent_account_sid: "", business_profile_status: "approved", messaging_registration: "", migration_status: "active", purpose: "Support", apps: "", owner: "", lifecycle: "active", usage_status: "observed", voice_status: "configured", voice_routing: "", sms_status: "pending", sms_routing: "", last_used_on: "", reviewed_on: "2026-10-01", evidence: "Call log", notes: "" },
    { id: crypto.randomUUID(), version: 1, updated_at: "2026-10-20T00:00:00Z", number: "+12025550100", label: "Legacy", provider: "Twilio", account: "", tenant: "", account_type: "unknown", account_sid: "", parent_account_sid: "", business_profile_status: "approved", messaging_registration: "", migration_status: "active", purpose: "Old", apps: "", owner: "", lifecycle: "retired", usage_status: "observed", voice_status: "configured", voice_routing: "", sms_status: "configured", sms_routing: "", last_used_on: "", reviewed_on: "2026-10-01", evidence: "Call log", notes: "" },
  ] })) } as unknown as PhoneRegistryClient,
} satisfies ControlCenterClients);

function renderCenter(clients: ControlCenterClients) {
  return render(<MemoryRouter><ControlCenter data={data} demo={false} {...clients} /></MemoryRouter>);
}
const href = (element: HTMLElement) => element.getAttribute("href");

describe("control center", () => {
  it("shows the portfolio at a glance from live reads and never shows an unavailable figure as zero", async () => {
    renderCenter({ ...connectedClients(), communications: fakeCommunications() });
    const glance = screen.getByRole("region", { name: "Portfolio at a glance" });
    expect(await within(glance).findByText("of 4 administration connections")).toBeTruthy();
    const figure = (label: string) => within(glance).getByText(label).parentElement!;
    expect(within(figure("Applications connected")).getByText("2")).toBeTruthy();
    expect(await within(figure("Conversations waiting")).findByText("4")).toBeTruthy();
    expect(within(figure("Open support cases")).getByText("2")).toBeTruthy();
    expect(within(figure("Open support cases")).getByText("1 urgent")).toBeTruthy();
    expect(within(figure("Subscriptions")).getByText("5")).toBeTruthy();
    expect(within(figure("Subscriptions")).getByText("Billed by the Hub across every application")).toBeTruthy();
    expect(within(figure("Channels live")).getByText("4 of 5")).toBeTruthy();
  });

  it("lists every customer channel with its live status, waiting count and inbox link", async () => {
    renderCenter({ ...connectedClients(), communications: fakeCommunications() });
    const channels = screen.getByRole("region", { name: "Customer channels" });
    const rows = await within(channels).findAllByRole("listitem");
    expect(rows.map(row => row.querySelector("strong")?.textContent)).toEqual(["Phone line (877) 521-2890", "Text messages", "Email", "Website chat", "Website forms"]);
    expect(within(rows[1]).getByText("Not connected")).toBeTruthy();
    expect(within(rows[1]).getByText("Not live")).toBeTruthy();
    expect(within(rows[2]).getByText("Receiving · replies not configured")).toBeTruthy();
    expect(href(within(rows[1]).getByRole("link", { name: "Open Text messages conversations" }))).toBe("/communications?channel=sms");
    expect(within(rows[1]).getByRole("link", { name: "Open Text messages conversations" }).textContent).toBe("1 waiting");
    expect(href(within(channels).getByRole("link", { name: /Open inbox/ }))).toBe("/communications");
    expect(href(within(channels).getByRole("link", { name: "Phone numbers and routing" }))).toBe("/phone-numbers");
  });

  it("summarizes the Hub services with the same checks their own pages run", async () => {
    renderCenter({ ...connectedClients(), communications: fakeCommunications() });
    const services = screen.getByRole("region", { name: "Hub services" });
    expect(await within(services).findByText("1 of 2 applied")).toBeTruthy();
    expect(within(services).getByText("Production migrations").parentElement!.parentElement!.textContent).toContain("Still needed");
    expect(within(services).getByText("Configured on the Hub service")).toBeTruthy();
    expect(within(services).getByText("help.caremetric.ai")).toBeTruthy();
    expect(within(services).getByText("DNS record not found yet")).toBeTruthy();
    expect(await within(services).findByText("1 active · 1 need review · 1 with texting attention")).toBeTruthy();
    expect(href(within(services).getByRole("link", { name: "2 numbers" }))).toBe("/phone-numbers");
    expect(await within(services).findByText("2 ready customers across 1 applications with support enabled")).toBeTruthy();
    expect(href(within(services).getByRole("link", { name: "AI go-live readiness" }))).toBe("/admin/go-live-readiness");
  });

  it("shows one card per application with health, subscriptions, users, integration, support and intake, each linking into its workspace", async () => {
    renderCenter({ ...connectedClients(), communications: fakeCommunications() });
    const applications = screen.getByRole("region", { name: "Applications" });
    const cards = await within(applications).findAllByRole("article");
    expect(cards).toHaveLength(4);
    const carebase = within(applications).getByRole("article", { name: "CareBase (PennTrain) controls" });
    expect(within(carebase).getByText("Connection verified")).toBeTruthy();
    expect(within(carebase).getByText("Organizations:").textContent).toBe("Organizations: 12");
    expect(within(carebase).getByText("Deployed source abc1234")).toBeTruthy();
    expect(within(carebase).getByText("Subscriptions").closest("div")!.textContent).toContain("5 subscriptions · $995.00 MRR");
    expect(within(carebase).getByText("Organizations, users and access controls")).toBeTruthy();
    expect(href(within(carebase).getByRole("link", { name: "Users" }))).toBe("/admin/apps?product=carebase&view=users");
    expect(href(within(carebase).getByRole("link", { name: "Organizations" }))).toBe("/admin/apps?product=carebase&view=organizations");
    expect(href(within(carebase).getByRole("link", { name: "Billing and subscriptions" }))).toBe("/admin/billing?app=carebase");
    expect(within(carebase).getByText("Enabled; click pending")).toBeTruthy();
    expect(within(carebase).getByText(/Administration connection: cmcarebase.com/)).toBeTruthy();
    expect(await within(carebase).findByText("conversations waiting", { exact: false })).toBeTruthy();
    expect(within(carebase).getByText("Support").closest("div")!.textContent).toContain("2 conversations waiting · 2 open cases (1 urgent) · 2 published articles (1 app-specific) · 12 AI calls");
    expect(href(within(carebase).getByRole("link", { name: "Communications" }))).toBe("/communications?product=carebase");
    expect(href(within(carebase).getByRole("link", { name: "Support cases" }))).toBe("/cases?product=carebase");
    expect(href(within(carebase).getByRole("link", { name: "Knowledge" }))).toBe("/knowledge?product=carebase");
    expect(await within(carebase).findByText("2 of 4 active customers ready · 6 SMS-verified members")).toBeTruthy();
    expect(href(within(carebase).getByRole("link", { name: /Open CareBase \(PennTrain\) workspace/ }))).toBe("/admin/apps?product=carebase");

    const breathe = within(applications).getByRole("article", { name: "Breathe (PennFit) controls" });
    // The connection is unavailable, but its billing is the Hub's own and still reads.
    expect(within(breathe).getAllByText("Unavailable")).toHaveLength(1);
    expect(within(breathe).getByText(/the application could not be reached/)).toBeTruthy();
    expect(within(breathe).getByText("Subscriptions").closest("div")!.textContent).toContain("0 subscriptions · $0.00 MRR");
    expect(within(breathe).getByText("Not registered for customer support intake")).toBeTruthy();
    // The Hub's own records still show for a silent application.
    expect(within(breathe).getByText("Support").closest("div")!.textContent).toContain("0 conversations waiting · 0 open cases · 1 published articles (0 app-specific) · 2 AI calls");

    const advisors = within(applications).getByRole("article", { name: "CareMetric Healthcare Advisors controls" });
    expect(within(advisors).getByText("Open consultation requests:").textContent).toBe("Open consultation requests: 2");
    expect(within(advisors).getByText("Consulting practice · engagement fees are set by written proposal")).toBeTruthy();
    expect(within(advisors).getByText("No software accounts")).toBeTruthy();
    expect(href(within(advisors).getByRole("link", { name: "Consultation requests" }))).toBe("/admin/apps?product=advisors&view=inquiries");
    expect(within(advisors).getByText("Feeds the Hub inbox: Consultation request import")).toBeTruthy();

  });

  it("shows AI usage by application and by customer within each application, for the chosen period", async () => {
    const clients = connectedClients();
    renderCenter({ ...clients, communications: fakeCommunications() });
    const usage = screen.getByRole("region", { name: "AI usage" });
    expect((await within(usage).findByText("CareMetric CareBase")).closest("li")!.textContent).toContain("12 calls");
    expect(usage.querySelector(".control-usage-totals")!.textContent).toBe("14 calls · 9 by staff · 5 automated · 1 failed · 12,000 in / 3,400 out tokens");
    const carebase = within(usage).getByText("CareMetric CareBase").closest("li")!;
    expect(within(carebase).getByText("8 by staff · 4 automated · 1 failed · 10,000 in / 3,000 out tokens")).toBeTruthy();
    expect(within(carebase).getByText("1 customer")).toBeTruthy();
    expect(within(carebase).getByText("Cedar Care").parentElement!.textContent).toBe("Cedar Care9 calls · 0 failed · 8,000 in / 2,400 out tokens");
    expect(within(within(usage).getByText("CareMetric Breathe").closest("li")!).queryByText(/customer/)).toBeNull();
    expect(within(usage).getByText("Case summary for staff:").textContent).toBe("Case summary for staff: 8");
    expect(within(usage).getByText("Automated resolution attempt:").textContent).toBe("Automated resolution attempt: 6");
    expect(clients.aiUsage.summary).toHaveBeenLastCalledWith(30, expect.anything());
    fireEvent.change(within(usage).getByLabelText("Period"), { target: { value: "7" } });
    await waitFor(() => expect(clients.aiUsage.summary).toHaveBeenLastCalledWith(7, expect.anything()));
  });

  it("shows which integration settings are set without ever showing a secret value", async () => {
    renderCenter({ ...connectedClients(), communications: fakeCommunications() });
    const setup = screen.getByRole("region", { name: "Integration setup" });
    const rows = await within(setup).findAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText("AI assistance (Anthropic)")).toBeTruthy();
    expect(within(rows[0]).getByText("Ready")).toBeTruthy();
    expect(within(rows[0]).getByText(/Optional settings are not set/)).toBeTruthy();
    expect(within(rows[0]).getByText("ANTHROPIC_API_KEY").parentElement!.textContent).toBe("ANTHROPIC_API_KEY set");
    expect(within(rows[0]).getByText("HUB_AI_AUTOMATION_ENABLED").parentElement!.textContent).toBe("HUB_AI_AUTOMATION_ENABLED false");
    expect(within(rows[0]).getByText("HUB_AI_DRAFT_TIER").parentElement!.textContent).toBe("HUB_AI_DRAFT_TIER not set");
    expect(href(within(rows[0]).getByRole("link", { name: "Setup steps" }))).toBe("https://github.com/kdeyarmin/caremetric-support-hub/blob/main/docs/CONTROL_CENTER.md");
    expect(within(rows[1]).getByText("Needs setup")).toBeTruthy();
    // A required flag that is present but false is shown with its value and still needs setup.
    expect(within(rows[1]).getByText("HUB_CHAT_ENABLED").parentElement!.textContent).toBe("HUB_CHAT_ENABLED false");
    expect(within(rows[1]).getByText("HUB_CHAT_ENABLED").parentElement!.className).toBe("is-missing");
    expect(setup.textContent).toContain("The Hub never stores or sends a secret from the browser.");
  });

  it("labels AI usage that could not be loaded on every card instead of hiding it", async () => {
    const clients = connectedClients();
    clients.aiUsage = { summary: vi.fn(async () => { throw new Error("ledger down"); }) };
    renderCenter({ ...clients, communications: fakeCommunications() });
    const carebase = await screen.findByRole("article", { name: "CareBase (PennTrain) controls" });
    expect(await within(carebase).findByText("AI usage unavailable")).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "AI usage" })).getByRole("alert")).toBeTruthy();
  });

  it("re-reads the Hub's own cases and articles when everything is refreshed", async () => {
    const clients = connectedClients();
    renderCenter({ ...clients, communications: fakeCommunications() });
    await screen.findByRole("article", { name: "CareBase (PennTrain) controls" });
    await waitFor(() => expect(clients.hub.listCases).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Refresh everything" }));
    await waitFor(() => expect(clients.hub.listCases).toHaveBeenCalledTimes(2));
    expect(clients.hub.listContent).toHaveBeenCalledTimes(2);
  });

  it("keeps the inbox failure isolated and marks only its figures unavailable", async () => {
    const communications = { channels: vi.fn(async () => { throw new Error("down"); }), list: vi.fn(async () => { throw new Error("down"); }) };
    renderCenter({ ...connectedClients(), communications });
    const channels = screen.getByRole("region", { name: "Customer channels" });
    expect(await within(channels).findByRole("alert")).toBeTruthy();
    const glance = screen.getByRole("region", { name: "Portfolio at a glance" });
    expect(within(within(glance).getByText("Conversations waiting").parentElement!).getByText("Unavailable")).toBeTruthy();
    const carebase = await screen.findByRole("article", { name: "CareBase (PennTrain) controls" });
    expect(within(carebase).getByText("Conversations unavailable")).toBeTruthy();
    expect(within(carebase).getByText("Connection verified")).toBeTruthy();
  });

  it("explains that live Hub services are not part of the implementation preview", async () => {
    const connected = connectedClients();
    render(<MemoryRouter><ControlCenter data={data} demo portfolio={fakePortfolio({})} communications={fakeCommunications()} supportReadiness={connected.supportReadiness} goLive={connected.goLive} phones={connected.phones} aiUsage={connected.aiUsage} integrationSetup={connected.integrationSetup} hub={connected.hub} /></MemoryRouter>);
    const services = screen.getByRole("region", { name: "Hub services" });
    expect(await within(services).findAllByText("Not available in the implementation preview. Sign in to the live Hub to see it.")).toHaveLength(3);
    expect(within(screen.getByRole("region", { name: "AI usage" })).getByText("Not available in the implementation preview. Sign in to the live Hub to see it.")).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Integration setup" })).getByText("Not available in the implementation preview. Sign in to the live Hub to see it.")).toBeTruthy();
    expect(connected.goLive.report).not.toHaveBeenCalled();
    expect(connected.aiUsage.summary).not.toHaveBeenCalled();
    expect(connected.integrationSetup.report).not.toHaveBeenCalled();
    const cards = await screen.findAllByRole("article", { name: /controls$/ });
    expect(cards).toHaveLength(4);
    expect(within(cards[0]).getByText("Not available in the implementation preview. Sign in to the live Hub to see it.")).toBeTruthy();
  });
});
