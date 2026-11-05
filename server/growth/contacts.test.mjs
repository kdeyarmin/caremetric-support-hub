import { describe, expect, it, vi } from 'vitest';
import { contactPaths, growthContactFinder, privateAddress, roleAddresses, roleLocalParts, robotsAllows } from './contacts.mjs';

const publicLookup = vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]);
const page = (body, { status = 200, type = 'text/html; charset=utf-8', location = null } = {}) =>
  new Response(body, { status, headers: { 'content-type': type, ...(location ? { location } : {}) } });
// A fake website: path -> response (or a function of the URL). Anything else is a 404.
function site(pages) {
  const calls = [];
  const fetchImpl = vi.fn(async (url, init) => {
    calls.push({ url, redirect: init?.redirect, agent: init?.headers?.['User-Agent'] });
    const entry = pages[url];
    if (typeof entry === 'function') return entry(url);
    return entry ?? page('Not found', { status: 404 });
  });
  return { fetchImpl, calls };
}

describe('role addresses', () => {
  it('keeps only role addresses on the business\'s exact domain, best first', () => {
    const html = `<a href="mailto:Jane.Doe@Example.org">Jane</a> sales@example.org <a href="mailto:info@example.org?subject=Hi">Write</a>
      office@other.org admin@mail.example.org contact&#64;example.org 555-0100 hello@example.org.evil.test`;
    expect(roleAddresses(html, 'example.org')).toEqual(['info@example.org', 'contact@example.org', 'sales@example.org']);
  });
  it('never keeps a personal address, whatever the page says', () => {
    expect(roleAddresses('pat@example.org patricia.example@example.org director@example.org', 'example.org')).toEqual([]);
  });
  it('matches the role list the database admits', () => {
    expect(roleLocalParts).toEqual(expect.arrayContaining(['info', 'contact', 'office', 'admin', 'hello', 'inquiries', 'sales']));
    expect(new Set(roleLocalParts).size).toBe(roleLocalParts.length);
  });
});

describe('robots.txt', () => {
  it('follows the longest matching rule of the group for every robot', () => {
    const robots = 'User-agent: *\nDisallow: /private\nAllow: /private/contact\n\nUser-agent: OtherBot\nDisallow: /';
    expect(robotsAllows(robots, '/contact')).toBe(true);
    expect(robotsAllows(robots, '/private/team')).toBe(false);
    expect(robotsAllows(robots, '/private/contact')).toBe(true);
  });
  it('prefers a group naming this finder, and treats an empty Disallow as allowing all', () => {
    expect(robotsAllows('User-agent: *\nDisallow: /\n\nUser-agent: CareMetricContactFinder\nDisallow:', '/contact')).toBe(true);
    expect(robotsAllows('User-agent: CareMetricContactFinder\nDisallow: /', '/')).toBe(false);
    expect(robotsAllows('', '/')).toBe(true);
  });
});

describe('private addresses', () => {
  it('refuses loopback, private, link-local, shared and multicast ranges, and every IPv6 local range', () => {
    for (const address of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) {
      expect(privateAddress(address), address).toBe(true);
    }
    for (const address of ['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946']) expect(privateAddress(address), address).toBe(false);
    expect(privateAddress('not-an-address')).toBe(true);
  });
});

describe('the contact finder', () => {
  it('reads the business\'s own pages in order and returns the first role address with the page it was on', async () => {
    const { fetchImpl, calls } = site({
      'https://example.org/robots.txt': page('User-agent: *\nDisallow: /admin', { type: 'text/plain' }),
      'https://example.org/': page('<p>Welcome. Call us.</p>'),
      'https://example.org/contact': page('<a href="mailto:info@example.org">Email us</a> or jane@example.org'),
    });
    const finder = growthContactFinder({ fetchImpl, lookup: publicLookup });
    expect(await finder.find('example.org')).toEqual({ email: 'info@example.org', sourceUrl: 'https://example.org/contact' });
    expect(calls.map(call => call.url)).toEqual(['https://example.org/robots.txt', 'https://example.org/', 'https://example.org/contact']);
    expect(calls.every(call => call.redirect === 'manual' && call.agent.startsWith('CareMetricContactFinder'))).toBe(true);
  });

  it('reads at most the four known pages and says when nothing usable was found', async () => {
    const { fetchImpl, calls } = site({ 'https://example.org/': page('jane.doe@example.org') });
    expect(await growthContactFinder({ fetchImpl, lookup: publicLookup }).find('example.org')).toEqual({ email: null, reason: 'none' });
    expect(calls.length).toBe(1 + contactPaths.length);
  });

  it('honours robots.txt: a site that forbids every page is not read', async () => {
    const { fetchImpl, calls } = site({ 'https://example.org/robots.txt': page('User-agent: *\nDisallow: /', { type: 'text/plain' }) });
    expect(await growthContactFinder({ fetchImpl, lookup: publicLookup }).find('example.org')).toEqual({ email: null, reason: 'robots' });
    expect(calls.map(call => call.url)).toEqual(['https://example.org/robots.txt']);
  });

  it('follows a redirect to the www name but never off the business\'s domain', async () => {
    const { fetchImpl, calls } = site({
      'https://example.org/': page('', { status: 301, location: 'https://www.example.org/' }),
      'https://www.example.org/': page('contact@example.org'),
      'https://example.org/contact': page('', { status: 302, location: 'https://directory.test/listing?email=info@example.org' }),
    });
    expect(await growthContactFinder({ fetchImpl, lookup: publicLookup }).find('example.org')).toEqual({ email: 'contact@example.org', sourceUrl: 'https://www.example.org/' });
    const { fetchImpl: offsite, calls: offsiteCalls } = site({
      'https://example.org/': page('', { status: 302, location: 'https://directory.test/listing' }),
    });
    expect((await growthContactFinder({ fetchImpl: offsite, lookup: publicLookup }).find('example.org')).email).toBeNull();
    expect(offsiteCalls.some(call => call.url.startsWith('https://directory.test'))).toBe(false);
    expect(calls.some(call => call.url.startsWith('https://directory.test'))).toBe(false);
  });

  it('never connects to a name that resolves to a private address, an address literal or a malformed domain', async () => {
    const { fetchImpl } = site({});
    const privateLookup = vi.fn(async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.5', family: 4 }]);
    expect((await growthContactFinder({ fetchImpl, lookup: privateLookup }).find('example.org')).email).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
    for (const domain of ['127.0.0.1', 'localhost', 'example', 'exa mple.org', '']) {
      expect((await growthContactFinder({ fetchImpl, lookup: publicLookup }).find(domain))).toEqual({ email: null, reason: 'invalid_domain' });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('ignores pages that are not HTML or text and reads no further than the size cap', async () => {
    const big = `${'x'.repeat(400_000)} info@example.org`;
    const { fetchImpl } = site({
      'https://example.org/': page('info@example.org', { type: 'application/pdf' }),
      'https://example.org/contact': page(big),
    });
    expect(await growthContactFinder({ fetchImpl, lookup: publicLookup }).find('example.org')).toEqual({ email: null, reason: 'none' });
  });

  it('a network error on one page moves on to the next; an abort stops the search', async () => {
    const { fetchImpl } = site({
      'https://example.org/': () => { throw new TypeError('fetch failed'); },
      'https://example.org/contact': page('hello@example.org'),
    });
    expect((await growthContactFinder({ fetchImpl, lookup: publicLookup }).find('example.org')).email).toBe('hello@example.org');
    await expect(growthContactFinder({ fetchImpl, lookup: publicLookup }).find('example.org', { signal: AbortSignal.abort() })).rejects.toBeDefined();
  });
});
