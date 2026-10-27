export const REQUIRED_BACKEND_CONTRACT = 4;
export const REQUIRED_BACKEND_FEATURES = [
  "phone.registry.v1", "phone.accounts.v1",
  "learning.runtime.v1", "platform.admin.read.v1", "app.sms.v1", "learning.sources.v1",
  "platform.admin.command.v1", "learning.receipts.v1", "learning.authoring.v1",
  "knowledge.publications.v1", "support.readiness.v1", "platform.admin.intel.v1", "learning.draft-editing.v1",
  "support.customer-onboarding.v1", "learning.structure.v1", "support.customer-registration.v1", "learning.course-creation.v1", "learning.credit-policy.v1", "learning.distribution.v1","learning.pennsync-source.v1", "learning.media.v1", "learning.sequence.v1",
  "support.ai-assistance.v1", "support.ai-automation.v1", "support.go-live-readiness.v1", "support.ai-automation-server.v1",
  "platform.admin.advisors.v1",
  "support.ai-automation-failure-policy.v1",
  "support.communications.v1",
  "support.ai-usage.v1",
  "support.bulk-email.v1",
  "learning.catalog-authoring.v1",
  "billing.platform.v1",
  "customer.self-service.v1",
  "support.manual-escalation.v1",
  "support.customer-diagnostics.v1",
] as const;

/** Additive features share the API version; the integer alone never proves readiness. */
export function assertBackendContract(contract: unknown): void {
  const features = contract && typeof contract === "object" && "features" in contract ? contract.features : undefined;
  if (!contract || typeof contract !== "object" || !("api_version" in contract) || contract.api_version !== REQUIRED_BACKEND_CONTRACT
    || !Array.isArray(features) || features.length > 100
    || features.some(feature => typeof feature !== "string")
    || new Set(features).size !== features.length
    || REQUIRED_BACKEND_FEATURES.some(feature => !features.includes(feature))) {
    throw new Error("The Support Hub backend API is incompatible. Apply the reviewed migrations before deploying this frontend.");
  }
}

/** Public release metadata only. Never send an administrator session or secret key. */
export async function verifyBackendContract(
  supabaseUrl: string,
  publishableKey: string,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const url = new URL(supabaseUrl);
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Backend compatibility check requires a trusted HTTPS Supabase origin.");
  }
  if (!publishableKey.startsWith("sb_publishable_")) {
    throw new Error("Backend compatibility check requires a publishable key, never a secret or service-role key.");
  }
  let response: Response;
  try {
    response = await fetcher(new URL("/rest/v1/rpc/get_backend_contract", url), {
      method: "POST",
      headers: { apikey: publishableKey, "Content-Type": "application/json", "Content-Profile": "hub" },
      body: "{}",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error("Cannot verify the Support Hub backend. Check connectivity before deploying.");
  }
  if (!response.ok) {
    throw new Error(`Support Hub backend compatibility check failed (${response.status}). Apply the reviewed migrations before deploying this frontend.`);
  }
  const contract: unknown = await response.json();
  assertBackendContract(contract);
}
