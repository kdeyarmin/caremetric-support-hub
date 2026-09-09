import type { CaseMessage } from "../domain";

export type CaseThreadStatus = "idle" | "loading" | "ready" | "error";

export interface CaseThreadState {
  caseId: string | null;
  messages: CaseMessage[];
  status: CaseThreadStatus;
  error: string;
  stale: boolean;
}

export type CaseThreadReadResult =
  | { caseId: string; messages: CaseMessage[]; error: null }
  | { caseId: string; messages: null; error: unknown };

export interface CaseThreadReader {
  listMessages(caseId: string): Promise<CaseMessage[]>;
}

export const emptyCaseThread: CaseThreadState = {
  caseId: null,
  messages: [],
  status: "idle",
  error: "",
  stale: false,
};

export function beginCaseThreadLoad(
  previous: CaseThreadState,
  caseId: string,
): CaseThreadState {
  const sameCase = previous.caseId === caseId;
  return {
    caseId,
    messages: sameCase ? previous.messages : [],
    status: "loading",
    error: "",
    stale: sameCase && previous.messages.length > 0,
  };
}

export async function readCaseThread(
  reader: CaseThreadReader,
  caseId: string,
): Promise<CaseThreadReadResult> {
  try {
    return { caseId, messages: await reader.listMessages(caseId), error: null };
  } catch (error) {
    return { caseId, messages: null, error };
  }
}

export function completeCaseThreadLoad(
  current: CaseThreadState,
  caseId: string,
  messages: CaseMessage[],
): CaseThreadState {
  if (current.caseId !== caseId) return current;
  return { caseId, messages, status: "ready", error: "", stale: false };
}

export function failCaseThreadLoad(
  current: CaseThreadState,
  caseId: string,
  caught: unknown,
): CaseThreadState {
  if (current.caseId !== caseId) return current;
  return {
    ...current,
    status: "error",
    error: caught instanceof Error ? caught.message : "The conversation could not be loaded.",
    stale: current.messages.length > 0,
  };
}
