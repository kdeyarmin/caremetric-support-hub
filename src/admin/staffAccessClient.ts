import { requestAdmin } from "./transport";
import { staffAccessContext, staffAccessDomain, staffAccessOperation, staffAccessPreview } from "./staffAccessProtocol";
import type { StaffAccessContext, StaffAccessOperation, StaffAccessPreview } from "./staffAccessProtocol";

type Operation<K extends StaffAccessOperation["operation"]> = Extract<StaffAccessOperation, { operation: K }>;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export interface StaffAccessClient {
  request(operation: DistributiveOmit<Operation<"context">, "domain">, signal: AbortSignal): Promise<StaffAccessContext>;
  request(operation: DistributiveOmit<Operation<"preview" | "apply" | "resume">, "domain">, signal: AbortSignal): Promise<StaffAccessPreview>;
}

/** Breathe staff deactivate and reactivate through the Hub server's Breathe change route; every answer is checked again here. */
export const staffAccessClient: StaffAccessClient = {
  async request(operation: DistributiveOmit<StaffAccessOperation, "domain">, signal: AbortSignal) {
    const parsed = staffAccessOperation.parse({ domain: staffAccessDomain, ...operation });
    const answer = await requestAdmin("tenant-lifecycle", parsed, signal);
    return (parsed.operation === "context" ? staffAccessContext.parse(answer) : staffAccessPreview.parse(answer)) as never;
  },
} as StaffAccessClient;
