import { afterEach, describe, expect, it, vi } from "vitest";

// The library's lesson upload (learningApi.uploadMedia): the stored video is checked against the source before it is approved.
const session = vi.hoisted(() => ({ hubRpc: vi.fn(async (_name: string, args?: Record<string, unknown>) => args?.p_id), appRequest: vi.fn() }));
vi.mock("../lib/appSession", () => session);
vi.mock("../lib/config", () => ({ config: { demoMode: false } }));
import { learningApi } from "./api";

const videoBytes = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109, 1, 2, 3, 4]);
const files = () => [
  new File([videoBytes], "lesson.mp4", { type: "video/mp4" }),
  new File(["WEBVTT\n\n00:00.000 --> 00:01.000\nHello.\n"], "lesson.vtt", { type: "text/vtt" }),
  new File(["Hello.\n"], "lesson.txt", { type: "text/plain" }),
] as const;
const hex = async (bytes: Uint8Array<ArrayBuffer>) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), b => b.toString(16).padStart(2, "0")).join("");

// A Hub whose last video part answers `videoAnswer`, and whose stored copy (read by the fallback download) is `stored`.
function hub(videoAnswer: Record<string, unknown>, stored: Uint8Array<ArrayBuffer> = videoBytes) {
  const downloads: string[] = [];
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") return Response.json(url.endsWith("/video.mp4") ? videoAnswer : { uploaded: true });
    downloads.push(url);
    return new Response(stored);
  });
  vi.stubGlobal("fetch", fetcher);
  return { downloads };
}
afterEach(() => { vi.unstubAllGlobals(); session.hubRpc.mockClear(); });

describe("uploading a lesson video", () => {
  it("uses the checksum the Hub read back from Storage, without downloading the video again", async () => {
    const h = hub({ uploaded: true, sha256: await hex(videoBytes) });
    const [video, captions, transcript] = files();
    const id = await learningApi.uploadMedia("Lesson one", video, captions, transcript, true);
    expect(h.downloads).toEqual([]);
    expect(session.hubRpc).toHaveBeenCalledWith("register_learning_media", { p_id: id, p_title: "Lesson one", p_sha256: await hex(videoBytes), p_reviewed: true });
  });
  it("refuses a video whose stored checksum the Hub reports as different", async () => {
    hub({ uploaded: true, sha256: "0".repeat(64) });
    const [video, captions, transcript] = files();
    await expect(learningApi.uploadMedia("Lesson one", video, captions, transcript, true)).rejects.toThrow("does not match the source");
    expect(session.hubRpc).not.toHaveBeenCalled();
  });
  it("downloads and checks the stored copy itself when the Hub reports no checksum", async () => {
    const h = hub({ uploaded: true });
    const [video, captions, transcript] = files();
    await learningApi.uploadMedia("Lesson one", video, captions, transcript, true);
    expect(h.downloads).toHaveLength(1); expect(h.downloads[0]).toMatch(/^\/api\/media\/learning\/[0-9a-f-]{36}\/video\.mp4$/);
    const changed = hub({ uploaded: true }, new Uint8Array(videoBytes.length));
    await expect(learningApi.uploadMedia("Lesson one", ...files(), true)).rejects.toThrow("does not match the source");
    expect(changed.downloads).toHaveLength(1);
  });
});
