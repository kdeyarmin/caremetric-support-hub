/**
 * A small, tolerant reader for the parts of an HTML page that search engines and AI assistants look at.
 * It does not run scripts, which is the point: it sees a page the way a crawler that does not run
 * JavaScript sees it. Input is capped by the caller; every pattern here is linear in the input.
 */
const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
// One pass over the original text, so a reference that decodes to the start of another (&amp;#65;) is not decoded twice, and decimal
// (&#38;) and hexadecimal (&#x26;) references read alike. Anything that is not a known, valid character is left as it was written.
export const decode = text => String(text ?? '').replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-z]{2,6}));/g, (match, decimal, hex, name) => {
  if (name) return Object.hasOwn(named, name) ? named[name] : match;
  const value = decimal === undefined ? Number.parseInt(hex, 16) : Number(decimal);
  return value > 0 && value < 0x110000 && !(value >= 0xd800 && value <= 0xdfff) ? String.fromCodePoint(value) : match;
});
const squash = text => decode(text).replace(/\s+/g, ' ').trim();

/** The attributes of one start tag, names lower-cased. */
export function attributes(tag) {
  const out = {};
  const inner = String(tag).replace(/^<[a-zA-Z][^\s/>]*/, '').replace(/\/?>$/, '');
  for (const match of inner.matchAll(/([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
    out[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? '';
  }
  return out;
}

const skippable = /^(?:#|mailto:|tel:|javascript:|data:|sms:)/i;
const asset = /\.(?:pdf|png|jpe?g|gif|svg|webp|avif|ico|css|js|mjs|json|xml|txt|zip|docx?|xlsx?|pptx?|mp4|mp3|woff2?|ttf)(?:[?#]|$)/i;

/** Absolute, hash-free http(s) URL, or null. */
export function resolve(href, base) {
  try {
    const url = new URL(href, base);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    url.hash = '';
    return url.toString();
  } catch { return null; }
}

// Everything below is a single forward scan with indexOf, never a pattern that can rescan to the end of the
// input for each unfinished tag: a page of ten thousand unclosed tags must cost the same as any other page.
const maxInput = 600_000;
const maxTag = 2048;
const maxTags = 20_000;
const letter = code => (code >= 65 && code <= 90) || (code >= 97 && code <= 122);

/** Each start tag of the markup, as written. A tag with no end inside a sane length is treated as text. */
function startTags(html) {
  const tags = [];
  let index = html.indexOf('<');
  while (index !== -1 && tags.length < maxTags) {
    let end = -1;
    if (letter(html.charCodeAt(index + 1))) {
      let quote = 0;
      for (let i = index + 1, stop = Math.min(html.length, index + maxTag); i < stop; i += 1) {
        const code = html.charCodeAt(i);
        if (quote) { if (code === quote) quote = 0; } else if (code === 34 || code === 39) quote = code; else if (code === 62) { end = i; break; }
      }
    }
    if (end === -1) { index = html.indexOf('<', index + 1); continue; }
    tags.push(html.slice(index, end + 1));
    index = html.indexOf('<', end + 1);
  }
  return tags;
}

const nameOf = tag => /^<([a-zA-Z][^\s/>]*)/.exec(tag)?.[1].toLowerCase() ?? '';

/** Elements of one kind with their content: [{ open, body }]. An unterminated element ends the scan. */
function elements(html, lower, name) {
  const found = [];
  const open = `<${name}`;
  const close = `</${name}`;
  let from = 0;
  while (found.length < 2000) {
    const start = lower.indexOf(open, from);
    if (start === -1) break;
    const next = lower.charCodeAt(start + open.length);
    if (!(next === 32 || next === 62 || next === 47 || next === 9 || next === 10 || next === 13)) { from = start + open.length; continue; }
    const tagEnd = lower.indexOf('>', start);
    if (tagEnd === -1) break;
    const closeStart = lower.indexOf(close, tagEnd);
    if (closeStart === -1) break;
    found.push({ open: html.slice(start, tagEnd + 1), body: html.slice(tagEnd + 1, closeStart), start, end: lower.indexOf('>', closeStart) + 1 || lower.length });
    from = found.at(-1).end;
  }
  return found;
}

/** The markup with the given elements (and comments) removed, in one pass per kind. */
function without(html, kinds) {
  let out = html;
  for (const [open, close] of kinds) {
    const lower = out.toLowerCase();
    let result = '';
    let from = 0;
    for (;;) {
      const start = lower.indexOf(open, from);
      if (start === -1) { result += out.slice(from); break; }
      if (open !== '<!--') {
        const next = lower.charCodeAt(start + open.length);
        if (!(next === 32 || next === 62 || next === 47 || next === 9 || next === 10 || next === 13)) { result += out.slice(from, start + open.length); from = start + open.length; continue; }
      }
      const end = lower.indexOf(close, start + open.length);
      if (end === -1) { result += out.slice(from, start); break; }
      const tail = open === '<!--' ? end + close.length : (lower.indexOf('>', end) + 1 || lower.length);
      result += `${out.slice(from, start)} `;
      from = tail;
    }
    out = result;
  }
  return out;
}

/** Text with every tag removed. A tag that never ends swallows the rest, which keeps the scan linear. */
function stripTags(html) {
  let out = '';
  let from = 0;
  for (;;) {
    const open = html.indexOf('<', from);
    if (open === -1) { out += html.slice(from); break; }
    out += `${html.slice(from, open)} `;
    const close = html.indexOf('>', open + 1);
    if (close === -1) break;
    from = close + 1;
  }
  return out;
}

/**
 * Everything the checks need from one page. `links` are page addresses (no assets), unique, in document
 * order and resolved against the page; the caller decides which belong to the site. `wordCount` counts the
 * words in the initial HTML only.
 */
export function analyzeHtml(html, pageUrl) {
  const source = String(html ?? '').slice(0, maxInput);

  const jsonLd = { count: 0, invalid: 0, types: [] };
  for (const script of elements(source, source.toLowerCase(), 'script')) {
    if (!/application\/ld\+json/i.test(script.open)) continue;
    jsonLd.count += 1;
    try {
      const data = JSON.parse(script.body);
      for (const node of Array.isArray(data) ? data : (data?.['@graph'] ?? [data])) {
        const type = node?.['@type'];
        for (const name of Array.isArray(type) ? type : [type]) if (typeof name === 'string' && jsonLd.types.length < 8) jsonLd.types.push(name);
      }
    } catch { jsonLd.invalid += 1; }
  }

  const visible = without(source, [['<!--', '-->'], ['<script', '</script'], ['<style', '</style'], ['<noscript', '</noscript']]);
  const lowerVisible = visible.toLowerCase();
  const tags = startTags(visible).map(tag => ({ name: nameOf(tag), attrs: attributes(tag) }));
  const ofKind = name => tags.filter(tag => tag.name === name).map(tag => tag.attrs);

  const metas = ofKind('meta');
  const named = name => metas.find(attrs => attrs.name?.toLowerCase() === name)?.content;
  const property = name => metas.find(attrs => attrs.property?.toLowerCase() === name)?.content;
  const title = elements(visible, lowerVisible, 'title')[0]?.body;
  const canonicalTag = ofKind('link').find(attrs => /(?:^|\s)canonical(?:\s|$)/i.test(attrs.rel ?? ''));

  const bodyStart = lowerVisible.indexOf('<body');
  const text = squash(stripTags(bodyStart === -1 ? visible : visible.slice(bodyStart)));
  const words = text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? [];

  const images = ofKind('img');
  const links = [];
  const seen = new Set();
  for (const attrs of ofKind('a')) {
    // An attribute holds HTML text: href="/a?b=1&amp;c=2" is the address /a?b=1&c=2, which is what a browser requests.
    const href = decode(attrs.href ?? '').trim();
    if (!href || skippable.test(href) || asset.test(href)) continue;
    const absolute = resolve(href, pageUrl);
    if (absolute && !seen.has(absolute)) { seen.add(absolute); links.push(absolute); }
  }

  return {
    title: title === undefined ? null : squash(title),
    description: named('description') === undefined ? null : squash(named('description')),
    canonical: decode(canonicalTag?.href ?? '').trim() || null,
    robotsMeta: (named('robots') ?? '').toLowerCase(),
    openGraph: { title: Boolean(property('og:title')), description: Boolean(property('og:description')), image: Boolean(property('og:image')), url: Boolean(property('og:url')) },
    twitterCard: Boolean(named('twitter:card') ?? property('twitter:card')),
    viewport: Boolean(named('viewport')),
    lang: tags.some(tag => tag.name === 'html' && /^[a-zA-Z]/.test(tag.attrs.lang ?? '')),
    h1Count: tags.filter(tag => tag.name === 'h1').length,
    jsonLd,
    images: { total: images.length, withoutAlt: images.filter(attrs => attrs.alt === undefined).length },
    wordCount: words.length,
    links,
  };
}

const robotsFields = new Set(['user-agent', 'sitemap', 'disallow', 'allow', 'crawl-delay']);

/**
 * One robots.txt line as [field, value]: the field in lower case, the value without a trailing comment, or null when the
 * line has no field. It cuts at the first # and the first colon with indexOf and never uses a pattern that can rescan the
 * line (or the lines after it), so a response of blank lines, spaces or colons costs the same as an ordinary file.
 */
function robotsLine(line) {
  const hash = line.indexOf('#');
  const text = hash === -1 ? line : line.slice(0, hash);
  const colon = text.indexOf(':');
  if (colon === -1) return null;
  // Whatever precedes the colon is trimmed before it is judged, so indentation or spaces before it do not hide a directive. Each line is
  // sliced, trimmed and tested once, which is linear however long the line is.
  const name = text.slice(0, colon).trim().toLowerCase();
  return /^[a-z-]+$/.test(name) ? [name, text.slice(colon + 1).trim()] : null;
}

/**
 * The Sitemap lines and the "block everything" rule of a robots.txt, or null when the text is not a robots file.
 * User-agent lines that follow one another form one group (RFC 9309), so a rule applies to everyone when any of them is *.
 */
export function analyzeRobots(text) {
  const body = String(text ?? '');
  const start = body.trimStart().slice(0, 16).toLowerCase();
  if (start.startsWith('<!doctype') || start.startsWith('<html')) return null;
  const sitemaps = [];
  let found = false;
  let blocksAll = false;
  let applies = false;
  let ruled = false; // a rule has been read since the last User-agent line, so the next User-agent starts a new group
  for (const line of body.split(/\r?\n/)) {
    const parsed = robotsLine(line);
    if (!parsed || !robotsFields.has(parsed[0])) continue;
    found = true;
    const [name, value] = parsed;
    if (name === 'sitemap') {
      const address = value.split(/\s/, 1)[0];
      if (address) sitemaps.push(address);
    } else if (name === 'user-agent') {
      if (ruled) { applies = false; ruled = false; }
      if (value === '*') applies = true;
    } else {
      ruled = true;
      if (applies && name === 'disallow' && value === '/') blocksAll = true;
    }
  }
  return found ? { sitemaps, blocksAll } : null;
}

/** The addresses in a sitemap, and whether it is an index of other sitemaps. null when the text is not a sitemap. */
export function analyzeSitemap(text) {
  const body = String(text ?? '');
  if (!/<(?:urlset|sitemapindex)\b/i.test(body)) return null;
  const urls = [...body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map(match => decode(match[1]));
  return { index: /<sitemapindex\b/i.test(body), urls };
}
