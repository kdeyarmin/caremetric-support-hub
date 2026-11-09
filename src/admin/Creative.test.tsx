// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Creative } from "./Creative";
import type { CreativeClient } from "./creativeClient";
import { studioSchema } from "./creativeProtocol";
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
  assets: [asset(), asset({ id: "44444444-4444-4444-8444-444444444444", variantLabel: "B", hookType: "problem", compliance: { verdict: "warn", reasons: [{ rule: "text_heavy", level: "warn", message: "Text covers about 30% of the picture." }] } }),
    asset({ id: "55555555-5555-4555-8555-555555555555", variantLabel: "A-15s", kind: "video", placement: "meta.video_vertical", width: 1080, height: 1920, durationSeconds: 15, lengthKey: "15s", contentType: "video/mp4", status: "approved", actionStatus: "executed" })],
  total: 3, statusCounts: { proposed: 2, approved: 1 }, blocked: 4, briefs: [], brandKits: [kit("carebase"), kit("caremetric-intel")], learnings: [], ...over,
});
const clientOf = (data = studio()): CreativeClient & { [K in keyof CreativeClient]: ReturnType<typeof vi.fn> } => ({
  studio: vi.fn(async () => data), setBrandKit: vi.fn(async () => kit("carebase")), addBrandFile: vi.fn(async () => kit("carebase")), removeBrandFile: vi.fn(async () => kit("carebase")),
  createBrief: vi.fn(async () => ({ ...data.briefs[0] })), decide: vi.fn(async () => ({ id: "33333333-3333-4333-8333-333333333333", kind: "creative.asset", status: "executed", decided: true })),
}) as never;

describe("the Creative screen", () => {
  it("shows the gallery with previews, compliance badges and the blocked count, never a blocked asset", async () => {
    render(<Creative client={clientOf()} />);
    expect(await screen.findAllByText("Territory plans from public data")).toHaveLength(3);
    expect(screen.getAllByText("Passed every check", { selector: "span" })).toHaveLength(2);
    expect(screen.getByText("1 warning")).toBeTruthy();
    expect(screen.getByText("Blocked by the checks (not shown)").parentElement?.textContent).toContain("4");
    expect(document.querySelector('img[src="/api/admin/creative/file/22222222-2222-4222-8222-222222222222"]')).toBeTruthy();
    expect(document.querySelector('video[src="/api/admin/creative/file/55555555-5555-4555-8555-555555555555"]')).toBeTruthy();
    expect(document.querySelector('a[href="/api/admin/creative/file/22222222-2222-4222-8222-222222222222?download=1"]')).toBeTruthy();
    expect(screen.getAllByText(/Nothing is rendered for this product until it has a/)).toHaveLength(2);
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
    fireEvent.change(screen.getByLabelText("Audience"), { target: { value: "Owners of home health agencies" } });
    fireEvent.click(screen.getByRole("button", { name: "Start this brief" }));
    await waitFor(() => expect(client.createBrief).toHaveBeenCalledWith(expect.objectContaining({ product: "caremetric-intel", goal: "Drive free-trial starts", platforms: ["meta"], formats: ["static"], videoLengths: [] })));
  });

  it("saves a brand kit with the version it was read at", async () => {
    const client = clientOf();
    render(<Creative client={client} />);
    await screen.findAllByRole("article");
    const kitPanel = screen.getByRole("region", { name: /CareMetric CareBase brand kit/ });
    fireEvent.change(within(kitPanel).getAllByPlaceholderText("#RRGGBB")[0], { target: { value: "#0B5394" } });
    fireEvent.click(within(kitPanel).getByRole("button", { name: "Save brand kit" }));
    await waitFor(() => expect(client.setBrandKit).toHaveBeenCalledWith(expect.objectContaining({ product: "carebase", expectedVersion: 1, kit: expect.objectContaining({ primaryColor: "#0B5394" }) })));
  });
});
