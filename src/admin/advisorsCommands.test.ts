import { describe, expect, it } from "vitest";
import { parseAdvisorCommand, parseAdvisorCommandResult, type AdvisorCommand } from "../../supabase/functions/_shared/advisorsCommands";

const update: AdvisorCommand = { operation: "inquiries.update", id: "CM-00000000000A", status: "in-progress", notes: "Called back on Tuesday.\nSending a proposal.", expected: { status: "new", notes: "" } };
const remove: AdvisorCommand = { operation: "inquiries.delete", id: "CM-00000000000B", expected: { status: "closed", notes: "Done." } };
const item = { id: "CM-00000000000A", createdAt: "2026-10-01T10:00:00.000Z", name: "Alex Rivera", email: "alex@agency.test", organization: "River Home Health", phone: "",
  sector: "Home Health", service: "Strategic Planning & Operations", message: "Operations review.", status: "in-progress", notes: "Called back on Tuesday.\nSending a proposal." };
const envelope = (operation: string, data: unknown) => ({ contractVersion: 1, product: "advisors", operation, generatedAt: "2026-10-31T00:00:00.000Z", data });

describe("Healthcare Advisors changes from the Hub", () => {
  it("accepts exactly the changes Advisors' own inbox offers", () => {
    expect(parseAdvisorCommand(update)).toEqual(update);
    expect(parseAdvisorCommand(remove)).toEqual(remove);
  });

  it.each([
    ["an unknown reference", { ...update, id: "CM-123" }],
    ["an unknown status", { ...update, status: "archived" }],
    ["notes over 3,000 characters", { ...update, notes: "x".repeat(3001) }],
    ["control characters in notes", { ...update, notes: "bell\u0007" }],
    ["an extra field", { ...update, extra: true }],
    ["a change without what the owner saw", { ...update, expected: undefined }],
    ["an incomplete snapshot", { ...update, expected: { status: "new" } }],
    ["a delete carrying a status", { ...remove, status: "closed" }],
    ["any other operation", { operation: "inquiries.list", id: "CM-00000000000A", expected: { status: "new", notes: "" } }],
  ])("refuses %s before any authority is issued", (_label, input) => {
    expect(() => parseAdvisorCommand(input)).toThrow();
  });

  it("keeps an update's answer only when Advisors saved exactly what was sent", () => {
    expect(parseAdvisorCommandResult(envelope("inquiries.update", { item }), update)).toEqual({ item: { ...item, phone: null } });
    expect(() => parseAdvisorCommandResult(envelope("inquiries.update", { item: { ...item, status: "closed" } }), update)).toThrow();
    expect(() => parseAdvisorCommandResult(envelope("inquiries.update", { item: { ...item, id: "CM-00000000000C" } }), update)).toThrow();
    expect(() => parseAdvisorCommandResult({ ...envelope("inquiries.update", { item }), product: "carebase" }, update)).toThrow();
    expect(() => parseAdvisorCommandResult(envelope("inquiries.delete", { item }), update)).toThrow();
  });

  it("confirms a delete only for the request that was named", () => {
    expect(parseAdvisorCommandResult(envelope("inquiries.delete", { id: "CM-00000000000B", deleted: true }), remove)).toEqual({ id: "CM-00000000000B", deleted: true });
    expect(() => parseAdvisorCommandResult(envelope("inquiries.delete", { id: "CM-00000000000A", deleted: true }), remove)).toThrow();
    expect(() => parseAdvisorCommandResult(envelope("inquiries.delete", { id: "CM-00000000000B", deleted: true, extra: 1 }), remove)).toThrow();
  });
});
