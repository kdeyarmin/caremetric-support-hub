import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal, flushSync } from "react-dom";
import type { TrainingClient } from "./trainingClient";
import { useAdminRead } from "./useAdminRead";
import { Loading, ReadFailure } from "./AdminReads";
import { dateBasisLabels, downloadTrainingCsv, trainingCells, trainingDate, trainingDateTime, trainingHeaders, trainingReportCsv, trainingReportScope } from "./trainingPresentation";
import type { TrainingReportFilters, TrainingReportPage, TrainingReportRow } from "./trainingPresentation";

export function TrainingReports({ client, organizationId, facilityId, certificatesOnly = false, onCancel }: {
  client: TrainingClient; organizationId: string; facilityId: string | null; certificatesOnly?: boolean;
  onCancel: (row: TrainingReportRow) => void;
}) {
  const [draft, setDraft] = useState<TrainingReportFilters>({ courseSearch: "", status: "all", dateBasis: certificatesOnly ? "certificate" : "assigned", dateFrom: null, dateThrough: null });
  const [filters, setFilters] = useState(draft), [offset, setOffset] = useState(0), [revision, setRevision] = useState(0);
  const [exporting, setExporting] = useState(false), [exportError, setExportError] = useState("");
  const [printable, setPrintable] = useState<{ report: TrainingReportPage; filters: TrainingReportFilters } | null>(null);
  const [certificate, setCertificate] = useState<TrainingReportRow | null>(null);
  const activeExport = useRef<AbortController | null>(null);
  useEffect(() => () => activeExport.current?.abort(), []);
  useEffect(() => {
    const clearPrint = () => setPrintable(null);
    window.addEventListener("afterprint", clearPrint);
    return () => window.removeEventListener("afterprint", clearPrint);
  }, []);
  const reader = useCallback(async (signal: AbortSignal) => {
    void revision;
    return await client.request({ domain: "training.v1", operation: "enrollments.report", organizationId, facilityId, ...filters, limit: 20, offset }, signal) as TrainingReportPage;
  }, [client, organizationId, facilityId, filters, offset, revision]);
  const state = useAdminRead(reader);
  const invalidDates = !!draft.dateFrom && !!draft.dateThrough && draft.dateFrom > draft.dateThrough;
  async function exportReport(format: "csv" | "print") {
    if (activeExport.current || state.status !== "ready") return;
    const controller = new AbortController(); activeExport.current = controller;
    const requestedFilters = { ...filters };
    setExporting(true); setExportError(""); setPrintable(null);
    try {
      const report = await client.request({ domain: "training.v1", operation: "enrollments.report", organizationId, facilityId, ...requestedFilters, limit: 10000, offset: 0 }, controller.signal) as TrainingReportPage;
      if (controller.signal.aborted) return;
      const csv = trainingReportCsv(report, requestedFilters);
      if (format === "csv") downloadTrainingCsv(csv);
      else { flushSync(() => setPrintable({ report, filters: requestedFilters })); window.print(); }
    } catch (caught) {
      if (!controller.signal.aborted) {
        setPrintable(null);
        const tooLarge = caught && typeof caught === "object" && "code" in caught && caught.code === "report_too_large";
        setExportError(tooLarge ? "This report is too large. Narrow the date range, course title or facility, then export again. No partial report was exported." : "The complete report could not be prepared. Check the connection or narrow the date range, course title or facility to at most 10,000 enrollments. No partial report was exported.");
      }
    } finally { activeExport.current = null; if (!controller.signal.aborted) setExporting(false); }
  }
  return <section className="panel training-report">
    <div className="panel-heading"><h3>{certificatesOnly ? "Issued certificates" : "Enrollment, completion and progress"}</h3></div>
    <div className="admin-section-body">
      <form className="training-filters" onSubmit={event => { event.preventDefault(); if (!invalidDates) { setFilters({ ...draft }); setOffset(0); setRevision(value => value + 1); setCertificate(null); setPrintable(null); } }}>
        <fieldset disabled={exporting}>
          <label>Course title<input type="search" maxLength={100} value={draft.courseSearch} onChange={event => setDraft({ ...draft, courseSearch: event.target.value })} /></label>
          <label>Enrollment status<select value={draft.status} onChange={event => setDraft({ ...draft, status: event.target.value as TrainingReportFilters["status"] })}>{["all", "assigned", "in_progress", "completed", "overdue", "paused", "canceled"].map(status => <option key={status} value={status}>{status.replaceAll("_", " ")}</option>)}</select></label>
          <label>Date basis<select value={draft.dateBasis} disabled={certificatesOnly} onChange={event => setDraft({ ...draft, dateBasis: event.target.value as TrainingReportFilters["dateBasis"] })}>{Object.entries(dateBasisLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label>From<input type="date" value={draft.dateFrom || ""} onChange={event => setDraft({ ...draft, dateFrom: event.target.value || null })} /></label>
          <label>Through<input type="date" value={draft.dateThrough || ""} onChange={event => setDraft({ ...draft, dateThrough: event.target.value || null })} /></label>
          <button className="button button-primary" disabled={invalidDates}>Run report</button>
        </fieldset>
      </form>
      {invalidDates && <p role="alert">The through date must be on or after the from date.</p>}
      {state.status === "loading" && <Loading label="Loading training report" />}
      {state.status === "error" && <ReadFailure error={state.error} retry={() => setRevision(value => value + 1)} />}
      {state.status === "ready" && <>
        <h4>{state.data.organization_name} · {state.data.facility_name || "All facilities"}</h4>
        <div className="training-metrics" aria-label="Training report totals">
          <div><strong>{state.data.students}</strong><span>Students</span></div><div><strong>{state.data.total}</strong><span>Enrollments</span></div>
          <div><strong>{state.data.completed}</strong><span>Completed</span></div><div><strong>{state.data.in_progress}</strong><span>In progress</span></div>
          <div><strong>{state.data.certificates}</strong><span>Certificates</span></div><div><strong>{state.data.completion_denominator ? `${Math.round(100 * state.data.completed / state.data.completion_denominator)}%` : "—"}</strong><span>Completion rate</span></div>
        </div>
        <p className="admin-explanation">{trainingReportScope(filters)}</p>
        <div className="training-actions"><button className="button button-secondary" disabled={exporting} onClick={() => void exportReport("csv")}>{exporting ? "Preparing complete report…" : "Export complete CSV"}</button><button className="button button-secondary" disabled={exporting} onClick={() => void exportReport("print")}>Print complete report</button></div>
        <div className="portfolio-table-wrap"><table><thead><tr>{["Student", "Facility", "Course", "Status", "Progress", "Due", "Completed", "Certificate", "Actions"].map(label => <th key={label}>{label}</th>)}</tr></thead><tbody>{state.data.rows.map(row => <tr key={row.id}>
          <td>{row.student}</td><td>{row.facility}</td><td>{row.course}</td><td>{row.status.replaceAll("_", " ")}</td><td><progress value={row.percent_complete} max={100} aria-label={`${row.student}: ${row.course} progress`} /> {row.percent_complete}%</td><td>{trainingDate(row.due_date)}</td><td>{trainingDate(row.completed_at)}</td>
          <td>{row.credential_number || "Not issued"}{row.certificate_id && <><small>{trainingDate(row.certificate_issued_at)} · {row.certificate_pdf_status}</small><button className="button button-secondary button-small" onClick={() => setCertificate(row)}>View / print certificate</button></>}</td>
          <td>{!["completed", "canceled"].includes(row.status) && <button className="button button-secondary button-small" onClick={() => onCancel(row)}>Cancel enrollment</button>}</td>
        </tr>)}</tbody></table></div>
        {!state.data.rows.length && <p>No enrollments match these filters.</p>}
        <div className="admin-pagination"><span>{state.data.rows.length} of {state.data.total} enrollments shown · Generated {trainingDateTime(state.data.generated_at)}</span><div><button className="button button-secondary button-small" disabled={offset === 0 || exporting} onClick={() => setOffset(Math.max(0, offset - 20))}>Previous report page</button><button className="button button-secondary button-small" disabled={offset + 20 >= state.data.total || exporting} onClick={() => setOffset(offset + 20)}>Next report page</button></div></div>
      </>}
      {exportError && <p role="alert">{exportError}</p>}
      {certificate?.certificate_id && <CertificatePreview key={certificate.certificate_id} client={client} organizationId={organizationId} certificateId={certificate.certificate_id} label={`${certificate.student} · ${certificate.course}`} close={() => setCertificate(null)} />}
    </div>
    {printable && createPortal(<div id="hub-training-print"><h1>Training enrollment, completion and certificates</h1><h2>{printable.report.organization_name} · {printable.report.facility_name || "All facilities"}</h2><p>Generated {trainingDateTime(printable.report.generated_at)} (Pennsylvania time)</p><p>{trainingReportScope(printable.filters)}</p><p>{printable.report.total} enrollments · {printable.report.students} students · {printable.report.completed} completed · {printable.report.certificates} certificates</p><table><thead><tr>{trainingHeaders.map(header => <th key={header}>{header}</th>)}</tr></thead><tbody>{printable.report.rows.map(row => <tr key={row.id}>{trainingCells(row).map((value, index) => <td key={index}>{value}</td>)}</tr>)}</tbody></table></div>, document.body)}
  </section>;
}

function CertificatePreview({ client, organizationId, certificateId, label, close }: { client: TrainingClient; organizationId: string; certificateId: string; label: string; close: () => void }) {
  const [revision, setRevision] = useState(0);
  const reader = useCallback(async (signal: AbortSignal) => {
    void revision;
    return await client.request({ domain: "training.v1", operation: "certificates.read", organizationId, certificateId }, signal) as { certificateId: string; status: "pending" | "processing" | "ready" | "failed"; url: string | null; expiresAt: string | null };
  }, [client, organizationId, certificateId, revision]);
  const state = useAdminRead(reader);
  return <section className="training-review" aria-label="Certificate preview"><h4>{label}</h4>
    {state.status === "loading" && <Loading label="Preparing certificate" />}
    {state.status === "error" && <ReadFailure error={state.error} retry={() => setRevision(value => value + 1)} />}
    {state.status === "ready" && (state.data.status === "ready" && state.data.url ? <p><a className="button button-primary" href={state.data.url} target="_blank" rel="noopener noreferrer">Open certificate PDF to print or save</a></p> : <p role="status">Certificate PDF: {state.data.status}. <button className="button button-secondary button-small" onClick={() => setRevision(value => value + 1)}>Check PDF again</button></p>)}
    <button className="button button-secondary button-small" onClick={close}>Close certificate preview</button>
  </section>;
}
