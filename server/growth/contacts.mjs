/**
 * The contact finder: for a business the Marketing Manager found online, it reads that business's own website and keeps one public
 * role address on that business's domain (info@, contact@ and the like), which the database records as the business's one cold email
 * contact (private.growth_record_contact). The owner chose capped cold email to businesses' public addresses only (2026-11-04), so:
 *
 * - Only https pages on the business's own domain or its www. name are read, never a directory, search result or third-party page.
 * - robots.txt is honoured (for this finder's name and for every robot); a site that forbids it is left alone.
 * - At most four pages (the home page, contact, contact-us and about), 300 KB each, 10 seconds each; redirects only within the domain.
 * - A name that resolves to a private, loopback or link-local address, or an address literal, is never fetched. The connection itself
 *   resolves the name through the same check (pinnedFetch), so a name whose answer changes after the check cannot steer it elsewhere.
 * - A redirect is checked against the robots.txt of the host it leads to before it is followed.
 * - Only role local parts on the business's exact domain are kept; a personal address (jane.doe@, a name) is never kept, nor one on
 *   another domain, nor a phone number of any kind. An address is read whole: `jane!info@` is not taken for `info@`.
 *
 * Nothing it reads is stored except the one address and the page it was found on. Page text is never logged.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';

/** The role local parts the database admits for a found contact (growth_contacts_role_address_check), in order of preference. */
export const roleLocalParts = Object.freeze(['info', 'contact', 'contactus', 'office', 'hello', 'inquiries', 'inquiry', 'enquiries', 'enquiry',
  'admissions', 'sales', 'reception', 'frontdesk', 'general', 'admin', 'administrator', 'mail', 'team']);
export const contactPaths = Object.freeze(['/', '/contact', '/contact-us', '/about']);
export const finderAgent = 'CareMetricContactFinder';
const pageBytes = 300_000;
const robotsBytes = 100_000;
const timeoutMs = 10_000;
const domainPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,}$/;

/** Every role address on exactly `domain` in a page's text, mailto links included, best first. */
export function roleAddresses(text, domain) {
  const decoded = String(text ?? '')
    .replace(/&#(?:64|x40);/gi, '@').replace(/&commat;/gi, '@').replace(/&#(?:46|x2e);/gi, '.').replace(/%40/g, '@');
  const found = new Set();
  // An address starts where no character of an address's local part could come before it (RFC 5322 atext and the dot), so a longer
  // address such as jane!info@ or john/sales@ is never read as the role address at its end; and it ends where its domain ends.
  for (const match of decoded.matchAll(/(?<![a-z0-9!#$%&'*+\/=?^_`{|}~.-])[a-z0-9._%+-]{1,64}@[a-z0-9.-]{1,253}\.[a-z]{2,24}(?![a-z0-9-])/gi)) {
    const [local, host] = match[0].toLowerCase().split('@');
    if (host === domain && roleLocalParts.includes(local)) found.add(`${local}@${host}`);
  }
  return [...found].sort((a, b) => roleLocalParts.indexOf(a.split('@')[0]) - roleLocalParts.indexOf(b.split('@')[0]));
}

/**
 * Whether one robots.txt pattern matches `path`, as RFC 9309 reads it: `*` matches any run of characters, a final `$` anchors the end,
 * and anything else is a prefix.
 */
export function robotsPatternMatches(pattern, path) {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const source = body.split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${source}${anchored ? '$' : ''}`).test(path);
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
export function pinnedFetch(lookup = dnsLookup) {
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
    const outgoing = httpsRequest({
      protocol: 'https:', hostname: target.hostname, servername: target.hostname, port: 443, path: `${target.pathname}${target.search}`,
      method: 'GET', headers, signal, lookup: checkedLookup, agent: false,
    }, incoming => {
      const responseHeaders = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (value !== undefined) for (const one of [].concat(value)) responseHeaders.append(name, String(one));
      }
      const empty = [204, 205, 304].includes(incoming.statusCode);
      if (empty) incoming.resume();
      resolve(new Response(empty ? null : Readable.toWeb(incoming), { status: incoming.statusCode, headers: responseHeaders }));
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
  // A page: { url, text } or null.
  async function get(url, hosts, limit, signal, accept, allowed = null) {
    const result = await fetchOnHosts(url, hosts, limit, signal, accept, allowed, false);
    return result.outcome === 'ok' ? { url: result.url, text: result.text } : null;
  }

  /** The one role address to record for `domain`, with the page it was on, or why there is none. */
  async function find(domain, { signal } = {}) {
    const host = String(domain ?? '').toLowerCase();
    if (!domainPattern.test(host) || host.length > 253) return { email: null, reason: 'invalid_domain' };
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
    const robots = await robotsFor(host);
    let read = 0;
    for (const path of contactPaths) {
      signal?.throwIfAborted();
      if (!robotsAllows(robots, path)) continue;
      let page = null;
      try { page = await get(`https://${host}${path}`, hosts, pageBytes, signal, 'text/html', allowed); } catch (error) { if (signal?.aborted) throw error; }
      read += 1;
      const best = page ? roleAddresses(page.text, host)[0] : null;
      if (best) return { email: best, sourceUrl: page.url };
    }
    return { email: null, reason: read === 0 ? 'robots' : 'none' };
  }

  return { configured: true, find };
}
