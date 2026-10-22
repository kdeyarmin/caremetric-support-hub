import { useCallback, useState } from "react";
import type { FormEvent } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, ArrowRight, BookOpen, ChevronRight, Search, X } from "lucide-react";
import { Loading, ReadFailure } from "./AdminReads";
import { timeLabel } from "./readState";
import { useAdminRead } from "./useAdminRead";
import type { AdminClient, CareBaseCourseSummary } from "./types";
import { AuthoringPanel } from "../learning/AuthoringPanel";
import { CourseCreationPanel } from "../learning/CourseCreationPanel";
import { AiCourseDraftPanel } from "../learning/GenerationPanels";

const PAGE_SIZE = 20;
const number = new Intl.NumberFormat();

export function CourseCatalog({ client }: { client: AdminClient }) {
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
    <div className="panel-heading"><div><h2 id="admin-course-heading">Shared courses in CareBase</h2><p>Global courses · all publication states · governed version controls</p></div><Link className="text-link" to="/library">Hub content library <ChevronRight size={14} aria-hidden="true" /></Link></div>
    <div className="admin-section-body">
      <CourseCreationPanel onOpen={courseId => { setSelectedId(courseId); retry(); }} />
      <AiCourseDraftPanel onOpen={courseId => { setSelectedId(courseId); retry(); }} />
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
    {state.status === "ready" && <AuthoringPanel key={courseId} courseId={courseId} />}
  </aside>;
}

function CourseMetadata({ course }: { course: CareBaseCourseSummary }) {
  return <><span className="admin-course-status">{course.status}</span><h2 className="admin-detail-title">{course.title}</h2>{course.description && <p className="admin-course-description">{course.description}</p>}<dl className="admin-course-metadata"><div><dt>Category</dt><dd>{course.category || "Uncategorized"}</dd></div><div><dt>Estimated duration</dt><dd>{course.estimatedDurationMinutes === null ? "Not set" : `${course.estimatedDurationMinutes} minutes`}</dd></div><div><dt>Updated in CareBase</dt><dd>{timeLabel(course.updatedAt)}</dd></div><div><dt>Scope</dt><dd>Global shared course</dd></div></dl></>;
}
