import { useCallback, useState } from "react";
import type { AdminPage, AdvisorInquiry } from "../../supabase/functions/_shared/portfolioProtocol";
import { advisorInquiryStatuses } from "../../supabase/functions/_shared/portfolioProtocol";
import type { AdvisorCommand } from "../../supabase/functions/_shared/advisorsCommands";
import { mailtoHref } from "../lib/mailto";
import { changeAdvisorRequest } from "./advisorsClient";
import { PagedRecords } from "./PagedRecords";
import { readPortfolio } from "./portfolioClient";
import { timeLabel } from "./readState";
import { AdminApiError } from "./transport";

const statusLabels: Record<AdvisorInquiry["status"], string> = { new: "Needs review", "in-progress": "In progress", closed: "Closed" };

function changeFailure(caught: unknown) {
  const code = caught instanceof AdminApiError ? caught.code : "upstream";
  return code === "conflict" ? "This request changed in Advisors since the list loaded. Reload the list, then try again."
    : code === "notfound" ? "This request no longer exists in Advisors. Reload the list."
    : code === "401" || code === "403" ? "Your Hub sign-in has expired. Sign in again, then retry."
    : code === "unconfigured" ? "The Advisors connection is not switched on yet."
    : code === "invalid_request" ? "Notes can be up to 3,000 characters without special control characters."
    : "Advisors did not answer. Try again; nothing changed.";
}

/** Status, notes and deletion for one request. Every change names what the owner last saw, so Advisors refuses it if the request changed meanwhile. */
function ManageRequest({ row, change, onDeleted }: { row: AdvisorInquiry; change: (command: AdvisorCommand) => Promise<unknown>; onDeleted: () => void }) {
  const [saved, setSaved] = useState({ status: row.status, notes: row.notes });
  const [status, setStatus] = useState(row.status);
  const [notes, setNotes] = useState(row.notes);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [deleted, setDeleted] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const edited = status !== saved.status || notes !== saved.notes;
  async function run(command: AdvisorCommand, done: () => void) {
    setBusy(true); setResult(null);
    try { await change(command); done(); }
    catch (caught) { setResult({ ok: false, text: changeFailure(caught) }); }
    finally { setBusy(false); setConfirming(false); }
  }
  if (deleted) return <p role="status" className="muted">Deleted from Advisors.</p>;
  return <div className="advisor-manage">
    <label>Status<select value={status} disabled={busy} onChange={event => { setStatus(event.target.value as AdvisorInquiry["status"]); setResult(null); }}>
      {advisorInquiryStatuses.map(value => <option key={value} value={value}>{statusLabels[value]}</option>)}</select></label>
    <label>Notes<textarea value={notes} rows={3} maxLength={3000} disabled={busy} onChange={event => { setNotes(event.target.value); setResult(null); }} /></label>
    <div className="button-row">
      <button type="button" className="button button-primary button-small" disabled={busy || !edited}
        onClick={() => void run({ operation: "inquiries.update", id: row.id, status, notes, expected: saved }, () => { setSaved({ status, notes }); setResult({ ok: true, text: "Saved in Advisors." }); })}>Save</button>
      {!confirming
        ? <button type="button" className="button button-secondary button-small" disabled={busy} onClick={() => setConfirming(true)}>Delete</button>
        : <><span>Delete permanently?</span>
          <button type="button" className="button button-secondary button-small" disabled={busy}
            onClick={() => void run({ operation: "inquiries.delete", id: row.id, expected: saved }, () => { setDeleted(true); onDeleted(); })}>Yes, delete</button>
          <button type="button" className="button button-secondary button-small" disabled={busy} onClick={() => setConfirming(false)}>Keep it</button></>}
    </div>
    {result && <p role={result.ok ? "status" : "alert"} className={result.ok ? "muted" : "form-message form-error"}>{result.text}</p>}
  </div>;
}

/** Healthcare Advisors consultation requests, read live from the Advisors inbox and managed from here. */
export function ConsultationRequests({ change = (command: AdvisorCommand) => changeAdvisorRequest(command, new AbortController().signal) }: { change?: (command: AdvisorCommand) => Promise<unknown> }) {
  const read = useCallback(async (search: string, offset: number, signal: AbortSignal) =>
    await readPortfolio("advisors", { operation: "inquiries.list", search: search || undefined, offset, limit: 20 }, signal) as AdminPage<AdvisorInquiry>, []);
  return <>
    <p className="admin-explanation">Requests submitted through the caremetricadvisors.com consultation form. Change a request's status or notes, or delete it, here: changes go straight to Advisors, and its private inbox shows them too. Contact details are self-reported, and the website asks visitors not to include patient information. Advisors deletes requests after 365 days.</p>
    <PagedRecords<AdvisorInquiry> app="CareMetric Healthcare Advisors" title="Consultation requests" searchLabel="Search names, emails and organizations" columns={["Received", "Reference", "Contact", "Organization", "Interest", "Message", "Manage"]} read={read} render={(row, removed) => <>
      <td>{timeLabel(row.createdAt)}</td>
      <td>{row.id}</td>
      <td>{row.name}<div><a href={mailtoHref(row.email)}>{row.email}</a></div>{row.phone && <div><a href={`tel:${row.phone.replace(/[^+\d]/g, "")}`}>{row.phone}</a></div>}</td>
      <td>{row.organization}<div>{row.sector}</div></td>
      <td>{row.service}</td>
      <td style={{ whiteSpace: "pre-wrap", minWidth: "18rem" }}>{row.message}</td>
      <td><ManageRequest key={row.id} row={row} change={change} onDeleted={removed} /></td>
    </>} />
  </>;
}
