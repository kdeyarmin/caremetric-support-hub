export function packageError(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  if (["401", "403", "unauthenticated", "forbidden"].includes(code)) return "A current administrator session in the Hub and CareBase is required. Sign in again, then inspect saved package operations.";
  if (code === "unconfigured") return "CareBase package ingestion is not available on this connection.";
  if (code === "conflict") return "The source, saved operation, or session changed. Refresh package status and load the current course material before starting another change.";
  if (code === "artifact_mismatch") return "The uploaded bytes did not match the reviewed file. Refresh saved operations before trying again.";
  if (code === "payload_too_large") return "Choose a nonempty ZIP no larger than 50 MiB.";
  if (code === "invalid_request") return "Check the package standard, reason, entry point and selected ZIP.";
  if (code === "busy") return "CareBase is processing another package. Keep this request and retry after checking saved operations.";
  return "The request did not finish. Check saved package operations before retrying the same request. Nothing is automatically accepted.";
}
