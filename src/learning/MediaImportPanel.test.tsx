// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MEDIA_IMPORT_COLUMNS, type MediaImportItem } from "./mediaImportProtocol";

const client = vi.hoisted(() => ({ list: vi.fn(), stage: vi.fn(), register: vi.fn(), attach: vi.fn(), review: vi.fn() }));
vi.mock("./mediaImportClient", () => ({ mediaImportClient: client }));
const { MediaImportPanel } = await import("./MediaImportPanel");

const captions = "WEBVTT\n\n00:00.000 --> 00:01.500\nWelcome to the lesson.\n";
const transcript = "Welcome to the lesson.\n";
const csvLine = (n: number, product = "pennsync", source = `65f1a2b3c4d5e6f708192a3${n}`) => [product, "Infection control", `Lesson ${n}`, source, "2",
  `https://resource2.heygen.ai/video/${n}.mp4`, "", `captions/${n}.vtt`, `transcripts/${n}.txt`, `render${n}abc`].join(",");
const manifest = (lines: string[]) => new File([[MEDIA_IMPORT_COLUMNS.join(","), ...lines].join("\n")], "manifest.csv", { type: "text/csv" });
const sidecars = (n: number, captionText = captions) => [new File([captionText], `${n}.vtt`), new File([transcript], `${n}.txt`)];
function item(n: number, overrides: Partial<MediaImportItem> = {}): MediaImportItem {
  return { itemKey: `pennsync:65f1a2b3c4d5e6f708192a3${n}:render${n}abc`, product: "pennsync", courseTitle: "Infection control", lessonTitle: `Lesson ${n}`,
    sourceRecord: `65f1a2b3c4d5e6f708192a3${n}`, heygenVideoId: `render${n}abc`, durationSeconds: 94, mp4Url: `https://resource2.heygen.ai/video/${n}.mp4`,
    captionsFile: `captions/${n}.vtt`, transcriptFile: `transcripts/${n}.txt`, state: "staged", failureCode: null,
    mediaId: `00000000-0000-4000-8000-00000000000${n}`, sourceSha256: "a".repeat(64), byteSize: 3145728, attempts: 1, updatedAt: "2026-11-06T00:00:00Z",
    target: { state: "ready", itemId: "10000000-0000-4000-8000-000000000001", draftTitle: "Infection control", unitId: "20000000-0000-4000-8000-000000000001", unitTitle: `Lesson ${n}` },
    ...overrides };
}
const choose = (files: File[]) => fireEvent.change(screen.getByLabelText("Manifest, captions and transcripts"), { target: { files } });
beforeEach(() => { client.list.mockResolvedValue([]); });
afterEach(() => { cleanup(); vi.resetAllMocks(); });

it("checks the manifest and every sidecar before offering a transfer", async () => {
  render(<MediaImportPanel />);
  choose([manifest([csvLine(1), csvLine(2), csvLine(3)]), ...sidecars(1), new File([captions], "2.vtt"), ...sidecars(3, "not captions")]);
  await screen.findByText(/manifest.csv: 1 of 3 videos ready \(1 PennSync · 0 CareBase\)/);
  const problems = screen.getByRole("list", { name: "Manifest problems" });
  expect(within(problems).getByText(/Line 3 \(Lesson 2\): Choose exactly one transcripts\/2.txt/)).toBeTruthy();
  expect(within(problems).getByText(/Line 4 \(Lesson 3\): Captions:/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Transfer 1 videos" })).toBeTruthy();
  expect(client.stage).not.toHaveBeenCalled();
});

it("transfers nothing from a manifest with row errors", async () => {
  render(<MediaImportPanel />);
  choose([manifest([csvLine(1), csvLine(2, "carebase")]), ...sidecars(1), ...sidecars(2)]);
  await screen.findByText(/TrainingModule id can only name a PennSync lesson/);
  expect(screen.getByText(/No video is transferred from a manifest with errors/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Transfer/ })).toBeNull();
});

it("transfers row by row, reports a partial failure, and retries only the failed row with the same request", async () => {
  client.stage.mockImplementation(async ({ row }: { row: { lessonTitle: string } }) => row.lessonTitle === "Lesson 2"
    ? { item: item(2, { state: "failed", failureCode: "source_unavailable", mediaId: null }), replayed: false }
    : { item: item(Number(row.lessonTitle.slice(-1))), replayed: false });
  render(<MediaImportPanel />);
  choose([manifest([csvLine(1), csvLine(2), csvLine(3)]), ...sidecars(1), ...sidecars(2), ...sidecars(3)]);
  fireEvent.click(await screen.findByRole("button", { name: "Transfer 3 videos" }));
  await screen.findByText(/2 of 3 videos staged; 1 need attention/);
  const results = screen.getByRole("list", { name: "Transfer results" });
  expect(within(results).getByText(/Line 3 · Infection control · Lesson 2: The MP4 could not be downloaded/)).toBeTruthy();
  expect(within(results).getByText(/Line 4 · Infection control · Lesson 3: Stored privately/)).toBeTruthy();
  expect(client.stage).toHaveBeenCalledTimes(3);
  const [failedRequest] = client.stage.mock.calls[1];
  expect(failedRequest).toMatchObject({ manifestSha256: expect.stringMatching(/^[a-f0-9]{64}$/), captions, transcript, row: expect.not.objectContaining({ line: expect.anything() }) });

  client.stage.mockResolvedValueOnce({ item: item(2), replayed: false });
  fireEvent.click(screen.getByRole("button", { name: "Retry 1 failed" }));
  await screen.findByText(/1 of 1 videos staged\./);
  expect(client.stage).toHaveBeenCalledTimes(4);
  expect(failedRequest.row.lessonTitle).toBe("Lesson 2");
  expect(client.stage.mock.calls[3][0]).toEqual(failedRequest);
  expect(within(screen.getByRole("list", { name: "Transfer results" })).getAllByText(/Stored privately/)).toHaveLength(3);
});

it("approves a staged video only after its review is opened and confirmed", async () => {
  client.list.mockResolvedValueOnce([item(1), item(4, { state: "failed", failureCode: "hash_mismatch", mediaId: null })]).mockResolvedValue([item(1, { state: "registered", target: { ...item(1).target, state: "attached" } })]);
  client.review.mockResolvedValue({ video: "https://media.test/video.mp4", captions: "https://media.test/captions.vtt", transcript: "Welcome to the lesson." });
  client.register.mockResolvedValue({ item: item(1, { state: "registered" }), replayed: false });
  render(<MediaImportPanel />);
  const staged = await screen.findByRole("article", { name: "Infection control · Lesson 1" });
  expect(within(staged).getByText(/Infection control · Lesson 1: Ready to attach to this lesson/)).toBeTruthy();
  expect(screen.getByText(/The stored copy does not match the downloaded video/)).toBeTruthy();
  expect(within(staged).queryByRole("button", { name: /Approve/ })).toBeNull();
  fireEvent.click(within(staged).getByRole("button", { name: "Review video, captions and transcript" }));
  const approve = await within(staged).findByRole("button", { name: "Approve and attach to lesson" }) as HTMLButtonElement;
  expect(within(staged).getByText("Welcome to the lesson.")).toBeTruthy();
  expect(approve.disabled).toBe(true);
  fireEvent.click(within(staged).getByRole("checkbox"));
  fireEvent.click(approve);
  await waitFor(() => expect(client.register).toHaveBeenCalledWith("00000000-0000-4000-8000-000000000001"));
  await screen.findByText(/Approved \(1\)/);
  expect(screen.getByText(/Attached to this lesson/)).toBeTruthy();
});

it("offers attachment for an approved video once its lesson exists, and explains when it cannot", async () => {
  client.list.mockResolvedValue([item(1, { state: "registered" }), item(2, { state: "registered", target: { state: "missing_draft", itemId: null, draftTitle: null, unitId: null, unitTitle: null } })]);
  client.attach.mockResolvedValue({ item: item(1, { state: "registered" }), replayed: false });
  render(<MediaImportPanel />);
  fireEvent.click(await screen.findByRole("button", { name: "Attach to lesson" }));
  await waitFor(() => expect(client.attach).toHaveBeenCalledWith("00000000-0000-4000-8000-000000000001"));
  expect(screen.getByText(/No Hub draft has this course yet/)).toBeTruthy();
  expect(screen.getAllByRole("button", { name: "Attach to lesson" })).toHaveLength(1);
});
