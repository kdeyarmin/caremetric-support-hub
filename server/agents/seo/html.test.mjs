import { describe, expect, it } from 'vitest';
import { analyzeHtml, analyzeRobots, analyzeSitemap, attributes, decode, resolve } from './html.mjs';

const page = 'https://example.test/care/';
const full = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<title>  Assisted living compliance &amp; training | Example  </title>
<meta name="description" content="Keep every ALF compliant with training, tracking and survey readiness in one place.">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="INDEX, Follow">
<link rel="canonical" href="https://example.test/care/">
<meta property="og:title" content="Example"><meta property="og:description" content="d"><meta property="og:image" content="https://example.test/i.png"><meta property="og:url" content="https://example.test/care/">
<meta name="twitter:card" content="summary_large_image">
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Organization","name":"Example"},{"@type":["WebSite","Thing"]}]}</script>
<script>var junk = "<h1>not a heading</h1><a href='/fake'>x</a>";</script>
<style>h1 { color: red } /* <h1> */</style>
</head><body>
<!-- <h1>commented out</h1><a href="/commented">no</a> -->
<h1>Compliance made simple</h1>
<p>Training records, tracked&nbsp;daily. It's what surveyors expect.</p>
<a href="/pricing">Pricing</a> <a href='/contact#form'>Contact</a> <a href=/about>About</a>
<a href="https://other.test/x">Elsewhere</a> <a href="mailto:a@b.test">Mail</a> <a href="#top">Top</a> <a href="/brochure.pdf">PDF</a> <a href="/pricing">Again</a>
<img src="a.png" alt="A"><img src="b.png" alt=""><img src="c.png">
<noscript><h1>Enable JS</h1></noscript>
</body></html>`;

describe('reading a page', () => {
  const facts = analyzeHtml(full, page);

  it('reads the head the way a crawler does', () => {
    expect(facts.title).toBe('Assisted living compliance & training | Example');
    expect(facts.description).toMatch(/^Keep every ALF compliant/);
    expect(facts.canonical).toBe('https://example.test/care/');
    expect(facts.robotsMeta).toBe('index, follow');
    expect(facts.openGraph).toEqual({ title: true, description: true, image: true, url: true });
    expect(facts.twitterCard).toBe(true);
    expect(facts.viewport).toBe(true);
    expect(facts.lang).toBe(true);
  });

  it('counts headings and images in the markup, not in scripts, styles, comments or noscript', () => {
    expect(facts.h1Count).toBe(1);
    expect(facts.images).toEqual({ total: 3, withoutAlt: 1 });
  });

  it('reads structured data, including a graph and a list of types', () => {
    expect(facts.jsonLd).toEqual({ count: 1, invalid: 0, types: ['Organization', 'WebSite', 'Thing'] });
  });

  it('collects each same-site page link once, resolved and without its fragment, and skips the rest', () => {
    expect(facts.links).toEqual(['https://example.test/pricing', 'https://example.test/contact', 'https://example.test/about', 'https://other.test/x']);
  });

  it('counts the words a crawler that does not run scripts would see', () => {
    expect(facts.wordCount).toBeGreaterThan(15);
    expect(facts.wordCount).toBeLessThan(30);
  });
});

describe('reading a poor page', () => {
  it('says what is missing instead of guessing', () => {
    const facts = analyzeHtml('<html><head></head><body><div id="root"></div><script src="/app.js"></script></body></html>', page);
    expect(facts).toMatchObject({
      title: null, description: null, canonical: null, robotsMeta: '', twitterCard: false, viewport: false, lang: false, h1Count: 0, wordCount: 0,
      openGraph: { title: false, description: false, image: false, url: false }, jsonLd: { count: 0, invalid: 0, types: [] }, images: { total: 0, withoutAlt: 0 }, links: [],
    });
  });

  it('reports broken structured data and an empty title', () => {
    const facts = analyzeHtml('<title></title><script type="application/ld+json">{not json</script><script type="application/ld+json">{"@type":"Product"}</script>', page);
    expect(facts.title).toBe('');
    expect(facts.jsonLd).toEqual({ count: 2, invalid: 1, types: ['Product'] });
  });

  it('notices noindex, several headings and a canonical among other rel values', () => {
    const facts = analyzeHtml('<meta name="robots" content="noindex,nofollow"><link rel="alternate canonical" href=" /x "><h1>a</h1><h1 class=b>b</h1>', page);
    expect(facts.robotsMeta).toBe('noindex,nofollow');
    expect(facts.canonical).toBe('/x');
    expect(facts.h1Count).toBe(2);
  });

  it('copes with empty and non-string input', () => {
    for (const input of ['', null, undefined, 12]) expect(analyzeHtml(input, page).wordCount, String(input)).toBeLessThanOrEqual(1);
  });

  it('stays fast on large malformed pages, because a crawl must never stall the server', () => {
    const shapes = {
      'unclosed tags with quotes': '<a href="/x'.repeat(50_000),
      'unclosed comments': '<!--'.repeat(150_000),
      'unclosed scripts': '<script>'.repeat(70_000),
      'unclosed styles and noscript': '<style>'.repeat(40_000) + '<noscript>'.repeat(40_000),
      'unclosed titles': '<title>'.repeat(70_000),
      'nothing but angle brackets': '<'.repeat(600_000),
      'unfinished meta tags': '<meta name=description content="'.repeat(20_000),
      'a huge ordinary page': '<div><p>word <a href="/p">link</a></p></div>'.repeat(13_000),
      'many script-like words': '<scripted><script2><scriptx>'.repeat(20_000),
    };
    for (const [name, input] of Object.entries(shapes)) {
      const started = performance.now();
      analyzeHtml(input, page);
      // A guard against the quadratic blow-up this once had (minutes), not a benchmark: generous for a busy machine.
      expect(performance.now() - started, name).toBeLessThan(4000);
    }
  });

  it('reads only the first 600 KB of a page', () => {
    expect(analyzeHtml(`<title>kept</title>${' '.repeat(700_000)}<h1>late</h1>`, page)).toMatchObject({ title: 'kept', h1Count: 0 });
  });
});

describe('attributes, entities and addresses', () => {
  it('reads quoted, single quoted, bare and valueless attributes', () => {
    expect(attributes(`<meta NAME="Description" content='a "b" c' data-x=y hidden/>`)).toEqual({ name: 'Description', content: 'a "b" c', 'data-x': 'y', hidden: '' });
  });
  it('decodes the common entities and numeric ones, and leaves nonsense alone', () => {
    expect(decode('Tom &amp; Jerry &lt;3 &#8217;s &#0; &#99999999; &bogus;')).toBe('Tom & Jerry <3 ’s &#0; &#99999999; &bogus;');
  });
  it('resolves relative addresses and refuses anything that is not a web page address', () => {
    expect(resolve('../x?y=1#z', 'https://example.test/a/b/')).toBe('https://example.test/a/x?y=1');
    expect(resolve('javascript:alert(1)', page)).toBeNull();
    expect(resolve('ftp://example.test/', page)).toBeNull();
    expect(resolve('http://[bad', page)).toBeNull();
  });
});

describe('reading robots.txt', () => {
  it('finds the sitemaps and a rule that blocks everything', () => {
    expect(analyzeRobots('User-agent: *\nDisallow: /admin\nSitemap: https://example.test/sitemap.xml\n')).toEqual({ sitemaps: ['https://example.test/sitemap.xml'], blocksAll: false });
    expect(analyzeRobots('User-agent: Googlebot\nDisallow: /\n\nUser-agent: *\nAllow: /\n')).toEqual({ sitemaps: [], blocksAll: false });
    expect(analyzeRobots('# staging\nUser-agent: *\nDisallow: /   # everything\n')).toEqual({ sitemaps: [], blocksAll: true });
  });
  it('says null for an app shell or anything else that is not a robots file', () => {
    expect(analyzeRobots('<!doctype html><html><body>app</body></html>')).toBeNull();
    expect(analyzeRobots('Not found')).toBeNull();
    expect(analyzeRobots('')).toBeNull();
  });
});

describe('reading a sitemap', () => {
  it('lists the addresses', () => {
    expect(analyzeSitemap('<?xml version="1.0"?><urlset><url><loc>https://example.test/</loc></url><url><loc> https://example.test/a?x=1&amp;y=2 </loc></url></urlset>'))
      .toEqual({ index: false, urls: ['https://example.test/', 'https://example.test/a?x=1&y=2'] });
  });
  it('recognizes an index of sitemaps', () => {
    expect(analyzeSitemap('<sitemapindex><sitemap><loc>https://example.test/s1.xml</loc></sitemap></sitemapindex>')).toEqual({ index: true, urls: ['https://example.test/s1.xml'] });
  });
  it('says null for an app shell or anything else', () => {
    expect(analyzeSitemap('<!doctype html><html></html>')).toBeNull();
    expect(analyzeSitemap('')).toBeNull();
  });
});
