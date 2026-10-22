import { useState } from "react";
import type { z } from "zod";
import type { CareBaseCourseSummary } from "../admin/types";
import { collectionSchema, kitSchema, lessonSchema, metadataSchema, type CatalogCollection, type CatalogKit, type CatalogLesson,
  type CatalogMetadata, type StoredCollection, type StoredKit, type StoredLesson, type StoredMetadata } from "./catalogProtocol";

type FormProps<Stored, Record> = { initial: Stored | null; courses: CareBaseCourseSummary[]; busy: boolean; onSave: (record: Record) => void; onCancel: () => void };
const lines = (value: string) => value.split("\n").map(item => item.trim()).filter(Boolean);
const labels: Record<string, string> = { title: "Title", description: "Description", interests: "Interests", jobTitles: "Job titles", courseIds: "Courses",
  courseId: "Course", body: "Lesson text", question: "Question", choices: "Answer choices", correctChoice: "Correct answer", explanation: "Explanation",
  minutes: "Minutes", language: "Language", creditStatement: "Credit statement", creditEvidenceUrl: "Credit evidence link", name: "Name", items: "Courses" };
/** Names the fields CareBase would refuse, using the refinement's own sentence where there is one. */
function describeInvalid(error: z.ZodError) {
  const fields = [...new Set(error.issues.filter(issue => issue.path.length).map(issue => labels[String(issue.path[0])] ?? String(issue.path[0])))];
  const rules = error.issues.filter(issue => !issue.path.length).map(issue => issue.message);
  return [...rules, ...(fields.length ? [`Check ${fields.join(", ")}.`] : [])].join(" ");
}
function Actions({ busy, invalid, onCancel }: { busy: boolean; invalid: string; onCancel: () => void }) {
  return <>{invalid && <p role="alert">{invalid}</p>}
    <div className="admin-authoring-actions"><button type="submit" className="button button-primary" disabled={busy || Boolean(invalid)}>Save</button>
      <button type="button" className="button button-secondary" disabled={busy} onClick={onCancel}>Cancel</button></div></>;
}
const title = (courses: CareBaseCourseSummary[], id: string) => courses.find(course => course.id.toLowerCase() === id.toLowerCase())?.title ?? id;

/** An ordered list of chosen courses; CareBase checks each one's eligibility again on save. */
function CourseList({ label, courses, eligible, chosen, busy, onChange, required }: { label: string; courses: CareBaseCourseSummary[]; eligible: CareBaseCourseSummary[];
  chosen: string[]; busy: boolean; onChange: (ids: string[]) => void; required?: { value: Set<string>; onChange: (value: Set<string>) => void } }) {
  const [pick, setPick] = useState("");
  const available = eligible.filter(course => !chosen.some(id => id.toLowerCase() === course.id.toLowerCase()));
  return <fieldset><legend>{label}</legend>
    {chosen.length === 0 && <p>No courses yet.</p>}
    <ol>{chosen.map(id => <li key={id}>{title(courses, id)}
      {required && <label className="learning-checkbox"><input type="checkbox" disabled={busy} checked={required.value.has(id)}
        onChange={event => { const next = new Set(required.value); if (event.target.checked) next.add(id); else next.delete(id); required.onChange(next); }} />Required</label>}
      <button type="button" className="button button-secondary button-small" disabled={busy} onClick={() => onChange(chosen.filter(value => value !== id))}>Remove</button></li>)}</ol>
    <label>Add a course<select disabled={busy} value={pick} onChange={event => setPick(event.target.value)}>
      <option value="">Choose a published course</option>{available.map(course => <option key={course.id} value={course.id}>{course.title}</option>)}</select></label>
    <button type="button" className="button button-secondary button-small" disabled={busy || !pick} onClick={() => { onChange([...chosen, pick]); setPick(""); }}>Add course</button>
  </fieldset>;
}

export function CollectionForm({ initial, courses, busy, onSave, onCancel }: FormProps<StoredCollection, CatalogCollection>) {
  const [record, setRecord] = useState({ id: initial?.id ?? crypto.randomUUID(), title: initial?.title ?? "", description: initial?.description ?? "",
    interests: initial?.interests.join("\n") ?? "", jobTitles: initial?.jobTitles.join("\n") ?? "", published: initial?.published ?? false, courseIds: initial?.courseIds ?? [] });
  const parsed = collectionSchema.safeParse({ ...record, interests: lines(record.interests), jobTitles: lines(record.jobTitles) });
  const set = (patch: Partial<typeof record>) => setRecord(current => ({ ...current, ...patch }));
  return <form aria-label="Elective collection" onSubmit={event => { event.preventDefault(); if (parsed.success) onSave(parsed.data); }}>
    <label>Title<input disabled={busy} value={record.title} maxLength={150} onChange={event => set({ title: event.target.value })} /></label>
    <label>Description<textarea disabled={busy} value={record.description} maxLength={2000} onChange={event => set({ description: event.target.value })} /></label>
    <label>Interests, one per line (up to 20)<textarea disabled={busy} value={record.interests} onChange={event => set({ interests: event.target.value })} /></label>
    <label>Job titles, one per line (up to 30)<textarea disabled={busy} value={record.jobTitles} onChange={event => set({ jobTitles: event.target.value })} /></label>
    <CourseList label="Courses (up to 100)" courses={courses} eligible={courses.filter(course => course.status === "published")} chosen={record.courseIds} busy={busy}
      onChange={courseIds => set({ courseIds })} />
    <label className="learning-checkbox"><input type="checkbox" disabled={busy} checked={record.published} onChange={event => set({ published: event.target.checked })} />Published</label>
    <Actions busy={busy} invalid={parsed.success ? "" : describeInvalid(parsed.error)} onCancel={onCancel} />
  </form>;
}

export function LessonForm({ initial, courses, busy, onSave, onCancel }: FormProps<StoredLesson, CatalogLesson>) {
  const [record, setRecord] = useState({ id: initial?.id ?? crypto.randomUUID(), courseId: initial?.courseId ?? null, title: initial?.title ?? "", body: initial?.body ?? "",
    question: initial?.question ?? "", choices: initial?.choices ?? ["", ""], correctChoice: initial?.correctChoice ?? 0, explanation: initial?.explanation ?? "",
    minutes: initial?.minutes ?? 3, published: initial?.published ?? false });
  const parsed = lessonSchema.safeParse(record);
  const set = (patch: Partial<typeof record>) => setRecord(current => ({ ...current, ...patch }));
  const linked = courses.filter(course => course.status === "published" || course.id === record.courseId);
  return <form aria-label="Refresher lesson" onSubmit={event => { event.preventDefault(); if (parsed.success) onSave(parsed.data); }}>
    <label>Linked course<select disabled={busy} value={record.courseId ?? ""} onChange={event => set({ courseId: event.target.value || null })}>
      <option value="">No linked course</option>{linked.map(course => <option key={course.id} value={course.id}>{course.title}</option>)}</select></label>
    <label>Title<input disabled={busy} value={record.title} maxLength={150} onChange={event => set({ title: event.target.value })} /></label>
    <label>Lesson text (30 to 12,000 characters)<textarea disabled={busy} value={record.body} maxLength={12_000} onChange={event => set({ body: event.target.value })} /></label>
    <label>Question<textarea disabled={busy} value={record.question} maxLength={1000} onChange={event => set({ question: event.target.value })} /></label>
    <fieldset><legend>Answer choices (2 to 4)</legend>
      {record.choices.map((choice, index) => <div key={index}>
        <label className="learning-checkbox"><input type="radio" name={`correct-${record.id}`} disabled={busy} checked={record.correctChoice === index}
          onChange={() => set({ correctChoice: index })} />Correct</label>
        <label>Choice {index + 1}<textarea disabled={busy} value={choice} maxLength={1000}
          onChange={event => set({ choices: record.choices.map((value, at) => at === index ? event.target.value : value) })} /></label>
        {record.choices.length > 2 && <button type="button" className="button button-secondary button-small" disabled={busy} onClick={() => set({
          choices: record.choices.filter((_, at) => at !== index), correctChoice: record.correctChoice === index ? 0 : record.correctChoice > index ? record.correctChoice - 1 : record.correctChoice })}>Remove choice</button>}
      </div>)}
      {record.choices.length < 4 && <button type="button" className="button button-secondary button-small" disabled={busy} onClick={() => set({ choices: [...record.choices, ""] })}>Add choice</button>}
    </fieldset>
    <label>Explanation<textarea disabled={busy} value={record.explanation} maxLength={3000} onChange={event => set({ explanation: event.target.value })} /></label>
    <label>Minutes<select disabled={busy} value={record.minutes} onChange={event => set({ minutes: Number(event.target.value) })}>
      {[3, 4, 5].map(value => <option key={value} value={value}>{value}</option>)}</select></label>
    <label className="learning-checkbox"><input type="checkbox" disabled={busy} checked={record.published} onChange={event => set({ published: event.target.checked })} />Published</label>
    {initial && <p>Saving a new lesson revision asks learners who opened the old one to reopen it.</p>}
    <Actions busy={busy} invalid={parsed.success ? "" : describeInvalid(parsed.error)} onCancel={onCancel} />
  </form>;
}

export function MetadataForm({ initial, courses, busy, onSave, onCancel, existing }: FormProps<StoredMetadata, CatalogMetadata> & { existing: StoredMetadata[] }) {
  const [courseId, setCourseId] = useState(initial?.courseId ?? "");
  const stored = initial ?? existing.find(row => row.courseId.toLowerCase() === courseId.toLowerCase()) ?? null;
  const [record, setRecord] = useState({ language: stored?.language ?? "", creditStatement: stored?.creditStatement ?? "", creditEvidenceUrl: stored?.creditEvidenceUrl ?? "" });
  const parsed = metadataSchema.safeParse({ courseId, language: record.language.trim() || null, creditStatement: record.creditStatement.trim() ? record.creditStatement : null,
    creditEvidenceUrl: record.creditEvidenceUrl.trim() || null });
  const set = (patch: Partial<typeof record>) => setRecord(current => ({ ...current, ...patch }));
  function choose(id: string) {
    const row = existing.find(value => value.courseId.toLowerCase() === id.toLowerCase());
    setCourseId(id); setRecord({ language: row?.language ?? "", creditStatement: row?.creditStatement ?? "", creditEvidenceUrl: row?.creditEvidenceUrl ?? "" });
  }
  return <form aria-label="Discovery metadata" onSubmit={event => { event.preventDefault(); if (parsed.success) onSave(parsed.data); }}>
    <label>Course<select disabled={busy || Boolean(initial)} value={courseId} onChange={event => choose(event.target.value)}>
      <option value="">Choose a course</option>{courses.map(course => <option key={course.id} value={course.id}>{course.title}</option>)}</select></label>
    <label>Language (leave blank for none)<input disabled={busy} value={record.language} maxLength={100} onChange={event => set({ language: event.target.value })} /></label>
    <label>Credit statement<textarea disabled={busy} value={record.creditStatement} maxLength={1500} onChange={event => set({ creditStatement: event.target.value })} /></label>
    <label>Credit evidence link (https)<input disabled={busy} type="url" value={record.creditEvidenceUrl} maxLength={2000} onChange={event => set({ creditEvidenceUrl: event.target.value })} /></label>
    <p>Enter the credit statement and its evidence link together, or leave both blank.</p>
    <Actions busy={busy} invalid={parsed.success ? "" : describeInvalid(parsed.error)} onCancel={onCancel} />
  </form>;
}

export function KitForm({ initial, courses, busy, onSave, onCancel }: FormProps<StoredKit, CatalogKit>) {
  const [record, setRecord] = useState({ id: initial?.id ?? crypto.randomUUID(), revision: initial?.revision ?? null, name: initial?.name ?? "",
    description: initial?.description ?? "", published: initial?.published ?? false });
  const [courseIds, setCourseIds] = useState(initial?.items.map(item => item.courseId) ?? []);
  const [required, setRequired] = useState(new Set(initial?.items.filter(item => item.isRequired).map(item => item.courseId) ?? []));
  const parsed = kitSchema.safeParse({ ...record, items: courseIds.map(courseId => ({ courseId, isRequired: required.has(courseId) })) });
  const set = (patch: Partial<typeof record>) => setRecord(current => ({ ...current, ...patch }));
  return <form aria-label="Starter kit" onSubmit={event => { event.preventDefault(); if (parsed.success) onSave(parsed.data); }}>
    <label>Name<input disabled={busy} value={record.name} maxLength={160} onChange={event => set({ name: event.target.value })} /></label>
    <label>Description<textarea disabled={busy} value={record.description} maxLength={3000} onChange={event => set({ description: event.target.value })} /></label>
    <CourseList label="Courses (up to 100)" courses={courses} eligible={courses.filter(course => course.status === "published")} chosen={courseIds} busy={busy}
      onChange={setCourseIds} required={{ value: required, onChange: setRequired }} />
    <label className="learning-checkbox"><input type="checkbox" disabled={busy} checked={record.published} onChange={event => set({ published: event.target.checked })} />Published</label>
    <Actions busy={busy} invalid={parsed.success ? "" : describeInvalid(parsed.error)} onCancel={onCancel} />
  </form>;
}
