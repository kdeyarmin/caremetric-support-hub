import { describe, expect, it, vi } from 'vitest';
import { agencyDisplay, buildSendList, decider, firstNameOf, hostedSite, nextBatchDates, sequenceBatches } from './sequence-batches.mjs';
import { ownerSequences, readSendList } from './owner-sequence.mjs';

const feature = 'platform.agents.owner-sequence-batches.v1';
const ownerRole = '5% OR GREATER DIRECT OWNERSHIP INTEREST';
const person = (name, title, email, source = 'cms_owners') => ({ name, title, email, source });
const candidate = (n, overrides = {}) => ({
  id: `org-${n}`, name: `AGENCY ${n} HOME HEALTH LLC`, domain: `agency${n}.example`, patients: 500 - n,
  targets: [{ ccn: `39${String(8000 + n)}`, name: `AGENCY ${n} HOME HEALTH LLC`, setting: 'home_health', city: 'Plains', countyFips: '42079', patients: 500 - n }],
  people: [person(`JANE DOE${'X'.repeat(n % 3)}`, ownerRole, `jdoe@agency${n}.example`)], ...overrides,
});
const ownersOf = list => new Map(list.map(c => [c.targets[0].ccn, { ccn: c.targets[0].ccn, owners: [{ name: c.people[0]?.name ?? 'JANE DOE', kind: 'individual', role: ownerRole, percentage: 100, data_year: '2026' }] }]));
const counties = new Map([['42079', 'Luzerne'], ['42091', 'Montgomery']]);

describe('the next batch\'s dates', () => {
  it('starts on a Tuesday at least four days out and a week after the last batch, then that Friday and the next Wednesday', () => {
    expect(nextBatchDates('2026-11-27')).toEqual(['2026-12-01', '2026-12-04', '2026-12-09']);
    expect(nextBatchDates('2026-11-27', '2026-12-08')).toEqual(['2026-12-15', '2026-12-18', '2026-12-23']);
    expect(nextBatchDates('2026-11-28')).toEqual(['2026-12-08', '2026-12-11', '2026-12-16']);
    expect(nextBatchDates('2026-12-14', '2026-12-08')).toEqual(['2026-12-22', '2026-12-25', '2026-12-30']);
  });
});

describe('screening an agency', () => {
  it('tells a page builder\'s site (no mailbox of its own) from an agency\'s own domain', () => {
    for (const domain of ['elitehomehealthcare.lovable.app', 'deermeadowshomehealth.weebly.com', 'kathleenchupka.dr-leonardo.com', 'x.wixsite.com']) expect(hostedSite(domain)).toBe(true);
    for (const domain of ['maylathhealth.com', 'athomerehabllc.com', 'wix-home-health.com']) expect(hostedSite(domain)).toBe(false);
  });

  it('writes to the person who decides, preferring one CMS lists as an owner, never a title that does not decide', () => {
    const owners = [{ name: 'DOROTHY MAYLATH', kind: 'individual', role: ownerRole }];
    expect(decider([person('Pat Nurse', 'Director of Nursing', 'pnurse@x.example', 'website'), person('DOROTHY MAYLATH', 'Administrator/Owner', 'dmaylath@x.example', 'npi_registry')], owners))
      .toMatchObject({ email: 'dmaylath@x.example', owner: true, rank: 0 });
    expect(decider([person('Lisa Deornellas', 'Executive Director', 'lisad@x.example', 'website')], [])).toMatchObject({ email: 'lisad@x.example', rank: 3 });
    expect(decider([person('Pat Nurse', 'Director of Nursing', 'pnurse@x.example', 'website'), person('Sam Seller', 'Marketing', 'sam@x.example', 'website')], [])).toBeNull();
    expect(decider([person('Info Desk', 'Owner', null, 'website')], [])).toBeNull();
  });

  it('greets a person and names an agency as people write them', () => {
    expect(firstNameOf('DOROTHY MAYLATH')).toBe('Dorothy');
    expect(firstNameOf('Jennifer Guglielmi')).toBe('Jennifer');
    expect(firstNameOf('MARY-ANN SMITH, RN')).toBe('Mary-Ann');
    expect(firstNameOf('McKenzie Doe')).toBe('McKenzie');
    expect(firstNameOf('info')).toBeNull();
    expect(agencyDisplay('COMPASS HOME HEALTH & REHAB LLC')).toBe('Compass Home Health & Rehab');
    expect(agencyDisplay('Hospice For All Seasons, LLC')).toBe('Hospice For All Seasons');
    expect(agencyDisplay('MAYLATH VALLEY HEALTH SYSTEMS, INC.')).toBe('Maylath Valley Health Systems');
  });
});

describe('the send list', () => {
  it('takes agencies in the database\'s order up to the batch size, whoever owns them, leaves out the ones that fail a check, and reads back as a send list', () => {
    const list = [candidate(1, { domain: 'agency1.weebly.com' }), candidate(2), candidate(3, { people: [person('Pat Nurse', 'Director of Nursing', 'pnurse@agency3.example', 'website')] }),
      candidate(4, { name: 'SMITH, JONES & CO HOME CARE, INC.', targets: [{ ...candidate(4).targets[0], name: 'SMITH, JONES & CO HOME CARE, INC.', setting: 'hospice' }] }),
      candidate(5, { targets: [{ ...candidate(5).targets[0], countyFips: '42999' }] }), candidate(6), candidate(7), candidate(8)];
    const facts = ownersOf(list);
    facts.set(list[5].targets[0].ccn, { ccn: list[5].targets[0].ccn, owners: [{ name: 'BIG CAPITAL PARTNERS LP', kind: 'organization', role: ownerRole }] });
    facts.set(list[2].targets[0].ccn, { ccn: list[2].targets[0].ccn, owners: [{ name: 'JANE ROE', kind: 'individual', role: ownerRole }] });
    const out = buildSendList(list, { size: 3, number: 3, facts, counties });
    // Agency 6 is owned by a company (CMS): it is taken all the same (owner, 2026-11-27: no agency is off limits).
    expect(out.people.map(p => [p.ref, p.ccn])).toEqual([['pa-b3-01', list[1].targets[0].ccn], ['pa-b3-02', list[3].targets[0].ccn], ['pa-b3-03', list[5].targets[0].ccn]]);
    expect(out.skipped).toEqual([{ agency: 'AGENCY 1 HOME HEALTH LLC', reason: 'no_website_of_its_own' }, { agency: 'AGENCY 3 HOME HEALTH LLC', reason: 'no_decider' },
      { agency: 'AGENCY 5 HOME HEALTH LLC', reason: 'county_unknown' }]);
    // Without CMS's owners, the people's own titles decide.
    expect(buildSendList(list, { size: 3, number: 3, counties }).people.map(p => p.ref)).toEqual(['pa-b3-01', 'pa-b3-02', 'pa-b3-03']);
    const read = readSendList(out.csv);
    expect(read.problems).toEqual([]);
    expect(read.people[1]).toMatchObject({ ref: 'pa-b3-02', agency: 'Smith, Jones & Co Home Care', matchName: 'SMITH, JONES & CO HOME CARE, INC.', county: 'Luzerne', setting: 'hospice',
      domain: 'agency4.example', ccn: list[3].targets[0].ccn, firstName: 'Jane', email: 'jdoe@agency4.example' });
  });
});

describe('the weekly builder', () => {
  const ready = [candidate(1), candidate(2), candidate(3), candidate(4)];
  function builder({ plan = { due: true, owner: 'u1', lastFirstDate: '2026-12-08', lastNumber: 2, candidates: ready }, queued = { queued: true, id: 'req-9', approve: true },
    enabled = true, features = new Set([feature]), size = 3, handedOver = [] } = {}) {
    const store = { batchPlan: vi.fn(async () => plan), batchQueue: vi.fn(async () => queued) };
    const feed = { configured: true, agencyFacts: vi.fn(async ({ ccns }) => ({ agencies: ccns.map(ccn => ownersOf(ready).get(ccn)) })),
      counties: vi.fn(async () => ({ counties: [{ county_fips: '42079', county_name: 'Luzerne County', state: 'PA' }] })) };
    const notifier = { send: vi.fn(async () => []) };
    return { store, feed, notifier, batches: sequenceBatches({ store, feed, features, enabled, size, handedOver, now: () => new Date('2026-11-27T20:00:00Z') }) };
  }

  it('queues the next batch in the owner\'s name with next week\'s dates and tells the owner who is in it', async () => {
    const { store, feed, notifier, batches } = builder();
    const out = await batches.build({ notifier, task: { agentKey: 'marketing_manager', id: 't1' } });
    expect(out).toEqual({ queued: 'req-9', people: 3, approve: true });
    expect(store.batchPlan).toHaveBeenCalledWith(15);
    expect(feed.agencyFacts).toHaveBeenCalledWith({ ccns: ready.map(c => c.targets[0].ccn), signal: undefined });
    const payload = store.batchQueue.mock.calls[0][0];
    expect(payload).toMatchObject({ name: 'Pennsylvania cold email, batch 3', campaign: 'pa-cold-email', template: 'intel-pa-cold-2026-11',
      sendDates: ['2026-12-15', '2026-12-18', '2026-12-23'], dailyLimit: 3 });
    expect(readSendList(payload.csv).people.map(p => p.ref)).toEqual(['pa-b3-01', 'pa-b3-02', 'pa-b3-03']);
    const told = notifier.send.mock.calls[0][0];
    expect(told).toMatchObject({ subject: 'The AI team picked Pennsylvania cold email, batch 3 (3 agencies)', attention: 'update', dedupeKey: 'owner-sequence:batch:req-9' });
    expect(told.body).toContain('pa-b3-01: Agency 1 Home Health (Luzerne County, home health)');
    expect(told.body).toContain('approves it');
  });

  it('stops once Pennsylvania is Instantly\'s (Settings → Customer growth → States Instantly sends to)', async () => {
    const handed = builder({ handedOver: ['OH', 'PA'] });
    expect(await handed.batches.build()).toEqual({ skipped: 'instantly' });
    expect(handed.store.batchPlan).not.toHaveBeenCalled();
    expect((await builder({ handedOver: ['OH'] }).batches.build()).queued).toBe('req-9');
  });

  it('does nothing while off or undeclared, waits when no batch is due or too few agencies are ready, and never builds without the feed', async () => {
    expect(await builder({ enabled: false }).batches.build()).toBeNull();
    expect(await builder({ features: new Set() }).batches.build()).toBeNull();
    expect(await builder({ plan: { due: false, why: 'built_this_week' } }).batches.build()).toEqual({ skipped: 'built_this_week' });
    expect(await builder({ plan: { due: true, lastNumber: 2, candidates: ready.slice(0, 2) } }).batches.build()).toEqual({ skipped: 'too_few_ready', ready: 2 });
    const noFeed = builder();
    noFeed.feed.configured = false;
    expect(await noFeed.batches.build()).toEqual({ skipped: 'feed' });
    const lost = builder({ queued: { queued: false, why: 'request_waiting' } });
    expect(await lost.batches.build({ notifier: lost.notifier })).toEqual({ skipped: 'request_waiting' });
    expect(lost.notifier.send).not.toHaveBeenCalled();
  });

  it('runs before the sequences\' own work, and a failure never holds back their emails', async () => {
    const store = { review: vi.fn(async () => ({ stopped: [], opened: [] })), claim: vi.fn(async () => ({ send: false, status: 'none_due' })) };
    const build = vi.fn(async () => { throw Object.assign(new Error('feed down'), { code: 'feed_unavailable' }); });
    const sequences = ownerSequences({ store, features: new Set(['platform.agents.owner-sequences.v1']), enabled: true, mail: { configured: true, send: vi.fn() },
      unsubscribeToken: key => key, hash: value => value, batches: { build } });
    const out = await sequences.run({ agent: { autonomy: 'act' } });
    expect(out.result).toMatchObject({ batch: { failed: 'feed_unavailable' }, sent: 0, status: 'none_due' });
    expect(store.claim).toHaveBeenCalled();
  });
});
