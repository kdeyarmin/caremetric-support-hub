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
vi.mock("./commandClient", () => ({ commandClient: {
  preview: vi.fn(async () => preview),
  apply: vi.fn(() => new Promise<CommandResult>(resolve => { pending.apply = resolve; })),
} }));
import { AdminWorkspace } from "./AdminWorkspace";

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
});
