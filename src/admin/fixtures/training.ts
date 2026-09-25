import type { TrainingEnrollmentPage, TrainingEnrollmentRow } from "../../../supabase/functions/_shared/trainingProtocol";
import type { TrainingIntent } from "../TrainingCommandReview";
export const trainingIds = {
  organization: "10000000-0000-4000-8000-000000000001",
  facility: "20000000-0000-4000-8000-000000000001",
  secondFacility: "20000000-0000-4000-8000-000000000002",
  student: "30000000-0000-4000-8000-000000000001",
  course: "40000000-0000-4000-8000-000000000001",
  version: "50000000-0000-4000-8000-000000000001",
  assignment: "60000000-0000-4000-8000-000000000001",
  certificate: "70000000-0000-4000-8000-000000000001",
  request: "80000000-0000-4000-8000-000000000001",
};
export const trainingRow: TrainingEnrollmentRow = {
  id: trainingIds.assignment, employee_id: trainingIds.student, student: "Ada Student", facility_id: trainingIds.facility,
  facility: "Cedar Home", course_id: trainingIds.course, course: "Fire safety", status: "completed",
  assigned_at: "2026-09-01T12:00:00Z", due_date: "2026-09-30", completed_at: "2026-09-24T14:00:00Z",
  percent_complete: 100, certificate_id: trainingIds.certificate, credential_number: "CM-123",
  certificate_issued_at: "2026-09-24T14:00:00Z", certificate_pdf_status: "ready",
};
export const trainingReport: TrainingEnrollmentPage = {
  organization_name: "Cedar Care", facility_name: "Cedar Home", generated_at: "2026-09-25T02:00:00Z",
  date_basis: "assigned", limit: 20, offset: 0, total: 1, students: 1, completed: 1, in_progress: 0,
  not_started: 0, canceled: 0, completion_denominator: 1, certificates: 1, rows: [trainingRow],
};
export const trainingIntent: TrainingIntent = {
  command: { domain: "training.v1", operation: "apply", action: "facilities.provision", requestId: trainingIds.request,
    organizationId: null, parameters: { organizationName: "Cedar Care", facilityName: "Cedar Home", facilityType: "PCH" }, reason: "Facility requested training access." },
  title: "Create training facility", details: [["Organization", "Cedar Care"], ["Facility", "Cedar Home"]],
};
