// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type { CommandPreview, CommandResult } from "../../supabase/functions/_shared/adminCommandProtocol";
import type { PortfolioClient } from "./portfolioClient";
import type { AdminClient } from "./types";

vi.hoisted(() => { vi.stubEnv("VITE_DEMO_MODE", "true"); });
const pending = vi.hoisted(() => ({ apply: null as null | ((result: CommandResult) => void) }));
const first = "99400000-0000-4000-8000-000000000011", second = "99400000-0000-4000-8000-000000000012";
const preview: CommandPreview = { commandId: "99400000-0000-4000-8000-000000000013", action: "users.setActive", targetId: first, reason: "Departed staff member",
  expiresAt: "2099-01-01T00:00:00Z", previewDigest: "a".repeat(64), changes: [{ field: "active", before: "true", after: "false" }] };
const organizationPreview = vi.hoisted(() => ({ commandId: "99400000-0000-4000-8000-000000000014", action: "organizations.setSuspension" as const, targetId: "000000000000000000000002",
  reason: "Contract ended at the end of October", expiresAt: "2099-01-01T00:00:00Z", previewDigest: "b".repeat(64), changes: [{ field: "status" as const, before: "active", after: "disabled" }] }));
vi.mock("./commandClient", () => ({ commandClient: {
  preview: vi.fn(async (command: { action: string }, _signal: unknown, product?: string) => {
    if (product === "intel" && command.action === "organizations.setSuspension") return organizationPreview;
    if (product === "intel") throw new AdminApiError("refused", "This is the last active administrator. Make someone else an administrator first.");
    return preview;
  }),
  apply: vi.fn(() => new Promise<CommandResult>(resolve => { pending.apply = resolve; })),
} }));
import { AdminWorkspace } from "./AdminWorkspace";
import { commandClient } from "./commandClient";
import { AdminApiError } from "./transport";

afterEach(cleanup);
const unexpected = () => Promise.reject(new Error("Unexpected fixture read"));
const courseClient: AdminClient = { getOverview: unexpected, listCourses: unexpected, getCourse: unexpected };
const user = (id: string, name: string) => ({ id, displayName: name, email: `${name.toLowerCase()}@agency.test`, role: "staff", status: "active", createdAt: null });
const portfolio: PortfolioClient = {
  capabilities: async () => ({ apiVersion: 1, sourceRevision: null, operations: ["overview", "users.list", "commands.preview", "commands.apply"] }),
  overview: async () => ({ organizationCount: 1, activeUserCount: 2 }), organizations: unexpected,
  users: async () => ({ items: [user(first, "Robin"), user(second, "Casey")], total: 2, limit: 20, offset: 0 }),
};

describe("changing application access", () => {
  it("keeps the other rows' access buttons disabled until an applied change has answered", async () => {
    render(<MemoryRouter initialEntries={["/admin/apps?product=carebase&view=users"]}><AdminWorkspace client={courseClient} portfolio={portfolio} /></MemoryRouter>);
    const rows = await screen.findAllByRole("button", { name: "Change access" });
    fireEvent.click(rows[0]);
    const panel = await screen.findByRole("region", { name: "Review application access change" });
    fireEvent.change(within(panel).getByLabelText("Desired access"), { target: { value: "inactive" } });
    fireEvent.change(within(panel).getByLabelText("Reason"), { target: { value: preview.reason } });
    fireEvent.click(within(panel).getByRole("button", { name: /preview/i }));
    fireEvent.click(await within(panel).findByRole("button", { name: "Apply previewed change" }));
    await waitFor(() => expect(pending.apply).not.toBeNull());
    for (const button of screen.getAllByRole("button", { name: "Change access" })) expect(button).toHaveProperty("disabled", true);
    pending.apply!({ commandId: preview.commandId, action: preview.action, targetId: first, appliedAt: "2026-11-16T16:00:00Z", replayed: false, changes: preview.changes });
    expect(await within(panel).findByText(/Change recorded/)).toBeTruthy();
    await waitFor(() => { for (const button of screen.getAllByRole("button", { name: "Change access" })) expect(button).toHaveProperty("disabled", false); });
  });

  it("changes an Intel account in Intel's words, shows its real status, and explains a refusal", async () => {
    const account = "00000000000000000000002a";
    const intel: PortfolioClient = {
      capabilities: async () => ({ apiVersion: 1, sourceRevision: null, operations: ["overview", "users.list", "commands.preview", "commands.apply"] }),
      overview: async () => ({ organizationCount: null, activeUserCount: null, registeredUserCount: 1 }), organizations: unexpected,
      users: async () => ({ items: [{ ...user(account, "Jordan"), role: "admin", status: "registered", accountStatus: "active" }], total: 1, limit: 20, offset: 0 }),
    };
    render(<MemoryRouter initialEntries={["/admin/apps?product=intel&view=users"]}><AdminWorkspace client={courseClient} portfolio={intel} /></MemoryRouter>);
    fireEvent.click(await screen.findByRole("button", { name: "Change access" }));
    expect(screen.getAllByText("active").length).toBeGreaterThan(0);
    const panel = await screen.findByRole("region", { name: "Review application access change" });
    expect(within(panel).getByText(/CareMetric Intel records the administrator/)).toBeTruthy();
    fireEvent.change(within(panel).getByLabelText("Desired access"), { target: { value: "inactive" } });
    expect(within(panel).getByRole("option", { name: "Turn the account off and end its sessions" })).toBeTruthy();
    fireEvent.change(within(panel).getByLabelText("Reason"), { target: { value: "Left the agency last week" } });
    fireEvent.click(within(panel).getByRole("button", { name: /preview/i }));
    expect((await within(panel).findByRole("alert")).textContent).toBe("This is the last active administrator. Make someone else an administrator first.");
  });

  it("suspends an Intel organization in Intel's words, with each organization's status in words", async () => {
    const intel: PortfolioClient = {
      capabilities: async () => ({ apiVersion: 1, sourceRevision: null, operations: ["overview", "organizations.list", "users.list", "commands.preview", "commands.apply"] }),
      overview: async () => ({ organizationCount: null, activeUserCount: null, registeredUserCount: 1 }), users: unexpected,
      organizations: async () => ({ items: [{ id: organizationPreview.targetId, name: "Lakeside Home Health", slug: "lakeside", status: "active", createdAt: null },
        { id: "000000000000000000000003", name: "Riverbend Hospice", slug: "riverbend", status: "disabled", createdAt: null }], total: 2, limit: 20, offset: 0 }),
    };
    render(<MemoryRouter initialEntries={["/admin/apps?product=intel&view=organizations"]}><AdminWorkspace client={courseClient} portfolio={intel} /></MemoryRouter>);
    const buttons = await screen.findAllByRole("button", { name: "Change access" });
    expect(screen.getByRole("cell", { name: "Suspended" })).toBeTruthy();
    expect(screen.getByRole("cell", { name: "Active" })).toBeTruthy();
    fireEvent.click(buttons[0]);
    const panel = await screen.findByRole("region", { name: "Review application access change" });
    expect(within(panel).getByRole("option", { name: "Restore the organization and check its billing again" })).toBeTruthy();
    fireEvent.change(within(panel).getByLabelText("Desired access"), { target: { value: "suspended" } });
    fireEvent.change(within(panel).getByLabelText("Reason"), { target: { value: organizationPreview.reason } });
    fireEvent.click(within(panel).getByRole("button", { name: /preview/i }));
    expect(await within(panel).findByText(/members keep their sign-ins but can open only Billing/)).toBeTruthy();
    const status = within(panel).getByRole("row", { name: /Status/ });
    expect(within(status).getAllByRole("cell").map(cell => cell.textContent)).toEqual(["Status", "Active", "Suspended"]);
    expect(commandClient.preview).toHaveBeenLastCalledWith(expect.objectContaining({ action: "organizations.setSuspension", targetId: organizationPreview.targetId, parameters: { suspended: true } }), expect.anything(), "intel");
  });
});
