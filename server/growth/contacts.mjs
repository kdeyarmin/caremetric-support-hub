/**
 * The contact finder: for a business the Marketing Manager found online, it reads that business's own website and keeps one public
 * role address on that business's domain (info@, contact@ and the like), which the database records as the business's one cold email
 * contact (private.growth_record_contact). The owner chose capped cold email to businesses' public addresses only (2026-11-04), so:
 *
 * - Only https pages on the business's own domain or its www. name are read, never a directory, search result or third-party page.
 * - robots.txt is honoured (for this finder's name and for every robot); a site that forbids it is left alone.
 * - At most four pages (the home page, contact, contact-us and about), 300 KB each, 10 seconds each; redirects only within the domain.
 * - A name that resolves to a private, loopback or link-local address, or an address literal, is never fetched.
 * - Only role local parts on the business's exact domain are kept; a personal address (jane.doe@, a name) is never kept, nor one on
 *   another domain, nor a phone number of any kind.
 *
 * Nothing it reads is stored except the one address and the page it was found on. Page text is never logged.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

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
  for (const match of decoded.matchAll(/[a-z0-9._%+-]{1,64}@[a-z0-9.-]{1,253}\.[a-z]{2,24}/gi)) {
    const [local, host] = match[0].toLowerCase().split('@');
    if (host === domain && roleLocalParts.includes(local)) found.add(`${local}@${host}`);
  }
  return [...found].sort((a, b) => roleLocalParts.indexOf(a.split('@')[0]) - roleLocalParts.indexOf(b.split('@')[0]));
}

/** Whether robots.txt lets this finder read `path`: the longest matching rule of the group for this finder, else of `*`, wins. */
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
      if (value !== '') current.rules.push({ allow: field === 'allow', prefix: value.replace(/\*.*$/, '').replace(/\$$/, '') });
    } else {
      lastWasAgent = false;
    }
  }
  const mine = groups.filter(group => group.agents.some(agent => agent !== '*' && finderAgent.toLowerCase().includes(agent)));
  const applicable = mine.length > 0 ? mine : groups.filter(group => group.agents.includes('*'));
  let best = null;
  for (const rule of applicable.flatMap(group => group.rules)) {
    if (!path.startsWith(rule.prefix)) continue;
    if (!best || rule.prefix.length > best.prefix.length || (rule.prefix.length === best.prefix.length && rule.allow)) best = rule;
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

export function growthContactFinder({ fetchImpl = fetch, lookup = dnsLookup } = {}) {
  async function safeHost(host) {
    if (isIP(host)) return false;
    try {
      const addresses = await lookup(host, { all: true });
      return Array.isArray(addresses) && addresses.length > 0 && addresses.every(entry => !privateAddress(entry.address));
    } catch { return false; }
  }

  // One GET on the business's own hosts, following at most two redirects that stay on them. Returns { url, text } or null.
  async function get(url, hosts, limit, signal, accept) {
    let target = new URL(url);
    for (let hop = 0; hop < 3; hop += 1) {
      if (target.protocol !== 'https:' || target.username || target.password || target.port || !hosts.includes(target.hostname)) return null;
      if (!(await safeHost(target.hostname))) return null;
      const response = await fetchImpl(target.href, {
        redirect: 'manual', headers: { 'User-Agent': `${finderAgent}/1.0 (+https://help.caremetric.ai)`, Accept: accept },
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
      });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel?.().catch(() => {});
        const location = response.headers.get('location');
        if (!location) return null;
        target = new URL(location, target);
        continue;
      }
      if (!response.ok) { await response.body?.cancel?.().catch(() => {}); return null; }
      const type = String(response.headers.get('content-type') ?? '').toLowerCase();
      if (!type.startsWith('text/html') && !type.startsWith('text/plain')) { await response.body?.cancel?.().catch(() => {}); return null; }
      return { url: target.href, text: await readLimited(response, limit) };
    }
    return null;
  }

  /** The one role address to record for `domain`, with the page it was on, or why there is none. */
  async function find(domain, { signal } = {}) {
    const host = String(domain ?? '').toLowerCase();
    if (!domainPattern.test(host) || host.length > 253) return { email: null, reason: 'invalid_domain' };
    const hosts = [host, `www.${host}`];
    let robots = '';
    try {
      const page = await get(`https://${host}/robots.txt`, hosts, robotsBytes, signal, 'text/plain');
      robots = page?.text ?? '';
    } catch (error) {
      if (signal?.aborted) throw error;
    }
    let read = 0;
    for (const path of contactPaths) {
      signal?.throwIfAborted();
      if (!robotsAllows(robots, path)) continue;
      let page = null;
      try { page = await get(`https://${host}${path}`, hosts, pageBytes, signal, 'text/html'); } catch (error) { if (signal?.aborted) throw error; }
      read += 1;
      const best = page ? roleAddresses(page.text, host)[0] : null;
      if (best) return { email: best, sourceUrl: page.url };
    }
    return { email: null, reason: read === 0 ? 'robots' : 'none' };
  }

  return { configured: true, find };
}
