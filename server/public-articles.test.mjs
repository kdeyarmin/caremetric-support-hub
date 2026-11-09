import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { appServer, securityHeaders } from './http.mjs';
import { feedArticle, publicArticleFeed, splitArticle } from './public-articles.mjs';
import { fireDrillDraft, referralDraft } from './agents/content/fixtures.mjs';
import { topics } from './agents/content/topics.mjs';
import { checkDraft } from './agents/content/validate.mjs';
import { legalDisclaimer, officialSources } from './agents/content/facts.mjs';

const topic = key => topics.find(item => item.key === key);
const referral = checkDraft(referralDraft, { topic: topic('home-health-referral-marketing') }).article;
const fireDrills = checkDraft(fireDrillDraft, { topic: topic('pa-fire-drill-requirements') }).article;
const stored = (article, over = {}) => ({
  key: article.slug, title: article.title, description: article.description, markdown: article.body, locale: 'en-US', revision: 1,
  publishedAt: '2026-11-03T14:00:00+00:00', updatedAt: '2026-11-03T14:00:00+00:00', ...over,
});
const intelRows = [stored(referral), { ...stored(referral), title: 'A duplicate' }, { key: 'Bad Key', title: 'Bad key' }, { key: 'no-title', title: ' ' }];

describe('an article\'s parts', () => {
  it('splits the Content Marketer\'s Markdown into the summary, the body, the questions, the sources and the links', () => {
    const parts = splitArticle(referral.body);
    expect(parts.summary).toBe(referralDraft.summary);
    expect(parts.body).toBe(referralDraft.body);
    expect(parts.questions).toEqual(referralDraft.faq);
    expect(parts.citations.map(link => link.url)).toEqual(referralDraft.citations);
    expect(parts.internalLinks).toEqual([
      { label: 'CareMetric Intel', url: 'https://www.caremetricintel.com/' },
      { label: 'A practical framework for targeted healthcare marketing', url: 'https://www.caremetricintel.com/resources/targeted-healthcare-marketing-framework' },
    ]);
    expect(parts.disclaimer).toBeNull();
  });

  it('keeps a regulation article\'s disclaimer and labelled sources', () => {
    const parts = splitArticle(fireDrills.body);
    expect(parts.disclaimer).toBe(legalDisclaimer);
    expect(parts.citations).toContainEqual({ label: officialSources['pacode-2600-132'].label, url: officialSources['pacode-2600-132'].url });
    expect(parts.body).toBe(fireDrillDraft.body);
    expect(parts.body).not.toContain('not legal advice');
  });

  it('leaves Markdown of any other shape whole in the body, so nothing is dropped', () => {
    expect(splitArticle('Do not include PHI.\n\n## Steps\n\nOne.')).toEqual({ summary: '', body: 'Do not include PHI.\n\n## Steps\n\nOne.', questions: [], citations: [], internalLinks: [], disclaimer: null });
    for (const markdown of [
      'Body.\n\n## Sources\n\nSee the code.',
      'Body.\n\n## Sources\n\n- [A](https://pa.gov/)\n\n## After\n\nMore text.',
      'Body.\n\n## Frequently asked questions\n\nIntro text.\n\n### Why?\n\nBecause.',
      'Body.\n\n## Learn more\n\n- [A](javascript:alert(1))',
    ]) {
      const parts = splitArticle(markdown);
      expect(parts.body, markdown).toBe(markdown);
      expect([parts.questions, parts.citations, parts.internalLinks], markdown).toEqual([[], [], []]);
    }
    expect(splitArticle(null).body).toBe('');
  });

  it('returns only the fields an anonymous visitor can read, and drops rows that are not articles', () => {
    const article = feedArticle({ ...stored(referral), id: 'secret', variables: { approvedBy: 'owner' }, revision: 2, updatedAt: null });
    expect(Object.keys(article).sort()).toEqual(['body', 'citations', 'description', 'disclaimer', 'internalLinks', 'key', 'locale', 'markdown', 'publishedAt', 'questions', 'revision', 'summary', 'title', 'updatedAt']);
    expect(article).toMatchObject({ key: referral.slug, revision: 2, publishedAt: '2026-11-03T14:00:00.000Z', updatedAt: '2026-11-03T14:00:00.000Z', markdown: referral.body });
    expect([feedArticle(null), feedArticle({ key: 'Bad Key', title: 'x' }), feedArticle({ key: 'ok', title: '' })]).toEqual([null, null, null]);
  });
});

describe('GET /api/public/articles', () => {
  let server, base, load, clock;
  beforeAll(async () => {
    load = vi.fn(async product => (product === 'caremetric-intel' ? intelRows : []));
    clock = 0;
    server = appServer({ auth: {}, gateway: {}, delegations: {}, origins: [], publicArticles: publicArticleFeed({ load: product => load(product), now: () => clock, log: () => {} }) });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => { await new Promise(resolve => server.close(resolve)); });

  it('lists one product\'s public articles, once each, cacheable for five minutes, with the security headers', async () => {
    const response = await fetch(`${base}/api/public/articles?product=caremetric-intel`, { headers: { cookie: 'hub_session=whatever' } });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('public, max-age=300');
    expect(response.headers.get('set-cookie')).toBeNull();
    for (const [name, value] of Object.entries(securityHeaders)) expect(response.headers.get(name), name).toBe(value);
    const body = await response.json();
    expect(body.product).toBe('caremetric-intel');
    expect(body.articles.map(article => [article.key, article.title])).toEqual([[referral.slug, referral.title]]);
    expect(body.articles[0]).toMatchObject({ description: referral.description, summary: referralDraft.summary, questions: referralDraft.faq, revision: 1 });
    expect((await (await fetch(`${base}/api/public/articles?product=carebase`)).json())).toEqual({ product: 'carebase', articles: [] });
  });

  it('answers one article by its key, and 404 for a key the product has no public article for', async () => {
    const response = await fetch(`${base}/api/public/articles/${referral.slug}?product=caremetric-intel`);
    expect(response.status).toBe(200);
    expect((await response.json()).article).toMatchObject({ key: referral.slug, markdown: referral.body });
    for (const path of [`/api/public/articles/${referral.slug}?product=carebase`, '/api/public/articles/no-such-article?product=caremetric-intel', '/api/public/articles/Bad%20Key?product=caremetric-intel']) {
      const missing = await fetch(`${base}${path}`);
      expect([missing.status, missing.headers.get('cache-control')], path).toEqual([404, 'public, max-age=60']);
    }
  });

  it('refuses anything but one known product, other parameters and other methods', async () => {
    for (const query of ['', '?product=', '?product=caremetric-intel&product=carebase', '?product=caremetric-intel&draft=1']) {
      expect((await fetch(`${base}/api/public/articles${query}`)).status, query).toBe(400);
    }
    expect((await fetch(`${base}/api/public/articles?product=breathe`)).status).toBe(404);
    expect((await fetch(`${base}/api/public/articles/a/b?product=caremetric-intel`)).status).toBe(404);
    const post = await fetch(`${base}/api/public/articles?product=caremetric-intel`, { method: 'POST' });
    expect([post.status, post.headers.get('cache-control')]).toEqual([405, 'no-store']);
    const head = await fetch(`${base}/api/public/articles?product=caremetric-intel`, { method: 'HEAD' });
    expect([head.status, await head.text()]).toEqual([200, '']);
  });

  it('does not exist until the database declares the feature', async () => {
    const closed = appServer({ auth: {}, gateway: {}, delegations: {}, origins: [] });
    closed.listen(0, '127.0.0.1'); await once(closed, 'listening');
    try {
      const response = await fetch(`http://127.0.0.1:${closed.address().port}/api/public/articles?product=caremetric-intel`);
      expect([response.status, response.headers.get('cache-control')]).toEqual([404, 'no-store']);
    } finally { await new Promise(resolve => closed.close(resolve)); }
  });
});

describe('reading the articles', () => {
  it('reads each product once per five minutes, one read at a time, and serves the last list when the database cannot answer', async () => {
    const reads = vi.fn(async () => intelRows);
    const logs = [];
    let at = 0;
    const feed = publicArticleFeed({ load: reads, now: () => at, log: line => logs.push(line) });
    await Promise.all([feed.articles('caremetric-intel'), feed.articles('caremetric-intel'), feed.articles('carebase')]);
    expect(reads.mock.calls.map(call => call[0])).toEqual(['caremetric-intel', 'carebase']);
    at = 299_999; await feed.articles('caremetric-intel');
    expect(reads).toHaveBeenCalledTimes(2);
    at = 300_000; reads.mockRejectedValue(new Error('secret detail'));
    for (let index = 0; index < 10; index += 1) expect(await feed.articles('caremetric-intel')).toHaveLength(1);
    expect([reads.mock.calls.length, logs]).toEqual([3, ['{"event":"hub_public_articles_load_failed","product":"caremetric-intel"}']]);
    at = 360_000; await feed.articles('caremetric-intel');
    expect(reads).toHaveBeenCalledTimes(4);
  });

  it('with no list at all answers 503, and still reads the database at most once a minute', async () => {
    const reads = vi.fn(async () => { throw new Error('down'); });
    let at = 0;
    const feed = publicArticleFeed({ load: reads, now: () => at, log: () => {} });
    for (let index = 0; index < 5; index += 1) await expect(feed.articles('advisors')).rejects.toMatchObject({ status: 503 });
    expect(reads).toHaveBeenCalledTimes(1);
    at = 60_000; reads.mockResolvedValueOnce([]);
    expect(await feed.articles('advisors')).toEqual([]);
  });
});
