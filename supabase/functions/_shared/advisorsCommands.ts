import { advisorInquiryStatuses, parseAdvisorInquiry, type AdvisorInquiry } from "./portfolioProtocol.ts";

/**
 * Changes the owner makes to a Healthcare Advisors consultation request from the Hub: the same ones Advisors' private
 * /admin inbox offers. `expected` is the status and notes the owner saw, so Advisors refuses a change if the request
 * was edited meanwhile instead of overwriting or deleting it unseen.
 */
export const advisorsCommandEndpoint = "https://caremetricadvisors.com/api/hub/admin-command";
export const advisorsCommandOperations = ["inquiries.update", "inquiries.delete"] as const;
export type AdvisorSnapshot = { status: AdvisorInquiry["status"]; notes: string };
export type AdvisorCommand =
  | { operation: "inquiries.update"; id: string; status: AdvisorInquiry["status"]; notes: string; expected: AdvisorSnapshot }
  | { operation: "inquiries.delete"; id: string; expected: AdvisorSnapshot };
export type AdvisorCommandResult = { item: AdvisorInquiry } | { id: string; deleted: true };

const reference = /^CM-[A-F0-9]{12}$/;
const invalid = () => new Error("Invalid consultation change");
const isStatus = (value: unknown): value is AdvisorInquiry["status"] => advisorInquiryStatuses.includes(value as AdvisorInquiry["status"]);
// Notes may hold line breaks and tabs, never other control characters.
const isNotes = (value: unknown): value is string => typeof value === "string" && value.trim().length <= 3000 && !/\p{Cc}/u.test(value.replace(/[\n\r\t]/g, ""));
const record = (value: unknown) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
};
function snapshot(value: unknown): AdvisorSnapshot {
  const row = record(value);
  if (Object.keys(row).length !== 2 || !isStatus(row.status) || !isNotes(row.notes)) throw invalid();
  return { status: row.status, notes: row.notes };
}

export const isAdvisorCommand = (value: unknown) => advisorsCommandOperations.includes((value as { operation?: unknown } | null)?.operation as never);

/** Accepts only the exact change shapes Advisors accepts, so the Hub never issues authority for anything else. */
export function parseAdvisorCommand(input: unknown): AdvisorCommand {
  const value = record(input);
  if (typeof value.id !== "string" || !reference.test(value.id)) throw invalid();
  const expected = snapshot(value.expected);
  if (value.operation === "inquiries.delete" && Object.keys(value).length === 3) return { operation: "inquiries.delete", id: value.id, expected };
  if (value.operation === "inquiries.update" && Object.keys(value).length === 5 && isStatus(value.status) && isNotes(value.notes)) {
    return { operation: "inquiries.update", id: value.id, status: value.status, notes: value.notes, expected };
  }
  throw invalid();
}

/** Checks Advisors' answer against the exact change that was sent and keeps only reviewed fields. */
export function parseAdvisorCommandResult(input: unknown, command: AdvisorCommand): AdvisorCommandResult {
  const envelope = record(input);
  if (envelope.contractVersion !== 1 || envelope.product !== "advisors" || envelope.operation !== command.operation
    || typeof envelope.generatedAt !== "string" || !Number.isFinite(Date.parse(envelope.generatedAt))) throw invalid();
  return parseAdvisorChangeResult(envelope.data, command);
}

/** Checks a reported change against the one sent: Advisors' envelope data on the server, the Hub route's answer in the browser. */
export function parseAdvisorChangeResult(input: unknown, command: AdvisorCommand): AdvisorCommandResult {
  const data = record(input);
  if (command.operation === "inquiries.delete") {
    if (Object.keys(data).length !== 2 || data.id !== command.id || data.deleted !== true) throw invalid();
    return { id: command.id, deleted: true };
  }
  const item = parseAdvisorInquiry(data.item);
  if (item.id !== command.id || item.status !== command.status || item.notes !== command.notes) throw invalid();
  return { item };
}
