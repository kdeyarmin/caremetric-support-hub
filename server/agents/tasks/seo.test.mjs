import { describe, expect, it, vi } from 'vitest';
import { composeSeoReport, seoHandlers } from './seo.mjs';

const origin = 'https://support-hub-web-production.up.railway.app';
const finding = (code, severity, page = '/', detail = 'detail', title = `Title of ${code}`) => ({ code, severity, title, detail, page });
const result = (key, label, findings = [], overrides = {}) => {
  const counts = { high: 0, medium: 0, low: 0 };
  for (const item of findings) counts[item.severity] += 1;
  return { key, label, checked: 12, findings, counts, score: 90, incomplete: false, ...overrides };
};
const now = new Date('2026-11-02T12:00:00Z');
const compose = audits => composeSeoReport(audits, { now, publicOrigin: origin });

describe('composing the SEO report', () => {
  it('says plainly when there is nothing to fix', () => {
    const report = compose([result('a', 'Alpha'), result('b', 'Beta')]);
    expect(report).toMatchObject({ subject: 'Weekly SEO report: nothing to fix', headline: 'Nothing to fix this week.', total: 0, urgent: 0 });
    expect(report.blocks[0]).toEqual({ type: 'callout', tone: 'success', title: 'All clear.', text: 'Nothing to fix this week.' });
    expect(report.blocks.some(block => block.type === 'button')).toBe(false);
    expect(report.body).toContain('Alpha (score 90, 12 pages checked): nothing to fix.');
  });

  it('counts kinds of problem, not occurrences, and puts the urgent ones first', () => {
    const report = compose([
      result('a', 'Alpha', [finding('noindex', 'high', '/x'), finding('noindex', 'high', '/y'), finding('title_length', 'low')]),
      result('b', 'Beta', [finding('sitemap_missing', 'medium', '/sitemap.xml')]),
    ]);
    expect(report.total).toBe(3);
    expect(report.urgent).toBe(1);
    expect(report.subject).toBe('Weekly SEO report: 3 things to fix across 2 sites, 1 urgent');
    expect(report.headline).toBe('1 problem could keep pages out of search results, 1 worth fixing, 1 minor.');
    expect(report.blocks[0]).toMatchObject({ tone: 'warning', title: 'SEO check.' });
    expect(report.blocks.at(-1)).toEqual({ type: 'button', label: 'Open the AI team', url: `${origin}/admin/team` });
  });

  it('shows each site\'s worst problems with an example, and says how many more there are', () => {
    const many = Array.from({ length: 9 }, (_, index) => finding(`code_${index}`, 'low', `/p${index}`));
    const report = compose([result('a', 'Alpha', [finding('noindex', 'high', '/x', 'meta robots says noindex'), ...many])]);
    const details = report.blocks.find(block => block.type === 'details');
    expect(details.rows).toHaveLength(7);
    expect(details.rows[0]).toEqual(['Urgent: Title of noindex', '/x (meta robots says noindex)']);
    expect(details.rows.at(-1)).toEqual(['And more', '4 other kinds of problem']);
    expect(report.body).toContain('and 4 more');
  });

  it('uses the singular and counts places when several pages share a problem', () => {
    const report = compose([result('a', 'Alpha', [finding('x', 'low', '/a'), finding('x', 'low', '/b'), finding('y', 'low', '/c'), finding('z', 'medium', '/d')])]);
    const rows = report.blocks.find(block => block.type === 'details').rows;
    expect(rows.find(([label]) => label.includes('Title of x'))[1]).toBe('2 places, for example /a (detail)');
    expect(rows.find(([label]) => label.includes('Title of y'))[1]).toBe('/c (detail)');
  });

  it('is never an all-clear when a check did not finish', () => {
    const failed = compose([result('a', 'Alpha'), result('b', 'Beta', [], { failed: true, score: 0, checked: 0, incomplete: true })]);
    expect(failed).toMatchObject({ subject: 'Weekly SEO report: nothing found, but not every check finished', headline: 'Nothing found in what was checked. 1 site could not be fully checked.', total: 0 });
    expect(failed.blocks[0]).toEqual({ type: 'callout', tone: 'info', title: 'SEO check.', text: 'Nothing found in what was checked. 1 site could not be fully checked.' });
    expect(compose([result('a', 'Alpha', [], { incomplete: true }), result('b', 'Beta', [], { incomplete: true })]).headline).toBe('Nothing found in what was checked. 2 sites could not be fully checked.');
    // With findings, they lead and the note follows.
    const mixed = compose([result('a', 'Alpha', [finding('noindex', 'high', '/x')]), result('b', 'Beta', [], { incomplete: true })]);
    expect(mixed.headline).toBe('1 problem could keep pages out of search results. 1 site could not be fully checked.');
    expect(mixed.subject).toBe('Weekly SEO report: 1 thing to fix across 2 sites, 1 urgent');
    // A complete clean check is still the all-clear.
    expect(compose([result('a', 'Alpha')]).blocks[0]).toMatchObject({ tone: 'success', title: 'All clear.' });
  });

  it('says when a site could not be checked or was slow, rather than saying nothing is wrong', () => {
    const report = compose([result('a', 'Alpha', [], { failed: true, score: 0, checked: 0, incomplete: true }), result('b', 'Beta', [finding('x', 'low')], { incomplete: true })]);
    expect(report.body).toContain('Alpha: the check could not run this week.');
    expect(report.body).toContain('Beta (score 90, 12 pages checked, stopped early)');
    expect(JSON.stringify(report.blocks)).toContain('The check stopped early because the site was slow.');
    expect(report.subject).toBe('Weekly SEO report: 1 thing to fix across 2 sites');
  });

  it('is the same email for the same results, and never quotes anything but our own findings', () => {
    const audits = [result('a', 'Alpha', [finding('noindex', 'high', '/x', 'meta robots says noindex')])];
    expect(compose(audits)).toEqual(compose(audits));
    expect(JSON.stringify(compose(audits))).not.toMatch(/<|>|@/);
  });
});

const task = (overrides = {}) => ({ id: 't1', agentKey: 'seo_analyst', kind: 'seo.weekly', attempts: 1, sourceKind: 'schedule', payload: {}, ...overrides });
const sites = [{ key: 'a', label: 'Alpha', origin: 'https://alpha.test', variants: [] }, { key: 'b', label: 'Beta', origin: 'https://beta.test', variants: [] }];
const fixture = ({ audit, delivery = [{ channel: 'email', delivery: 'sent' }] } = {}) => {
  const store = { startRun: vi.fn(async () => 'run-1'), finishRun: vi.fn(async () => undefined) };
  const notifier = { send: vi.fn(async () => delivery) };
  const logs = [];
  const audits = audit ?? vi.fn(async site => result(site.key, site.label, site.key === 'a' ? [finding('noindex', 'high', '/x')] : []));
  return { store, notifier, logs, audits, handlers: seoHandlers({ store, notifier, publicOrigin: origin, fetchImpl: 'fetch', sites, audit: audits, log: line => logs.push(line) }) };
};
const at = iso => ({ now: () => new Date(iso) });
const monday = '2026-11-02T12:00:00Z';
const tuesday = '2026-11-03T12:00:00Z';

describe('the weekly SEO task', () => {
  it('does its work on Monday: audits every site, emails the report once and records a run', async () => {
    const { handlers, notifier, store, audits } = fixture();
    const { result: outcome } = await handlers['seo.weekly'](task(), at(monday));
    expect(audits).toHaveBeenCalledTimes(2);
    expect(audits).toHaveBeenCalledWith(sites[0], { fetchImpl: 'fetch', signal: undefined });
    expect(notifier.send).toHaveBeenCalledTimes(1);
    expect(notifier.send.mock.calls[0][0]).toMatchObject({
      severity: 'warning', subject: 'Weekly SEO report: 1 thing to fix across 2 sites, 1 urgent', dedupeKey: 'seo:weekly:2026-11-02', agentKey: 'seo_analyst', taskId: 't1',
      blocks: expect.arrayContaining([expect.objectContaining({ type: 'callout' })]),
    });
    expect(store.startRun).toHaveBeenCalledWith('t1', 'none', 'seo.1');
    expect(store.finishRun).toHaveBeenCalledWith('run-1', 'completed', {}, 'Sent the SEO report: 1 problem could keep pages out of search results.', null);
    expect(outcome).toMatchObject({ date: '2026-11-02', delivery: ['email:sent'], sites: [{ key: 'a', score: 90, top: [{ code: 'noindex', severity: 'high', count: 1, page: '/x' }] }, { key: 'b', top: [] }] });
  });

  it('catches up after Monday and skips a confirmed weekly delivery', async () => {
    const caught=fixture();
    await caught.handlers['seo.weekly'](task(),at(tuesday));
    expect(caught.notifier.send.mock.calls[0][0].dedupeKey).toBe('seo:weekly:2026-11-02');
    const done=fixture();done.store.notificationStatus=vi.fn(async()=> 'sent');
    expect((await done.handlers['seo.weekly'](task(),at(tuesday))).result.skipped).toBe('already_attempted');
    expect(done.audits).not.toHaveBeenCalled();
    const failed=fixture();failed.store.notificationStatus=vi.fn(async()=> 'failed');
    await failed.handlers['seo.weekly'](task(),at(tuesday));
    expect(failed.notifier.send).toHaveBeenCalled();
  });

  it('uses the Eastern week at the UTC Monday boundary', async () => {
    const late=fixture();
    await late.handlers['seo.weekly'](task(),at('2026-11-02T03:30:00Z'));
    expect(late.notifier.send.mock.calls[0][0].dedupeKey).toBe('seo:weekly:2026-10-26');
  });

  it('runs on any day when the owner asks, and sends every time', async () => {
    const { handlers, notifier } = fixture();
    await handlers['seo.weekly'](task({ sourceKind: 'owner', id: 'a' }), at(tuesday));
    await handlers['seo.weekly'](task({ sourceKind: 'owner', id: 'b' }), at(tuesday));
    expect(notifier.send.mock.calls.map(([input]) => input.dedupeKey)).toEqual(['seo:2026-11-03:a', 'seo:2026-11-03:b']);
  });

  it('sends a quiet week as plain information', async () => {
    const { handlers, notifier } = fixture({ audit: vi.fn(async site => result(site.key, site.label)) });
    await handlers['seo.weekly'](task(), at(monday));
    expect(notifier.send.mock.calls[0][0]).toMatchObject({ severity: 'info', subject: 'Weekly SEO report: nothing to fix' });
  });

  it('keeps going when one site cannot be audited, and says so without the reason', async () => {
    const audit = vi.fn(async site => { if (site.key === 'a') throw new Error('connect ECONNREFUSED 10.0.0.1:443'); return result(site.key, site.label); });
    const { handlers, notifier, logs } = fixture({ audit });
    const { result: outcome } = await handlers['seo.weekly'](task(), at(monday));
    expect(notifier.send.mock.calls[0][0].body).toContain('Alpha: the check could not run this week.');
    expect(outcome.sites[0]).toMatchObject({ key: 'a', incomplete: true, score: 0 });
    expect(logs).toEqual([JSON.stringify({ event: 'hub_seo_audit_failed', site: 'a' })]);
    expect(logs.join()).not.toMatch(/ECONNREFUSED|10\.0\.0\.1/);
  });

  it('says so when the report was written but reached nobody', async () => {
    const { handlers, store } = fixture({ delivery: [{ channel: 'email', delivery: 'suppressed' }] });
    await handlers['seo.weekly'](task(), at(monday));
    expect(store.finishRun).toHaveBeenCalledWith('run-1', 'failed', {}, 'The SEO report was written but not delivered (email:suppressed).', 'not_delivered');
  });

  it('retries when the owner cannot be told', async () => {
    const { handlers, notifier } = fixture();
    notifier.send.mockRejectedValue(new Error('database down'));
    await expect(handlers['seo.weekly'](task(), at(monday))).rejects.toThrow('database down');
  });

  it('bounds each example address it stores, not just the number of groups', async () => {
    const huge = Array.from({ length: 24 }, (_, index) => finding(`code_${index}`, 'low', `/${'p'.repeat(100_000)}${index}`));
    const { handlers } = fixture({ audit: vi.fn(async site => result(site.key, site.label, huge)) });
    const { result: outcome } = await handlers['seo.weekly'](task(), at(monday));
    expect(JSON.stringify(outcome).length).toBeLessThan(8000);
    for (const entry of outcome.sites) for (const top of entry.top) expect(top.page.length).toBeLessThanOrEqual(160);
    expect(outcome.sites[0].top).toHaveLength(8);
  });

  it('keeps its stored result small', async () => {
    const many = Array.from({ length: 40 }, (_, index) => finding(`code_${index}`, 'low', `/${'p'.repeat(100)}${index}`));
    const { handlers } = fixture({ audit: vi.fn(async site => result(site.key, site.label, many)) });
    const { result: outcome } = await handlers['seo.weekly'](task(), at(monday));
    expect(JSON.stringify(outcome).length).toBeLessThan(8000);
    expect(outcome.sites[0].top).toHaveLength(8);
  });
});
