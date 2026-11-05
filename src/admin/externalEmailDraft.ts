import type { ExternalEmailDraft, ExternalEmailProposal } from "./teamProtocol";

const prefix = "caremetric:team:external-email:";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * A retry after a lost response or a page reload must look up the same proposal. Store only a
 * fingerprint and request UUID for this browser tab: never the recipient, subject or message.
 * The composer also keeps the key in memory if the browser refuses session storage.
 */
export async function externalEmailRequestKey(draft: ExternalEmailDraft, renew?: Pick<ExternalEmailProposal, "requestKey" | "status">): Promise<string> {
  // A failed or uncertain send must never acquire a fresh identity. Only a server-confirmed
  // rejection or expiry, followed by an explicit owner request, permits a new proposal.
  if (renew && (!uuid.test(renew.requestKey) || (renew.status !== "rejected" && renew.status !== "expired"))) {
    throw new Error("Only a rejected or expired email proposal can be renewed.");
  }
  const bytes = new TextEncoder().encode(JSON.stringify([draft.to, draft.subject, draft.body]));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const key = prefix + Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  try {
    const existing = sessionStorage.getItem(key);
    // Another call may already have replaced this terminal request. Reuse that newer key so a
    // duplicate click or a stale view cannot prepare multiple replacements for the same email.
    if (existing && uuid.test(existing) && (!renew || existing !== renew.requestKey)) return existing;
  } catch { /* A blocked storage area does not prevent a proposal; its retries keep the in-memory key. */ }
  const requestKey = crypto.randomUUID();
  try { sessionStorage.setItem(key, requestKey); } catch { /* See above. */ }
  return requestKey;
}
