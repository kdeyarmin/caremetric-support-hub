/**
 * The contact finder: for a business the Marketing Manager found online, it reads that business's own website and keeps one public
 * role address on that business's domain (info@, contact@ and the like), which the database records as the business's one cold email
 * contact (private.growth_record_contact). The owner chose capped cold email to businesses' public addresses only (2026-11-04), so:
 *
 * - Only https pages on the business's own domain or its www. name are read, never a directory, search result or third-party page.
 * - robots.txt is honoured (for this finder's name and for every robot); a site that forbids it is left alone.
 * - At most six pages (the home page, contact, contact-us, about, about-us and contactus), 300 KB each, 10 seconds each; redirects only
 *   within the domain. Reading stops at the first page that shows a role address.
 * - A name that resolves to a private, loopback or link-local address, or an address literal, is never fetched. The connection itself
 *   resolves the name through the same check (pinnedFetch), so a name whose answer changes after the check cannot steer it elsewhere.
 * - A redirect is checked against the robots.txt of the host it leads to before it is followed.
 * - Only role local parts on the business's exact domain are kept as its contact; a personal address (jane.doe@, a name) is never
 *   the business's contact, nor one on another domain, nor a phone number of any kind. An address is read whole: `jane!info@` is not
 *   taken for `info@`.
 *
 * Nothing it reads is stored except the one address, the page it was found on and a short summary of the home page (`siteSummary`:
 * its title, its description and the start of its text), which the Marketing Manager keeps as dated evidence of what the business says
 * it is, exactly as it keeps a search result's snippet. A summary that seems to hold a personal identifier is dropped. Page text is
 * never logged.
 *
 * `listing` reads the same pages for what a business publishes about reaching it, so the Marketing Manager can find a web-found
 * agency's Medicare record (agency-match.mjs): the telephone numbers (never a fax), the postal addresses and the home page's title.
 * The numbers are handed to the caller only, which sends them in one request to Intel's feed and keeps none of them.
 *
 * `team` reads the same way, for the people step (server/growth/people.mjs; owner decision 2026-11-13, named people): the people the
 * business's own pages name with a title that decides, and the personal addresses those pages publish on its exact domain. At most
 * six pages: the home page, the pages it links to that name people (team, leadership, about), then the usual ones. A published
 * address is kept only when it is one of the usual shapes of a named person's name, and then waits for the owner's review.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';
import { analyzeHtml } from '../agents/seo/html.mjs';
import { screenIdentifiers } from '../agents/concierge/screen.mjs';
import { phonesIn } from './roster.mjs';
import { matchPhoneLimit, pageText, placesIn, publishedPhones } from './agency-match.mjs';
import { teamLinks, teamPeople } from './team.mjs';

/** The role local parts the database admits for a found contact (growth_contacts_role_address_check), in order of preference. */
export const roleLocalParts = Object.freeze(['info', 'contact', 'contactus', 'office', 'hello', 'inquiries', 'inquiry', 'enquiries', 'enquiry',
  'admissions', 'sales', 'reception', 'frontdesk', 'general', 'admin', 'administrator', 'mail', 'team']);
export const contactPaths = Object.freeze(['/', '/contact', '/contact-us', '/about', '/about-us', '/contactus']);
/** Where a business's site usually names its people, read after the pages its home page links to. */
export const teamPaths = Object.freeze(['/about', '/about-us', '/our-team', '/team', '/leadership', '/contact', '/contact-us']);
export const teamPageLimit = 6;
/** The longest home page summary kept as evidence, and how much of the page's opening text it may quote. */
export const siteSummaryLimit = 1200;
const siteTextLimit = 700;
const clip = (value, limit) => { const text = String(value ?? '').replace(/\s+/g, ' ').trim(); return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text; };

/**
 * What a business's own home page says it is, as one line of evidence: its title, its description and the start of its visible
 * text. Null when the page says too little to judge by (an empty page or an app shell), or when the text seems to hold a personal
 * identifier, so one page can never keep an organization from being assessed.
 */
export function siteSummary(html, url) {
  let page;
  try { page = analyzeHtml(html, url); } catch { return null; }
  const parts = [
    page.title ? `Title: ${clip(page.title, 200)}` : null,
    page.description ? `Description: ${clip(page.description, 300)}` : null,
    page.wordCount >= 20 ? `Opening text: ${clip(page.text, siteTextLimit)}` : null,
  ].filter(Boolean);
  if (!parts.length || (!page.description && page.wordCount < 20)) return null;
  const claim = clip(`The organization's own home page. ${parts.join(' ')}`, siteSummaryLimit);
  return screenIdentifiers(claim).flagged ? null : { url, claim };
}
export const finderAgent = 'CareMetricContactFinder';
const pageBytes = 300_000;
const robotsBytes = 100_000;
const timeoutMs = 10_000;
const domainPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,}$/;

/** Every address on exactly `domain` in a page's text, mailto links included, in the order the page shows them. */
export function domainAddresses(text, domain) {
  const decoded = String(text ?? '')
    .replace(/&#(?:64|x40);/gi, '@').replace(/&commat;/gi, '@').replace(/&#(?:46|x2e);/gi, '.').replace(/%40/g, '@');
  const found = new Set();
  // An address starts where no character of an address's local part could come before it (RFC 5322 atext and the dot), so a longer
  // address such as jane!info@ or john/sales@ is never read as the role address at its end; and it ends where its domain ends.
  for (const match of decoded.matchAll(/(?<![a-z0-9!#$%&'*+\/=?^_`{|}~.-])[a-z0-9._%+-]{1,64}@[a-z0-9.-]{1,253}\.[a-z]{2,24}(?![a-z0-9-])/gi)) {
    const [local, host] = match[0].toLowerCase().split('@');
    if (host === domain) found.add(`${local}@${host}`);
  }
  return [...found];
}

/** Every role address on exactly `domain` in a page's text, mailto links included, best first. */
export function roleAddresses(text, domain) {
  return domainAddresses(text, domain).filter(address => roleLocalParts.includes(address.split('@')[0]))
    .sort((a, b) => roleLocalParts.indexOf(a.split('@')[0]) - roleLocalParts.indexOf(b.split('@')[0]));
}

/** The addresses on exactly `domain` that are a person's rather than a role's (jdoe@, jane.doe@), in the order the page shows them. */
export function personalAddresses(text, domain) {
  return domainAddresses(text, domain).filter(address => !roleLocalParts.includes(address.split('@')[0]) && /^[a-z][a-z._-]{1,63}$/.test(address.split('@')[0]));
}

/**
 * Whether one robots.txt pattern matches `path`, as RFC 9309 reads it: `*` matches any run of characters, a final `$` anchors the end,
 * and anything else is a prefix.
 */
export function robotsPatternMatches(pattern, path) {
  // The site writes the pattern and, through a redirect, can choose the path too. Read as a regular expression (one `.*` per `*`), a
  // rule with a run of wildcards backtracked for minutes to hours on a path it does not match, holding the Hub's only thread. Matching
  // the literal pieces left to right, each at its first place after the one before, gives the same answer in one pass: an earlier
  // place for a piece never leaves less room for the pieces after it.
  const anchored = pattern.endsWith('$');
  const parts = (anchored ? pattern.slice(0, -1) : pattern).split('*');
  if (!path.startsWith(parts[0])) return false;
  let at = parts[0].length;
  for (let index = 1; index < parts.length; index += 1) {
    // Anchored, the last piece must end the path, and may start anywhere after the pieces before it.
    if (anchored && index === parts.length - 1) return path.length - at >= parts[index].length && path.endsWith(parts[index]);
    const found = path.indexOf(parts[index], at);
    if (found < 0) return false;
    at = found + parts[index].length;
  }
  return !anchored || at === path.length;
}

/**
 * Whether robots.txt lets this finder read `path`: of the group for this finder (else the `*` group), the matching rule with the longest
 * pattern wins, and Allow wins a tie (RFC 9309, section 2.2.2). Wildcards and the end anchor are honoured, so `Allow: /*.pdf$` never
 * opens `/contact` under `Disallow: /`.
 */
export function robotsAllows(robots, path) {
  if (typeof robots !== 'string' || robots.trim() === '') return true;
  const groups = [];
  let current = null;
  let lastWasAgent = false;
  for (const raw of robots.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (field === 'user-agent') {
      if (!lastWasAgent) { current = { agents: [], rules: [] }; groups.push(current); }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if ((field === 'allow' || field === 'disallow') && current) {
      lastWasAgent = false;
      if (value !== '') current.rules.push({ allow: field === 'allow', pattern: value });
    } else {
      lastWasAgent = false;
    }
  }
  const mine = groups.filter(group => group.agents.some(agent => agent !== '*' && finderAgent.toLowerCase().includes(agent)));
  const applicable = mine.length > 0 ? mine : groups.filter(group => group.agents.includes('*'));
  let best = null;
  for (const rule of applicable.flatMap(group => group.rules)) {
    if (!robotsPatternMatches(rule.pattern, path)) continue;
    if (!best || rule.pattern.length > best.pattern.length || (rule.pattern.length === best.pattern.length && rule.allow)) best = rule;
  }
  return best ? best.allow : true;
}

/** An address the finder must never connect to. */
export function privateAddress(address) {
  const value = String(address ?? '').toLowerCase();
  if (isIP(value) === 4) {
    const [a, b] = value.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  if (isIP(value) === 6) {
    if (value === '::' || value === '::1') return true;
    const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return privateAddress(mapped[1]);
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(value);
  }
  return true;
}

/**
 * A GET that connects only to addresses it has just checked: the name is resolved inside the connection, through `lookup`, and any
 * answer that includes a private, loopback or link-local address refuses the connection. TLS still verifies the certificate for the
 * name. Redirects are not followed (the finder checks each one itself).
 */
export function pinnedFetch(lookup = dnsLookup, request = httpsRequest) {
  const checkedLookup = (hostname, options, callback) => {
    Promise.resolve(lookup(hostname, { all: true })).then(addresses => {
      if (!Array.isArray(addresses) || addresses.length === 0 || addresses.some(entry => privateAddress(entry?.address))) {
        callback(Object.assign(new Error('The name resolves to an address the finder never connects to.'), { code: 'EPRIVATEADDRESS' }));
      } else if (options?.all) {
        callback(null, addresses.map(entry => ({ address: entry.address, family: entry.family })));
      } else {
        callback(null, addresses[0].address, addresses[0].family);
      }
    }, callback);
  };
  return (url, { headers = {}, signal } = {}) => new Promise((resolve, reject) => {
    const target = new URL(url);
    const outgoing = request({
      protocol: 'https:', hostname: target.hostname, servername: target.hostname, port: 443, path: `${target.pathname}${target.search}`,
      method: 'GET', headers, signal, lookup: checkedLookup, agent: false,
    }, incoming => {
      // Node accepts any three-digit status (LinkedIn answers 999), but a Response holds only 200 to 599, and a throw in this callback
      // is uncaught and stops the whole process. Such an answer, like anything this callback cannot turn into a Response, is no page.
      const refuse = error => { incoming.resume(); reject(error); };
      if (!(incoming.statusCode >= 200 && incoming.statusCode <= 599)) {
        return refuse(Object.assign(new Error('The site answered with a status the finder does not read.'), { code: 'EBADSTATUS' }));
      }
      try {
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (value !== undefined) for (const one of [].concat(value)) responseHeaders.append(name, String(one));
        }
        const empty = [204, 205, 304].includes(incoming.statusCode);
        if (empty) incoming.resume();
        resolve(new Response(empty ? null : Readable.toWeb(incoming), { status: incoming.statusCode, headers: responseHeaders }));
      } catch (error) { refuse(error); }
    });
    outgoing.on('error', reject);
    outgoing.end();
  });
}

async function readLimited(response, limit) {
  const reader = response.body?.getReader?.();
  if (!reader) return '';
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) { chunks.push(Buffer.from(value).subarray(0, Math.max(0, value.byteLength - (bytes - limit)))); break; }
      chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks).toString('utf8');
}

const disallowAll = 'User-agent: *\nDisallow: /';

export function growthContactFinder({ fetchImpl = null, lookup = dnsLookup } = {}) {
  const fetchPage = fetchImpl ?? pinnedFetch(lookup);
  async function safeHost(host) {
    if (isIP(host)) return false;
    try {
      const addresses = await lookup(host, { all: true });
      return Array.isArray(addresses) && addresses.length > 0 && addresses.every(entry => !privateAddress(entry.address));
    } catch { return false; }
  }

  // One GET on the business's own hosts, following at most two redirects that stay on them and that `allowed` (robots.txt) permits.
  // Says how it ended: 'ok' with { url, text }; 'missing' for a 4xx answer; 'unreachable' for a 5xx answer; 'refused' when the
  // address, a redirect or the content type is not one this finder reads. A network error or timeout throws.
  async function fetchOnHosts(url, hosts, limit, signal, accept, allowed, anyType) {
    let target = new URL(url);
    for (let hop = 0; hop < 3; hop += 1) {
      // A redirect to another https host is refused, and that host is said (`movedTo`, its name only) so a caller may read it as a site
      // of its own: never followed here.
      if (hop > 0 && target.protocol === 'https:' && !target.username && !target.password && !target.port && !hosts.includes(target.hostname)) {
        return { outcome: 'refused', movedTo: target.hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '') };
      }
      if (target.protocol !== 'https:' || target.username || target.password || target.port || !hosts.includes(target.hostname)) return { outcome: 'refused' };
      if (!(await safeHost(target.hostname))) return { outcome: 'refused' };
      if (hop > 0 && allowed && !(await allowed(target))) return { outcome: 'refused' };
      const response = await fetchPage(target.href, {
        redirect: 'manual', headers: { 'User-Agent': `${finderAgent}/1.0 (+https://help.caremetric.ai)`, Accept: accept },
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
      });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel?.().catch(() => {});
        const location = response.headers.get('location');
        if (!location) return { outcome: 'refused' };
        target = new URL(location, target);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel?.().catch(() => {});
        return { outcome: response.status >= 400 && response.status < 500 ? 'missing' : 'unreachable' };
      }
      const type = String(response.headers.get('content-type') ?? '').toLowerCase();
      if (!anyType && !type.startsWith('text/html') && !type.startsWith('text/plain')) { await response.body?.cancel?.().catch(() => {}); return { outcome: 'refused' }; }
      return { outcome: 'ok', url: target.href, text: await readLimited(response, limit) };
    }
    return { outcome: 'refused' };
  }

  // One business's site: its hosts, its robots.txt (read once per host) and a page reader that honours it.
  function siteOf(host, signal) {
    const hosts = [host, `www.${host}`];
    // Each host's robots.txt, read once: the business's domain first, its www. name only if a redirect leads there. As RFC 9309
    // sets out, a robots.txt that answers 4xx means no rules, and one that cannot be read (a 5xx answer, a network error or
    // timeout, or a redirect this finder does not follow) means the whole site is off limits. Its content type does not matter.
    const robotsByHost = new Map();
    const robotsFor = async name => {
      if (!robotsByHost.has(name)) {
        let text = disallowAll;
        try {
          const result = await fetchOnHosts(`https://${name}/robots.txt`, hosts, robotsBytes, signal, 'text/plain', null, true);
          if (result.outcome === 'ok') text = result.text;
          else if (result.outcome === 'missing') text = '';
        } catch (error) {
          if (signal?.aborted) throw error;
        }
        robotsByHost.set(name, text);
      }
      return robotsByHost.get(name);
    };
    const allowed = async target => robotsAllows(await robotsFor(target.hostname), `${target.pathname}${target.search}`);
    let moved = null;
    return {
      hosts,
      /** Whether robots.txt lets the finder read `path` on the business's domain. */
      may: async path => robotsAllows(await robotsFor(host), path),
      /** The page at `path` on the business's domain ({ url, text }), or null; a network error other than the caller's abort is null too. */
      async read(path) {
        try {
          const result = await fetchOnHosts(`https://${host}${path}`, hosts, pageBytes, signal, 'text/html', allowed, false);
          if (path === '/' && result.movedTo && !moved) moved = result.movedTo;
          return result.outcome === 'ok' ? { url: result.url, text: result.text } : null;
        } catch (error) { if (signal?.aborted) throw error; return null; }
      },
      /** The other host the home page redirected to, if it did (its name only; never read here). */
      movedTo: () => moved,
    };
  }

  /**
   * The one role address to record for `domain`, with the page it was on, or why there is none. With `phone` (an agency's ten-digit
   * CMS telephone number), also whether that number is written on one of the pages read (`phoneSeen`): reading continues past the
   * address until it is, or the pages run out. Only the yes or no is returned; no number read from a page is kept.
   *
   * For the website search (site-search.mjs, the Nov 24 measurement): `morePaths` are read after the usual pages while the number is
   * still unseen (a locations page often carries each office's number); `judge(html)` is asked of every page read and its first
   * answer is returned as `judged` (the page itself is never kept); and a home page that redirects to another host says so
   * (`movedTo`, the host's name only), since that host is the site the business actually runs.
   */
  async function find(domain, { signal, phone = null, judge = null, morePaths = [] } = {}) {
    const host = String(domain ?? '').toLowerCase();
    if (!domainPattern.test(host) || host.length > 253) return { email: null, reason: 'invalid_domain' };
    const site = siteOf(host, signal);
    let read = 0;
    const wanted = /^\d{10}$/.test(String(phone ?? '')) ? String(phone) : null;
    let phoneSeen = false, email = null, sourceUrl = null, judged = null;
    // The home page (the first path) also says what the business is: its summary is returned whether or not an address is found.
    let summary = null;
    const extra = (Array.isArray(morePaths) ? morePaths : []).filter(path => typeof path === 'string' && /^\/[a-z0-9/_-]{0,60}$/i.test(path)
      && !contactPaths.includes(path)).slice(0, 3);
    for (const path of [...contactPaths, ...extra]) {
      signal?.throwIfAborted();
      // The usual pages are read until the address and the number are found; the extra ones only while the number is unseen.
      if (extra.includes(path) && (!wanted || phoneSeen)) break;
      if (!(await site.may(path))) continue;
      const page = await site.read(path);
      read += 1;
      if (page && path === '/') summary = siteSummary(page.text, page.url);
      if (page && wanted && !phoneSeen && phonesIn(page.text).has(wanted)) phoneSeen = true;
      if (page && typeof judge === 'function' && !judged) { try { judged = judge(page.text) || null; } catch { judged = null; } }
      const best = page ? roleAddresses(page.text, host)[0] : null;
      if (best && !email) { email = best; sourceUrl = page.url; }
      // Done once the address is found and the agency confirmed: by its number when one was given, else by the judge when asked.
      if (email && (wanted ? phoneSeen : typeof judge !== 'function' || Boolean(judged))) break;
    }
    const checked = { ...(wanted ? { phoneSeen } : {}), ...(judged ? { judged } : {}), ...(site.movedTo() ? { movedTo: site.movedTo() } : {}) };
    if (email) return { email, sourceUrl, ...(summary ? { site: summary } : {}), ...checked };
    return { email: null, reason: read === 0 ? 'robots' : 'none', ...(summary ? { site: summary } : {}), ...checked };
  }

  /**
   * What the business publishes about reaching it, from the usual contact pages (each allowed by robots.txt): its telephone numbers
   * as ten digits, call links first and never one written after "fax" (at most six), its postal addresses ({ city, state, zip }, at
   * most five) and its home page's title. Reading stops once it has six numbers and an address. Nothing is stored or logged here.
   */
  async function listing(domain, { signal } = {}) {
    const host = String(domain ?? '').toLowerCase();
    if (!domainPattern.test(host) || host.length > 253) return { phones: [], places: [], title: null, read: 0 };
    const site = siteOf(host, signal);
    const phones = [], places = [];
    let title = null, read = 0;
    for (const path of contactPaths) {
      signal?.throwIfAborted();
      if (!(await site.may(path))) continue;
      const page = await site.read(path);
      read += 1;
      if (!page) continue;
      if (path === '/') { try { title = analyzeHtml(page.text, page.url).title ?? null; } catch { title = null; } }
      for (const phone of publishedPhones(page.text)) if (!phones.includes(phone)) phones.push(phone);
      places.push(...placesIn(pageText(page.text)));
      if (phones.length >= matchPhoneLimit && places.length) break;
    }
    return { phones: phones.slice(0, matchPhoneLimit), places: places.slice(0, 5), title: title ? title.slice(0, 200) : null, read };
  }

  /**
   * Who leads the business, from its own site: the people its pages name with a title that decides ({ name, title, sourceUrl }) and
   * the people's addresses its pages publish on its domain ({ email, sourceUrl }). The home page first, then the pages it links to
   * that name people (team, leadership, about), then the usual ones; at most `teamPageLimit` pages, each allowed by robots.txt.
   */
  async function team(domain, { signal } = {}) {
    const host = String(domain ?? '').toLowerCase();
    if (!domainPattern.test(host) || host.length > 253) return { people: [], addresses: [] };
    const site = siteOf(host, signal);
    const people = new Map(), addresses = new Map();
    // The usual pages are queued from the start, so a home page that robots.txt forbids or that fails still leaves them to read.
    const queue = ['/', ...teamPaths];
    const seen = new Set();
    let read = 0;
    while (queue.length && read < teamPageLimit) {
      signal?.throwIfAborted();
      const path = queue.shift();
      if (seen.has(path)) continue;
      seen.add(path);
      if (!(await site.may(path))) continue;
      const page = await site.read(path);
      read += 1;
      if (!page) continue;
      for (const person of teamPeople(page.text)) if (!people.has(person.name.toLowerCase())) people.set(person.name.toLowerCase(), { ...person, sourceUrl: page.url });
      for (const email of personalAddresses(page.text, host)) if (!addresses.has(email)) addresses.set(email, { email, sourceUrl: page.url });
      if (path === '/') {
        let links = [];
        try { links = analyzeHtml(page.text, page.url).links; } catch { links = []; }
        queue.unshift(...teamLinks(links, site.hosts));
      }
    }
    return { people: [...people.values()].slice(0, 10), addresses: [...addresses.values()].slice(0, 20) };
  }

  return { configured: true, find, team, listing };
}
