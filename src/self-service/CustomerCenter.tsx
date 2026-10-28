import { isCentralHubApp } from '../hubScope';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { z } from 'zod';
import { selfServiceClient } from './client';
import { diagnosticReport, type SelfServiceWorkspace } from './protocol';
import { config } from '../lib/config';

const accountsSchema = z.object({ accounts: z.array(z.object({ id: z.string(), name: z.string(), facility_id: z.string(), facility_name: z.string() })) });
const labels = { unlock: 'Unlock account', reset_link: 'Send password reset link', resend_invitation: 'Resend account setup link', temporary_password: 'Issue temporary password' } as const;
export function CustomerCenter({ organizationBilling = false }: { organizationBilling?: boolean }) {
  const [workspace, setWorkspace] = useState<SelfServiceWorkspace | null>(null);
  const [connectionId, setConnectionId] = useState('');
  const [accounts, setAccounts] = useState<z.infer<typeof accountsSchema>['accounts']>([]);
  const [target, setTarget] = useState('');
  const [action, setAction] = useState<keyof typeof labels>('reset_link');
  const [reason, setReason] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [receipt, setReceipt] = useState<unknown>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const [diagnostics, setDiagnostics] = useState<{ connectionId: string; name: string; checks: { name: string; status: string }[]; receipt: Awaited<ReturnType<typeof selfServiceClient.diagnosticSupport>> | null } | null>(null);
  const pendingDiagnostics = useRef<Record<string, string>>({});
  async function requestDiagnosticSupport(connection: SelfServiceWorkspace['connections'][number]) {
    const requestId = pendingDiagnostics.current[connection.id] ?? crypto.randomUUID();
    pendingDiagnostics.current[connection.id] = requestId;
    const receipt = await selfServiceClient.diagnosticSupport(connection.id, requestId);
    delete pendingDiagnostics.current[connection.id];
    setDiagnostics({ connectionId: connection.id, name: connection.name, checks: [], receipt });
  }
  useEffect(() => {
    const controller = new AbortController();
    if (!config.demoMode) void selfServiceClient.workspace(controller.signal).then(data => setWorkspace({ ...data, connections: data.connections.filter(connection => isCentralHubApp(connection.app)) })).catch(() => { if (!controller.signal.aborted) setError('Your application connections could not be loaded.'); });
    return () => controller.abort();
  }, [reload]);
  async function run(work: () => Promise<void>) { setBusy(true); setError(''); try { await work(); } catch (cause) { setError(cause instanceof Error ? cause.message : 'The action could not be completed.'); } finally { setBusy(false); } }
  const selected = workspace?.connections.find(connection => connection.id === connectionId);
  return <div className="learning-workspace"><header><span className="eyebrow">Customer self-service</span><h1>Manage your CareMetric services</h1><p>Employee access, training records, help, and support for your authorized applications.</p></header>
    {error && <div className="panel" role="alert"><p>{error}</p><button className="button button-secondary" onClick={() => { setError(''); setReload(value => value + 1); }}>Retry</button></div>}
    <div className="capability-grid">{[['/account/profile', 'My profile & training', 'Review certificates, expiration dates, history, and evidence.'], ['/subscriptions', 'Plans & add-ons', 'Compare services, preview charges, and manage subscriptions.'], ['/billing', 'Invoices & payments', 'Manage shared payment details and recover failed payments.'], ['/cases', 'Support requests', 'Track technical support and customer service issues.'], ['/knowledge', 'Knowledge base & FAQ', 'Find setup instructions, feature guides, and troubleshooting.'], ['/manuals', 'User manuals', 'Read and print instructions for your applications.'], ['/security', 'Account security', 'Manage sign-in and account protection.']].filter(([to]) => (to !== '/billing' || organizationBilling) && (to !== '/subscriptions' || organizationBilling || workspace?.connections.some(connection => connection.role !== 'member'))).map(([to, title, description]) => <Link className="panel" key={to} to={to}><h2>{title}</h2><p>{description}</p></Link>)}</div>
    <section className="panel"><h2>Connected applications</h2>{!workspace ? <p>{config.demoMode ? 'Sign in to connect your real application accounts.' : 'Loading connections…'}</p> : !workspace.connections.length ? <p>Open customer self-service from your application to connect it. Each connection verifies your application account and mobile number.</p> : workspace.connections.map(connection => <article key={connection.id}><h3>{connection.name}</h3><p>{connection.role.replaceAll('_', ' ')} · {connection.facilities.map(facility => facility.name).join(', ') || 'Personal account'}</p><button className="button button-secondary" disabled={busy} onClick={() => void run(async () => {
      const result = diagnosticReport.parse(await selfServiceClient.native(connection.id, { action: 'diagnostics.read' }));
      setDiagnostics({ connectionId: connection.id, name: connection.name, checks: result.checks, receipt: null });
    })}>Check connection</button> <button className="button button-secondary" disabled={busy || diagnostics?.connectionId === connection.id && diagnostics.receipt !== null} onClick={() => void run(() => requestDiagnosticSupport(connection))}>Get AI-assisted connection support</button><p>Creates a private support request with connection results. You can request a human at any time.</p></article>)}</section>
    {diagnostics && <section className="panel" role="status"><h2>{diagnostics.name} connection support</h2>{diagnostics.checks.length > 0 && <ul>{diagnostics.checks.map(check => <li key={check.name}>{check.name}: {check.status}</li>)}</ul>}{diagnostics.receipt && <><p>Support request #{diagnostics.receipt.case_number} is ready.{diagnostics.receipt.tool_state === 'unavailable' ? ' The application check was unavailable; support can follow up in the case.' : ' Your connection results are included for support.'}</p><Link to={`/cases?case=${diagnostics.receipt.case_id}`}>Open support request</Link></>}</section>}
    <section className="panel"><h2>Employee account recovery</h2><p>Choose an application to see employee accounts you can recover. Account-access changes always need your confirmation.</p>
      <label>Application<select disabled={busy} value={connectionId} onChange={event => { const id = event.target.value; setConnectionId(id); setAccounts([]); setTarget(''); setConfirmation(''); setReceipt(null); if (id) void run(async () => setAccounts(accountsSchema.parse(await selfServiceClient.native(id, { action: 'employees.list' })).accounts)); }}><option value="">Choose an application</option>{workspace?.connections.filter(connection => connection.role !== 'member' && connection.capabilities.includes('employee.recovery.v1')).map(connection => <option key={connection.id} value={connection.id}>{connection.name}</option>)}</select></label>
      {selected && <form className="sign-in-form" onSubmit={event => { event.preventDefault(); if (!target || busy) return; void run(async () => { const prepared = await selfServiceClient.prepare(connectionId, { action: 'recovery.execute', target, recovery_action: action, reason, request_id: crypto.randomUUID() }); setConfirmation(prepared.confirmation_id); }); }}>
        <label>Employee<select required value={target} disabled={busy} onChange={event => { setTarget(event.target.value); setConfirmation(''); setReceipt(null); }}><option value="">Choose an employee</option>{accounts.map(account => <option key={account.id} value={account.id}>{account.name} · {account.facility_name}</option>)}</select></label>
        <label>Action<select value={action} disabled={busy} onChange={event => { setAction(event.target.value as keyof typeof labels); setConfirmation(''); setReceipt(null); }}>{Object.entries(labels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label>How was the employee’s identity verified?<textarea required minLength={10} maxLength={500} value={reason} disabled={busy} onChange={event => { setReason(event.target.value); setConfirmation(''); }} /></label>
        {!confirmation && <button className="button button-primary" disabled={busy || !target || reason.trim().length < 10}>Review recovery</button>}
      </form>}
      {confirmation && <div className="panel"><p>Confirm <strong>{labels[action].toLowerCase()}</strong> for <strong>{accounts.find(account => account.id === target)?.name}</strong>. Their existing sessions will end.</p><button className="button button-primary" disabled={busy} onClick={() => void run(async () => { const value = await selfServiceClient.confirm(confirmation); setReceipt(value); setConfirmation(''); setReason(''); })}>Confirm recovery</button> <button className="button button-secondary" disabled={busy} onClick={() => setConfirmation('')}>Cancel</button></div>}
      {receipt !== null && <RecoveryReceipt value={receipt} onHide={() => setReceipt(null)} />}
    </section>
  </div>;
}
function RecoveryReceipt({ value, onHide }: { value: unknown; onHide: () => void }) {
  const parsed = z.object({ state: z.string(), temporary_password: z.string().optional(), expires_at: z.string().optional() }).safeParse(value);
  if (!parsed.success) return <p role="status">The application returned a receipt. Check its recovery history before repeating this action.</p>;
  return <div className="panel" role="status"><p>Recovery status: {parsed.data.state}</p>{parsed.data.temporary_password && <><p>Share this temporary password privately. It is shown once and expires after 30 minutes.</p><code className="recovery-secret">{parsed.data.temporary_password}</code>{parsed.data.expires_at && <p>Expires {new Date(parsed.data.expires_at).toLocaleString()}</p>}<button className="button button-secondary" onClick={onHide}>I have shared it; hide password</button></>}</div>;
}
