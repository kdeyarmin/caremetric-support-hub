import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpError } from './sms-auth.mjs';

/**
 * Large files arrive in parts. Railway closes a request whose body takes more than five minutes to upload, and the Hub ends one
 * after about two, so a single request cannot carry a 256 or 512 MiB video over an ordinary office connection. Each part is its
 * own short request: it is appended, in order, to a private spool file, and a part that does not start where the spool ends is
 * not written; the answer says where to resume. Once the last byte arrives, the whole file goes through the same checks a single
 * upload does. A spool belongs to one session and one target, and is removed when the upload finishes, fails its checks, or sits
 * idle for ten minutes.
 */
export const uploadPartBytes = 8 * 1024 * 1024;

const digits = /^(0|[1-9][0-9]{0,9})$/;

/**
 * The part a request carries ({offset, total, length}), or null for a whole file in one request. `length` is the declared
 * Content-Length, or null when a proxy sent the part chunked; either way the bytes read are counted and bounded.
 */
export function parseUploadPart(headers) {
  const offset = headers['upload-offset'], total = headers['upload-length'], length = headers['content-length'];
  if (offset === undefined && total === undefined) return null;
  if (![offset, total].every(value => typeof value === 'string' && digits.test(value)) || (length !== undefined && !digits.test(length))) {
    throw new HttpError(400, 'Invalid upload part.');
  }
  const part = { offset: Number(offset), total: Number(total), length: length === undefined ? null : Number(length) };
  if (part.total < 1 || part.offset > part.total || part.length > uploadPartBytes || part.offset + (part.length ?? 0) > part.total) {
    throw new HttpError(400, 'Invalid upload part.');
  }
  return part;
}

/** A spool is keyed by the session that sent it, never by anything the browser names alone. */
export function partKey(sessionToken, target) {
  return `${createHash('sha256').update(String(sessionToken)).digest('hex')}:${target}`;
}

/** At most `limit` bytes, and exactly `length` when the request declared it. */
async function readPart(body, limit, length) {
  const chunks = [];
  let size = 0;
  for await (const chunk of body) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'An upload part is larger than allowed or runs past the end of the file.');
    chunks.push(chunk);
  }
  if (length !== null && size !== length) throw new HttpError(400, 'Invalid upload part.');
  return Buffer.concat(chunks, size);
}

/**
 * Spools for one kind of upload. `budget` caps the bytes all live spools may grow to (their declared totals), so slow or
 * abandoned uploads cannot fill the disk.
 */
export function partUploads({ budget, idleMs = 10 * 60 * 1000, dir = tmpdir() }) {
  const live = new Map();
  const reserved = () => [...live.values()].reduce((sum, spool) => sum + spool.total, 0);
  const drop = async (key, spool) => {
    if (live.get(key) === spool) live.delete(key);
    clearTimeout(spool.timer);
    if (spool.directory) await rm(spool.directory, { recursive: true, force: true });
  };
  const idle = (key, spool) => {
    clearTimeout(spool.timer);
    spool.timer = setTimeout(() => { if (spool.busy) idle(key, spool); else void drop(key, spool); }, idleMs);
    spool.timer.unref?.();
  };
  return {
    get reserved() { return reserved(); },
    /**
     * Appends one part. While bytes remain the answer is {received}, which is where the next part starts. When the last byte has
     * arrived, complete({file, sha256, byteLength, stream}) runs over the whole file and the answer is {result}. A completion that
     * fails with a client error (4xx) discards the spool, as the bytes are wrong; any other failure keeps it, so an empty part at
     * the end retries the completion without sending the file again.
     */
    async receive(key, part, body, complete) {
      let spool = live.get(key);
      if (spool?.busy) throw new HttpError(503, 'This upload is still receiving a part. Retry shortly.');
      if (spool && spool.total !== part.total) { await drop(key, spool); spool = undefined; }
      if (!spool) {
        if (part.offset !== 0) return { received: 0 };
        if (reserved() + part.total > budget) throw new HttpError(429, 'Upload capacity reached. Try again when the current upload finishes.');
        spool = { directory: null, file: null, total: part.total, received: 0, hash: createHash('sha256'), sha256: null, busy: true, timer: null };
        live.set(key, spool);
        try {
          spool.directory = await mkdtemp(join(dir, 'caremetric-upload-'));
          spool.file = join(spool.directory, 'file');
          await writeFile(spool.file, new Uint8Array(), { flag: 'wx', mode: 0o600 });
        } catch (error) { await drop(key, spool); throw error; }
      }
      spool.busy = true;
      try {
        if (part.offset !== spool.received) return { received: spool.received };
        // A part is written whole or not at all: a part cut short leaves the spool where it was.
        const bytes = await readPart(body, Math.min(uploadPartBytes, spool.total - spool.received), part.length);
        if (bytes.length) {
          try { await appendFile(spool.file, bytes); } catch (error) { await drop(key, spool); throw error; }
          spool.hash.update(bytes); spool.received += bytes.length;
        }
        if (spool.received < spool.total) return { received: spool.received };
        spool.sha256 ??= spool.hash.digest('hex');
        const { file, sha256, received: byteLength } = spool;
        let result;
        try { result = await complete({ file, sha256, byteLength, stream: () => createReadStream(file) }); }
        catch (error) {
          if (error instanceof HttpError && error.status >= 400 && error.status < 500) await drop(key, spool);
          throw error;
        }
        await drop(key, spool);
        return { result };
      } finally {
        spool.busy = false;
        if (live.get(key) === spool) idle(key, spool);
      }
    },
  };
}
