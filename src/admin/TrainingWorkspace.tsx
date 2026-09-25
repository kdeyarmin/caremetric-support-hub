import { useCallback, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { AdminOrganization } from "../../supabase/functions/_shared/portfolioProtocol";
import type { TrainingAction, TrainingCommand, TrainingCommandResult, TrainingCourse, TrainingFacility, TrainingPage, TrainingStudent, TrainingTerm } from "../../supabase/functions/_shared/trainingProtocol";
import { parseTrainingOperation, trainingModules } from "../../supabase/functions/_shared/trainingProtocol";
import { portfolioClient, type PortfolioClient } from "./portfolioClient";
import { trainingClient, type TrainingClient } from "./trainingClient";
import { Loading, ReadFailure } from "./AdminReads";
import { useAdminRead } from "./useAdminRead";
import { PagedRecords } from "./PagedRecords";
import { TrainingCommandReview, type TrainingIntent } from "./TrainingCommandReview";
import { TrainingReports } from "./TrainingReports";
import { trainingDate, trainingLocalDateTime, type TrainingReportRow, type TrainingReportPage } from "./trainingPresentation";
import { loadTrainingIntent } from "./trainingRecovery";
import "./training.css";

type Editor = { draft?: TrainingCommand; action: TrainingAction; student?: TrainingStudent; enrollment?: TrainingReportRow; term?: TrainingTerm };
const moduleNames = { "modules.train": "Facility training", "modules.workforce": "Workforce", "modules.compliance": "Compliance", "modules.billing": "Billing", "modules.carebase": "Full CareBase suite" };
const actionNames: Record<TrainingAction, string> = {
  "facilities.provision": "Create training facility", "students.create": "Add student", "students.update": "Edit student",
  "students.setActive": "Change student status", "invitations.create": "Invite administrator or student",
  "enrollments.assign": "Assign course", "enrollments.cancel": "Cancel enrollment", "access.grant": "Grant module access", "access.revoke": "Revoke module term",
};
const dateToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const uuid = (value: string | null) => value && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? value : "";

export function TrainingWorkspace({ actorId, portfolio = portfolioClient, client = trainingClient }: { actorId: string; portfolio?: PortfolioClient; client?: TrainingClient }) {
  const [recovery] = useState(() => { try { return { intent: loadTrainingIntent(actorId), error: false }; } catch { return { intent: null, error: true }; } });
  const [recovered, setRecovered] = useState(!!recovery.intent);
  const [params, setParams] = useSearchParams();
  const organizationId = uuid(params.get("organizationId"));
  const facilityId = uuid(params.get("facilityId"));
  const [organization, setOrganization] = useState<AdminOrganization | null>(null);
  const [facility, setFacility] = useState<TrainingFacility | null>(null);
  const [editor, setEditor] = useState<Editor | null>(recovery.intent ? { action: recovery.intent.command.action, draft: recovery.intent.command } : null), [intent, setIntent] = useState<TrainingIntent | null>(recovery.intent);
  const [revision, setRevision] = useState(0), [notice, setNotice] = useState("");
  const [noticeKind, setNoticeKind] = useState<"success" | "warning">("success");
  const scopeReader = useCallback(async (signal: AbortSignal) => {
    void revision;
    if (!organizationId) return { organization_name: "", facility_name: null };
    return await client.request({ domain: "training.v1", operation: "enrollments.report", organizationId, facilityId: facilityId || null, courseSearch: "", status: "all", dateBasis: "assigned", dateFrom: null, dateThrough: null, limit: 1, offset: 0 }, signal) as TrainingReportPage;
  }, [client, organizationId, facilityId, revision]);
  const scope = useAdminRead(scopeReader);
  const organizationName = scope.status === "ready" && scope.data.organization_name || (organization?.id === organizationId ? organization.name || organization.slug || "Selected organization" : "Selected organization");
  const facilityName = scope.status === "ready" && scope.data.facility_name || (facility?.id === facilityId ? facility.name : "Selected facility");
  const selectOrganization = (item: AdminOrganization) => {
    setOrganization(item); setFacility(null); setNotice("");
    setParams(previous => { const next = new URLSearchParams(previous); next.set("organizationId", item.id); next.delete("facilityId"); return next; });
  };
  const selectFacility = (item: TrainingFacility | null) => {
    setFacility(item); setNotice("");
    setParams(previous => { const next = new URLSearchParams(previous); if (item) next.set("facilityId", item.id); else next.delete("facilityId"); return next; });
  };
  const edit = (value: Editor) => { setNotice(""); setIntent(null); setEditor(value); };
  const applied = (response: Awaited<ReturnType<TrainingClient["request"]>>) => {
    const result = response as TrainingCommandResult;
    setNoticeKind("success");
    if (result.action === "facilities.provision" && typeof result.result.facilityId === "string") {
      const names = intent?.command.action === "facilities.provision" ? intent.command.parameters : null;
      setOrganization({ id: result.organizationId, name: names?.organizationName || "New organization", slug: null, status: "active", createdAt: null });
      setFacility({ id: result.result.facilityId, name: names?.facilityName || "New facility", facilityType: names?.facilityType || "PCH", isActive: true });
      setParams(previous => { const next = new URLSearchParams(previous); next.set("organizationId", result.organizationId); next.set("facilityId", String(result.result.facilityId)); return next; });
      setNotice("Training facility created. Next, invite its administrator and add students below.");
    } else if (result.action === "invitations.create" && result.result.deliveryStatus === "failed") {
      setNoticeKind("warning");
      setNotice("Invitation was not delivered. This request is complete and will not resend. Check the recipient's existing account, email and invitation configuration before starting a new reviewed invitation. You can continue managing training below.");
    } else if (result.action === "invitations.create") setNotice(`Invitation recorded. Delivery status: ${String(result.result.deliveryStatus)}. The recipient completes their own account setup.`);
    else if (result.action === "students.create") setNotice("Student added. Invite the student to their account, then assign a course.");
    else if (result.action === "enrollments.assign") setNotice(result.result.alreadyAssigned ? "The student is already enrolled in this course." : "Course assigned. Follow the student's progress in Enrollment & reports.");
    else setNotice(`${actionNames[result.action]} recorded${result.replayed ? " (previously completed request)" : ""}.`);
    setIntent(null); setEditor(null); setRecovered(false); setRevision(value => value + 1);
  };
  const readOrganizations = useCallback((search: string, offset: number, signal: AbortSignal) => portfolio.organizations({ product: "carebase", search: search || undefined, limit: 20, offset, signal }), [portfolio]);
  return <div className="training-workspace">
    <div className="training-heading"><div><h2>CareMetric CareBase · Facility training</h2><p>Set up training access, enroll facility staff, follow progress and print results here in the Hub.</p></div><button className="button button-primary" disabled={!!editor || recovery.error} onClick={() => edit({ action: "facilities.provision" })}>New training facility</button></div>
    {notice && <p className={`training-notice${noticeKind === "warning" ? " training-notice-warning" : ""}`} role={noticeKind === "warning" ? "alert" : "status"}>{notice}</p>}
    {recovery.error && <p role="alert">An unfinished training request could not be recovered from this browser tab. Restore session storage or contact Hub support before creating another change. No new training changes will be sent.</p>}
    {editor && (intent ? <TrainingCommandReview intent={intent} client={client} actorId={actorId} recovered={recovered} onClose={() => setIntent(null)} onApplied={applied} /> : <TrainingEditor key={`${editor.action}:${editor.student?.id || editor.enrollment?.id || editor.term?.id || "new"}`} client={client} editor={editor} organizationId={organizationId || null} facilityId={facilityId || null} organizationName={organizationName} facilityName={facilityName} onReview={value => { setEditor({ ...editor, draft: value.command }); setIntent(value); }} close={() => setEditor(null)} />)}
    <fieldset className="training-workspace-content" disabled={!!editor || recovery.error}>
      <details open={!organizationId} className="training-organization-picker"><summary>{organizationId ? `Change organization · ${organizationName}` : "Choose an existing organization"}</summary>
        <PagedRecords<AdminOrganization> key={`organizations:${revision}`} app="CareBase" title="Training organizations" searchLabel="Search training organizations" columns={["Organization", "Status", "Training"]} read={readOrganizations} render={item => <><td>{item.name || item.slug || "Unnamed organization"}</td><td>{item.status}</td><td><button className="button button-secondary button-small" onClick={() => selectOrganization(item)}>Manage {item.name || item.slug || "organization"}</button></td></>} />
      </details>
      {!organizationId ? <section className="panel training-start"><h3>Start a facility in three steps</h3><ol><li>Create a training facility or select an existing organization.</li><li>Invite its administrator, add students and assign courses.</li><li>Review enrollment, completion and issued certificates; export or print reports.</li></ol><p>New training facilities receive access to the training module. Additional modules require their own access terms.</p></section> : scope.status === "loading" ? <Loading label="Verifying selected training organization and facility" /> : scope.status === "error" ? <ReadFailure error={scope.error} retry={() => setRevision(value => value + 1)} /> : <OrganizationTraining key={`${organizationId}:${revision}`} client={client} organizationId={organizationId} organizationName={organizationName} facilityId={facilityId || null} facilityName={facilityName} selectFacility={selectFacility} edit={edit} />}
    </fieldset>
  </div>;
}

function OrganizationTraining({ client, organizationId, organizationName, facilityId, facilityName, selectFacility, edit }: {
  client: TrainingClient; organizationId: string; organizationName: string; facilityId: string | null; facilityName: string;
  selectFacility: (facility: TrainingFacility | null) => void; edit: (value: Editor) => void;
}) {
  const [search, setSearch] = useState(""), [filter, setFilter] = useState(""), [offset, setOffset] = useState(0), [revision, setRevision] = useState(0);
  const [params, setParams] = useSearchParams();
  const requestedTab = params.get("trainingTab");
  const tab = requestedTab && ["reports", "certificates", "access"].includes(requestedTab) ? requestedTab : "students";
  const setTab = (value: string) => setParams(previous => { const next = new URLSearchParams(previous); next.set("trainingTab", value); return next; });
  const reader = useCallback(async (signal: AbortSignal) => {
    void revision;
    return await client.request({ domain: "training.v1", operation: "facilities.list", organizationId, search: filter, limit: 20, offset }, signal) as TrainingPage<TrainingFacility>;
  }, [client, organizationId, filter, offset, revision]);
  const state = useAdminRead(reader);
  return <section className="training-organization">
    <div className="training-heading"><h3>{organizationName}</h3><button className="button button-secondary" onClick={() => edit({ action: "invitations.create" })}>Invite facility administrator</button></div>
    <form className="training-facility-picker" onSubmit={event => { event.preventDefault(); setFilter(search.trim()); setOffset(0); }}>
      <label>Find a facility<input type="search" maxLength={100} value={search} onChange={event => setSearch(event.target.value)} /></label><button className="button button-secondary">Search facilities</button>
    </form>
    {state.status === "loading" && <Loading label="Loading facilities" />}
    {state.status === "error" && <ReadFailure error={state.error} retry={() => setRevision(value => value + 1)} />}
    {state.status === "ready" && <><label className="training-facility-choice">Training facility<select value={facilityId || ""} onChange={event => selectFacility(state.data.items.find(item => item.id === event.target.value) || null)}>
      <option value="">All facilities · reporting only</option>{facilityId && !state.data.items.some(item => item.id === facilityId) && <option value={facilityId}>{facilityName}</option>}
      {state.data.items.map(item => <option key={item.id} value={item.id}>{item.name} · {item.facilityType === "ALR" ? "ALF" : "PCH"}{item.isActive ? "" : " · inactive"}</option>)}</select></label>
      <div className="admin-pagination"><span>{state.data.total} facilities</span><div><button className="button button-secondary button-small" disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 20))}>Previous facilities</button><button className="button button-secondary button-small" disabled={offset + 20 >= state.data.total} onClick={() => setOffset(offset + 20)}>Next facilities</button></div></div>
    </>}
    <nav className="admin-view-nav" aria-label="Facility training sections">{([["students", "Students & enrollment"], ["reports", "Enrollment & reports"], ["certificates", "Certificates"], ["access", "Module access"]] as const).map(([id, label]) => <button key={id} type="button" aria-pressed={tab === id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}>{label}</button>)}</nav>
    {tab === "students" && (facilityId ? <Students key={facilityId} client={client} organizationId={organizationId} facilityId={facilityId} edit={edit} /> : <p>Choose a facility above to add, invite or enroll students. Reports can cover every facility in this organization.</p>)}
    {(tab === "reports" || tab === "certificates") && <TrainingReports key={`${facilityId || "all"}:${tab}`} client={client} organizationId={organizationId} facilityId={facilityId} certificatesOnly={tab === "certificates"} onCancel={enrollment => edit({ action: "enrollments.cancel", enrollment })} />}
    {tab === "access" && <ModuleAccess client={client} organizationId={organizationId} edit={edit} />}
  </section>;
}

function Students({ client, organizationId, facilityId, edit }: { client: TrainingClient; organizationId: string; facilityId: string; edit: (value: Editor) => void }) {
  const [status, setStatus] = useState<"all" | "active" | "inactive">("all");
  const read = useCallback(async (search: string, offset: number, signal: AbortSignal) => await client.request({ domain: "training.v1", operation: "students.list", organizationId, facilityId, search, status, offset, limit: 20 }, signal) as TrainingPage<TrainingStudent>, [client, organizationId, facilityId, status]);
  return <section>
    <div className="training-actions"><button className="button button-primary" onClick={() => edit({ action: "students.create" })}>Add student</button><label>Student status<select value={status} onChange={event => setStatus(event.target.value as typeof status)}><option value="all">All students</option><option value="active">Active students</option><option value="inactive">Inactive students</option></select></label></div>
    <p className="admin-explanation">Add the student, send their account invitation, then assign a course. Existing progress and certificates are retained when a student becomes inactive.</p>
    <PagedRecords<TrainingStudent> key={status} app="CareBase" title="Facility students" searchLabel="Search students" columns={["Student", "Email", "Position", "Status", "Account access", "Manage"]} read={read} render={student => <>
      <td>{student.firstName} {student.lastName}<small>Hired {trainingDate(student.hireDate)}</small></td><td>{student.email || "No email recorded"}</td><td>{student.jobTitle}</td><td>{student.status.replaceAll("_", " ")}</td><td>{student.profileId ? "Account linked" : "No account linked"}</td>
      <td><div className="training-row-actions"><button className="button button-secondary button-small" onClick={() => edit({ action: "students.update", student })}>Edit student</button><button className="button button-secondary button-small" disabled={!student.isActive || !student.email || !!student.profileId} onClick={() => edit({ action: "invitations.create", student })}>Invite student</button><button className="button button-secondary button-small" disabled={!student.isActive} onClick={() => edit({ action: "enrollments.assign", student })}>Assign course</button><button className="button button-secondary button-small" onClick={() => edit({ action: "students.setActive", student })}>{student.isActive ? "Deactivate student" : "Reactivate student"}</button></div></td>
    </>} />
  </section>;
}

function ModuleAccess({ client, organizationId, edit }: { client: TrainingClient; organizationId: string; edit: (value: Editor) => void }) {
  const [revision, setRevision] = useState(0);
  const [offset, setOffset] = useState(0);
  const [now] = useState(Date.now);
  const [params] = useSearchParams();
  const billingParams = new URLSearchParams(params); billingParams.set("view", "billing");
  const reader = useCallback(async (signal: AbortSignal) => { void revision; return await client.request({ domain: "training.v1", operation: "access.list", organizationId, limit: 20, offset }, signal) as TrainingPage<TrainingTerm>; }, [client, organizationId, offset, revision]);
  const state = useAdminRead(reader);
  return <section className="panel training-access"><div className="panel-heading"><h3>Module access terms</h3><button className="button button-primary" onClick={() => edit({ action: "access.grant" })}>Grant module access</button></div><div className="admin-section-body">
    <p>Grant complimentary training or record an agreed contract. Each additional module requires a separate term. These terms control application access; they do not create a charge or modify a payment subscription. Use the <Link to={`?${billingParams}`}>Hub Billing workspace</Link> for checkout and subscription management.</p>
    {state.status === "loading" && <Loading label="Loading module access" />}{state.status === "error" && <ReadFailure error={state.error} retry={() => setRevision(value => value + 1)} />}
    {state.status === "ready" && <><div className="portfolio-table-wrap"><table><thead><tr><th>Module</th><th>Basis</th><th>Starts</th><th>Ends</th><th>Status</th><th>Reason</th><th>Action</th></tr></thead><tbody>{state.data.items.map(term => <tr key={term.id}><td>{moduleNames[term.moduleKey]}</td><td>{term.source}</td><td>{trainingDate(term.startsAt)}</td><td>{term.endsAt ? trainingDate(term.endsAt) : "No expiration"}</td><td>{term.revokedAt ? "Revoked" : term.endsAt && Date.parse(term.endsAt) <= now ? "Expired" : "Active term"}</td><td>{term.reason}</td><td>{!term.revokedAt && <button className="button button-secondary button-small" onClick={() => edit({ action: "access.revoke", term })}>Revoke term</button>}</td></tr>)}</tbody></table></div>{!state.data.items.length && <p>No module access terms were returned.</p>}</>}
    {state.status === "ready" && <div className="admin-pagination"><span>{state.data.items.length} of {state.data.total} access terms</span><div><button className="button button-secondary button-small" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 20))}>Previous access terms</button><button className="button button-secondary button-small" disabled={offset + 20 >= state.data.total} onClick={() => setOffset(offset + 20)}>Next access terms</button></div></div>}
  </div></section>;
}

function TrainingEditor({ client, editor, organizationId, facilityId, organizationName, facilityName, onReview, close }: {
  client: TrainingClient; editor: Editor; organizationId: string | null; facilityId: string | null;
  organizationName: string; facilityName: string; onReview: (intent: TrainingIntent) => void; close: () => void;
}) {
  const [error, setError] = useState("");
  const [courseRevision, setCourseRevision] = useState(0);
  const initial = editor.draft?.parameters as Record<string, string | boolean | null> | undefined;
  const initialValue = (name: string, fallback = "") => typeof initial?.[name] === "string" ? initial[name] as string : fallback;
  const [courseSearch, setCourseSearch] = useState(""), [courseFilter, setCourseFilter] = useState(""), [courseOffset, setCourseOffset] = useState(0), [courseId, setCourseId] = useState(initialValue("courseId"));
  const courseReader = useCallback(async (signal: AbortSignal) => { void courseRevision; return editor.action === "enrollments.assign" && organizationId ? await client.request({ domain: "training.v1", operation: "courses.list", organizationId, search: courseFilter, limit: 20, offset: courseOffset }, signal) as TrainingPage<TrainingCourse> : { items: [], total: 0, limit: 20, offset: 0 }; }, [client, editor.action, organizationId, courseFilter, courseOffset, courseRevision]);
  const courses = useAdminRead(courseReader);
  const student = editor.student;
  const selectedCourse = courses.status === "ready" ? courses.data.items.find(item => item.id === courseId) : undefined;
  const studentFields = ["students.create", "students.update", "invitations.create"].includes(editor.action);
  const title = editor.action === "invitations.create" ? student ? "Invite student" : "Invite facility administrator" : actionNames[editor.action];
  function review(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError("");
    const form = new FormData(event.currentTarget), value = (name: string) => String(form.get(name) || "").trim();
    const common = { domain: "training.v1" as const, operation: "apply" as const, organizationId, requestId: crypto.randomUUID(), reason: value("reason") };
    let command: TrainingCommand;
    const details: Array<[string, string]> = editor.action === "facilities.provision" ? [] : [["Organization", organizationName]];
    if (facilityId && editor.action !== "access.grant" && editor.action !== "access.revoke") details.push(["Facility", facilityName]);
    if (student) details.push(["Student", `${student.firstName} ${student.lastName}`]);
    try {
      switch (editor.action) {
        case "facilities.provision": command = { ...common, action: editor.action, organizationId: null, parameters: { organizationName: value("organizationName"), facilityName: value("facilityName"), facilityType: value("facilityType") as "PCH" | "ALR" } }; details.push(["Organization", command.parameters.organizationName], ["Facility", command.parameters.facilityName], ["Facility type", command.parameters.facilityType === "ALR" ? "ALF" : "PCH"], ["Included access", "Training module"]); break;
        case "students.create": if (!facilityId) return; command = { ...common, action: editor.action, parameters: { facilityId, firstName: value("firstName"), lastName: value("lastName"), email: value("email") || null, jobTitle: value("jobTitle"), hireDate: value("hireDate") } }; details.push(["Student", `${value("firstName")} ${value("lastName")}`], ["Email", value("email") || "None"], ["Position", value("jobTitle")], ["Hire date", value("hireDate")]); break;
        case "students.update": if (!student) return; command = { ...common, action: editor.action, parameters: { employeeId: student.id, firstName: value("firstName"), lastName: value("lastName"), email: value("email") || null, jobTitle: value("jobTitle") } }; details.push(["Updated name", `${value("firstName")} ${value("lastName")}`], ["Updated email", value("email") || "None"], ["Updated position", value("jobTitle")]); break;
        case "students.setActive": if (!student) return; command = { ...common, action: editor.action, parameters: { employeeId: student.id, active: !student.isActive, effectiveDate: value("effectiveDate") } }; details.push(["New status", student.isActive ? "Inactive" : "Active"], ["Effective date", value("effectiveDate")]); break;
        case "invitations.create": command = { ...common, action: editor.action, parameters: { role: student ? "employee" : "org_admin", employeeId: student?.id || null, facilityId: student ? facilityId : null, firstName: value("firstName"), lastName: value("lastName"), email: value("email") } }; details.push(["Invitee", `${value("firstName")} ${value("lastName")}`], ["Invitation email", value("email")], ["Role", student ? "Student" : "Organization administrator"]); break;
        case "enrollments.assign": if (!student || !selectedCourse?.versionId) return; command = { ...common, action: editor.action, parameters: { employeeId: student.id, courseId: selectedCourse.id, versionId: selectedCourse.versionId, dueDate: value("dueDate") || null } }; details.push(["Course", selectedCourse.title], ["Due date", value("dueDate") || "No due date"]); break;
        case "enrollments.cancel": if (!editor.enrollment) return; command = { ...common, action: editor.action, parameters: { assignmentId: editor.enrollment.id } }; details.push(["Student", editor.enrollment.student], ["Course", editor.enrollment.course], ["Current status", editor.enrollment.status]); break;
        case "access.grant": command = { ...common, action: editor.action, parameters: { moduleKey: value("moduleKey") as TrainingTerm["moduleKey"], source: value("source") as TrainingTerm["source"], endsAt: value("endsAt") ? new Date(value("endsAt")).toISOString() : null } }; details.push(["Module", moduleNames[command.parameters.moduleKey]], ["Basis", command.parameters.source], ["Ends", command.parameters.endsAt || "No expiration"]); break;
        case "access.revoke": if (!editor.term) return; command = { ...common, action: editor.action, parameters: { termId: editor.term.id } }; details.push(["Module", moduleNames[editor.term.moduleKey]], ["Original term", `${editor.term.source} · ${trainingDate(editor.term.startsAt)}`]); break;
      }
      const parsed = parseTrainingOperation(command);
      if (parsed.operation === "apply") onReview({ command: parsed, title, details });
    } catch { setError("Check the required names, dates, email and administrative reason before reviewing this change."); }
  }
  return <section className="panel training-editor"><h3>{title}</h3>{organizationId && <p>{organizationName}{facilityId ? ` · ${facilityName}` : ""}{student ? ` · ${student.firstName} ${student.lastName}` : ""}</p>}
    {editor.action === "enrollments.assign" && <form className="training-facility-picker" onSubmit={event => { event.preventDefault(); setCourseFilter(courseSearch.trim()); setCourseOffset(0); setCourseId(""); }}><label>Find a course<input type="search" maxLength={100} value={courseSearch} onChange={event => setCourseSearch(event.target.value)} /></label><button className="button button-secondary">Search courses</button></form>}
    <form onSubmit={review} className="training-form">
      {editor.action === "facilities.provision" && <><label>Organization name<input name="organizationName" required maxLength={200} defaultValue={initialValue("organizationName")} /></label><label>Facility name<input name="facilityName" required maxLength={200} defaultValue={initialValue("facilityName")} /></label><label>Facility type<select name="facilityType" defaultValue={initialValue("facilityType", "PCH")}><option value="PCH">Pennsylvania Personal Care Home (PCH)</option><option value="ALR">Pennsylvania Assisted Living Facility (ALF)</option></select></label><p>Creates a new organization and its first facility with training module access. Add other modules only after separate agreement.</p></>}
      {studentFields && <><label>First name<input name="firstName" required maxLength={100} defaultValue={initialValue("firstName", student?.firstName || "")} /></label><label>Last name<input name="lastName" required maxLength={100} defaultValue={initialValue("lastName", student?.lastName || "")} /></label><label>Email<input name="email" type="email" maxLength={320} required={editor.action === "invitations.create"} readOnly={editor.action === "students.update" && !!student?.profileId} aria-describedby={editor.action === "students.update" && student?.profileId ? "linked-student-email-note" : undefined} defaultValue={initialValue("email", student?.email || "")} /></label>{editor.action !== "invitations.create" && <label>Position / job title<input name="jobTitle" required maxLength={200} defaultValue={initialValue("jobTitle", student?.jobTitle || "")} /></label>}</>}
      {editor.action === "students.update" && student?.profileId && <p id="linked-student-email-note">This email is linked to a login account. Account email changes must use the verified account recovery process; editing a training record does not change login credentials.</p>}
      {editor.action === "students.create" && <label>Hire date<input name="hireDate" type="date" defaultValue={initialValue("hireDate")} required /></label>}
      {editor.action === "invitations.create" && <p>Invite as {student ? "a student for this facility" : "this organization's administrator"}. The recipient will receive an account setup invitation.</p>}
      {editor.action === "students.setActive" && <><p>{student?.isActive ? "Deactivate this student and follow the existing CareBase account and enrollment rules. Training history is retained." : "Reactivate this student using the existing CareBase employment and access rules."}</p><label>Effective date<input name="effectiveDate" type="date" defaultValue={initialValue("effectiveDate", dateToday())} required /></label></>}
      {editor.action === "enrollments.assign" && <>{courses.status === "loading" ? <Loading label="Loading available courses" /> : courses.status === "error" ? <ReadFailure error={courses.error} retry={() => setCourseRevision(value => value + 1)} /> : <><label>Course<select value={courseId} required onChange={event => setCourseId(event.target.value)}><option value="">Select a course</option>{courses.data.items.map(course => <option key={course.id} value={course.id} disabled={!course.versionId}>{course.title}{course.versionId ? "" : " - no published version"}</option>)}</select></label><div className="admin-pagination"><span>{courses.data.total} courses</span><div><button type="button" className="button button-secondary button-small" disabled={courseOffset === 0} onClick={() => { setCourseOffset(Math.max(0, courseOffset - 20)); setCourseId(""); }}>Previous courses</button><button type="button" className="button button-secondary button-small" disabled={courseOffset + 20 >= courses.data.total} onClick={() => { setCourseOffset(courseOffset + 20); setCourseId(""); }}>Next courses</button></div></div></>}<label>Due date (optional)<input name="dueDate" type="date" defaultValue={initialValue("dueDate")} /></label></>}
      {editor.action === "enrollments.cancel" && <p>Cancel {editor.enrollment?.course} for {editor.enrollment?.student}. Completed training and issued certificates remain historical records.</p>}
      {editor.action === "access.grant" && <><label>Module<select name="moduleKey" defaultValue={initialValue("moduleKey", "modules.train")}>{trainingModules.map(key => <option key={key} value={key}>{moduleNames[key]}</option>)}</select></label><label>Access basis<select name="source" defaultValue={initialValue("source", "complimentary")}><option value="complimentary">Complimentary</option><option value="contract">Agreed contract</option></select></label><label>Access ends (optional, your local time)<input name="endsAt" type="datetime-local" defaultValue={trainingLocalDateTime(initialValue("endsAt"))} /></label><p>A contract term records agreed access; it does not charge the customer. Use Billing in this Hub for payment subscriptions.</p></>}
      {editor.action === "access.revoke" && <p>Revoke the selected {editor.term && moduleNames[editor.term.moduleKey]} term. Other active terms and subscriptions may continue to provide access.</p>}
      <label>Administrative reason<textarea name="reason" defaultValue={editor.draft?.reason || ""} minLength={10} maxLength={500} required rows={3} /></label>
      {error && <p role="alert">{error}</p>}
      <div className="training-actions"><button className="button button-primary" disabled={editor.action === "enrollments.assign" && !selectedCourse?.versionId}>Review training change</button><button className="button button-secondary" type="button" onClick={close}>Cancel</button></div>
    </form>
  </section>;
}
