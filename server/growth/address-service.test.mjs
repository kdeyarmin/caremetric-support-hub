import { describe, expect, it, vi } from 'vitest';
import { serviceGuesses, withAddressService, zeroBounce, zeroBounceResult } from './address-service.mjs';

const json = body => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

describe('ZeroBounce', () => {
  it('reads only the status: valid confirms, invalid and do-not-mail refuse, a role address is its mailbox, unknown stays unknown', () => {
    expect(zeroBounceResult({ status: 'valid' })).toBe('verified');
    expect(zeroBounceResult({ status: 'invalid', sub_status: 'mailbox_not_found' })).toBe('rejected');
    expect(zeroBounceResult({ status: 'catch-all' })).toBe('catch_all');
    expect(zeroBounceResult({ status: 'unknown', sub_status: 'greylisted' })).toBe('unknown');
    expect(zeroBounceResult({ status: 'spamtrap' })).toBe('rejected');
    expect(zeroBounceResult({ status: 'abuse' })).toBe('rejected');
    expect(zeroBounceResult({ status: 'do_not_mail', sub_status: 'disposable' })).toBe('rejected');
    expect(zeroBounceResult({ status: 'do_not_mail', sub_status: 'role_based' })).toBe('verified');
    expect(zeroBounceResult({ status: 'do_not_mail', sub_status: 'role_based_catch_all' })).toBe('catch_all');
    expect(zeroBounceResult({})).toBe('unknown');
  });

  it('asks one fixed address with the key, never follows a redirect, and keeps the key out of every error', async () => {
    const fetchImpl = vi.fn(async () => json({ address: 'jdoe@valleyhospice.org', status: 'valid', sub_status: '' }));
    const service = zeroBounce({ apiKey: ' zb-secret ', fetchImpl });
    expect(service.configured).toBe(true);
    expect(await service.check('JDoe@ValleyHospice.org')).toEqual({ result: 'verified' });
    const [url, init] = fetchImpl.mock.calls[0];
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe('https://api.zerobounce.net/v2/validate');
    expect(Object.fromEntries(parsed.searchParams)).toEqual({ api_key: 'zb-secret', email: 'jdoe@valleyhospice.org', ip_address: '' });
    expect(init.redirect).toBe('error');
    // A wrong key or no credits answers 200 with an error; a server error is worth trying later; neither carries the key.
    for (const [response, code, transient] of [[json({ error: 'Invalid API key or your account ran out of credits' }), 'service_refused', false],
      [new Response('busy', { status: 503 }), 'service_unavailable', true], [new Response('no', { status: 401 }), 'service_refused', false]]) {
      const error = await zeroBounce({ apiKey: 'zb-secret', fetchImpl: async () => response }).check('jdoe@valleyhospice.org').catch(e => e);
      expect(error).toMatchObject({ code, transient });
      expect(JSON.stringify({ message: error.message, code: error.code })).not.toMatch(/zb-secret/);
    }
    const offline = await zeroBounce({ apiKey: 'zb-secret', fetchImpl: async () => { throw new Error('getaddrinfo api.zerobounce.net?api_key=zb-secret'); } })
      .check('jdoe@valleyhospice.org').catch(e => e);
    expect(offline).toMatchObject({ code: 'service_unavailable', transient: true });
    expect(offline.message).not.toMatch(/zb-secret/);
  });

  it('is not configured without a key, and asks about nothing that is not an address', async () => {
    const fetchImpl = vi.fn();
    expect(zeroBounce({ apiKey: '', fetchImpl }).configured).toBe(false);
    await expect(zeroBounce({ apiKey: '', fetchImpl }).check('jdoe@valleyhospice.org')).rejects.toMatchObject({ code: 'service_not_configured' });
    await expect(zeroBounce({ apiKey: 'k', fetchImpl }).check('not an address\r\nRCPT TO:<x@y.z>')).rejects.toMatchObject({ code: 'service_invalid_address' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('the mail server first, then the verification service', () => {
  const guesses = ['jane.doe@valleyhospice.org', 'jdoe@valleyhospice.org', 'jane@valleyhospice.org', 'janedoe@valleyhospice.org'];
  function setup({ server = { result: 'unknown', reason: 'blocked' }, answers = [], on = true, declared = true, reserve = true, configured = true, available = true } = {}) {
    const mailbox = { configured: true, available: () => available, state: () => 'reachable', check: vi.fn(async () => server) };
    const service = { configured, check: vi.fn(async () => answers.shift() ?? { result: 'unknown' }) };
    const reserved = vi.fn(async () => (typeof reserve === 'function' ? reserve() : reserve));
    const checker = withAddressService({ mailbox, service, enabled: () => on, declared: () => declared, reserve: reserved });
    return { mailbox, service, reserved, checker };
  }

  it('leaves a clear answer from the mail server alone and asks the service nothing', async () => {
    for (const server of [{ result: 'verified', email: 'jdoe@valleyhospice.org' }, { result: 'rejected' }, { result: 'catch_all' },
      { result: 'unknown', reason: 'no_mail' }, { result: 'unknown', reason: 'invalid' }]) {
      const { service, reserved, checker } = setup({ server });
      expect(await checker.check('valleyhospice.org', guesses)).toEqual(server);
      expect(service.check).not.toHaveBeenCalled();
      expect(reserved).not.toHaveBeenCalled();
    }
  });

  it('asks the service, best shape first, when the server refuses the Hub or cannot be reached, one reserved check at a time', async () => {
    const { service, reserved, checker } = setup({ answers: [{ result: 'rejected' }, { result: 'verified' }] });
    expect(await checker.check('valleyhospice.org', guesses)).toEqual({ result: 'verified', email: 'jdoe@valleyhospice.org', via: 'service' });
    expect(service.check.mock.calls.map(([email]) => email)).toEqual(['jane.doe@valleyhospice.org', 'jdoe@valleyhospice.org']);
    expect(reserved).toHaveBeenCalledTimes(2);
    const unreachable = setup({ server: { result: 'unreachable' }, answers: [{ result: 'catch_all' }] });
    expect(await unreachable.checker.check('valleyhospice.org', guesses)).toEqual({ result: 'catch_all', via: 'service' });
    // At most three shapes; every one refused is a refusal from the service.
    const refused = setup({ answers: [{ result: 'rejected' }, { result: 'rejected' }, { result: 'rejected' }, { result: 'verified' }] });
    expect(await refused.checker.check('valleyhospice.org', guesses)).toEqual({ result: 'rejected', via: 'service' });
    expect(refused.service.check).toHaveBeenCalledTimes(serviceGuesses);
  });

  it('keeps the mail server\'s answer when the service cannot tell, is out of checks, fails, or is not switched on', async () => {
    const unknown = setup({ answers: [{ result: 'unknown' }] });
    expect(await unknown.checker.check('valleyhospice.org', guesses)).toEqual({ result: 'unknown', reason: 'blocked', service: 'unknown' });
    const spent = setup({ reserve: false });
    expect(await spent.checker.check('valleyhospice.org', guesses)).toEqual({ result: 'unknown', reason: 'blocked', service: 'daily_limit' });
    expect(spent.service.check).not.toHaveBeenCalled();
    const failing = setup();
    failing.service.check.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'service_refused' }));
    expect(await failing.checker.check('valleyhospice.org', guesses)).toEqual({ result: 'unknown', reason: 'blocked', service: 'service_refused' });
    for (const off of [{ on: false }, { declared: false }, { configured: false }]) {
      const { service, reserved, checker } = setup(off);
      expect(await checker.check('valleyhospice.org', guesses)).toEqual({ result: 'unknown', reason: 'blocked' });
      expect(service.check).not.toHaveBeenCalled();
      expect(reserved).not.toHaveBeenCalled();
    }
  });

  it('never asks the service about an address on another domain, and still answers while the mail servers rest', async () => {
    const { service, checker } = setup({ answers: [{ result: 'verified' }] });
    await checker.check('valleyhospice.org', ['jane@gmail.com', 'JDoe@ValleyHospice.org']);
    expect(service.check.mock.calls.map(([email]) => email)).toEqual(['jdoe@valleyhospice.org']);
    expect(setup({ available: false }).checker.available()).toBe(true);
    expect(setup({ available: false, on: false }).checker.available()).toBe(false);
    expect(setup({ available: true, on: false }).checker.available()).toBe(true);
  });
});
