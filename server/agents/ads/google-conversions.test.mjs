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
const failureOf = (enumValue, kind = 'conversionUploadError') => ({ partialFailureError: { code: 3, message: 'The click identifier Cj0 and secret text',
  details: [{ '@type': 'type.googleapis.com/google.ads.googleads.v26.errors.GoogleAdsFailure', errors: [{ errorCode: { [kind]: enumValue }, message: 'secret text' }] }] }, results: [{}] });

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

describe('a click conversion', () => {
  it('sends the gclid, the time of the lead and the lead\'s id as the order id, and nothing about the person', async () => {
    const fetchImpl = googleFetch({ results: [{ gclid: 'Cj0KCQiA_abc-1', conversionAction: 'customers/3021386768/conversionActions/987654321', conversionDateTime: '2026-11-19 14:20:00+00:00' }] });
    const client = googleAdsClient({ ...credentials, fetchImpl });
    expect(await client.uploadClickConversion({ conversionActionId: '987654321', gclid: 'Cj0KCQiA_abc-1', happenedAt, orderId: leadId })).toEqual({ uploaded: true });
    const [url, init] = fetchImpl.mock.calls.at(-1);
    expect(url).toBe('https://googleads.googleapis.com/v26/customers/3021386768:uploadClickConversions');
    expect(JSON.parse(init.body)).toEqual({ partialFailure: true, conversions: [{ gclid: 'Cj0KCQiA_abc-1', conversionAction: 'customers/3021386768/conversionActions/987654321',
      conversionDateTime: '2026-11-19 14:20:00+00:00', orderId: leadId }] });
  });

  it('reads Google\'s partial failures: already there, not matched yet, or refused, keeping only a fixed code', async () => {
    const upload = answer => googleAdsClient({ ...credentials, fetchImpl: googleFetch(answer) })
      .uploadClickConversion({ conversionActionId: '987654321', gclid: 'Cj0KCQiA_abc-1', happenedAt, orderId: leadId });
    expect(await upload(failureOf('CLICK_CONVERSION_ALREADY_EXISTS'))).toEqual({ uploaded: true, already: true });
    for (const value of ['TOO_RECENT_CONVERSION_ACTION', 'CLICK_NOT_FOUND', 'TOO_RECENT_EVENT']) {
      await expect(upload(failureOf(value))).rejects.toMatchObject({ code: 'google_click_not_ready', retry: true, transient: false });
    }
    const expired = await upload(failureOf('EXPIRED_EVENT')).catch(error => error);
    expect(expired).toMatchObject({ code: 'google_expired_event', reason: 'conversionUploadError.EXPIRED_EVENT' });
    expect(JSON.stringify({ ...expired })).not.toContain('secret');
    await expect(upload(new Response('{}', { status: 403 }))).rejects.toMatchObject({ code: 'google_permission' });
    await expect(upload(new Response('{}', { status: 503 }))).rejects.toMatchObject({ code: 'google_unavailable', transient: true });
    await expect(upload(new Response('{}', { status: 400 }))).rejects.toMatchObject({ code: 'google_query_refused', transient: false });
    // A 200 that confirms nothing is not taken for a sent conversion.
    await expect(upload({ results: [{}] })).rejects.toMatchObject({ code: 'google_unconfirmed' });
    await expect(upload({})).rejects.toMatchObject({ code: 'google_unconfirmed' });
  });

  it('refuses a malformed request before calling Google', async () => {
    const fetchImpl = googleFetch({});
    const client = googleAdsClient({ ...credentials, fetchImpl });
    for (const input of [{ conversionActionId: 'abc', gclid: 'Cj0', happenedAt, orderId: leadId }, { conversionActionId: '9', gclid: 'bad value', happenedAt, orderId: leadId },
      { conversionActionId: '9', gclid: 'Cj0', happenedAt: Number.NaN, orderId: leadId }]) {
      await expect(client.uploadClickConversion(input)).rejects.toMatchObject({ code: 'google_invalid_request' });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(googleAdsClient({ fetchImpl }).uploadClickConversion({ conversionActionId: '9', gclid: 'Cj0', happenedAt, orderId: leadId })).rejects.toMatchObject({ code: 'google_not_configured' });
  });
});

describe('reporting leads to Google', () => {
  const task = { id: 't1', agentKey: 'social_manager', kind: 'ads.conversions', sourceKind: 'schedule', agent: { autonomy: 'act' } };
  const lead = (id, clickIds) => ({ id, kind: 'county_report', email: 'pat@agency.example.org', occurredAt: '2026-11-19T14:20:00Z', firstSeenAt: '2026-11-19T14:00:00Z', clickIds });
  function setup({ action = '987654321', candidates = [], ready = { ready: true }, upload = async () => ({ uploaded: true }) } = {}) {
    const store = { adsConversionCandidates: vi.fn(async platform => (platform === 'google' ? candidates : [])), adsConversionRecord: vi.fn(async () => true) };
    const notifier = { send: vi.fn(async () => [{ channel: 'email', delivery: 'sent' }]) };
    const googleClient = { configured: true, createSearchCampaign: vi.fn(), conversionActionReady: vi.fn(async () => ready), uploadClickConversion: vi.fn(upload) };
    const settings = key => ({ 'ads.server_conversions': true, 'ads.google_conversion_action': action })[key];
    const team = adsTeam({ ads: () => adsConfig({}, settings), features: new Set([adsFeature]), googleClient });
    const handlers = team.handlers({ store, notifier, model: { configured: false }, meta: { configured: { ads: false } }, linkedin: { configured: { ads: false } },
      social: {}, marketed: ['caremetric-intel'], log: () => {} });
    return { store, notifier, googleClient, run: () => handlers['ads.conversions'](task) };
  }

  it('sends a lead with a gclid, marks one without as skipped, and leaves a click Google cannot match yet for the next run', async () => {
    const h = setup({ candidates: [lead('l1', { gclid: 'Cj0KCQiA_one' }), lead('l2', { fbclid: 'IwAR0abc' }), lead('l3', { gclid: 'Cj0KCQiA_three' })],
      upload: async ({ orderId }) => { if (orderId === 'l3') throw Object.assign(new Error('not yet'), { code: 'google_click_not_ready', retry: true }); return { uploaded: true }; } });
    expect((await h.run()).result).toEqual({ sent: 1, skipped: 1, failed: 0, waiting: 1 });
    expect(h.googleClient.conversionActionReady).toHaveBeenCalledTimes(1);
    expect(h.googleClient.uploadClickConversion.mock.calls[0][0]).toEqual({ conversionActionId: '987654321', gclid: 'Cj0KCQiA_one', happenedAt: Date.parse('2026-11-19T14:20:00Z'), orderId: 'l1' });
    expect(JSON.stringify(h.googleClient.uploadClickConversion.mock.calls)).not.toContain('pat@');
    expect(h.store.adsConversionRecord.mock.calls).toEqual([['l1', 'google', 'sent', null], ['l2', 'google', 'skipped', 'no_click']]);
    expect(h.notifier.send).not.toHaveBeenCalled();
  });

  it('records a click Google will not take as failed, and only that lead', async () => {
    const h = setup({ candidates: [lead('l1', { gclid: 'Cj0KCQiA_one' })], upload: async () => { throw Object.assign(new Error('expired'), { code: 'google_expired_event' }); } });
    expect((await h.run()).result).toEqual({ sent: 0, skipped: 0, failed: 1 });
    expect(h.store.adsConversionRecord.mock.calls).toEqual([['l1', 'google', 'failed', 'google_expired_event']]);
  });

  it('stops without marking any lead when the conversion action or the account refuses, and tells the owner once', async () => {
    const unusable = setup({ candidates: [lead('l1', { gclid: 'Cj0KCQiA_one' }), lead('l2', { gclid: 'Cj0KCQiA_two' })], ready: { ready: false, reason: 'not_click_import' } });
    expect((await unusable.run()).result).toEqual({ sent: 0, skipped: 0, failed: 0, stopped: 'not_click_import' });
    expect(unusable.googleClient.uploadClickConversion).not.toHaveBeenCalled();
    expect(unusable.store.adsConversionRecord).not.toHaveBeenCalled();
    expect(unusable.notifier.send).toHaveBeenCalledTimes(1);
    expect(unusable.notifier.send.mock.calls[0][0]).toMatchObject({ severity: 'warning', attention: 'now', dedupeKey: 'ads:conversions:google:not_click_import' });
    expect(unusable.notifier.send.mock.calls[0][0].body).toContain('Track conversions from clicks');

    const refused = setup({ candidates: [lead('l1', { gclid: 'Cj0KCQiA_one' })], upload: async () => { throw Object.assign(new Error('no'), { code: 'google_permission' }); } });
    expect((await refused.run()).result).toEqual({ sent: 0, skipped: 0, failed: 0, stopped: 'google_permission' });
    expect(refused.store.adsConversionRecord).not.toHaveBeenCalled();

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
