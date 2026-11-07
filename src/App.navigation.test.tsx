// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";

const repo = vi.hoisted(() => ({
  getActorContext: vi.fn(),
  listProducts: vi.fn(),
  listContacts: vi.fn(),
  listCases: vi.fn(),
  listMessages: vi.fn(async () => []),
  listContent: vi.fn(),
}));
const session = vi.hoisted(() => ({ current: vi.fn(), subscribe: vi.fn(() => () => {}), signOut: vi.fn() }));
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

  it("opens the support request named by the customer center link", async () => {
    render(<MemoryRouter initialEntries={["/cases?case=case-done"]}><App /></MemoryRouter>);
    expect(await screen.findByRole("heading", { name: "Resolved billing question" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Open sign-in problem" })).toBeNull();
  });
});

describe("a saved sign-in destination", () => {
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
