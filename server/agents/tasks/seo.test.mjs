import { describe, expect, it, vi } from 'vitest';
import { composeSeoReport, seoHandlers } from './seo.mjs';
import { aiModels } from '../../ai-assistance.mjs';
import { modelRuntime } from '../runtime/index.mjs';
import { searchInsights } from '../seo/insights.mjs';
import { promptVersion as rewriteVersion, responseSchema, systemPrompt } from '../seo/rewrite.mjs';

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
      severity: 'warning', subject: 'Weekly SEO report: 1 thing to fix across 2 sites, 1 urgent', dedupeKey: 'seo:2026-11-02', agentKey: 'seo_analyst', taskId: 't1',
      blocks: expect.arrayContaining([expect.objectContaining({ type: 'callout' })]),
    });
    expect(store.startRun).toHaveBeenCalledWith('t1', 'none', 'seo.1');
    expect(store.finishRun).toHaveBeenCalledWith('run-1', 'completed', {}, 'Sent the SEO report: 1 problem could keep pages out of search results.', null);
    expect(outcome).toMatchObject({ date: '2026-11-02', delivery: ['email:sent'], sites: [{ key: 'a', score: 90, top: [{ code: 'noindex', severity: 'high', count: 1, page: '/x' }] }, { key: 'b', top: [] }] });
  });

  it('does nothing on the other mornings, so the report arrives once a week', async () => {
    for (const iso of [tuesday, '2026-11-04T12:00:00Z', '2026-11-08T12:00:00Z']) {
      const { handlers, notifier, audits } = fixture();
      expect((await handlers['seo.weekly'](task(), at(iso))).result).toEqual({ skipped: 'not_monday' });
      expect(audits).not.toHaveBeenCalled();
      expect(notifier.send).not.toHaveBeenCalled();
    }
  });

  it('decides the weekday by Eastern time, not UTC', async () => {
    // 03:30 UTC on Tuesday is still Monday evening in New York.
    const { handlers, audits } = fixture();
    await handlers['seo.weekly'](task(), at('2026-11-03T03:30:00Z'));
    expect(audits).toHaveBeenCalledTimes(2);
    const late = fixture();
    // 03:30 UTC on Monday is still Sunday evening in New York.
    expect((await late.handlers['seo.weekly'](task(), at('2026-11-02T03:30:00Z'))).result).toEqual({ skipped: 'not_monday' });
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

// ---- Search Console, duplicated hosts, app shells and suggested titles -------------------------------------------------------------

const account = 'seo-reader@caremetric-seo.iam.gserviceaccount.com';
const figures = (clicks, impressions, ctr, position) => ({ clicks, impressions, ctr, position });
const gscRow = (keys, clicks, impressions, position) => ({ keys, clicks, impressions, ctr: impressions ? clicks / impressions : 0, position });
const searchRead = (over = {}) => ({
  window: { current: { startDate: '2026-10-03', endDate: '2026-10-30' }, previous: { startDate: '2026-09-05', endDate: '2026-10-02' } },
  properties: [{
    property: 'sc-domain:cmcarebase.com', ok: true, totals: { current: figures(120, 4300, 0.028, 18.2), previous: figures(104, 3980, 0.026, 19.5) },
    queries: [gscRow(['personal care home software'], 40, 900, 6.1), gscRow(['pa personal care home training'], 3, 230, 11.4)],
    pages: [gscRow(['https://cmcarebase.com/'], 80, 2000, 9), gscRow(['https://cmcarebase.com/pricing'], 7, 1200, 6.2)],
    pairs: [
      gscRow(['carebase', 'https://cmcarebase.com/'], 20, 300, 9), gscRow(['carebase', 'https://home.cmcarebase.com/'], 4, 120, 14.2),
      gscRow(['pa personal care home training', 'https://cmcarebase.com/training'], 3, 230, 11.4), gscRow(['carebase pricing', 'https://cmcarebase.com/pricing'], 5, 700, 6),
    ],
  }],
  ...over,
});
const owners = ['cmcarebase.com', 'home.cmcarebase.com', 'www.caremetricintel.com'];
const connected = (read = searchRead(), over = {}) => ({ state: 'connected', account, invalidProperties: 0, insights: searchInsights(read, { owners }), ...over });
const texts = report => report.blocks.map(block => [block.title, block.text, ...(block.rows ?? []).flat()].filter(Boolean).join(' | ')).join('\n');

describe('the Search Console part of the report', () => {
  it('is left out entirely when the caller does not ask for it', () => {
    expect(JSON.stringify(compose([result('a', 'Alpha')]))).not.toContain('Search Console');
  });

  it('says once, with the owner\'s steps, when it is not connected, and why', () => {
    const report = composeSeoReport([result('a', 'Alpha')], { now, publicOrigin: origin, search: { state: 'not_configured' } });
    expect(report.body.match(/Search Console is not connected/g)).toHaveLength(1);
    expect(texts(report).match(/Search Console is not connected/g)).toHaveLength(1);
    for (const step of ['create a service account', 'enable the Google Search Console API', 'add the service account\'s email address as a user on each property', 'HUB_SEARCH_CONSOLE_CREDENTIALS', 'HUB_SEARCH_CONSOLE_SITES']) {
      expect(report.body).toContain(step);
    }
    // It changes nothing else: a clean week is still the all-clear.
    expect(report).toMatchObject({ subject: 'Weekly SEO report: nothing to fix', headline: 'Nothing to fix this week.' });
    const states = { credentials_missing: 'HUB_SEARCH_CONSOLE_CREDENTIALS is empty', credentials_invalid: 'could not be read. Paste the service account\'s whole JSON key file', no_properties: 'for example sc-domain:cmcarebase.com' };
    for (const [state, words] of Object.entries(states)) expect(composeSeoReport([result('a', 'Alpha')], { now, search: { state } }).body, state).toContain(words);
  });

  it('gives each property\'s clicks, impressions, click-through rate and position against the 28 days before, with its top searches and pages', () => {
    const report = composeSeoReport([result('a', 'Alpha')], { now, publicOrigin: origin, search: connected() });
    const table = report.blocks.find(block => block.type === 'details' && block.rows[0][0] === 'sc-domain:cmcarebase.com');
    expect(table.rows).toEqual([
      ['sc-domain:cmcarebase.com', '120 clicks (up 15%), 4,300 impressions (up 8%), 2.8% clicked, up 0.2 points, average position 18.2, 1.3 better.'],
      ['Top searches', 'personal care home software (40 clicks), pa personal care home training (3 clicks)'],
      ['Top pages', 'cmcarebase.com/ (80 clicks), cmcarebase.com/pricing (7 clicks)'],
    ]);
    expect(report.body).toContain('Search Console, Oct 3 to Oct 30, against the 28 days before.\nsc-domain:cmcarebase.com: 120 clicks (up 15%)');
    const quiet = connected(searchRead({ properties: [{ ...searchRead().properties[0], totals: { current: figures(0, 0, 0, 0), previous: figures(2, 40, 0.05, 30) } }] }));
    expect(composeSeoReport([result('a', 'Alpha')], { now, search: quiet }).body).toContain('sc-domain:cmcarebase.com: no impressions in the last 28 days (40 the 28 days before).');
  });

  it('lists the searches close to the first page, the pages seen often but rarely clicked, and the searches two of the sites compete for', () => {
    const report = composeSeoReport([result('a', 'Alpha')], { now, publicOrigin: origin, search: connected() });
    const after = text => report.blocks[report.blocks.findIndex(block => block.text?.startsWith(text)) + 1].rows;
    expect(after('Close to the first page')).toEqual([['pa personal care home training', 'average position 11.4, 230 impressions, 3 clicks; cmcarebase.com/training']]);
    expect(after('Seen often, rarely clicked')).toEqual([['cmcarebase.com/pricing', '1,200 impressions, 0.6% clicked at average position 6.2, where about 5.0% is usual']]);
    expect(after('Your own sites compete')).toEqual([['carebase', 'cmcarebase.com/ (position 9.0, 300 impressions) and home.cmcarebase.com/ (position 14.2, 120 impressions)']]);
    expect(report.body).toContain('Your own sites compete: carebase (cmcarebase.com/ (position 9.0, 300 impressions) and home.cmcarebase.com/ (position 14.2, 120 impressions)).');
    // Opportunities are not problems: they do not make a clean week a bad one.
    expect(report.subject).toBe('Weekly SEO report: nothing to fix');
  });

  it('says when nothing stood out, and which properties could not be read and what to do about it', () => {
    const plain = searchRead({ properties: [{ ...searchRead().properties[0], queries: [], pages: [], pairs: [] },
      { property: 'https://www.caremetricintel.com/', ok: false, code: 'not_permitted', status: 403 }, { property: 'sc-domain:caremetricadvisors.com', ok: false, code: 'api_unavailable', status: 503 }] });
    const report = composeSeoReport([result('a', 'Alpha')], { now, search: connected(plain, { invalidProperties: 1 }) });
    expect(texts(report)).toContain('No quick wins stood out in Search Console this week.');
    expect(texts(report)).toContain(`https://www.caremetricintel.com/ | Could not be read: the service account (${account}) cannot read this property. Add it in Search Console under Settings, Users and permissions. Write it in HUB_SEARCH_CONSOLE_SITES exactly as Search Console shows it: an address prefix ends with /.`);
    expect(report.body).toContain('sc-domain:caremetricadvisors.com could not be read: Google did not answer in time, or its answer could not be read.');
    expect(report.body).toContain('1 entry in HUB_SEARCH_CONSOLE_SITES was not understood and skipped.');
    expect(composeSeoReport([result('a', 'Alpha')], { now, search: connected(plain, { invalidProperties: 2 }) }).body).toContain('2 entries in HUB_SEARCH_CONSOLE_SITES were not understood and skipped.');
    const none = composeSeoReport([result('a', 'Alpha')], { now, search: connected({ window: null, properties: [{ property: 'sc-domain:x.test', ok: false, code: 'token_refused', status: 400 }] }) });
    expect(none.body).toContain('Search Console, the last 28 days, against the 28 days before.\nsc-domain:x.test could not be read: Google refused the service account\'s key.');
    expect(texts(none)).not.toContain('No quick wins');
  });
});

describe('the crawl\'s new findings in the report', () => {
  const pair = { hosts: ['cmcarebase.com', 'home.cmcarebase.com'], urls: ['https://cmcarebase.com/', 'https://home.cmcarebase.com/'], product: 'CareBase', reasons: ['same_product'], sharedTitles: 0 };

  it('counts two hosts serving one page as worth fixing, and asks for one canonical home page with both addresses', () => {
    const report = composeSeoReport([result('carebase', 'CareBase'), result('carebase_home', 'CareBase home (Framer)')], { now, publicOrigin: origin, duplicates: [pair] });
    expect(report).toMatchObject({ subject: 'Weekly SEO report: 1 thing to fix across 2 sites', headline: '1 worth fixing.', total: 1 });
    const at = report.blocks.findIndex(block => block.title === 'Pick one canonical home page.');
    expect(report.blocks[at]).toMatchObject({ type: 'callout', tone: 'warning' });
    expect(report.blocks[at + 1].rows).toEqual([['cmcarebase.com and home.cmcarebase.com', 'https://cmcarebase.com/ and https://home.cmcarebase.com/: both are home pages for CareBase.']]);
    expect(report.body).toContain('Pick one canonical home page: two of your sites serve the same pages and compete for the same searches. Choose one, and redirect the other to it permanently.\nhttps://cmcarebase.com/ and https://home.cmcarebase.com/: both are home pages for CareBase.');
    expect(report.blocks.at(-1)).toMatchObject({ type: 'button' });
    const every = { ...pair, reasons: ['same_product', 'canonical', 'same_title'], sharedTitles: 3 };
    expect(composeSeoReport([result('a', 'Alpha')], { now, duplicates: [every] }).body).toContain('both are home pages for CareBase; one names the other as its canonical address; they have 3 titles in common.');
    expect(composeSeoReport([result('a', 'Alpha')], { now, duplicates: [{ ...pair, product: null, reasons: ['same_title'], sharedTitles: 1 }] }).body).toContain('they have a page with the same title.');
  });

  it('says plainly that search engines and AI assistants without JavaScript see almost nothing on an app shell', () => {
    const shell = result('help', 'Help center', [finding('thin_html', 'medium', '/', '0 words before scripts run: an app shell that only scripts fill in')], { appShells: ['/'] });
    const report = composeSeoReport([shell], { now, publicOrigin: origin });
    const callout = report.blocks.find(block => block.title === 'Invisible without JavaScript.');
    expect(callout.text).toBe('Help center: / is a single-page app shell. Search engines and AI assistants that do not run JavaScript see almost nothing there: no text and no links, only what the page\'s head says, such as its title and description. Put the text of public pages in the HTML itself, prerendered or rendered on the server.');
    expect(report.body).toContain(callout.text);
    const many = composeSeoReport([result('help', 'Help center', [], { appShells: ['/', '/a', '/b'] })], { now });
    expect(many.body).toContain('Help center: 3 pages (for example /) are single-page app shells.');
    expect(composeSeoReport([result('help', 'Help center', [], { appShells: ['/'], failed: true })], { now }).body).not.toContain('app shell');
  });

  it('says where a site that redirects to another of the sites goes, and nothing else is asked of it', () => {
    const report = composeSeoReport([result('carebase', 'CareBase'), result('carebase_home', 'CareBase home (Framer)', [], { redirectsTo: 'https://cmcarebase.com', checked: 0, score: 100 })], { now });
    expect(report.body).toContain('CareBase home (Framer): redirects to https://cmcarebase.com, so search engines see one site.');
    expect(report.subject).toBe('Weekly SEO report: nothing to fix');
    const temporary = composeSeoReport([result('carebase_home', 'CareBase home (Framer)', [finding('site_redirect_temporary', 'low', '/', '302 to https://cmcarebase.com/')], { redirectsTo: 'https://cmcarebase.com' })], { now });
    expect(temporary.body).toContain('redirects to https://cmcarebase.com, so search engines see one site; Title of site_redirect_temporary (1).');
    expect(texts(temporary)).toContain('Minor: Title of site_redirect_temporary | / (302 to https://cmcarebase.com/)');
  });
});

describe('the suggested titles in the report', () => {
  const item = (id, url) => ({ id, site: 'CareBase', url, reason: 'low_ctr', why: 'Seen often in search, rarely clicked.', title: `Staff training for personal care homes ${id} | CareBase`, description: 'Track staff training and survey documentation for personal care homes in one clear place.' });

  it('shows each checked suggestion with its page and why, says how many were dropped, and changes nothing', () => {
    const report = composeSeoReport([result('a', 'Alpha')], { now, suggestions: { state: 'ok', items: [item('p1', 'https://cmcarebase.com/pricing'), item('p2', 'https://cmcarebase.com/')], dropped: 1 } });
    expect(texts(report)).toContain('Suggested titles and descriptions, written by the model from each page\'s own text and the searches that show it, and checked by code. Nothing was changed: copy the ones you want into the page. 1 suggestion did not pass the checks and is not shown.');
    const tables = report.blocks.filter(block => block.type === 'details' && block.rows[0][0] === 'Page');
    expect(tables.map(table => table.rows)).toEqual([
      [['Page', 'https://cmcarebase.com/pricing'], ['Why', 'Seen often in search, rarely clicked.'], ['New title', 'Staff training for personal care homes p1 | CareBase'], ['New description', item().description]],
      [['Page', 'https://cmcarebase.com/'], ['Why', 'Seen often in search, rarely clicked.'], ['New title', 'Staff training for personal care homes p2 | CareBase'], ['New description', item().description]],
    ]);
    expect(report.body).toContain('https://cmcarebase.com/pricing\nTitle: Staff training for personal care homes p1 | CareBase\nDescription: Track staff training');
    expect(report.subject).toBe('Weekly SEO report: nothing to fix');
  });

  it('says in one line why there are none this week, and says nothing at all without a model', () => {
    const lines = {
      none: 'No page needed a new title or description this week.', budget: 'daily model budget does not cover them', refused: 'The model declined',
      no_time: 'the checks took too long', too_slow: 'the model did not answer in time', unavailable: 'the model was unavailable',
    };
    for (const [state, words] of Object.entries(lines)) expect(composeSeoReport([result('a', 'Alpha')], { now, suggestions: { state } }).body, state).toContain(words);
    expect(composeSeoReport([result('a', 'Alpha')], { now, suggestions: { state: 'ok', items: [], dropped: 3 } }).body).toContain('did not pass the checks this week, so none are shown.');
    expect(compose([result('a', 'Alpha')]).body).not.toMatch(/Suggested|title and description/);
  });

  it('keeps the stored body within what the notification row holds, in whole paragraphs', () => {
    const items = Array.from({ length: 40 }, (_, index) => item(`p${index}`, `https://cmcarebase.com/${'x'.repeat(100)}${index}`));
    const report = composeSeoReport([result('a', 'Alpha', [finding('noindex', 'high', '/x')])], { now, search: connected(), suggestions: { state: 'ok', items, dropped: 0 } });
    expect(report.body.length).toBeLessThanOrEqual(4000);
    expect(report.body.endsWith('\n\n…')).toBe(true);
    expect(report.body.startsWith('1 problem could keep pages out of search results.')).toBe(true);
    // The email itself is built from the blocks and keeps everything.
    expect(report.blocks.filter(block => block.rows?.[0]?.[0] === 'Page')).toHaveLength(40);
  });
});

// The handler, with every new part.
const pageFacts = (url, title, over = {}) => ({ url, title, description: 'Old description that is long enough to count as a description of the page.', canonical: url, text: `Staff training and survey documentation for personal care homes and Assisted Living Facilities. ${Array.from({ length: 60 }, (_, index) => `word${index}`).join(' ')}`, words: 72, noindex: false, appShell: false, ...over });
const realSites = [
  { key: 'carebase', label: 'CareBase', product: 'carebase', origin: 'https://cmcarebase.com', variants: [] },
  { key: 'carebase_home', label: 'CareBase home (Framer)', product: 'carebase', origin: 'https://home.cmcarebase.com', variants: [] },
];
const crawl = vi.fn(async site => (site.key === 'carebase'
  ? { ...result('carebase', 'CareBase', [finding('title_length', 'low', '/pricing', '7 characters')]), pages: [pageFacts('https://cmcarebase.com/', 'CareMetric CareBase — Survey-Ready Operations'), pageFacts('https://cmcarebase.com/pricing', 'Pricing')], appShells: [] }
  : { ...result('carebase_home', 'CareBase home (Framer)', [finding('title_length', 'low', '/', '68 characters')]), pages: [pageFacts('https://home.cmcarebase.com/', 'CareBase by CareMetric')], appShells: [] }));
const goodSuggestion = { page: 'p1', title: 'Plans for Personal Care Homes and ALFs | CareBase', description: 'Compare plans for staff training and survey documentation in personal care homes and Assisted Living Facilities.' };
const badSuggestion = { page: 'p2', title: 'The best software for every ALR | CareBase', description: 'Guaranteed survey results for every home, with training and records in one place for you.' };
const completed = (suggestions = [goodSuggestion, badSuggestion]) => ({ outcome: 'completed', output: { suggestions }, model: aiModels.fast, runId: 'run-m', costCents: 0.2 });

function team({ reader = null, model = null, clock, limits, env = {} } = {}) {
  const store = { startRun: vi.fn(async () => 'run-1'), finishRun: vi.fn(async () => undefined), budget: vi.fn(async () => ({ remainingCents: 50 })) };
  const notifier = { send: vi.fn(async () => [{ channel: 'email', delivery: 'sent' }]) };
  const logs = [];
  const handlers = seoHandlers({
    store, notifier, publicOrigin: origin, fetchImpl: 'fetch', sites: realSites, audit: crawl, log: line => logs.push(line), model, env,
    ...(reader === null ? {} : { searchConsole: reader }), ...(clock ? { clock } : {}), ...(limits ? { limits } : {}),
  });
  return { store, notifier, logs, run: (input = task(), context = at(monday)) => handlers['seo.weekly'](input, context) };
}
const fakeReader = (read = searchRead()) => ({ state: 'ready', configured: true, properties: read.properties.map(entry => entry.property), invalidProperties: 0, account, read: vi.fn(async () => read) });
const fakeModel = answer => ({ configured: true, run: vi.fn(typeof answer === 'function' ? answer : async () => answer) });
const email = harness => harness.notifier.send.mock.calls[0][0];

describe('the weekly task with Search Console and suggestions', () => {
  it('says once how to connect Search Console when the variables are not set, and stores only its state', async () => {
    const harness = team();
    const { result: outcome } = await harness.run();
    expect(email(harness).body.match(/Search Console is not connected/g)).toHaveLength(1);
    expect(outcome.search).toEqual({ state: 'not_configured' });
    expect(outcome).not.toHaveProperty('suggestions');
  });

  it('reads Search Console beside the crawl, reports it, and keeps only figures and counts in the result', async () => {
    const reader = fakeReader();
    const harness = team({ reader });
    const { result: outcome } = await harness.run(task(), { now: () => new Date(monday), signal: undefined });
    expect(reader.read).toHaveBeenCalledWith({ signal: undefined, now: new Date(monday) });
    expect(email(harness).body).toContain('sc-domain:cmcarebase.com: 120 clicks (up 15%)');
    expect(outcome.search).toEqual({ state: 'connected', properties: [{ property: 'sc-domain:cmcarebase.com', clicks: 120, impressions: 4300, previousClicks: 104, previousImpressions: 3980 }], striking: 1, lowCtr: 1, competing: 1 });
    expect(JSON.stringify(outcome)).not.toMatch(/personal care home|carebase pricing|Survey-Ready|word1/);
    expect(harness.store.finishRun.mock.calls.at(-1)[3]).toBe('Sent the SEO report: 1 worth fixing, 2 minor. Search Console: 1 of 1 properties read.');
    // The two CareBase home pages are reported as one thing to fix.
    expect(outcome.duplicates).toEqual([['cmcarebase.com', 'home.cmcarebase.com']]);
  });

  it('asks the model about the weak pages through the runtime, with public page text only, and emails the suggestions that pass', async () => {
    const model = fakeModel(completed());
    const harness = team({ reader: fakeReader(), model });
    const { result: outcome } = await harness.run(task({ agent: { modelTier: 'fast', config: { effort: 'medium' } } }));
    expect(model.run).toHaveBeenCalledTimes(1);
    const [runTask, request, context] = model.run.mock.calls[0];
    expect(runTask.id).toBe('t1');
    expect(request).toMatchObject({ promptVersion: rewriteVersion, system: [{ text: systemPrompt, cache: true }], schema: responseSchema, effort: 'medium', maxTokens: 3000 });
    expect(request.validate).toEqual(expect.any(Function));
    expect(request.describe).toEqual(expect.any(Function));
    expect(context.signal).toBeInstanceOf(AbortSignal);
    // The page seen often but rarely clicked comes first, with its searches; then the page with a weak title.
    expect(request.user).toMatch(/<page id="p1">\nsite: CareBase\naddress: https:\/\/cmcarebase.com\/pricing\nwhy: Seen often in search, rarely clicked: 1,200 impressions/);
    expect(request.user).toContain('searches that show it: carebase pricing');
    expect(request.user).toContain('visible text: Staff training and survey documentation');
    expect(request.user).toContain('<page id="p2">\nsite: CareBase home (Framer)\naddress: https://home.cmcarebase.com/\nwhy: Title too short, too long or shared with another page.');
    expect(request.user.match(/<page id=/g)).toHaveLength(2);

    const tables = email(harness).blocks.filter(block => block.rows?.[0]?.[0] === 'Page');
    expect(tables.map(table => table.rows)).toEqual([[['Page', 'https://cmcarebase.com/pricing'], ['Why', expect.stringMatching(/^Seen often/)], ['New title', goodSuggestion.title], ['New description', goodSuggestion.description]]]);
    // The second suggestion makes claims and uses the wrong term: the checks drop it, and the email says one was dropped.
    expect(JSON.stringify(email(harness))).not.toMatch(/ALR|Guaranteed|best software/);
    expect(email(harness).body).toContain('1 suggestion did not pass the checks and is not shown.');
    expect(outcome.suggestions).toEqual({ state: 'ok', offered: 2, kept: 1, dropped: 1 });
    expect(JSON.stringify(outcome)).not.toContain(goodSuggestion.title);
    expect(harness.store.finishRun.mock.calls.at(-1)[3]).toMatch(/1 suggested title for 2 pages\.$/);
  });

  it('uses the agent\'s effort when it is a known one, and low otherwise', async () => {
    for (const [config, effort] of [[{ effort: 'high' }, 'high'], [{ effort: 'extreme' }, 'low'], [undefined, 'low']]) {
      const model = fakeModel(completed());
      await team({ model }).run(task({ agent: { config } }));
      expect(model.run.mock.calls[0][1].effort, String(config?.effort)).toBe(effort);
    }
  });

  it('works from the crawl alone without Search Console, and leaves the section out without a model', async () => {
    const model = fakeModel(completed([{ ...goodSuggestion }]));
    const withModel = team({ model });
    await withModel.run();
    expect(model.run.mock.calls[0][1].user).toContain('address: https://cmcarebase.com/pricing\nwhy: Title too short, too long or shared with another page.');
    expect(model.run.mock.calls[0][1].user).toContain('searches that show it: (not known)');

    const off = fakeModel(completed());
    off.configured = false;
    const without = team({ model: off });
    const { result: outcome } = await without.run();
    expect(off.run).not.toHaveBeenCalled();
    expect(email(without).body).not.toMatch(/Suggested titles|new title/i);
    expect(outcome).not.toHaveProperty('suggestions');
  });

  it('still sends the report when the model fails, is over budget or declines, and says so in one line', async () => {
    const outage = fakeModel(async () => { throw Object.assign(new Error('The model call could not be completed.'), { code: 'provider_outage', transient: true }); });
    const failed = team({ model: outage });
    const { result: outcome } = await failed.run();
    expect(email(failed).body).toContain('Suggested titles and descriptions could not be written this week: the model was unavailable.');
    expect(outcome.suggestions).toEqual({ state: 'unavailable', offered: 2, kept: 0, dropped: 0 });
    expect(failed.logs).toContain(JSON.stringify({ event: 'hub_seo_suggestions_failed', code: 'provider_outage' }));
    for (const [answer, words] of [[{ outcome: 'budget_exhausted', neededCents: 1, remainingCents: 0 }, 'daily model budget does not cover them'], [{ outcome: 'refused' }, 'The model declined']]) {
      const harness = team({ model: fakeModel(answer) });
      await harness.run();
      expect(email(harness).body).toContain(words);
    }
  });

  it('does not start the model when the checks left too little time, and stops a call that runs past its own deadline', async () => {
    const times = [0, 190_000];
    const late = fakeModel(completed());
    const skipped = team({ model: late, clock: () => times.shift() ?? 190_000 });
    await skipped.run();
    expect(late.run).not.toHaveBeenCalled();
    expect(email(skipped).body).toContain('the checks took too long to leave time for them');

    const slow = fakeModel((runTask, request, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('x'), { code: 'run_aborted', transient: true })), { once: true })));
    const stopped = team({ model: slow, limits: { modelDeadlineMs: 50, modelMinimumMs: 0 } });
    const { result: outcome } = await stopped.run();
    expect(outcome.suggestions.state).toBe('too_slow');
    expect(email(stopped).body).toContain('the model did not answer in time');
  });

  it('sends nothing once the scheduler has stopped waiting for the task', async () => {
    const controller = new AbortController();
    const model = fakeModel(async () => { controller.abort(); throw Object.assign(new Error('x'), { code: 'run_aborted', transient: true }); });
    const harness = team({ model });
    await expect(harness.run(task(), { now: () => new Date(monday), signal: controller.signal })).rejects.toMatchObject({ code: 'task_timeout', transient: true });
    expect(harness.notifier.send).not.toHaveBeenCalled();
    expect(harness.store.startRun).not.toHaveBeenCalled();
  });
});

describe('paying for the suggestions once per report', () => {
  // The database counts alerts by dedupe key prefix (private.agent_notification_count): this fake does the same over the keys it holds.
  const counting = keys => vi.fn(async ({ prefix, channel }) => keys.filter(key => key.startsWith(prefix) && channel === 'email').length);
  const harnessWith = ({ keys = [], count, send } = {}) => {
    const model = fakeModel(completed([goodSuggestion]));
    const harness = team({ model });
    harness.store.notificationCount = count ?? counting(keys);
    if (send) harness.notifier.send.mockImplementation(send);
    return { ...harness, model };
  };

  it('does not call the model again for a report that already has an email under its own key', async () => {
    const harness = harnessWith({ keys: ['seo:2026-11-02'] });
    const { result: outcome } = await harness.run();
    expect(harness.model.run).not.toHaveBeenCalled();
    expect(harness.store.notificationCount).toHaveBeenCalledWith({ prefix: 'seo:2026-11-02', channel: 'email', since: new Date(0) });
    expect(outcome.suggestions).toEqual({ state: 'already_sent', offered: 0, kept: 0, dropped: 0 });
    // The report itself still goes to the notifier, which sends it once under the same key.
    expect(email(harness).dedupeKey).toBe('seo:2026-11-02');
    expect(email(harness).body).toContain('This report has already been sent or tried once, so its suggested titles and descriptions are not paid for again.');
  });

  it('tells the scheduled report from the owner\'s own reports that day, whose keys begin with its key', async () => {
    const harness = harnessWith({ keys: ['seo:2026-11-02:owner-task-1', 'seo:2026-11-02:owner-task-2', 'seo:2026-11-01'] });
    const { result: outcome } = await harness.run();
    expect(harness.model.run).toHaveBeenCalledTimes(1);
    expect(outcome.suggestions.state).toBe('ok');
    // An owner's own report is its own key: the scheduled report that morning does not stop it, and neither does another Run now.
    for (const id of ['owner-task-3', 'owner-task-4']) {
      const owner = harnessWith({ keys: ['seo:2026-11-02', 'seo:2026-11-02:owner-task-1'] });
      await owner.run(task({ sourceKind: 'owner', id }));
      expect(owner.model.run, id).toHaveBeenCalledTimes(1);
      expect(owner.store.notificationCount).toHaveBeenCalledWith({ prefix: `seo:2026-11-02:${id}`, channel: 'email', since: new Date(0) });
    }
    const again = harnessWith({ keys: ['seo:2026-11-02:owner-task-1'] });
    await again.run(task({ sourceKind: 'owner', id: 'owner-task-1' }));
    expect(again.model.run).not.toHaveBeenCalled();
  });

  it('reuses the checked suggestions when the same report is tried again in this process, and pays once', async () => {
    const tries = [];
    const harness = harnessWith({ send: async input => { tries.push(input); if (tries.length === 1) throw new Error('database down'); return [{ channel: 'email', delivery: 'sent' }]; } });
    await expect(harness.run()).rejects.toThrow('database down');
    const { result: outcome } = await harness.run();
    expect(harness.model.run).toHaveBeenCalledTimes(1);
    expect(outcome.suggestions).toEqual({ state: 'ok', offered: 2, kept: 1, dropped: 0, reused: true });
    const shown = report => JSON.stringify(report.blocks.filter(block => block.rows?.[0]?.[0] === 'Page'));
    expect(shown(tries[1])).toContain(goodSuggestion.title);
    expect(shown(tries[1])).toBe(shown(tries[0]));
    // Another day is another report.
    await harness.run(task(), at('2026-11-09T12:00:00Z'));
    expect(harness.model.run).toHaveBeenCalledTimes(2);
  });

  it('writes the suggestions when the check cannot be made, and says so in the log', async () => {
    const harness = harnessWith({ count: vi.fn(async () => { throw new Error('function private.agent_notification_count does not exist'); }) });
    await harness.run();
    expect(harness.model.run).toHaveBeenCalledTimes(1);
    expect(harness.logs).toContain(JSON.stringify({ event: 'hub_seo_sent_check_failed' }));
    expect(harness.logs.join()).not.toContain('does not exist');
  });
});

describe('the suggestions through the shared model runtime', () => {
  const message = suggestions => ({
    id: 'msg_1', type: 'message', role: 'assistant', model: aiModels.fast, content: [{ type: 'text', text: JSON.stringify({ suggestions }) }],
    stop_reason: 'end_turn', usage: { input_tokens: 2400, output_tokens: 300, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, _request_id: 'req_seo1',
  });
  function runtimeTeam({ remaining = 50, answer = message([goodSuggestion, badSuggestion]) } = {}) {
    const create = vi.fn(async () => answer);
    const ledger = [];
    const harness = team({ reader: fakeReader() });
    harness.store.budget.mockResolvedValue({ remainingCents: remaining });
    const runtime = modelRuntime({ client: { messages: { create } }, store: harness.store, record: async entry => { ledger.push(entry); }, log: () => {}, now: () => new Date(monday) });
    const handlers = seoHandlers({ store: harness.store, notifier: harness.notifier, publicOrigin: origin, fetchImpl: 'fetch', sites: realSites, audit: crawl, log: () => {}, model: runtime, searchConsole: fakeReader(), env: {} });
    return { ...harness, create, ledger, run: () => handlers['seo.weekly'](task({ agentKey: 'seo_analyst', agent: { modelTier: 'fast', config: { effort: 'low' } } }), at(monday)) };
  }

  it('makes one metered call on the fast tier, books it, and emails what passes the checks', async () => {
    const harness = runtimeTeam();
    const { result: outcome } = await harness.run();
    expect(harness.create).toHaveBeenCalledTimes(1);
    const body = harness.create.mock.calls[0][0];
    expect(body.model).toBe(aiModels.fast);
    expect(body.system).toEqual([{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }]);
    expect(body.output_config).toEqual({ effort: 'low', format: { type: 'json_schema', schema: responseSchema } });
    expect(body.messages[0].content).toContain('<page id="p1">');
    expect(harness.store.budget).toHaveBeenCalledWith('seo_analyst');
    expect(harness.store.startRun.mock.calls[0]).toEqual(['t1', aiModels.fast, rewriteVersion]);
    expect(harness.store.finishRun.mock.calls[0]).toEqual(['run-1', 'completed', expect.objectContaining({ inputTokens: 2400, outputTokens: 300, costCents: expect.any(Number) }), 'Suggested titles and descriptions for 2 pages.', null]);
    expect(harness.ledger).toEqual([expect.objectContaining({ feature: 'agent_seo_analyst', model: aiModels.fast, outcome: 'completed', actor: 'automation' })]);
    expect(outcome.suggestions).toEqual({ state: 'ok', offered: 2, kept: 1, dropped: 1 });
    expect(JSON.stringify(email(harness).blocks)).toContain(goodSuggestion.title);
    expect(JSON.stringify(email(harness).blocks)).not.toContain(badSuggestion.title);
  });

  it('makes no call when the agent\'s budget for the day is used up, and the report still goes out', async () => {
    const harness = runtimeTeam({ remaining: 0 });
    const { result: outcome } = await harness.run();
    expect(harness.create).not.toHaveBeenCalled();
    expect(outcome.suggestions.state).toBe('budget');
    expect(email(harness).body).toContain('daily model budget does not cover them');
  });

  it('uses nothing from an answer that does not fit the format', async () => {
    const harness = runtimeTeam({ answer: message([{ page: 'https://evil.test/', title: 'x', description: 'y' }]) });
    const { result: outcome } = await harness.run();
    expect(outcome.suggestions.state).toBe('unavailable');
    expect(harness.store.finishRun.mock.calls[0][1]).toBe('no_result');
    expect(email(harness).body).toContain('the model was unavailable');
  });
});
