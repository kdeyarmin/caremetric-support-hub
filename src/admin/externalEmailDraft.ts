import type { ExternalEmailDraft } from "./teamProtocol";

const prefix = "caremetric:team:external-email:";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * A retry after a lost response or a page reload must look up the same proposal. Store only a
 * fingerprint and request UUID for this browser tab: never the recipient, subject or message.
 * The composer also keeps the key in memory if the browser refuses session storage.
 */
export async function externalEmailRequestKey(draft: ExternalEmailDraft): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify([draft.to, draft.subject, draft.body]));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const key = prefix + Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  try {
    const existing = sessionStorage.getItem(key);
    if (existing && uuid.test(existing)) return existing;
  } catch { /* A blocked storage area does not prevent a proposal; its retries keep the in-memory key. */ }
  const requestKey = crypto.randomUUID();
  try { sessionStorage.setItem(key, requestKey); } catch { /* See above. */ }
  return requestKey;
}
