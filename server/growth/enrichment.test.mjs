import { describe, expect, it, vi } from 'vitest';
import { enrichProspects, evidenceSearchLimit, evidenceTargets } from './enrichment.mjs';
import { growthHandlers } from './worker.mjs';
import { discoveryQueriesPerDay } from './playbook.mjs';

const day = new Date('2026-11-11T13:00:00Z');
const prospect = (domain, extra = {}) => ({ domain, product: 'caremetric-intel', owner_agent: 'marketing_manager', stage: 'researched',
  fit: 60, internal: false, tenant_id: null, eligibility: 'review', ...extra });
const permitted = { eligibility: 'permitted', verified_at: '2026-11-10T12:00:00Z' };
const row = (domain, extra = {}) => ({ domain, name: 'An operator', url: `https://${domain}/about`, claim: 'Operates a healthcare business.', ...extra });

describe('daily prospect evidence enrichment', () => {
  it('prioritizes permitted contacts, rotates both pools without starvation and keeps a hard provider-call bound', () => {
    const items = [...Array.from({ length: 24 }, (_, i) => prospect(`ready${i}.example`, permitted)),
      ...Array.from({ length: 24 }, (_, i) => prospect(`other${i}.example`))];
    const seen = new Set();
    for (let offset = 0; offset < 24; offset++) {
      const selected = evidenceTargets(items, ['caremetric-intel'], new Date(day.getTime() + offset * 86_400_000));
      expect(selected).toHaveLength(evidenceSearchLimit);
      expect(new Set(selected.map(item => item.domain)).size).toBe(evidenceSearchLimit);
      // Two contact-ready prospects for each of the others, in that order, so neither pool starves the other.
      expect(selected.slice(0, 3).map(item => item.domain.slice(0, 5))).toEqual(['ready', 'ready', 'other']);
      expect(selected.filter(item => item.domain.startsWith('other'))).toHaveLength(Math.floor(evidenceSearchLimit / 3));
      selected.forEach(item => seen.add(item.domain));
    }
    expect(seen.size).toBe(48);
    // One pool alone fills every search.
    expect(evidenceTargets(items.filter(item => item.domain.startsWith('other')), ['caremetric-intel'], day)).toHaveLength(evidenceSearchLimit);
    expect(evidenceTargets(items.toReversed(), ['caremetric-intel'], day)).toEqual(evidenceTargets(items, ['caremetric-intel'], day));
  });

  it('excludes other products, customers, internal records, clear non-fits, opted-out contacts and unsafe domains', () => {
    const items = [prospect('good.example', { fit: null }), prospect('qualified.example', { fit: 75 }),
      prospect('no-fit.example', { fit: 29 }), prospect('customer.example', { tenant_id: 'tenant' }),
      prospect('internal.example', { internal: true }), prospect('lost.example', { stage: 'lost' }),
      prospect('wrong-owner.example', { owner_agent: 'account_manager' }), prospect('pilot.example', { product: 'carebase' }),
      prospect('optout.example', { eligibility: 'opted_out' }), prospect('unknown.example', { product: 'unknown' }),
      ...['localhost', '127.0.0.1', 'good.example site:other.example', 'https://good.example', 'bad..example', '-bad.example'].map(domain => prospect(domain))];
    expect(evidenceTargets(items, ['caremetric-intel'], day)).toEqual([{ product: 'caremetric-intel', domain: 'good.example' }]);
    expect(evidenceTargets(items, [], day)).toEqual([]);
    expect(evidenceTargets(items, null, new Date('2026-11-11T01:00:00Z'))).toEqual(evidenceTargets(items, null, new Date('2026-11-10T22:00:00Z')));
  });

  it('paginates the snapshot and stores bounded same-domain evidence through the existing insert only', async () => {
    const items = [prospect('one.example', permitted), prospect('two.example'), prospect('three.example'), prospect('four.example')];
    const store = { snapshot: vi.fn(async offset => ({ total: items.length, items: items.slice(offset, offset + 2) })),
      discover: vi.fn(async (_product, rows) => rows.length), assess: vi.fn(), autoQualify: vi.fn() };
    const research = { search: vi.fn(async (_product, { domain }) => [row('other.example'), row(domain, { url: 'https://wrong.example/about' }),
      row(domain, { url: `https://user:password@${domain}/about` }), row(domain, { url: `https://${domain}:444/about` }),
      ...Array.from({ length: 15 }, (_, i) => row(`www.${domain}`, { url: `https://www.${domain}/${i}` }))]) };
    const result = await enrichProspects({ growth: { store, research }, marketed: ['caremetric-intel'], moment: day });
    expect(store.snapshot.mock.calls).toEqual([[0], [2]]);
    expect(research.search).toHaveBeenCalledTimes(4);
    expect(store.discover).toHaveBeenCalledTimes(4);
    expect(result).toEqual({ searched: 4, evidenceRows: 40 });
    // A pipeline the caller has already read is not read again.
    store.snapshot.mockClear();
    expect(await enrichProspects({ growth: { store, research }, marketed: ['caremetric-intel'], moment: day, items: items.slice(0, 1) })).toEqual({ searched: 1, evidenceRows: 10 });
    expect(store.snapshot).not.toHaveBeenCalled();
    for (const [, rows] of store.discover.mock.calls) {
      expect(rows).toHaveLength(10);
      expect(rows.every(item => item.url.startsWith(`https://www.${item.domain}/`))).toBe(true);
    }
    expect(store.assess).not.toHaveBeenCalled();
    expect(store.autoQualify).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('.example');
  });

  it('starts no search once the run\'s time is spent, and leaves the rest for the next run', async () => {
    const items = Array.from({ length: 6 }, (_, i) => prospect(`slow${i}.example`));
    const store = { discover: vi.fn(async (_product, rows) => rows.length) };
    let searches = 0;
    const research = { search: vi.fn(async (_product, { domain }) => { searches += 1; return [row(domain)]; }) };
    // Out of time after the second search.
    const result = await enrichProspects({ growth: { store, research }, marketed: null, moment: day, items, spent: () => searches >= 2 });
    expect(result).toEqual({ searched: 2, evidenceRows: 2 });
    expect(research.search).toHaveBeenCalledTimes(2);
    // Already out of time: nothing is searched.
    research.search.mockClear();
    expect(await enrichProspects({ growth: { store, research }, marketed: null, moment: day, items, spent: () => true })).toEqual({ searched: 0, evidenceRows: 0 });
    expect(research.search).not.toHaveBeenCalled();
  });

  it('propagates provider failures and aborts before storing or searching the next organization', async () => {
    const stop = new AbortController();
    const store = { snapshot: vi.fn(async () => ({ total: 2, items: [prospect('one.example'), prospect('two.example')] })), discover: vi.fn() };
    const research = { search: vi.fn(async () => { stop.abort(); return [row('one.example')]; }) };
    await expect(enrichProspects({ growth: { store, research }, marketed: null, moment: day, signal: stop.signal })).rejects.toBeDefined();
    expect(research.search).toHaveBeenCalledTimes(1);
    expect(store.discover).not.toHaveBeenCalled();
    research.search.mockRejectedValue(Object.assign(new Error('Rate limited'), { code: 'research_unavailable', transient: true }));
    await expect(enrichProspects({ growth: { store, research }, marketed: null, moment: day })).rejects.toMatchObject({ transient: true });
  });

  it('keeps the stored organization domain when an owner originally entered a www prefix', async () => {
    const store = { snapshot: vi.fn(async () => ({ total: 1, items: [prospect('www.operator.example')] })),
      discover: vi.fn(async () => 1) };
    const research = { search: vi.fn(async () => [row('operator.example')]) };
    await enrichProspects({ growth: { store, research }, marketed: null, moment: day });
    expect(research.search).toHaveBeenCalledWith('caremetric-intel', { domain: 'operator.example', signal: undefined });
    expect(store.discover).toHaveBeenCalledWith('caremetric-intel', [expect.objectContaining({ domain: 'www.operator.example' })]);
  });

  it('adds enrichment to discovery, never Observe or the fifteen-minute pipeline', async () => {
    const store = { snapshot: vi.fn(async () => ({ total: 1, items: [prospect('operator.example', { assessed_at: '2026-11-01T00:00:00Z', evidence: [] })] })),
      discover: vi.fn(async (_product, rows) => rows.length), plan: vi.fn() };
    const search = vi.fn(async (_product, options) => options.domain ? [row(options.domain)] : []);
    const handlers = growthHandlers({ growth: { store, research: { configured: true, search } }, marketed: ['caremetric-intel'] });
    const result = await handlers['growth.discovery']({ agent: { autonomy: 'propose' } }, { now: () => day });
    expect(result.result).toEqual({ candidates: 0, searches: discoveryQueriesPerDay, enrichment: { searched: 1, evidenceRows: 1 } });
    expect(search).toHaveBeenCalledTimes(discoveryQueriesPerDay + 1);
    search.mockClear();
    await handlers['growth.discovery']({ agent: { autonomy: 'observe' } }, { now: () => day });
    await handlers['growth.pipeline']({ kind: 'growth.pipeline', agent: { autonomy: 'propose' } }, { now: () => day });
    expect(search).not.toHaveBeenCalled();
  });
});
