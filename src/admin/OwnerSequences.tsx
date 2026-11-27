import { useEffect, useState } from 'react';
import type { z } from 'zod';
import { growthMutation, growthPost, sequenceListSchema, sequencePrepareSchema, sequenceSchema } from './growthClient';

/** Why a row of the send list was left out, in the owner's words. */
const leftOut: Record<string, string> = {
  home_area: 'In Cambria County or a county bordering it',
  do_not_contact: 'Said no before: on the do-not-contact list',
  suppressed: 'On the suppression list (an earlier bounce, complaint or opt-out)',
  in_sequence: 'Already in an approved sequence',
  growth_contacted: 'The Marketing Manager emailed this agency in the last 90 days',
  ref: 'No usable reference (letters, digits, - or _)', email: 'No usable email address', agency: 'No agency name', county: 'No usable county',
  state: 'Not in Pennsylvania', setting: 'Setting is not hha or hospice', first_name: 'First name is not a plain name', ccn: 'CCN is not six characters',
  duplicate_ref: 'Reference repeated', duplicate_email: 'Address repeated', empty: 'The send list has no rows',
};
const reasonFor = (reason: string) => (reason.startsWith('missing_columns:') ? `The send list has no ${reason.slice(16).split(',').join(', ')} column` : leftOut[reason] ?? reason);
const stopped: Record<string, string> = {
  replied: 'Replied', opted_out: 'Said no: never again', left: 'Has left (automatic reply)', bounced: 'Bounced', complaint: 'Marked as spam: never again',
  unsubscribed: 'Unsubscribed: never again', suppressed: 'Suppressed', do_not_contact: 'On the do-not-contact list', owner: 'Stopped by you',
};
const matchNote = (notes: Record<string, unknown>) => [
  notes.noMatch === 'other_setting' ? 'Intel matched an agency of the other kind, so it gets the county report email'
    : notes.noMatch ? 'No confident CMS match, so it gets the county report email' : null,
  notes.noReport ? 'Intel has no report for its CCN, so it gets the county report email' : null,
  typeof notes.listCounty === 'string' ? `The report's county is used (the list said ${notes.listCounty})` : null,
  notes.countyUnchecked ? 'The report\'s county could not be checked' : null,
  typeof notes.autoReplyAt === 'string' ? `Out-of-office reply ${new Date(notes.autoReplyAt).toLocaleDateString()} (does not stop the sequence)` : null,
].filter(Boolean).join(' · ');
const day = (value: string) => new Date(`${value}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });

function SequenceDetail({ id, revision, onChange }: { id: string; revision: number; onChange: (message: string) => void }) {
  const [entry, setEntry] = useState<{ id: string; revision: number; data: z.infer<typeof sequenceSchema> } | null>(null);
  const [failure, setFailure] = useState(''); const [busy, setBusy] = useState(false); const [checked, setChecked] = useState(false);
  useEffect(() => {
    const c = new AbortController();
    void growthPost('sequence', { id }, sequenceSchema, c.signal).then(data => { if (!c.signal.aborted) { setEntry({ id, revision, data }); setFailure(''); } })
      .catch(e => { if (!c.signal.aborted) setFailure(e instanceof Error ? e.message : 'The sequence could not be loaded.'); });
    return () => c.abort();
  }, [id, revision]);
  const data = entry?.id === id ? entry.data : null;
  async function act(operation: string, input: unknown, done: string) {
    setBusy(true); setFailure('');
    try { await growthMutation(operation, input); onChange(done); } catch (e) { setFailure(e instanceof Error ? e.message : 'Result unconfirmed. Refresh before retrying.'); } finally { setBusy(false); }
  }
  if (failure && !data) return <p role="alert">{failure}</p>;
  if (!data) return <p role="status">Loading the sequence…</p>;
  const draft = data.status === 'draft';
  const blocked = data.people.filter(p => p.blocked);
  return <div aria-labelledby="sequence-detail-title">
    <h3 id="sequence-detail-title">{data.name}</h3>
    {failure && <p role="alert">{failure}</p>}
    <p>{data.people.length} people · emails on {data.sendDates.map(day).join(', ')} · {data.windowStart.slice(0, 5)} to {data.windowEnd.slice(0, 5)} Eastern, weekdays · at most {data.dailyLimit} a day · from {String(data.sender.fromName ?? 'the growth sender')}, replies to the support inbox · status: {data.status}</p>
    {draft && <p>Read every email below. Nothing is sent until you approve, and then each goes out exactly as shown, as plain text, on its date.</p>}
    {blocked.length > 0 && <p role="alert">{blocked.map(p => `${p.ref}: ${reasonFor(p.blocked ?? '')}`).join('; ')}. Discard this draft and prepare it again without them.</p>}
    <table><thead><tr><th>Ref</th><th>Agency</th><th>Person</th><th>First email</th><th>Status</th></tr></thead><tbody>
      {data.people.map(p => <tr key={p.id}><td>{p.ref}</td><td>{p.agency}<br /><small>{p.setting === 'hospice' ? 'Hospice' : 'Home health'} · {p.county} County{p.ccn ? ` · CCN ${p.ccn}` : ''}</small></td>
        <td>{p.firstName ?? '(no first name: "Hi there,")'}<br /><small>{p.email}</small></td>
        <td>{p.reportUrl ? <a href={p.reportUrl} target="_blank" rel="noopener noreferrer">Its market report</a> : 'Free county report'}{matchNote(p.notes) && <><br /><small>{matchNote(p.notes)}</small></>}</td>
        <td>{p.status === 'stopped' ? stopped[p.stopReason ?? ''] ?? p.stopReason : p.status}{p.openedAt && <><br /><small>Opened its report {new Date(p.openedAt).toLocaleDateString()}</small></>}
          {data.status === 'approved' && p.status === 'active' && <><br /><button disabled={busy} onClick={() => void act('sequenceStop', { id: data.id, recipient: p.id }, `Stopped ${p.ref}.`)}>Stop {p.ref}</button></>}</td></tr>)}
    </tbody></table>
    {data.people.map(p => <details key={p.id}><summary>{p.ref} · {p.agency} · {p.messages.map(m => m.status).join(' / ')}</summary>
      {p.messages.map(m => <div key={m.id}><p><strong>Email {m.step} · {day(m.sendOn)} · {m.status}</strong>{m.attemptedAt ? ` · sent ${new Date(m.attemptedAt).toLocaleString()}` : ''}</p>
        <p>To: {p.email}<br />Subject: {m.subject}</p><pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit' }}>{m.body}</pre></div>)}
    </details>)}
    {draft && <form onSubmit={e => { e.preventDefault(); void act('sequenceApprove', { id: data.id, version: data.version }, `Approved. The first emails go out ${day(data.sendDates[0])} from ${data.windowStart.slice(0, 5)} Eastern.`); }}>
      <label><input type="checkbox" checked={checked} onChange={e => setChecked(e.target.checked)} /> I read every email above, and each may go out exactly as written</label>
      <button className="button button-primary" disabled={busy || !checked || blocked.length > 0}>Approve and schedule</button>
      <button type="button" className="button" disabled={busy} onClick={() => void act('sequenceDiscard', { id: data.id }, 'Draft discarded.')}>Discard this draft</button>
    </form>}
    {data.status === 'approved' && <button className="button" disabled={busy} onClick={() => void act('sequenceStop', { id: data.id }, 'Sequence stopped. Nothing more goes out.')}>Stop the whole sequence</button>}
  </div>;
}

/** Growth → Your own sequences: prepare a send list with the owner's copy, read every email, approve, then watch it go. */
export function OwnerSequencesPanel({ revision }: { revision: number }) {
  const [entry, setEntry] = useState<{ revision: number; data: z.infer<typeof sequenceListSchema> } | null>(null);
  const [reload, setReload] = useState(0); const [failure, setFailure] = useState(''); const [notice, setNotice] = useState('');
  const [selected, setSelected] = useState<string | null>(null); const [busy, setBusy] = useState(false); const [csv, setCsv] = useState('');
  const [problems, setProblems] = useState<z.infer<typeof sequencePrepareSchema>['problems']>([]);
  useEffect(() => {
    const c = new AbortController();
    void growthPost('sequences', {}, sequenceListSchema, c.signal).then(data => { if (!c.signal.aborted) { setEntry({ revision, data }); setFailure(''); } })
      .catch(e => { if (!c.signal.aborted) setFailure(e instanceof Error ? e.message : 'Your sequences could not be loaded.'); });
    return () => c.abort();
  }, [revision, reload]);
  const data = entry?.data;
  if (failure && !data) return <section className="panel"><h2>Your own sequences</h2><p role="alert">{failure}</p></section>;
  if (!data) return <section className="panel"><h2>Your own sequences</h2><p role="status">Loading your sequences…</p></section>;
  const s = data.services;
  const missing = [!s.enabled && 'turn on Settings → Customer growth → Send your own email sequences', !s.mail && 'set up SendGrid and the growth sender in Settings → Email',
    !s.signing && 'set the growth signing key (HUB_GROWTH_SIGNING_KEY) in Railway', !s.feed && 'set HUB_INTEL_FEED_SECRET in Railway so agencies can be matched to their reports'].filter(Boolean);
  const template = data.templates[0];
  async function prepare(form: FormData) {
    setBusy(true); setFailure(''); setNotice(''); setProblems([]);
    try {
      const dates = Array.from({ length: template?.steps ?? 3 }, (_, i) => String(form.get(`date${i + 1}`) ?? ''));
      const answer = await growthPost('sequencePrepare', { name: String(form.get('name') ?? ''), csv, template: template?.id, campaign: String(form.get('campaign') ?? ''), sendDates: dates,
        dailyLimit: Number(form.get('dailyLimit') ?? 8) }, sequencePrepareSchema, undefined, 300_000);
      setProblems(answer.problems);
      if (answer.saved) { setSelected(answer.saved.id); setNotice('Prepared. Read every email, then approve it below.'); setReload(n => n + 1); }
      else setNotice('Nothing was prepared: every row was left out.');
    } catch (e) { setFailure(e instanceof Error ? e.message : 'The sequence could not be prepared.'); } finally { setBusy(false); }
  }
  return <section className="panel" aria-labelledby="owner-sequences-title"><h2 id="owner-sequences-title">Your own sequences</h2>
    <p>Your words, sent as written: plain text, from the growth sender in your name, one email every five minutes on weekdays in the morning window. Any reply, a bounce or a "no thanks" stops that person, and a "no" keeps the address and the agency off every later list. Replies land in Communications and wait for you.</p>
    {missing.length > 0 && <p role="status">Before anything is sent: {missing.join('; ')}.</p>}
    {notice && <p role="status">{notice}</p>}{failure && <p role="alert">{failure}</p>}
    <details className="panel"><summary>Prepare a sequence from a send list</summary>
      <form onSubmit={e => { e.preventDefault(); void prepare(new FormData(e.currentTarget)); }}>
        <p>Copy: {template?.label ?? 'none available'}. The send list is a CSV with one row per person: ref, first_name, email, agency_display, agency_name_for_matching, city, county, setting (hha or hospice), and optionally state, website and ccn. Rows in Cambria County or the seven counties bordering it are always left out.</p>
        <label>Name<input name="name" maxLength={120} required defaultValue="Pennsylvania cold email, batch 1" /></label>
        <label>Campaign tag (utm_campaign)<input name="campaign" pattern="[a-z0-9-]{1,60}" required defaultValue="pa-cold-email" /></label>
        {Array.from({ length: template?.steps ?? 3 }, (_, i) => <label key={i}>Email {i + 1} date<input type="date" name={`date${i + 1}`} required /></label>)}
        <label>Most emails a day<input type="number" name="dailyLimit" min={1} max={30} defaultValue={8} required /></label>
        <label>Send list (CSV file)<input type="file" accept=".csv,text/csv" onChange={e => { const file = e.target.files?.[0]; if (file) void file.text().then(setCsv); }} /></label>
        <label>Or paste it<textarea value={csv} onChange={e => setCsv(e.target.value)} rows={6} maxLength={30000} /></label>
        <button className="button button-primary" disabled={busy || !csv.trim() || !template}>{busy ? 'Preparing: matching each agency and checking its report…' : 'Prepare the emails'}</button>
      </form>
      {problems.length > 0 && <><h3>Left out</h3><ul>{problems.map((p, i) => <li key={i}>{[p.ref, p.agency].filter(Boolean).join(' · ') || `Row ${p.row}`}: {reasonFor(p.reason)}</li>)}</ul></>}
    </details>
    {data.sequences.length > 0 && <table><thead><tr><th>Sequence</th><th>Dates</th><th>Status</th><th>People</th><th>Sent / waiting</th><th>Replied / opened</th></tr></thead><tbody>
      {data.sequences.map(q => <tr key={q.id}><td><button onClick={() => setSelected(q.id)}>{q.name}</button></td><td>{q.sendDates.map(day).join(', ')}</td><td>{q.status}</td>
        <td>{q.people}{q.stopped ? ` (${q.stopped} stopped)` : ''}</td><td>{q.sent} / {q.scheduled}</td><td>{q.replied} / {q.opened}</td></tr>)}
    </tbody></table>}
    {!data.sequences.length && <p>No sequences yet.</p>}
    {selected && <SequenceDetail id={selected} revision={revision + reload} onChange={message => { setNotice(message); setReload(n => n + 1); }} />}
  </section>;
}
