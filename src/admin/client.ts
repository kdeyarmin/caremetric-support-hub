import { supabase } from "../lib/supabase";
import { config } from "../lib/config";
import { parseAdminEnvelope, parseAdminOperation, type AdminOperation } from "../../supabase/functions/_shared/adminProtocol";
import type { AdminClient, CareBaseCourseDetail, CareBaseCoursePage, CareBaseOverview } from "./types";

export class AdminApiError extends Error {
  readonly code: string;
  constructor(code: string) { super("Administrator request could not be completed."); this.code = code; }
}

async function read(operation: AdminOperation, signal: AbortSignal) {
  if (!supabase) throw new AdminApiError("unconfigured");
  const { data, error } = await supabase.auth.getSession();
  if (error || !data.session) throw new AdminApiError("401");
  const response = await fetch(`${config.supabaseUrl}/functions/v1/platform-admin`, {
    method: "POST", headers: { "Content-Type": "application/json", apikey: config.supabasePublishableKey, Authorization: `Bearer ${data.session.access_token}` },
    body: JSON.stringify(parseAdminOperation(operation)), signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]), redirect: "error", cache: "no-store",
  });
  if (!response.ok) {
    let code = response.status === 401 ? "401" : response.status === 403 ? "403" : "upstream";
    try {
      const body = await response.json() as { error?: { code?: string } };
      if (body.error?.code && ["unconfigured", "notfound", "upstream"].includes(body.error.code)) code = body.error.code;
    } catch { /* Error details are intentionally not displayed. */ }
    throw new AdminApiError(code);
  }
  return parseAdminEnvelope(await response.json(), operation).data;
}

export const adminClient: AdminClient = {
  getOverview: async ({ signal }) => await read({ operation: "overview" }, signal) as CareBaseOverview,
  listCourses: async ({ search, limit, offset, signal }) => await read({ operation: "courses.list", search, limit, offset }, signal) as CareBaseCoursePage,
  getCourse: async ({ courseId, signal }) => await read({ operation: "courses.get", courseId }, signal) as CareBaseCourseDetail,
};
