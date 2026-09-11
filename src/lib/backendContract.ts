export const REQUIRED_BACKEND_CONTRACT = 2;

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
  if (!contract || typeof contract !== "object" || !("api_version" in contract) || contract.api_version !== REQUIRED_BACKEND_CONTRACT) {
    throw new Error("The Support Hub backend API is incompatible. Apply the reviewed migrations before deploying this frontend.");
  }
}
