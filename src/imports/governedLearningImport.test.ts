import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { z } from "zod";
import fixture from "./fixtures/governedCourse.json";
import { governedCourseSchema, governedImportSummary, prepareGovernedImport, sourceDigest, validateGovernedCourse } from "./governedLearningImport";

async function envelope(value: unknown = fixture) {
  const payload = JSON.stringify(value);
  return { contract: "carebase.catalog-snapshot.v1", scope: "global-courses-with-current-version", courses: [{ payload, sourceRevision: await sourceDigest(payload) }] };
}

describe("governed CareBase source contract", () => {
  it("preserves every source field and original payload bytes, including native policy unsupported by generic Hub drafts", async () => {
    const snapshot = await envelope();
    const [parsed] = await prepareGovernedImport(snapshot);
    expect(parsed.course).toEqual(fixture);
    expect(parsed.payload).toBe(snapshot.courses[0].payload);
    expect(governedImportSummary([parsed])).toEqual({ courses: 1, archived: 0, blocks: 6, quizzes: 1, questions: 1, creditRules: 2, providers: 1, mediaReferences: 3 });
  });
  it.each(["draft", "published", "archived"])("preserves source publication state %s explicitly", async publicationState => {
    const [parsed] = await prepareGovernedImport(await envelope({ ...fixture, publicationState }));
    expect(parsed.course.publicationState).toBe(publicationState);
  });
  it.each(["assessment", "knowledge_check", "final_exam"])("preserves %s quiz behavior without coercion", async kind => {
    const value = structuredClone(fixture);
    const quiz = value.blocks[1].quiz!;
    Object.assign(quiz, { kind, passingScore: 0, maxAttempts: 11, revealsAnswersAfterAttempt: kind === "knowledge_check" });
    quiz.questions[0].type = "true_false";
    expect((await prepareGovernedImport(await envelope(value)))[0].course.blocks[1].quiz).toEqual(quiz);
  });
  it("accepts lowercase and uppercase opaque native IDs without requiring RFC v4", async () => {
    const value = { ...fixture, sourceVersionId: "AAAAAAAA-0000-0000-0000-000000000000" };
    expect((await prepareGovernedImport(await envelope(value)))[0].course.sourceVersionId).toBe(value.sourceVersionId);
  });
  it("detects changed content, credit policy, provider and retirement despite an unchanged native version UUID", async () => {
    const original = await sourceDigest(JSON.stringify(fixture));
    for (const change of [
      { ...fixture, publicationState: "archived" },
      { ...fixture, provider: { ...fixture.provider, fullName: "Another synthetic provider" } },
      { ...fixture, credits: [{ ...fixture.credits[0], creditHours: "3.00" }] },
      { ...fixture, course: { ...fixture.course, recurrenceIntervalDays: 730 } },
    ]) expect(await sourceDigest(JSON.stringify(change))).not.toBe(original);
  });
  it("rejects tampered payloads before parsing or staging", async () => {
    const snapshot = await envelope();
    snapshot.courses[0].payload += " ";
    await expect(prepareGovernedImport(snapshot)).rejects.toThrow("checksum");
  });
  it("rejects unrecognized fields rather than silently discarding source metadata", () => {
    expect(() => validateGovernedCourse({ ...fixture, employeeId: "private" })).toThrow();
    expect(() => validateGovernedCourse({ ...fixture, course: { ...fixture.course, unknownFuturePolicy: true } })).toThrow();
  });
  it.each(["https://video.invalid/play?token=private", "https://video.invalid/play?X-Amz-Signature=private", "https://video.invalid/play?access_token=private"])("rejects credential-bearing authored content: %s", url => {
    const value = validateGovernedCourse(structuredClone(fixture));
    value.blocks[0].body = { content: url };
    expect(() => validateGovernedCourse(value)).toThrow("playback credentials");
  });
  it("rejects exam answer reveal, duplicate question IDs and detached quiz configuration", () => {
    const value = structuredClone(fixture);
    value.blocks[1].quiz!.revealsAnswersAfterAttempt = true;
    expect(() => validateGovernedCourse(value)).toThrow("visibility");
    value.blocks[1].quiz!.revealsAnswersAfterAttempt = false;
    value.blocks[1].quiz!.questions.push(value.blocks[1].quiz!.questions[0]);
    expect(() => validateGovernedCourse(value)).toThrow("identifier");
    value.blocks[1].quiz = null;
    expect(() => validateGovernedCourse(value)).toThrow("configuration");
  });
  it("rejects duplicate source courses", async () => {
    const snapshot = await envelope();
    snapshot.courses.push(snapshot.courses[0]);
    await expect(prepareGovernedImport(snapshot)).rejects.toThrow("repeats a source course");
  });
  it("pins the database validator to the same strict schema", () => {
    const sql = readFileSync("supabase/migrations/20260911152329_governed_learning_snapshots.sql", "utf8");
    expect(JSON.parse(sql.split("$schema$")[1])).toEqual(z.toJSONSchema(governedCourseSchema, { target: "draft-7" }));
  });
  it("keeps the exporter read-only and excludes learner tables and media locations", () => {
    const sql = readFileSync("scripts/export-carebase-governed-learning.sql", "utf8");
    expect(sql).not.toMatch(/(?:from|join)\s+(?:public\.)?(?:employees|profiles|quiz_attempts|course_assignments|certificates|course_progress|employee_training_records)\b/i);
    expect(sql).not.toMatch(/\b(?:insert into|update public|delete from|lp\.storage_path|lp\.storage_bucket)\b/i);
    expect(sql).toContain("extensions.digest(b.video_url,'sha256')");
    expect(sql).not.toContain("c.status='published'");
  });
  it("the offline rehearsal does not print payloads or file paths on invalid input", () => {
    const result = spawnSync(process.execPath, ["scripts/rehearse-governed-learning-import.mjs", "src/imports/fixtures/governedCourse.json"], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).not.toContain("Synthetic Provider");
    expect(result.stderr).not.toContain("governedCourse.json");
    expect(result.stdout).toBe("");
  });
  it("hashes exactly UTF-8 source bytes in Node and the browser Web Crypto contract", async () => {
    const payload = '{"title":"Synthetic café", "creditHours":"4.00"}';
    const expected = execFileSync(process.execPath, ["--input-type=module", "-e", "import { createHash } from 'node:crypto'; process.stdout.write(createHash('sha256').update(process.argv[1]).digest('hex'));", payload], { encoding: "utf8" });
    expect(await sourceDigest(payload)).toBe(expected);
  });
});
