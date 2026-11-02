// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Team } from "./Team";
import { TeamApiError } from "./teamClient";
import type { TeamClient } from "./teamClient";
import type { TeamAgent, TeamOverview } from "./teamProtocol";

// DOM tests inject every data client; initialize the app's ordinary explicit preview configuration.
vi.hoisted(() => { vi.stubEnv("VITE_DEMO_MODE", "true"); });
afterEach(cleanup);

const ids = { task: "22222222-2222-4222-8222-222222222222", action: "33333333-3333-4333-8333-333333333333", schedule: "44444444-4444-4444-8444-444444444444", schedule2: "55555555-5555-4555-8555-555555555555" };
const counts = { queued: 0, running: 0, awaitingApproval: 0, awaitingSession: 0, failedLast24h: 0 };
const engineer: TeamAgent = {
  key: "platform_engineer", displayName: "Platform Engineer", roleSummary: "On call: probes every product health endpoint.", status: "active", autonomy: "act", modelTier: "fast",
  dailyBudgetCents: 50, spentTodayCents: 12.5, promptVersion: "v1", toolAllowlist: [], config: {}, updatedAt: "2026-11-02T12:00:00.123456+00:00",
  lastRun: { startedAt: "2026-11-02T11:00:00+00:00", outcome: "completed" }, counts: { ...counts, queued: 1, failedLast24h: 2 },
  schedules: [
    { id: ids.schedule, taskKind: "probe.sweep", cadence: "interval", everySeconds: 300, atLocal: null, timezone: "America/New_York", requiresSession: false, enabled: true, nextRunAt: "2026-11-02T12:05:00+00:00", lastRunAt: null },
    { id: ids.schedule2, taskKind: "brief.daily", cadence: "daily", everySeconds: null, atLocal: "07:00:00", timezone: "America/New_York", requiresSession: false, enabled: true, nextRunAt: "2026-11-03T12:00:00+00:00", lastRunAt: null },
  ],
};
const concierge: TeamAgent = {
  ...engineer, key: "support_concierge", displayName: "Support Concierge", roleSummary: "Triages every new conversation.", status: "paused", autonomy: "propose", modelTier: "draft",
  dailyBudgetCents: 300, spentTodayCents: 0, updatedAt: "2026-11-02T12:00:01.000000+00:00", lastRun: null, counts, schedules: [],
};
const overview = (changes: Partial<TeamOverview["team"]> = {}, services: Partial<TeamOverview["services"]> = {}): TeamOverview => ({
  team: {
    loadedAt: "2026-11-02T12:00:00+00:00", dayStart: "2026-11-02T05:00:00+00:00", agents: [concierge, engineer], approvalCount: 1, awaitingSessionCount: 0,
    approvals: [{ id: ids.action, agentKey: "support_concierge", agentName: "Support Concierge", taskId: ids.task, kind: "communication.reply", targetKind: "communication", targetId: "CM-1001",
      preview: "Here is how to export by month.", createdAt: "2026-11-02T11:30:00+00:00", expiresAt: "2026-11-09T11:30:00+00:00" }],
    ...changes,
  },
  services: { enabled: true, handlers: ["probe.sweep"], sms: true, email: true, ownerEmail: true, ...services },
});
const emptyPage = { items: [], total: 0, offset: 0, limit: 15 };
function fakeClient(data: TeamOverview = overview(), overrides: Partial<TeamClient> = {}): TeamClient {
  return {
    overview: vi.fn(async () => data), setStatus: vi.fn(async () => engineer), setAutonomy: vi.fn(async () => engineer), setBudget: vi.fn(async () => engineer),
    decide: vi.fn(async () => ({ id: ids.action, kind: "communication.reply", status: "executed", decided: true })), run: vi.fn(async () => ({ id: ids.task, status: "queued" })),
    cancel: vi.fn(async () => ({ id: ids.task, status: "cancelled" })), waiting: vi.fn(async () => ({ started: 2 })),
    activity: vi.fn(async () => emptyPage) as TeamClient["activity"], audit: vi.fn(async () => emptyPage), ...overrides,
  };
}
const card = (name: string) => screen.getByRole("article", { name });

describe("AI team screen", () => {
  it("shows what the team can use, what waits for you, and each agent", async () => {
    render(<Team client={fakeClient()} />);
    const services = await screen.findByRole("region", { name: "What the team can use" });
    expect(within(services).getByText("Scheduler").parentElement?.textContent).toContain("On");
    expect(within(services).getByText(/Health check/)).toBeTruthy();
    const waiting = screen.getByRole("region", { name: /Waiting for you/ });
    expect(within(waiting).getByText(/Support Concierge/)).toBeTruthy();
    expect(within(waiting).getByLabelText("Proposed text: Reply to a customer").textContent).toBe("Here is how to export by month.");
    const engineerCard = card("Platform Engineer");
    expect(within(engineerCard).getByText("Active")).toBeTruthy();
    expect(within(engineerCard).getByText(/Spent today: \$0\.13 of \$0\.50/)).toBeTruthy();
    expect(within(engineerCard).getByText("Fast (Haiku)")).toBeTruthy();
    expect(within(engineerCard).getByText(/Every 5 minutes/)).toBeTruthy();
    expect(within(engineerCard).getByText(/Daily at 7:00 AM Eastern/)).toBeTruthy();
    expect(within(card("Support Concierge")).getByText("Paused")).toBeTruthy();
  });

  it("says plainly when nothing is switched on, instead of looking broken", async () => {
    render(<Team client={fakeClient(overview({ approvals: [], approvalCount: 0, awaitingSessionCount: 2 }, { enabled: false, handlers: [], sms: false, email: false, ownerEmail: false }))} />);
    const services = await screen.findByRole("region", { name: "What the team can use" });
    expect(within(services).getByText(/Set HUB_AGENTS_ENABLED to true/)).toBeTruthy();
    expect(within(services).getByText(/Nothing here is broken/)).toBeTruthy();
    expect(within(services).getByText(/Set HUB_OWNER_EMAIL/)).toBeTruthy();
    expect(within(services).getByText(/fall back to email/)).toBeTruthy();
    expect(within(services).getByText(/2 tasks are waiting for you to be signed in/)).toBeTruthy();
    expect(screen.getByText("Nothing is waiting for your approval.")).toBeTruthy();
    expect(screen.getAllByText("No code behind it yet").length).toBeGreaterThan(0);
  });

  it("runs the work that was waiting for the owner's sign-in, and says how much started", async () => {
    const client = fakeClient(overview({ awaitingSessionCount: 2 }));
    render(<Team client={client} />);
    const services = await screen.findByRole("region", { name: "What the team can use" });
    expect(within(services).getByText(/Run them now while you are signed in/)).toBeTruthy();
    fireEvent.click(within(services).getByRole("button", { name: "Run what's waiting" }));
    expect(client.waiting).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/Started 2 tasks\. They finish in the background/)).toBeTruthy();
    await waitFor(() => expect(client.overview).toHaveBeenCalledTimes(2));
  });

  it("says when nothing was waiting, shows no button when nothing is, and disables it while the team is off", async () => {
    const client = fakeClient(overview({ awaitingSessionCount: 1 }), {});
    (client.waiting as ReturnType<typeof vi.fn>).mockResolvedValue({ started: 0 });
    render(<Team client={client} />);
    fireEvent.click(await screen.findByRole("button", { name: "Run what's waiting" }));
    expect(await screen.findByText("Nothing was waiting to run.")).toBeTruthy();
    cleanup();
    render(<Team client={fakeClient(overview({ awaitingSessionCount: 0 }))} />);
    await screen.findByRole("region", { name: "What the team can use" });
    expect(screen.queryByRole("button", { name: "Run what's waiting" })).toBeNull();
    cleanup();
    render(<Team client={fakeClient(overview({ awaitingSessionCount: 1 }, { enabled: false }))} />);
    expect((await screen.findByRole("button", { name: "Run what's waiting" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows the server's reason when the waiting work could not be started", async () => {
    const client = fakeClient(overview({ awaitingSessionCount: 1 }), { waiting: vi.fn(async () => { throw new TeamApiError(401, "Current administrator session required."); }) });
    render(<Team client={client} />);
    fireEvent.click(await screen.findByRole("button", { name: "Run what's waiting" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Current administrator session required.");
  });

  it("resumes an agent, naming the version it saw, and refreshes", async () => {
    const client = fakeClient();
    render(<Team client={client} />);
    fireEvent.click(await screen.findByRole("button", { name: "Resume Support Concierge" }));
    expect(client.setStatus).toHaveBeenCalledWith({ key: "support_concierge", status: "active", expectedUpdatedAt: concierge.updatedAt });
    expect(await screen.findByText("Support Concierge is active.")).toBeTruthy();
    await waitFor(() => expect(client.overview).toHaveBeenCalledTimes(2));
  });

  it("pauses an active agent", async () => {
    const client = fakeClient();
    render(<Team client={client} />);
    fireEvent.click(await screen.findByRole("button", { name: "Pause Platform Engineer" }));
    expect(client.setStatus).toHaveBeenCalledWith({ key: "platform_engineer", status: "paused", expectedUpdatedAt: engineer.updatedAt });
  });

  it("changes autonomy", async () => {
    const client = fakeClient();
    render(<Team client={client} />);
    fireEvent.change(await screen.findByLabelText("Autonomy for Support Concierge"), { target: { value: "observe" } });
    await waitFor(() => expect(client.setAutonomy).toHaveBeenCalledWith({ key: "support_concierge", autonomy: "observe", expectedUpdatedAt: concierge.updatedAt }));
    expect(await screen.findByText("Support Concierge is set to Observe.")).toBeTruthy();
  });

  it("turns a budget in dollars into cents, and refuses one that makes no sense", async () => {
    const client = fakeClient();
    render(<Team client={client} />);
    const input = await screen.findByLabelText("Daily budget for Support Concierge in dollars");
    const save = screen.getByRole("button", { name: "Save budget for Support Concierge" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(input, { target: { value: "1.50" } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    expect(client.setBudget).toHaveBeenCalledWith({ key: "support_concierge", dailyBudgetCents: 150, expectedUpdatedAt: concierge.updatedAt });
    fireEvent.change(await screen.findByLabelText("Daily budget for Platform Engineer in dollars"), { target: { value: "5000" } });
    expect((screen.getByRole("button", { name: "Save budget for Platform Engineer" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("alert").textContent).toContain("between $0 and $1,000");
  });

  it("offers Run now only for work with code behind it, on an active agent", async () => {
    const client = fakeClient();
    render(<Team client={client} />);
    const engineerCard = await screen.findByRole("article", { name: "Platform Engineer" });
    expect(within(engineerCard).getAllByRole("button", { name: /Run .* now/ })).toHaveLength(1);
    expect(within(engineerCard).getByText("No code behind it yet")).toBeTruthy();
    fireEvent.click(within(engineerCard).getByRole("button", { name: "Run Health check now" }));
    expect(client.run).toHaveBeenCalledWith({ agentKey: "platform_engineer", taskKind: "probe.sweep" });
    expect(await screen.findByText("Health check is queued for Platform Engineer.")).toBeTruthy();
  });

  it("disables Run now while the agent is paused", async () => {
    const paused = { ...engineer, status: "paused" as const };
    render(<Team client={fakeClient(overview({ agents: [paused] }))} />);
    expect((await screen.findByRole("button", { name: "Run Health check now" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("approves a proposal with the owner's note, and says what it did", async () => {
    const client = fakeClient();
    render(<Team client={client} />);
    const waiting = await screen.findByRole("region", { name: /Waiting for you/ });
    fireEvent.change(within(waiting).getByLabelText("Note (optional)"), { target: { value: "Looks right" } });
    fireEvent.click(within(waiting).getByRole("button", { name: "Approve and send: Reply to a customer from Support Concierge" }));
    expect(client.decide).toHaveBeenCalledWith({ actionId: ids.action, decision: "approve", note: "Looks right" });
    expect(await screen.findByText("Approved.")).toBeTruthy();
  });

  it("rejects a proposal without a note", async () => {
    const client = fakeClient();
    render(<Team client={client} />);
    fireEvent.click(await screen.findByRole("button", { name: "Reject: Reply to a customer from Support Concierge" }));
    expect(client.decide).toHaveBeenCalledWith({ actionId: ids.action, decision: "reject", note: undefined });
    expect(await screen.findByText("Rejected.")).toBeTruthy();
  });

  it("does not claim an approval that someone else already decided, or one that could not be carried out", async () => {
    const decided = fakeClient(overview(), { decide: vi.fn(async () => ({ id: ids.action, kind: "communication.reply", status: "approved", decided: false })) });
    const { unmount } = render(<Team client={decided} />);
    fireEvent.click(await screen.findByRole("button", { name: /Approve and send/ }));
    expect((await screen.findByRole("alert")).textContent).toContain("already decided or has expired");
    unmount();
    const failed = fakeClient(overview(), { decide: vi.fn(async () => ({ id: ids.action, kind: "communication.reply", status: "failed", decided: true })) });
    render(<Team client={failed} />);
    fireEvent.click(await screen.findByRole("button", { name: /Approve and send/ }));
    expect((await screen.findByRole("alert")).textContent).toContain("could not be carried out");
  });

  it("shows the server's reason when a change is refused, and still refreshes", async () => {
    const client = fakeClient(overview(), { setStatus: vi.fn(async () => { throw new TeamApiError(409, "This agent changed. Refresh and review again."); }) });
    render(<Team client={client} />);
    fireEvent.click(await screen.findByRole("button", { name: "Resume Support Concierge" }));
    expect((await screen.findByRole("alert")).textContent).toBe("This agent changed. Refresh and review again.");
    await waitFor(() => expect(client.overview).toHaveBeenCalledTimes(2));
    const unknown = fakeClient(overview(), { setStatus: vi.fn(async () => { throw new Error("socket hang up"); }) });
    cleanup();
    render(<Team client={unknown} />);
    fireEvent.click(await screen.findByRole("button", { name: "Resume Support Concierge" }));
    expect((await screen.findByRole("alert")).textContent).toBe("The change could not be completed. Nothing was changed.");
  });

  it("keeps showing the team while it refreshes after a change", async () => {
    let release: (value: TeamOverview) => void = () => undefined;
    const overviewCalls = vi.fn()
      .mockResolvedValueOnce(overview())
      .mockImplementationOnce(() => new Promise<TeamOverview>(resolve => { release = resolve; }));
    render(<Team client={fakeClient(overview(), { overview: overviewCalls })} />);
    fireEvent.click(await screen.findByRole("button", { name: "Resume Support Concierge" }));
    await waitFor(() => expect(overviewCalls).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("heading", { name: "Agents" })).toBeTruthy();
    expect(screen.queryByText("Loading the AI team")).toBeNull();
    release(overview());
    await waitFor(() => expect(screen.getByRole("heading", { name: "Agents" })).toBeTruthy());
  });

  it("explains a failed read and tries again on request", async () => {
    const overviewCalls = vi.fn().mockRejectedValueOnce(new TeamApiError(401, "Sign in")).mockResolvedValueOnce(overview());
    render(<Team client={fakeClient(overview(), { overview: overviewCalls })} />);
    expect((await screen.findByRole("alert")).textContent).toContain("Sign-in required");
    fireEvent.click(screen.getByRole("button", { name: /Retry/ }));
    expect(await screen.findByRole("region", { name: "What the team can use" })).toBeTruthy();
  });

  it("lists what the team has done, a page at a time, for one agent or all", async () => {
    const run = (n: number) => ({ id: `66666666-6666-4666-8666-66666666666${n}`, taskId: ids.task, agentKey: "platform_engineer", model: "claude-haiku-5-5", promptVersion: "v1", startedAt: "2026-11-02T11:00:00+00:00", finishedAt: null, outcome: "completed",
      rounds: 2, toolCalls: 1, inputTokens: 1200, outputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0, costCents: 12.5, summary: `Run ${n}`, errorCode: null });
    const activity = vi.fn(async (input: { offset: number }) => ({ items: [run(input.offset === 0 ? 1 : 2)], total: 20, offset: input.offset, limit: 15 }));
    const client = fakeClient(overview(), { activity: activity as unknown as TeamClient["activity"] });
    render(<Team client={client} />);
    const panel = await screen.findByRole("tabpanel");
    expect(await within(panel).findByText("Run 1")).toBeTruthy();
    expect(within(panel).getByText("Showing 1–1 of 20")).toBeTruthy();
    expect(within(panel).getByText("Platform Engineer", { selector: "td" })).toBeTruthy();
    expect(activity).toHaveBeenCalledWith({ kind: "runs", agentKey: null, offset: 0, limit: 15 }, expect.any(Object));
    fireEvent.click(within(panel).getByRole("button", { name: "Older" }));
    expect(await within(panel).findByText("Run 2")).toBeTruthy();
    expect(activity).toHaveBeenLastCalledWith({ kind: "runs", agentKey: null, offset: 15, limit: 15 }, expect.any(Object));
    fireEvent.change(within(panel).getByLabelText("Agent"), { target: { value: "support_concierge" } });
    await waitFor(() => expect(activity).toHaveBeenLastCalledWith({ kind: "runs", agentKey: "support_concierge", offset: 0, limit: 15 }, expect.any(Object)));
  });

  it("switches between kinds of activity and the audit log", async () => {
    const client = fakeClient();
    render(<Team client={client} />);
    await screen.findByRole("tabpanel");
    fireEvent.click(screen.getByRole("tab", { name: "Tasks" }));
    await waitFor(() => expect(client.activity).toHaveBeenLastCalledWith({ kind: "tasks", agentKey: null, offset: 0, limit: 15 }, expect.any(Object)));
    fireEvent.click(screen.getByRole("tab", { name: "Proposed actions" }));
    await waitFor(() => expect(client.activity).toHaveBeenLastCalledWith({ kind: "actions", agentKey: null, offset: 0, limit: 15 }, expect.any(Object)));
    fireEvent.click(screen.getByRole("tab", { name: "Alerts to you" }));
    await waitFor(() => expect(client.activity).toHaveBeenLastCalledWith({ kind: "notifications", agentKey: null, offset: 0, limit: 15 }, expect.any(Object)));
    fireEvent.click(screen.getByRole("tab", { name: "Audit log" }));
    await waitFor(() => expect(client.audit).toHaveBeenCalledWith({ prefix: null, offset: 0, limit: 15 }, expect.any(Object)));
    expect(screen.queryByLabelText("Agent")).toBeNull();
    expect(await screen.findByText("Nothing here yet.")).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Audit log" }).getAttribute("aria-selected")).toBe("true");
  });
});
