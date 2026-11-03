import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { escapeHtml, renderMarkdownHtml } from '../src/lib/markdown.ts';

/**
 * The help center for crawlers, AI assistants and the first paint. The app is a single-page application, so without this a
 * crawler that runs no scripts sees an empty page for every address. The server answers three kinds of request itself:
 *
 * - `/help/articles/<content key>`: a public, published article as real HTML (its title, description, canonical address, Open
 *   Graph tags, an Article in JSON-LD and the body rendered from Markdown by src/lib/markdown.ts, which escapes everything), inside
 *   the app's own index.html, so the app's script and styles load and take over at the same address. An address with no public
 *   article answers 404 (marked noindex) with the same page shell, so the app can still show a signed-in customer an article for
 *   customers.
 * - `/sitemap.xml`: the help center's public pages and every public article.
 * - `/robots.txt`: everything may be crawled except the API and the administration pages, and where the sitemap is.
 *
 * The articles are the ones an anonymous visitor's app reads (`load`, the hub.list_published_content RPC without a session), so a
 * crawler is shown exactly what a visitor sees. They are cached for `ttlMs` (five minutes) and refreshed by one request at a time;
 * when the database cannot answer, the last list is served, and with no list at all the page answers 503 with the app shell.
 * Responses keep every security header the server sets (including the Content Security Policy: the JSON-LD block is data, not a
 * script) and are cacheable by browsers and crawlers for a few minutes.
 */
const keyPattern = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const articleRoute = /^\/help\/articles\/([^/]+)(\/?)$/;
const fallbackTemplate = '<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="UTF-8" />\n    <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n    <title>CareMetric Support Hub</title>\n  </head>\n  <body>\n    <div id="root"></div>\n  </body>\n</html>\n';
const siteName = 'CareMetric Help Center';
const moreLimit = 6;

/** JSON that is safe inside a script element: nothing in it can close the element or start markup. */
export const scriptJson = value => JSON.stringify(value)
  .replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

const xml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]);

/** At most `limit` characters, cut at a word, for a description. */
const clip = (value, limit) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), limit - 40)).trimEnd()}…`;
};

/** The public, published articles in `rows` (the list_published_content rows), one per content key, in the list's order. */
export function publicArticles(rows) {
  const seen = new Set();
  const articles = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row?.kind !== 'article' || row.status !== 'published' || row.access_level !== 'public') continue;
    if (typeof row.content_key !== 'string' || !keyPattern.test(row.content_key) || seen.has(row.content_key)) continue;
    if (typeof row.title !== 'string' || !row.title.trim()) continue;
    seen.add(row.content_key);
    articles.push({
      key: row.content_key, title: row.title.trim(), summary: typeof row.summary === 'string' ? row.summary.trim() : '',
      body: typeof row.body_markdown === 'string' ? row.body_markdown : '', products: Array.isArray(row.product_ids) ? row.product_ids : [],
      locale: typeof row.locale === 'string' && /^[a-z]{2}(?:-[A-Z]{2})?$/.test(row.locale) ? row.locale : 'en-US',
    });
  }
  return articles;
}

/** The app's index.html with the page's head tags and its content in place. Replacements are functions, so a "$" in an article stays text. */
export function pageHtml(template, { title, description = null, canonical = null, head = [], content, robots = null }) {
  let html = template.replace(/<title>[\s\S]*?<\/title>/i, () => `<title>${escapeHtml(title)}</title>`);
  if (description !== null) {
    const meta = `<meta name="description" content="${escapeHtml(description)}" />`;
    html = /<meta\s+name="description"[^>]*>/i.test(html) ? html.replace(/<meta\s+name="description"[^>]*>/i, () => meta) : html.replace(/<\/title>/i, () => `</title>\n    ${meta}`);
  }
  const extra = [
    ...(robots ? [`<meta name="robots" content="${escapeHtml(robots)}" />`] : []),
    ...(canonical ? [`<link rel="canonical" href="${escapeHtml(canonical)}" />`] : []),
    ...head,
  ];
  if (extra.length) html = html.replace(/\s*<\/head>/i, () => `\n    ${extra.join('\n    ')}\n  </head>`);
  return /<div id="root"><\/div>/.test(html)
    ? html.replace(/<div id="root"><\/div>/, () => `<div id="root">${content}</div>`)
    : html.replace(/<body([^>]*)>/i, (_, attributes) => `<body${attributes}><div id="root">${content}</div>`);
}

const shell = main => `<div class="public-help-shell"><header class="public-help-header"><a class="brand-lockup brand-lockup-large" href="/help"><span><strong>CareMetric</strong><small>Help center</small></span></a><nav class="public-help-nav" aria-label="Public support navigation"><a href="/help">Help center</a><a href="/learn">Learning library</a></nav></header><main class="public-help-wrap">${main}</main></div>`;

export function helpCenter({ load, origin = 'https://help.caremetric.ai', dist = resolve('dist'), ttlMs = 5 * 60_000, now = () => Date.now(), log = line => console.warn(line) }) {
  const base = String(origin).replace(/\/+$/, '');
  let cache = null;
  let loading = null;
  let template = null;
  // Each article's page is built once per list read, not once per request.
  let pages = new Map();

  async function articles() {
    if (cache && now() - cache.at < ttlMs) return cache.list;
    loading ??= Promise.resolve().then(load).then(rows => {
      cache = { at: now(), list: publicArticles(rows) };
      pages = new Map();
      return cache.list;
    }).finally(() => { loading = null; });
    try {
      return await loading;
    } catch {
      log(JSON.stringify({ event: 'hub_help_center_load_failed' }));
      if (cache) return cache.list;
      throw Object.assign(new Error('The help center could not be read.'), { code: 'help_unavailable' });
    }
  }

  async function page() {
    if (template) return template;
    try { template = await readFile(resolve(dist, 'index.html'), 'utf8'); } catch { return fallbackTemplate; }
    return template;
  }

  function send(req, res, status, type, body, cacheControl, extra = {}) {
    res.statusCode = status;
    res.setHeader('Content-Type', type);
    res.setHeader('Cache-Control', cacheControl);
    for (const [name, value] of Object.entries(extra)) res.setHeader(name, value);
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  function articleHtml(article, list, template) {
    const url = `${base}/help/articles/${article.key}`;
    const description = clip(article.summary || article.title, 300);
    const more = list.filter(other => other.key !== article.key)
      .sort((a, b) => Number(b.products.some(id => article.products.includes(id))) - Number(a.products.some(id => article.products.includes(id))))
      .slice(0, moreLimit);
    const structured = {
      '@context': 'https://schema.org', '@type': 'Article', headline: clip(article.title, 110), description, url,
      mainEntityOfPage: { '@type': 'WebPage', '@id': url }, inLanguage: article.locale, isAccessibleForFree: true,
      author: { '@type': 'Organization', name: 'CareMetric', url: base }, publisher: { '@type': 'Organization', name: 'CareMetric', url: base },
    };
    const head = [
      `<meta property="og:type" content="article" />`,
      `<meta property="og:site_name" content="${siteName}" />`,
      `<meta property="og:title" content="${escapeHtml(article.title)}" />`,
      `<meta property="og:description" content="${escapeHtml(description)}" />`,
      `<meta property="og:url" content="${escapeHtml(url)}" />`,
      `<meta property="og:locale" content="${escapeHtml(article.locale.replace('-', '_'))}" />`,
      `<meta name="twitter:card" content="summary" />`,
      `<meta name="twitter:title" content="${escapeHtml(article.title)}" />`,
      `<meta name="twitter:description" content="${escapeHtml(description)}" />`,
      `<script type="application/ld+json">${scriptJson(structured)}</script>`,
    ];
    const content = shell(`<article class="panel help-article"><nav class="help-article-crumbs" aria-label="Breadcrumb"><a href="/help">Help center</a></nav><span class="eyebrow">Article</span><h1>${escapeHtml(article.title)}</h1>${article.summary ? `<p class="help-article-summary">${escapeHtml(article.summary)}</p>` : ''}<div class="help-article-body">${renderMarkdownHtml(article.body)}</div></article>${more.length
      ? `<nav class="panel help-article-more" aria-label="More help articles"><h2>More from the help center</h2><ul>${more.map(other => `<li><a href="/help/articles/${escapeHtml(other.key)}">${escapeHtml(other.title)}</a></li>`).join('')}</ul></nav>`
      : ''}`);
    return pageHtml(template, { title: `${article.title} | ${siteName}`, description, canonical: url, head, content });
  }

  function missingHtml(template) {
    const content = shell('<section class="panel help-article help-article-missing"><span class="eyebrow">Help center</span><h1>This article is not available</h1><p>It may have moved, or it may be for signed-in customers only.</p><a class="text-link" href="/help">Back to the help center</a></section>');
    return pageHtml(template, { title: `Article not found | ${siteName}`, robots: 'noindex', content });
  }

  /** Answers the request when it is one of the help center's own addresses (true), or leaves it to the app (false). Never rejects. */
  async function serve(req, res, path) {
    if (path === '/robots.txt') {
      send(req, res, 200, 'text/plain; charset=utf-8', `User-agent: *\nDisallow: /api/\nDisallow: /admin\n\nSitemap: ${base}/sitemap.xml\n`, 'public, max-age=86400');
      return true;
    }
    if (path === '/sitemap.xml') {
      let list;
      try { list = await articles(); } catch {
        send(req, res, 503, 'text/plain; charset=utf-8', 'The sitemap is temporarily unavailable.', 'no-store', { 'Retry-After': '120' });
        return true;
      }
      const addresses = [`${base}/help`, `${base}/learn`, ...list.map(article => `${base}/help/articles/${article.key}`)];
      send(req, res, 200, 'application/xml; charset=utf-8',
        `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${addresses.map(address => `  <url><loc>${xml(address)}</loc></url>`).join('\n')}\n</urlset>\n`,
        'public, max-age=3600');
      return true;
    }
    const match = articleRoute.exec(path);
    if (!match) return false;
    // One address per article: the form with a trailing slash moves to the one without.
    if (match[2] && keyPattern.test(match[1])) {
      send(req, res, 301, 'text/plain; charset=utf-8', '', 'public, max-age=86400', { Location: `/help/articles/${match[1]}` });
      return true;
    }
    const template = await page();
    let list;
    try { list = await articles(); } catch {
      send(req, res, 503, 'text/html; charset=utf-8', template, 'no-store', { 'Retry-After': '120' });
      return true;
    }
    const article = keyPattern.test(match[1]) ? list.find(item => item.key === match[1]) : null;
    if (!article) {
      send(req, res, 404, 'text/html; charset=utf-8', missingHtml(template), 'public, max-age=60');
      return true;
    }
    if (!pages.has(article.key)) pages.set(article.key, articleHtml(article, list, template));
    send(req, res, 200, 'text/html; charset=utf-8', pages.get(article.key), 'public, max-age=300');
    return true;
  }

  return { serve, articles };
}
