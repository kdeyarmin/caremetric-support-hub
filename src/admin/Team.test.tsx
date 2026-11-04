// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Team } from "./Team";
import { TeamApiError } from "./teamClient";
import type { TeamClient } from "./teamClient";
import type { ExternalEmailDraft, ExternalEmailProposal, TeamAgent, TeamOverview } from "./teamProtocol";

// DOM tests inject every data client; initialize the app's ordinary explicit preview configuration.
vi.hoisted(() => { vi.stubEnv("VITE_DEMO_MODE", "true"); });
beforeEach(() => { sessionStorage.clear(); vi.stubGlobal("crypto", webcrypto); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

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
  services: { enabled: true, handlers: ["probe.sweep"], sms: true, email: true, ownerEmail: true, ai: true, customerTextToAi: false, externalEmail: true, ...services },
  waitingActions: 0,
});
const emptyPage = { items: [], total: 0, offset: 0, limit: 15 };
function fakeClient(data: TeamOverview = overview(), overrides: Partial<TeamClient> = {}): TeamClient {
  return {
    overview: vi.fn(async () => data), setStatus: vi.fn(async () => engineer), setAutonomy: vi.fn(async () => engineer), setBudget: vi.fn(async () => engineer),
    decide: vi.fn(async () => ({ id: ids.action, kind: "communication.reply", status: "executed", decided: true })), run: vi.fn(async () => ({ id: ids.task, status: "queued" })),
    prepareEmail: vi.fn(async (input: ExternalEmailDraft & { requestKey: string }) => ({ id: ids.action, kind: "email.external" as const, status: "proposed" as const, created: true, requestKey: input.requestKey })),
    cancel: vi.fn(async () => ({ id: ids.task, status: "cancelled" })), waiting: vi.fn(async () => ({ started: 2, actions: 0 })),
    activity: vi.fn(async () => emptyPage) as TeamClient["activity"], audit: vi.fn(async () => emptyPage), ...overrides,
  };
}
const card = (name: string) => screen.getByRole("article", { name });
const ownerDraft = { to: "support@example.org", subject: "CMS source access", body: "Hello,\n\nPlease review the <em>literal</em> source errors.\n\nKevin\n" };
const externalApproval = (draft = ownerDraft) => ({ id: ids.action, agentKey: "chief_of_staff", agentName: "Chief of Staff", taskId: null, kind: "email.external", targetKind: "external_email", targetId: ids.schedule,
  preview: `To: ${draft.to}\nSubject: ${draft.subject}\n\n${draft.body}`, createdAt: "2026-11-04T12:00:00+00:00", expiresAt: "2026-11-11T12:00:00+00:00" });
const fillEmail = (panel: HTMLElement, draft = ownerDraft) => {
  fireEvent.change(within(panel).getByLabelText("To"), { target: { value: draft.to } });
  fireEvent.change(within(panel).getByLabelText("Subject"), { target: { value: draft.subject } });
  fireEvent.change(within(panel).getByLabelText("Message"), { target: { value: draft.body } });
};

describe("AI team screen", () => {
  it("prepares an exact owner email for review without approving it or enabling an agent", async () => {
    let proposed = false;
    const client = fakeClient(overview(), {
      overview: vi.fn(async () => overview({ approvals: proposed ? [externalApproval()] : [], approvalCount: proposed ? 1 : 0 }, { enabled: false })),
      prepareEmail: vi.fn<TeamClient["prepareEmail"]>(async input => { proposed = true; return { id: ids.action, kind: "email.external", status: "proposed", created: true, requestKey: input.requestKey }; }),
    });
    render(<Team client={client} />);
    const composer = await screen.findByRole("region", { name: "Prepare an email" });
    fillEmail(composer);
    fireEvent.click(within(composer).getByRole("button", { name: "Prepare email for approval" }));
    await waitFor(() => expect(client.prepareEmail).toHaveBeenCalledTimes(1));
    expect(client.prepareEmail).toHaveBeenCalledWith({ ...ownerDraft, requestKey: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    expect(client.decide).not.toHaveBeenCalled();
    expect(client.setStatus).not.toHaveBeenCalled();
    expect(client.setAutonomy).not.toHaveBeenCalled();
    const preview = await screen.findByLabelText("Proposed text: Email to support@example.org: CMS source access");
    expect(preview.textContent).toBe(externalApproval().preview);
    expect(preview.querySelector("em")).toBeNull();
    expect((within(composer).getByLabelText("Message") as HTMLTextAreaElement).value).toBe(ownerDraft.body);
    expect((within(composer).getByRole("button", { name: "Proposal prepared" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("button", { name: "Approve and send: Email to support@example.org: CMS source access from Chief of Staff" })).toBeTruthy();
  });

  it("keeps an unchanged draft and request key through a lost response, refresh, and safe proposal retry", async () => {
    const prepare = vi.fn<TeamClient["prepareEmail"]>().mockRejectedValueOnce(new Error("connection lost")).mockImplementation(async input => ({ id: ids.action, kind: "email.external", status: "proposed", created: false, requestKey: input.requestKey }));
    const client = fakeClient(overview({ approvals: [], approvalCount: 0 }), { prepareEmail: prepare });
    render(<Team client={client} />);
    const composer = await screen.findByRole("region", { name: "Prepare an email" });
    fillEmail(composer);
    fireEvent.click(within(composer).getByRole("button", { name: "Prepare email for approval" }));
    expect((await screen.findByRole("alert")).textContent).toContain("draft is unchanged");
    expect((within(composer).getByLabelText("Message") as HTMLTextAreaElement).value).toBe(ownerDraft.body);
    await waitFor(() => expect((screen.getByRole("button", { name: "Refresh" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(client.overview).toHaveBeenCalledTimes(3));
    fireEvent.click(within(composer).getByRole("button", { name: "Prepare email for approval" }));
    expect(await screen.findByText(/This email proposal already exists/)).toBeTruthy();
    expect(prepare.mock.calls[1][0]).toEqual(prepare.mock.calls[0][0]);
    expect(client.decide).not.toHaveBeenCalled();
  });

  it("retains the draft on a server refusal and does not submit twice while preparing", async () => {
    let release: (value: ExternalEmailProposal) => void = () => undefined;
    const prepare = vi.fn<TeamClient["prepareEmail"]>().mockRejectedValueOnce(new TeamApiError(503, "Email proposals are not available yet."))
      .mockImplementation(() => new Promise(resolve => { release = resolve; }));
    render(<Team client={fakeClient(overview(), { prepareEmail: prepare })} />);
    const composer = await screen.findByRole("region", { name: "Prepare an email" });
    fillEmail(composer);
    const form = composer.querySelector("form")!;
    fireEvent.submit(form);
    expect((await screen.findByRole("alert")).textContent).toContain("Draft kept. Email proposals are not available yet.");
    expect((within(composer).getByLabelText("Subject") as HTMLInputElement).value).toBe(ownerDraft.subject);
    fireEvent.submit(form); fireEvent.submit(form);
    await waitFor(() => expect(prepare).toHaveBeenCalledTimes(2));
    expect(prepare.mock.calls[1][0]).toEqual(prepare.mock.calls[0][0]);
    expect((within(composer).getByLabelText("Message") as HTMLTextAreaElement).disabled).toBe(true);
    await act(async () => release({ id: ids.action, kind: "email.external", status: "proposed", created: true, requestKey: prepare.mock.calls[1][0].requestKey }));
    await screen.findByRole("button", { name: "Proposal prepared" });
    fireEvent.submit(form);
    expect(prepare).toHaveBeenCalledTimes(2);
  });

  it("keeps composition disabled when readiness is absent, and refuses multiple recipients", async () => {
    const unavailable = fakeClient(overview({}, { externalEmail: undefined }));
    const first = render(<Team client={unavailable} />);
    let composer = await screen.findByRole("region", { name: "Prepare an email" });
    expect((within(composer).getByRole("button", { name: "Prepare email for approval" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.submit(composer.querySelector("form")!);
    expect(unavailable.prepareEmail).not.toHaveBeenCalled();
    first.unmount();
    const client = fakeClient();
    render(<Team client={client} />);
    composer = await screen.findByRole("region", { name: "Prepare an email" });
    fillEmail(composer, { ...ownerDraft, to: "one@example.org,two@example.org" });
    fireEvent.submit(composer.querySelector("form")!);
    expect((await within(composer).findByRole("alert")).textContent).toBe("Enter one email address in To.");
    expect(client.prepareEmail).not.toHaveBeenCalled();
  });

  it("preserves Unicode text while counting characters consistently with the server", async () => {
    const client = fakeClient();
    render(<Team client={client} />);
    const composer = await screen.findByRole("region", { name: "Prepare an email" });
    const draft = { ...ownerDraft, subject: "😀".repeat(200), body: "😀".repeat(3000) };
    fillEmail(composer, draft);
    fireEvent.submit(composer.querySelector("form")!);
    await waitFor(() => expect(client.prepareEmail).toHaveBeenCalledWith({ ...draft, requestKey: expect.any(String) }));
  });

  it("describes an approved owner email as provider-accepted, without claiming recipient delivery", async () => {
    const client = fakeClient(overview({ approvals: [externalApproval()] }), { decide: vi.fn(async () => ({ id: ids.action, kind: "email.external", status: "executed", decided: true })) });
    render(<Team client={client} />);
    fireEvent.click(await screen.findByRole("button", { name: /Approve and send: Email to support@example.org/ }));
    expect(await screen.findByText("Accepted by the email provider. Delivery to the recipient is not confirmed.")).toBeTruthy();
    expect(client.decide).toHaveBeenCalledTimes(1);
  });

  it.each(["unknown", "approved", "network", "server"])("explicitly says not to resend when the owner email outcome is %s", async mode => {
    const decide = vi.fn<TeamClient["decide"]>(async () => {
      if (mode === "network") throw new Error("connection lost");
      if (mode === "server") throw new TeamApiError(500, "The result could not be saved.");
      return { id: ids.action, kind: "email.external", status: mode === "approved" ? "approved" : "failed", decided: true, ...(mode === "unknown" ? { error: "external_email_unconfirmed" } : {}) };
    });
    render(<Team client={fakeClient(overview({ approvals: [externalApproval()] }), { decide })} />);
    fireEvent.click(await screen.findByRole("button", { name: /Approve and send: Email to support@example.org/ }));
    const notice = await screen.findByText(/Do not resend this email|Do not resend it/);
    expect(notice.textContent).not.toMatch(/Nothing was sent|has not been sent|Run what's waiting/);
    expect(decide).toHaveBeenCalledTimes(1);
  });

  it("shows accepted and unknown email outcomes in history without exposing a request UUID as the recipient", async () => {
    const base = { ...externalApproval(), decisionNote: null, decidedAt: "2026-11-04T12:01:00+00:00", executedAt: null };
    const activity = vi.fn(async (input: { kind: string }) => input.kind === "actions" ? { ...emptyPage, total: 2, items: [
      { ...base, status: "executed", result: null },
      { ...base, id: ids.schedule2, preview: "Private preview unavailable", status: "failed", result: { error: "external_email_unconfirmed" } },
    ] } : emptyPage) as unknown as TeamClient["activity"];
    render(<Team client={fakeClient(overview({ approvals: [], approvalCount: 0 }), { activity })} />);
    fireEvent.click(await screen.findByRole("tab", { name: "Proposed actions" }));
    expect(await screen.findByText("Accepted by email provider")).toBeTruthy();
    expect(screen.getByText("Outcome unknown")).toBeTruthy();
    expect(screen.getByText("support@example.org")).toBeTruthy();
    expect(screen.getByText("External recipient")).toBeTruthy();
    expect(screen.queryByText(ids.schedule)).toBeNull();
    expect(screen.queryByText(ownerDraft.body)).toBeNull();
    expect(screen.getByText(/Do not resend it/)).toBeTruthy();
  });

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
    render(<Team client={fakeClient(overview({ approvals: [], approvalCount: 0, awaitingSessionCount: 2 }, { enabled: false, handlers: [], sms: false, email: false, ownerEmail: false, ai: false, customerTextToAi: false }))} />);
    const services = await screen.findByRole("region", { name: "What the team can use" });
    expect(within(services).getByText(/Set HUB_AGENTS_ENABLED to true/)).toBeTruthy();
    expect(within(services).getByText(/Set ANTHROPIC_API_KEY on the Hub service/)).toBeTruthy();
    expect(within(services).getByText(/Nothing here is broken/)).toBeTruthy();
    expect(within(services).getByText(/Set HUB_OWNER_EMAIL/)).toBeTruthy();
    expect(within(services).getByText(/fall back to email/)).toBeTruthy();
    expect(within(services).getByText(/2 tasks are waiting for you to be signed in/)).toBeTruthy();
    expect(screen.getByText("Nothing is waiting for your approval.")).toBeTruthy();
    expect(screen.getAllByText("No code behind it yet").length).toBeGreaterThan(0);
  });

  it("shows the model as ready when a key is set, and says an agent uses it only where its own setting allows", async () => {
    render(<Team client={fakeClient(overview())} />);
    const services = await screen.findByRole("region", { name: "What the team can use" });
    const row = within(services).getByText("AI model").closest("li") as HTMLElement;
    expect(within(row).getByText("Ready")).toBeTruthy();
    expect(within(row).getByText(/uses it only where its own setting says so/)).toBeTruthy();
    expect(within(services).queryByText(/Set ANTHROPIC_API_KEY/)).toBeNull();
  });

  it("says customer messages stay in the Hub until the owner switches drafting on, and what goes to the model when it is on", async () => {
    const off = render(<Team client={fakeClient(overview())} />);
    let row = (await within(await screen.findByRole("region", { name: "What the team can use" })).findByText("Customer text to AI")).closest("li") as HTMLElement;
    expect(within(row).getByText("Off")).toBeTruthy();
    expect(within(row).getByText(/Customer messages stay in the Hub\. Set HUB_AGENTS_CUSTOMER_TEXT_TO_AI to true/)).toBeTruthy();
    off.unmount();
    render(<Team client={fakeClient(overview({}, { customerTextToAi: true }))} />);
    row = (await within(await screen.findByRole("region", { name: "What the team can use" })).findByText("Customer text to AI")).closest("li") as HTMLElement;
    expect(within(row).getByText("On")).toBeTruthy();
    expect(within(row).getByText(/scrubbed text to the model to draft an answer for you to approve/)).toBeTruthy();
    expect(within(row).getByText(/never go/)).toBeTruthy();
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
    (client.waiting as ReturnType<typeof vi.fn>).mockResolvedValue({ started: 0, actions: 0 });
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

  it("lets approved replies be sent with the scheduler off, since they need only the owner's session", async () => {
    const off = { enabled: false };
    const withReplies = fakeClient({ ...overview({ awaitingSessionCount: 1 }, off), waitingActions: 2 }, { waiting: vi.fn(async () => ({ started: 0, actions: 2 })) });
    render(<Team client={withReplies} />);
    const button = await screen.findByRole("button", { name: "Run what's waiting" }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    expect(await screen.findByText(/Sending 2 approved replies/)).toBeTruthy();
    cleanup();
    // Waiting tasks alone cannot run with the scheduler off, so the button stays disabled then.
    render(<Team client={fakeClient({ ...overview({ awaitingSessionCount: 1 }, off), waitingActions: 0 })} />);
    expect((await screen.findByRole("button", { name: "Run what's waiting" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows the server's reason when the waiting work could not be started", async () => {
    const client = fakeClient(overview({ awaitingSessionCount: 1 }), { waiting: vi.fn(async () => { throw new TeamApiError(401, "Current administrator session required."); }) });
    render(<Team client={client} />);
    fireEvent.click(await screen.findByRole("button", { name: "Run what's waiting" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Current administrator session required.");
  });

  it("offers to send approved replies that never went out, and says what started", async () => {
    const client = fakeClient({ ...overview({ awaitingSessionCount: 0 }), waitingActions: 2 }, { waiting: vi.fn(async () => ({ started: 0, actions: 2 })) });
    render(<Team client={client} />);
    const services = await screen.findByRole("region", { name: "What the team can use" });
    expect(within(services).getByText(/2 replies you approved have not been sent yet/)).toBeTruthy();
    fireEvent.click(within(services).getByRole("button", { name: "Run what's waiting" }));
    expect(await screen.findByText(/Sending 2 approved replies\. They finish in the background/)).toBeTruthy();
    cleanup();
    const both = fakeClient({ ...overview({ awaitingSessionCount: 1 }), waitingActions: 1 }, { waiting: vi.fn(async () => ({ started: 1, actions: 1 })) });
    render(<Team client={both} />);
    expect(await screen.findByText(/1 task is waiting for you to be signed in/)).toBeTruthy();
    expect(screen.getByText(/1 reply you approved has not been sent yet/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Run what's waiting" }));
    expect(await screen.findByText(/Started 1 task and sending 1 approved reply\. They finish in the background/)).toBeTruthy();
  });

  it("links a proposed reply to its conversation in the inbox", async () => {
    render(<Team client={fakeClient()} />);
    const waiting = await screen.findByRole("region", { name: /Waiting for you/ });
    const link = within(waiting).getByRole("link", { name: "Open CM-1001" });
    expect(link.getAttribute("href")).toBe("/communications?search=CM-1001&status=all");
  });

  it("shows a proposed customer email by its account and subject, sends it on approval, and says why one was not sent", async () => {
    const email = { id: ids.action, agentKey: "account_manager", agentName: "Account Manager", taskId: ids.task, kind: "email.send", targetKind: "billing_account",
      targetId: "maple-grove", preview: "Subject: Welcome to CareMetric CareBase\n\nHello,\n\nThank you for starting a CareMetric CareBase trial for Maple Grove.",
      createdAt: "2026-11-02T11:30:00+00:00", expiresAt: "2026-11-09T11:30:00+00:00" };
    const client = fakeClient(overview({ approvals: [email] }), { decide: vi.fn(async () => ({ id: ids.action, kind: "email.send", status: "failed", decided: true, error: "suppressed" })) });
    render(<Team client={client} />);
    const waiting = await screen.findByRole("region", { name: /Waiting for you/ });
    expect(within(waiting).getByText(/proposes: Email to maple-grove: Welcome to CareMetric CareBase/)).toBeTruthy();
    expect(within(waiting).queryByRole("link")).toBeNull();
    expect(within(waiting).getByLabelText("Proposed text: Email to maple-grove: Welcome to CareMetric CareBase").textContent).toBe(email.preview);
    fireEvent.click(within(waiting).getByRole("button", { name: "Approve and send: Email to maple-grove: Welcome to CareMetric CareBase from Account Manager" }));
    expect(client.decide).toHaveBeenCalledWith({ actionId: ids.action, decision: "approve", note: undefined });
    expect((await screen.findByRole("alert")).textContent).toContain("The billing contact unsubscribed from CareMetric emails, so nothing was sent.");
  });

  it("says why an approved reply could not be sent", async () => {
    const client = fakeClient(overview(), { decide: vi.fn(async () => ({ id: ids.action, kind: "communication.reply", status: "failed", decided: true, error: "thread_changed" })) });
    render(<Team client={client} />);
    fireEvent.click(await screen.findByRole("button", { name: /Approve and send/ }));
    expect((await screen.findByRole("alert")).textContent).toContain("The customer wrote again after this reply was written, so nothing was sent.");
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
    const text = (await screen.findByRole("alert")).textContent ?? "";
    // A dropped connection or a timeout can come after the server has acted, so the screen never says nothing changed.
    expect(text).toBe("The result could not be confirmed, so the change may have gone through. Refresh and check the lists below before you try again.");
    expect(text).not.toMatch(/nothing was changed/i);
  });

  it("reloads the activity history when the page is refreshed or something changes, keeping its tab", async () => {
    const client = fakeClient();
    render(<Team client={client} />);
    await screen.findByRole("region", { name: "What the team has done" });
    await waitFor(() => expect(client.activity).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("tab", { name: "Proposed actions" }));
    await waitFor(() => expect(client.activity).toHaveBeenCalledTimes(2));
    expect((client.activity as ReturnType<typeof vi.fn>).mock.calls[1][0]).toMatchObject({ kind: "actions", offset: 0 });
    fireEvent.click(screen.getByRole("button", { name: /Refresh/ }));
    await waitFor(() => expect(client.activity).toHaveBeenCalledTimes(3));
    expect((client.activity as ReturnType<typeof vi.fn>).mock.calls[2][0]).toMatchObject({ kind: "actions", offset: 0 });
    expect(screen.getByRole("tab", { name: "Proposed actions" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(await screen.findByRole("button", { name: "Resume Support Concierge" }));
    await waitFor(() => expect(client.activity).toHaveBeenCalledTimes(4));
  });

  it("says an approved reply has not been sent yet only when the server confirmed it was waiting for the owner's session", async () => {
    const client = fakeClient(overview(), { decide: vi.fn(async () => ({ id: ids.action, kind: "communication.reply", status: "approved", decided: true, needsSession: true })) });
    render(<Team client={client} />);
    fireEvent.click(await screen.findByRole("button", { name: /Approve and send/ }));
    expect(await screen.findByText("Approved. It has not been sent yet. Press Run what's waiting while you are signed in.")).toBeTruthy();
  });

  it("does not say a reply was not sent when the approval came back without a confirmation either way", async () => {
    // The server also answers a bare "approved" when the reply went out and only its record was lost.
    const client = fakeClient(overview(), { decide: vi.fn(async () => ({ id: ids.action, kind: "communication.reply", status: "approved", decided: true })) });
    render(<Team client={client} />);
    fireEvent.click(await screen.findByRole("button", { name: /Approve and send/ }));
    // Approving reloads the activity list, whose "Loading activity" indicator is also a status region: wait for the decision's own message.
    const text = (await screen.findByText(/could not confirm what happened next/)).textContent ?? "";
    expect(text).toContain("could not confirm what happened next");
    expect(text).toContain("open the conversation before answering again");
    expect(text).not.toMatch(/not been sent|Run what's waiting/);
  });

  it("does not send the owner to Run what's waiting for a reply that failed because the sign-in lapsed", async () => {
    const client = fakeClient(overview(), { decide: vi.fn(async () => ({ id: ids.action, kind: "communication.reply", status: "failed", decided: true, error: "session_required" })) });
    render(<Team client={client} />);
    fireEvent.click(await screen.findByRole("button", { name: /Approve and send/ }));
    const text = (await screen.findByRole("alert")).textContent ?? "";
    expect(text).toContain("nothing was sent");
    expect(text).not.toMatch(/Run what's waiting/);
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

  it("says why an action failed in the history, from the code its executor stored", async () => {
    const action = (n: number, status: string, result: Record<string, unknown> | null) => ({
      id: `77777777-7777-4777-8777-77777777777${n}`, taskId: ids.task, agentKey: "support_concierge", kind: "communication.reply", targetKind: "communication", targetId: `CM-100${n}`,
      status, preview: "Here is how to export by month.", decisionNote: null, createdAt: "2026-11-02T11:30:00+00:00", expiresAt: "2026-11-09T11:30:00+00:00",
      decidedAt: status === "failed" ? "2026-11-02T11:40:00+00:00" : null, executedAt: null, result,
    });
    const activity = vi.fn(async (input: { kind: string }) => (input.kind === "actions"
      ? { items: [action(1, "failed", { error: "thread_changed" }), action(2, "failed", null), action(3, "proposed", null), action(4, "failed", { error: "session_required" })], total: 4, offset: 0, limit: 15 }
      : emptyPage)) as unknown as TeamClient["activity"];
    render(<Team client={fakeClient(overview(), { activity })} />);
    await screen.findByRole("region", { name: "What the team has done" });
    fireEvent.click(screen.getByRole("tab", { name: "Proposed actions" }));
    const rows = await screen.findAllByRole("row");
    const text = (id: string) => rows.find(row => row.textContent?.includes(id))?.textContent ?? "";
    expect(text("CM-1001")).toContain("Failed");
    expect(text("CM-1001")).toContain("The customer wrote again after this reply was written, so nothing was sent.");
    expect(text("CM-1001")).not.toContain("thread_changed");
    // A failure with no stored code, and an action that has not failed, show nothing extra.
    expect(text("CM-1002")).toContain("Failed");
    expect(text("CM-1002")).not.toContain("nothing was sent");
    expect(text("CM-1003")).toContain("Waiting for approval");
    // A failed action is final: the button picks up only approved ones, so a lapsed sign-in is not sent there for a retry.
    expect(text("CM-1004")).toContain("Failed");
    expect(text("CM-1004")).toContain("Your sign-in lapsed before the reply was sent, so nothing was sent. Sign in again and answer from the conversation.");
    expect(text("CM-1004")).not.toMatch(/Run what's waiting/);
  });

  it("names a lead form incident in the history instead of showing its key", async () => {
    const incident = {
      id: "77777777-7777-4777-8777-777777777779", taskId: ids.task, agentKey: "platform_engineer", kind: "incident.open", targetKind: "probe_target", targetId: "carebase_forms:2",
      status: "executed", preview: "CareBase lead form is not working", decisionNote: null, createdAt: "2026-11-02T11:30:00+00:00", expiresAt: "2026-11-09T11:30:00+00:00",
      decidedAt: null, executedAt: "2026-11-02T11:31:00+00:00", result: null,
    };
    const activity = vi.fn(async (input: { kind: string }) => (input.kind === "actions" ? { items: [incident], total: 1, offset: 0, limit: 15 } : emptyPage)) as unknown as TeamClient["activity"];
    render(<Team client={fakeClient(overview(), { activity })} />);
    await screen.findByRole("region", { name: "What the team has done" });
    fireEvent.click(screen.getByRole("tab", { name: "Proposed actions" }));
    expect(await screen.findByText("CareBase lead form, incident 2")).toBeTruthy();
    expect(screen.queryByText("carebase_forms:2")).toBeNull();
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
