import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appServer, securityHeaders } from './http.mjs';
import { helpCenter, pageHtml, publicArticles, scriptJson } from './help-center.mjs';
import { articleHomeUrl, servedElsewhere } from './agents/content/facts.mjs';

const index = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="description" content="CareMetric central support, knowledge, media, and learning hub." />
    <title>CareMetric Support Hub</title>
    <script type="module" crossorigin src="/assets/index-abc123.js"></script>
    <link rel="stylesheet" crossorigin href="/assets/index-abc123.css">
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>
`;
const row = (over = {}) => ({
  id: '11111111-1111-4111-8111-111111111111', content_key: 'pennsylvania-fire-drills', kind: 'article', status: 'published', access_level: 'public',
  title: 'Fire drills for "personal care" homes & ALFs <b>', summary: 'Monthly drills, a sleeping-hours drill and the record: $199 stays $199.',
  body_markdown: '**In short:** hold a drill monthly.\n\n## Records\n\nSee [§ 2600.132](https://www.pacodeandbulletin.gov/secure/pacode/data/055/chapter2600/s2600.132.html).\n\n<script>alert(1)</script>',
  product_ids: ['p-carebase'], locale: 'en-US', ...over,
});
const rows = [
  row(),
  row({ id: '2', content_key: 'support.protect-patient-information', title: 'Protect patient information', summary: 'Never send PHI.', body_markdown: 'Do not include PHI.', product_ids: ['p-other'] }),
  row({ id: '3', content_key: 'account.invite-user', access_level: 'customer', title: 'Invite a user' }),
  row({ id: '4', content_key: 'course.basics', kind: 'course', title: 'A course' }),
  row({ id: '5', content_key: 'Bad Key', title: 'Bad key' }),
];

let dist, server, base, load, clock;
beforeAll(async () => {
  dist = await mkdtemp(join(tmpdir(), 'hub-help-'));
  await writeFile(join(dist, 'index.html'), index);
  load = vi.fn(async () => rows);
  clock = 1_000_000;
  const help = helpCenter({ load: () => load(), dist, now: () => clock, log: () => {} });
  server = appServer({ auth: {}, gateway: {}, delegations: {}, origins: ['https://help.caremetric.ai'], helpCenter: help, dist });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise(resolve => server.close(resolve)); await rm(dist, { recursive: true, force: true }); });

describe('public help articles as HTML', () => {
  it('serves a public article with its own title, description, canonical address, sharing tags and structured data', async () => {
    const response = await fetch(`${base}/help/articles/pennsylvania-fire-drills`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('public, max-age=300');
    for (const [name, value] of Object.entries(securityHeaders)) expect(response.headers.get(name), name).toBe(value);
    const html = await response.text();
    expect(html).toContain('<title>Fire drills for &quot;personal care&quot; homes &amp; ALFs &lt;b&gt; | CareMetric Help Center</title>');
    expect(html).toContain('<meta name="description" content="Monthly drills, a sleeping-hours drill and the record: $199 stays $199." />');
    expect(html.match(/<meta name="description"/g)).toHaveLength(1);
    expect(html).toContain('<link rel="canonical" href="https://help.caremetric.ai/help/articles/pennsylvania-fire-drills" />');
    expect(html).toContain('<meta property="og:type" content="article" />');
    expect(html).toContain('<meta property="og:url" content="https://help.caremetric.ai/help/articles/pennsylvania-fire-drills" />');
    expect(html).toContain('<meta name="twitter:card" content="summary" />');
    const jsonLd = JSON.parse(/<script type="application\/ld\+json">([^<]*)<\/script>/.exec(html)[1]);
    expect(jsonLd).toMatchObject({ '@context': 'https://schema.org', '@type': 'Article', headline: 'Fire drills for "personal care" homes & ALFs <b>', url: 'https://help.caremetric.ai/help/articles/pennsylvania-fire-drills', inLanguage: 'en-US', publisher: { '@type': 'Organization', name: 'CareMetric' } });
    // The app's own script and styles stay, so it takes over at the same address.
    expect(html).toContain('<script type="module" crossorigin src="/assets/index-abc123.js"></script>');
    expect(html).toContain('<link rel="stylesheet" crossorigin href="/assets/index-abc123.css">');
  });

  it('renders the body from Markdown with every piece of HTML escaped, inside the app root', async () => {
    const html = await (await fetch(`${base}/help/articles/pennsylvania-fire-drills`)).text();
    const root = html.slice(html.indexOf('<div id="root">'), html.lastIndexOf('</body>'));
    expect(root).toContain('<h1>Fire drills for &quot;personal care&quot; homes &amp; ALFs &lt;b&gt;</h1>');
    expect(root).toContain('<p><strong>In short:</strong> hold a drill monthly.</p>');
    expect(root).toContain('<h2>Records</h2>');
    expect(root).toContain('<a href="https://www.pacodeandbulletin.gov/secure/pacode/data/055/chapter2600/s2600.132.html">§ 2600.132</a>');
    expect(root).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(root).not.toContain('<script');
    // Other public articles are linked; customer-only items, courses and malformed keys never are.
    expect(root).toContain('<a href="/help/articles/support.protect-patient-information">Protect patient information</a>');
    expect(root).not.toMatch(/account\.invite-user|course\.basics|Bad Key/);
  });

  it('answers a HEAD request with the headers only', async () => {
    const response = await fetch(`${base}/help/articles/pennsylvania-fire-drills`, { method: 'HEAD' });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('');
  });

  it('answers 404 with the app shell, marked noindex, for an address with no public article', async () => {
    for (const key of ['no-such-article', 'account.invite-user', 'course.basics', 'Bad%20Key', 'UPPER']) {
      const response = await fetch(`${base}/help/articles/${key}`);
      expect(response.status, key).toBe(404);
      const html = await response.text();
      expect(html).toContain('<meta name="robots" content="noindex" />');
      expect(html).toContain('<title>Article not found | CareMetric Help Center</title>');
      expect(html).toContain('/assets/index-abc123.js');
      expect(html).not.toContain('rel="canonical"');
    }
  });

  it('moves the address with a trailing slash to the one without, and leaves everything else to the app', async () => {
    const moved = await fetch(`${base}/help/articles/pennsylvania-fire-drills/`, { redirect: 'manual' });
    expect([moved.status, moved.headers.get('location')]).toEqual([301, '/help/articles/pennsylvania-fire-drills']);
    for (const path of ['/help', '/learn', '/help/articles', '/']) {
      const response = await fetch(`${base}${path}`);
      expect(response.status, path).toBe(200);
      expect(await response.text(), path).toBe(index);
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
    expect((await fetch(`${base}/help/articles/pennsylvania-fire-drills`, { method: 'POST' })).status).toBe(405);
  });
});

describe('the sitemap and robots.txt', () => {
  it('lists the help center, the learning library and every public article', async () => {
    const response = await fetch(`${base}/sitemap.xml`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/xml; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('public, max-age=3600');
    const xml = await response.text();
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">')).toBe(true);
    expect([...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(match => match[1])).toEqual([
      'https://help.caremetric.ai/help', 'https://help.caremetric.ai/learn',
      'https://help.caremetric.ai/help/articles/pennsylvania-fire-drills', 'https://help.caremetric.ai/help/articles/support.protect-patient-information',
    ]);
  });

  it('lets crawlers in, keeps them out of the API and administration, and names the sitemap', async () => {
    const response = await fetch(`${base}/robots.txt`);
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('public, max-age=86400');
    expect(await response.text()).toBe('User-agent: *\nDisallow: /api/\nDisallow: /admin\n\nSitemap: https://help.caremetric.ai/sitemap.xml\n');
  });
});

describe('reading the articles', () => {
  it('reads the list once per five minutes, and serves the last list when the database cannot answer', async () => {
    const reads = vi.fn(async () => rows);
    let at = 0;
    const help = helpCenter({ load: reads, now: () => at, log: () => {} });
    await Promise.all([help.articles(), help.articles(), help.articles()]);
    expect(reads).toHaveBeenCalledTimes(1);
    at = 299_999; await help.articles();
    expect(reads).toHaveBeenCalledTimes(1);
    at = 300_000; reads.mockRejectedValueOnce(new Error('database down'));
    expect((await help.articles()).map(article => article.key)).toEqual(['pennsylvania-fire-drills', 'support.protect-patient-information']);
    expect(reads).toHaveBeenCalledTimes(2);
  });

  it('backs off a failed refresh: one database read a minute while it fails, the last good list served meanwhile', async () => {
    const reads = vi.fn(async () => rows);
    const logs = [];
    let at = 0;
    const help = helpCenter({ load: reads, now: () => at, log: line => logs.push(line) });
    await help.articles();
    at = 300_000;
    reads.mockRejectedValue(new Error('database down'));
    // Crawler traffic during the outage: every request gets the last list, and only the first one reads the database.
    for (let index = 0; index < 25; index += 1) expect((await help.articles()).map(article => article.key)).toEqual(['pennsylvania-fire-drills', 'support.protect-patient-information']);
    expect(await Promise.all([help.articles(), help.articles()])).toHaveLength(2);
    expect([reads.mock.calls.length, logs.length]).toEqual([2, 1]);
    at = 359_999; await help.articles();
    expect(reads).toHaveBeenCalledTimes(2);
    at = 360_000; await help.articles();
    expect([reads.mock.calls.length, logs.length]).toEqual([3, 2]);
    expect(logs.every(line => line === '{"event":"hub_help_center_load_failed"}')).toBe(true);
    // The first read that succeeds ends the back-off, and the list is fresh for five minutes again.
    reads.mockResolvedValue(rows.slice(1));
    at = 420_000;
    expect((await help.articles()).map(article => article.key)).toEqual(['support.protect-patient-information']);
    at = 719_999; await help.articles();
    expect(reads).toHaveBeenCalledTimes(4);
  });

  it('with no list at all answers unavailable to every request, and still reads the database at most once a minute', async () => {
    const reads = vi.fn(async () => { throw new Error('database down'); });
    let at = 0;
    const help = helpCenter({ load: reads, now: () => at, log: () => {} });
    for (let index = 0; index < 5; index += 1) await expect(help.articles()).rejects.toMatchObject({ code: 'help_unavailable' });
    expect(reads).toHaveBeenCalledTimes(1);
    at = 60_000;
    await expect(help.articles()).rejects.toMatchObject({ code: 'help_unavailable' });
    expect(reads).toHaveBeenCalledTimes(2);
    reads.mockResolvedValueOnce(rows);
    at = 120_000;
    expect(await help.articles()).toHaveLength(2);
  });

  it('answers 503 with the app shell when there is no list at all', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hub-help-down-'));
    try {
      await writeFile(join(dir, 'index.html'), index);
      const logs = [];
      const failing = vi.fn(async () => { throw new Error('secret detail'); });
      const down = appServer({ auth: {}, gateway: {}, delegations: {}, origins: [], dist: dir,
        helpCenter: helpCenter({ load: failing, dist: dir, log: line => logs.push(line) }) });
      down.listen(0, '127.0.0.1'); await once(down, 'listening');
      try {
        const address = `http://127.0.0.1:${down.address().port}`;
        const page = await fetch(`${address}/help/articles/pennsylvania-fire-drills`);
        expect([page.status, page.headers.get('retry-after'), page.headers.get('cache-control')]).toEqual([503, '120', 'no-store']);
        expect(await page.text()).toBe(index);
        expect((await fetch(`${address}/sitemap.xml`)).status).toBe(503);
        for (let index = 0; index < 5; index += 1) expect((await fetch(`${address}/help/articles/support.protect-patient-information`)).status).toBe(503);
        // Seven requests inside a minute, one database read and one log line.
        expect([failing.mock.calls.length, logs.length]).toEqual([1, 1]);
        expect(logs.join('\n')).not.toContain('secret detail');
      } finally { await new Promise(resolve => down.close(resolve)); }
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('keeps public, published articles with a well-formed key, once each', () => {
    expect(publicArticles([...rows, row({ title: 'A second revision' })]).map(article => [article.key, article.title])).toEqual([
      ['pennsylvania-fire-drills', 'Fire drills for "personal care" homes & ALFs <b>'], ['support.protect-patient-information', 'Protect patient information'],
    ]);
    expect(publicArticles(null)).toEqual([]);
    expect(publicArticles([row({ status: 'retired' }), row({ title: ' ' }), row({ locale: 'xx_bad' })]).map(article => article.locale)).toEqual(['en-US']);
  });

  it('builds pages without letting article text act as markup or as a replacement pattern', () => {
    expect(scriptJson({ text: '</script><script>alert(1)</script> & \u2028' })).toBe('{"text":"\\u003c/script\\u003e\\u003cscript\\u003ealert(1)\\u003c/script\\u003e \\u0026 \\u2028"}');
    const html = pageHtml(index, { title: "$& $1 $' title", description: '$` description', content: "<p>$& and $'</p>" });
    expect(html).toContain("<title>$&amp; $1 $&#39; title</title>");
    expect(html).toContain('content="$` description"');
    expect(html).toContain("<div id=\"root\"><p>$& and $'</p></div>");
  });
});

describe('articles whose home is the product\'s own website', () => {
  const intelId = '22222222-2222-4222-8222-222222222222';
  const carebaseId = '33333333-3333-4333-8333-333333333333';
  const products = [{ id: intelId, slug: 'caremetric-intel' }, { id: carebaseId, slug: 'carebase' }];
  const intelRows = [
    row({ id: 'i1', content_key: 'home-health-referral-marketing', title: 'Home health referral marketing', summary: 'Plan referral outreach.', product_ids: [intelId] }),
    row({ id: 'i2', content_key: 'shared-guide', title: 'A shared guide', summary: 'For two products.', product_ids: [intelId, carebaseId] }),
    row({ id: 'i3', content_key: 'carebase-guide', title: 'A CareBase guide', summary: 'For CareBase.', product_ids: [carebaseId] }),
  ];
  let intelServer, intelBase;
  beforeAll(async () => {
    const help = helpCenter({ load: async () => intelRows, loadProducts: async () => products, elsewhere: (product, key) => (servedElsewhere(product) ? articleHomeUrl(product, key) : null), dist, log: () => {} });
    intelServer = appServer({ auth: {}, gateway: {}, delegations: {}, origins: [], helpCenter: help, dist });
    intelServer.listen(0, '127.0.0.1'); await once(intelServer, 'listening');
    intelBase = `http://127.0.0.1:${intelServer.address().port}`;
  });
  afterAll(async () => { await new Promise(resolve => intelServer.close(resolve)); });

  it('keeps an Intel article readable here, with its canonical link, sharing address and structured data on Intel\'s website', async () => {
    const response = await fetch(`${intelBase}/help/articles/home-health-referral-marketing`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('<link rel="canonical" href="https://www.caremetricintel.com/resources/home-health-referral-marketing" />');
    expect(html).toContain('<meta property="og:url" content="https://www.caremetricintel.com/resources/home-health-referral-marketing" />');
    const jsonLd = JSON.parse(/<script type="application\/ld\+json">([^<]*)<\/script>/.exec(html)[1]);
    expect(jsonLd).toMatchObject({ url: 'https://www.caremetricintel.com/resources/home-health-referral-marketing', mainEntityOfPage: { '@id': 'https://www.caremetricintel.com/resources/home-health-referral-marketing' } });
    expect(html).toContain('<h1>Home health referral marketing</h1>');
    expect(html).not.toContain('href="https://help.caremetric.ai/help/articles/home-health-referral-marketing"');
  });

  it('keeps the help center the home of every other article, an article shared with another product included', async () => {
    for (const key of ['shared-guide', 'carebase-guide']) {
      const html = await (await fetch(`${intelBase}/help/articles/${key}`)).text();
      expect(html, key).toContain(`<link rel="canonical" href="https://help.caremetric.ai/help/articles/${key}" />`);
    }
  });

  it('leaves Intel\'s articles out of the sitemap', async () => {
    const xml = await (await fetch(`${intelBase}/sitemap.xml`)).text();
    expect([...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(match => match[1])).toEqual([
      'https://help.caremetric.ai/help', 'https://help.caremetric.ai/learn',
      'https://help.caremetric.ai/help/articles/shared-guide', 'https://help.caremetric.ai/help/articles/carebase-guide',
    ]);
  });

  it('reads the products with the articles, and keeps the last list when either read fails', async () => {
    const reads = vi.fn(async () => intelRows);
    const productReads = vi.fn(async () => products);
    let at = 0;
    const elsewhere = (product, key) => (servedElsewhere(product) ? articleHomeUrl(product, key) : null);
    const help = helpCenter({ load: reads, loadProducts: productReads, elsewhere, now: () => at, log: () => {} });
    expect((await help.articles()).map(article => article.home)).toEqual(['https://www.caremetricintel.com/resources/home-health-referral-marketing', null, null]);
    at = 300_000; productReads.mockRejectedValueOnce(new Error('down'));
    expect((await help.articles())[0].home).toBe('https://www.caremetricintel.com/resources/home-health-referral-marketing');
    expect([reads.mock.calls.length, productReads.mock.calls.length]).toEqual([2, 2]);
    // Without a products list nothing is sent elsewhere; an address that is not https is never used.
    expect(publicArticles(intelRows, { elsewhere }).every(article => article.home === null)).toBe(true);
    expect(publicArticles(intelRows, { slugs: new Map([[intelId, 'caremetric-intel']]), elsewhere: () => 'javascript:alert(1)' })[0].home).toBeNull();
    // An item with a different live revision for each product comes back as one row per revision: its products are all of them,
    // whichever row comes first, so it stays the help center's.
    const split = [row({ id: 'r1', content_key: 'split-revisions', product_ids: [intelId] }), row({ id: 'r2', content_key: 'split-revisions', title: 'Other revision', product_ids: [carebaseId] })];
    expect(publicArticles(split, { slugs: new Map(products.map(item => [item.id, item.slug])), elsewhere }).map(article => [article.key, article.home])).toEqual([['split-revisions', null]]);
  });
});
