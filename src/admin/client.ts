import type { AdminOperation } from "../../supabase/functions/_shared/adminProtocol";
import { readPortfolio } from "./portfolioClient";
import type { AdminClient, CareBaseCourseDetail, CareBaseCoursePage, CareBaseOverview } from "./types";
export { AdminApiError } from "./portfolioClient";
const read = (operation: AdminOperation, signal: AbortSignal) => readPortfolio("carebase", operation, signal);

export const adminClient: AdminClient = {
  getOverview: async ({ signal }) => await read({ operation: "overview" }, signal) as CareBaseOverview,
  listCourses: async ({ search, limit, offset, signal }) => await read({ operation: "courses.list", search, limit, offset }, signal) as CareBaseCoursePage,
  getCourse: async ({ courseId, signal }) => await read({ operation: "courses.get", courseId }, signal) as CareBaseCourseDetail,
};
