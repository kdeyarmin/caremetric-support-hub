import { useCallback, useEffect, useRef, useState } from "react";
import { requestAdmin } from "../admin/transport";
import type { AdminClient, CareBaseCourseSummary } from "../admin/types";
import { catalogOperationSchema, projectCatalogResult, type CatalogPage, type CatalogSave, type CatalogSection, type StoredCollection, type StoredKit,
  type StoredLesson, type StoredMetadata } from "./catalogProtocol";
import { CollectionForm, KitForm, LessonForm, MetadataForm } from "./TrainingLibraryForms";

type Stored = StoredCollection | StoredLesson | StoredMetadata | StoredKit;
const tabs: { section: CatalogSection; name: string; noun: string }[] = [
  { section: "collections", name: "Elective collections", noun: "collection" }, { section: "lessons", name: "Refresher lessons", noun: "lesson" },
  { section: "metadata", name: "Discovery metadata", noun: "course details" }, { section: "starterKits", name: "Starter kits", noun: "starter kit" }];
const MAX_PAGES = 50;
async function run(operation: unknown, signal: AbortSignal) {
  const op = catalogOperationSchema.parse(operation);
  return projectCatalogResult(await requestAdmin("learning-catalog", op, signal), op);
}
const failure = (caught: unknown) => {
  const code = caught && typeof caught === "object" && "code" in caught ? caught.code : "upstream";
  return code === "invalid_request" ? "CareBase refused this record. Check each field, and that every course is an eligible global course." :
    code === "conflict" ? "This record changed, a course is no longer eligible, or the save conflicts with an earlier one. The tab was reloaded: review the record and save again." :
    code === "401" || code === "403" ? "A current administrator session in the Hub and CareBase is required." :
    "The request did not finish, or the training library is not switched on in CareBase. Retry the same save: CareBase returns its first result instead of saving twice.";
};

/** Global courses for the pickers, with titles. CareBase checks each course's eligibility again on every save. */
function useCourses(client: AdminClient) {
  const [courses, setCourses] = useState<CareBaseCourseSummary[] | null>(null); const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      const items: CareBaseCourseSummary[] = [];
      for (let offset = 0; offset <= 10_000; offset += 50) {
        const page = await client.listCourses({ offset, limit: 50, signal: controller.signal });
        items.push(...page.items); if (page.items.length === 0 || offset + page.limit >= page.total) break;
      }
      setCourses(items.sort((a, b) => a.title.localeCompare(b.title)));
    })().catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [client]);
  return { courses, failed };
}

export function TrainingLibrary({ client }: { client: AdminClient }) {
  const [section, setSection] = useState<CatalogSection>("collections");
  const { courses, failed } = useCourses(client);
  return <section className="panel admin-course-panel" aria-labelledby="training-library-heading">
    <div className="panel-heading"><div><h2 id="training-library-heading">Training library</h2>
      <p>Elective collections, refresher lessons, course discovery details and starter kits that CareBase offers every organization</p></div></div>
    <div className="admin-section-body">
      <nav className="admin-view-nav" aria-label="Training library sections">{tabs.map(tab => <button key={tab.section} type="button" className={section === tab.section ? "active" : ""}
        aria-pressed={section === tab.section} onClick={() => setSection(tab.section)}>{tab.name}</button>)}</nav>
      {failed && <p role="alert">The course list did not load. Course pickers are unavailable until you reload this page.</p>}
      {!courses && !failed && <p role="status">Loading courses…</p>}
      {courses && <LibrarySection key={section} section={section} courses={courses} />}
    </div>
  </section>;
}

function LibrarySection({ section, courses }: { section: CatalogSection; courses: CareBaseCourseSummary[] }) {
  const tab = tabs.find(value => value.section === section)!;
  const [items, setItems] = useState<Stored[] | null>(null);
  const [editing, setEditing] = useState<Stored | "new" | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [message, setMessage] = useState("");
  const intents = useRef(new Map<string, string>());
  const courseTitle = (id: string | null) => id ? courses.find(course => course.id.toLowerCase() === id.toLowerCase())?.title ?? id : "No linked course";
  const load = useCallback(async (signal: AbortSignal) => {
    const all: Stored[] = []; let after: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const value = await run({ operation: "catalog.read", section, after }, signal) as CatalogPage;
      all.push(...value.items as Stored[]); after = value.nextAfter; if (after === null) break;
    }
    if (after !== null) throw new Error("Training library section is too large to show");
    return all;
  }, [section]);
  const reload = useCallback(async () => { setItems(null); setItems(await load(new AbortController().signal)); }, [load]);
  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal).then(setItems).catch(caught => { if (!controller.signal.aborted) setError(failure(caught)); });
    return () => controller.abort();
  }, [load]);
  async function save(record: object) {
    const key = section === "collections" ? "collection" : section === "lessons" ? "lesson" : section === "metadata" ? "metadata" : "kit";
    const operation = section === "lessons" ? "refreshers.save" : `${section}.save`;
    // One request ID per exact record: a retry after a timeout returns CareBase's first result.
    const intent = JSON.stringify({ operation, [key]: record });
    let requestId = intents.current.get(intent);
    if (!requestId) { requestId = crypto.randomUUID(); intents.current.set(intent, requestId); }
    setBusy(true); setError(""); setMessage("");
    try {
      await run({ operation, requestId, [key]: record } as CatalogSave, new AbortController().signal);
      intents.current.delete(intent); setEditing(null); setMessage(`Saved the ${tab.noun}.`); await reload();
    } catch (caught) {
      setError(failure(caught));
      if (caught && typeof caught === "object" && "code" in caught && caught.code === "conflict") { intents.current.clear(); setEditing(null); await reload().catch(() => {}); }
    } finally { setBusy(false); }
  }
  const sorted = items && [...items].sort((a, b) => label(a).localeCompare(label(b)));
  function label(item: Stored) { return "name" in item ? item.name : "title" in item ? item.title : courseTitle(item.courseId); }
  const form = editing && (() => {
    const initial = editing === "new" ? null : editing, common = { courses, busy, onSave: (record: object) => void save(record), onCancel: () => setEditing(null) };
    if (section === "collections") return <CollectionForm initial={initial as StoredCollection | null} {...common} />;
    if (section === "lessons") return <LessonForm initial={initial as StoredLesson | null} {...common} />;
    if (section === "metadata") return <MetadataForm initial={initial as StoredMetadata | null} existing={(items ?? []) as StoredMetadata[]} {...common} />;
    return <KitForm initial={initial as StoredKit | null} {...common} />;
  })();
  return <div aria-label={tab.name}>
    {error && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}
    {section === "collections" && <p>A published collection needs at least one course. To withdraw a collection, unpublish it; nothing is deleted.</p>}
    {section === "metadata" && <p>Discovery details apply to global courses only.</p>}
    {section === "starterKits" && <p>A published starter kit needs at least one course. If someone else saved the kit since you opened it, reload and edit it again.</p>}
    {!editing && <button type="button" className="button button-secondary" disabled={busy || !items} onClick={() => { setMessage(""); setEditing("new"); }}>
      {section === "metadata" ? "Edit a course’s details" : `New ${tab.noun}`}</button>}
    {form}
    {!items && !error && <p role="status">Loading {tab.name.toLowerCase()}…</p>}
    {sorted && !editing && (sorted.length === 0 ? <p>No {tab.name.toLowerCase()} yet.</p> : <ul className="admin-record-list">{sorted.map(item => {
      const key = "id" in item ? item.id : item.courseId;
      return <li key={key}><strong>{label(item)}</strong>{"published" in item && <span> · {item.published ? "Published" : "Not published"}</span>}
        {"courseIds" in item && <span> · {item.courseIds.length} courses</span>}{"items" in item && <span> · {item.items.length} courses · revision {item.revision}</span>}
        {"choices" in item && <span> · {courseTitle(item.courseId)} · {item.minutes} minutes · revision {item.revision}</span>}
        {"language" in item && <span> · {item.language ?? "No language"} · {item.creditStatement ? "Credit statement" : "No credit statement"}</span>}
        <button type="button" className="button button-secondary button-small" disabled={busy} onClick={() => { setMessage(""); setEditing(item); }}>Edit</button></li>;
    })}</ul>)}
  </div>;
}
