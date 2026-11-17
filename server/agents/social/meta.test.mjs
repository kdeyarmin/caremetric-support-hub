import { describe, expect, it, vi } from 'vitest';
import { metaClient } from './meta.mjs';

const token = 'EAAG-system-user-token-0123456789';
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const route = handlers => vi.fn(async (url, init = {}) => {
  const parsed = new URL(url);
  const params = init.body ? new URLSearchParams(init.body) : parsed.searchParams;
  for (const [pattern, reply] of handlers) if (pattern.test(`${init.method ?? 'GET'} ${parsed.pathname}`)) return typeof reply === 'function' ? reply(parsed, params) : reply instanceof Response ? reply.clone() : json(reply);
  return json({ error: { code: 100, message: 'unknown path' } }, 400);
});
const client = (fetchImpl, over = {}) => metaClient({ token, pageId: '1111', instagramId: '2222', adAccountId: 'act_3333', fetchImpl, ...over });

describe('the Meta client', () => {
  it.each(['facebook', 'instagram'])('stages %s video, reads processing and publishes only on a separate call', async platform => {
    const fetchImpl = route([
      [/^GET \/v23\.0\/1111$/, { access_token: 'EAAG-page-token-abcdefghijklmnop' }],
      [/^POST \/v23\.0\/(1111\/videos|2222\/media)$/, (url, params) => {
        expect(params.get(platform === 'facebook' ? 'file_url' : 'video_url')).toMatch(/\/api\/creative\/a\/[f]{64}\.mp4$/);
        if (platform === 'facebook') { expect(url.host).toBe('graph-video.facebook.com'); expect(params.get('published')).toBe('false'); }
        else expect(params.get('media_type')).toBe('REELS');
        return json({ id: '900' });
      }],
      [/^GET \/v23\.0\/900$/, { status: { video_status: 'ready' }, status_code: 'FINISHED' }],
      [/^POST \/v23\.0\/900$/, (url, params) => { expect(params.get('published')).toBe('true'); return json({ success: true }); }],
      [/^POST \/v23\.0\/2222\/media_publish$/, (url, params) => { expect(params.get('creation_id')).toBe('900'); return json({ id: '901' }); }],
    ]);
    const meta = client(fetchImpl);
    const staged = await meta.prepareVideo({ platform, videoUrl: `https://help.caremetric.ai/api/creative/a/${'f'.repeat(64)}.mp4`, message: 'Territory planning.' });
    expect(staged).toEqual({ id: '900' });
    expect(fetchImpl.mock.calls.some(([url]) => String(url).includes('media_publish'))).toBe(false);
    expect(await meta.readVideo(staged.id, { platform })).toEqual({ ready: true, failed: false });
    expect(await meta.publishVideo({ platform, videoId: staged.id, message: 'Territory planning.' })).toEqual({ id: platform === 'facebook' ? '900' : '901' });
  });

  it('treats unfinished/failed video processing separately and never retries an uncertain publish', async () => {
    const fetchImpl = route([[/GET/, { status_code: 'IN_PROGRESS' }], [/POST/, json({}, 200)]]);
    const meta = client(fetchImpl);
    expect(await meta.readVideo('900', { platform: 'instagram' })).toEqual({ ready: false, failed: false });
    await expect(meta.publishVideo({ platform: 'instagram', videoId: '900', message: 'A post' })).rejects.toMatchObject({ code: 'meta_unconfirmed' });
    expect(fetchImpl.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
    expect(await client(route([[/GET/, { status_code: 'ERROR' }]])).readVideo('900', { platform: 'instagram' })).toEqual({ ready: false, failed: true });
    await expect(client(route([[/POST/, json({ error: { code: 2 } }, 503)]])).publishVideo({ platform: 'instagram', videoId: '900' })).rejects.toMatchObject({ code: 'meta_unconfirmed' });
    await expect(meta.prepareVideo({ platform: 'instagram', videoUrl: 'https://example.org/random.mp4' })).rejects.toMatchObject({ code: 'meta_invalid_request' });
  });
  it('knows what is connected, from valid ids and a token only', () => {
    expect(client(vi.fn()).configured).toEqual({ pages: true, instagram: true, ads: true });
    expect(metaClient({ token, pageId: '1111' }).configured).toEqual({ pages: true, instagram: false, ads: false });
    expect(metaClient({ token: '', pageId: '1111', adAccountId: '3333' }).configured).toEqual({ pages: false, instagram: false, ads: false });
    expect(metaClient({ token, pageId: '../me', adAccountId: 'act_x' }).configured).toEqual({ pages: false, instagram: false, ads: false });
  });

  it('publishes a story: an Instagram STORIES container, or a Page photo uploaded unpublished and posted as a photo story', async () => {
    const fetchImpl = route([
      [/^GET \/v23\.0\/1111$/, { access_token: 'EAAG-page-token-abcdefghijklmnop' }],
      [/^POST \/v23\.0\/2222\/media$/, (url, params) => json({ id: params.get('media_type') === 'STORIES' && params.get('image_url') ? 'c1' : 'wrong' })],
      [/^POST \/v23\.0\/2222\/media_publish$/, (url, params) => json({ id: params.get('creation_id') === 'c1' ? '1790000' : 'wrong' })],
      [/^POST \/v23\.0\/1111\/photos$/, (url, params) => json({ id: params.get('published') === 'false' && params.get('url') ? 'p1' : 'wrong' })],
      [/^POST \/v23\.0\/1111\/photo_stories$/, (url, params) => json({ success: true, post_id: params.get('photo_id') === 'p1' ? '1111_55' : 'wrong' })],
    ]);
    const meta = client(fetchImpl);
    expect(await meta.publishStory({ platform: 'instagram', imageUrl: 'https://help.caremetric.ai/api/creative/a/x.png' })).toEqual({ id: '1790000' });
    expect(await meta.publishStory({ platform: 'facebook', imageUrl: 'https://help.caremetric.ai/api/creative/a/x.png' })).toEqual({ id: '1111_55' });
    await expect(meta.publishStory({ platform: 'linkedin', imageUrl: 'https://x.test/a.png' })).rejects.toMatchObject({ code: 'meta_invalid_request' });
  });

  it('calls only graph.facebook.com, posts with the Page\'s own token, and never puts a token in an error', async () => {
    const fetchImpl = route([
      [/^GET \/v23\.0\/1111$/, { access_token: 'EAAG-page-token-abcdefghijklmnop' }],
      [/^POST \/v23\.0\/1111\/feed$/, (url, params) => json({ id: '1111_99', echo: params.get('access_token') })],
    ]);
    const meta = client(fetchImpl);
    expect(await meta.publishPost({ platform: 'facebook', message: 'Hello', link: 'https://cmcarebase.com/signup' })).toEqual({ id: '1111_99' });
    const [url, init] = fetchImpl.mock.calls[1];
    expect(new URL(url).host).toBe('graph.facebook.com');
    expect(new URLSearchParams(init.body).get('access_token')).toBe('EAAG-page-token-abcdefghijklmnop');
    expect(init.redirect).toBe('error');
    const failing = client(route([[/./, json({ error: { code: 190, message: `bad ${token}` } }, 401)]]));
    const error = await failing.recentPosts().catch(caught => caught);
    expect(error).toMatchObject({ code: 'meta_token_invalid' });
    expect(JSON.stringify({ message: error.message, code: error.code })).not.toContain(token);
  });

  it('maps Meta errors to codes the Team screen shows, retrying only the transient ones', async () => {
    for (const [body, status, code, transient] of [[{ error: { code: 4 } }, 400, 'meta_rate_limited', true], [{ error: { code: 200 } }, 403, 'meta_permission', false],
      [{ error: { code: 1 } }, 500, 'meta_unavailable', true], [{ error: { code: 100 } }, 400, 'meta_invalid_request', false]]) {
      await expect(client(route([[/./, json(body, status)]])).adsOverview()).rejects.toMatchObject({ code, transient });
    }
    const lost = client(vi.fn(async (url, init) => { if (init.method === 'POST') throw new TypeError('socket hang up'); return json({ access_token: 'EAAG-page-token-abcdefghijklmnop' }); }));
    await expect(lost.publishPost({ platform: 'facebook', message: 'Hi' })).rejects.toMatchObject({ code: 'meta_unconfirmed', transient: false });
  });

  it('finds other people\'s recent comments and messages, by id only, and leaves out the Page\'s own', async () => {
    const now = new Date('2026-11-08T15:00:00Z');
    const meta = client(route([
      [/^GET \/v23\.0\/1111$/, { access_token: 'EAAG-page-token-abcdefghijklmnop' }],
      [/^GET \/v23\.0\/1111\/feed$/, { data: [{ id: '1111_1', permalink_url: 'https://facebook.com/p/1', comments: { data: [
        { id: '1_10', created_time: '2026-11-08T14:00:00Z', from: { id: '5555' }, permalink_url: 'https://facebook.com/c/10', message: 'NOT REQUESTED' },
        { id: '1_11', created_time: '2026-11-08T14:10:00Z', from: { id: '1111' } },
        { id: '1_12', created_time: '2026-11-01T14:10:00Z', from: { id: '5556' } },
      ] } }] }],
      [/^GET \/v23\.0\/1111\/conversations$/, { data: [{ id: 't_1', messages: { data: [{ id: 'm_1', from: { id: '7777' }, created_time: '2026-11-08T13:00:00Z' }] } },
        { id: 't_2', messages: { data: [{ id: 'm_2', from: { id: '1111' }, created_time: '2026-11-08T13:00:00Z' }] } }] }],
      [/^GET \/v23\.0\/2222\/media$/, { data: [{ id: '20', permalink: 'https://instagram.com/p/20', comments: { data: [{ id: '30', timestamp: '2026-11-08T12:00:00Z', from: { id: '8888' } }] } }] }],
    ]));
    const items = await meta.recentInbox({ now });
    expect(items).toEqual([
      { platform: 'facebook', kind: 'comment', id: '1_10', parentId: '1111_1', url: 'https://facebook.com/c/10', at: '2026-11-08T14:00:00.000Z' },
      { platform: 'messenger', kind: 'message', id: 'm_1', parentId: 't_1', url: null, at: '2026-11-08T13:00:00.000Z' },
      { platform: 'instagram', kind: 'comment', id: '30', parentId: '20', url: 'https://instagram.com/p/20', at: '2026-11-08T12:00:00.000Z' },
    ]);
    expect(JSON.stringify(items)).not.toContain('NOT REQUESTED');
  });

  it('reads a comment or message when it is handled: whether the Page answered, and whether the reply window is open', async () => {
    const meta = client(route([
      [/^GET \/v23\.0\/1111$/, { access_token: 'EAAG-page-token-abcdefghijklmnop' }],
      [/^GET \/v23\.0\/1_10$/, { message: 'How much is it?', from: { id: '5555' }, comments: { data: [{ from: { id: '1111' } }] } }],
      [/^GET \/v23\.0\/t_1$/, { messages: { data: [{ id: 'm_3', message: 'Thanks!', from: { id: '7777' }, created_time: '2026-11-08T14:30:00Z' }, { id: 'm_2', message: 'Hi there', from: { id: '1111' }, created_time: '2026-11-08T14:00:00Z' }] } }],
    ]));
    expect(await meta.readItem({ platform: 'facebook', kind: 'comment', id: '1_10' })).toMatchObject({ text: 'How much is it?', fromPage: false, answered: true });
    const message = await meta.readItem({ platform: 'messenger', kind: 'message', id: 'm_3', parentId: 't_1' }, { now: new Date('2026-11-08T15:00:00Z') });
    expect(message).toMatchObject({ text: 'Thanks!', answered: false, open: true, recipient: '7777', history: [{ direction: 'outbound', text: 'Hi there' }] });
    expect((await meta.readItem({ platform: 'messenger', kind: 'message', id: 'm_3', parentId: 't_1' }, { now: new Date('2026-11-10T15:00:00Z') })).open).toBe(false);
    expect((await meta.readItem({ platform: 'messenger', kind: 'message', id: 'm_1', parentId: 't_1' })).answered).toBe(true);
  });

  it('reads the ad account into ad sets, ads with their copy and two weeks of results', async () => {
    const meta = client(route([
      [/\/adsets$/, { data: [{ id: '40', name: 'PA operators', effective_status: 'ACTIVE', daily_budget: '2500', campaign: { name: 'Trials', objective: 'OUTCOME_LEADS' } }] }],
      [/\/ads$/, { data: [{ id: '50', name: 'Training', adset_id: '40', effective_status: 'ACTIVE', created_time: '2026-10-01T00:00:00Z',
        creative: { id: '60', object_story_spec: { link_data: { message: 'Track training', name: 'Start free', description: '30-day trial', link: 'https://cmcarebase.com/signup', image_hash: 'abc' } } } }] }],
      [/\/insights$/, (url, params) => json({ data: [{ ad_id: '50', impressions: '2000', inline_link_clicks: '40', spend: '25.50', frequency: '1.8', actions: [{ action_type: 'lead', value: '3' }, { action_type: 'link_click', value: '40' }] }], window: params.get('time_range') })],
    ]));
    const overview = await meta.adsOverview({ now: new Date('2026-11-08T15:00:00Z') });
    expect(overview.adsets).toEqual([{ id: '40', name: 'PA operators', active: true, dailyBudget: 2500, objective: 'OUTCOME_LEADS', campaign: 'Trials' }]);
    expect(overview.ads[0]).toMatchObject({ id: '50', adsetId: '40', active: true, imageHash: 'abc', copy: { message: 'Track training', headline: 'Start free', link: 'https://cmcarebase.com/signup' } });
    expect(overview.current).toEqual([{ adId: '50', impressions: 2000, clicks: 40, spendCents: 2550, frequency: 1.8, results: 3 }]);
  });
});

describe('new campaigns and lead reports', () => {
  it('creates a paused traffic campaign and a paused ad set for the retargeting audience, and reports a lead by hash and click', async () => {
    const seen = [];
    const fetchImpl = vi.fn(async (url, init) => {
      const path = new URL(url).pathname;
      const params = new URLSearchParams(init.body);
      seen.push([path, params]);
      return new Response(JSON.stringify(path.endsWith('/campaigns') ? { id: '601' } : path.endsWith('/adsets') ? { id: '602' } : { events_received: 1 }), { status: 200 });
    });
    const meta = client(fetchImpl);
    expect(await meta.createCampaign({ name: 'Intel retargeting', dailyBudgetCents: 3000, audienceId: '1234567' })).toEqual({ campaignId: '601', adsetId: '602' });
    expect(Object.fromEntries(seen[0][1])).toMatchObject({ objective: 'OUTCOME_TRAFFIC', status: 'PAUSED', special_ad_categories: '[]' });
    expect(Object.fromEntries(seen[1][1])).toMatchObject({ campaign_id: '601', status: 'PAUSED', daily_budget: '3000' });
    expect(JSON.parse(seen[1][1].get('targeting')).custom_audiences).toEqual([{ id: '1234567' }]);
    await expect(meta.createCampaign({ name: 'x', dailyBudgetCents: 3000, audienceId: 'none' })).rejects.toMatchObject({ code: 'meta_invalid_request' });
    const hash = 'a'.repeat(64);
    expect(await meta.sendConversion({ pixelId: '7654321', eventName: 'Lead', eventId: 'l1', eventTime: 1794225600, emailHash: hash, fbclid: 'IwAR0abc', clickedAt: 1794139200000 })).toEqual({ received: 1 });
    expect(seen[2][0]).toBe('/v23.0/7654321/events');
    expect(JSON.parse(seen[2][1].get('data'))[0]).toEqual({ event_name: 'Lead', event_time: 1794225600, event_id: 'l1', action_source: 'website',
      user_data: { em: [hash], fbc: 'fb.1.1794139200000.IwAR0abc' } });
  });

  it('ends the ad set of a campaign the owner handed over with its month, and starts the ad set then the campaign once its ad is in', async () => {
    const seen = [];
    const fetchImpl = vi.fn(async (url, init) => {
      const path = new URL(url).pathname;
      seen.push([path, new URLSearchParams(init.body)]);
      return new Response(JSON.stringify(path.endsWith('/campaigns') ? { id: '601' } : path.endsWith('/adsets') ? { id: '602' } : { success: true }), { status: 200 });
    });
    const meta = client(fetchImpl);
    const endAt = '2099-12-01T04:59:59.000Z';
    expect(await meta.createCampaign({ name: 'Intel retargeting', dailyBudgetCents: 1500, audienceId: '1234567', endAt })).toEqual({ campaignId: '601', adsetId: '602' });
    expect(Object.fromEntries(seen[1][1])).toMatchObject({ status: 'PAUSED', daily_budget: '1500', end_time: '4099784399' });
    expect(seen[0][1].get('status')).toBe('PAUSED');
    await expect(meta.createCampaign({ name: 'x', dailyBudgetCents: 1500, audienceId: '1234567', endAt: '2020-01-01T00:00:00Z' })).rejects.toMatchObject({ code: 'meta_invalid_request' });
    expect(await meta.startCampaign({ campaignId: '601', adsetId: '602' })).toEqual({ started: true });
    expect(seen.slice(2).map(([path, params]) => [path, params.get('status')])).toEqual([['/v23.0/602', 'ACTIVE'], ['/v23.0/601', 'ACTIVE']]);
    await expect(meta.startCampaign({ campaignId: 'act_1', adsetId: '602' })).rejects.toMatchObject({ code: 'meta_invalid_request' });
    expect(seen).toHaveLength(4);
  });
});

describe('reach outside cold email (team review 2026-11-17, stage 6)', () => {
  it('posts a Facebook post with an approved image as a Page photo whose caption carries the link', async () => {
    const fetchImpl = route([
      [/^GET \/v23\.0\/1111$/, { access_token: 'EAAG-page-token-abcdefghijklmnop' }],
      [/^POST \/v23\.0\/1111\/photos$/, (url, params) => {
        expect(params.get('url')).toBe('https://help.caremetric.ai/api/creative/a/x.png');
        expect(params.get('message')).toContain('https://cmcarebase.com/?utm_content=post-1');
        expect(params.get('published')).toBe('true');
        return json({ id: '77', post_id: '1111_77' });
      }],
    ]);
    const posted = await client(fetchImpl).publishPost({ platform: 'facebook', message: 'Training hours. https://cmcarebase.com/?utm_content=post-1', link: 'https://cmcarebase.com/?utm_content=post-1', imageUrl: 'https://help.caremetric.ai/api/creative/a/x.png' });
    expect(posted).toEqual({ id: '1111_77' });
    expect(fetchImpl.mock.calls.some(([url]) => new URL(url).pathname.endsWith('/feed'))).toBe(false);
    await expect(client(fetchImpl).publishPost({ platform: 'facebook', message: 'x', imageUrl: 'http://example.org/x.png' })).rejects.toMatchObject({ code: 'meta_invalid_request' });
  });

  it('reads comments on running ads only when asked, marked as on an ad, and lists a comment once', async () => {
    const now = new Date('2026-11-08T15:00:00Z');
    const handlers = [
      [/^GET \/v23\.0\/1111$/, { access_token: 'EAAG-page-token-abcdefghijklmnop' }],
      [/^GET \/v23\.0\/act_3333\/ads$/, { data: [{ id: 'a1', creative: { effective_object_story_id: '1111_9' } }, { id: 'a2', creative: { effective_object_story_id: '1111_9' } }, { id: 'a3', creative: {} }] }],
      [/^GET \/v23\.0\/1111_9\/comments$/, { data: [
        { id: '9_1', created_time: '2026-11-08T14:00:00Z', from: { id: '5555' }, permalink_url: 'https://facebook.com/c/91', message: 'NOT REQUESTED' },
        { id: '9_2', created_time: '2026-11-08T14:05:00Z', from: { id: '1111' } },
      ] }],
      [/^GET \/v23\.0\/1111\/feed$/, { data: [{ id: '1111_9', comments: { data: [{ id: '9_1', created_time: '2026-11-08T14:00:00Z', from: { id: '5555' } }] } }] }],
      [/^GET \/v23\.0\/1111\/conversations$/, { data: [] }],
      [/^GET \/v23\.0\/2222\/media$/, { data: [] }],
    ];
    const fetchImpl = route(handlers);
    const items = await client(fetchImpl).recentInbox({ now, adComments: true });
    expect(items).toEqual([{ platform: 'facebook', kind: 'comment', id: '9_1', parentId: '1111_9', url: 'https://facebook.com/c/91', at: '2026-11-08T14:00:00.000Z', ad: true }]);
    expect(fetchImpl.mock.calls.filter(([url]) => new URL(url).pathname.endsWith('/1111_9/comments'))).toHaveLength(1);
    expect(JSON.stringify(items)).not.toContain('NOT REQUESTED');
    const off = route(handlers);
    expect(await client(off).recentInbox({ now })).toEqual([{ platform: 'facebook', kind: 'comment', id: '9_1', parentId: '1111_9', url: null, at: '2026-11-08T14:00:00.000Z' }]);
    expect(off.mock.calls.some(([url]) => new URL(url).pathname.endsWith('/ads'))).toBe(false);
  });

  it('still reads the Page, Messenger and Instagram when Meta refuses the ads read, and stops only when the run is aborted', async () => {
    const now = new Date('2026-11-08T15:00:00Z');
    const handlers = [
      [/^GET \/v23\.0\/1111$/, { access_token: 'EAAG-page-token-abcdefghijklmnop' }],
      [/^GET \/v23\.0\/act_3333\/ads$/, json({ error: { code: 200, type: 'OAuthException', message: 'Requires ads_read permission' } }, 403)],
      [/^GET \/v23\.0\/1111\/feed$/, { data: [{ id: '1111_9', comments: { data: [{ id: '9_1', created_time: '2026-11-08T14:00:00Z', from: { id: '5555' } }] } }] }],
      [/^GET \/v23\.0\/1111\/conversations$/, { data: [] }],
      [/^GET \/v23\.0\/2222\/media$/, { data: [] }],
    ];
    const fetchImpl = route(handlers);
    expect(await client(fetchImpl).recentInbox({ now, adComments: true }))
      .toEqual([{ platform: 'facebook', kind: 'comment', id: '9_1', parentId: '1111_9', url: null, at: '2026-11-08T14:00:00.000Z' }]);
    expect(fetchImpl.mock.calls.some(([url]) => new URL(url).pathname.endsWith('/act_3333/ads'))).toBe(true);
    const stop = new AbortController();
    stop.abort();
    await expect(client(route(handlers)).recentInbox({ now, adComments: true, signal: stop.signal })).rejects.toMatchObject({ code: expect.stringMatching(/^meta_/) });
  });

  it('limits a new campaign to the roster\'s states through Meta\'s own location search, and launches nothing when a state is not found', async () => {
    const seen = [];
    const fetchImpl = vi.fn(async (url, init = {}) => {
      const parsed = new URL(url);
      const params = init.body ? new URLSearchParams(init.body) : parsed.searchParams;
      seen.push([`${init.method ?? 'GET'} ${parsed.pathname}`, params]);
      if (parsed.pathname.endsWith('/search')) {
        const q = params.get('q');
        if (q === 'Atlantis') return json({ data: [] });
        return json({ data: [{ key: q === 'Pennsylvania' ? '3881' : '3875', name: q, type: 'region', country_code: 'US' }, { key: '999', name: `${q} County`, type: 'region', country_code: 'US' }] });
      }
      return json(parsed.pathname.endsWith('/campaigns') ? { id: '601' } : { id: '602' });
    });
    const meta = client(fetchImpl);
    const states = [{ code: 'PA', name: 'Pennsylvania' }, { code: 'NJ', name: 'New Jersey' }];
    expect(await meta.createCampaign({ name: 'Intel retargeting', dailyBudgetCents: 3000, audienceId: '1234567', states })).toEqual({ campaignId: '601', adsetId: '602' });
    const search = seen.find(([what]) => what === 'GET /v23.0/search')[1];
    expect(Object.fromEntries(search)).toMatchObject({ type: 'adgeolocation', location_types: '["region"]', country_code: 'US' });
    const adset = seen.find(([what]) => what === 'POST /v23.0/act_3333/adsets')[1];
    expect(JSON.parse(adset.get('targeting')).geo_locations).toEqual({ regions: [{ key: '3881' }, { key: '3875' }] });
    // Looked up once a process.
    seen.length = 0;
    await meta.createCampaign({ name: 'Again', dailyBudgetCents: 3000, audienceId: '1234567', states });
    expect(seen.some(([what]) => what === 'GET /v23.0/search')).toBe(false);
    // Without states: the whole country, as before.
    seen.length = 0;
    await meta.createCampaign({ name: 'Country', dailyBudgetCents: 3000, audienceId: '1234567' });
    expect(JSON.parse(seen.find(([what]) => what === 'POST /v23.0/act_3333/adsets')[1].get('targeting')).geo_locations).toEqual({ countries: ['US'] });
    // A state Meta does not find: nothing is created.
    seen.length = 0;
    await expect(meta.createCampaign({ name: 'Nowhere', dailyBudgetCents: 3000, audienceId: '1234567', states: [{ code: 'ZZ', name: 'Atlantis' }] })).rejects.toMatchObject({ code: 'meta_geo_unresolved' });
    expect(seen.some(([what]) => what.startsWith('POST'))).toBe(false);
  });
});
