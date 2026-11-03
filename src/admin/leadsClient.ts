import { z } from "zod";
import { config } from "../lib/config";
import { sessionEvent } from "../lib/appSession";
import { leadPageSchema, leadSchema } from "./leadsProtocol";
import type { Lead, LeadKind, LeadPage, LeadSource, LeadStatus } from "./leadsProtocol";

/**
 * A failed Leads request. The message is the server's reviewed text (for example "This lead changed. Refresh and try
 * again."), safe to show; the code lets the read-failure panel use the same wording as the other administrator screens.
 */
export class LeadsApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.code = status === 401 ? "401" : status === 403 ? "403" : status === 404 || status === 503 ? "unconfigured" : "upstream";
  }
}

async function post<S extends z.ZodType>(path: string, body: unknown, schema: S, signal?: AbortSignal): Promise<z.infer<S>> {
  if (config.demoMode) throw new LeadsApiError(503, "Leads are not available in the preview.");
  const response = await fetch(`/api/${path}`, {
    method: "POST", credentials: "same-origin", cache: "no-store", redirect: "error",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000),
  });
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event(sessionEvent));
    const message = data && typeof data === "object" && "error" in data && typeof data.error === "string" ? data.error : "The request could not be completed.";
    throw new LeadsApiError(response.status, message);
  }
  return schema.parse(data);
}

export interface LeadFilter { kind: LeadKind | null; source: LeadSource | null; includeTest: boolean; offset: number; limit: number }

export interface LeadsClient {
  list(filter: LeadFilter, options: { signal: AbortSignal }): Promise<LeadPage>;
  /** Needs the owner's command session (under eight hours old). A stale `expectedUpdatedAt` is refused with 409. */
  setStatus(input: { id: string; status: LeadStatus; expectedUpdatedAt: string }): Promise<Lead>;
}

export const leadsClient: LeadsClient = {
  list: (filter, { signal }) => post("rpc/list_leads",
    { p_kind: filter.kind, p_source: filter.source, p_include_test: filter.includeTest, p_offset: filter.offset, p_limit: filter.limit }, leadPageSchema, signal),
  setStatus: input => post("admin/leads/status", input, leadSchema),
};
