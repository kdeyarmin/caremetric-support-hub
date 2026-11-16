// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";

const repo = vi.hoisted(() => ({
  getActorContext: vi.fn(),
  listProducts: vi.fn(),
  listContacts: vi.fn(),
  listCases: vi.fn(),
  listMessages: vi.fn(async () => []),
  updateCase: vi.fn(async () => undefined),
  listContent: vi.fn(),
}));
const session = vi.hoisted(() => ({ current: vi.fn(), subscribe: vi.fn(() => () => {}), signOut: vi.fn(), start: vi.fn(), verify: vi.fn(), passwordSettings: vi.fn() }));
vi.mock("./lib/config", () => ({ config: { demoMode: false, supabaseUrl: "https://hub.test", supabasePublishableKey: "key", helpBaseUrl: "https://hub.test", centralSupportEmail: "support@caremetric.ai", centralSupportPhone: "+18775212890", centralSupportPhoneDisplay: "(877) 521-2890", pennTrainBaseUrl: "" } }));
vi.mock("./data", () => ({ repository: repo, demoRepository: {} }));
vi.mock("./lib/appSession", () => ({
  appSession: session,
  appRequest: vi.fn(async () => { throw new Error("offline"); }),
  hubClient: { rpc: async () => ({ data: null, error: new Error("offline") }) },
  hubRpc: vi.fn(async () => { throw new Error("offline"); }),
  sessionEvent: "caremetric:session",
}));

import App from "./App";

const owner = { id: "owner", name: "Owner", role: "staff" as const, tenantId: null, tenantName: null, memberships: [] };
function WhereAmI() { return <output data-testid="path">{useLocation().pathname}</output>; }
const path = () => screen.getByTestId("path").textContent;

beforeEach(() => {
  session.current.mockResolvedValue({ authenticated: true });
  repo.getActorContext.mockResolvedValue({ ...owner, role: "support_manager" });
  repo.listProducts.mockResolvedValue([]);
  repo.listContacts.mockResolvedValue([]);
  repo.listCases.mockResolvedValue([]);
  repo.listContent.mockResolvedValue([]);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); window.localStorage.clear(); window.history.replaceState({}, "", "/"); });

describe("moving between pages", () => {
  it("keeps the shell mounted, checks the session once and refreshes the data quietly", async () => {
    render(<MemoryRouter initialEntries={["/overview"]}><App /></MemoryRouter>);
    const shell = await waitFor(() => { const found = document.querySelector<HTMLElement>(".app-shell"); expect(found).toBeTruthy(); return found!; });
    shell.dataset.marker = "first";
    expect(repo.getActorContext).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getAllByRole("link").find((link) => link.getAttribute("href") === "/knowledge")!);
    expect(screen.queryByText("Opening the CareMetric Support Hub…")).toBeNull();
    await waitFor(() => expect(repo.getActorContext).toHaveBeenCalledTimes(2));
    expect(document.querySelector<HTMLElement>(".app-shell")?.dataset.marker).toBe("first");
    expect(session.current).toHaveBeenCalledTimes(1);
  });

  it("keeps the page when a background refresh fails", async () => {
    render(<MemoryRouter initialEntries={["/overview"]}><App /></MemoryRouter>);
    await waitFor(() => expect(document.querySelector(".app-shell")).toBeTruthy());
    repo.listCases.mockRejectedValueOnce(new Error("temporarily unavailable"));
    fireEvent.click(screen.getAllByRole("link").find((link) => link.getAttribute("href") === "/knowledge")!);
    await waitFor(() => expect(repo.listCases).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(document.querySelector(".app-shell")).toBeTruthy();
    expect(screen.queryByText("temporarily unavailable")).toBeNull();
  });
});

const product = (id: string, slug: string, name: string) => ({ id, slug, name, description: "", status: "active" as const, color: "#264491" });
const supportCase = (id: string, caseNumber: number, subject: string, status: "open" | "resolved", productId: string) => ({
  id, caseNumber, tenantId: "tenant", tenantName: "North Home", productId, requesterId: "requester", requesterName: "Pat",
  subject, category: "general" as const, priority: "normal" as const, status, source: "portal" as const,
  assignedTo: null, assignedToName: null, appVersion: null, route: null,
  createdAt: "2026-10-20T00:00:00Z", updatedAt: "2026-10-20T00:00:00Z", lastMessageAt: "2026-10-20T00:00:00Z", aiStage: null, aiAttempts: null,
});

describe("the support case queue", () => {
  const carebase = product("prod-carebase", "carebase", "CareBase");
  const breathe = product("prod-breathe", "breathe", "Breathe");
  const open = supportCase("case-open", 1042, "Open sign-in problem", "open", carebase.id);
  const resolved = supportCase("case-done", 1043, "Resolved billing question", "resolved", breathe.id);

  beforeEach(() => {
    repo.listProducts.mockResolvedValue([carebase, breathe]);
    repo.listCases.mockResolvedValue([open, resolved]);
  });

  it("follows the cases the filters still show", async () => {
    render(<MemoryRouter initialEntries={["/cases"]}><App /></MemoryRouter>);
    expect(await screen.findByRole("heading", { name: "Open sign-in problem" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Filter by status"), { target: { value: "resolved" } });
    expect(await screen.findByRole("heading", { name: "Resolved billing question" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Open sign-in problem" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Filter by application"), { target: { value: carebase.id } });
    expect(await screen.findByText("No cases match")).toBeTruthy();
    expect(screen.getByText("Select a case")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Open sign-in problem" })).toBeNull();
  });

  it("names the application a link opened the queue on, even one outside the usual list, and accepts its repository name", async () => {
    const advisors = product("prod-advisors", "advisors", "Healthcare Advisors");
    const pennsync = product("prod-pennsync", "pennsync", "PennSync");
    repo.listProducts.mockResolvedValue([carebase, breathe, advisors, pennsync]);
    repo.listCases.mockResolvedValue([open, resolved, supportCase("case-old", 1001, "Historical agency question", "open", pennsync.id)]);
    render(<MemoryRouter initialEntries={["/cases?product=pennsync"]}><App /></MemoryRouter>);
    expect(await screen.findByRole("heading", { name: "Historical agency question" })).toBeTruthy();
    const filter = screen.getByLabelText("Filter by application") as HTMLSelectElement;
    expect(filter.selectedOptions[0].textContent).toBe("PennSync");
    expect(screen.getByText("1 case")).toBeTruthy();
    fireEvent.change(filter, { target: { value: "all" } });
    expect(await screen.findByText("3 cases")).toBeTruthy();
    cleanup();
    render(<MemoryRouter initialEntries={["/cases?product=pennfit"]}><App /></MemoryRouter>);
    expect(await screen.findByRole("heading", { name: "Resolved billing question" })).toBeTruthy();
    expect((screen.getByLabelText("Filter by application") as HTMLSelectElement).selectedOptions[0].textContent).toBe("Breathe");
  });

  it("opens the support request named by the customer center link", async () => {
    render(<MemoryRouter initialEntries={["/cases?case=case-done"]}><App /></MemoryRouter>);
    expect(await screen.findByRole("heading", { name: "Resolved billing question" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Open sign-in problem" })).toBeNull();
  });

  it("opens the specific recent case from the overview", async () => {
    render(<MemoryRouter initialEntries={["/overview"]}><App /></MemoryRouter>);
    fireEvent.click(await screen.findByRole("link", { name: /Resolved billing question/ }));
    expect(await screen.findByRole("heading", { name: "Resolved billing question" })).toBeTruthy();
  });

  it("opens the new case form from the customer overview even with existing cases", async () => {
    repo.getActorContext.mockResolvedValue({ ...owner, role: "customer" });
    render(<MemoryRouter initialEntries={["/overview"]}><App /></MemoryRouter>);
    fireEvent.click(await screen.findByRole("link", { name: "New support case" }));
    expect(await screen.findByRole("heading", { name: "Open a new support case" })).toBeTruthy();
  });

  it("uses refreshed cases when entering the queue", async () => {
    render(<MemoryRouter initialEntries={["/overview"]}><App /></MemoryRouter>);
    await screen.findByRole("heading", { name: /Everything your customers need/ });
    repo.listCases.mockResolvedValue([{ ...open, subject: "Updated by another staff member" }, resolved]);
    fireEvent.click(screen.getByRole("link", { name: "Open queue" }));
    expect(await screen.findByRole("heading", { name: "Updated by another staff member" })).toBeTruthy();
  });

  it("does not let an earlier navigation refresh undo a locally saved change", async () => {
    render(<MemoryRouter initialEntries={["/overview"]}><App /></MemoryRouter>);
    await screen.findByRole("heading", { name: /Everything your customers need/ });
    let resolveRefresh!: (value: typeof open[]) => void;
    repo.listCases.mockReturnValueOnce(new Promise(resolve => { resolveRefresh = resolve; }))
      .mockResolvedValue([{ ...open, subject: "Freshly saved case", status: "resolved" }, resolved]);
    fireEvent.click(screen.getByRole("link", { name: "Open queue" }));
    await waitFor(() => expect(repo.listCases).toHaveBeenCalledTimes(2));
    fireEvent.change(document.querySelector('.case-controls select')!, { target: { value: 'resolved' } });
    await screen.findByRole("heading", { name: "Freshly saved case" });
    await act(async () => { resolveRefresh([open, resolved]); });
    expect(screen.getByRole("heading", { name: "Freshly saved case" })).toBeTruthy();
  });
});

describe("a load that keeps failing", () => {
  it("lets a signed-in person sign out instead of only trying again", async () => {
    repo.listCases.mockRejectedValue(new Error("temporarily unavailable"));
    render(<MemoryRouter initialEntries={["/overview"]}><App /></MemoryRouter>);
    expect(await screen.findByRole("heading", { name: "We couldn’t open the Support Hub" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(session.signOut).toHaveBeenCalledTimes(1));
  });
});

describe("session refresh ordering", () => {
  it("ignores an older authenticated session response after sign-out", async () => {
    let resolveSession!: (value: { authenticated: boolean }) => void;
    session.current.mockReturnValueOnce(new Promise(resolve => { resolveSession = resolve; }));
    render(<MemoryRouter initialEntries={["/overview"]}><App /></MemoryRouter>);
    await waitFor(() => expect(session.subscribe).toHaveBeenCalled());
    session.current.mockResolvedValue({ authenticated: false });
    await act(async () => { (session.subscribe.mock.calls[0] as unknown as [() => void])[0](); });
    await act(async () => { resolveSession({ authenticated: true }); });
    expect(screen.queryByRole("heading", { name: "Sign in to CareMetric." })).toBeTruthy();
    expect(document.querySelector(".app-shell")).toBeNull();
  });

  it("does not load private data from an actor lookup that completes after sign-out", async () => {
    let resolveActor!: (value: typeof owner) => void;
    repo.getActorContext.mockReturnValueOnce(new Promise(resolve => { resolveActor = resolve; }));
    render(<MemoryRouter initialEntries={["/overview"]}><App /></MemoryRouter>);
    await waitFor(() => expect(repo.getActorContext).toHaveBeenCalled());
    session.current.mockResolvedValue({ authenticated: false });
    await act(async () => { (session.subscribe.mock.calls[0] as unknown as [() => void])[0](); });
    await act(async () => { resolveActor(owner); });
    expect(repo.listCases).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "Sign in to CareMetric." })).toBeTruthy();
  });

  it("does not reload an empty public catalog indefinitely", async () => {
    session.current.mockResolvedValue({ authenticated: false });
    window.history.replaceState({}, "", "/help");
    repo.listProducts.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockRejectedValue(new Error("Too many reads"));
    render(<MemoryRouter initialEntries={["/help"]}><App /></MemoryRouter>);
    await waitFor(() => expect(repo.listProducts).toHaveBeenCalled());
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 40)); });
    expect(repo.listProducts).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("heading", { name: "CareMetric help" })).toBeTruthy();
  });
});

describe("a saved sign-in destination", () => {
  it("takes password recovery from an admin link to account security", async () => {
    session.current.mockResolvedValue({ authenticated: false });
    session.start.mockResolvedValue({ challengeId: "recovery", retryAfter: 60 });
    render(<MemoryRouter initialEntries={["/admin"]}><App /><WhereAmI /></MemoryRouter>);
    fireEvent.click(await screen.findByRole("button", { name: "Set up or reset your password" }));
    fireEvent.change(screen.getByLabelText("Mobile number"), { target: { value: "+12025550123" } });
    fireEvent.click(screen.getByRole("button", { name: "Text me a code" }));
    await screen.findByLabelText("SMS code");
    expect(path()).toBe("/security");
    expect(window.localStorage.getItem("caremetric.pendingHelpPath")).toBe("/security");
  });

  it("opens once sign-in completes at the home address, ahead of the home page", async () => {
    window.localStorage.setItem("caremetric.pendingHelpPath", "/help");
    render(<MemoryRouter initialEntries={["/"]}><App /><WhereAmI /></MemoryRouter>);
    await waitFor(() => expect(path()).toBe("/help"));
    expect(window.localStorage.getItem("caremetric.pendingHelpPath")).toBeNull();
  });

  it("is discarded when sign-in completes on another page, so it cannot redirect a later visit", async () => {
    window.localStorage.setItem("caremetric.pendingHelpPath", "/help");
    window.history.replaceState({}, "", "/cases");
    render(<MemoryRouter initialEntries={["/cases"]}><App /><WhereAmI /></MemoryRouter>);
    await waitFor(() => expect(document.querySelector(".app-shell")).toBeTruthy());
    expect(path()).toBe("/cases");
    expect(window.localStorage.getItem("caremetric.pendingHelpPath")).toBeNull();
  });
});
