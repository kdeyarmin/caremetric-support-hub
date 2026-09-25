import { describe, expect, it } from "vitest";
import { trainingDate, trainingDateTime, trainingReportCsv, type TrainingReportFilters } from "./trainingPresentation";
import { trainingReport, trainingRow } from "./fixtures/training";
const filters: TrainingReportFilters = { courseSearch: "", status: "all", dateBasis: "completed", dateFrom: "2026-09-01", dateThrough: "2026-09-30" };
describe("training report documents", () => {
  it("keeps date-only deadlines stable and reports Pennsylvania time across UTC midnight", () => {
    expect(trainingDate("2026-09-25")).toBe("2026-09-25");
    expect(trainingDate("2026-09-25T02:00:00Z")).toBe("Sep 24, 2026");
    expect(trainingDateTime("2026-09-25T02:00:00Z")).toContain("10:00 PM EDT");
    expect(trainingDate(null)).toBe("—");
  });
  it("exports the applied scope and neutralizes spreadsheet formulas including leading whitespace", () => {
    const csv = trainingReportCsv({ ...trainingReport, organization_name: "=1+1", rows: [{ ...trainingRow, student: " \t@SUM(1)", course: 'A "quoted" course' }] }, filters);
    expect(csv).toContain('"\'=1+1"');
    expect(csv).toContain('"\' \t@SUM(1)"');
    expect(csv).toContain('"A ""quoted"" course"');
    expect(csv).toContain("Completion date: 2026-09-01 through 2026-09-30 (Pennsylvania time)");
    expect(csv).toContain("Completion rate excludes canceled enrollments");
    expect(csv).toContain("Sep 24, 2026, 10:00 PM EDT");
  });
  it("refuses truncated, noninitial or oversized report snapshots", () => {
    expect(() => trainingReportCsv({ ...trainingReport, total: 2 }, filters)).toThrow();
    expect(() => trainingReportCsv({ ...trainingReport, offset: 20 }, filters)).toThrow();
    expect(() => trainingReportCsv({ ...trainingReport, total: 10001 }, filters)).toThrow();
    expect(() => trainingReportCsv({ ...trainingReport, rows: [], total: 0 }, filters)).not.toThrow();
  });
});
