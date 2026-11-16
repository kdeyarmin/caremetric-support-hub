/**
 * Sends a file to a Hub upload address in ordered parts (server/upload-parts.mjs). Railway closes a request whose body takes more
 * than five minutes, so a large video cannot go up in one request over an ordinary connection. Each part is its own request; the
 * Hub answers 202 with where the next part starts until the whole file has arrived, then answers as a single upload would.
 * A dropped part is sent again from where the Hub says, so a brief network loss does not restart the upload.
 */
export const UPLOAD_PART_BYTES = 8 * 1024 * 1024;
// Under Railway's five minutes; the last part also waits for the Hub to check and store the whole file.
const PART_TIMEOUT_MS = 270000;
const RETRIES = 5;

export interface PartOptions {
  signal?: AbortSignal;
  /** Bytes the Hub has received so far, after each part. */
  onProgress?: (received: number, total: number) => void;
  wait?: (ms: number) => Promise<void>;
}

async function receivedFrom(response: Response, total: number): Promise<number | null> {
  try {
    const value: unknown = await response.json();
    if (!value || typeof value !== "object" || Object.keys(value).join() !== "received") return null;
    const received = (value as { received: unknown }).received;
    return Number.isSafeInteger(received) && (received as number) >= 0 && (received as number) <= total ? received as number : null;
  } catch { return null; }
}

/** Returns the Hub's answer to the whole upload (the last part's response, or an error response). */
export async function sendInParts(fetcher: typeof fetch, url: string, file: Blob, headers: Record<string, string>, options: PartOptions = {}): Promise<Response> {
  const wait = options.wait ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
  let offset = 0, failures = 0, restarts = 0;
  for (;;) {
    options.signal?.throwIfAborted();
    const end = Math.min(offset + UPLOAD_PART_BYTES, file.size);
    const timeout = AbortSignal.timeout(PART_TIMEOUT_MS);
    let response: Response | null = null;
    try {
      response = await fetcher(url, {
        method: "POST", credentials: "same-origin", cache: "no-store", redirect: "error",
        headers: { ...headers, "Upload-Offset": String(offset), "Upload-Length": String(file.size) },
        body: file.slice(offset, end), signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
      });
    } catch (error) {
      if (options.signal?.aborted) throw error;
    }
    if (response?.status === 202) {
      const received = await receivedFrom(response, file.size);
      if (received !== null) {
        // Moving forward resets the retry count. The Hub may also answer from behind: it restarted or dropped an idle upload,
        // so the file is sent again from there, a few times at most. An answer that does not move counts as a retry.
        if (received > offset) failures = 0;
        else if (received < offset && ++restarts > 3) throw new Error("The upload could not make progress.");
        else if (received === offset && ++failures > RETRIES) throw new Error("The upload could not make progress.");
        offset = received; options.onProgress?.(received, file.size);
        continue;
      }
    } else if (response && response.status < 500) {
      return response;
    }
    // A network failure, a timeout, a 5xx, or an unreadable 202: ask again from the same offset after a pause.
    if (++failures > RETRIES) {
      if (response) return response;
      throw new Error("The upload could not reach the Hub.");
    }
    await wait(Math.min(30000, 1000 * 2 ** (failures - 1)));
  }
}
