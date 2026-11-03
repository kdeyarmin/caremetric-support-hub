import { generateKeyPairSync, verify } from 'node:crypto';
import { inspect } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import {
  apiOrigin, readCredentials, readProperties, readScope, searchConsoleHosts, searchConsoleReader, signAssertion, tokenUrl, windows,
} from './search-console.mjs';

// One key pair for the whole file, made here: no key is checked in.
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const pemBody = pem.split('\n')[1];
const account = 'seo-reader@caremetric-seo.iam.gserviceaccount.com';
const keyFile = (over = {}) => JSON.stringify({
  type: 'service_account', project_id: 'caremetric-seo', private_key_id: 'abc123def456', private_key: pem, client_email: account,
  client_id: '1234567890', token_uri: 'https://evil.test/token', ...over,
});
const decode = part => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
const accessToken = 'fixture-access-token-0001-not-real';

describe('reading the service account key', () => {
  it('reads the key file as Google downloads it, or the same text in base64', () => {
    for (const raw of [keyFile(), `  ${keyFile()}\n`, Buffer.from(keyFile()).toString('base64')]) {
      const credentials = readCredentials(raw);
      expect(credentials).toMatchObject({ state: 'ready', clientEmail: account, keyId: 'abc123def456' });
      expect(credentials.privateKey.asymmetricKeyType).toBe('rsa');
    }
  });

  it('never shows the key, however the result is printed', () => {
    const credentials = readCredentials(keyFile());
    expect(JSON.stringify(credentials)).not.toContain(pemBody);
    expect(inspect(credentials, { depth: 5 })).not.toContain(pemBody);
  });

  it('says missing or invalid, and nothing more, for anything else', () => {
    expect(readCredentials(undefined)).toEqual({ state: 'missing' });
    expect(readCredentials('   ')).toEqual({ state: 'missing' });
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' });
    for (const raw of ['{not json', '"text"', 'null', keyFile({ type: 'authorized_user' }), keyFile({ client_email: 'not-an-email' }), keyFile({ private_key: 'garbage' }),
      keyFile({ private_key: undefined }), keyFile({ private_key: ec })]) {
      expect(readCredentials(raw), raw.slice(0, 40)).toEqual({ state: 'invalid' });
    }
    // An odd key id is left out rather than sent in the header.
    expect(readCredentials(keyFile({ private_key_id: 'bad id"' })).keyId).toBeNull();
  });
});

describe('reading the properties', () => {
  it('takes domain properties and address prefixes as Search Console writes them', () => {
    expect(readProperties('sc-domain:CMCAREBASE.com, https://www.caremetricintel.com/ https://caremetricadvisors.com')).toEqual({
      properties: ['sc-domain:cmcarebase.com', 'https://www.caremetricintel.com/', 'https://caremetricadvisors.com/'], invalid: 0,
    });
  });

  it('keeps an address prefix exactly as written: a bare host always has its slash, and a slash is never added to a path', () => {
    // The API names a property "as defined in Search Console" (its examples are http://www.example.com/ and sc-domain:example.com), and
    // Google's help asks for the prefix "including the final / mark"; neither says a prefix without it cannot exist, so none is added.
    expect(readProperties('https://cmcarebase.com/training,https://cmcarebase.com/guides/,https://www.caremetricintel.com').properties)
      .toEqual(['https://cmcarebase.com/training', 'https://cmcarebase.com/guides/', 'https://www.caremetricintel.com/']);
  });

  it('leaves out and counts what it cannot use, and reads at most ten', () => {
    expect(readProperties('cmcarebase.com,sc-domain:,ftp://x.test/,https://a.test/?q=1,https://user:pw@b.test/,sc-domain:cmcarebase.com,sc-domain:cmcarebase.com'))
      .toEqual({ properties: ['sc-domain:cmcarebase.com'], invalid: 5 });
    expect(readProperties('')).toEqual({ properties: [], invalid: 0 });
    const many = Array.from({ length: 12 }, (_, index) => `sc-domain:site${index}.test`).join(',');
    expect(readProperties(many)).toMatchObject({ invalid: 2 });
    expect(readProperties(many).properties).toHaveLength(10);
  });
});

describe('the signed assertion', () => {
  const credentials = readCredentials(keyFile());

  it('is an RS256 JWT for Google\'s token endpoint, asking only to read Search Console, for one hour', () => {
    const jwt = signAssertion(credentials, { issuedAt: 1_800_000_000 });
    const [header, claims, signature] = jwt.split('.');
    expect(decode(header)).toEqual({ alg: 'RS256', typ: 'JWT', kid: 'abc123def456' });
    expect(decode(claims)).toEqual({ iss: account, scope: 'https://www.googleapis.com/auth/webmasters.readonly', aud: 'https://oauth2.googleapis.com/token', iat: 1_800_000_000, exp: 1_800_003_600 });
    expect(verify('RSA-SHA256', Buffer.from(`${header}.${claims}`), publicKey, Buffer.from(signature, 'base64url'))).toBe(true);
  });

  it('cannot be altered without breaking the signature, and signs the same claims the same way', () => {
    const jwt = signAssertion(credentials, { issuedAt: 1_800_000_000 });
    const [header, , signature] = jwt.split('.');
    const forged = Buffer.from(JSON.stringify({ iss: account, scope: 'https://www.googleapis.com/auth/webmasters', aud: tokenUrl, iat: 1_800_000_000, exp: 1_800_003_600 })).toString('base64url');
    expect(verify('RSA-SHA256', Buffer.from(`${header}.${forged}`), publicKey, Buffer.from(signature, 'base64url'))).toBe(false);
    expect(signAssertion(credentials, { issuedAt: 1_800_000_000 })).toBe(jwt);
    expect(decode(signAssertion({ ...credentials, keyId: null }, { issuedAt: 1 }).split('.')[0])).toEqual({ alg: 'RS256', typ: 'JWT' });
  });
});

describe('the windows the report compares', () => {
  it('ends three days back in Search Console\'s Pacific day, and compares 28 days with the 28 before', () => {
    expect(windows(new Date('2026-11-02T12:00:00Z'))).toEqual({
      current: { startDate: '2026-10-03', endDate: '2026-10-30' }, previous: { startDate: '2026-09-05', endDate: '2026-10-02' },
    });
    // 05:00 UTC on November 3 is still November 2 in California.
    expect(windows(new Date('2026-11-03T05:00:00Z')).current.endDate).toBe('2026-10-30');
  });
});

// ---- The reader against a scripted network -----------------------------------------------------------------------------------

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const row = (keys, clicks, impressions, ctr, position) => ({ keys, clicks, impressions, ctr, position });
/** A Search Console that answers by property and request shape. */
const apiAnswer = (property, request) => {
  const dims = (request.dimensions ?? []).join(',');
  if (dims === '') return { rows: [{ clicks: request.startDate === '2026-10-03' ? 120 : 100, impressions: 4000, ctr: 0.03, position: 12.5 }], responseAggregationType: 'byProperty' };
  if (dims === 'query') return { rows: [row(['personal care home software'], 40, 900, 0.044, 6.1)] };
  if (dims === 'page') return { rows: [row([`https://cmcarebase.com/${property.length}`], 40, 900, 0.044, 6.1)] };
  return { rows: [row(['personal care home software', 'https://cmcarebase.com/'], 30, 600, 0.05, 5)] };
};

function network({ token = [() => json({ access_token: accessToken, expires_in: 3599, token_type: 'Bearer' })], api = (property, request) => json(apiAnswer(property, request)) } = {}) {
  const requests = [];
  let tokenCalls = 0;
  const fetchImpl = vi.fn(async (url, init) => {
    const parsed = new URL(url);
    requests.push({ url, host: parsed.host, init, body: init.body });
    if (url === tokenUrl) {
      const step = token[Math.min(tokenCalls, token.length - 1)];
      tokenCalls += 1;
      return step(init);
    }
    const match = /^\/webmasters\/v3\/sites\/([^/]+)\/searchAnalytics\/query$/.exec(parsed.pathname);
    if (parsed.origin !== apiOrigin || !match) throw new TypeError('unexpected address');
    return api(decodeURIComponent(match[1]), JSON.parse(init.body), init);
  });
  return { fetchImpl, requests, tokenCalls: () => tokenCalls, apiCalls: () => requests.filter(request => request.url !== tokenUrl) };
}
const hang = init => new Promise((_, reject) => {
  if (init.signal.aborted) reject(init.signal.reason);
  else init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
});
const moment = new Date('2026-11-02T12:00:00Z');

function reader({ net = network(), sites = 'sc-domain:cmcarebase.com', credentials = keyFile(), clock = () => moment.getTime(), limits = {} } = {}) {
  const logs = [];
  const instance = searchConsoleReader({ credentials, sites, fetchImpl: net.fetchImpl, log: line => logs.push(line), clock, sleep: async () => {}, limits: { timeoutMs: 40, ...limits } });
  return { instance, net, logs };
}

describe('the Search Console reader', () => {
  it('says what is missing before it makes any request', () => {
    const states = [[undefined, undefined, 'not_configured'], [undefined, 'sc-domain:a.test', 'credentials_missing'], ['{', 'sc-domain:a.test', 'credentials_invalid'],
      [keyFile(), '', 'no_properties'], [keyFile(), 'a.test', 'no_properties'], [keyFile(), 'sc-domain:a.test', 'ready']];
    for (const [credentials, sites, state] of states) {
      const net = network();
      const instance = searchConsoleReader({ credentials, sites, fetchImpl: net.fetchImpl, log: () => {} });
      expect(instance.state, state).toBe(state);
      expect(instance.configured).toBe(state === 'ready');
      expect(net.requests).toHaveLength(0);
    }
    expect(reader().instance.account).toBe(account);
    expect(reader({ credentials: '{' }).instance.account).toBeNull();
  });

  it('signs in once with a fresh assertion and reads each property\'s totals, searches, pages and both together', async () => {
    const { instance, net } = reader({ sites: 'sc-domain:cmcarebase.com,https://www.caremetricintel.com/' });
    const read = await instance.read({ now: moment });
    expect(net.tokenCalls()).toBe(1);
    const tokenRequest = net.requests.find(request => request.url === tokenUrl);
    expect(tokenRequest.init).toMatchObject({ method: 'POST', redirect: 'error', cache: 'no-store' });
    expect(tokenRequest.init.headers['content-type']).toBe('application/x-www-form-urlencoded');
    const form = new URLSearchParams(tokenRequest.body);
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    const [header, claims, signature] = form.get('assertion').split('.');
    expect(decode(claims)).toMatchObject({ iss: account, scope: readScope, aud: tokenUrl, iat: Math.floor(moment.getTime() / 1000) });
    expect(verify('RSA-SHA256', Buffer.from(`${header}.${claims}`), publicKey, Buffer.from(signature, 'base64url'))).toBe(true);

    expect(net.apiCalls()).toHaveLength(10);
    for (const request of net.apiCalls()) {
      expect(request.init).toMatchObject({ method: 'POST', redirect: 'error', cache: 'no-store' });
      expect(request.init.headers.authorization).toBe(`Bearer ${accessToken}`);
    }
    expect(net.apiCalls().map(request => request.url)).toContain(`${apiOrigin}/webmasters/v3/sites/sc-domain%3Acmcarebase.com/searchAnalytics/query`);
    expect(net.apiCalls().map(request => request.url)).toContain(`${apiOrigin}/webmasters/v3/sites/https%3A%2F%2Fwww.caremetricintel.com%2F/searchAnalytics/query`);
    const bodies = net.apiCalls().filter(request => request.url.includes('cmcarebase')).map(request => JSON.parse(request.body));
    expect(bodies).toEqual(expect.arrayContaining([
      { startDate: '2026-10-03', endDate: '2026-10-30', type: 'web', dataState: 'final' },
      { startDate: '2026-09-05', endDate: '2026-10-02', type: 'web', dataState: 'final' },
      { startDate: '2026-10-03', endDate: '2026-10-30', type: 'web', dataState: 'final', dimensions: ['query'], rowLimit: 250 },
      { startDate: '2026-10-03', endDate: '2026-10-30', type: 'web', dataState: 'final', dimensions: ['page'], rowLimit: 250 },
      { startDate: '2026-10-03', endDate: '2026-10-30', type: 'web', dataState: 'final', dimensions: ['query', 'page'], rowLimit: 250 },
    ]));
    expect(new Set(net.requests.map(request => request.host))).toEqual(new Set(searchConsoleHosts));

    expect(read.window.current).toEqual({ startDate: '2026-10-03', endDate: '2026-10-30' });
    expect(read.properties[0]).toMatchObject({
      property: 'sc-domain:cmcarebase.com', ok: true,
      totals: { current: { clicks: 120, impressions: 4000, ctr: 0.03, position: 12.5 }, previous: { clicks: 100 } },
      queries: [{ keys: ['personal care home software'], clicks: 40, impressions: 900 }],
      pairs: [{ keys: ['personal care home software', 'https://cmcarebase.com/'], clicks: 30 }],
    });
  });

  it('keeps the access token until shortly before it expires, and shares one sign-in between requests made together', async () => {
    let time = moment.getTime();
    const { instance, net } = reader({ clock: () => time });
    await instance.read({ now: moment });
    await instance.read({ now: moment });
    expect(net.tokenCalls()).toBe(1);
    time += 3_500_000;
    await instance.read({ now: moment });
    expect(net.tokenCalls()).toBe(1);
    time += 100_000;
    await instance.read({ now: moment });
    expect(net.tokenCalls()).toBe(2);
  });

  it('tries the token endpoint once more after a server error, a timeout or a dropped connection, and never after a refusal', async () => {
    const recovered = network({ token: [() => json({ error: 'backendError' }, 503), () => json({ access_token: accessToken, expires_in: 3600 })] });
    expect((await reader({ net: recovered }).instance.read({ now: moment })).properties[0].ok).toBe(true);
    expect(recovered.tokenCalls()).toBe(2);

    const slow = network({ token: [hang] });
    const slowRead = reader({ net: slow });
    expect((await slowRead.instance.read({ now: moment })).properties[0]).toEqual({ property: 'sc-domain:cmcarebase.com', ok: false, code: 'token_unreachable', status: null });
    expect(slow.tokenCalls()).toBe(2);

    const dropped = network({ token: [() => { throw new TypeError('fetch failed'); }] });
    expect((await reader({ net: dropped }).instance.read({ now: moment })).properties[0].code).toBe('token_unreachable');
    expect(dropped.tokenCalls()).toBe(2);

    const refused = network({ token: [() => json({ error: 'invalid_grant', error_description: `Invalid JWT ${pemBody}` }, 400)] });
    const refusedRead = reader({ net: refused });
    expect((await refusedRead.instance.read({ now: moment })).properties[0]).toEqual({ property: 'sc-domain:cmcarebase.com', ok: false, code: 'token_refused', status: 400 });
    expect(refused.tokenCalls()).toBe(1);
    expect(refused.apiCalls()).toHaveLength(0);

    const odd = network({ token: [() => json({ access_token: 'short' })] });
    expect((await reader({ net: odd }).instance.read({ now: moment })).properties[0].code).toBe('token_invalid');
  });

  it('asks again with a fresh token when Google refuses the one it has, once', async () => {
    let refusals = 1;
    const net = network({ api: (property, request) => (refusals-- > 0 ? json({ error: { code: 401 } }, 401) : json(apiAnswer(property, request))) });
    const read = await reader({ net }).instance.read({ now: moment });
    expect(read.properties[0].ok).toBe(true);
    expect(net.tokenCalls()).toBe(2);
    const always = network({ api: () => json({ error: { code: 401 } }, 401) });
    expect((await reader({ net: always }).instance.read({ now: moment })).properties[0].code).toBe('token_refused');
  });

  it('retries a query once after a server error, a rate limit or a timeout, and reads each failure as a code', async () => {
    const cases = [
      ['a server error that clears', [500], true, null],
      ['a server error that stays', [500, 500], false, 'api_unavailable'],
      ['a rate limit that stays', [429, 429], false, 'rate_limited'],
      ['no permission on the property', [403], false, 'not_permitted'],
      ['an unknown property', [404], false, 'property_not_found'],
      ['a request Google rejects', [400], false, 'request_rejected'],
    ];
    for (const [name, statuses, ok, code] of cases) {
      const calls = new Map();
      const net = network({
        api: (property, request) => {
          const key = JSON.stringify(request);
          const index = calls.get(key) ?? 0;
          calls.set(key, index + 1);
          return index < statuses.length ? json({ error: { message: `refused ${pemBody}` } }, statuses[index]) : json(apiAnswer(property, request));
        },
      });
      const { instance, logs } = reader({ net });
      const entry = (await instance.read({ now: moment })).properties[0];
      expect(entry.ok, name).toBe(ok);
      if (!ok) expect(entry.code, name).toBe(code);
      const attempts = Math.max(...calls.values());
      expect(attempts, name).toBe([403, 404, 400].includes(statuses[0]) ? 1 : 2);
      expect(logs.join('\n')).not.toContain(pemBody);
    }
    const hanging = network({ api: (property, request, init) => hang(init) });
    const { instance } = reader({ net: hanging });
    expect((await instance.read({ now: moment })).properties[0]).toMatchObject({ ok: false, code: 'api_unreachable', status: null });
    expect(hanging.apiCalls()).toHaveLength(10);
  });

  it('refuses an answer it cannot read', async () => {
    for (const answer of [() => new Response('not json', { status: 200 }), () => json({ rows: 'many' }), () => json([1, 2])]) {
      const { instance } = reader({ net: network({ api: answer }) });
      expect((await instance.read({ now: moment })).properties[0].code).toBe('response_invalid');
    }
    // Rows of the wrong shape are dropped; the rest are kept.
    const { instance } = reader({ net: network({ api: (property, request) => (request.dimensions?.[0] === 'query' && request.dimensions.length === 1
      ? json({ rows: [row(['ok'], 1, 2, 0.5, 3), { keys: [5], clicks: 1 }, row(['a', 'b'], 1, 1, 1, 1), { keys: ['no numbers'] }] }) : json(apiAnswer(property, request))) }) });
    expect((await instance.read({ now: moment })).properties[0].queries).toEqual([row(['ok'], 1, 2, 0.5, 3), { keys: ['no numbers'], clicks: 0, impressions: 0, ctr: 0, position: 0 }]);
  });

  it('keeps reading the other properties when one cannot be read', async () => {
    const net = network({ api: (property, request) => (property.includes('intel') ? json({}, 403) : json(apiAnswer(property, request))) });
    const read = await reader({ net, sites: 'sc-domain:cmcarebase.com,https://www.caremetricintel.com/' }).instance.read({ now: moment });
    expect(read.properties.map(entry => [entry.property, entry.ok, entry.code])).toEqual([['sc-domain:cmcarebase.com', true, undefined], ['https://www.caremetricintel.com/', false, 'not_permitted']]);
  });

  it('never puts the key, the assertion or the access token in a log line, an error or a result', async () => {
    const net = network({ api: (property, request) => (property.includes('intel') ? json({ error: { message: `token ${accessToken}` } }, 500) : json(apiAnswer(property, request))) });
    const { instance, logs } = reader({ net, sites: 'sc-domain:cmcarebase.com,https://www.caremetricintel.com/' });
    const read = await instance.read({ now: moment });
    const assertion = new URLSearchParams(net.requests.find(request => request.url === tokenUrl).body).get('assertion');
    const everything = JSON.stringify({ read, logs, instance });
    for (const secret of [pemBody, assertion, accessToken, 'abc123def456']) expect(everything).not.toContain(secret);
    expect(logs).toEqual([JSON.stringify({ event: 'hub_seo_search_console_failed', property: 'https://www.caremetricintel.com/', code: 'api_unavailable', status: 500 })]);
  });

  it('stops when the task is stopped, and says so by rejecting', async () => {
    const controller = new AbortController();
    const net = network({ api: (property, request, init) => { controller.abort(); return hang(init); } });
    await expect(reader({ net }).instance.read({ now: moment, signal: controller.signal })).rejects.toMatchObject({ code: 'aborted' });
    // A transport that ignores its signal is still given up on at the time limit.
    const deaf = network({ api: () => new Promise(() => {}) });
    expect((await reader({ net: deaf }).instance.read({ now: moment })).properties[0]).toMatchObject({ ok: false, code: 'api_unreachable' });
    await expect(reader({ credentials: '' }).instance.read({ now: moment })).rejects.toMatchObject({ code: 'credentials_missing' });
  });

  it('refuses an answer larger than it will read', async () => {
    const { instance } = reader({ net: network({ api: () => json({ rows: [], padding: 'x'.repeat(5000) }) }), limits: { maxBytes: 1000 } });
    expect((await instance.read({ now: moment })).properties[0].code).toBe('response_invalid');
  });
});
