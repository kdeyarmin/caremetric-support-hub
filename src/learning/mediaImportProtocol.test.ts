import { describe, expect, it } from "vitest";
import { learningSourceId } from "../imports/pennsyncCourseImport";
import { MEDIA_IMPORT_COLUMNS, matchSidecar, mediaImportRequestSchema, mediaImportTargetKey, parseCsv, parseMediaManifest, validateSidecars } from "./mediaImportProtocol";

const header = MEDIA_IMPORT_COLUMNS.join(",");
const module = "65f1a2b3c4d5e6f708192a3b";
const draft = "3f0c2a1e-4b5d-4c6e-8f70-91a2b3c4d5e6";
const line = (fields: Partial<Record<(typeof MEDIA_IMPORT_COLUMNS)[number], string>> = {}) => MEDIA_IMPORT_COLUMNS.map(name => ({
  product: "PennSync", course_title: "Infection control", lesson_title: "Hand hygiene", source_record: module, duration_seconds: "94.5",
  mp4_url: "https://resource2.heygen.ai/video/abc.mp4", poster_url: "", captions_file: "captions/abc.vtt", transcript_file: "transcripts/abc.txt",
  heygen_video_id: "abc123def", ...fields,
})[name]).join(",");

describe("CSV parsing", () => {
  it("reads quoted commas, doubled quotes, CRLF and a byte-order mark", () => {
    expect(parseCsv('\uFEFFa,b,c\r\n"x, y","say ""hi""",\r\n\r\nlast,row,here')).toEqual([["a", "b", "c"], ["x, y", 'say "hi"', ""], ["last", "row", "here"]]);
    expect(parseCsv('a,"multi\nline"\n')).toEqual([["a", "multi\nline"]]);
  });
  it("rejects malformed quoting instead of guessing", () => {
    expect(() => parseCsv('a,"open\n')).toThrow(/inside a quoted field/);
    expect(() => parseCsv('a,b"c\n')).toThrow(/quote inside an unquoted field/);
    expect(() => parseCsv('a,"b"c\n')).toThrow(/text after a closing quote/);
    expect(() => parseCsv("x".repeat(524289))).toThrow(/512 KB/);
  });
});

describe("manifest validation", () => {
  it("normalizes valid rows for both products, in any column order", () => {
    const reordered = [...MEDIA_IMPORT_COLUMNS].reverse();
    const values = (text: string) => { const cells = text.split(","); return reordered.map(name => cells[MEDIA_IMPORT_COLUMNS.indexOf(name)]).join(","); };
    const carebase = line({ product: "CareBase", source_record: draft.toUpperCase(), heygen_video_id: "cb-1234567", mp4_url: "https://files2.heygen.ai/x/cb.mp4?Expires=1",
      captions_file: "cb.vtt", transcript_file: "cb.txt", poster_url: "https://files2.heygen.ai/x/cb.jpg", lesson_title: "  Fire   safety " });
    const parsed = parseMediaManifest([reordered.join(","), values(line()), values(carebase)].join("\n"));
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows).toEqual([
      { line: 2, product: "pennsync", courseTitle: "Infection control", lessonTitle: "Hand hygiene", sourceRecord: module, durationSeconds: 94.5,
        mp4Url: "https://resource2.heygen.ai/video/abc.mp4", posterUrl: null, captionsFile: "captions/abc.vtt", transcriptFile: "transcripts/abc.txt", heygenVideoId: "abc123def" },
      expect.objectContaining({ line: 3, product: "carebase", sourceRecord: draft, lessonTitle: "Fire   safety", posterUrl: "https://files2.heygen.ai/x/cb.jpg" }),
    ]);
  });

  it("requires exactly the documented columns", () => {
    expect(parseMediaManifest(`${header},notes\n${line()},x`).errors[0].message).toMatch(/columns must be exactly/);
    expect(parseMediaManifest(header.replace(",poster_url", "")).errors[0].message).toMatch(/columns must be exactly/);
    expect(parseMediaManifest(header).errors[0].message).toMatch(/lists no videos/);
  });

  it("reports every invalid row with its line and stages none of them", () => {
    const parsed = parseMediaManifest([header, line(),
      line({ product: "carebase", heygen_video_id: "other123", mp4_url: "https://resource2.heygen.ai/2.mp4", captions_file: "2.vtt", transcript_file: "2.txt" }),
      line({ mp4_url: "http://resource2.heygen.ai/3.mp4", heygen_video_id: "third123", source_record: "0123456789abcdef01234567", captions_file: "3.vtt", transcript_file: "3.txt" }),
      line({ duration_seconds: "1e3", heygen_video_id: "fourth12", source_record: "1123456789abcdef01234567", mp4_url: "https://resource2.heygen.ai/4.mp4", captions_file: "../4.vtt", transcript_file: "4.txt" }),
      "too,few,fields",
    ].join("\n"));
    expect(parsed.rows).toEqual([]);
    expect(parsed.errors.map(error => error.line)).toEqual([3, 4, 5, 6]);
    expect(parsed.errors[0].message).toMatch(/TrainingModule id can only name a PennSync lesson/);
    expect(parsed.errors[1].message).toMatch(/mp4Url must be an https URL/);
    expect(parsed.errors[2].message).toMatch(/durationSeconds/);
    expect(parsed.errors[2].message).toMatch(/captionsFile/);
    expect(parsed.errors[3].message).toMatch(/Expected 10 fields/);
  });

  it("refuses a render, URL, lesson or sidecar listed twice", () => {
    const parsed = parseMediaManifest([header, line(), line({ heygen_video_id: "second12", mp4_url: "https://resource2.heygen.ai/2.mp4", captions_file: "2.vtt", transcript_file: "2.txt" }),
      line({ source_record: "1123456789abcdef01234567", lesson_title: "Other", mp4_url: "https://resource2.heygen.ai/3.mp4", captions_file: "3.vtt", transcript_file: "3.txt" })].join("\n"));
    expect(parsed.errors).toEqual([
      { line: 3, message: "This lesson is already listed on line 2." },
      { line: 4, message: "This render is already listed on line 2." },
    ]);
    expect(mediaImportTargetKey({ sourceRecord: draft, lessonTitle: " Fire  Safety" })).toBe(mediaImportTargetKey({ sourceRecord: draft, lessonTitle: "fire safety" }));
  });

  it("derives the same PennSync lesson identity as the conversion and the SQL resolver", async () => {
    // The contract migration asserts the same vector in SQL.
    expect(await learningSourceId("lesson", module)).toBe("f185124e-304d-8d4a-8a4e-2607fe5877ed");
  });
});

describe("sidecars", () => {
  it("resolves folder paths exactly beside the manifest and loose files by name", () => {
    const folder = [{ name: "abc.vtt", webkitRelativePath: "hub-media-2026/captions/abc.vtt" }, { name: "abc.txt", webkitRelativePath: "hub-media-2026/abc.txt" },
      { name: "lesson.vtt", webkitRelativePath: "selected/archive/captions/lesson.vtt" }];
    expect(matchSidecar("captions/abc.vtt", folder, "hub-media-2026")?.webkitRelativePath).toBe("hub-media-2026/captions/abc.vtt");
    expect(matchSidecar("abc.txt", folder, "hub-media-2026")?.name).toBe("abc.txt");
    // A same-named file in another directory of the chosen folder is never used.
    expect(matchSidecar("captions/lesson.vtt", folder, "selected/current")).toBeNull();
    expect(matchSidecar("abc.vtt", folder, "hub-media-2026")).toBeNull();
    const loose = [{ name: "loose.vtt", webkitRelativePath: "" }, { name: "dup.vtt" }, { name: "dup.vtt" }];
    expect(matchSidecar("loose.vtt", loose)?.name).toBe("loose.vtt");
    expect(matchSidecar("captions/loose.vtt", loose)?.name).toBe("loose.vtt");
    expect(matchSidecar("dup.vtt", loose)).toBeNull();
    expect(matchSidecar("missing.vtt", loose)).toBeNull();
  });
  it("applies the server's WebVTT and transcript checks first", () => {
    const captions = "WEBVTT\n\n00:00.000 --> 00:02.000\nWash your hands.\n";
    expect(validateSidecars({ durationSeconds: 2 }, captions, "Wash your hands.")).toBeNull();
    expect(validateSidecars({ durationSeconds: 1.2 }, captions, "Wash your hands.")).toBeNull();
    expect(validateSidecars({ durationSeconds: 0.5 }, captions, "Wash your hands.")).toMatch(/^Captions:/);
    expect(validateSidecars({ durationSeconds: 2 }, "Wash your hands.", "Wash your hands.")).toMatch(/^Captions:.*WEBVTT/);
    expect(validateSidecars({ durationSeconds: 2 }, captions, "Contact nurse@example.com")).toMatch(/^Transcript:.*email/);
  });
  it("accepts only the documented operations", () => {
    expect(mediaImportRequestSchema.safeParse({ operation: "register", mediaId: draft, reviewed: true }).success).toBe(true);
    expect(mediaImportRequestSchema.safeParse({ operation: "register", mediaId: draft, reviewed: false }).success).toBe(false);
    expect(mediaImportRequestSchema.safeParse({ operation: "publish", mediaId: draft }).success).toBe(false);
    expect(mediaImportRequestSchema.safeParse({ operation: "list", extra: 1 }).success).toBe(false);
  });
});
