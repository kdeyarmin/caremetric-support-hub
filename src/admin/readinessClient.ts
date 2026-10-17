import { requestAdmin } from "./transport";
export { AdminApiError } from "./transport";
import { parseReadinessReport } from "./readinessProtocol";
import type { GoLiveReadinessReport } from "./readinessProtocol";

export interface ReadinessClient {
  report(options: { signal: AbortSignal }): Promise<GoLiveReadinessReport>;
}

export const readinessClient: ReadinessClient = {
  report: async ({ signal }) => parseReadinessReport(await requestAdmin("go-live-readiness", {}, signal)),
};
