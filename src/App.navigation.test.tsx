// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";

const repo = vi.hoisted(() => ({
  getActorContext: vi.fn(),
  listProducts: vi.fn(),
  listContacts: vi.fn(),
  listCases: vi.fn(),
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

describe("a saved sign-in destination", () => {
  it("is discarded when sign-in completes on another page, so it cannot redirect a later visit", async () => {
    window.localStorage.setItem("caremetric.pendingHelpPath", "/help");
    window.history.replaceState({}, "", "/cases");
    render(<MemoryRouter initialEntries={["/cases"]}><App /><WhereAmI /></MemoryRouter>);
    await waitFor(() => expect(document.querySelector(".app-shell")).toBeTruthy());
    expect(path()).toBe("/cases");
    expect(window.localStorage.getItem("caremetric.pendingHelpPath")).toBeNull();
  });
});
