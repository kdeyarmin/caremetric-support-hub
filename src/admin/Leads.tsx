import { useCallback, useState } from "react";
import { RefreshCw, UserPlus } from "lucide-react";
import { Link, useInRouterContext } from "react-router-dom";
import { Loading, ReadFailure } from "./AdminReads";
import { timeLabel } from "./readState";
import { useAdminRead } from "./useAdminRead";
import { mailtoHref } from "../lib/mailto";
import { LeadsApiError, leadsClient } from "./leadsClient";
import type { LeadsClient } from "./leadsClient";
import {
  attributionSummary, detailLabel, detailValue, leadKindLabels, leadKinds, leadSourceLabels, leadSources, leadStatusLabels, leadStatuses,
} from "./leadsProtocol";
import type { Lead, LeadKind, LeadPage, LeadSource, LeadStatus } from "./leadsProtocol";
import "./admin.css";

type Notice = { ok: boolean; text: string } | null;
const pageSize = 25;

// A refusal carries the server's reviewed text; a stale change (409) is explained, because the list reloads under it.
// Anything else (a timeout, a dropped connection, an answer the screen could not read) may have happened after the
// server saved the change, so it never claims that nothing changed.
function failureText(error: unknown): string {
  if (error instanceof LeadsApiError) {
    if (error.status === 409) return "This lead changed since the list loaded, so nothing was saved. The list has been refreshed: check it and try again.";
    if (error.status === 401) return "Your administrator session has ended. Sign in again with an SMS code, then make the change.";
    return error.message;
  }
  return "The change could not be confirmed. Refresh and check the lead's status before you try again.";
}

/** A link to the lead's conversation in the inbox (a plain link where there is no router, as in tests). */
function ConversationLink({ reference }: { reference: string }) {
  const href = `/communications?search=${encodeURIComponent(reference)}&status=all`;
  return useInRouterContext() ? <Link to={href}>Open {reference}</Link> : <a href={href}>Open {reference}</a>;
}

const who = (lead: Lead) => lead.contact.name ?? lead.contact.email;
const leadCount = (count: number) => `${count} lead${count === 1 ? "" : "s"}`;

/**
 * Newer and Older, from what the page itself says: Older only while more leads exist and the next page is within the
 * deepest offset hub.list_leads serves (`maxOffset`), so the screen never asks for a page the database refuses.
 */
function Pager({ data, onPage }: { data: LeadPage; onPage: (offset: number) => void }) {
  const older = data.offset + pageSize;
  const more = data.offset + data.items.length < data.total;
  const beyond = older > data.maxOffset;
  return <>
    <div className="button-row team-paging">
      <button type="button" className="button button-secondary button-small" disabled={data.offset === 0} onClick={() => onPage(Math.max(0, data.offset - pageSize))}>Newer</button>
      <span className="muted" role="status">Showing {data.offset + 1}–{data.offset + data.items.length} of {data.total}</span>
      <button type="button" className="button button-secondary button-small" disabled={!more || beyond} onClick={() => onPage(older)}>Older</button>
    </div>
    {more && beyond && <p className="admin-explanation">This is as far back as the list pages. Choose a kind or product to see older leads.</p>}
  </>;
}

function LeadRow({ lead, busy, onStatus }: { lead: Lead; busy: string; onStatus: (lead: Lead, status: LeadStatus) => void }) {
  const facts = Object.entries(lead.details).map(([key, value]) => `${detailLabel(key)}: ${detailValue(value)}`).join(" · ");
  return <tr>
    <td>{timeLabel(lead.receivedAt)}</td>
    <td>{leadSourceLabels[lead.source]}{lead.test && <> <span className="admin-status admin-status-muted">Test</span></>}</td>
    <td>{leadKindLabels[lead.kind]}{facts && <small className="leads-facts">{facts}</small>}</td>
    <td>{lead.contact.name ?? "—"}{lead.contact.role && <small>{lead.contact.role}</small>}</td>
    <td>{lead.contact.organization ?? "—"}</td>
    <td><a href={mailtoHref(lead.contact.email)}>{lead.contact.email}</a>{lead.contact.phone && <small>{lead.contact.phone}</small>}</td>
    <td className="team-wide">{attributionSummary(lead.attribution)}</td>
    <td>
      <select value={lead.status} disabled={Boolean(busy)} aria-label={`Status for ${who(lead)}`}
        onChange={event => onStatus(lead, event.target.value as LeadStatus)}>
        {leadStatuses.map(status => <option key={status} value={status}>{leadStatusLabels[status]}</option>)}
      </select>
    </td>
    <td>{lead.conversation ? <ConversationLink reference={lead.conversation.reference} /> : <span className="muted">None</span>}</td>
  </tr>;
}

/** Every website lead from CareBase, Intel and Healthcare Advisors, newest first, with its status and conversation. */
export function Leads({ client = leadsClient }: { client?: LeadsClient }) {
  const [kind, setKind] = useState<LeadKind | "">("");
  const [source, setSource] = useState<LeadSource | "">("");
  const [includeTest, setIncludeTest] = useState(false);
  const [offset, setOffset] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState<Notice>(null);
  const reload = useCallback(() => setRefresh(value => value + 1), []);
  const reader = useCallback((signal: AbortSignal) => {
    void refresh;
    return client.list({ kind: kind || null, source: source || null, includeTest, offset, limit: pageSize }, { signal });
  }, [client, kind, source, includeTest, offset, refresh]);
  const state = useAdminRead(reader);
  // Keep showing the last page while a refresh is in flight, so a status change never blanks the list.
  const [kept, setKept] = useState<{ data: LeadPage; receivedAt: Date } | null>(null);
  if (state.status === "ready" && kept?.data !== state.data) setKept({ data: state.data, receivedAt: state.receivedAt });
  const shown = state.status === "ready" ? state : kept;
  const filtered = Boolean(kind || source);
  // A new filter or page is a different list: show it loading instead of the last one.
  const filter = (change: () => void) => { change(); setOffset(0); setKept(null); setNotice(null); };
  const page = (next: number) => { setOffset(next); setKept(null); };

  const onStatus = async (lead: Lead, status: LeadStatus) => {
    if (busy || status === lead.status) return;
    setBusy(lead.id); setNotice(null);
    try {
      await client.setStatus({ id: lead.id, status, expectedUpdatedAt: lead.updatedAt });
      setNotice({ ok: true, text: `${who(lead)} is marked ${leadStatusLabels[status].toLowerCase()}.` });
    } catch (error) {
      setNotice({ ok: false, text: failureText(error) });
    } finally {
      setBusy(""); reload();
    }
  };

  return <div className="leads">
    <div className="page-heading"><div><span className="eyebrow">CareMetric Admin</span><h1><UserPlus size={22} aria-hidden="true" /> Leads</h1>
      <p>Every lead from the CareBase, Intel and Healthcare Advisors websites, newest first. A person who asked to be contacted also has a conversation in Communications, where you reply.</p></div>
      <button type="button" className="button button-secondary" onClick={reload} disabled={state.status === "loading"}><RefreshCw size={16} aria-hidden="true" /> Refresh</button></div>
    {notice && <p role={notice.ok ? "status" : "alert"} className={notice.ok ? "admin-explanation" : "form-message form-error"}>{notice.text}</p>}
    <section className="panel" aria-labelledby="leads-list-title">
      <div className="admin-section-title"><div><h2 id="leads-list-title">Leads</h2>
        <p>Contact details are what the visitor typed. What they wrote is kept only in the conversation, never here.</p></div></div>
      <div className="leads-filters">
        <label className="team-field">Kind
          <select value={kind} onChange={event => filter(() => setKind(event.target.value as LeadKind | ""))}>
            <option value="">All kinds</option>{leadKinds.map(value => <option key={value} value={value}>{leadKindLabels[value]}</option>)}</select></label>
        <label className="team-field">Product
          <select value={source} onChange={event => filter(() => setSource(event.target.value as LeadSource | ""))}>
            <option value="">All products</option>{leadSources.map(value => <option key={value} value={value}>{leadSourceLabels[value]}</option>)}</select></label>
        <label className="leads-toggle"><input type="checkbox" checked={includeTest} onChange={event => filter(() => setIncludeTest(event.target.checked))} /> Show test leads</label>
      </div>
      {!shown && state.status === "loading" && <Loading label="Loading leads" app="Hub" />}
      {state.status === "error" && <ReadFailure error={state.error} retry={reload} />}
      {shown && <>
        <p className="admin-read-time">Loaded {timeLabel(shown.receivedAt)}.</p>
        {shown.data.items.length === 0 && shown.data.offset > 0
          // Leads were deleted since this page was chosen (retention, for one), so nothing is left this far back.
          ? <div className="button-row team-paging">
            <span className="muted" role="status">No leads on this page now ({leadCount(shown.data.total)} in all).</span>
            <button type="button" className="button button-secondary button-small" onClick={() => page(0)}>First page</button>
          </div>
          : shown.data.items.length === 0
          ? <p className="admin-explanation">{filtered || includeTest ? "No leads match these filters." : "No leads yet. They appear here as soon as CareBase, Intel or Advisors forwards one."}</p>
          : <>
            <div className="portfolio-table-wrap"><table className="coverage-matrix team-table leads-table"><caption className="sr-only">Leads, newest first</caption>
              <thead><tr>{["Received", "Product", "Kind", "Name", "Organization", "Email", "Source", "Status", "Conversation"].map(label => <th key={label} scope="col">{label}</th>)}</tr></thead>
              <tbody>{shown.data.items.map(lead => <LeadRow key={`${lead.id}:${lead.updatedAt}`} lead={lead} busy={busy} onStatus={(item, status) => void onStatus(item, status)} />)}</tbody>
            </table></div>
            <Pager data={shown.data} onPage={page} />
          </>}
      </>}
    </section>
  </div>;
}
