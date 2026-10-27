import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { selfServiceClient } from './client';
import { deduplicateProfile, type ProfileRecord } from './protocol';
import { config } from '../lib/config';

const labels = { current: 'Current', expiring: 'Expiring soon', expired: 'Expired', pending_review: 'Pending review', assigned: 'Assigned', missing: 'Missing', historical: 'Historical / renewed', rejected: 'Not accepted', not_applicable: 'Not applicable' };
const csvCell = (value: string) => `"${(/^[=+@\-\t\r]/.test(value) ? "'" : '') + value.replaceAll('"', '""')}"`;
export function TrainingProfile() {
  const [records, setRecords] = useState<ProfileRecord[]>([]);
  const [failures, setFailures] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  const [filter, setFilter] = useState('all');
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      if (config.demoMode) { setLoading(false); return; }
      setLoading(true); setFailures([]);
      const next: ProfileRecord[] = [], errors: string[] = [];
      const hub = await selfServiceClient.hubLearning(controller.signal).catch(() => { errors.push('Shared CareMetric learning could not be loaded.'); return []; });
      next.push(...hub);
      const workspace = await selfServiceClient.workspace(controller.signal).catch(() => { errors.push('Linked application accounts could not be loaded.'); return null; });
      if (workspace) await Promise.all(workspace.connections.filter(connection => connection.capabilities.includes('training.profile.v1')).map(async connection => {
        try { next.push(...await selfServiceClient.profile(connection.id, controller.signal)); } catch { errors.push(`${connection.name} records could not be loaded. Open the application to refresh your connection.`); }
      }));
      if (!controller.signal.aborted) { setRecords(deduplicateProfile(next)); setFailures(errors); setLoading(false); }
    })();
    return () => controller.abort();
  }, [retry]);
  const visible = records.filter(record => filter === 'all' || record.status === filter);
  const attention = records.filter(record => ['expiring', 'expired', 'missing'].includes(record.status));
  function exportTranscript() {
    const rows = [['Source', 'Title', 'Type', 'Completed', 'Expires', 'Days remaining', 'Status', 'Source verification', 'Source revision'], ...records.map(record => [record.source, record.title, record.kind, record.completed_on ?? '', record.expires_on ?? 'No expiration recorded', record.days_remaining?.toString() ?? '', labels[record.status], record.verification_status ?? '', record.source_revision ?? ''])];
    const blob = new Blob([rows.map(row => row.map(csvCell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob), anchor = document.createElement('a'); anchor.href = url; anchor.download = 'caremetric-training-transcript.csv'; anchor.click(); URL.revokeObjectURL(url);
  }
  return <div className="learning-workspace"><header><span className="eyebrow">My account</span><h1>My profile &amp; training</h1><p>Training, certifications, expiration dates, and retained history from your verified CareMetric accounts.</p></header>
    <nav className="learning-links print-hidden"><Link to="/self-service">Customer center</Link><Link to="/learn/my">My learning</Link><Link to="/security">Account security</Link></nav>
    {loading && <p role="status">Loading your training records…</p>}
    {failures.length > 0 && <section className="panel" role="alert"><h2>Some records are unavailable</h2>{failures.map(error => <p key={error}>{error}</p>)}<button className="button button-secondary" onClick={() => setRetry(value => value + 1)}>Retry records</button></section>}
    {!loading && <><section className="panel"><h2>{attention.length} items need attention{failures.length ? ' in the available records' : ''}</h2><p>Renewal notices follow the rules in the application that owns the record. Reviewed renewals retain their previous evidence.</p>{attention.map(record => <p key={`${record.source}:${record.id}`}><strong>{record.title}</strong> · {labels[record.status]}{record.expires_on ? ` · due ${record.expires_on.slice(0, 10)}` : ''}</p>)}</section>
      <section className="panel"><div className="panel-heading"><h2>Full training history</h2><div className="print-hidden"><button className="button button-secondary" disabled={!records.length} onClick={exportTranscript}>Export transcript</button> <button className="button button-secondary" onClick={() => window.print()}>Print</button></div></div>
        <label className="print-hidden">Status <select value={filter} onChange={event => setFilter(event.target.value)}><option value="all">All records</option>{Object.entries(labels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        {!visible.length ? <p>{records.length ? 'No records match this status.' : 'Your profile is ready. Complete shared learning or open customer self-service in an application to connect its training records.'}</p> : <div className="billing-table-wrap"><table className="billing-table"><thead><tr><th>Training or credential</th><th>Completed</th><th>Expires / due</th><th>Status</th><th /></tr></thead><tbody>{visible.map(record => <tr key={`${record.source}:${record.id}`}><td><strong>{record.title}</strong><br /><small>{record.source} · {record.kind.replaceAll('_', ' ')}</small></td><td>{record.completed_on?.slice(0, 10) ?? '—'}</td><td>{record.expires_on?.slice(0, 10) ?? 'No expiration recorded'}{record.days_remaining != null && <small className="block">{record.days_remaining < 0 ? `${-record.days_remaining} days overdue` : `${record.days_remaining} days remaining`}</small>}</td><td>{labels[record.status]}</td><td>{record.href && <a className="button button-secondary button-small" href={record.href}>Open record / evidence</a>}</td></tr>)}</tbody></table></div>}
      </section></>}
  </div>;
}
