/**
 * Who leads a business, read from its own website's pages (about, team, leadership): a person's name next to a title that decides
 * (owner, administrator, executive director, business development …). A name is kept only beside such a title, so a page's other
 * capitalized words ("Patient Care", "Our Mission") are never taken for a person. Pure functions: the contact finder reads the pages.
 *
 * Every scan here is linear in the page: the markup is cut at each tag with indexOf, never with a pattern that can rescan the page.
 */
import { decode } from '../agents/seo/html.mjs';

const ranks = [
  [/\b(owner|founder|co-?founder)\b/i, 0], [/\b(chief executive|ceo|president)\b/i, 1], [/\badministrator\b/i, 2],
  [/\bexecutive director\b/i, 3], [/\b(business development|community liaison|community relations|marketing)\b/i, 4], [/\b(director|chief|vp|vice president)\b/i, 5],
];
/** How much a title decides, lower first; Infinity for a title that does not decide. */
export function titleRank(title) {
  const text = String(title ?? '');
  for (const [pattern, rank] of ranks) if (pattern.test(text)) return rank;
  return Infinity;
}

// Tags that sit inside a line of text; every other tag ends a line.
const inline = new Set(['a', 'abbr', 'b', 'bdi', 'cite', 'em', 'font', 'i', 'mark', 'q', 's', 'small', 'span', 'strong', 'sub', 'sup', 'u', 'wbr']);
const dropped = ['script', 'style', 'noscript', 'svg', 'template', 'head', 'select'];
const maxInput = 300_000;
const maxLines = 6000;

/** A page's visible text as lines: one per block of the markup, entities decoded, spaces collapsed, empty lines dropped. */
export function pageLines(html) {
  const source = String(html ?? '').slice(0, maxInput);
  const lower = source.toLowerCase();
  let out = '';
  let from = 0;
  for (;;) {
    const open = source.indexOf('<', from);
    if (open === -1) { out += source.slice(from); break; }
    out += source.slice(from, open);
    if (lower.startsWith('<!--', open)) {
      const end = lower.indexOf('-->', open + 4);
      if (end === -1) break;
      from = end + 3;
      out += '\n';
      continue;
    }
    const close = source.indexOf('>', open + 1);
    if (close === -1) break;
    const name = /^<\/?([a-z][a-z0-9-]*)/.exec(lower.slice(open, Math.min(close + 1, open + 40)))?.[1] ?? '';
    from = close + 1;
    if (dropped.includes(name) && lower[open + 1] !== '/') {
      // The element's content is never text a visitor reads: skip to its end tag.
      const end = lower.indexOf(`</${name}`, from);
      if (end === -1) break;
      from = lower.indexOf('>', end) + 1 || source.length;
      out += '\n';
      continue;
    }
    out += inline.has(name) ? ' ' : '\n';
  }
  const lines = [];
  for (const raw of decode(out).split('\n')) {
    const line = raw.replace(/[\s ]+/g, ' ').trim();
    if (line) lines.push(line);
    if (lines.length >= maxLines) break;
  }
  return lines;
}

// Words that start with a capital on a business's page but are never part of a person's name.
const notName = new Set(['about', 'our', 'the', 'team', 'meet', 'staff', 'leadership', 'contact', 'us', 'home', 'health', 'healthcare', 'hospice', 'care',
  'services', 'service', 'agency', 'nursing', 'nurse', 'nurses', 'patient', 'patients', 'family', 'families', 'mission', 'vision', 'values', 'history',
  'director', 'directors', 'administrator', 'manager', 'management', 'owner', 'founder', 'president', 'chief', 'officer', 'executive', 'board', 'clinical',
  'medical', 'office', 'business', 'development', 'marketing', 'community', 'liaison', 'relations', 'operations', 'quality', 'compliance', 'intake',
  'admissions', 'billing', 'human', 'resources', 'careers', 'read', 'more', 'learn', 'view', 'bio', 'profile', 'email', 'phone', 'call', 'fax', 'click',
  'here', 'welcome', 'and', 'of', 'for', 'to', 'in', 'at', 'with', 'by', 'on', 'we', 'you', 'your', 'who', 'what', 'why', 'how', 'is', 'are', 'a', 'an',
  'inc', 'llc', 'corp', 'company', 'group', 'center', 'county', 'street', 'suite', 'road', 'avenue', 'monday', 'friday', 'privacy', 'policy', 'terms',
  'copyright', 'rights', 'reserved', 'skilled', 'therapy', 'physical', 'occupational', 'speech', 'palliative', 'private', 'duty', 'companion',
  'senior', 'living', 'assisted', 'memory', 'support', 'program', 'programs', 'volunteer', 'volunteers', 'news', 'events', 'blog', 'resources',
  'regional', 'vice', 'assistant', 'associate', 'coordinator', 'specialist', 'supervisor', 'social', 'work', 'worker', 'spiritual', 'chaplain', 'bereavement',
  'pennsylvania', 'ohio', 'new', 'york', 'jersey', 'texas', 'florida', 'california', 'north', 'south', 'east', 'west', 'united', 'states', 'america']);
const nameToken = /^(?:\p{Lu}[\p{L}'’-]{1,30}\.?|\p{Lu}\.)$/u;
const separators = /\s+[-–—|:]\s+|\s*[|]\s*|\s*:\s+|,\s+/;
const plain = value => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z]/g, '');

const suffixWords = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v', 'esq']);
// Letters after a name: degrees, licences and certifications a home health or hospice leader writes after it.
const credentialWords = new Set(['rn', 'bsn', 'msn', 'lpn', 'lvn', 'cna', 'np', 'aprn', 'fnp', 'dnp', 'phd', 'md', 'do', 'pa', 'pt', 'dpt', 'ot', 'otr',
  'slp', 'ccc', 'lcsw', 'lsw', 'msw', 'mba', 'mha', 'mph', 'mpa', 'ms', 'ma', 'ba', 'bs', 'bsw', 'cpa', 'jd', 'fache', 'chc', 'chpn', 'cphq', 'crnp',
  'cos', 'hcs', 'cpc', 'ccm', 'cdp', 'cmc', 'rd', 'ld', 'pharmd', 'rph', 'nha', 'lnha', 'cno', 'ceo', 'coo', 'cfo', 'cmo', 'acm', 'cwocn', 'wcc']);
/** Whether a word written after a name is a credential or a suffix (RN, MBA, Jr.), not part of the name. */
export const isCredential = token => { const word = plain(String(token ?? '')); return word !== '' && (credentialWords.has(word) || suffixWords.has(word)); };

/** The person's name a short piece of text is, credentials after it dropped, or null. */
export function personName(text) {
  let value = String(text ?? '').replace(/^(?:dr|mr|mrs|ms)\.?\s+/i, '').trim();
  // Credentials after the name, with or without commas: "Jane Doe, RN, COS-C", "Jane Doe RN".
  for (;;) {
    const tail = /(?:,\s*|\s+)([A-Za-z.]{1,9}(?:-[A-Za-z])?)\s*$/.exec(value);
    if (!tail || !tail[1].split('-').every(part => isCredential(part) || part.length === 1) || !isCredential(tail[1].split('-')[0])) break;
    value = value.slice(0, tail.index).trim();
  }
  if (value.length < 4 || value.length > 60) return null;
  const tokens = value.split(' ');
  if (tokens.length < 2 || tokens.length > 4 || !tokens.every(token => nameToken.test(token))) return null;
  const words = tokens.map(plain);
  if (words.some(word => notName.has(word)) || words[0].length < 2 || words.at(-1).length < 2) return null;
  // ALL CAPS NAMES are written in capitals by the page's style: read them as names.
  return tokens.map(token => (token === token.toUpperCase() && token.length > 2 ? token[0] + token.slice(1).toLowerCase() : token)).join(' ');
}

/** The title a short piece of text is, when it decides, or null. */
export function decidingTitle(text) {
  const value = String(text ?? '').replace(/^[\s,–—|:(-]+|[\s,–—|:)-]+$/g, '').replace(/^(?:is our|is the|serves as|our|the|is)\s+/i, '').trim();
  if (value.length < 3 || value.length > 80 || value.split(' ').length > 9 || /[.!?]\s|@|https?:/.test(value)) return null;
  // A line that names someone ("Chris Park (Community Liaison)") is that person's line, never another person's title.
  const words = value.split(' ');
  if (words.some((_, i) => i + 1 < words.length && personName(`${words[i]} ${words[i + 1]}`))) return null;
  return Number.isFinite(titleRank(value)) ? value : null;
}

/**
 * The people a page names with a title that decides: [{ name, title }], at most ten, the same name once. A name and its title on one
 * line ("Jane Doe, RN – Administrator", "Administrator: Jane Doe", "Jane Doe (Owner)"), or a name on its own line with its title on
 * the side the page puts titles: below the names, or above them when more of the page's names have a title above than below (cards
 * that read "Administrator / Jane Doe / Owner / John Smith"). A title on the other side is used only when no other name claims it.
 */
export function teamPeople(html) {
  const lines = pageLines(html);
  const found = new Map();
  const names = lines.map(line => (line.length <= 140 ? personName(line) : null));
  const titleAt = index => (index >= 0 && index < lines.length && !names[index] ? decidingTitle(lines[index]) : null);
  let aboveCount = 0, belowCount = 0;
  names.forEach((name, i) => { if (name) { if (titleAt(i - 1)) aboveCount += 1; if (titleAt(i + 1)) belowCount += 1; } });
  const titlesAbove = aboveCount > belowCount;
  const add = (name, title) => { if (name && title && !found.has(name.toLowerCase()) && found.size < 10) found.set(name.toLowerCase(), { name, title }); };
  for (let i = 0; i < lines.length && found.size < 10; i += 1) {
    const line = lines[i];
    if (line.length > 140) continue;
    const bracket = /^(.+?)\s*\(([^()]{3,80})\)$/.exec(line);
    if (bracket && personName(bracket[1]) && decidingTitle(bracket[2])) { add(personName(bracket[1]), decidingTitle(bracket[2])); continue; }
    const name = names[i];
    if (name) {
      // The title on the page's side; failing that, the other side's, unless the next name over claims it.
      const below = titleAt(i + 1), above = titleAt(i - 1);
      const title = titlesAbove ? above ?? (names[i + 2] ? null : below) : below ?? (names[i - 2] ? null : above);
      add(name, title);
      continue;
    }
    // One line: cut it where a name ends and a title begins. A name first takes the longest cut that is still a name, so the
    // credentials after it stay with the name ("Jane Doe, RN, Administrator"); a title first takes the shortest.
    const parts = line.split(separators);
    if (parts.length < 2 || parts.length > 6) continue;
    const cut = (left, right) => [parts.slice(0, left).join(', '), parts.slice(left).join(', ')];
    let pair = null;
    for (let at = parts.length - 1; at >= 1 && !pair; at -= 1) {
      const [left, right] = cut(at);
      if (personName(left) && decidingTitle(right)) pair = [personName(left), decidingTitle(right)];
    }
    for (let at = 1; at < parts.length && !pair; at += 1) {
      const [left, right] = cut(at);
      if (decidingTitle(left) && personName(right)) pair = [personName(right), decidingTitle(left)];
    }
    if (pair) add(...pair);
  }
  return [...found.values()];
}

// Where a business's site names its people, by the words of a link's address.
const teamWords = /(?:^|[/_-])(team|our-team|leadership|leaders|staff|our-staff|about|about-us|who-we-are|management|our-people|meet|administration|owners?)(?:[/_.-]|$)/i;

/** The links on `pages` that lead to a page naming the business's people, on its own hosts, best first, at most `limit`. */
export function teamLinks(links, hosts, limit = 4) {
  const scored = [];
  for (const link of links ?? []) {
    let url;
    try { url = new URL(link); } catch { continue; }
    if (url.protocol !== 'https:' || !hosts.includes(url.hostname) || url.username || url.password || url.port) continue;
    const match = teamWords.exec(url.pathname);
    if (!match) continue;
    const word = match[1].toLowerCase();
    const score = /team|leader|staff|management|people|meet|administration|owner/.test(word) ? 0 : 1;
    scored.push({ path: `${url.pathname}${url.search}`, score });
  }
  return [...new Map(scored.sort((a, b) => a.score - b.score).map(item => [item.path, item])).values()].slice(0, limit).map(item => item.path);
}
