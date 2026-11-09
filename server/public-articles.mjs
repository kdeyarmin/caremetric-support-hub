import { HttpError } from './sms-auth.mjs';
import { productSlugs } from './agents/content/facts.mjs';

/**
 * The public article feed: a product's public help-center articles as JSON, for the product's own website. Intel's website reads it
 * to serve the Content Marketer's CareMetric Intel articles at https://www.caremetricintel.com/resources/<content key>, which is
 * their canonical address (server/help-center.mjs points the help center's copy there). docs/API.md, "Public article feed".
 *
 * - `GET /api/public/articles?product=<product slug>`: `{ product, articles: [...] }`, newest first.
 * - `GET /api/public/articles/<content key>?product=<product slug>`: `{ product, article }`, or 404 when that product has no such
 *   public article.
 *
 * Only what an anonymous help-center visitor can already read: published, public articles published for every visitor (audience
 * "all") whose every publication is for that product, read by private.public_articles (20261109130000_public_articles.sql), which
 * returns no ids, authors, approvers, revision variables or anything about drafts or the publishing action. The stored Markdown
 * is the article as the help center shows it; the feed also returns its parts (`splitArticle`), so a site can lay them out.
 *
 * Reads are cached the way the help center caches its own: per product for `ttlMs` (five minutes), refreshed by one request at a
 * time, the last list served while the database cannot answer, a failed refresh not retried for `retryMs` (a minute), and 503
 * when there is no list at all. Responses may be cached by browsers and shared caches for five minutes. Registered only when the
 * database declares `content.public-articles.v1`.
 */
export const publicArticlesFeature = 'content.public-articles.v1';

const keyPattern = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const route = /^\/api\/public\/articles(?:\/([^/]+))?$/;
const special = { 'frequently asked questions': 'questions', sources: 'citations', 'learn more': 'internalLinks' };
const linkLine = /^- \[([^\]\n]+)\]\((https:\/\/[^\s)]+)\)$/;
const timestamp = value => {
  const date = new Date(value);
  return value && !Number.isNaN(date.getTime()) ? date.toISOString() : null;
};

/**
 * The parts of an article's Markdown as the Content Marketer assembles it (server/agents/content/validate.mjs, assembleArticle):
 * "**In short:** <summary>", the body's own sections, then "## Frequently asked questions" (### question, answer), "## Sources"
 * and "## Learn more" (lists of links) and, last, the italic disclaimer of a regulation article. Markdown of another shape (an
 * article written by hand) is left whole in `body`, with no questions or links, so nothing is ever dropped.
 */
export function splitArticle(markdown) {
  const text = String(markdown ?? '').replace(/\r\n?/g, '\n').trim();
  const whole = { summary: '', body: text, questions: [], citations: [], internalLinks: [], disclaimer: null };
  let rest = text;
  let summary = '';
  const lead = /^\*\*In short:\*\* ([^\n]+)(?:\n\n|$)/.exec(rest);
  if (lead) { summary = lead[1].trim(); rest = rest.slice(lead[0].length); }
  let disclaimer = null;
  const last = /\n\n\*([^*\n]+)\*$/.exec(rest);
  if (last) { disclaimer = last[1].trim(); rest = rest.slice(0, last.index); }

  const headings = [...rest.matchAll(/^## (.+)$/gm)];
  const first = headings.findIndex(match => Object.hasOwn(special, match[1].trim().toLowerCase()));
  const parts = { questions: [], citations: [], internalLinks: [] };
  if (first >= 0) {
    const tail = headings.slice(first);
    for (const [index, heading] of tail.entries()) {
      const name = special[heading[1].trim().toLowerCase()];
      // Every heading after the first special one must be special too, each once; otherwise the article is left whole.
      if (!name || parts[name].length) return { ...whole, summary, body: rest.trim(), disclaimer };
      const end = index + 1 < tail.length ? tail[index + 1].index : rest.length;
      const section = rest.slice(heading.index + heading[0].length, end).trim();
      if (name === 'questions') {
        const blocks = section.split(/^### /m);
        if (blocks.shift().trim()) return { ...whole, summary, body: rest.trim(), disclaimer };
        for (const block of blocks) {
          const [question, ...answer] = block.split('\n');
          if (!question.trim() || !answer.join('\n').trim()) return { ...whole, summary, body: rest.trim(), disclaimer };
          parts.questions.push({ question: question.trim(), answer: answer.join('\n').trim() });
        }
      } else {
        for (const line of section.split('\n')) {
          const link = linkLine.exec(line.trim());
          if (!link) return { ...whole, summary, body: rest.trim(), disclaimer };
          parts[name].push({ label: link[1], url: link[2] });
        }
      }
    }
  }
  return { summary, body: (first >= 0 ? rest.slice(0, headings[first].index) : rest).trim(), ...parts, disclaimer };
}

/** One row of private.public_articles as the feed returns it, or null when it is not a usable article. */
export function feedArticle(row) {
  if (typeof row?.key !== 'string' || !keyPattern.test(row.key) || typeof row.title !== 'string' || !row.title.trim()) return null;
  const markdown = typeof row.markdown === 'string' ? row.markdown : '';
  return {
    key: row.key, title: row.title.trim(), description: typeof row.description === 'string' ? row.description.trim() : '',
    locale: typeof row.locale === 'string' && /^[a-z]{2}(?:-[A-Z]{2})?$/.test(row.locale) ? row.locale : 'en-US',
    revision: Number.isInteger(row.revision) ? row.revision : null,
    publishedAt: timestamp(row.publishedAt), updatedAt: timestamp(row.updatedAt) ?? timestamp(row.publishedAt),
    markdown, ...splitArticle(markdown),
  };
}

export function publicArticleFeed({ load, products = productSlugs, ttlMs = 5 * 60_000, retryMs = 60_000, now = () => Date.now(), log = line => console.warn(line) }) {
  const known = new Set(products);
  // Per product: { cache, loading, failedAt }.
  const state = new Map(products.map(product => [product, { cache: null, loading: null, failedAt: null }]));
  const unavailable = () => new HttpError(503, 'The articles are temporarily unavailable.');

  async function articles(product) {
    const entry = state.get(product);
    if (entry.cache && now() - entry.cache.at < ttlMs) return entry.cache.list;
    if (entry.failedAt !== null && now() - entry.failedAt < retryMs) {
      if (entry.cache) return entry.cache.list;
      throw unavailable();
    }
    entry.loading ??= Promise.resolve().then(() => load(product)).then(rows => {
      const seen = new Set();
      const list = (Array.isArray(rows) ? rows : []).map(feedArticle).filter(article => article && !seen.has(article.key) && seen.add(article.key));
      entry.cache = { at: now(), list };
      entry.failedAt = null;
      return list;
    }, () => {
      entry.failedAt = now();
      log(JSON.stringify({ event: 'hub_public_articles_load_failed', product }));
      throw unavailable();
    }).finally(() => { entry.loading = null; });
    try {
      return await entry.loading;
    } catch {
      if (entry.cache) return entry.cache.list;
      throw unavailable();
    }
  }

  /** Answers /api/public/articles and its articles (true), or leaves the path alone (false). Throws HttpError for a bad request. */
  async function serve(req, res, url) {
    const match = route.exec(url.pathname);
    if (!match) return false;
    if (!['GET', 'HEAD'].includes(req.method)) throw new HttpError(405, 'Method not allowed.');
    const params = [...url.searchParams.keys()];
    if (params.some(name => name !== 'product') || url.searchParams.getAll('product').length !== 1 || !url.searchParams.get('product')) throw new HttpError(400, 'Name one product: ?product=<product slug>.');
    const product = url.searchParams.get('product');
    if (!known.has(product)) throw new HttpError(404, 'Unknown product.');
    const list = await articles(product);
    let body;
    if (match[1] === undefined) body = { product, articles: list };
    else {
      const article = keyPattern.test(match[1]) ? list.find(item => item.key === match[1]) : null;
      if (!article) {
        res.statusCode = 404; res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'public, max-age=60');
        res.end(req.method === 'HEAD' ? undefined : JSON.stringify({ error: 'This article is not available.' }));
        return true;
      }
      body = { product, article };
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.end(req.method === 'HEAD' ? undefined : JSON.stringify(body));
    return true;
  }

  return { serve, articles };
}
