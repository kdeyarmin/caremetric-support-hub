// Node 22.18+ / 24+. Read-only accounting for the CareBase course publication
// bridge: every imported catalog course, its credit basis, and the one reason
// it can still be waiting on (central media transfer). The catalog rows are
// read from the reviewed import migration, the same rows that created
// hub.content_items and hub.course_links in production.
//   node scripts/audit-carebase-course-bridge.mjs
import { readFileSync } from "node:fs";

const migration = readFileSync(new URL("../supabase/migrations/20260907143500_import_penntrain_catalog.sql", import.meta.url), "utf8");
const blocks = [...migration.matchAll(/\$catalog\$(.*?)\$catalog\$/gs)].map(match => JSON.parse(match[1]));
if (blocks.length !== 2) throw new Error(`Expected the course and course-link catalog blocks, found ${blocks.length}.`);
const [items, links] = blocks;
const byId = new Map(items.map(row => [row.id, row]));
if (byId.size !== items.length || links.length !== items.length || links.some(row => !byId.has(row.id))) {
  throw new Error("The catalog item and course-link blocks do not describe the same courses.");
}

const courses = items.map(row => {
  const videos = row.video_count ?? 0;
  return {
    sourceCourseId: row.id,
    contentKey: row.content_key,
    title: row.title,
    creditMinutes: row.duration_minutes,
    videoLessons: videos,
    launchPath: row.launch_path,
    state: videos > 0 ? "awaiting-media-transfer" : "ready-to-publish-after-import",
    reason: videos > 0
      ? `${videos} video lesson(s) must complete the reviewed central media transfer (registered media with checksum, captions, and transcript) before publication validation passes.`
      : "No catalog-level blocker: publishes once its imported draft passes the preservation gate and publishing validation.",
  };
}).sort((a, b) => a.title.localeCompare(b.title));

const missingCredit = courses.filter(course => !(course.creditMinutes >= 1));
const awaiting = courses.filter(course => course.state === "awaiting-media-transfer");
const report = {
  totalCourses: courses.length,
  creditBasisPresent: courses.length - missingCredit.length,
  readyToPublishAfterImport: courses.length - awaiting.length,
  awaitingMediaTransfer: { courses: awaiting.length, videoLessons: awaiting.reduce((n, course) => n + course.videoLessons, 0) },
  courses,
};
console.log(JSON.stringify(report, null, 2));
if (courses.length !== 80) throw new Error(`Expected 80 imported courses, accounted for ${courses.length}.`);
if (missingCredit.length) throw new Error(`Courses missing a credited duration: ${missingCredit.map(course => course.contentKey).join(", ")}`);
