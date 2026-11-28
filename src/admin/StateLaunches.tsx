import { useEffect, useState } from 'react';
import type { z } from 'zod';
import { growthMutation, growthPost, launchDetailSchema, launchListSchema } from './growthClient';

type Launch = z.infer<typeof launchListSchema>['launches'][number];

const segmentWords: Record<string, string> = {
  agency: 'Home health & hospice owners', snf: 'Skilled nursing administrators', local: 'Local nursing homes', chain: 'Chains – corporate',
  regional: 'Regional groups – leadership',
};
/** Why a facility is not in a campaign, in the owner's words. */
const noteWords: Record<string, string> = {
  hospital_based: 'In a hospital', government: 'Run by a government', same_chain: 'Its chain\'s head office gets the email',
  same_group: 'Its group\'s leadership gets the email', home_area: 'In Cambria County, your home county', national_chain: 'A national chain',
  same_name: 'The same business as another agency', no_domain: 'No website of its own found', domain_mismatch: 'The website Hunter found was another business\'s',
  no_person: 'Nobody who decides found', search_limit: 'Not looked up: the state\'s Hunter searches ran out', do_not_contact: 'On the do-not-contact list',
  suppressed: 'On the suppression list', in_sequence: 'In one of your own sequences', growth_contacted: 'The Marketing Manager emailed it in the last 90 days',
  same_person: 'The same person as another facility', same_business: 'The same business as another facility', already_in_instantly: 'Already in Instantly',
};
const statusWords: Record<string, string> = {
  pending: 'To look up', held: 'Left out', found: 'Found', not_found: 'Not found', added: 'In a campaign', skipped: 'Left out', replied: 'Replied',
  opted_out: 'Said no: never again', bounced: 'Bounced',
};
const num = (value: unknown) => (typeof value === 'number' ? value : Number(value ?? 0) || 0);

function stateOf(l: Launch) {
  const p = l.progress as Record<string, unknown>;
  const looked = num(p.looked);
  if (l.status === 'queued') return 'Waiting to start';
  if (l.status === 'building') {
    if (p.waiting === 'instantly') return 'Waiting for the Instantly API key in Railway';
    if (p.waiting === 'senders') return 'Waiting for Instantly mailboxes in Settings';
    if (l.stage === 'gather') return 'Gathering the state\'s facilities';
    if (l.stage === 'contacts') return `Finding people: ${looked} looked up, ${num(p.found)} found, ${num(p.hunterSearches)} Hunter searches`;
    return 'Building the Instantly campaigns';
  }
  if (l.status === 'ready') return `Ready: ${num((l.summary as Record<string, unknown>).leads)} people in draft campaigns${(l.summary as Record<string, unknown>).builtByHand ? ', built by hand on November 28' : ''}. Nothing is sent until you click Launch.`;
  if (l.status === 'launching') return 'Starting the campaigns in Instantly';
  if (l.status === 'launched') return `Sending since ${l.launchedAt ? new Date(l.launchedAt).toLocaleDateString() : 'launch'}`;
  if (l.status === 'failed') return `Stopped: ${l.error ?? 'unknown'}. Nothing was sent.`;
  return 'Cancelled';
}

function LaunchDetail({ id, revision }: { id: string; revision: number }) {
  const [rows, setRows] = useState<z.infer<typeof launchDetailSchema> | null>(null);
  const [failure, setFailure] = useState(''); const [show, setShow] = useState<'people' | 'all'>('people');
  useEffect(() => {
    const c = new AbortController();
    void growthPost('launch', { id }, launchDetailSchema, c.signal).then(data => { if (!c.signal.aborted) { setRows(data); setFailure(''); } })
      .catch(e => { if (!c.signal.aborted) setFailure(e instanceof Error ? e.message : 'The launch could not be loaded.'); });
    return () => c.abort();
  }, [id, revision]);
  if (failure) return <p role="alert">{failure}</p>;
  if (!rows) return <p role="status">Loading the facilities…</p>;
  if (!rows.length) return <p>This state was built by hand: its people are in its Instantly campaigns and on your cold email sheet.</p>;
  const shown = (show === 'people' ? rows.filter(r => r.email) : rows).slice(0, 500);
  return <div>
    <p><button className="button" onClick={() => setShow(show === 'people' ? 'all' : 'people')}>{show === 'people' ? `Show all ${rows.length} facilities` : 'Show only the people found'}</button></p>
    <table><thead><tr><th>Facility</th><th>Campaign</th><th>Person</th><th>Status</th></tr></thead><tbody>
      {shown.map(r => <tr key={r.id}><td>{r.name}<br /><small>{r.setting === 'nursing_home' ? 'Nursing home' : r.setting === 'hospice' ? 'Hospice' : 'Home health'}{r.city ? ` · ${r.city}` : ''}{r.county ? ` · ${r.county} County` : ''}{r.chainName ? ` · ${r.chainName}` : ''}</small></td>
        <td>{segmentWords[r.segment] ?? r.segment}</td>
        <td>{r.personName ?? '—'}{r.title && <><br /><small>{r.title}</small></>}{r.email && <><br /><small>{r.email}</small></>}</td>
        <td>{statusWords[r.status] ?? r.status}{r.note && <><br /><small>{noteWords[r.note] ?? r.note}</small></>}</td></tr>)}
    </tbody></table>
    {shown.length < (show === 'people' ? rows.filter(r => r.email).length : rows.length) && <p>The first 500 are shown.</p>}
  </div>;
}

/** Growth → State launches: choose the next state, and launch it once the AI team has built it in Instantly. */
export function StateLaunchesPanel({ revision }: { revision: number }) {
  const [entry, setEntry] = useState<z.infer<typeof launchListSchema> | null>(null);
  const [reload, setReload] = useState(0); const [failure, setFailure] = useState(''); const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false); const [state, setState] = useState(''); const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    const c = new AbortController();
    void growthPost('launches', {}, launchListSchema, c.signal).then(data => { if (!c.signal.aborted) { setEntry(data); setFailure(''); } })
      .catch(e => { if (!c.signal.aborted) setFailure(e instanceof Error ? e.message : 'State launches could not be loaded.'); });
    return () => c.abort();
  }, [revision, reload]);
  async function act(operation: string, input: unknown, done: string) {
    setBusy(true); setFailure(''); setNotice('');
    try { await growthMutation(operation, input); setNotice(done); setReload(n => n + 1); }
    catch (e) { setFailure(e instanceof Error ? e.message : 'Result unconfirmed. Refresh before retrying.'); } finally { setBusy(false); }
  }
  if (!entry) return <section className="panel"><h2>State launches</h2>{failure ? <p role="alert">{failure}</p> : <p role="status">Loading state launches…</p>}</section>;
  const s = entry.services;
  const names = new Map(entry.states.map(x => [x.code, x.name]));
  // One state at a time: the next one is chosen once the open one is launched or cancelled.
  const openLaunch = entry.launches.find(l => ['queued', 'building', 'ready', 'launching'].includes(l.status));
  const missing = [!entry.enabled && 'turn on Settings → Customer growth → Build state launches in Instantly',
    !s.instantly && 'paste an Instantly API key (all scopes, from Instantly\'s Settings → Integrations) into Railway as INSTANTLY_API_KEY',
    !s.hunter && 'set HUNTER_API_KEY in Railway so people can be found',
    !s.feed && 'set HUB_INTEL_FEED_SECRET in Railway so home health agencies, hospices and county reports are included',
    !s.senders && 'choose the sending mailboxes in Settings → Customer growth → Instantly mailboxes for state launches',
    !s.webhook && 'set the growth signing key (HUB_GROWTH_SIGNING_KEY) in Railway so replies and opt-outs come back'].filter(Boolean);
  return <section className="panel" aria-labelledby="state-launches-title"><h2 id="state-launches-title">State launches</h2>
    <p>Choose the next state. The Marketing Manager finds its nursing homes, home health agencies and hospices, a decision-maker with a checked address at each, and builds draft Instantly campaigns with your copy, the way Pennsylvania was built. You are told when it is ready. Nothing is sent until you click Launch. A "yes" gets its county report; a "no thanks" goes on the do-not-contact list.</p>
    {missing.length > 0 && <p role="status">Before a state can be built: {missing.join('; ')}.</p>}
    {notice && <p role="status">{notice}</p>}{failure && <p role="alert">{failure}</p>}
    {openLaunch ? <p role="status">One state at a time: finish {names.get(openLaunch.state) ?? openLaunch.state} first. Launch it (or cancel it), then choose the next state here.</p>
      : <form onSubmit={e => { e.preventDefault(); if (state) void act('launchRequest', { state }, `${names.get(state) ?? state} is queued. You'll be told when it is ready to launch.`); }}>
        <label>Next state<select value={state} onChange={e => setState(e.target.value)} required>
          <option value="">Choose a state…</option>
          {entry.states.map(x => <option key={x.code} value={x.code}>{x.name}</option>)}
        </select></label>
        <button className="button button-primary" disabled={busy || !state}>Build this state</button>
      </form>}
    {entry.launches.length > 0 ? <table><thead><tr><th>State</th><th>Where it is</th><th>Campaigns</th><th /></tr></thead><tbody>
      {entry.launches.map(l => {
        const name = names.get(l.state) ?? l.state;
        const campaigns = Object.entries(l.campaigns);
        const pendingLeft = (l.summary as Record<string, unknown>).pendingLeft === true;
        return <tr key={l.id}><td>{name}</td><td>{stateOf(l)}</td>
          <td>{campaigns.length ? campaigns.map(([segment, c]) => <div key={segment}>{c.name}: {c.leads} people{c.started ? ' · sending' : ''}</div>) : '—'}</td>
          <td>
            {l.status === 'ready' && campaigns.length > 0 && <button className="button button-primary" disabled={busy} onClick={() => void act('launchApprove', { id: l.id }, `${name} is starting. The campaigns begin sending within five minutes, on weekdays from 8:00.`)}>Launch {name}</button>}
            {l.status === 'ready' && pendingLeft && <button className="button" disabled={busy} onClick={() => void act('launchMore', { id: l.id }, `Looking for more people in ${name}.`)}>Find more people</button>}
            {['queued', 'building', 'ready', 'failed'].includes(l.status) && <button className="button" disabled={busy} onClick={() => void act('launchCancel', { id: l.id }, `${name} cancelled. Campaigns already made stay in Instantly as drafts.`)}>Cancel</button>}
            <button className="button" onClick={() => setOpen(open === l.id ? null : l.id)}>{open === l.id ? 'Hide facilities' : 'Facilities'}</button>
          </td></tr>;
      })}
    </tbody></table> : <p>No state launches yet.</p>}
    {open && <LaunchDetail id={open} revision={revision + reload} />}
  </section>;
}
