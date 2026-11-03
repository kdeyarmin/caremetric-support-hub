import { describe, expect, it, vi } from 'vitest';
import { auditSite, catalog, clip, detailLimit, fetchPage, pageFindings, pageLimit, summarizeFindings } from './audit.mjs';
import { analyzeHtml } from './html.mjs';

const origin = 'https://www.example.test';
const site = { key: 'example', label: 'Example', origin, variants: ['https://example.test'] };
const words = count => Array.from({ length: count }, (_, index) => `word${index}`).join(' ');

/** A well-formed page: everything the checks look for. */
const goodPage = ({ path = '/', title = `Compliance training for care homes ${path}`, description = `Keep every home compliant with training, tracking and survey readiness for ${path}.`, canonical, extra = '', text = 80 } = {}) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<meta name="description" content="${description}"><meta name="viewport" content="width=device-width">
<link rel="canonical" href="${canonical ?? `${origin}${path}`}">
<meta property="og:title" content="t"><meta property="og:description" content="d"><meta property="og:image" content="https://www.example.test/i.png"><meta name="twitter:card" content="summary">
<script type="application/ld+json">{"@type":"Organization","name":"Example"}</script></head>
<body><h1>Welcome</h1><p>${words(text)}</p>${extra}</body></html>`;

const reply = (body, { status = 200, type = 'text/html; charset=utf-8', location, headers = {} } = {}) => ({ body, status, type, location, headers });
const robotsFile = `User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\n`;
const sitemapOf = urls => `<?xml version="1.0"?><urlset>${urls.map(url => `<url><loc>${url}</loc></url>`).join('')}</urlset>`;

/** A scripted network: URL to reply, 404 for anything else, and a record of every request. */
const network = routes => {
  const requests = [];
  const fetchImpl = vi.fn(async (url, options) => {
    requests.push({ url, options });
    const route = routes[url] ?? (typeof routes['*'] === 'function' ? routes['*'](url) : undefined) ?? reply('Not found', { status: 404, type: 'text/plain' });
    if (route === 'hang') return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason)));
    if (route === 'refuse') throw new TypeError('fetch failed');
    const headers = { 'content-type': route.type, ...(route.location ? { location: route.location } : {}), ...route.headers };
    return new Response(route.status === 204 || route.status === 301 || route.status === 302 ? null : route.body, { status: route.status, headers });
  });
  return { fetchImpl, requests };
};

const healthy = () => ({
  [`${origin}/robots.txt`]: reply(robotsFile, { type: 'text/plain' }),
  [`${origin}/sitemap.xml`]: reply(sitemapOf([`${origin}/`, `${origin}/pricing`, `${origin}/about`]), { type: 'application/xml' }),
  [`${origin}/`]: reply(goodPage({ path: '/', extra: '<a href="/pricing">Pricing</a><a href="/about">About</a>' })),
  [`${origin}/pricing`]: reply(goodPage({ path: '/pricing' })),
  [`${origin}/about`]: reply(goodPage({ path: '/about' })),
  'http://www.example.test/': reply('', { status: 301, location: `${origin}/` }),
  'https://example.test/': reply('', { status: 301, location: `${origin}/` }),
});
const codes = result => result.findings.map(finding => finding.code).sort();
const audit = (routes, options = {}) => { const net = network(routes); return auditSite(site, { fetchImpl: net.fetchImpl, ...options }).then(result => ({ result, ...net })); };

describe('a healthy site', () => {
  it('has nothing to fix and a full score', async () => {
    const { result } = await audit(healthy());
    expect(result).toMatchObject({ key: 'example', label: 'Example', checked: 3, findings: [], counts: { high: 0, medium: 0, low: 0 }, score: 100, incomplete: false });
  });

  it('asks only for the site\'s own pages, plainly, and follows nothing', async () => {
    const { requests } = await audit(healthy());
    const hosts = new Set(requests.map(request => new URL(request.url).host));
    expect([...hosts].sort()).toEqual(['example.test', 'www.example.test']);
    for (const { options } of requests) {
      expect(options.method).toBe('GET');
      expect(options.redirect).toBe('manual');
      expect(options.headers['user-agent']).toMatch(/^CareMetric-SEO-Check\/1/);
      expect(Object.keys(options.headers).sort()).toEqual(['accept', 'user-agent']);
      expect(options.credentials).toBeUndefined();
    }
  });
});

describe('a site that is only an app shell (no robots, no sitemap, nothing before scripts run)', () => {
  const shell = '<!doctype html><html><head><title>Example App</title><meta name="description" content="An app."></head><body><div id="root"></div><script src="/app.js"></script></body></html>';
  it('reports what a crawler would find', async () => {
    const { result } = await audit({
      [`${origin}/robots.txt`]: reply(shell), [`${origin}/sitemap.xml`]: reply(shell), [`${origin}/`]: reply(shell),
      'http://www.example.test/': reply('', { status: 301, location: `${origin}/` }),
      'https://example.test/': reply('', { status: 302, location: `${origin}/` }),
    });
    expect(codes(result)).toEqual(expect.arrayContaining(['robots_missing', 'sitemap_missing', 'thin_html', 'h1_missing', 'canonical_missing', 'social_missing', 'jsonld_missing', 'viewport_missing', 'lang_missing', 'title_length', 'description_length', 'variant_temporary_redirect']));
    expect(result.findings.find(finding => finding.code === 'robots_missing').detail).toMatch(/web page, not a robots file/);
    expect(result.checked).toBe(1);
    expect(result.counts.high).toBe(0);
    expect(result.score).toBe(64);
  });

  it('scores a kind of problem once, however many pages have it', async () => {
    const routes = healthy();
    const bare = goodPage().replace(/<meta property="og:title"[^>]*><meta property="og:description"[^>]*><meta property="og:image"[^>]*><meta name="twitter:card"[^>]*>/, '');
    for (const path of ['/', '/pricing', '/about']) routes[`${origin}${path}`] = reply(bare.replace('Welcome', 'Welcome').replace(origin + '/', origin + path).replace('care homes /', `care homes ${path}`).replace('for /.', `for ${path}.`).replace('<h1>', '<a href="/pricing">p</a><a href="/about">a</a><h1>'));
    const { result } = await audit(routes);
    expect(result.findings.filter(finding => finding.code === 'social_missing')).toHaveLength(3);
    expect(result.counts.low).toBe(3);
    expect(result.score).toBe(99);
  });
});

describe('site level problems', () => {
  it('flags a robots.txt that blocks everything, and one that names no sitemap', async () => {
    const { result } = await audit({ ...healthy(), [`${origin}/robots.txt`]: reply('User-agent: *\nDisallow: /\n', { type: 'text/plain' }) });
    expect(codes(result)).toEqual(['robots_blocks_all', 'robots_no_sitemap']);
    expect(result.counts.high).toBe(1);
  });

  it('follows a sitemap index to its child sitemaps on the same site, and ignores any other host', async () => {
    const routes = healthy();
    routes[`${origin}/sitemap.xml`] = reply(`<sitemapindex><sitemap><loc>${origin}/s1.xml</loc></sitemap><sitemap><loc>https://elsewhere.test/s2.xml</loc></sitemap></sitemapindex>`, { type: 'application/xml' });
    routes[`${origin}/s1.xml`] = reply(sitemapOf([`${origin}/`, `${origin}/pricing`]), { type: 'application/xml' });
    const { result, requests } = await audit(routes);
    expect(result.checked).toBe(2);
    expect(requests.some(request => request.url.includes('elsewhere.test'))).toBe(false);
  });

  it('reports addresses on another site in the sitemap and never crawls them', async () => {
    const routes = healthy();
    routes[`${origin}/sitemap.xml`] = reply(sitemapOf([`${origin}/`, 'https://evil.test/a', 'https://evil.test/b']), { type: 'application/xml' });
    const { result, requests } = await audit(routes);
    expect(result.findings.find(finding => finding.code === 'sitemap_other_host').detail).toMatch(/^2 address\(es\), for example https:\/\/evil\.test\/a/);
    expect(requests.some(request => request.url.includes('evil.test'))).toBe(false);
  });

  it('reports an empty sitemap', async () => {
    const { result } = await audit({ ...healthy(), [`${origin}/sitemap.xml`]: reply(sitemapOf([]), { type: 'application/xml' }) });
    expect(codes(result)).toContain('sitemap_empty');
  });

  it('checks the usual sitemap address when robots.txt names none', async () => {
    const { result } = await audit({ ...healthy(), [`${origin}/robots.txt`]: reply('User-agent: *\nAllow: /\n', { type: 'text/plain' }) });
    expect(codes(result)).toEqual(['robots_no_sitemap']);
    expect(result.checked).toBe(3);
  });

  it('flags an http address that answers instead of redirecting, and a temporary redirect', async () => {
    expect(codes((await audit({ ...healthy(), 'http://www.example.test/': reply(goodPage()) })).result)).toEqual(['http_not_redirected']);
    expect(codes((await audit({ ...healthy(), 'http://www.example.test/': reply('', { status: 302, location: `${origin}/` }) })).result)).toEqual(['http_redirect_temporary']);
  });

  it('wants the plain http address to redirect permanently to this site\'s own https address', async () => {
    const cases = [
      ['a permanent redirect to the https address', reply('', { status: 301, location: `${origin}/` }), []],
      ['a 308 to a page of the site', reply('', { status: 308, location: `${origin}/pricing` }), []],
      ['a redirect to another http address', reply('', { status: 301, location: 'http://www.example.test/' }), ['http_not_redirected']],
      ['a relative redirect that stays on http', reply('', { status: 301, location: '/' }), ['http_not_redirected']],
      ['a redirect to another site', reply('', { status: 301, location: 'https://elsewhere.test/' }), ['http_not_redirected']],
      ['a redirect to a lookalike host', reply('', { status: 301, location: `${origin}.evil.test/` }), ['http_not_redirected']],
      ['a redirect with no destination', reply('', { status: 301 }), ['http_not_redirected']],
      ['a 404', reply('Not found', { status: 404, type: 'text/plain' }), ['http_not_redirected']],
      ['a server error', reply('x', { status: 500, type: 'text/plain' }), ['http_not_redirected']],
      ['a temporary redirect to the https address', reply('', { status: 307, location: `${origin}/` }), ['http_redirect_temporary']],
      ['a 303 to the https address', reply('', { status: 303, location: `${origin}/` }), ['http_redirect_temporary']],
      ['a temporary redirect to another site', reply('', { status: 302, location: 'https://elsewhere.test/' }), ['http_not_redirected']],
    ];
    for (const [name, answer, expected] of cases) expect(codes((await audit({ ...healthy(), 'http://www.example.test/': answer })).result), name).toEqual(expected);
    const { result } = await audit({ ...healthy(), 'http://www.example.test/': reply('', { status: 301, location: 'https://elsewhere.test/secret-token' }) });
    expect(JSON.stringify(result)).not.toContain('secret-token');
  });

  it('says nothing about http when the host does not answer on that port', async () => {
    expect((await audit({ ...healthy(), 'http://www.example.test/': 'refuse' })).result.findings).toEqual([]);
  });

  it('checks the other addresses for the same site', async () => {
    const variantCodes = async reply_ => codes((await audit({ ...healthy(), 'https://example.test/': reply_ })).result);
    expect(await variantCodes(reply('', { status: 404, type: 'application/json' }))).toEqual(['variant_broken']);
    expect(await variantCodes(reply('', { status: 302, location: `${origin}/` }))).toEqual(['variant_temporary_redirect']);
    expect(await variantCodes(reply('', { status: 301, location: 'https://other.test/' }))).toEqual(['variant_redirect_elsewhere']);
    expect(await variantCodes(reply(goodPage({ canonical: 'https://example.test/' })))).toEqual(['variant_duplicate']);
    expect(await variantCodes(reply(goodPage({ canonical: `${origin}/` })))).toEqual([]);
    expect(await variantCodes('refuse')).toEqual(['variant_broken']);
  });
});

describe('page level problems', () => {
  it('reports pages that error, redirect, are not HTML or do not answer', async () => {
    const routes = healthy();
    routes[`${origin}/sitemap.xml`] = reply(sitemapOf([`${origin}/`, `${origin}/gone`, `${origin}/boom`, `${origin}/moved`, `${origin}/file`, `${origin}/slow`]), { type: 'application/xml' });
    routes[`${origin}/boom`] = reply('x', { status: 500, type: 'text/plain' });
    routes[`${origin}/moved`] = reply('', { status: 301, location: `${origin}/pricing` });
    routes[`${origin}/file`] = reply('%PDF', { type: 'application/pdf' });
    routes[`${origin}/slow`] = 'hang';
    const { result } = await audit(routes, { limits: { timeoutMs: 40 } });
    expect(codes(result)).toEqual(['not_html', 'page_error', 'page_error', 'page_redirect', 'page_unreachable']);
    expect(result.findings.find(finding => finding.code === 'page_unreachable')).toMatchObject({ detail: 'timeout', page: '/slow' });
    expect(result.findings.find(finding => finding.code === 'page_redirect').detail).toBe(`301 to ${origin}/pricing`);
  });

  it('flags noindex in a meta tag or a header', async () => {
    const routes = healthy();
    routes[`${origin}/pricing`] = reply(goodPage({ path: '/pricing' }).replace('<meta charset="utf-8">', '<meta charset="utf-8"><meta name="robots" content="noindex">'));
    routes[`${origin}/about`] = reply(goodPage({ path: '/about' }), { headers: { 'x-robots-tag': 'NoIndex' } });
    const { result } = await audit(routes);
    expect(result.findings.filter(finding => finding.code === 'noindex').map(finding => finding.page).sort()).toEqual(['/about', '/pricing']);
    expect(result.counts.high).toBe(2);
  });

  it('flags titles and descriptions that several pages share, once per group', async () => {
    const routes = healthy();
    routes[`${origin}/pricing`] = reply(goodPage({ path: '/pricing', title: 'Compliance training for care homes /', description: goodPage().match(/name="description" content="([^"]*)"/)[1] }));
    const { result } = await audit(routes);
    expect(codes(result)).toEqual(['description_duplicate', 'title_duplicate']);
    expect(result.findings[0].detail).toMatch(/^2 pages, for example \//);
  });

  it('flags a canonical link that points somewhere else', async () => {
    const routes = healthy();
    routes[`${origin}/about`] = reply(goodPage({ path: '/about', canonical: 'https://other.test/about' }));
    const { result } = await audit(routes);
    expect(result.findings).toEqual([expect.objectContaining({ code: 'canonical_mismatch', page: '/about', detail: 'points to https://other.test/about' })]);
  });

  it('compares a canonical link with the page address exactly: case and a trailing slash count, the host and the fragment do not', async () => {
    const mismatch = async canonical => {
      const routes = healthy();
      routes[`${origin}/pricing`] = reply(goodPage({ path: '/pricing', canonical }));
      return (await audit(routes)).result.findings.map(item => [item.code, item.detail]);
    };
    expect(await mismatch(`${origin}/Pricing`)).toEqual([['canonical_mismatch', `points to ${origin}/Pricing`]]);
    expect(await mismatch(`${origin}/pricing/`)).toEqual([['canonical_mismatch', `points to ${origin}/pricing/`]]);
    expect(await mismatch(`${origin}/pricing?plan=team`)).toEqual([['canonical_mismatch', `points to ${origin}/pricing?plan=team`]]);
    expect(await mismatch('HTTPS://WWW.EXAMPLE.TEST/pricing#plans')).toEqual([]);
    // The site root is one address whether or not it is written with its slash.
    const routes = healthy();
    routes[`${origin}/`] = reply(goodPage({ path: '/', canonical: origin, extra: '<a href="/pricing">Pricing</a><a href="/about">About</a>' }));
    expect((await audit(routes)).result.findings).toEqual([]);
  });

  it('treats addresses that differ only by case as different pages, so a broken link to one is not hidden by a page at the other', async () => {
    const routes = healthy();
    routes[`${origin}/sitemap.xml`] = reply(sitemapOf([`${origin}/`, `${origin}/pricing`, `${origin}/About`]), { type: 'application/xml' });
    delete routes[`${origin}/about`];
    routes[`${origin}/About`] = reply(goodPage({ path: '/About' }));
    const { result, requests } = await audit(routes);
    expect(result.findings).toEqual([expect.objectContaining({ code: 'broken_link', page: '/', detail: '404 on /about' })]);
    expect(requests.some(request => request.url === `${origin}/about`)).toBe(true);
  });

  it('treats a page with a trailing slash and the same page without one as two addresses', async () => {
    const routes = healthy();
    routes[`${origin}/`] = reply(goodPage({ path: '/', extra: '<a href="/pricing">Pricing</a><a href="/about/">About</a>' }));
    const { result, requests } = await audit(routes);
    expect(requests.some(request => request.url === `${origin}/about/`)).toBe(true);
    expect(result.findings).toEqual([expect.objectContaining({ code: 'broken_link', detail: '404 on /about/' })]);
  });

  it('checks the links between pages once each and reports the broken ones on the page that has them', async () => {
    const routes = healthy();
    routes[`${origin}/`] = reply(goodPage({ path: '/', extra: '<a href="/pricing">p</a><a href="/missing">m</a><a href="/missing">again</a><a href="/fine">f</a><a href="https://other.test/x">x</a>' }));
    routes[`${origin}/fine`] = reply('ok');
    const { result, requests } = await audit(routes);
    expect(result.findings).toEqual([expect.objectContaining({ code: 'broken_link', page: '/', detail: '404 on /missing' })]);
    expect(requests.filter(request => request.url === `${origin}/missing`)).toHaveLength(1);
    expect(requests.some(request => request.url.includes('other.test/x'))).toBe(false);
  });

  it('checks a few pages from the home page when the site has no sitemap', async () => {
    const routes = healthy();
    routes[`${origin}/sitemap.xml`] = reply('Not found', { status: 404, type: 'text/plain' });
    const { result } = await audit(routes);
    expect(codes(result)).toEqual(['sitemap_missing']);
    expect(result.checked).toBe(3);
  });
});

describe('what a finding keeps of an address', () => {
  it('clips a very long address and detail where the finding is recorded, so an email and a stored result stay small', async () => {
    const long = `${origin}/${'a'.repeat(50_000)}?q=${'b'.repeat(50_000)}`;
    const routes = healthy();
    routes[`${origin}/sitemap.xml`] = reply(sitemapOf([`${origin}/`, long, `${origin}/pricing`]), { type: 'application/xml' });
    routes[long] = reply('boom', { status: 500, type: 'text/plain' });
    const { result } = await audit(routes);
    const error = result.findings.find(item => item.code === 'page_error');
    expect(error.page).toHaveLength(pageLimit);
    expect(error.page.endsWith('…')).toBe(true);
    expect(error.page.startsWith('/aaaa')).toBe(true);
    for (const item of result.findings) { expect(item.page.length).toBeLessThanOrEqual(pageLimit); expect(item.detail.length).toBeLessThanOrEqual(detailLimit); }
    const other = healthy();
    other[`${origin}/sitemap.xml`] = reply(sitemapOf([`${origin}/`, `https://elsewhere.test/${'c'.repeat(50_000)}`]), { type: 'application/xml' });
    const { result: foreign } = await audit(other);
    expect(foreign.findings.find(item => item.code === 'sitemap_other_host').detail).toHaveLength(detailLimit);
  });

  it('clips at a limit, marks the cut, and never splits a character pair', () => {
    expect(clip('short', 10)).toBe('short');
    expect(clip('abcdefghij', 10)).toBe('abcdefghij');
    expect(clip('abcdefghijk', 10)).toBe('abcdefghi…');
    // Cutting 😀 (two code units) after its first unit would leave half a pair, which JSON and the database refuse.
    const cut = clip(`aaaa😀bbbb`, 6);
    expect(cut).toBe('aaaa…');
    expect(() => JSON.parse(JSON.stringify({ cut }))).not.toThrow();
    expect(clip(undefined, 5)).toBe('');
  });
});

describe('limits', () => {
  it('never crawls more pages or links than it is allowed to', async () => {
    const urls = Array.from({ length: 100 }, (_, index) => `${origin}/p${index}`);
    const routes = { ...healthy(), [`${origin}/sitemap.xml`]: reply(sitemapOf(urls), { type: 'application/xml' }), '*': url => (url.startsWith(`${origin}/p`) ? reply(goodPage({ path: new URL(url).pathname, extra: Array.from({ length: 100 }, (_, i) => `<a href="/l${i}">l</a>`).join('') })) : undefined) };
    const { requests } = await audit(routes, { limits: { pages: 8, links: 5 } });
    const pageRequests = requests.filter(request => /\/p\d+$/.test(request.url) || request.url === `${origin}/`);
    expect(pageRequests.length).toBeLessThanOrEqual(8);
    expect(requests.filter(request => /\/l\d+$/.test(request.url)).length).toBeLessThanOrEqual(5);
  });

  it('stops at its deadline with what it has, and says so', async () => {
    let time = 0;
    const net = network(healthy());
    const result = await auditSite(site, { fetchImpl: net.fetchImpl, now: () => { time += 40_000; return time; }, limits: { deadlineMs: 100_000 } });
    expect(result.incomplete).toBe(true);
    expect(net.requests.length).toBeLessThan(10);
  });

  it('stops when asked to', async () => {
    const controller = new AbortController();
    controller.abort();
    const net = network(healthy());
    const result = await auditSite(site, { fetchImpl: net.fetchImpl, signal: controller.signal });
    expect(result.incomplete).toBe(true);
    expect(net.requests).toHaveLength(0);
  });
});

describe('fetching one page', () => {
  it('reads at most the allowed bytes of an endless body, then cancels it', async () => {
    let cancelled = false;
    const body = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(4096).fill(97)); }, cancel() { cancelled = true; } });
    const page = await fetchPage('https://www.example.test/', { fetchImpl: async () => new Response(body, { status: 200, headers: { 'content-type': 'text/html' } }), timeoutMs: 2000, maxBytes: 10_000 });
    expect(page.text.length).toBe(10_000);
    expect(cancelled).toBe(true);
  });

  it('reports a body that stalls as a timeout', async () => {
    const stalled = new ReadableStream({ pull() { return new Promise(() => {}); } });
    const page = await fetchPage('https://www.example.test/', { fetchImpl: async () => new Response(stalled, { status: 200, headers: { 'content-type': 'text/html' } }), timeoutMs: 40, maxBytes: 1000 });
    expect(page).toMatchObject({ status: 0, error: 'timeout' });
  });

  it('does not read the body of an error or when no body is wanted', async () => {
    const read = vi.fn();
    const body = new ReadableStream({ pull(controller) { read(); controller.enqueue(new Uint8Array(8)); } });
    const page = await fetchPage('https://www.example.test/', { fetchImpl: async () => new Response(body, { status: 404 }), timeoutMs: 2000, maxBytes: 1000 });
    expect(page).toMatchObject({ status: 404, text: '' });
  });
});

describe('findings', () => {
  it('has a severity and a sentence for every code a page check can raise', () => {
    const poor = analyzeHtml('<html><head></head><body></body></html>', 'https://www.example.test/');
    for (const finding of pageFindings(poor, 'https://www.example.test/')) expect(catalog[finding.code], finding.code).toBeDefined();
    for (const [code, [severity, title]] of Object.entries(catalog)) { expect(['high', 'medium', 'low'], code).toContain(severity); expect(title.length, code).toBeGreaterThan(8); }
  });

  it('is grouped by code, worst first, with one example', () => {
    const items = [
      { code: 'jsonld_missing', severity: 'low', title: 'a', detail: 'd1', page: '/a' }, { code: 'noindex', severity: 'high', title: 'b', detail: 'd2', page: '/b' },
      { code: 'jsonld_missing', severity: 'low', title: 'a', detail: 'd3', page: '/c' }, { code: 'title_duplicate', severity: 'medium', title: 'c', detail: 'd4', page: '/d' },
    ];
    expect(summarizeFindings(items)).toEqual([
      { code: 'noindex', severity: 'high', title: 'b', count: 1, example: { page: '/b', detail: 'd2' } },
      { code: 'title_duplicate', severity: 'medium', title: 'c', count: 1, example: { page: '/d', detail: 'd4' } },
      { code: 'jsonld_missing', severity: 'low', title: 'a', count: 2, example: { page: '/a', detail: 'd1' } },
    ]);
  });
});

describe('what the later steps get from the crawl', () => {
  it('lists each HTML page in the order it was queued, with what the rewrite and duplicate checks need, and asks for the home page once', async () => {
    const routes = healthy();
    routes[`${origin}/about`] = reply(goodPage({ path: '/about' }), { headers: { 'x-robots-tag': 'noindex' } });
    const { result, requests } = await audit(routes);
    expect(result.pages.map(page => [page.url, page.noindex, page.appShell])).toEqual([[`${origin}/`, false, false], [`${origin}/pricing`, false, false], [`${origin}/about`, true, false]]);
    expect(result.pages[1]).toMatchObject({ title: 'Compliance training for care homes /pricing', canonical: `${origin}/pricing`, words: 81 });
    expect(result.pages[1].description).toMatch(/^Keep every home compliant/);
    expect(result.pages[1].text).toMatch(/^Welcome word0 word1/);
    expect(result.appShells).toEqual([]);
    expect(requests.filter(request => request.url === `${origin}/`)).toHaveLength(1);
  });

  it('names the pages that are app shells, and says so in the thin page finding', async () => {
    const shell = '<!doctype html><html lang="en"><head><title>Example Support Hub</title><script type="module" src="/assets/index.js"></script></head><body><div id="root"></div></body></html>';
    const routes = { ...healthy(), [`${origin}/`]: reply(shell), [`${origin}/pricing`]: reply('<!doctype html><html><body><p>Only a few words here.</p></body></html>') };
    const { result } = await audit(routes);
    expect(result.appShells).toEqual(['/']);
    const thin = result.findings.filter(finding => finding.code === 'thin_html');
    expect(thin.map(finding => [finding.page, finding.detail])).toEqual(expect.arrayContaining([
      ['/', '0 words before scripts run: an app shell that only scripts fill in'], ['/pricing', '5 words before scripts run'],
    ]));
  });
});

describe('a site that redirects to another of the company\'s sites', () => {
  const home = { key: 'home', label: 'Home', origin: 'https://home.example.test', variants: [] };
  const owners = [origin, home.origin];
  const run = async (answer, owned = owners) => {
    const net = network({ ...healthy(), 'https://home.example.test/': answer });
    return { result: await auditSite(home, { fetchImpl: net.fetchImpl, owners: owned }), requests: net.requests };
  };

  it('is checked no further when it redirects permanently, and says where it goes', async () => {
    for (const status of [301, 308]) {
      const { result, requests } = await run(reply('', { status, location: `${origin}/` }));
      expect(result).toMatchObject({ key: 'home', checked: 0, findings: [], score: 100, incomplete: false, redirectsTo: origin, pages: [], appShells: [] });
      expect(requests.map(request => request.url)).toEqual(['https://home.example.test/']);
    }
    expect((await run(reply('', { status: 301, location: `${origin}/welcome` }))).result.redirectsTo).toBe(origin);
  });

  it('asks for a permanent redirect when it uses a temporary one', async () => {
    const { result } = await run(reply('', { status: 302, location: `${origin}/` }));
    expect(result.redirectsTo).toBe(origin);
    expect(result.findings).toEqual([expect.objectContaining({ code: 'site_redirect_temporary', severity: 'low', detail: `302 to ${origin}/` })]);
    expect(result.score).toBe(99);
  });

  it('is checked as usual when it redirects anywhere else, or within itself', async () => {
    for (const location of ['https://elsewhere.test/', 'https://home.example.test/en/', `${origin}.evil.test/`]) {
      const { result } = await run(reply('', { status: 301, location }), owners);
      expect(result.redirectsTo, location).toBeUndefined();
      expect(result.findings.map(finding => finding.code), location).toContain('page_redirect');
    }
    // A site the caller does not count as the company's is no reason to stop either.
    expect((await run(reply('', { status: 301, location: `${origin}/` }), [home.origin])).result.redirectsTo).toBeUndefined();
  });
});
