// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const settings = vi.hoisted(() => ({ demoMode: false }));
vi.mock("../lib/config", () => ({ config: settings }));
import { TeamApiError, teamClient } from "./teamClient";

const agent = {
  key: "platform_engineer", displayName: "Platform Engineer", roleSummary: "On call.", status: "active", autonomy: "act", modelTier: "fast", dailyBudgetCents: 50, spentTodayCents: 0,
  promptVersion: "v1", toolAllowlist: [], config: {}, updatedAt: "2026-11-02T12:00:00.123456+00:00", lastRun: null,
  counts: { queued: 0, running: 0, awaitingApproval: 0, awaitingSession: 0, failedLast24h: 0 }, schedules: [],
};
const respond = (body: unknown, status = 200) => vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));

beforeEach(() => { settings.demoMode = false; });
afterEach(() => vi.unstubAllGlobals());

describe("AI team client", () => {
  it("posts a change as JSON in the owner's session and validates the answer", async () => {
    const fetcher = respond(agent);
    vi.stubGlobal("fetch", fetcher);
    const result = await teamClient.setStatus({ key: "platform_engineer", status: "active", expectedUpdatedAt: agent.updatedAt });
    expect(result.status).toBe("active");
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/admin/team/status");
    expect(init).toMatchObject({ method: "POST", credentials: "same-origin", cache: "no-store", redirect: "error", headers: { "Content-Type": "application/json" } });
    expect(JSON.parse(String(init.body))).toEqual({ key: "platform_engineer", status: "active", expectedUpdatedAt: agent.updatedAt });
  });

  it("sends a note with a decision only when there is one", async () => {
    const fetcher = respond({ id: "11111111-1111-4111-8111-111111111111", kind: "communication.reply", status: "executed", decided: true });
    vi.stubGlobal("fetch", fetcher);
    await teamClient.decide({ actionId: "11111111-1111-4111-8111-111111111111", decision: "approve" });
    await teamClient.decide({ actionId: "11111111-1111-4111-8111-111111111111", decision: "reject", note: "Not now" });
    expect(JSON.parse(String((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toEqual({ actionId: "11111111-1111-4111-8111-111111111111", decision: "approve" });
    expect(JSON.parse(String((fetcher.mock.calls[1] as unknown as [string, RequestInit])[1].body))).toEqual({ actionId: "11111111-1111-4111-8111-111111111111", decision: "reject", note: "Not now" });
  });

  it("starts the waiting work with an empty body and checks how many tasks started", async () => {
    const fetcher = respond({ started: 2, actions: 1 });
    vi.stubGlobal("fetch", fetcher);
    expect(await teamClient.waiting()).toEqual({ started: 2, actions: 1 });
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/admin/team/waiting");
    expect(init).toMatchObject({ method: "POST", credentials: "same-origin" });
    expect(JSON.parse(String(init.body))).toEqual({});
    vi.stubGlobal("fetch", respond({ started: -1, actions: 0 }));
    await expect(teamClient.waiting()).rejects.toThrow();
    vi.stubGlobal("fetch", respond({ error: "Current administrator session required." }, 401));
    await expect(teamClient.waiting()).rejects.toMatchObject({ status: 401, message: "Current administrator session required." });
  });

  it("posts an autonomy step change and checks the step it gets back", async () => {
    const step = { category: "account_emails", label: "Account emails", status: "held", supervisedSince: null, automaticAt: null, changedAt: "2026-11-04T22:00:00.123456+00:00", ready: true, agents: ["account_manager"] };
    const fetcher = respond(step);
    vi.stubGlobal("fetch", fetcher);
    expect(await teamClient.setStep({ category: "account_emails", action: "hold", expectedChangedAt: "2026-11-04T21:00:00.000001+00:00" })).toEqual(step);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/admin/team/step");
    expect(JSON.parse(String(init.body))).toEqual({ category: "account_emails", action: "hold", expectedChangedAt: "2026-11-04T21:00:00.000001+00:00" });
    vi.stubGlobal("fetch", respond({ ...step, status: "sometimes" }));
    await expect(teamClient.setStep({ category: "account_emails", action: "hold", expectedChangedAt: step.changedAt })).rejects.toThrow();
  });

  it("asks the read RPCs for a page with the database's parameter names", async () => {
    const fetcher = respond({ items: [], total: 0, offset: 15, limit: 15 });
    vi.stubGlobal("fetch", fetcher);
    await teamClient.activity({ kind: "runs", agentKey: "chief_of_staff", offset: 15, limit: 15 }, { signal: new AbortController().signal });
    await teamClient.audit({ prefix: "agent.", offset: 0, limit: 15 }, { signal: new AbortController().signal });
    const calls = fetcher.mock.calls as unknown as Array<[string, RequestInit]>;
    expect([calls[0][0], JSON.parse(String(calls[0][1].body))]).toEqual(["/api/rpc/list_agent_activity", { p_kind: "runs", p_agent_key: "chief_of_staff", p_offset: 15, p_limit: 15 }]);
    expect([calls[1][0], JSON.parse(String(calls[1][1].body))]).toEqual(["/api/rpc/list_audit_events", { p_action_prefix: "agent.", p_offset: 0, p_limit: 15 }]);
  });

  it("keeps the server's reviewed message and status, and tells the shell when the session lapsed", async () => {
    vi.stubGlobal("fetch", respond({ error: "This agent changed. Refresh and review again." }, 409));
    await expect(teamClient.cancel({ taskId: "11111111-1111-4111-8111-111111111111" })).rejects.toMatchObject({ status: 409, code: "upstream", message: "This agent changed. Refresh and review again." });
    const lapsed = vi.fn();
    window.addEventListener("caremetric:session", lapsed);
    vi.stubGlobal("fetch", respond({ error: "Sign in with an SMS code to continue." }, 401));
    await expect(teamClient.cancel({ taskId: "11111111-1111-4111-8111-111111111111" })).rejects.toMatchObject({ status: 401, code: "401" });
    expect(lapsed).toHaveBeenCalledTimes(1);
    window.removeEventListener("caremetric:session", lapsed);
    vi.stubGlobal("fetch", respond({ error: "x" }, 403));
    await expect(teamClient.cancel({ taskId: "11111111-1111-4111-8111-111111111111" })).rejects.toMatchObject({ code: "403" });
    vi.stubGlobal("fetch", respond({ error: "x" }, 503));
    await expect(teamClient.cancel({ taskId: "11111111-1111-4111-8111-111111111111" })).rejects.toMatchObject({ code: "unconfigured" });
  });

  it("does not trust an answer that is not the shape it expects", async () => {
    vi.stubGlobal("fetch", respond({ ...agent, status: "sleeping" }));
    await expect(teamClient.setStatus({ key: "platform_engineer", status: "active", expectedUpdatedAt: agent.updatedAt })).rejects.toThrow();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>", { status: 502 })));
    await expect(teamClient.cancel({ taskId: "11111111-1111-4111-8111-111111111111" })).rejects.toMatchObject({ message: "The request could not be completed." });
  });

  it("does not call the server in the preview", async () => {
    settings.demoMode = true;
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await expect(teamClient.overview({ signal: new AbortController().signal })).rejects.toBeInstanceOf(TeamApiError);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
