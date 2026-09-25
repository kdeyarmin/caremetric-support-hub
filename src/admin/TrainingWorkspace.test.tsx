// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TrainingWorkspace } from "./TrainingWorkspace";
import type { PortfolioClient } from "./portfolioClient";
import type { TrainingOperation, TrainingResponse, TrainingTerm } from "../../supabase/functions/_shared/trainingProtocol";
import { trainingIds as ids, trainingIntent, trainingReport, trainingRow } from "./fixtures/training";
import { saveTrainingIntent } from "./trainingRecovery";
import { AdminApiError } from "./transport";

afterEach(() => { cleanup(); sessionStorage.clear(); vi.restoreAllMocks(); vi.useRealTimers(); });
const organization = { id: ids.organization, name: "Cedar Care", slug: "cedar-care", status: "active", createdAt: null };
const facilities = [{ id: ids.facility, name: "Cedar Home", facilityType: "PCH", isActive: true }, { id: ids.secondFacility, name: "Aspen Home", facilityType: "ALR", isActive: true }] as const;
const student = { id: ids.student, firstName: "Ada", lastName: "Student", email: "ada@example.test", jobTitle: "Care aide", hireDate: null, isActive: true, status: "active", profileId: null };
const read = async (operation: TrainingOperation): Promise<TrainingResponse> => {
  if (operation.operation === "enrollments.report") return { ...trainingReport, facility_name: operation.facilityId === ids.secondFacility ? "Aspen Home" : operation.facilityId ? "Cedar Home" : null, rows: operation.facilityId === ids.secondFacility ? [] : trainingReport.rows };
  if (operation.operation === "facilities.list") return { items: [...facilities], total: 2, offset: operation.offset, limit: operation.limit };
  if (operation.operation === "students.list") return { items: [student], total: 1, offset: operation.offset, limit: operation.limit };
  if (operation.operation === "courses.list") return { items: [{ id: ids.course, title: "Fire safety", versionId: ids.version }, { id: "40000000-0000-4000-8000-000000000002", title: "Draft course", versionId: null }], total: 2, offset: 0, limit: 20 };
  if (operation.operation === "access.list") return { items: [], total: 0, limit: operation.limit, offset: operation.offset };
  if (operation.operation === "apply") return { requestId: operation.requestId, action: operation.action, organizationId: ids.organization, replayed: false, result: operation.action === "facilities.provision" ? { organizationId: ids.organization, facilityId: ids.facility } : operation.action === "invitations.create" ? { invitationId: ids.request, deliveryStatus: "sent" } : { employeeId: ids.student } };
  throw new Error("Unexpected fixture operation");
};
const route = `/admin?product=carebase&view=training&organizationId=${ids.organization}&facilityId=${ids.facility}`;
function History() {
  const navigate = useNavigate(), location = useLocation();
  return <><output aria-label="Current URL">{location.search}</output><button onClick={() => navigate(-1)}>Browser back</button><button onClick={() => navigate(1)}>Browser forward</button></>;
}
function setup(request = vi.fn(read), initial: string | string[] = route, actorId = "owner-a") {
  const portfolio = { organizations: vi.fn(async () => ({ items: [organization], total: 1, limit: 20, offset: 0 })) } as unknown as PortfolioClient;
  return { request, ...render(<MemoryRouter initialEntries={Array.isArray(initial) ? initial : [initial]}><History /><TrainingWorkspace actorId={actorId} client={{ request }} portfolio={portfolio} /></MemoryRouter>) };
}
const fill = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
async function approve() {
  fireEvent.click(screen.getByRole("button", { name: "Review training change" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "I reviewed this change." }));
  fireEvent.click(screen.getByRole("button", { name: "Apply reviewed change" }));
}
describe("Hub facility training workspace", () => {
  it("verifies the refreshed URL scope before exposing student or invitation actions", async () => {
    let finish!: (response: TrainingResponse) => void;
    const request = vi.fn(async (operation: TrainingOperation) => operation.operation === "enrollments.report" && operation.limit === 1 ? await new Promise<TrainingResponse>(resolve => { finish = resolve; }) : read(operation));
    setup(request); expect(screen.queryByRole("button", { name: "Add student" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Invite organization administrator" })).toBeNull();
    await act(async () => finish(trainingReport));
    expect(await screen.findByRole("button", { name: "Add student" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add student" }));
    expect(screen.getByText("Cedar Care · Cedar Home")).toBeTruthy();
  });
  it("does not expose scoped changes when a cross-organization facility URL is refused", async () => {
    setup(vi.fn(async operation => { if (operation.operation === "enrollments.report") throw new AdminApiError("notfound"); return read(operation); }));
    await screen.findByText("Record unavailable");
    expect(screen.queryByRole("button", { name: "Add student" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Invite organization administrator" })).toBeNull();
  });
  it("creates a student only in the verified facility after review", async () => {
    const { request } = setup(); fireEvent.click(await screen.findByRole("button", { name: "Add student" }));
    fill("First name", "Grace"); fill("Last name", "Student"); fill("Email", "grace@example.test"); fill("Position / job title", "Care aide"); fill("Hire date", "2026-09-01"); fill("Administrative reason", "Facility requested staff enrollment.");
    expect(request.mock.calls.filter(([operation]) => operation.operation === "apply")).toHaveLength(0);
    await approve();
    await waitFor(() => expect(request.mock.calls.filter(([operation]) => operation.operation === "apply")).toHaveLength(1));
    const applied = request.mock.calls.find(([operation]) => operation.operation === "apply")![0];
    expect(applied).toMatchObject({ action: "students.create", organizationId: ids.organization, parameters: { facilityId: ids.facility, firstName: "Grace", lastName: "Student", hireDate: "2026-09-01" } });
    await screen.findByText(/Student added/);
  });
  it("invites administrators as org_admin with no implicit student or platform role", async () => {
    const { request } = setup(); fireEvent.click(await screen.findByRole("button", { name: "Invite organization administrator" }));
    const editor = screen.getByRole("region", { name: "Invite organization administrator" });
    expect(within(editor).getByText(/organization administrator with access to all facilities in this organization/)).toBeTruthy();
    expect(within(editor).queryByText(/Cedar Home/)).toBeNull();
    fill("First name", "Ava"); fill("Last name", "Admin"); fill("Email", "ava@example.test"); fill("Administrative reason", "Facility requested its administrator account.");
    fireEvent.click(screen.getByRole("button", { name: "Review training change" }));
    const review = screen.getByRole("region", { name: "Review training change" });
    expect(within(review).getByText("All facilities in this organization")).toBeTruthy();
    expect(within(review).getByText("Organization administrator")).toBeTruthy();
    expect(within(review).queryByText("Facility")).toBeNull();
    expect(within(review).queryByText("Cedar Home")).toBeNull();
    fireEvent.click(within(review).getByRole("checkbox", { name: "I reviewed this change." }));
    fireEvent.click(within(review).getByRole("button", { name: "Apply reviewed change" }));
    await screen.findByText(/Delivery status: sent/);
    expect(request.mock.calls.find(([operation]) => operation.operation === "apply")![0]).toMatchObject({ action: "invitations.create", organizationId: ids.organization, parameters: { role: "org_admin", employeeId: null, facilityId: null, email: "ava@example.test" } });
  });
  it("shows the selected enrollment's facility when canceling from an all-facilities report", async () => {
    const secondAssignment = "60000000-0000-4000-8000-000000000002";
    const request = vi.fn(async (operation: TrainingOperation): Promise<TrainingResponse> => operation.operation === "enrollments.report"
      ? { ...trainingReport, facility_name: null, total: 2, completed: 0, not_started: 2, rows: [
        { ...trainingRow, status: "assigned", completed_at: null },
        { ...trainingRow, id: secondAssignment, facility_id: ids.secondFacility, facility: "Aspen Home", status: "assigned", completed_at: null },
      ] }
      : read(operation));
    setup(request, `/admin?view=training&organizationId=${ids.organization}&trainingTab=reports`);
    const cancelButtons = await screen.findAllByRole("button", { name: "Cancel enrollment" });
    fireEvent.click(cancelButtons[1]);
    const editor = screen.getByRole("region", { name: "Cancel enrollment" });
    expect(within(editor).getByText("Cedar Care · Aspen Home")).toBeTruthy();
    expect(within(editor).getByText(/Fire safety for Ada Student at Aspen Home/)).toBeTruthy();
    fill("Administrative reason", "Enrollment canceled at facility request.");
    fireEvent.click(screen.getByRole("button", { name: "Review training change" }));
    const review = screen.getByRole("region", { name: "Review training change" });
    expect(within(review).getByText("Facility").nextElementSibling?.textContent).toBe("Aspen Home");
    expect(within(review).queryByText("Cedar Home")).toBeNull();
    fireEvent.click(within(review).getByRole("checkbox", { name: "I reviewed this change." }));
    fireEvent.click(within(review).getByRole("button", { name: "Apply reviewed change" }));
    await waitFor(() => expect(request.mock.calls.find(([operation]) => operation.operation === "apply")?.[0]).toMatchObject({ action: "enrollments.cancel", organizationId: ids.organization, parameters: { assignmentId: secondAssignment } }));
  });
  it("clearly reports a failed invitation and permits a corrected invitation only through a new review", async () => {
    const request = vi.fn(async (operation: TrainingOperation): Promise<TrainingResponse> => operation.operation === "apply" && operation.action === "invitations.create"
      ? { requestId: operation.requestId, action: operation.action, organizationId: ids.organization, replayed: false, result: { invitationId: null, deliveryStatus: "failed" } }
      : read(operation));
    setup(request); fireEvent.click(await screen.findByRole("button", { name: "Invite organization administrator" }));
    fill("First name", "Ava"); fill("Last name", "Admin"); fill("Email", "ava@example.test"); fill("Administrative reason", "Facility requested its administrator account.");
    await approve();
    const notice = await screen.findByRole("alert");
    expect(notice.textContent).toContain("Invitation was not delivered");
    expect(notice.textContent).toContain("will not resend");
    expect(screen.queryByText(/recipient completes their own account setup/)).toBeNull();
    expect((await screen.findByRole("button", { name: "Add student" }) as HTMLButtonElement).disabled).toBe(false);
    const first = request.mock.calls.find(([operation]) => operation.operation === "apply")![0];
    fireEvent.click(screen.getByRole("button", { name: "Invite organization administrator" }));
    fill("First name", "Ava"); fill("Last name", "Admin"); fill("Email", "corrected@example.test"); fill("Administrative reason", "Corrected facility administrator email.");
    expect(request.mock.calls.filter(([operation]) => operation.operation === "apply")).toHaveLength(1);
    await approve(); await screen.findByRole("alert");
    const mutations = request.mock.calls.map(([operation]) => operation).filter(operation => operation.operation === "apply");
    expect(mutations).toHaveLength(2);
    expect(mutations[1]).toMatchObject({ parameters: { email: "corrected@example.test" } });
    expect(mutations[1].requestId).not.toBe(first.operation === "apply" ? first.requestId : null);
  });
  it("preserves facility selection and training section through browser back/forward and restored URLs", async () => {
    const first = setup();
    fireEvent.change(await screen.findByLabelText("Training facility"), { target: { value: ids.secondFacility } });
    await waitFor(() => expect((screen.getByLabelText("Training facility") as HTMLSelectElement).value).toBe(ids.secondFacility));
    fireEvent.click(screen.getByRole("button", { name: "Enrollment & reports" }));
    await screen.findByRole("button", { name: "Run report" });
    expect(screen.getByLabelText("Current URL").textContent).toContain("trainingTab=reports");
    fireEvent.click(screen.getByRole("button", { name: "Browser back" }));
    await screen.findByRole("button", { name: "Add student" });
    fireEvent.click(screen.getByRole("button", { name: "Browser back" }));
    await waitFor(() => expect((screen.getByLabelText("Training facility") as HTMLSelectElement).value).toBe(ids.facility));
    fireEvent.click(screen.getByRole("button", { name: "Browser forward" }));
    await waitFor(() => expect((screen.getByLabelText("Training facility") as HTMLSelectElement).value).toBe(ids.secondFacility));
    fireEvent.click(screen.getByRole("button", { name: "Browser forward" })); await screen.findByRole("button", { name: "Run report" });
    const restored = `/admin${screen.getByLabelText("Current URL").textContent}`; first.unmount(); setup(undefined, restored);
    await screen.findByRole("button", { name: "Run report" });
    expect((await screen.findByLabelText("Training facility") as HTMLSelectElement).value).toBe(ids.secondFacility);
  });
  it("requires a published course version and passes the selected version to enrollment", async () => {
    const { request } = setup(); fireEvent.click(await screen.findByRole("button", { name: "Assign course" }));
    const course = await screen.findByLabelText("Course");
    expect((screen.getByRole("option", { name: /Draft course.*no published version/ }) as HTMLOptionElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Review training change" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(course, { target: { value: ids.course } }); fill("Administrative reason", "Assigned required facility training.");
    await approve(); await screen.findByText(/Course assigned/);
    expect(request.mock.calls.find(([operation]) => operation.operation === "apply")![0]).toMatchObject({ action: "enrollments.assign", parameters: { employeeId: ids.student, courseId: ids.course, versionId: ids.version, dueDate: null } });
  });
  it("preserves module expiration and reason when returning from review to edit", async () => {
    setup(undefined, `${route}&trainingTab=access`);
    fireEvent.click(await screen.findByRole("button", { name: "Grant module access" }));
    fill("Access ends (optional, your local time)", "2026-12-31T17:30"); fill("Administrative reason", "Annual complimentary facility training.");
    fireEvent.click(screen.getByRole("button", { name: "Review training change" }));
    fireEvent.click(screen.getByRole("button", { name: "Back to edit" }));
    expect((screen.getByLabelText("Access ends (optional, your local time)") as HTMLInputElement).value).toBe("2026-12-31T17:30");
    expect((screen.getByLabelText("Administrative reason") as HTMLTextAreaElement).value).toBe("Annual complimentary facility training.");
  });
  it("restores only this administrator's unresolved request, retaining its original scope", async () => {
    saveTrainingIntent("owner-a", trainingIntent);
    const first = setup(undefined, "/admin?view=training");
    await screen.findByText(/unfinished request was recovered/);
    expect((screen.getByRole("button", { name: "New training facility" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Retry same training change" }));
    await screen.findByText(/Training facility created/);
    expect(first.request.mock.calls.find(([operation]) => operation.operation === "apply")![0]).toEqual(trainingIntent.command);
    first.unmount(); saveTrainingIntent("owner-a", trainingIntent); setup(undefined, "/admin?view=training", "owner-b");
    expect(screen.queryByText(/unfinished request was recovered/)).toBeNull();
  });
  it.each(["student", "administrator", "access"] as const)("keeps the %s draft in its starting organization through browser navigation and review/edit", async kind => {
    const otherOrganization = "10000000-0000-4000-8000-000000000002";
    const request = vi.fn(async (operation: TrainingOperation): Promise<TrainingResponse> => {
      if (operation.operation === "enrollments.report" && operation.organizationId === otherOrganization) return { ...trainingReport, organization_name: "Other Care", facility_name: "Aspen Home", rows: [] };
      return read(operation);
    });
    const tab = kind === "access" ? "&trainingTab=access" : "";
    setup(request, [`/admin?view=training&organizationId=${otherOrganization}&facilityId=${ids.secondFacility}${tab}`, `${route}${tab}`]);
    const title = kind === "student" ? "Add student" : kind === "administrator" ? "Invite organization administrator" : "Grant module access";
    fireEvent.click(await screen.findByRole("button", { name: title }));
    if (kind !== "access") { fill("First name", "Grace"); fill("Last name", "Staff"); fill("Email", "grace@example.test"); }
    if (kind === "student") { fill("Position / job title", "Care aide"); fill("Hire date", "2026-09-01"); }
    fill("Administrative reason", "Reviewed change for the original organization.");
    fireEvent.click(screen.getByRole("button", { name: "Browser back" }));
    await waitFor(() => expect(screen.getByLabelText("Current URL").textContent).toContain(otherOrganization));
    const editor = screen.getByRole("region", { name: title });
    expect(editor.textContent).toContain("Cedar Care"); expect(editor.textContent).not.toContain("Other Care");
    if (kind === "student") { expect(editor.textContent).toContain("Cedar Home"); expect(editor.textContent).not.toContain("Aspen Home"); }
    fireEvent.click(screen.getByRole("button", { name: "Review training change" }));
    let review = screen.getByRole("region", { name: "Review training change" });
    expect(within(review).getByText("Organization").nextElementSibling?.textContent).toBe("Cedar Care");
    if (kind === "student") expect(within(review).getByText("Facility").nextElementSibling?.textContent).toBe("Cedar Home");
    fireEvent.click(screen.getByRole("button", { name: "Browser forward" }));
    fireEvent.click(screen.getByRole("button", { name: "Back to edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Browser back" }));
    expect((screen.getByLabelText("Administrative reason") as HTMLTextAreaElement).value).toBe("Reviewed change for the original organization.");
    fireEvent.click(screen.getByRole("button", { name: "Review training change" }));
    review = screen.getByRole("region", { name: "Review training change" });
    expect(within(review).getByText("Organization").nextElementSibling?.textContent).toBe("Cedar Care");
    fireEvent.click(within(review).getByRole("checkbox", { name: "I reviewed this change." }));
    fireEvent.click(within(review).getByRole("button", { name: "Apply reviewed change" }));
    await waitFor(() => expect(request.mock.calls.some(([operation]) => operation.operation === "apply")).toBe(true));
    const command = request.mock.calls.find(([operation]) => operation.operation === "apply")![0];
    expect(command.organizationId).toBe(ids.organization);
    if (kind === "student") expect(command).toMatchObject({ parameters: { facilityId: ids.facility } });
    if (kind === "administrator") expect(command).toMatchObject({ parameters: { role: "org_admin", facilityId: null, employeeId: null } });
    if (kind === "access") expect(command).toMatchObject({ action: "access.grant" });
  });
  it("restores a course selected from page two of a filtered catalog when returning to edit", async () => {
    const selected = { id: "40000000-0000-4000-8000-000000000021", title: "Advanced fire safety", versionId: "50000000-0000-4000-8000-000000000021" };
    const request = vi.fn(async (operation: TrainingOperation): Promise<TrainingResponse> => operation.operation === "courses.list"
      ? { total: 21, limit: 20, offset: operation.offset, items: operation.offset === 20 ? [selected] : Array.from({ length: 20 }, (_,index) => ({ id: `40000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`, title: `Fire topic ${index + 1}`, versionId: ids.version })) }
      : read(operation));
    setup(request); fireEvent.click(await screen.findByRole("button", { name: "Assign course" }));
    fill("Find a course", "Fire"); fireEvent.click(screen.getByRole("button", { name: "Search courses" }));
    fireEvent.click(await screen.findByRole("button", { name: "Next courses" }));
    const choice = await screen.findByRole("option", { name: new RegExp(selected.title) });
    fireEvent.change(choice.parentElement!, { target: { value: selected.id } });
    fill("Due date (optional)", "2026-11-01"); fill("Administrative reason", "Selected advanced facility training.");
    fireEvent.click(screen.getByRole("button", { name: "Review training change" }));
    expect(within(screen.getByRole("region", { name: "Review training change" })).getByText(selected.title)).toBeTruthy();
    const beforeReturn = request.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Back to edit" }));
    await screen.findByRole("option", { name: new RegExp(selected.title) });
    expect((screen.getByLabelText("Find a course") as HTMLInputElement).value).toBe("Fire");
    expect((screen.getByLabelText("Course") as HTMLSelectElement).value).toBe(selected.id);
    expect((screen.getByLabelText("Due date (optional)") as HTMLInputElement).value).toBe("2026-11-01");
    expect(request.mock.calls.slice(beforeReturn).map(([operation]) => operation).filter(operation => operation.operation === "courses.list")).toEqual([expect.objectContaining({ search: "Fire", offset: 20 })]);
    await approve();
    await waitFor(() => expect(request.mock.calls.find(([operation]) => operation.operation === "apply")?.[0]).toMatchObject({ action: "enrollments.assign", parameters: { courseId: selected.id, versionId: selected.versionId, dueDate: "2026-11-01" } }));
  });
  it("identifies the exact access term when same-day terms share module and source", async () => {
    const terms: TrainingTerm[] = [
      { id: "90000000-0000-4000-8000-000000000001", moduleKey: "modules.train", source: "complimentary", startsAt: "2026-09-25T12:00:00.001Z", endsAt: "2026-12-31T23:00:00.001Z", revokedAt: null, reason: "First facility agreement" },
      { id: "90000000-0000-4000-8000-000000000002", moduleKey: "modules.train", source: "complimentary", startsAt: "2026-09-25T12:00:00.002Z", endsAt: "2027-12-31T23:00:00.002Z", revokedAt: null, reason: "Renewed facility agreement" },
    ];
    const request = vi.fn(async (operation: TrainingOperation): Promise<TrainingResponse> => operation.operation === "access.list" ? { items: terms, total: 2, limit: 20, offset: 0 } : read(operation));
    setup(request, `${route}&trainingTab=access`);
    fireEvent.click((await screen.findAllByRole("button", { name: "Revoke term" }))[1]);
    const editor = screen.getByRole("region", { name: "Revoke module term" });
    expect(within(editor).getByText(terms[1].id)).toBeTruthy();
    fill("Administrative reason", "Revoke the renewed agreement only.");
    fireEvent.click(screen.getByRole("button", { name: "Review training change" }));
    const review = screen.getByRole("region", { name: "Review training change" });
    expect(within(review).getByText("Term ID").nextElementSibling?.textContent).toBe(terms[1].id);
    expect(within(review).getByText("Starts").nextElementSibling?.textContent).toContain(terms[1].startsAt);
    expect(within(review).getByText("Ends").nextElementSibling?.textContent).toContain(terms[1].endsAt);
    expect(within(review).getByText("Original reason").nextElementSibling?.textContent).toBe(terms[1].reason);
    expect(within(review).queryByText(terms[0].id)).toBeNull();
    fireEvent.click(within(review).getByRole("checkbox", { name: "I reviewed this change." }));
    fireEvent.click(within(review).getByRole("button", { name: "Apply reviewed change" }));
    await waitFor(() => expect(request.mock.calls.find(([operation]) => operation.operation === "apply")?.[0]).toMatchObject({ action: "access.revoke", parameters: { termId: terms[1].id } }));
  });
  it("updates term status at its start and expiry boundaries without requiring navigation", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-25T12:00:00.000Z"));
    const terms: TrainingTerm[] = [
      { id: "90000000-0000-4000-8000-000000000001", moduleKey: "modules.train", source: "complimentary", startsAt: "2026-09-25T12:00:01.000Z", endsAt: "2026-09-25T12:00:02.000Z", revokedAt: null, reason: "Short scheduled term" },
      { id: "90000000-0000-4000-8000-000000000002", moduleKey: "modules.train", source: "complimentary", startsAt: "2026-09-25T11:00:00.000Z", endsAt: "2026-09-25T13:00:00.000Z", revokedAt: null, reason: "Longer term" },
    ];
    const request = vi.fn(async (operation: TrainingOperation): Promise<TrainingResponse> => operation.operation === "access.list" ? { items: terms, total: 2, limit: 20, offset: 0 } : read(operation));
    const view = setup(request, `${route}&trainingTab=access`);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    const row = screen.getByText("Short scheduled term").closest("tr")!;
    expect(within(row).getByText("Scheduled")).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(within(row).getByText("Active term")).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(within(row).getByText("Expired")).toBeTruthy();
    expect(request.mock.calls.filter(([operation]) => operation.operation === "access.list")).toHaveLength(1);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    view.unmount(); expect(vi.getTimerCount()).toBe(0);
  });
  it("distinguishes duplicate course titles by exact course and published-version IDs before applying", async () => {
    const choices = [
      { id: ids.course, title: "Fire safety", versionId: ids.version },
      { id: "40000000-0000-4000-8000-000000000002", title: "Fire safety", versionId: "50000000-0000-4000-8000-000000000002" },
    ];
    const request = vi.fn(async (operation: TrainingOperation): Promise<TrainingResponse> => operation.operation === "courses.list" ? { items: choices, total: 2, limit: 20, offset: 0 } : read(operation));
    setup(request); fireEvent.click(await screen.findByRole("button", { name: "Assign course" }));
    const options = await screen.findAllByRole("option", { name: /Fire safety/ });
    expect(options).toHaveLength(2);
    for (let index = 0; index < choices.length; index++) {
      expect(options[index].textContent).toContain(choices[index].id);
      expect(options[index].textContent).toContain(choices[index].versionId);
    }
    fireEvent.change(screen.getByLabelText("Course"), { target: { value: choices[1].id } });
    fill("Administrative reason", "Assign the second published safety course.");
    fireEvent.click(screen.getByRole("button", { name: "Review training change" }));
    const review = screen.getByRole("region", { name: "Review training change" });
    expect(within(review).getByText("Course ID").nextElementSibling?.textContent).toBe(choices[1].id);
    expect(within(review).getByText("Published version ID").nextElementSibling?.textContent).toBe(choices[1].versionId);
    expect(request.mock.calls.filter(([operation]) => operation.operation === "apply")).toHaveLength(0);
    fireEvent.click(within(review).getByRole("checkbox", { name: "I reviewed this change." }));
    fireEvent.click(within(review).getByRole("button", { name: "Apply reviewed change" }));
    await waitFor(() => expect(request.mock.calls.find(([operation]) => operation.operation === "apply")?.[0]).toMatchObject({ action: "enrollments.assign", parameters: { courseId: choices[1].id, versionId: choices[1].versionId } }));
  });
});
