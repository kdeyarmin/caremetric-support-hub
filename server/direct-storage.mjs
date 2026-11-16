import { createHash } from 'node:crypto';

/**
 * The Hub's direct transfer to Supabase Storage, shared by publication files (server/publications.mjs) and lesson media
 * (server/delegations.mjs). A Storage Edge Function signs a one-time address for one fixed object and returns only its token; the
 * Hub builds the address from its own Storage origin, sends or reads the bytes itself, and so a large video does not pass through
 * the function's 150-second response and 2-second CPU limits.
 */
// Each way of a transfer: an upload, then the read-back.
export const directTransferMs = 600000;
// A Storage token as it may appear in an address (JWTs are base64url with dots).
export const storageToken = /^[A-Za-z0-9._~-]{16,4096}$/;

// Storage answers an existing key with 409, or with its older 400 "Duplicate" body. Any other refusal is not read as one.
export async function storageDuplicate(response) {
  if (response.status === 409) return true;
  if (response.status !== 400) return false;
  try {
    const error = JSON.parse((await response.text()).slice(0, 8192));
    return ['ResourceAlreadyExists', 'KeyAlreadyExists', 'already_exists'].includes(error?.code)
      || (error?.error === 'Duplicate' && [400, 409, '400', '409'].includes(error?.statusCode));
  } catch { return false; }
}

// Reads what Storage holds back and hashes it: only the exact bytes that were checked may be recorded.
export async function storedMatches(response, { byteLength, sha256, contentType }) {
  if (response.status !== 200 || !response.body || response.headers.get('content-type')?.split(';')[0] !== contentType) return false;
  const hash = createHash('sha256'); let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > byteLength) return false;
    hash.update(chunk);
  }
  return bytes === byteLength && hash.digest('hex') === sha256;
}
