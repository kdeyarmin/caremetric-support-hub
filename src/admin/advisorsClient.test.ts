import { afterEach, expect, it, vi } from "vitest";
import type { AdvisorCommand } from "../../supabase/functions/_shared/advisorsCommands";

const requestAdmin = vi.fn<(functionName: string, body: unknown, signal: AbortSignal) => Promise<unknown>>();
vi.mock("./transport", () => ({ requestAdmin }));
const { changeAdvisorRequest } = await import("./advisorsClient");

afterEach(() => requestAdmin.mockReset());
const update: AdvisorCommand = { operation: "inquiries.update", id: "CM-00000000000A", status: "closed", notes: "Proposal sent.", expected: { status: "new", notes: "" } };
// What /api/admin/advisors-command returns: the Hub server has already checked Advisors' envelope and keeps only reviewed fields.
const saved = { item: { id: "CM-00000000000A", createdAt: "2026-10-01T10:00:00.000Z", name: "Alex Rivera", email: "alex@agency.test", organization: "River Home Health", phone: null,
  sector: "Home Health", service: "Strategic Planning & Operations", message: "Operations review.", status: "closed", notes: "Proposal sent." } };

it("reports a saved change as saved, reading the answer the Hub route actually returns", async () => {
  requestAdmin.mockResolvedValue(saved);
  await expect(changeAdvisorRequest(update, new AbortController().signal)).resolves.toEqual(saved);
  expect(requestAdmin).toHaveBeenCalledWith("advisors-command", update, expect.any(AbortSignal));
});

it("reports a delete as done only for the request that was named", async () => {
  const remove: AdvisorCommand = { operation: "inquiries.delete", id: "CM-00000000000A", expected: { status: "closed", notes: "Proposal sent." } };
  requestAdmin.mockResolvedValue({ id: "CM-00000000000A", deleted: true });
  await expect(changeAdvisorRequest(remove, new AbortController().signal)).resolves.toEqual({ id: "CM-00000000000A", deleted: true });
  requestAdmin.mockResolvedValue({ id: "CM-00000000000B", deleted: true });
  await expect(changeAdvisorRequest(remove, new AbortController().signal)).rejects.toThrow();
});

it("refuses an answer that does not match the change that was sent", async () => {
  requestAdmin.mockResolvedValue({ item: { ...saved.item, notes: "Something else." } });
  await expect(changeAdvisorRequest(update, new AbortController().signal)).rejects.toThrow();
});
