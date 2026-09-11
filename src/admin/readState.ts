export type AdminReadState<T> =
  | { status: "loading" }
  | { status: "ready"; data: T; receivedAt: Date }
  | { status: "error"; error: AdminReadError };

export interface AdminReadError {
  title: string;
  message: string;
  retryable: boolean;
}

export function timeLabel(value: string | Date | null): string {
  if (!value) return "Not recorded";
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.valueOf()) ? "Not available" : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** UI copy never exposes upstream exceptions, tokens, or response bodies. */
export function describeAdminReadError(error: unknown): AdminReadError {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  if (code === "invalid_request") return {
    title: "Search needs adjustment",
    message: "Use up to 100 characters in the selected search field. Wildcards and control characters are not supported.",
    retryable: false,
  };
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
    title: "Application connection unavailable",
    message: "This administration connection is not ready. Its records and totals are unavailable.",
    retryable: true,
  };
  if (code === "notfound" || code === "404") return {
    title: "Record unavailable",
    message: "This record could not be found. Refresh the list to check current records.",
    retryable: true,
  };
  return {
    title: "Application could not be reached",
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
