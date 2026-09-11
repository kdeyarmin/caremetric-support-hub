import { useRef, useState } from "react";
import { z } from "zod";
import { requestAdmin } from "../admin/transport";
import { learningReceiptOperationSchema, projectReceiptResult, receiptAccessResultSchema, receiptReconciliationSchema, receiptStatusSchema, type LearningReceiptOperation } from "./receiptProtocol";
import { receiptSetupId } from "./receiptSetupIntent";

async function run(operation: LearningReceiptOperation) {
  const parsed = learningReceiptOperationSchema.parse(operation);
  return projectReceiptResult(await requestAdmin("learning-receipts", parsed, new AbortController().signal), parsed);
}
export function ReceiptPanel() {
  const [data, setData] = useState<z.infer<typeof receiptStatusSchema> | null>(null);
  const [busy, setBusy] = useState(false); const [message, setMessage] = useState(""); const [error, setError] = useState("");
  const [organization, setOrganization] = useState(""); const [employee, setEmployee] = useState("");
  const [user, setUser] = useState(""); const [name, setName] = useState(""); const [snapshot, setSnapshot] = useState("");
  const setupIds = useRef(new Map<string, string>());
  const [reviewed, setReviewed] = useState(false);
  const [access, setAccess] = useState<z.infer<typeof receiptAccessResultSchema> | null>(null);
  const [reconciliation, setReconciliation] = useState<z.infer<typeof receiptReconciliationSchema> | null>(null);
  const load = async () => setData(receiptStatusSchema.parse(await run({ operation: "status" })));
  async function action(work: () => Promise<void>) {
    setBusy(true); setError(""); setMessage("");
    try { await work(); await load(); }
    catch { setError("The request did not finish. A recent administrator sign-in and enabled learning bridge are required. Completed steps are retained; retry the same request after resolving access or connectivity."); }
    finally { setBusy(false); }
  }
  return <section className="panel learning-notice" aria-label="CareBase completion receipts"><div>
    <h2>CareBase completion receipts</h2><p>Preserve future completion evidence in the Hub while CareBase continues to issue assignments, credits, and certificates. Existing records are never imported.</p>
    <button disabled={busy} onClick={() => void action(load)}>Load administrator setup</button>
    {error && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}
    {data && <>
      <p>Showing up to 100 recent mappings, receipt records, accounts, and source snapshots. Total: {data.mappingTotal} mappings and {data.receiptTotal} receipt records.</p>
      <form onSubmit={e => { e.preventDefault(); void action(async () => {
        const existing = data.tenants.find(t => t.nativeOrganizationId.toLowerCase() === organization.trim().toLowerCase());
        const intent = { operation: "provision_access" as const, nativeOrganizationId: organization.trim(), nativeEmployeeId: employee.trim(), tenantName: existing?.name ?? name.trim(), hubUserId: user };
        const result = receiptAccessResultSchema.parse(await run({ ...intent, hubTenantId: existing?.hubTenantId ?? receiptSetupId(setupIds.current, intent) }));
        setAccess(result); setMessage("Explicit tenant and principal access is ready. Case intake remains disabled for new tenants.");
      }); }}>
        <h3>1. Review tenant and learner access</h3>
        <p>Use verified CareBase organization and employee IDs. Each organization gets a separate Hub tenant. Select the same person's existing Hub account; names and email addresses are never used to match accounts.</p>
        <label>CareBase organization ID<input required value={organization} onChange={e => { setOrganization(e.target.value); setAccess(null); setReviewed(false); }} /></label>
        <label>CareBase employee ID<input required value={employee} onChange={e => { setEmployee(e.target.value); setAccess(null); setReviewed(false); }} /></label>
        <label>New Hub tenant name<input value={name} onChange={e => setName(e.target.value)} minLength={2} maxLength={180} /></label>
        <label>Existing Hub account<select required value={user} onChange={e => { setUser(e.target.value); setAccess(null); setReviewed(false); }}><option value="">Select account</option>{data.users.map(u => <option key={u.id} value={u.id}>{u.displayName} · {u.id}</option>)}</select></label>
        <p>If the learner has no Hub account, complete account onboarding first. This setup does not create or invite users.</p>
        <label><input type="checkbox" checked={reviewed} onChange={e => setReviewed(e.target.checked)} />I reviewed this native employee and existing Hub account as the same person and authorize customer access for this product only.</label>
        <button disabled={busy || !reviewed}>Provision reviewed access</button>
      </form>
      <form onSubmit={e => { e.preventDefault(); if (access) void action(async () => {
        const intent = { operation: "provision" as const, sourceSnapshotId: snapshot, nativeOrganizationId: access.nativeOrganizationId,
          nativeEmployeeId: access.nativeEmployeeId, hubTenantId: access.hubTenantId, hubUserId: access.hubUserId };
        await run({ ...intent, mappingId: receiptSetupId(setupIds.current, intent) });
        setMessage("Future assignments to this exact course version will capture receipts. Existing assignments remain native only.");
      }); }}>
        <h3>2. Bind an exact reviewed course version</h3>
        <label>Preserved published source snapshot<select required value={snapshot} onChange={e => setSnapshot(e.target.value)}><option value="">Select source snapshot</option>{data.snapshots.map(s => <option value={s.id} key={s.id}>{s.title} · {s.sourceVersionId} · {s.sourceRevision.slice(0, 12)}</option>)}</select></label>
        <button disabled={busy || !access}>Bind future assignments</button>
      </form>
      <h3>3. Reconcile captured receipts</h3><p>Receipts with changed source policies stay quarantined for review. Withdrawal changes Hub reporting evidence and preserves earned CareBase records.</p>
      <button disabled={busy} onClick={() => void action(async () => { const result = receiptReconciliationSchema.parse(await run({ operation: "reconcile", limit: 10 })); setReconciliation(result); setMessage(`${result.accepted} acknowledged; ${result.quarantined} quarantined; ${result.failed} need retry or review.`); })}>Reconcile up to 10 receipts</button>
      {reconciliation && <div aria-label="Last reconciliation details">
        <ul>{reconciliation.quarantineDetails.map(entry => <li key={entry.eventId}>{entry.eventId} · {{ mapping_disabled: "Receipt mapping was disabled", policy_drift: "Source policy changed", missing_renewal_evidence: "Required renewal evidence is missing", binding_identity_drift: "Bound learner identity changed", receipt_retracted: "Receipt was withdrawn", receipt_limits: "Evidence exceeds the reviewed delivery limits", needs_review: "Native evidence needs review" }[entry.reason]}</li>)}</ul>
        <ul>{reconciliation.retryEvents.map(eventId => <li key={eventId}>{eventId} · Delivery or acknowledgement needs retry. Resolve access or evidence conflicts before reconciling again.</li>)}</ul>
      </div>}
      <ul>{data.mappings.map(m => <li key={m.mappingId}>{m.mappingId} · {m.state} <button disabled={busy || m.state === "revoked"} onClick={() => void action(async () => { await run({ operation: "revoke", mappingId: m.mappingId }); setMessage("Receipt mapping revoked in both apps."); })}>Revoke receipt mapping</button></li>)}</ul>
      <ul>{data.receipts.map(r => <li key={r.assignmentId}>{r.assignmentId} · {r.kind} · sequence {r.sequence} <button disabled={busy || r.kind === "retracted"} onClick={() => void action(async () => { await run({ operation: "retract", assignmentId: r.assignmentId, expectedSequence: r.sequence }); setMessage("Withdrawal queued. Reconcile to update Hub reporting."); })}>Withdraw Hub receipt</button></li>)}</ul>
    </>}
  </div></section>;
}
