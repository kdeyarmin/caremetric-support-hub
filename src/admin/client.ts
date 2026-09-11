import { parseAdminEnvelope, parseAdminOperation, type AdminOperation } from "../../supabase/functions/_shared/adminProtocol";
import type { AdminClient, CareBaseCourseDetail, CareBaseCoursePage, CareBaseOverview } from "./types";

export class AdminApiError extends Error {
  readonly code: string;
  constructor(code: string) { super("Administrator request could not be completed."); this.code = code; }
}

async function read(operation: AdminOperation, signal: AbortSignal) {
  let normalized;
  try { normalized = parseAdminOperation(operation); } catch { throw new AdminApiError("invalid_request"); }
  const response = await fetch("/api/admin/read", {
    method: "POST", headers: { "Content-Type": "application/json" }, credentials:"same-origin",
    body: JSON.stringify(normalized), signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]), redirect: "error", cache: "no-store",
  });
  if (!response.ok) {
    let code = response.status === 401 ? "401" : response.status === 403 ? "403" : "upstream";
    try {
      const body = await response.json() as { error?: { code?: string } };
      if (body.error?.code && ["unconfigured", "notfound", "upstream", "invalid_request"].includes(body.error.code)) code = body.error.code;
    } catch { /* Error details are intentionally not displayed. */ }
    throw new AdminApiError(code);
  }
  return parseAdminEnvelope(await response.json(), normalized).data;
}

export const adminClient: AdminClient = {
  getOverview: async ({ signal }) => await read({ operation: "overview" }, signal) as CareBaseOverview,
  listCourses: async ({ search, limit, offset, signal }) => await read({ operation: "courses.list", search, limit, offset }, signal) as CareBaseCoursePage,
  getCourse: async ({ courseId, signal }) => await read({ operation: "courses.get", courseId }, signal) as CareBaseCourseDetail,
};
