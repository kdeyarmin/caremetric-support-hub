/**
 * One site's weekly check, from the outside and without running scripts, the way a crawler that does not run
 * JavaScript (and most AI assistants) reads it: robots.txt, the sitemap, the home page and the pages the
 * sitemap lists, the links between them, and the other addresses that should reach the same site.
 *
 * Every request goes to the site's own host (a variant host for the variant check), is a plain GET without
 * credentials, follows no redirect, and reads a bounded amount of the answer. Nothing a page says is kept
 * except a handful of fixed-vocabulary findings.
 */
import { analyzeHtml, analyzeRobots, analyzeSitemap, resolve } from './html.mjs';

export const defaults = Object.freeze({ pages: 20, links: 30, concurrency: 4, timeoutMs: 8000, htmlBytes: 600_000, textBytes: 400_000, deadlineMs: 150_000 });
const userAgent = 'CareMetric-SEO-Check/1 (+https://caremetric.ai)';

/** [severity, one plain sentence]. The code is the stable name; the detail says where. */
export const catalog = Object.freeze({
  robots_missing: ['medium', 'No robots.txt file'],
  robots_blocks_all: ['high', 'robots.txt blocks every page from search engines'],
  robots_no_sitemap: ['low', 'robots.txt does not point to the sitemap'],
  sitemap_missing: ['medium', 'No sitemap'],
  sitemap_empty: ['medium', 'The sitemap lists no pages'],
  sitemap_other_host: ['medium', 'The sitemap lists addresses on another site'],
  http_not_redirected: ['high', 'The plain http address does not redirect to https'],
  http_redirect_temporary: ['low', 'The http to https redirect is temporary'],
  variant_broken: ['medium', 'Another address for the site does not reach it'],
  variant_duplicate: ['medium', 'Another address serves the same pages without redirecting or naming the main address'],
  variant_redirect_elsewhere: ['medium', 'Another address redirects somewhere unexpected'],
  variant_temporary_redirect: ['low', 'Another address redirects with a temporary redirect'],
  page_unreachable: ['high', 'A page did not answer'],
  page_error: ['high', 'A page returns an error'],
  page_redirect: ['medium', 'A page listed for search engines redirects'],
  not_html: ['medium', 'A page is not an HTML page'],
  noindex: ['high', 'A page tells search engines not to index it'],
  title_missing: ['high', 'A page has no title'],
  title_length: ['low', 'A page title is too short or too long'],
  title_duplicate: ['medium', 'Pages share the same title'],
  description_missing: ['medium', 'A page has no description'],
  description_length: ['low', 'A page description is too short or too long'],
  description_duplicate: ['medium', 'Pages share the same description'],
  canonical_missing: ['medium', 'A page has no canonical link'],
  canonical_mismatch: ['medium', 'A canonical link points to a different address'],
  h1_missing: ['medium', 'A page has no main heading in its HTML'],
  h1_multiple: ['low', 'A page has more than one main heading'],
  thin_html: ['medium', 'A page has almost no text before scripts run'],
  viewport_missing: ['medium', 'A page is not set up for phones'],
  lang_missing: ['low', 'A page does not declare its language'],
  social_missing: ['low', 'A page has no social sharing preview'],
  jsonld_missing: ['low', 'A page has no structured data'],
  jsonld_invalid: ['medium', 'Structured data on a page is not valid'],
  images_without_alt: ['low', 'Images have no alternative text'],
  broken_link: ['medium', 'A link on the site is broken'],
});
// A kind of problem costs the same whether one page or twenty have it: the score says how many things are wrong, not how often.
const weight = { high: 15, medium: 5, low: 1 };
const severityOrder = { high: 0, medium: 1, low: 2 };

async function readBody(response, maxBytes) {
  const reader = response.body?.getReader();
  if (!reader) return { text: '', truncated: false };
  const chunks = [];
  let total = 0;
  let truncated = false;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
      if (total >= maxBytes) truncated = true;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const joined = new Uint8Array(Math.min(total, maxBytes));
  let offset = 0;
  for (const chunk of chunks) {
    const take = Math.min(chunk.byteLength, joined.byteLength - offset);
    if (take <= 0) break;
    joined.set(chunk.subarray(0, take), offset);
    offset += take;
  }
  return { text: new TextDecoder('utf-8', { fatal: false }).decode(joined), truncated };
}

/** One GET. Never throws: status 0 with an error word means nothing answered in time. */
export async function fetchPage(url, { fetchImpl, signal, timeoutMs, maxBytes }) {
  const limit = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, limit]) : limit;
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'GET', redirect: 'manual', signal: combined,
      headers: { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5', 'user-agent': userAgent },
    });
  } catch {
    return { url, status: 0, error: limit.aborted ? 'timeout' : 'network', location: null, type: '', robotsHeader: '', text: '' };
  }
  const result = {
    url, status: response.status, error: null, location: response.headers.get('location'),
    type: (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase(),
    robotsHeader: (response.headers.get('x-robots-tag') ?? '').toLowerCase(), text: '',
  };
  try {
    if (response.status >= 200 && response.status < 300 && maxBytes > 0) result.text = (await Promise.race([readBody(response, maxBytes), new Promise((_, reject) => { combined.addEventListener('abort', () => reject(combined.reason), { once: true }); })])).text;
    else await response.body?.cancel().catch(() => {});
  } catch {
    result.error = 'timeout';
    result.status = 0;
  }
  return result;
}

async function mapLimit(items, limit, work) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const index = next; next += 1; results[index] = await work(items[index], index); }
  }));
  return results;
}

const hostOf = value => { try { return new URL(value).host.toLowerCase(); } catch { return ''; } };
const tidy = value => { try { const url = new URL(value); url.hash = ''; return url.toString().replace(/\/$/, '').toLowerCase(); } catch { return String(value).toLowerCase(); } };
const path = url => { try { const parsed = new URL(url); return `${parsed.pathname}${parsed.search}` || '/'; } catch { return String(url); } };

/** Findings for one fetched, analyzed page. */
export function pageFindings(facts, url) {
  const found = [];
  const add = (code, detail) => found.push({ code, detail, page: path(url) });
  if (/noindex/.test(facts.robotsMeta)) add('noindex', 'meta robots says noindex');
  if (facts.title === null || facts.title === '') add('title_missing', 'no title');
  else if (facts.title.length < 15 || facts.title.length > 65) add('title_length', `${facts.title.length} characters`);
  if (facts.description === null || facts.description === '') add('description_missing', 'no description');
  else if (facts.description.length < 70 || facts.description.length > 160) add('description_length', `${facts.description.length} characters`);
  if (facts.canonical === null) add('canonical_missing', 'no canonical link');
  else if (tidy(resolve(facts.canonical, url) ?? facts.canonical) !== tidy(url)) add('canonical_mismatch', `points to ${resolve(facts.canonical, url) ?? facts.canonical}`);
  if (facts.h1Count === 0) add('h1_missing', 'no h1 in the HTML');
  else if (facts.h1Count > 1) add('h1_multiple', `${facts.h1Count} headings`);
  if (facts.wordCount < 50) add('thin_html', `${facts.wordCount} words before scripts run`);
  if (!facts.viewport) add('viewport_missing', 'no viewport meta tag');
  if (!facts.lang) add('lang_missing', 'no lang on the html element');
  if (!(facts.openGraph.title && facts.openGraph.description && facts.openGraph.image) || !facts.twitterCard) add('social_missing', 'missing Open Graph or Twitter card tags');
  if (facts.jsonLd.count === 0) add('jsonld_missing', 'no JSON-LD');
  if (facts.jsonLd.invalid > 0) add('jsonld_invalid', `${facts.jsonLd.invalid} block(s) do not parse`);
  if (facts.images.withoutAlt > 0) add('images_without_alt', `${facts.images.withoutAlt} of ${facts.images.total}`);
  return found;
}

/**
 * Checks one site. Returns { key, label, checked, findings, incomplete, score } where each finding is
 * { severity, code, title, detail, page }. A slow site stops at the deadline with what it has and says so.
 */
export async function auditSite(site, { fetchImpl = fetch, signal, now = () => Date.now(), limits = defaults } = {}) {
  const config = { ...defaults, ...limits };
  const deadline = now() + config.deadlineMs;
  let incomplete = false;
  const findings = [];
  const add = (code, detail, page = '/') => findings.push({ severity: catalog[code][0], code, title: catalog[code][1], detail, page });
  const host = hostOf(site.origin);
  const get = async (url, maxBytes) => {
    if (now() > deadline || signal?.aborted) { incomplete = true; return null; }
    return fetchPage(url, { fetchImpl, signal, timeoutMs: config.timeoutMs, maxBytes });
  };
  const sameSite = url => hostOf(url) === host;

  // robots.txt
  const robotsPage = await get(`${site.origin}/robots.txt`, config.textBytes);
  const robots = robotsPage?.status === 200 ? analyzeRobots(robotsPage.text) : null;
  if (robotsPage && !robots) add('robots_missing', robotsPage.status === 200 ? 'the address returns a web page, not a robots file' : `status ${robotsPage.status || robotsPage.error}`, '/robots.txt');
  if (robots?.blocksAll) add('robots_blocks_all', 'User-agent: * with Disallow: /', '/robots.txt');
  if (robots && robots.sitemaps.length === 0) add('robots_no_sitemap', 'no Sitemap line', '/robots.txt');

  // sitemap(s): the ones robots.txt names on this site, else the usual address
  const sitemapAddresses = (robots?.sitemaps.map(address => resolve(address, site.origin)).filter(address => address && sameSite(address)) ?? []);
  const sitemapQueue = (sitemapAddresses.length ? sitemapAddresses : [`${site.origin}/sitemap.xml`]).slice(0, 3);
  const listed = [];
  let sitemapFound = false;
  for (let index = 0; index < sitemapQueue.length && index < 6; index += 1) {
    const fetched = await get(sitemapQueue[index], config.textBytes);
    const parsed = fetched?.status === 200 ? analyzeSitemap(fetched.text) : null;
    if (!parsed) continue;
    sitemapFound = true;
    if (parsed.index) { for (const child of parsed.urls.slice(0, 3)) if (sameSite(child)) sitemapQueue.push(child); } else listed.push(...parsed.urls);
  }
  if (!sitemapFound) add('sitemap_missing', 'no sitemap.xml that parses', '/sitemap.xml');
  else if (listed.length === 0) add('sitemap_empty', 'no addresses', '/sitemap.xml');
  const foreign = listed.filter(address => !sameSite(address));
  if (foreign.length) add('sitemap_other_host', `${foreign.length} address(es), for example ${foreign[0]}`, '/sitemap.xml');
  const sitemapPages = [...new Set(listed.filter(sameSite))];

  // pages: home, then what the sitemap lists
  const queue = [`${site.origin}/`, ...sitemapPages.filter(address => tidy(address) !== tidy(`${site.origin}/`))].slice(0, config.pages);
  const analyzed = new Map();
  const fetchedPages = new Set();
  const checkPage = async url => {
    const page = await get(url, config.htmlBytes);
    if (!page) return;
    fetchedPages.add(tidy(url));
    if (page.status === 0) { add('page_unreachable', page.error, path(url)); return; }
    if (page.status >= 300 && page.status < 400) { add('page_redirect', `${page.status} to ${page.location ?? 'nowhere'}`, path(url)); return; }
    if (page.status !== 200) { add('page_error', `status ${page.status}`, path(url)); return; }
    if (!/html/.test(page.type)) { add('not_html', page.type || 'no content type', path(url)); return; }
    const facts = analyzeHtml(page.text, url);
    analyzed.set(url, facts);
    if (/noindex/.test(page.robotsHeader)) add('noindex', 'X-Robots-Tag header says noindex', path(url));
    for (const finding of pageFindings(facts, url)) add(finding.code, finding.detail, finding.page);
  };
  await mapLimit(queue, config.concurrency, checkPage);

  // no sitemap: look at a few pages the home page links to, so a site without one is still checked
  if (!sitemapFound && analyzed.size === 1) {
    const home = analyzed.values().next().value;
    const more = home.links.filter(sameSite).filter(address => !fetchedPages.has(tidy(address))).slice(0, config.pages - 1);
    await mapLimit(more, config.concurrency, checkPage);
  }

  // titles and descriptions shared by several pages
  for (const [field, code] of [['title', 'title_duplicate'], ['description', 'description_duplicate']]) {
    const groups = new Map();
    for (const [url, facts] of analyzed) if (facts[field]) groups.set(facts[field], [...(groups.get(facts[field]) ?? []), url]);
    for (const urls of groups.values()) if (urls.length > 1) add(code, `${urls.length} pages, for example ${path(urls[0])} and ${path(urls[1])}`, path(urls[0]));
  }

  // links between pages
  const linked = new Map();
  for (const [url, facts] of analyzed) for (const link of facts.links) if (sameSite(link) && !fetchedPages.has(tidy(link)) && !linked.has(link)) linked.set(link, url);
  await mapLimit([...linked].slice(0, config.links), config.concurrency, async ([link, from]) => {
    const target = await get(link, 0);
    if (target && (target.status === 0 || target.status >= 400)) add('broken_link', `${target.status || target.error} on ${path(link)}`, path(from));
  });

  // http to https
  const plain = await get(`http://${host}/`, 0);
  if (plain && plain.status !== 0) {
    if (plain.status === 200) add('http_not_redirected', 'http://… answers instead of redirecting', '/');
    else if ((plain.status === 302 || plain.status === 307) && plain.location?.startsWith('https://')) add('http_redirect_temporary', `${plain.status}`, '/');
  }

  // other addresses that should reach this site
  for (const variant of site.variants ?? []) {
    const reply = await get(`${variant}/`, config.htmlBytes);
    if (!reply) continue;
    const towardsSite = reply.location && (resolve(reply.location, variant) ?? '').startsWith(site.origin);
    if (reply.status === 301 || reply.status === 308) { if (!towardsSite) add('variant_redirect_elsewhere', `${hostOf(variant)} sends ${reply.status} to ${reply.location}`, hostOf(variant)); }
    else if (reply.status === 302 || reply.status === 307 || reply.status === 303) add(towardsSite ? 'variant_temporary_redirect' : 'variant_redirect_elsewhere', `${hostOf(variant)} uses ${reply.status} to ${reply.location ?? 'nowhere'}`, hostOf(variant));
    else if (reply.status === 200 && /html/.test(reply.type)) {
      const canonical = analyzeHtml(reply.text, `${variant}/`).canonical;
      if (!canonical || !resolve(canonical, variant)?.startsWith(site.origin)) add('variant_duplicate', `${hostOf(variant)} answers with 200 and ${canonical ? `a canonical link to ${canonical}` : 'no canonical link'}`, hostOf(variant));
    } else add('variant_broken', `${hostOf(variant)} ${reply.status || reply.error}`, hostOf(variant));
  }

  const counts = { high: 0, medium: 0, low: 0 };
  for (const finding of findings) counts[finding.severity] += 1;
  const kinds = new Map(findings.map(finding => [finding.code, finding.severity]));
  const score = Math.max(0, 100 - [...kinds.values()].reduce((sum, severity) => sum + weight[severity], 0));
  return { key: site.key, label: site.label, checked: analyzed.size, findings, counts, score, incomplete };
}

/** The findings grouped by code, worst first: [{ code, severity, title, count, example: { page, detail } }]. */
export function summarizeFindings(findings) {
  const groups = new Map();
  for (const finding of findings) {
    const group = groups.get(finding.code) ?? { code: finding.code, severity: finding.severity, title: finding.title, count: 0, example: { page: finding.page, detail: finding.detail } };
    group.count += 1;
    groups.set(finding.code, group);
  }
  return [...groups.values()].sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity] || b.count - a.count || a.code.localeCompare(b.code));
}
