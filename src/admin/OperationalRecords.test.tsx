// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { AuditRecords, JobRecords, ReleaseRecords } from "./OperationalRecords";
import { operationsClient, type OperationsClient } from "./operationsClient";
import { AdminWorkspace } from "./AdminWorkspace";
import { job, release, audit } from "./testFixtures/operations";
import type { PortfolioClient } from "./portfolioClient";
import type { AdminClient } from "./types";
import { operationalReadOperations } from "../../supabase/functions/_shared/operationsProtocol";
vi.hoisted(() => { vi.stubEnv("VITE_DEMO_MODE", "true"); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const page = <T,>(row: T, offset = 0, total = 1) => ({ items: [row], total, offset, limit: 20 });
function client(overrides: Partial<OperationsClient> = {}): OperationsClient {
  return { jobs: vi.fn(async () => page(job)), releases: vi.fn(async () => page(release)), audit: vi.fn(async () => page(audit)), ...overrides };
}
const unexpected = () => Promise.reject(new Error("Unexpected fixture read"));
const courseClient: AdminClient = { getOverview: unexpected, listCourses: unexpected, getCourse: unexpected };

describe("operational record interactions", () => {
  it("shows never recorded and unknown job state without invented success or zero counts", async () => {
    const api = client();
    render(<JobRecords client={api} />);
    await screen.findByText("No run recorded");
    expect(screen.getByText("Freshness not reported")).toBeTruthy();
    expect(screen.getByText("Attempted: Not reported")).toBeTruthy();
    expect(screen.getByText("Switch cannot stop this job")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /run|retry|stop/i })).toBeNull();
    expect(screen.queryByText("Attempted: 0")).toBeNull();
  });
  it("preserves exact counts and keeps connecting distinct from success", async () => {
    render(<JobRecords client={client({ jobs: async () => page({ ...job, lastStatus: "connecting", attemptedCount: "9223372036854775807" }) })} />);
    await screen.findByText("connecting (in progress)");
    expect(screen.getByText("Attempted: 9,223,372,036,854,775,807")).toBeTruthy();
  });
  it("shows release configuration limits and missing rollout independently of a definition", async () => {
    render(<ReleaseRecords client={client()} />);
    await screen.findByText("Fixture feature");
    expect(screen.getByText("Not configured")).toBeTruthy();
    expect(screen.getByText(/do not prove that an application consumer checks a flag/)).toBeTruthy();
    expect(screen.getByText("Organization stops: 0")).toBeTruthy();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });
  it("shows only the approved audit identifiers, without payload inspection or mutation controls", async () => {
    render(<AuditRecords client={client()} />);
    await screen.findByText("fixture.read");
    expect(screen.getByText(audit.id)).toBeTruthy();
    expect(screen.getByText(/Event payloads, previous values, clinical records/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /edit|delete|inspect payload/i })).toBeNull();
  });
  it("resets pagination for a new literal search and preserves native search text", async () => {
    const api = client({ jobs: vi.fn(async ({ offset }) => page(job, offset, 45)) });
    render(<JobRecords client={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Next" }));
    await waitFor(() => expect(api.jobs).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 20 })));
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "  worker_100%  " } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(api.jobs).toHaveBeenLastCalledWith(expect.objectContaining({ search: "worker_100%", offset: 0 })));
  });
  it.each([["unauthenticated", "Sign-in required"], ["forbidden", "Administrator access required"], ["unconfigured", "Application connection unavailable"], ["upstream", "Application could not be reached"]])("keeps %s errors private without showing data", async (code, title) => {
    render(<JobRecords client={client({ jobs: async () => { throw { code, message: "PRIVATE_RESPONSE" }; } })} />);
    await screen.findByText(title);
    expect(document.body.textContent).not.toContain("PRIVATE_RESPONSE");
    expect(screen.queryByRole("table")).toBeNull();
  });
  it("ignores a response for an abandoned search and renders empty results honestly", async () => {
    let finish!: (value: ReturnType<typeof page<typeof job>>) => void;
    const api = client({ jobs: vi.fn<OperationsClient["jobs"]>(({ search }) => search ? Promise.resolve({ items: [], total: 0, limit: 20, offset: 0 }) : new Promise(resolve => { finish = resolve; })) });
    render(<JobRecords client={api} />);
    const firstSignal = vi.mocked(api.jobs).mock.calls[0][0].signal;
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "missing" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await screen.findByText(/No records on this page/);
    expect(firstSignal.aborted).toBe(true);
    await act(async () => finish(page(job)));
    expect(screen.queryByText("Fixture worker")).toBeNull();
  });
  it.each([false, true])("advertises each operation only when CareBase reports capability: %s", async enabled => {
    const jobs = vi.spyOn(operationsClient, "jobs").mockResolvedValue(page(job));
    const portfolio: PortfolioClient = {
      capabilities: async () => ({ apiVersion: 1, sourceRevision: null, operations: ["overview", ...(enabled ? operationalReadOperations : [])] }),
      overview: async () => ({ organizationCount: 1, activeUserCount: 1 }), organizations: unexpected, users: unexpected,
    };
    render(<MemoryRouter><AdminWorkspace client={courseClient} portfolio={portfolio} /></MemoryRouter>);
    await screen.findByRole("button", { name: "Overview" });
    for (const name of ["Jobs", "Releases", "Audit"]) expect(Boolean(screen.queryByRole("button", { name }))).toBe(enabled);
    if (enabled) {
      fireEvent.click(screen.getByRole("button", { name: "Jobs" })); await screen.findByText("Fixture worker");
      expect(jobs).toHaveBeenCalledTimes(1);
      fireEvent.change(screen.getByLabelText("Application"), { target: { value: "breathe" } });
      await screen.findByRole("button", { name: "Overview" });
      expect(screen.queryByRole("button", { name: "Jobs" })).toBeNull();
      expect(screen.queryByText("Fixture worker")).toBeNull();
    } else expect(jobs).not.toHaveBeenCalled();
  });
});
