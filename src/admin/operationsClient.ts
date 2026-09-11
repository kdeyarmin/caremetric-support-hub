import { readPortfolio } from "./portfolioClient";
import type { OperationalAudit, OperationalJob, OperationalPage, OperationalRelease } from "../../supabase/functions/_shared/operationsProtocol";
export interface OperationsPageOptions { search: string; offset: number; signal: AbortSignal; }
export interface OperationsClient {
  jobs(options: OperationsPageOptions): Promise<OperationalPage<OperationalJob>>;
  releases(options: OperationsPageOptions): Promise<OperationalPage<OperationalRelease>>;
  audit(options: OperationsPageOptions): Promise<OperationalPage<OperationalAudit>>;
}
export const operationsClient: OperationsClient = {
  jobs: async ({ signal, ...page }) => await readPortfolio("carebase", { operation: "operations.jobs.list", limit: 20, ...page }, signal) as OperationalPage<OperationalJob>,
  releases: async ({ signal, ...page }) => await readPortfolio("carebase", { operation: "operations.releases.list", limit: 20, ...page }, signal) as OperationalPage<OperationalRelease>,
  audit: async ({ signal, ...page }) => await readPortfolio("carebase", { operation: "operations.audit.list", limit: 20, ...page }, signal) as OperationalPage<OperationalAudit>,
};
