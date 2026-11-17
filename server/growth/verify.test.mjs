import { describe, expect, it, vi } from 'vitest';
import { growthAddressCheckFeature, growthExecutors, growthHandlers } from './worker.mjs';
import { growthDiagnosticsFeature, guardAlert, verifyHandlers, verifyPerRun } from './verify.mjs';

const features = new Set([growthAddressCheckFeature]);
const task = { id: 'task', agentKey: 'marketing_manager', agent: { autonomy: 'act' }, kind: 'growth.verify' };
const clear = { on: true, tripped: false, percent: 5, sent: 3, bounced: 0, complaints: 0, since: '2026-11-16T00:00:00.000Z' };
const handler = ({ candidates = [], guard = clear, mailbox = null, notifier = null, record = null, clock, declared = features } = {}) => {
  const store = {
    sendGuardState: vi.fn(async () => guard),
    mailboxCandidates: vi.fn(async () => candidates),
    mailboxRecord: vi.fn(record ?? (async (_id, result) => ({ result, eligibility: result === 'rejected' ? 'undeliverable' : 'permitted', cancelled: result === 'rejected' ? 1 : 0 }))),
  };
  const run = verifyHandlers({ growth: { store, people: { mailbox } }, features: declared, notifier, ...(clock ? { clock } : {}) })['growth.verify'];
  return { store, run };
};
const checker = answers => ({ configured: true, available: () => true,
  check: vi.fn(async (domain, [address]) => (typeof answers[address] === 'object' ? answers[address] : { result: answers[address] ?? 'unknown' })) });

describe('checking an address before the first email (20261116100000_growth_address_check.sql)', () => {
  it('is registered only with the feature declared', () => {
    expect(verifyHandlers({ growth: { store: { mailboxCandidates: vi.fn() } } })).toEqual({});
    expect(Object.keys(verifyHandlers({ growth: { store: { mailboxCandidates: vi.fn() } }, features }))).toEqual(['growth.verify']);
  });

  it('counts the answers the verification service gave when the mail server would not, and records them as answers', async () => {
    const mailbox = checker({ 'info@a.example.org': { result: 'verified', email: 'info@a.example.org', via: 'service' },
      'info@b.example.org': { result: 'rejected', via: 'service' } });
    const { store, run } = handler({ mailbox, candidates: [{ id: 'a', email: 'info@a.example.org' }, { id: 'b', email: 'info@b.example.org' }] });
    const outcome = await run(task);
    expect(store.mailboxRecord.mock.calls).toEqual([['a', 'verified'], ['b', 'rejected']]);
    expect(outcome.result).toMatchObject({ checked: 2, verified: 1, rejected: 1, byService: 2 });
  });

  it('asks each handed-out address of its own business\'s mail server and records the answer, keeping only counts', async () => {
    const mailbox = checker({ 'info@dead.example.org': 'rejected', 'jane@live.example.org': { result: 'verified', email: 'jane@live.example.org' },
      'info@any.example.org': 'catch_all', 'info@quiet.example.org': { result: 'unknown', reason: 'temporary' } });
    const { store, run } = handler({ mailbox, candidates: [{ id: 'a', email: 'info@dead.example.org' }, { id: 'b', email: 'jane@live.example.org' },
      { id: 'c', email: 'info@any.example.org' }, { id: 'd', email: 'info@quiet.example.org' }] });
    const outcome = await run(task);
    expect(store.mailboxCandidates).toHaveBeenCalledWith(verifyPerRun);
    expect(mailbox.check.mock.calls.map(([domain, addresses]) => [domain, addresses])).toEqual([
      ['dead.example.org', ['info@dead.example.org']], ['live.example.org', ['jane@live.example.org']],
      ['any.example.org', ['info@any.example.org']], ['quiet.example.org', ['info@quiet.example.org']]]);
    expect(store.mailboxRecord.mock.calls).toEqual([['a', 'rejected'], ['b', 'verified'], ['c', 'catch_all'], ['d', 'unknown']]);
    expect(outcome.result).toEqual({ guard: 'clear', checked: 4, verified: 1, rejected: 1, catch_all: 1, unknown: 1, undeliverable: 1, cancelled: 1,
      why: { temporary: 1 } });
    expect(JSON.stringify(outcome)).not.toMatch(/@/);
  });

  it('records why a server gave no answer once the diagnostics feature is declared, as one of a few fixed reasons', async () => {
    const mailbox = checker({ 'info@a.example.org': { result: 'unknown', reason: 'temporary' }, 'info@b.example.org': { result: 'unknown', reason: 'blocked' },
      'info@c.example.org': { result: 'unreachable' }, 'info@d.example.org': { result: 'unknown', reason: '550 5.7.1 go away' },
      'info@e.example.org': { result: 'unknown' }, 'info@f.example.org': 'catch_all' });
    const { store, run } = handler({ mailbox, declared: new Set([growthAddressCheckFeature, growthDiagnosticsFeature]),
      candidates: ['a', 'b', 'c', 'd', 'e', 'f'].map(id => ({ id, email: `info@${id}.example.org` })) });
    const outcome = await run(task);
    expect(store.mailboxRecord.mock.calls).toEqual([['a', 'unknown', 'temporary'], ['b', 'unknown', 'blocked'], ['c', 'unreachable', 'unreachable'],
      ['d', 'unknown', 'error'], ['e', 'unknown', 'error'], ['f', 'catch_all', null]]);
    expect(outcome.result).toMatchObject({ checked: 6, unknown: 4, unreachable: 1, catch_all: 1, why: { temporary: 1, blocked: 1, unreachable: 1, error: 2 } });
    expect(JSON.stringify(outcome)).not.toMatch(/@|550|go away/);
  });

  it('keeps the STARTTLS reasons (a server that asks for TLS without offering it, a TLS conversation that failed) as their own', async () => {
    const mailbox = checker({ 'info@a.example.org': { result: 'unknown', reason: 'tls_required' }, 'info@b.example.org': { result: 'unknown', reason: 'tls_failed' } });
    const { store, run } = handler({ mailbox, declared: new Set([growthAddressCheckFeature, growthDiagnosticsFeature]),
      candidates: ['a', 'b'].map(id => ({ id, email: `info@${id}.example.org` })) });
    const outcome = await run(task);
    expect(store.mailboxRecord.mock.calls).toEqual([['a', 'unknown', 'tls_required'], ['b', 'unknown', 'tls_failed']]);
    expect(outcome.result).toMatchObject({ why: { tls_required: 1, tls_failed: 1 } });
  });

  it('spends no try while the mail servers are out of reach, and asks nothing without a host name to introduce the Hub', async () => {
    const resting = { configured: true, available: () => false, check: vi.fn() };
    const first = handler({ mailbox: resting, candidates: [{ id: 'a', email: 'info@a.example.org' }] });
    expect((await first.run(task)).result).toMatchObject({ checked: 0, stopped: 'mail_servers_unreachable' });
    expect(resting.check).not.toHaveBeenCalled();
    expect(first.store.mailboxRecord).not.toHaveBeenCalled();
    const unnamed = handler({ mailbox: { configured: false, check: vi.fn() }, candidates: [{ id: 'a', email: 'info@a.example.org' }] });
    expect((await unnamed.run(task)).result).toEqual({ guard: 'clear', skipped: 'checker_not_configured' });
    expect(unnamed.store.mailboxCandidates).not.toHaveBeenCalled();
  });

  it('records a checker failure as an unanswered try, skips an address the database refuses, and stops starting checks after two minutes', async () => {
    const mailbox = { configured: true, available: () => true, check: vi.fn(async () => { throw new Error('socket'); }) };
    const refused = Object.assign(new Error('Unknown contact'), { code: '22023' });
    let now = 0;
    const { store, run } = handler({ mailbox, candidates: [{ id: 'a', email: 'info@a.example.org' }, { id: 'b', email: 'info@b.example.org' }, { id: 'c', email: 'info@c.example.org' }],
      record: vi.fn().mockResolvedValueOnce({ eligibility: 'permitted' }).mockRejectedValueOnce(refused), clock: () => { now += 50_000; return now; } });
    const outcome = await run(task);
    expect(store.mailboxRecord.mock.calls).toEqual([['a', 'unknown'], ['b', 'unknown']]);
    expect(outcome.result).toMatchObject({ checked: 1, unknown: 1, stopped: 'time' });
  });

  it('tells the owner once a day while the bounce guard holds cold email, even with checking off', async () => {
    const notifier = { send: vi.fn() };
    const guard = { on: true, tripped: true, percent: 5, sent: 21, bounced: 2, complaints: 0, since: '2026-11-10T05:00:00.000Z' };
    const { run } = handler({ guard, notifier, mailbox: checker({}) });
    expect((await run(task, { now: () => new Date('2026-11-16T15:00:00Z') })).result).toMatchObject({ guard: 'tripped', alerted: true, checked: 0 });
    expect(notifier.send).toHaveBeenCalledWith(expect.objectContaining({ severity: 'warning', subject: 'Cold email is paused', dedupeKey: 'growth:bounce-guard:2026-11-16' }));
    expect(notifier.send.mock.calls[0][0].body).toMatch(/^2 of the 21 cold emails sent since 2026-11-10 bounced for good, above your 5% limit\. No cold email goes out until you resume it on Growth/);
    expect(guardAlert({ ...guard, complaints: 1 }).body).toMatch(/^Someone marked a cold email as spam\./);
    const off = handler({ guard: { on: false, tripped: false }, notifier: { send: vi.fn() }, mailbox: checker({}) });
    expect((await off.run(task)).result).toEqual({ checked: 0 });
  });

  it('does nothing in Observe', async () => {
    const { store, run } = handler({ mailbox: checker({}) });
    expect((await run({ ...task, agent: { autonomy: 'observe' } })).result).toEqual({ skipped: 'observe_only' });
    expect(store.sendGuardState).not.toHaveBeenCalled();
  });
});

describe('a first email waits for its address, and cold email for the bounce guard', () => {
  const o = { id: 'opp', product: 'caremetric-intel', stage: 'qualified', owner_agent: 'marketing_manager', internal: false, next_at: '2026-01-01T00:00:00Z', touches: 0, work: [], events: [],
    version: 4, contact_id: 'contact', contact_version: 7, eligibility: 'permitted', policy: { version: 9, approved_claim: 'Intel shows referral sources.' },
    evidence: [{ id: 'source', source_url: 'https://example.org', claim: 'A hospice.', observed_at: new Date().toISOString() }] };
  const sweep = async ({ hold, declared = true }) => {
    const store = { snapshot: vi.fn(async () => ({ total: 1, items: [o] })), plan: vi.fn(async () => 'work'), draft: vi.fn(async () => ({ id: 'message', status: 'draft' })), propose: vi.fn(),
      draftHold: vi.fn(async () => hold) };
    const model = { configured: true, run: vi.fn(async () => ({ outcome: 'completed', output: { subject: 'Referral sources', body: 'Which hospitals send your agency the most patients? Reply to this email and I will send the steps.', citations: ['source'], needsHuman: false } })) };
    const growth = { store, signingReady: true, hash: x => x, unsubscribeToken: () => 'token' };
    const outcome = await growthHandlers({ growth, model, features: declared ? features : null, marketed: ['caremetric-intel'] })['growth.pipeline']({ id: 'task', agent: { autonomy: 'propose' }, kind: 'growth.pipeline' });
    return { store, model, outcome };
  };

  it('pays for no draft while the address waits for its check or the guard holds cold email', async () => {
    for (const hold of ['address_unchecked', 'bounce_guard']) {
      const { store, model, outcome } = await sweep({ hold });
      expect(store.draftHold).toHaveBeenCalledWith('contact');
      expect(model.run).not.toHaveBeenCalled();
      expect(store.draft).not.toHaveBeenCalled();
      expect(outcome.result).toMatchObject({ planned: 1, drafted: 0, held: { [hold]: 1 } });
    }
  });

  it('asks nothing before the feature is declared', async () => {
    const { store, model } = await sweep({ hold: 'address_unchecked', declared: false });
    expect(store.draftHold).not.toHaveBeenCalled();
    expect(model.run).toHaveBeenCalled();
  });

  it('defers a held message before the send claim, and claims it once nothing holds it', async () => {
    const store = { sendHold: vi.fn().mockResolvedValueOnce('bounce_guard').mockResolvedValueOnce(null), claim: vi.fn(async () => ({ send: false, status: 'cancelled' })) };
    const exec = growthExecutors({ growth: { store, configured: () => true }, mail: { configured: true }, publicOrigin: 'https://hub.example.org', postalAddress: 'Test', features })['growth.message'];
    await expect(exec({ id: 'action', input: { messageId: 'm' } })).rejects.toMatchObject({ code: 'action_deferred' });
    expect(store.claim).not.toHaveBeenCalled();
    expect(await exec({ id: 'action', input: { messageId: 'm' } })).toEqual({ delivery: 'cancelled' });
    expect(store.claim).toHaveBeenCalledWith('m', 'action');
    const before = { sendHold: vi.fn(), claim: vi.fn(async () => ({ send: false, status: 'cancelled' })) };
    await growthExecutors({ growth: { store: before, configured: () => true }, mail: { configured: true } })['growth.message']({ id: 'action', input: { messageId: 'm' } });
    expect(before.sendHold).not.toHaveBeenCalled();
  });
});
