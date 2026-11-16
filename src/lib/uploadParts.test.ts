import { describe, expect, it, vi } from "vitest";
import { UPLOAD_PART_BYTES, sendInParts } from "./uploadParts";

type Call = { offset: number; total: number; size: number; headers: Record<string, string> };
// A Hub spool (server/upload-parts.mjs): writes a part only where the file ends, and says where the next part starts.
function hub(total: number, answer?: (call: Call, received: number) => Response | Error | undefined) {
  const state = { received: 0, calls: [] as Call[] };
  const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const headers = init!.headers as Record<string, string>;
    const call = { offset: Number(headers["Upload-Offset"]), total: Number(headers["Upload-Length"]), size: (init!.body as Blob).size, headers };
    state.calls.push(call);
    const special = answer?.(call, state.received);
    if (special instanceof Error) throw special;
    if (special) return special;
    if (call.offset === state.received) state.received += call.size;
    return state.received < total ? Response.json({ received: state.received }, { status: 202 }) : Response.json({ stored: true });
  });
  return { state, fetcher: fetcher as unknown as typeof fetch, spy: fetcher };
}
const file = (size: number) => new Blob([new Uint8Array(size)]);
const noWait = vi.fn(async () => {});

describe("sending a file in parts", () => {
  it("sends ordered parts with their offset and the file size, and returns the Hub's answer to the whole file", async () => {
    const size = 2 * UPLOAD_PART_BYTES + 5, h = hub(size), progress: number[] = [];
    const response = await sendInParts(h.fetcher, "/api/upload", file(size), { "Content-Type": "video/mp4" }, { onProgress: received => progress.push(received), wait: noWait });
    expect(await response.json()).toEqual({ stored: true });
    expect(h.state.calls.map(({ offset, total, size: length }) => [offset, total, length])).toEqual([
      [0, size, UPLOAD_PART_BYTES], [UPLOAD_PART_BYTES, size, UPLOAD_PART_BYTES], [2 * UPLOAD_PART_BYTES, size, 5]]);
    expect(h.state.calls.every(call => call.headers["Content-Type"] === "video/mp4")).toBe(true);
    expect(h.spy.mock.calls.every(([url, init]) => url === "/api/upload" && init?.credentials === "same-origin" && init.redirect === "error")).toBe(true);
    expect(progress).toEqual([UPLOAD_PART_BYTES, 2 * UPLOAD_PART_BYTES]);
  });

  it("continues from where the Hub says, after a lost reply or an upload the Hub dropped", async () => {
    const size = 2 * UPLOAD_PART_BYTES + 5, P = UPLOAD_PART_BYTES;
    let lost = false, dropped = false;
    const h = hub(size, call => {
      // The second part is written, but its reply never arrives.
      if (call.offset === P && !lost) { lost = true; h.state.received += call.size; return new TypeError("Failed to fetch"); }
      // The Hub restarted before the last part: it holds nothing.
      if (call.offset === 2 * P && !dropped) { dropped = true; h.state.received = 0; return Response.json({ received: 0 }, { status: 202 }); }
      return undefined;
    });
    expect((await sendInParts(h.fetcher, "/api/upload", file(size), {}, { wait: noWait })).status).toBe(200);
    expect(h.state.calls.map(call => call.offset)).toEqual([0, P, P, 2 * P, 0, P, 2 * P]);
  });

  it("retries a network failure, a timeout and a server error from the same offset after a pause", async () => {
    const failures: (Response | Error)[] = [new TypeError("Failed to fetch"), new Response("", { status: 502 }), new Response("", { status: 503 }), Response.json({ wrong: 1 }, { status: 202 })];
    const size = UPLOAD_PART_BYTES + 1, wait = vi.fn<(ms: number) => Promise<void>>(async () => {});
    const h = hub(size, call => (call.offset === UPLOAD_PART_BYTES ? failures.shift() : undefined));
    const response = await sendInParts(h.fetcher, "/api/upload", file(size), {}, { wait });
    expect(response.status).toBe(200);
    expect(h.state.calls.map(call => call.offset)).toEqual([0, UPLOAD_PART_BYTES, UPLOAD_PART_BYTES, UPLOAD_PART_BYTES, UPLOAD_PART_BYTES, UPLOAD_PART_BYTES]);
    expect(wait.mock.calls.map(([ms]) => ms)).toEqual([1000, 2000, 4000, 8000]);
  });

  it("returns a refusal at once, without retrying", async () => {
    const h = hub(20, () => new Response(JSON.stringify({ error: "Invalid media type." }), { status: 415 }));
    expect((await sendInParts(h.fetcher, "/api/upload", file(20), {}, { wait: noWait })).status).toBe(415);
    expect(h.state.calls).toHaveLength(1);
  });

  it("gives up after repeated failures, and when the Hub keeps losing the upload", async () => {
    const down = hub(20, () => new Response("", { status: 503 }));
    expect((await sendInParts(down.fetcher, "/api/upload", file(20), {}, { wait: noWait })).status).toBe(503);
    expect(down.state.calls).toHaveLength(6);
    const unreachable = hub(20, () => new TypeError("Failed to fetch"));
    await expect(sendInParts(unreachable.fetcher, "/api/upload", file(20), {}, { wait: noWait })).rejects.toThrow("could not reach the Hub");
    const stuck = hub(UPLOAD_PART_BYTES + 1, () => Response.json({ received: 0 }, { status: 202 }));
    await expect(sendInParts(stuck.fetcher, "/api/upload", file(UPLOAD_PART_BYTES + 1), {}, { wait: noWait })).rejects.toThrow("could not make progress");
    expect(stuck.state.calls).toHaveLength(6);
    // A Hub that drops the upload over and over: the file is sent again a few times, not forever.
    const forgetful = hub(UPLOAD_PART_BYTES + 1, (call, received) => {
      if (call.offset === UPLOAD_PART_BYTES && received === UPLOAD_PART_BYTES) { forgetful.state.received = 0; return Response.json({ received: 0 }, { status: 202 }); }
      return undefined;
    });
    await expect(sendInParts(forgetful.fetcher, "/api/upload", file(UPLOAD_PART_BYTES + 1), {}, { wait: noWait })).rejects.toThrow("could not make progress");
    expect(forgetful.state.calls).toHaveLength(8);
  });

  it("stops when the person cancels", async () => {
    const controller = new AbortController();
    const h = hub(UPLOAD_PART_BYTES + 1, call => { if (call.offset === 0) controller.abort(); return undefined; });
    await expect(sendInParts(h.fetcher, "/api/upload", file(UPLOAD_PART_BYTES + 1), {}, { signal: controller.signal, wait: noWait })).rejects.toThrow();
    expect(h.state.calls).toHaveLength(1);
  });
});
