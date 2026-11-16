import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseUploadPart, partKey, partUploads, uploadPartBytes } from './upload-parts.mjs';
import { HttpError } from './sms-auth.mjs';

const bytes = Buffer.from('0123456789abcdefghij');
const sha = value => createHash('sha256').update(value).digest('hex');
const part = (offset, slice, total = bytes.length) => [{ offset, total, length: slice.length }, Readable.from(slice.length ? [slice] : [])];
let dir;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'upload-parts-test-')); });
afterEach(async () => { vi.useRealTimers(); await rm(dir, { recursive: true, force: true }); });
const spools = async () => readdir(dir);

describe('upload part headers', () => {
  it('reads a part, and treats a request without part headers as a whole upload', () => {
    expect(parseUploadPart({})).toBe(null);
    expect(parseUploadPart({ 'upload-offset': '8', 'upload-length': '20', 'content-length': '12' })).toEqual({ offset: 8, total: 20, length: 12 });
    expect(parseUploadPart({ 'upload-offset': '20', 'upload-length': '20', 'content-length': '0' })).toEqual({ offset: 20, total: 20, length: 0 });
    // A proxy may send a part chunked, without a length; the bytes read are still bounded.
    expect(parseUploadPart({ 'upload-offset': '0', 'upload-length': '20' })).toEqual({ offset: 0, total: 20, length: null });
  });
  it.each([
    { 'upload-offset': '0' }, { 'upload-length': '20' }, { 'upload-offset': '-1', 'upload-length': '20' }, { 'upload-offset': '01', 'upload-length': '20' },
    { 'upload-offset': '0', 'upload-length': '0' }, { 'upload-offset': '21', 'upload-length': '20' }, { 'upload-offset': '10', 'upload-length': '20', 'content-length': '11' },
    { 'upload-offset': '0', 'upload-length': String(2 * uploadPartBytes), 'content-length': String(uploadPartBytes + 1) }, { 'upload-offset': '0', 'upload-length': '1e3' },
  ])('refuses a malformed part (%o)', headers => {
    expect(() => parseUploadPart(headers)).toThrow(HttpError);
  });
  it('keys a spool by the session that sent it', () => {
    expect(partKey('session-a', 'publication:x')).not.toBe(partKey('session-b', 'publication:x'));
    expect(partKey('session-a', 'publication:x')).not.toContain('session-a');
  });
});

describe('upload parts', () => {
  it('assembles ordered parts, then checks the whole file once', async () => {
    const uploads = partUploads({ budget: 100, dir });
    const complete = vi.fn(async file => {
      expect(await readFile(file.file)).toEqual(bytes);
      expect(Buffer.concat(await Array.fromAsync(file.stream()))).toEqual(bytes);
      return { stored: file.sha256, length: file.byteLength };
    });
    expect(await uploads.receive('k', ...part(0, bytes.subarray(0, 8)), complete)).toEqual({ received: 8 });
    expect(await uploads.receive('k', ...part(8, bytes.subarray(8, 16)), complete)).toEqual({ received: 16 });
    expect(complete).not.toHaveBeenCalled();
    expect(await uploads.receive('k', ...part(16, bytes.subarray(16)), complete)).toEqual({ result: { stored: sha(bytes), length: 20 } });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(await spools()).toEqual([]);
    expect(uploads.reserved).toBe(0);
  });

  it('answers a repeated part with upload_busy while the whole file is still being checked and stored', async () => {
    const uploads = partUploads({ budget: 100, dir });
    let finish;
    const storing = new Promise(resolve => { finish = resolve; });
    const slow = vi.fn(async () => { await storing; return { stored: true }; });
    const first = uploads.receive('k', ...part(0, bytes), slow);
    await vi.waitFor(() => expect(slow).toHaveBeenCalledOnce());
    // The browser gave up waiting and asks again: it must keep waiting, not count a failure (src/lib/uploadParts.ts).
    const repeat = await uploads.receive('k', ...part(0, bytes), slow).catch(error => error);
    expect(repeat).toBeInstanceOf(HttpError);
    expect(repeat).toMatchObject({ status: 503, code: 'upload_busy', publicMessage: 'This upload is still receiving a part. Retry shortly.' });
    finish();
    expect(await first).toEqual({ result: { stored: true } });
  });

  it('answers where to resume instead of writing a part out of order', async () => {
    const uploads = partUploads({ budget: 100, dir }), complete = vi.fn();
    expect(await uploads.receive('k', ...part(8, bytes.subarray(8, 16)), complete)).toEqual({ received: 0 });
    expect(await spools()).toEqual([]);
    await uploads.receive('k', ...part(0, bytes.subarray(0, 8)), complete);
    // A part repeated after its reply was lost, and one sent too far ahead, change nothing.
    expect(await uploads.receive('k', ...part(0, bytes.subarray(0, 8)), complete)).toEqual({ received: 8 });
    expect(await uploads.receive('k', ...part(16, bytes.subarray(16)), complete)).toEqual({ received: 8 });
    expect(await uploads.receive('k', ...part(8, bytes.subarray(8)), async file => readFile(file.file))).toEqual({ result: bytes });
  });

  it('writes a part whole or not at all', async () => {
    const uploads = partUploads({ budget: 100, dir }), complete = vi.fn(async () => 'stored');
    await uploads.receive('k', ...part(0, bytes.subarray(0, 8)), complete);
    // Cut short: fewer bytes arrived than the part declared.
    await expect(uploads.receive('k', { offset: 8, total: 20, length: 8 }, Readable.from([bytes.subarray(8, 12)]), complete)).rejects.toMatchObject({ status: 400 });
    // The connection dropped mid-part.
    const dropped = new Readable({ read() { this.push(bytes.subarray(8, 10)); this.destroy(new Error('aborted')); } });
    await expect(uploads.receive('k', { offset: 8, total: 20, length: 8 }, dropped, complete)).rejects.toThrow('aborted');
    // Past the end of the file, sent without a length.
    await expect(uploads.receive('k', { offset: 8, total: 20, length: null }, Readable.from([Buffer.alloc(13)]), complete)).rejects.toMatchObject({ status: 413 });
    expect(await uploads.receive('k', ...part(0, bytes.subarray(0, 8)), complete)).toEqual({ received: 8 });
    expect(await uploads.receive('k', { offset: 8, total: 20, length: null }, Readable.from([bytes.subarray(8)]), complete)).toEqual({ result: 'stored' });
  });

  it('keeps the file when storing it fails for now, and discards it when the bytes are wrong', async () => {
    const uploads = partUploads({ budget: 100, dir });
    const unavailable = vi.fn(async () => { throw new HttpError(503, 'Storage is unavailable.'); });
    await expect(uploads.receive('k', ...part(0, bytes), unavailable)).rejects.toMatchObject({ status: 503 });
    // An empty part at the end retries the check and storage without sending the file again.
    const stored = vi.fn(async file => ({ sha256: file.sha256 }));
    expect(await uploads.receive('k', ...part(20, Buffer.alloc(0)), stored)).toEqual({ result: { sha256: sha(bytes) } });
    expect(await spools()).toEqual([]);
    const wrong = vi.fn(async () => { throw new HttpError(422, 'The hash does not match.'); });
    await expect(uploads.receive('k', ...part(0, bytes), wrong)).rejects.toMatchObject({ status: 422 });
    expect(await spools()).toEqual([]);
    expect(await uploads.receive('k', ...part(20, Buffer.alloc(0)), stored)).toEqual({ received: 0 });
  });

  it('bounds the bytes all live uploads may reach, and frees them when an upload ends', async () => {
    const uploads = partUploads({ budget: 30, dir }), complete = vi.fn(async () => 'stored');
    await uploads.receive('a', ...part(0, bytes.subarray(0, 8)), complete);
    await expect(uploads.receive('b', ...part(0, bytes.subarray(0, 8)), complete)).rejects.toMatchObject({ status: 429 });
    expect(uploads.reserved).toBe(20);
    await uploads.receive('a', ...part(8, bytes.subarray(8)), complete);
    expect(await uploads.receive('b', ...part(0, bytes.subarray(0, 8)), complete)).toEqual({ received: 8 });
  });

  it('keeps sessions and targets apart, and restarts when the declared size changes', async () => {
    const uploads = partUploads({ budget: 100, dir }), complete = vi.fn();
    await uploads.receive(partKey('one', 't'), ...part(0, bytes.subarray(0, 8)), complete);
    expect(await uploads.receive(partKey('two', 't'), ...part(8, bytes.subarray(8, 16)), complete)).toEqual({ received: 0 });
    expect(await uploads.receive(partKey('one', 'u'), ...part(8, bytes.subarray(8, 16)), complete)).toEqual({ received: 0 });
    expect(await uploads.receive(partKey('one', 't'), ...part(0, bytes.subarray(0, 8), 30), complete)).toEqual({ received: 8 });
    expect(uploads.reserved).toBe(30);
  });

  it('refuses a second part for the same upload while one is being received', async () => {
    const uploads = partUploads({ budget: 100, dir }), complete = vi.fn();
    const slow = new Readable({ read() {} });
    const first = uploads.receive('k', { offset: 0, total: 20, length: 8 }, slow, complete);
    await vi.waitFor(async () => expect(await spools()).toHaveLength(1));
    await expect(uploads.receive('k', ...part(0, bytes.subarray(0, 8)), complete)).rejects.toMatchObject({ status: 503 });
    slow.push(bytes.subarray(0, 8)); slow.push(null);
    expect(await first).toEqual({ received: 8 });
  });

  it('removes an upload left idle', async () => {
    vi.useFakeTimers();
    const uploads = partUploads({ budget: 100, dir, idleMs: 1000 }), complete = vi.fn();
    await uploads.receive('k', ...part(0, bytes.subarray(0, 8)), complete);
    await vi.advanceTimersByTimeAsync(999);
    expect(uploads.reserved).toBe(20);
    await vi.advanceTimersByTimeAsync(1);
    vi.useRealTimers();
    await vi.waitFor(async () => expect(await spools()).toEqual([]));
    expect(uploads.reserved).toBe(0);
    expect(await uploads.receive('k', ...part(8, bytes.subarray(8, 16)), complete)).toEqual({ received: 0 });
  });
});
