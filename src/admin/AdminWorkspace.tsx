import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, ArrowRight, BookOpen, Building2, ChevronRight, CircleAlert, Layers3, LoaderCircle, RefreshCw, Search, ShieldCheck, Users, X } from "lucide-react";
import { AdminInventory } from "./AdminInventory";
import { adminInventory, adminInventoryProducts } from "./inventory";
import { readAdminResource } from "./readState";
import type { AdminReadError, AdminReadState } from "./readState";
import type { AdminClient, CareBaseCourseSummary } from "./types";
import "./admin.css";

type WorkspaceView = "overview" | "courses" | "inventory";
const PAGE_SIZE = 20;
const number = new Intl.NumberFormat();

function useAdminRead<T>(reader: (signal: AbortSignal) => Promise<T>): AdminReadState<T> {
  const [entry, setEntry] = useState<{ reader: typeof reader; state: AdminReadState<T> }>(() => ({ reader, state: { status: "loading" } }));
  useEffect(() => {
    const controller = new AbortController();
    void readAdminResource(reader, controller.signal, (state) => setEntry({ reader, state }));
    return () => controller.abort();
  }, [reader]);
  // A changed query/selection must never display the preceding request's data.
  return entry.reader === reader ? entry.state : { status: "loading" };
}

function Loading({ label }: { label: string }) {
  return <div className="admin-read-message" role="status"><LoaderCircle size={20} className="spin" aria-hidden="true" /><div><strong>{label}</strong><p>Requesting current CareBase data.</p></div></div>;
}

function ReadFailure({ error, retry }: { error: AdminReadError; retry: () => void }) {
  return <div className="admin-read-message admin-read-error" role="alert"><CircleAlert size={21} aria-hidden="true" /><div><strong>{error.title}</strong><p>{error.message}</p>{error.retryable && <button className="button button-secondary button-small" type="button" onClick={retry}><RefreshCw size={13} aria-hidden="true" />Retry</button>}</div></div>;
}

function timeLabel(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.valueOf()) ? "Not available" : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function AdminWorkspace({ client }: { client: AdminClient }) {
  const [view, setView] = useState<WorkspaceView>("overview");
  const [refresh, setRefresh] = useState(0);
  const retry = () => setRefresh((value) => value + 1);

  return <div className="admin-workspace">
    <div className="page-heading">
      <div><span className="eyebrow">CareMetric Admin</span><h1>Your apps, in one workspace</h1><p>View current CareBase totals and shared course metadata, use the hub’s support tools, and browse administration functions across your apps.</p></div>
      {view !== "inventory" && <button type="button" className="button button-secondary" onClick={retry}><RefreshCw size={15} aria-hidden="true" />Refresh data</button>}
    </div>
    <nav className="admin-view-nav" aria-label="Administration workspace views">
      <button type="button" className={view === "overview" ? "active" : ""} aria-pressed={view === "overview"} onClick={() => setView("overview")}><Layers3 size={16} aria-hidden="true" />Overview</button>
      <button type="button" className={view === "courses" ? "active" : ""} aria-pressed={view === "courses"} onClick={() => setView("courses")}><BookOpen size={16} aria-hidden="true" />CareBase courses</button>
      <button type="button" className={view === "inventory" ? "active" : ""} aria-pressed={view === "inventory"} onClick={() => setView("inventory")}><Building2 size={16} aria-hidden="true" />All app functions <span>{adminInventory.length}</span></button>
    </nav>
    {view === "overview" && <AdminOverview key={refresh} client={client} retry={retry} openCourses={() => setView("courses")} openInventory={() => setView("inventory")} />}
    {view === "courses" && <CourseCatalog key={refresh} client={client} />}
    {view === "inventory" && <AdminInventory />}
  </div>;
}

function AdminOverview({ client, retry, openCourses, openInventory }: { client: AdminClient; retry: () => void; openCourses: () => void; openInventory: () => void }) {
  const reader = useCallback((signal: AbortSignal) => client.getOverview({ signal }), [client]);
  const state = useAdminRead(reader);
  const overview = state.status === "ready" ? state.data : null;
  const metrics = [
    { label: "CareBase organizations", value: overview?.organizationCount, icon: Building2, color: "teal", note: "All CareBase organizations" },
    { label: "Active CareBase profiles", value: overview?.activeUserCount, icon: Users, color: "blue", note: "Aggregate count only" },
    { label: "Shared CareBase courses", value: overview?.globalCourseCount, icon: BookOpen, color: "violet", note: "Global courses, all publication states" },
  ];

  return <div className="admin-sections">
    <section aria-labelledby="admin-carebase-heading">
      <div className="admin-section-title"><div><h2 id="admin-carebase-heading">CareBase connection</h2><p>Live totals from CareBase. Other apps are not included in these counts.</p></div><span className={`admin-status ${state.status === "ready" ? "admin-status-connected" : "admin-status-muted"}`}>{state.status === "ready" ? "Live read succeeded" : state.status === "loading" ? "Connecting" : "Unavailable"}</span></div>
      <div className="metric-grid admin-metric-grid">{metrics.map(({ label, value, icon: Icon, color, note }) => <div className={`metric-card metric-${color}`} key={label}><div className="metric-icon"><Icon aria-hidden="true" /></div><div><p>{label}</p><strong aria-label={`${label}: ${value === undefined ? (state.status === "loading" ? "loading" : "unavailable") : value}`}>{value === undefined ? "—" : number.format(value)}</strong><small>{value === undefined ? (state.status === "loading" ? "Loading live count" : "Count unavailable") : note}</small></div></div>)}</div>
      {state.status === "loading" && <Loading label="Connecting to CareBase" />}
      {state.status === "error" && <ReadFailure error={state.error} retry={retry} />}
      {state.status === "ready" && <p className="admin-read-time">Last loaded {timeLabel(state.receivedAt)}. Refresh to request current totals.</p>}
    </section>
    <section className="admin-capability-grid" aria-label="Available administration tools">
      <div className="panel admin-capability"><span className="admin-status admin-status-muted">CareBase · read only</span><BookOpen className="admin-capability-icon" aria-hidden="true" /><h2>Shared course catalog</h2><p>Browse live global courses and their lesson outlines from CareBase. Private videos and tenant-specific courses stay in CareBase.</p><button className="text-link" type="button" onClick={openCourses}>Browse CareBase courses <ChevronRight size={14} aria-hidden="true" /></button></div>
      <div className="panel admin-capability"><span className="admin-status admin-status-muted">Available in this hub</span><ShieldCheck className="admin-capability-icon" aria-hidden="true" /><h2>Support and learning</h2><p>Manage support cases, the shared content library, product information, and administrator security.</p><div className="admin-quick-links"><Link to="/cases">Support cases <ChevronRight size={13} aria-hidden="true" /></Link><Link to="/library">Content library <ChevronRight size={13} aria-hidden="true" /></Link><Link to="/products">Products <ChevronRight size={13} aria-hidden="true" /></Link><Link to="/security">Security <ChevronRight size={13} aria-hidden="true" /></Link></div></div>
      <div className="panel admin-capability"><span className="admin-status admin-status-muted">Source inventory</span><Layers3 className="admin-capability-icon" aria-hidden="true" /><h2>Every app’s functions</h2><p>Search {adminInventory.length} audited surfaces across {adminInventoryProducts.length} apps, including billing, course creation, users, operations, and support.</p><button className="text-link" type="button" onClick={openInventory}>Browse all app functions <ChevronRight size={14} aria-hidden="true" /></button></div>
    </section>
    <div className="admin-scope-note"><CircleAlert size={18} aria-hidden="true" /><p><strong>Consolidation in progress.</strong> The CareBase connection currently provides read-only totals and shared course metadata. Billing changes and other app administration actions still require their owning apps.</p></div>
  </div>;
}

function CourseCatalog({ client }: { client: AdminClient }) {
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const retry = () => setRefresh((value) => value + 1);
  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSearch(searchInput.trim());
    setOffset(0);
    setSelectedId(null);
    retry();
  }
  function changePage(nextOffset: number) {
    setOffset(nextOffset);
    setSelectedId(null);
  }

  return <section className="panel admin-course-panel" aria-labelledby="admin-course-heading">
    <div className="panel-heading"><div><h2 id="admin-course-heading">Shared courses in CareBase</h2><p>Current global course metadata · all publication states · read only</p></div><Link className="text-link" to="/library">Hub content library <ChevronRight size={14} aria-hidden="true" /></Link></div>
    <div className="admin-section-body">
      <form className="admin-course-search" onSubmit={submitSearch}><label className="admin-search"><span className="admin-field-label">Search course titles</span><span className="admin-search-input"><Search size={16} aria-hidden="true" /><input type="search" maxLength={100} value={searchInput} onChange={(event) => setSearchInput(event.target.value)} placeholder="Search the CareBase catalog…" /></span></label><button type="submit" className="button button-primary">Search</button></form>
      <div className={`admin-catalog-layout${selectedId ? " has-selection" : ""}`}>
        <CourseList key={`${search}:${offset}:${refresh}`} client={client} search={search} offset={offset} selectedId={selectedId} selectCourse={setSelectedId} changePage={changePage} retry={retry} />
        {selectedId && <CourseDetail key={`${selectedId}:${refresh}`} client={client} courseId={selectedId} close={() => setSelectedId(null)} retry={retry} />}
      </div>
    </div>
  </section>;
}

function CourseList({ client, search, offset, selectedId, selectCourse, changePage, retry }: { client: AdminClient; search: string; offset: number; selectedId: string | null; selectCourse: (id: string) => void; changePage: (offset: number) => void; retry: () => void }) {
  const reader = useCallback((signal: AbortSignal) => client.listCourses({ search: search || undefined, offset, limit: PAGE_SIZE, signal }), [client, search, offset]);
  const state = useAdminRead(reader);
  if (state.status === "loading") return <Loading label="Loading shared courses" />;
  if (state.status === "error") return <ReadFailure error={state.error} retry={retry} />;
  const { items, total, limit } = state.data;
  const nextOffset = offset + limit;

  return <div className="admin-course-list">
    <div className="admin-course-list-heading"><p role="status">{number.format(total)} {total === 1 ? "course" : "courses"}{search ? ` matching “${search}”` : " in the shared catalog"}</p><span>Loaded {timeLabel(state.receivedAt)}</span></div>
    {items.length === 0 ? <div className="empty-state"><BookOpen aria-hidden="true" /><strong>{offset > 0 ? "No courses on this page" : search ? "No matching shared courses" : "No shared courses returned"}</strong><p>{offset > 0 ? "Return to the previous page or refresh the catalog." : search ? "Try another course title." : "CareBase returned an empty global catalog."}</p></div> : <ul>{items.map((course) => <li key={course.id}><button className={selectedId === course.id ? "selected" : ""} type="button" aria-pressed={selectedId === course.id} onClick={() => selectCourse(course.id)}><span className="admin-course-list-icon"><BookOpen size={18} aria-hidden="true" /></span><span className="admin-course-list-copy"><strong>{course.title}</strong><span>{course.category || "Uncategorized"} · {course.estimatedDurationMinutes === null ? "Duration not set" : `${course.estimatedDurationMinutes} min`}</span></span><span className="admin-course-status">{course.status}</span><ChevronRight size={17} aria-hidden="true" /></button></li>)}</ul>}
    <div className="admin-pagination"><span>{items.length > 0 ? `${number.format(offset + 1)}–${number.format(offset + items.length)} of ${number.format(total)}` : "0 shown"}</span><div><button type="button" className="button button-secondary button-small" disabled={offset === 0} onClick={() => changePage(Math.max(0, offset - limit))}><ArrowLeft size={13} aria-hidden="true" />Previous</button><button type="button" className="button button-secondary button-small" disabled={nextOffset >= total || nextOffset > 10000} onClick={() => changePage(nextOffset)}>Next <ArrowRight size={13} aria-hidden="true" /></button></div></div>
    {nextOffset > 10000 && nextOffset < total && <p className="admin-explanation">Refine the title search to browse more results.</p>}
  </div>;
}

function CourseDetail({ client, courseId, close, retry }: { client: AdminClient; courseId: string; close: () => void; retry: () => void }) {
  const reader = useCallback((signal: AbortSignal) => client.getCourse({ courseId, signal }), [client, courseId]);
  const state = useAdminRead(reader);

  return <aside className="admin-course-detail" aria-labelledby="admin-course-detail-heading"><div className="admin-detail-heading"><h3 id="admin-course-detail-heading">Course details</h3><button type="button" className="icon-button" aria-label="Close course details" onClick={close}><X size={16} aria-hidden="true" /></button></div>
    {state.status === "loading" && <Loading label="Loading course details" />}
    {state.status === "error" && <ReadFailure error={state.error} retry={retry} />}
    {state.status === "ready" && <div className="admin-detail-body"><CourseMetadata course={state.data.course} /><h3 className="admin-outline-heading">Lesson outline <span>{state.data.lessons.length}{state.data.lessonsTruncated ? "+" : ""}</span></h3>{state.data.lessons.length > 0 ? <ol className="admin-lesson-list">{state.data.lessons.map((lesson) => <li key={lesson.id}><strong>{lesson.title || "Untitled lesson"}</strong><span>{lesson.type.replaceAll("_", " ")}</span></li>)}</ol> : <p className="admin-explanation">No lesson outline was returned for this course’s current version.</p>}{state.data.lessonsTruncated && <p className="admin-explanation">Showing the first {state.data.lessons.length} lessons. The remaining outline is available in CareBase.</p>}<p className="admin-private-note">This view contains metadata and lesson titles. Course bodies, assessments, and private media are not included.</p></div>}
  </aside>;
}

function CourseMetadata({ course }: { course: CareBaseCourseSummary }) {
  return <><span className="admin-course-status">{course.status}</span><h2 className="admin-detail-title">{course.title}</h2>{course.description && <p className="admin-course-description">{course.description}</p>}<dl className="admin-course-metadata"><div><dt>Category</dt><dd>{course.category || "Uncategorized"}</dd></div><div><dt>Estimated duration</dt><dd>{course.estimatedDurationMinutes === null ? "Not set" : `${course.estimatedDurationMinutes} minutes`}</dd></div><div><dt>Updated in CareBase</dt><dd>{timeLabel(course.updatedAt)}</dd></div><div><dt>Scope</dt><dd>Global shared course</dd></div></dl></>;
}
