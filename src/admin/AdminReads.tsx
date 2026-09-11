import { CircleAlert, LoaderCircle, RefreshCw } from "lucide-react";
import type { AdminReadError } from "./readState";
export function Loading({ label, app = "CareBase" }: { label: string; app?: string }) {
  return <div className="admin-read-message" role="status"><LoaderCircle size={20} className="spin" aria-hidden="true" /><div><strong>{label}</strong><p>Requesting current {app} data.</p></div></div>;
}
export function ReadFailure({ error, retry }: { error: AdminReadError; retry: () => void }) {
  return <div className="admin-read-message admin-read-error" role="alert"><CircleAlert size={21} aria-hidden="true" /><div><strong>{error.title}</strong><p>{error.message}</p>{error.retryable && <button className="button button-secondary button-small" type="button" onClick={retry}><RefreshCw size={13} aria-hidden="true" />Retry</button>}</div></div>;
}
