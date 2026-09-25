// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TrainingWorkspace } from "./TrainingWorkspace";
import type { PortfolioClient } from "./portfolioClient";
import type { TrainingOperation, TrainingResponse } from "../../supabase/functions/_shared/trainingProtocol";
import { trainingIds as ids, trainingIntent, trainingReport } from "./fixtures/training";
import { saveTrainingIntent } from "./trainingRecovery";
import { AdminApiError } from "./transport";

afterEach(() => { cleanup(); sessionStorage.clear(); vi.restoreAllMocks(); });
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
function setup(request = vi.fn(read), initial = route, actorId = "owner-a") {
  const portfolio = { organizations: vi.fn(async () => ({ items: [organization], total: 1, limit: 20, offset: 0 })) } as unknown as PortfolioClient;
  return { request, ...render(<MemoryRouter initialEntries={[initial]}><History /><TrainingWorkspace actorId={actorId} client={{ request }} portfolio={portfolio} /></MemoryRouter>) };
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
    expect(screen.queryByRole("button", { name: "Invite facility administrator" })).toBeNull();
    await act(async () => finish(trainingReport));
    expect(await screen.findByRole("button", { name: "Add student" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add student" }));
    expect(screen.getByText("Cedar Care · Cedar Home")).toBeTruthy();
  });
  it("does not expose scoped changes when a cross-organization facility URL is refused", async () => {
    setup(vi.fn(async operation => { if (operation.operation === "enrollments.report") throw new AdminApiError("notfound"); return read(operation); }));
    await screen.findByText("Record unavailable");
    expect(screen.queryByRole("button", { name: "Add student" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Invite facility administrator" })).toBeNull();
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
    const { request } = setup(); fireEvent.click(await screen.findByRole("button", { name: "Invite facility administrator" }));
    fill("First name", "Ava"); fill("Last name", "Admin"); fill("Email", "ava@example.test"); fill("Administrative reason", "Facility requested its administrator account.");
    await approve();
    await screen.findByText(/Delivery status: sent/);
    expect(request.mock.calls.find(([operation]) => operation.operation === "apply")![0]).toMatchObject({ action: "invitations.create", organizationId: ids.organization, parameters: { role: "org_admin", employeeId: null, facilityId: null, email: "ava@example.test" } });
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
    expect((screen.getByRole("option", { name: "Draft course - no published version" }) as HTMLOptionElement).disabled).toBe(true);
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
});
