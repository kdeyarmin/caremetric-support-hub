import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { googleAdsClient } from './google.mjs';
import { adsConfig, adsFeature, adsTeam } from './index.mjs';

// Leads from Google search ads reported to Google (owner request 2026-11-19): the November 18 read-back found auto-tagging on and no
// conversion tracking, so Google could not count a lead its ad brought.
const credentials = { clientId: 'client.apps', clientSecret: 'secret-0123456789', refreshToken: '1//refresh-token-0123456789', customerId: '3021386768' };
const leadId = 'b2b2b2b2-0000-4000-8000-000000000001';
const happenedAt = Date.parse('2026-11-19T14:20:00.123Z');

function googleFetch(answer) {
  return vi.fn(async (url, init) => {
    if (String(url).includes('oauth2')) return new Response(JSON.stringify({ access_token: 'ya29.token' }));
    const value = typeof answer === 'function' ? answer(url, init) : answer;
    return value instanceof Response ? value : new Response(JSON.stringify(value));
  });
}
// A refusal from the Data Manager API, in Google's error model: the message carries text the Hub must never keep.
const refusalOf = (status, httpStatus, details) => new Response(JSON.stringify({ error: { code: httpStatus, status, message: 'The click identifier Cj0 and secret text', details } }), { status: httpStatus });
const errorInfo = reason => ({ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason, domain: 'googleapis.com', metadata: { consumer: 'projects/secret-project' } });

describe('the conversion action', () => {
  it('is ready only when it is an enabled import of conversions from clicks', async () => {
    const answers = [
      [{ results: [{ conversionAction: { id: '987654321', type: 'UPLOAD_CLICKS', status: 'ENABLED' } }] }, { ready: true }],
      [{ results: [] }, { ready: false, reason: 'missing' }],
      [{ results: [{ conversionAction: { id: '987654321', type: 'UPLOAD_CLICKS', status: 'REMOVED' } }] }, { ready: false, reason: 'not_enabled' }],
      [{ results: [{ conversionAction: { id: '987654321', type: 'WEBPAGE', status: 'ENABLED' } }] }, { ready: false, reason: 'not_click_import' }],
    ];
    for (const [answer, expected] of answers) {
      const fetchImpl = googleFetch(answer);
      expect(await googleAdsClient({ ...credentials, fetchImpl }).conversionActionReady('987654321')).toEqual(expected);
      const [url, init] = fetchImpl.mock.calls.find(([address]) => String(address).endsWith('googleAds:search'));
      expect(url).toBe('https://googleads.googleapis.com/v26/customers/3021386768/googleAds:search');
      expect(JSON.parse(init.body).query).toBe('SELECT conversion_action.id, conversion_action.type, conversion_action.status FROM conversion_action WHERE conversion_action.id = 987654321');
    }
    await expect(googleAdsClient({ ...credentials, fetchImpl: googleFetch({}) }).conversionActionReady('98765 OR 1=1')).rejects.toMatchObject({ code: 'google_invalid_request' });
  });
});

// Review 2026-11-20: the Google Ads API refused the first lead (CUSTOMER_NOT_ALLOWLISTED_FOR_THIS_FEATURE: since June 15, 2026 it takes no
// new adopters of offline conversions), so the click conversion goes through Google's Data Manager API.
describe('a click conversion', () => {
  it('sends the gclid, the time of the lead and the lead\'s id as the transaction id to the Data Manager API, and nothing about the person', async () => {
    const fetchImpl = googleFetch({ requestId: 'req-7f3a' });
    const client = googleAdsClient({ ...credentials, fetchImpl });
    expect(await client.sendClickConversion({ conversionActionId: '987654321', gclid: 'Cj0KCQiA_abc-1', happenedAt, transactionId: leadId })).toEqual({ accepted: true });
    const [url, init] = fetchImpl.mock.calls.at(-1);
    expect(url).toBe('https://datamanager.googleapis.com/v1/events:ingest');
    expect(init.method).toBe('POST');
    expect(init.headers).not.toHaveProperty('developer-token');
    expect(JSON.parse(init.body)).toEqual({
      destinations: [{ operatingAccount: { accountType: 'GOOGLE_ADS', accountId: '3021386768' }, productDestinationId: '987654321' }],
      events: [{ adIdentifiers: { gclid: 'Cj0KCQiA_abc-1' }, eventTimestamp: '2026-11-19T14:20:00.123Z', transactionId: leadId, eventSource: 'WEB' }],
    });
    // Through the manager account when one is set, as the Google Ads API calls sign in.
    const managed = googleFetch({ requestId: 'req-7f3b' });
    await googleAdsClient({ ...credentials, loginCustomerId: '1112223333', fetchImpl: managed })
      .sendClickConversion({ conversionActionId: '987654321', gclid: 'Cj0KCQiA_abc-1', happenedAt, transactionId: leadId });
    expect(JSON.parse(managed.mock.calls.at(-1)[1].body).destinations[0].loginAccount).toEqual({ accountType: 'GOOGLE_ADS', accountId: '1112223333' });
  });

  it('asks for the Data Manager scope when it signs in as the service account', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const serviceAccount = JSON.stringify({ type: 'service_account', client_email: 'hub@project.iam.gserviceaccount.com',
      private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }), token_uri: 'https://oauth2.googleapis.com/token' });
    const fetchImpl = googleFetch({ requestId: 'req-7f3c' });
    const client = googleAdsClient({ serviceAccount, customerId: '3021386768', fetchImpl });
    expect(client.auth).toBe('service_account');
    await client.sendClickConversion({ conversionActionId: '987654321', gclid: 'Cj0KCQiA_abc-1', happenedAt, transactionId: leadId });
    const assertion = new URLSearchParams(fetchImpl.mock.calls[0][1].body).get('assertion');
    expect(JSON.parse(Buffer.from(assertion.split('.')[1], 'base64url').toString()).scope).toBe('https://www.googleapis.com/auth/datamanager');
  });

  it('reads the Data Manager API\'s refusals, keeping only a fixed code and Google\'s reason', async () => {
    const send = answer => googleAdsClient({ ...credentials, fetchImpl: googleFetch(answer) })
      .sendClickConversion({ conversionActionId: '987654321', gclid: 'Cj0KCQiA_abc-1', happenedAt, transactionId: leadId });
    await expect(send(refusalOf('PERMISSION_DENIED', 403, [errorInfo('SERVICE_DISABLED')]))).rejects.toMatchObject({ code: 'google_datamanager_disabled', reason: 'SERVICE_DISABLED', transient: false });
    await expect(send(refusalOf('PERMISSION_DENIED', 403, [errorInfo('ACCESS_TOKEN_SCOPE_INSUFFICIENT')]))).rejects.toMatchObject({ code: 'google_datamanager_scope' });
    await expect(send(refusalOf('PERMISSION_DENIED', 403, []))).rejects.toMatchObject({ code: 'google_permission', reason: 'PERMISSION_DENIED' });
    await expect(send(refusalOf('UNAUTHENTICATED', 401, []))).rejects.toMatchObject({ code: 'google_permission' });
    const malformed = await send(refusalOf('INVALID_ARGUMENT', 400, [{ ...errorInfo('INVALID_ARGUMENT'), domain: 'datamanager.googleapis.com' },
      { '@type': 'type.googleapis.com/google.rpc.BadRequest', fieldViolations: [{ field: 'destinations[0].login_account.account_id', description: 'secret text', reason: 'INVALID_NUMBER_FORMAT' }] }])).catch(error => error);
    expect(malformed).toMatchObject({ code: 'google_request_refused', reason: 'INVALID_NUMBER_FORMAT', transient: false });
    expect(JSON.stringify({ ...malformed })).not.toMatch(/secret|login_account/);
    await expect(send(refusalOf('RESOURCE_EXHAUSTED', 429, [errorInfo('RATE_LIMIT_EXCEEDED')]))).rejects.toMatchObject({ code: 'google_unavailable', transient: true });
    await expect(send(new Response('{}', { status: 503 }))).rejects.toMatchObject({ code: 'google_unavailable', transient: true });
    // A 200 without the request's id confirms nothing, and is not taken for a sent conversion.
    await expect(send({})).rejects.toMatchObject({ code: 'google_unconfirmed' });
    await expect(send({ requestId: '' })).rejects.toMatchObject({ code: 'google_unconfirmed' });
  });

  it('refuses a malformed request before calling Google', async () => {
    const fetchImpl = googleFetch({});
    const client = googleAdsClient({ ...credentials, fetchImpl });
    for (const input of [{ conversionActionId: 'abc', gclid: 'Cj0', happenedAt, transactionId: leadId }, { conversionActionId: '9', gclid: 'bad value', happenedAt, transactionId: leadId },
      { conversionActionId: '9', gclid: 'Cj0', happenedAt: Number.NaN, transactionId: leadId }, { conversionActionId: '9', gclid: 'Cj0', happenedAt, transactionId: 'a b' }]) {
      await expect(client.sendClickConversion(input)).rejects.toMatchObject({ code: 'google_invalid_request' });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(googleAdsClient({ fetchImpl }).sendClickConversion({ conversionActionId: '9', gclid: 'Cj0', happenedAt, transactionId: leadId })).rejects.toMatchObject({ code: 'google_not_configured' });
  });
});

describe('reporting leads to Google', () => {
  const task = { id: 't1', agentKey: 'social_manager', kind: 'ads.conversions', sourceKind: 'schedule', agent: { autonomy: 'act' } };
  const lead = (id, clickIds) => ({ id, kind: 'county_report', email: 'pat@agency.example.org', occurredAt: '2026-11-19T14:20:00Z', firstSeenAt: '2026-11-19T14:00:00Z', clickIds });
  function setup({ action = '987654321', candidates = [], ready = { ready: true }, upload = async () => ({ accepted: true }) } = {}) {
    const store = { adsConversionCandidates: vi.fn(async platform => (platform === 'google' ? candidates : [])), adsConversionRecord: vi.fn(async () => true) };
    const notifier = { send: vi.fn(async () => [{ channel: 'email', delivery: 'sent' }]) };
    const googleClient = { configured: true, createSearchCampaign: vi.fn(), conversionActionReady: vi.fn(async () => ready), sendClickConversion: vi.fn(upload) };
    const settings = key => ({ 'ads.server_conversions': true, 'ads.google_conversion_action': action })[key];
    const team = adsTeam({ ads: () => adsConfig({}, settings), features: new Set([adsFeature]), googleClient });
    const handlers = team.handlers({ store, notifier, model: { configured: false }, meta: { configured: { ads: false } }, linkedin: { configured: { ads: false } },
      social: {}, marketed: ['caremetric-intel'], log: () => {} });
    return { store, notifier, googleClient, run: () => handlers['ads.conversions'](task) };
  }

  it('sends a lead with a gclid, marks one without as skipped, and leaves an answer that confirms nothing for the next run', async () => {
    const h = setup({ candidates: [lead('l1', { gclid: 'Cj0KCQiA_one' }), lead('l2', { fbclid: 'IwAR0abc' }), lead('l3', { gclid: 'Cj0KCQiA_three' })],
      upload: async ({ transactionId }) => { if (transactionId === 'l3') throw Object.assign(new Error('no id'), { code: 'google_unconfirmed' }); return { accepted: true }; } });
    expect((await h.run()).result).toEqual({ sent: 1, skipped: 1, failed: 0, waiting: 1 });
    expect(h.googleClient.conversionActionReady).toHaveBeenCalledTimes(1);
    expect(h.googleClient.sendClickConversion.mock.calls[0][0]).toEqual({ conversionActionId: '987654321', gclid: 'Cj0KCQiA_one', happenedAt: Date.parse('2026-11-19T14:20:00Z'), transactionId: 'l1' });
    expect(JSON.stringify(h.googleClient.sendClickConversion.mock.calls)).not.toContain('pat@');
    expect(h.store.adsConversionRecord.mock.calls).toEqual([['l1', 'google', 'sent', null], ['l2', 'google', 'skipped', 'no_click']]);
    expect(h.notifier.send).not.toHaveBeenCalled();
  });

  it('records a lead that cannot be sent (a malformed click ID) as failed, and only that lead', async () => {
    const h = setup({ candidates: [lead('l1', { gclid: 'Cj0KCQiA_one' })], upload: async () => { throw Object.assign(new Error('malformed'), { code: 'google_invalid_request' }); } });
    expect((await h.run()).result).toEqual({ sent: 0, skipped: 0, failed: 1 });
    expect(h.store.adsConversionRecord.mock.calls).toEqual([['l1', 'google', 'failed', 'google_invalid_request']]);
  });

  it('stops without marking any lead when the conversion action or the account refuses, and tells the owner once', async () => {
    const unusable = setup({ candidates: [lead('l1', { gclid: 'Cj0KCQiA_one' }), lead('l2', { gclid: 'Cj0KCQiA_two' })], ready: { ready: false, reason: 'not_click_import' } });
    expect((await unusable.run()).result).toEqual({ sent: 0, skipped: 0, failed: 0, stopped: 'not_click_import' });
    expect(unusable.googleClient.sendClickConversion).not.toHaveBeenCalled();
    expect(unusable.store.adsConversionRecord).not.toHaveBeenCalled();
    expect(unusable.notifier.send).toHaveBeenCalledTimes(1);
    expect(unusable.notifier.send.mock.calls[0][0]).toMatchObject({ severity: 'warning', attention: 'now', dedupeKey: 'ads:conversions:google:not_click_import' });
    expect(unusable.notifier.send.mock.calls[0][0].body).toContain('Track conversions from clicks');

    const refused = setup({ candidates: [lead('l1', { gclid: 'Cj0KCQiA_one' })], upload: async () => { throw Object.assign(new Error('no'), { code: 'google_permission' }); } });
    expect((await refused.run()).result).toEqual({ sent: 0, skipped: 0, failed: 0, stopped: 'google_permission' });
    expect(refused.store.adsConversionRecord).not.toHaveBeenCalled();

    // Review 2026-11-20: the Data Manager API not enabled, a sign-in without its scope, or a request Google calls malformed stops the run
    // the same way, and the owner reads what to do and Google's reason.
    for (const [code, reason, words] of [['google_datamanager_disabled', 'SERVICE_DISABLED', 'enable the Data Manager API'],
      ['google_datamanager_scope', 'ACCESS_TOKEN_SCOPE_INSUFFICIENT', 'auth/datamanager'], ['google_request_refused', 'INVALID_NUMBER_FORMAT', 'fault in the Hub']]) {
      const stopped = setup({ candidates: [lead('l1', { gclid: 'Cj0KCQiA_one' })], upload: async () => { throw Object.assign(new Error('no'), { code, reason }); } });
      expect((await stopped.run()).result).toEqual({ sent: 0, skipped: 0, failed: 0, stopped: code });
      expect(stopped.store.adsConversionRecord).not.toHaveBeenCalled();
      const notice = stopped.notifier.send.mock.calls[0][0];
      expect(notice).toMatchObject({ severity: 'warning', dedupeKey: `ads:conversions:google:${code}` });
      expect(notice.body).toContain(words);
      expect(notice.body).toContain(`Google's reason: ${reason}.`);
    }

    // Google unreachable: the run is tried again, and nothing is marked.
    const down = setup({ candidates: [lead('l1', { gclid: 'Cj0KCQiA_one' })], upload: async () => { throw Object.assign(new Error('down'), { code: 'google_unavailable', transient: true }); } });
    await expect(down.run()).rejects.toMatchObject({ code: 'google_unavailable' });
    expect(down.store.adsConversionRecord).not.toHaveBeenCalled();
  });

  it('touches nothing at Google until the conversion action id is set, and checks nothing when no lead has a gclid', async () => {
    const off = setup({ action: null, candidates: [lead('l1', { gclid: 'Cj0KCQiA_one' })] });
    expect((await off.run()).result).toEqual({ sent: 0, skipped: 0, failed: 0 });
    expect(off.store.adsConversionCandidates).not.toHaveBeenCalledWith('google', expect.anything());
    const quiet = setup({ candidates: [lead('l2', { fbclid: 'IwAR0abc' })] });
    await quiet.run();
    expect(quiet.googleClient.conversionActionReady).not.toHaveBeenCalled();
  });
});
