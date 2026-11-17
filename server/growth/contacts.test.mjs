import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { contactPaths, growthContactFinder, pinnedFetch, privateAddress, roleAddresses, roleLocalParts, robotsAllows, robotsPatternMatches } from './contacts.mjs';

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
  it('reads an address whole: a longer address is never taken for the role address at its end', () => {
    const html = '<a href="mailto:jane!info@example.org">Jane</a> john/sales@example.org pat+office@example.org x.info@example.org a=contact@example.org';
    expect(roleAddresses(html, 'example.org')).toEqual([]);
    expect(roleAddresses('Write to info@example.org.', 'example.org')).toEqual(['info@example.org']);
    expect(roleAddresses('(info@example.org)', 'example.org')).toEqual(['info@example.org']);
    expect(roleAddresses('info@example.org-mail.test', 'example.org')).toEqual([]);
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
  it('honours wildcards and the end anchor, so a narrow Allow never opens the rest of a site', () => {
    const robots = 'User-agent: *\nDisallow: /\nAllow: /*.pdf$';
    expect(robotsAllows(robots, '/contact')).toBe(false);
    expect(robotsAllows(robots, '/')).toBe(false);
    expect(robotsAllows(robots, '/files/brochure.pdf')).toBe(true);
    expect(robotsAllows(robots, '/files/brochure.pdf?x=1')).toBe(false);
    expect(robotsAllows('User-agent: *\nDisallow: /*/contact', '/team/contact')).toBe(false);
    expect(robotsAllows('User-agent: *\nDisallow: /*/contact', '/contact')).toBe(true);
    expect(robotsAllows('User-agent: *\nDisallow: /about$', '/about')).toBe(false);
    expect(robotsAllows('User-agent: *\nDisallow: /about$', '/about-us')).toBe(true);
    expect(robotsAllows('User-agent: *\nDisallow: /a.b(c)', '/a.b(c)/x')).toBe(false);
    expect(robotsAllows('User-agent: *\nDisallow: /a.b(c)', '/aXb(c)')).toBe(true);
  });
  it('prefers a group naming this finder, and treats an empty Disallow as allowing all', () => {
    expect(robotsAllows('User-agent: *\nDisallow: /\n\nUser-agent: CareMetricContactFinder\nDisallow:', '/contact')).toBe(true);
    expect(robotsAllows('User-agent: CareMetricContactFinder\nDisallow: /', '/')).toBe(false);
    expect(robotsAllows('', '/')).toBe(true);
  });
  it('reads a pattern as a prefix, with * for any run of characters and a final $ for the end of the path', () => {
    expect(robotsPatternMatches('/team', '/team/contact')).toBe(true);
    expect(robotsPatternMatches('/team', '/teams')).toBe(true);
    expect(robotsPatternMatches('/team', '/our-team')).toBe(false);
    expect(robotsPatternMatches('/', '/anything')).toBe(true);
    expect(robotsPatternMatches('/team$', '/team')).toBe(true);
    expect(robotsPatternMatches('/team$', '/team/')).toBe(false);
    expect(robotsPatternMatches('/*.pdf$', '/files/a.pdf')).toBe(true);
    expect(robotsPatternMatches('/*.pdf$', '/files/a.pdf.html')).toBe(false);
    expect(robotsPatternMatches('/*.pdf', '/files/a.pdf.html')).toBe(true);
    expect(robotsPatternMatches('/*a*a$', '/aa')).toBe(true);
    expect(robotsPatternMatches('/*a*a$', '/a')).toBe(false);
    expect(robotsPatternMatches('/*ab*ba$', '/aba')).toBe(false);
    expect(robotsPatternMatches('/*ab*ba$', '/abba')).toBe(true);
    expect(robotsPatternMatches('/**', '/x')).toBe(true);
    expect(robotsPatternMatches('/a$b', '/a$b/c')).toBe(true);
    expect(robotsPatternMatches('$', '')).toBe(true);
    expect(robotsPatternMatches('$', '/')).toBe(false);
  });
  it('answers as the wildcard regular expression it replaced, for every pattern and path', () => {
    const reference = (pattern, path) => {
      const anchored = pattern.endsWith('$');
      const source = (anchored ? pattern.slice(0, -1) : pattern).split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
      return new RegExp(`^${source}${anchored ? '$' : ''}`).test(path);
    };
    // A fixed pseudo-random sequence, so a failure always shows the same case.
    let seed = 20261117;
    const next = limit => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % limit; };
    const text = (length, alphabet) => Array.from({ length }, () => alphabet[next(alphabet.length)]).join('');
    for (let run = 0; run < 20000; run += 1) {
      const pattern = `/${text(next(7), ['a', 'b', '*', '.', '/', '$'])}${next(3) === 0 ? '$' : ''}`;
      const path = `/${text(next(9), ['a', 'b', '.', '/', '$'])}`;
      expect(robotsPatternMatches(pattern, path), `${pattern} ${path}`).toBe(reference(pattern, path));
    }
  });
  it('answers a rule with a long run of wildcards at once, whatever the path', () => {
    // As a regular expression this rule backtracked for hours on a path it does not match, and a site can also choose the path by redirect.
    const robots = `User-agent: *\nDisallow: /${'*'.repeat(40)}z$\nDisallow: /${'*a'.repeat(40)}b`;
    const started = performance.now();
    expect(robotsAllows(robots, '/contact-us/our-team')).toBe(true);
    expect(robotsAllows(robots, `/${'a'.repeat(5000)}`)).toBe(true);
    expect(robotsAllows(robots, `/${'a'.repeat(5000)}z`)).toBe(false);
    expect(performance.now() - started).toBeLessThan(2000);
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

  it('treats a robots.txt it cannot read as forbidding the site, and a missing one as allowing it (RFC 9309)', async () => {
    for (const robots of [page('Service unavailable', { status: 503 }), () => { throw new TypeError('fetch failed'); }]) {
      const { fetchImpl, calls } = site({ 'https://example.org/robots.txt': robots, 'https://example.org/contact': page('info@example.org') });
      expect(await growthContactFinder({ fetchImpl, lookup: publicLookup }).find('example.org')).toEqual({ email: null, reason: 'robots' });
      expect(calls.map(call => call.url)).toEqual(['https://example.org/robots.txt']);
    }
    // Rules are rules whatever the content type they are served with.
    const { fetchImpl: binary } = site({ 'https://example.org/robots.txt': page('User-agent: *\nDisallow: /', { type: 'application/octet-stream' }), 'https://example.org/contact': page('info@example.org') });
    expect(await growthContactFinder({ fetchImpl: binary, lookup: publicLookup }).find('example.org')).toEqual({ email: null, reason: 'robots' });
    const { fetchImpl: missing } = site({ 'https://example.org/robots.txt': page('Gone', { status: 410 }), 'https://example.org/contact': page('info@example.org') });
    expect(await growthContactFinder({ fetchImpl: missing, lookup: publicLookup }).find('example.org')).toEqual({ email: 'info@example.org', sourceUrl: 'https://example.org/contact' });
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

  it('checks a redirect against the robots.txt of the host it leads to before following it', async () => {
    const { fetchImpl, calls } = site({
      'https://example.org/robots.txt': page('User-agent: *\nDisallow: /private', { type: 'text/plain' }),
      'https://example.org/': page('', { status: 302, location: '/private/contact' }),
      'https://example.org/private/contact': page('info@example.org'),
      'https://example.org/contact': page('', { status: 301, location: 'https://www.example.org/team' }),
      'https://www.example.org/robots.txt': page('User-agent: *\nDisallow: /team', { type: 'text/plain' }),
      'https://www.example.org/team': page('office@example.org'),
    });
    expect(await growthContactFinder({ fetchImpl, lookup: publicLookup }).find('example.org')).toEqual({ email: null, reason: 'none' });
    expect(calls.map(call => call.url)).not.toContain('https://example.org/private/contact');
    expect(calls.map(call => call.url)).not.toContain('https://www.example.org/team');
    expect(calls.map(call => call.url)).toContain('https://www.example.org/robots.txt');
  });

  it('connects only to addresses it checked at connection time, so a name whose answer changes after the check is refused', async () => {
    // The first answer (the pre-check) is public; the second (the connection's own lookup) is private: the connection is refused
    // before any socket is opened, so nothing is read. Its robots.txt cannot be read either, so no page is tried.
    let answers = 0;
    const rebinding = vi.fn(async () => (answers++ % 2 === 0 ? [{ address: '93.184.216.34', family: 4 }] : [{ address: '127.0.0.1', family: 4 }]));
    expect(await growthContactFinder({ lookup: rebinding }).find('example.org')).toEqual({ email: null, reason: 'robots' });
    expect(rebinding.mock.calls.length).toBeGreaterThanOrEqual(2);
    await expect(pinnedFetch(async () => [{ address: '10.0.0.5', family: 4 }])('https://example.org/')).rejects.toMatchObject({ code: 'EPRIVATEADDRESS' });
    await expect(pinnedFetch(async () => [])('https://example.org/')).rejects.toMatchObject({ code: 'EPRIVATEADDRESS' });
  });

  it('treats an answer whose status a Response cannot hold (LinkedIn answers 999) as no page, without stopping the process', async () => {
    // A stand-in for https.request that answers the way Node does: on a later turn, with any three-digit status. A throw inside that
    // callback is uncaught, so before this was handled one such website stopped the whole Hub.
    const answering = status => (options, onResponse) => {
      const outgoing = new EventEmitter();
      outgoing.end = () => setImmediate(() => {
        const incoming = Readable.from([Buffer.from('<p>blocked</p>')]);
        Object.assign(incoming, { statusCode: status, headers: { 'content-type': 'text/html' } });
        onResponse(incoming);
      });
      return outgoing;
    };
    for (const status of [999, 600]) {
      await expect(pinnedFetch(publicLookup, answering(status))('https://example.org/')).rejects.toMatchObject({ code: 'EBADSTATUS' });
    }
    const ok = await pinnedFetch(publicLookup, answering(200))('https://example.org/');
    expect([ok.status, await ok.text()]).toEqual([200, '<p>blocked</p>']);
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

describe('the team reader', () => {
  it('reads the home page, the pages it links to that name people, then the usual ones, within robots.txt and six pages', async () => {
    const { fetchImpl, calls } = site({
      'https://example.org/robots.txt': page('User-agent: *\nDisallow: /team', { type: 'text/plain' }),
      'https://example.org/': page('<a href="/our-leadership">Leadership</a><a href="/team">Team</a><a href="https://other.org/staff">x</a><p>Welcome</p>'),
      'https://example.org/our-leadership': page(`<h3>Jane Doe, RN</h3><p>Administrator</p><a href="mailto:jdoe@example.org">Email</a>
        <a href="mailto:info@example.org">Office</a><a href="mailto:jane@gmail.com">Personal</a><p>Sam Lee – Director of Business Development</p>`),
      'https://example.org/about': page('<p>Founded by Mary Major (Owner)</p><p>Mary Major (Owner)</p>'),
    });
    const team = await growthContactFinder({ fetchImpl, lookup: publicLookup }).team('example.org');
    expect(team).toEqual({
      people: [{ name: 'Jane Doe', title: 'Administrator', sourceUrl: 'https://example.org/our-leadership' },
        { name: 'Sam Lee', title: 'Director of Business Development', sourceUrl: 'https://example.org/our-leadership' },
        { name: 'Mary Major', title: 'Owner', sourceUrl: 'https://example.org/about' }],
      addresses: [{ email: 'jdoe@example.org', sourceUrl: 'https://example.org/our-leadership' }],
    });
    const read = calls.map(call => new URL(call.url).pathname).filter(path => path !== '/robots.txt');
    expect(read).toEqual(['/', '/our-leadership', '/about', '/about-us', '/our-team', '/leadership']);
    expect(read).not.toContain('/team');
  });

  it('still reads the usual pages when robots.txt forbids the home page or it fails', async () => {
    const { fetchImpl, calls } = site({
      'https://example.org/robots.txt': page('User-agent: *\nDisallow: /$', { type: 'text/plain' }),
      'https://example.org/team': page('<h3>Jane Doe</h3><p>Administrator</p>'),
    });
    expect((await growthContactFinder({ fetchImpl, lookup: publicLookup }).team('example.org')).people).toEqual([
      { name: 'Jane Doe', title: 'Administrator', sourceUrl: 'https://example.org/team' }]);
    expect(calls.map(call => new URL(call.url).pathname)).not.toContain('/');
  });
});
