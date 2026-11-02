import { describe, expect, it, vi } from 'vitest';
import { auditSite, catalog, fetchPage, pageFindings, summarizeFindings } from './audit.mjs';
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
