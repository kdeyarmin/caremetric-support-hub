export type AdminReadState<T> =
  | { status: "loading" }
  | { status: "ready"; data: T; receivedAt: Date }
  | { status: "error"; error: AdminReadError };

export interface AdminReadError {
  title: string;
  message: string;
  retryable: boolean;
}

/** UI copy never exposes upstream exceptions, tokens, or response bodies. */
export function describeAdminReadError(error: unknown): AdminReadError {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  if (code === "401" || code === "unauthenticated") return {
    title: "Sign-in required",
    message: "Your administrator session could not be verified. Sign in again and complete MFA, then retry.",
    retryable: true,
  };
  if (code === "403" || code === "forbidden") return {
    title: "Administrator access required",
    message: "This connection requires an authorized platform administrator and verified MFA.",
    retryable: false,
  };
  if (code === "unconfigured") return {
    title: "CareBase connection unavailable",
    message: "The CareBase administration connection has not been configured. Live totals and courses are unavailable.",
    retryable: true,
  };
  if (code === "notfound" || code === "404") return {
    title: "Course unavailable",
    message: "This course could not be found in the shared CareBase catalog. Refresh the course list to check current records.",
    retryable: true,
  };
  return {
    title: "CareBase could not be reached",
    message: "Live data could not be loaded. Retry after the connection is available.",
    retryable: true,
  };
}

/** Abort invalidates late results even when an upstream transport ignores cancellation. */
export async function readAdminResource<T>(
  reader: (signal: AbortSignal) => Promise<T>,
  signal: AbortSignal,
  receive: (state: AdminReadState<T>) => void,
): Promise<void> {
  if (signal.aborted) return;
  try {
    const data = await reader(signal);
    if (!signal.aborted) receive({ status: "ready", data, receivedAt: new Date() });
  } catch (error) {
    if (!signal.aborted) receive({ status: "error", error: describeAdminReadError(error) });
  }
}
