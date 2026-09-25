import type { EnrollmentStatus, TrainingEnrollmentRow, TrainingEnrollmentPage } from "../../supabase/functions/_shared/trainingProtocol";
export type TrainingReportRow = TrainingEnrollmentRow;
export type TrainingReportPage = TrainingEnrollmentPage;
export interface TrainingReportFilters {
  courseSearch: string; status: EnrollmentStatus; dateBasis: "assigned" | "completed" | "certificate";
  dateFrom: string | null; dateThrough: string | null;
}
export const dateBasisLabels = { assigned: "Enrollment date", completed: "Completion date", certificate: "Certificate issue date" };
export function trainingLocalDateTime(value: string) {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf())) return "";
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
export function trainingDateTime(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.valueOf()) ? date.toLocaleString("en-US", { timeZone: "America/New_York", year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }) : "Unavailable";
}
export function trainingDate(value: string | null) {
  if (!value) return "—";
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = new Date(value);
  return Number.isFinite(date.valueOf()) ? date.toLocaleDateString("en-US", { timeZone: "America/New_York", year: "numeric", month: "short", day: "numeric" }) : "Unavailable";
}
export function trainingReportScope(filters: TrainingReportFilters) {
  return `${dateBasisLabels[filters.dateBasis]}: ${filters.dateFrom || "all past dates"} through ${filters.dateThrough || "all future dates"} (Pennsylvania time). Status: ${filters.status}. Course: ${filters.courseSearch || "all courses"}. Each assignment counts as one enrollment; annual repeats count separately. Completion rate excludes canceled enrollments. This report records training activity and does not certify facility compliance.`;
}
export const trainingHeaders = ["Student", "Facility", "Course", "Status", "Progress %", "Enrolled", "Due", "Completed", "Certificate number", "Certificate issued", "Certificate PDF status", "Enrollment ID"];
export function trainingCells(row: TrainingReportRow) {
  return [row.student, row.facility, row.course, row.status.replaceAll("_", " "), String(row.percent_complete), trainingDate(row.assigned_at), trainingDate(row.due_date), trainingDate(row.completed_at), row.credential_number || "", trainingDate(row.certificate_issued_at), row.certificate_pdf_status || "", row.id];
}
function csvCell(value: unknown) {
  let text = String(value ?? "");
  if (/^[\s]*[=+@-]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
export function trainingReportCsv(report: TrainingReportPage, filters: TrainingReportFilters) {
  if (report.offset !== 0 || report.rows.length !== report.total || report.total > 10000) throw new Error("The complete report was not returned. Narrow the filters and try again.");
  return [
    ["Training enrollment, completion and certificates", report.organization_name],
    ["Facility", report.facility_name || "All facilities in selected organization"], ["Generated (Pennsylvania time)", trainingDateTime(report.generated_at)],
    [trainingReportScope(filters)], ["Enrollments", report.total, "Students", report.students, "Completed", report.completed, "Non-canceled enrollments", report.completion_denominator, "Certificates", report.certificates],
    [], trainingHeaders, ...report.rows.map(trainingCells),
  ].map(row => row.map(csvCell).join(",")).join("\r\n");
}
export function downloadTrainingCsv(content: string) {
  const url = URL.createObjectURL(new Blob(["\uFEFF", content], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a"); link.href = url; link.download = "caremetric-training-report.csv"; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
