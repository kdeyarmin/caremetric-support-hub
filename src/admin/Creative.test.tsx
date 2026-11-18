// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Creative } from "./Creative";
import type { CreativeClient } from "./creativeClient";
import { studioSchema } from "./creativeProtocol";
import { TeamApiError } from "./teamClient";
import type { BrandKit, CreativeAsset, CreativeStudio } from "./creativeProtocol";

vi.hoisted(() => { vi.stubEnv("VITE_DEMO_MODE", "true"); });
beforeEach(() => { vi.stubGlobal("crypto", webcrypto); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const at = "2026-11-09T14:00:00.123456+00:00";
const asset = (over: Partial<CreativeAsset> = {}): CreativeAsset => ({
  id: "22222222-2222-4222-8222-222222222222", briefId: "11111111-1111-4111-8111-111111111111", product: "caremetric-intel", platform: "meta", placement: "meta.feed_square", kind: "static",
  layout: "checklist", width: 1080, height: 1080, durationSeconds: null, lengthKey: null, variantLabel: "A", hookType: "proof", concept: "See the territory",
  headline: "Territory plans from public data", primaryText: "CareMetric Intel brings targeted marketing into one place.", description: "Free trial", cta: "Start free trial",
  landingUrl: "https://www.caremetricintel.com/?utm_content=22222222-2222-4222-8222-222222222222", altText: "A checklist", captions: "", overlay: {}, provider: "internal", status: "proposed",
  compliance: { verdict: "pass", reasons: [] }, performance: {}, revisionNotes: "", actionId: "33333333-3333-4333-8333-333333333333", actionStatus: "proposed",
  contentType: "image/png", fileBytes: 51200, renderError: null, renderAttempts: 1, createdAt: at, updatedAt: at, renderedAt: at, approvedAt: null, liveAt: null, retiredAt: null, ...over,
});
const kit = (product: BrandKit["product"]): BrandKit => ({
  product, brandName: "CareMetric", logoFileId: null, primaryColor: null, secondaryColor: null, accentColor: null, textColor: null, backgroundColor: null, headingFont: null, bodyFont: null,
  voiceNotes: "", requiredDisclaimers: [], bannedPhrases: [], videoAvatarId: null, videoVoiceId: null, captionsDefault: true, version: 1, updatedAt: at, screenshots: [],
});
const studio = (over: Partial<CreativeStudio> = {}): CreativeStudio => studioSchema.parse({
  assets: [asset(), asset({ id: "44444444-4444-4444-8444-444444444444", variantLabel: "B", hookType: "problem", compliance: { verdict: "warn", reasons: [{ rule: "text_heavy", level: "warn", message: "Text covers about 30% of the picture." }],
      review: { score: 2, reader: "I would scroll past it.", fix: "Lead with the number." } } }),
    asset({ id: "55555555-5555-4555-8555-555555555555", variantLabel: "A-15s", kind: "video", placement: "meta.video_vertical", width: 1080, height: 1920, durationSeconds: 15, lengthKey: "15s", contentType: "video/mp4", status: "approved", actionStatus: "executed" })],
  total: 3, statusCounts: { proposed: 2, approved: 1 }, blocked: 4, briefs: [], brandKits: [kit("carebase"), kit("caremetric-intel")], learnings: [],
  themes: [
    { product: "caremetric-intel", name: "Emberline", mode: "dark", tagline: "Set your marketing on FIRE!", font: "Geist", source: "intel",
      colors: { primaryColor: "#FF7A45", secondaryColor: "#101116", accentColor: "#FF7A45", textColor: "#F4F4F6", backgroundColor: "#07080A" } },
    { product: "carebase", name: "CareBase", mode: "light", tagline: null, font: "Inter", source: "carebase",
      colors: { primaryColor: "#2563EB", secondaryColor: "#F8FAFC", accentColor: "#2563EB", textColor: "#0F172A", backgroundColor: "#FFFFFF" } },
  ], ...over,
});
const clientOf = (data = studio()): CreativeClient & { [K in keyof CreativeClient]: ReturnType<typeof vi.fn> } => ({
  studio: vi.fn(async () => data), setBrandKit: vi.fn(async () => kit("carebase")), addBrandFile: vi.fn(async () => kit("carebase")), removeBrandFile: vi.fn(async () => kit("carebase")),
  createBrief: vi.fn(async () => ({ ...data.briefs[0] })), decide: vi.fn(async () => ({ id: "33333333-3333-4333-8333-333333333333", kind: "creative.asset", status: "executed", decided: true })),
  uploadVideo: vi.fn(async () => ({ briefId: "11111111-1111-4111-8111-111111111111", already: false, assets: [] })),
  videoInfo: vi.fn(async () => ({ width: 1080, height: 1920, durationSeconds: 30 })),
}) as never;

describe("the Creative screen", () => {
  it("shows the gallery with previews, compliance badges and the blocked count, never a blocked asset", async () => {
    render(<Creative client={clientOf()} />);
    expect(await screen.findAllByText("Territory plans from public data")).toHaveLength(3);
    expect(screen.getAllByText("Passed every check", { selector: "span" })).toHaveLength(2);
    expect(screen.getByText("1 warning")).toBeTruthy();
    // The image review's score and what its reader took from it, beside the image it looked at.
    expect(screen.getByText("Image review: 2 of 5 as its audience would see it. I would scroll past it.")).toBeTruthy();
    expect(screen.getByText("Blocked by the checks (not shown)").parentElement?.textContent).toContain("4");
    expect(document.querySelector('img[src="/api/admin/creative/file/22222222-2222-4222-8222-222222222222"]')).toBeTruthy();
    expect(document.querySelector('video[src="/api/admin/creative/file/55555555-5555-4555-8555-555555555555"]')).toBeTruthy();
    expect(document.querySelector('a[href="/api/admin/creative/file/22222222-2222-4222-8222-222222222222?download=1"]')).toBeTruthy();
    // A blank brand kit is the product's own theme, so nothing waits on it.
    expect(screen.getByText(/Drawn in the Emberline theme/)).toBeTruthy();
    expect(screen.getByText(/Drawn in the CareBase theme/)).toBeTruthy();
    expect(screen.getAllByText(/the official .* logo is used/)).toHaveLength(2);
    expect(screen.getAllByText(/Use a PNG with a transparent background/)).toHaveLength(2);
  });

  it("approves everything waiting, on every page, after one confirmation", async () => {
    const client = clientOf();
    render(<Creative client={client} />);
    fireEvent.click(await screen.findByRole("button", { name: "Approve all 2" }));
    expect(screen.getByText(/Approve all 2 assets waiting for you\?/)).toBeTruthy();
    expect(client.decide).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Yes, approve all 2" }));
    expect(await screen.findByText("Approved 2 assets and handed them to the Social Media Manager.")).toBeTruthy();
    // Every waiting asset is read in full pages, and each is approved through the owner's own decide route; an approved one is left alone.
    expect(client.studio).toHaveBeenCalledWith({ product: null, platform: null, status: "proposed", offset: 0, limit: 60 }, expect.anything());
    expect(client.decide.mock.calls.map(([input]) => input)).toEqual([
      { actionId: "33333333-3333-4333-8333-333333333333", decision: "approve" }, { actionId: "33333333-3333-4333-8333-333333333333", decision: "approve" },
    ]);
  });

  it("says how many it could not approve, and never approves without the confirmation", async () => {
    const client = clientOf();
    client.decide.mockRejectedValueOnce(new TeamApiError(409, "That approval has expired."));
    render(<Creative client={client} />);
    fireEvent.click(await screen.findByRole("button", { name: "Approve all 2" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(client.decide).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Approve all 2" }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, approve all 2" }));
    expect(await screen.findByText("Approved 1 asset and handed it to the Social Media Manager. 1 asset could not be approved or handed over. Check the AI team's activity.")).toBeTruthy();
    expect(client.decide).toHaveBeenCalledTimes(2);
  });

  it("never counts an approval that expired or was decided elsewhere, and says when the hand-over comes later", async () => {
    const client = clientOf();
    client.decide
      .mockResolvedValueOnce({ id: "33333333-3333-4333-8333-333333333333", kind: "creative.asset_review", status: "expired", decided: false })
      .mockResolvedValueOnce({ id: "33333333-3333-4333-8333-333333333333", kind: "creative.asset_review", status: "approved", decided: true });
    render(<Creative client={client} />);
    fireEvent.click(await screen.findByRole("button", { name: "Approve all 2" }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, approve all 2" }));
    expect(await screen.findByText("1 asset is approved and goes to the Social Media Manager on the team's next run. 1 asset was no longer waiting (expired, or decided elsewhere), so it was not approved.")).toBeTruthy();
    expect(screen.queryByText(/handed it to the Social Media Manager/)).toBeNull();
  });

  it("approves through the AI team's decide route, and asks for changes only with a note", async () => {
    const client = clientOf();
    render(<Creative client={client} />);
    const card = (await screen.findAllByRole("article"))[0];
    fireEvent.click(within(card).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(client.decide).toHaveBeenCalledWith({ actionId: "33333333-3333-4333-8333-333333333333", decision: "approve" }));
    expect(await screen.findByText("Approved and handed to the Social Media Manager.")).toBeTruthy();
    const second = (await screen.findAllByRole("article"))[1];
    fireEvent.click(within(second).getByRole("button", { name: "Request changes" }));
    const send = within(second).getByRole("button", { name: "Send changes" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.change(within(second).getByLabelText("What should change?"), { target: { value: "Lead with the free trial." } });
    fireEvent.click(send);
    await waitFor(() => expect(client.decide).toHaveBeenLastCalledWith({ actionId: "33333333-3333-4333-8333-333333333333", decision: "reject", note: "Lead with the free trial." }));
  });

  it("filters by product, platform and status", async () => {
    const client = clientOf();
    render(<Creative client={client} />);
    await screen.findAllByRole("article");
    fireEvent.change(screen.getByLabelText("Platform"), { target: { value: "linkedin" } });
    await waitFor(() => expect(client.studio).toHaveBeenLastCalledWith(expect.objectContaining({ platform: "linkedin", offset: 0 }), expect.anything()));
  });

  it("starts a brief, refusing an audience described by a health condition", async () => {
    const client = clientOf(studio({ briefs: [{ id: "11111111-1111-4111-8111-111111111111", product: "caremetric-intel", goal: "g", audience: "a", offerCode: null, platforms: ["meta"], formats: ["static"], videoLengths: [], angle: "", source: "owner", status: "open", planRef: null, parentAssetId: null, revisionNote: "", result: {}, createdAt: at, updatedAt: at }] }));
    render(<Creative client={client} />);
    await screen.findAllByRole("article");
    fireEvent.change(screen.getByLabelText("Goal"), { target: { value: "Drive free-trial starts" } });
    fireEvent.change(screen.getByLabelText("Audience"), { target: { value: "Patients with diabetes" } });
    fireEvent.click(screen.getByRole("button", { name: "Start this brief" }));
    expect(await screen.findByText(/never by a health condition/)).toBeTruthy();
    expect(client.createBrief).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Audience"), { target: { value: "Marketing leaders at hospitals and nursing homes" } });
    fireEvent.click(screen.getByRole("button", { name: "Start this brief" }));
    await waitFor(() => expect(client.createBrief).toHaveBeenCalledWith(expect.objectContaining({ product: "caremetric-intel", goal: "Drive free-trial starts", platforms: ["meta"], formats: ["static"], videoLengths: [] })));
  });

  it("adds the owner's own finished video for each placement it fits, once attested", async () => {
    const client = clientOf();
    render(<Creative client={client} />);
    await screen.findAllByRole("article");
    const panel = screen.getByRole("region", { name: /Add a finished video/ });
    const file = new File([new Uint8Array(2048)], "caremetric-intel-commercial-9x16.mp4", { type: "video/mp4" });
    fireEvent.change(within(panel).getByLabelText("Video file"), { target: { files: [file] } });
    expect(await within(panel).findByText(/1080 x 1920, 30 seconds/)).toBeTruthy();
    const reels = within(panel).getByRole("checkbox", { name: "Instagram Reels and Facebook (9:16)" }) as HTMLInputElement;
    const linkedin = within(panel).getByRole("checkbox", { name: "LinkedIn (9:16)" }) as HTMLInputElement;
    expect(reels.checked && linkedin.checked).toBe(true);
    expect((within(panel).getByRole("textbox", { name: "Name" }) as HTMLInputElement).value).toBe("caremetric intel commercial 9x16");
    fireEvent.click(within(panel).getByRole("button", { name: "Add to the library" }));
    expect(await within(panel).findByRole("alert")).toBeTruthy();
    expect(client.uploadVideo).not.toHaveBeenCalled();
    fireEvent.click(within(panel).getByRole("checkbox", { name: /shows no patient, resident or personal information/ }));
    fireEvent.click(within(panel).getByRole("button", { name: "Add to the library" }));
    await waitFor(() => expect(client.uploadVideo).toHaveBeenCalledWith(expect.objectContaining({ product: "caremetric-intel", placements: ["meta.video_vertical", "linkedin.video_vertical"], attested: true, file })));
    expect(await screen.findByText(/Added to the library, approved for Instagram Reels and Facebook \(9:16\) and LinkedIn \(9:16\)/)).toBeTruthy();
  });

  it("says when a video fits no placement", async () => {
    const client = clientOf();
    client.videoInfo.mockResolvedValueOnce({ width: 1280, height: 720, durationSeconds: 20 });
    render(<Creative client={client} />);
    await screen.findAllByRole("article");
    const panel = screen.getByRole("region", { name: /Add a finished video/ });
    fireEvent.change(within(panel).getByLabelText("Video file"), { target: { files: [new File([new Uint8Array(16)], "clip.mp4", { type: "video/mp4" })] } });
    expect(await within(panel).findByText(/This video fits no placement/)).toBeTruthy();
    expect((within(panel).getByRole("button", { name: "Add to the library" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("saves a brand kit with the version it was read at", async () => {
    const client = clientOf();
    render(<Creative client={client} />);
    await screen.findAllByRole("article");
    const kitPanel = screen.getByRole("region", { name: /CareMetric CareBase brand kit/ });
    expect(within(kitPanel).getByText(/CareBase · light · Inter/)).toBeTruthy();
    const primary = within(kitPanel).getByRole("textbox", { name: "Primary color" });
    expect((primary as HTMLInputElement).placeholder).toBe("Theme #2563EB");
    fireEvent.change(primary, { target: { value: "#0B5394" } });
    fireEvent.click(within(kitPanel).getByRole("button", { name: "Use theme" }));
    expect((primary as HTMLInputElement).value).toBe("");
    fireEvent.change(primary, { target: { value: "#0B5394" } });
    fireEvent.click(within(kitPanel).getByRole("button", { name: "Save brand kit" }));
    await waitFor(() => expect(client.setBrandKit).toHaveBeenCalledWith(expect.objectContaining({ product: "carebase", expectedVersion: 1, kit: expect.objectContaining({ primaryColor: "#0B5394" }) })));
  });
});
