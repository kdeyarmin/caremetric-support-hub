import { describe, expect, it, vi } from 'vitest';
import { linkedinClient, linkedinComment, linkedinPost, linkedinVideo, littleText } from './linkedin.mjs';

const token = 'AQX-linkedin-member-token-0123456789';
const fresh = 'AQX-renewed-linkedin-token-abcdefghij';
const org = 'urn:li:organization:5550001';
const post = 'urn:li:share:7100000000000000001';
const comment = 'urn:li:comment:(urn:li:activity:7100000000000000009,7200000000000000002)';
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
/** Routes on the method and the decoded path, e.g. "GET /rest/socialActions/urn:li:share:1/comments". */
const route = handlers => vi.fn(async (url, init = {}) => {
  const parsed = new URL(url);
  const key = `${init.method ?? 'GET'} ${decodeURIComponent(parsed.pathname)}`;
  for (const [pattern, reply] of handlers) if (pattern.test(key)) return typeof reply === 'function' ? reply(parsed, init) : reply instanceof Response ? reply.clone() : json(reply);
  return json({ message: 'unknown path' }, 404);
});
const client = (fetchImpl, over = {}) => linkedinClient({ token, organizationId: '5550001', adAccountId: '5080001', fetchImpl, ...over });
const bodyOf = call => JSON.parse(call[1].body);

describe('LinkedIn approved videos', () => {
  const video = 'urn:li:video:C4E10AQFvideo';
  const videoUrl = `https://help.caremetric.ai/api/creative/a/${'a'.repeat(64)}.mp4`;
  const mp4 = () => { const bytes = Buffer.alloc(80_000, 0); bytes.write('ftyp', 4); return bytes; };
  const instructions = () => [
    { uploadUrl: 'https://www.linkedin.com/dms-uploads/video/1', firstByte: 0, lastByte: 39_999 },
    { uploadUrl: 'https://www.linkedin.com/dms-uploads/video/2', firstByte: 40_000, lastByte: 79_999 },
  ];
  function videoFetch({ parts = instructions(), sourceType = 'video/mp4', sourceLength = null, uploadStatus = 201, etag = true, status = 'AVAILABLE', postId = post, owner = org } = {}) {
    return vi.fn(async (url, init = {}) => {
      const parsed = new URL(url);
      if (parsed.host === 'help.caremetric.ai') return new Response(mp4(), { headers: { 'Content-Type': sourceType, ...(sourceLength ? { 'Content-Length': String(sourceLength) } : {}) } });
      if (parsed.pathname === '/rest/videos' && parsed.searchParams.get('action') === 'initializeUpload') return json({ value: { video, uploadToken: 'upload-session', uploadInstructions: parts } });
      if (parsed.pathname.startsWith('/dms-uploads/')) return new Response(null, { status: uploadStatus, headers: etag ? { ETag: `"part-${parsed.pathname.at(-1)}"` } : {} });
      if (parsed.pathname === '/rest/videos' && parsed.searchParams.get('action') === 'finalizeUpload') return json({});
      if (parsed.pathname.startsWith('/rest/videos/')) return json({ id: video, status, owner });
      if (parsed.pathname === '/rest/posts') return json({}, 201, postId ? { 'x-restli-id': postId } : {});
      return json({}, 404);
    });
  }

  it('prepares every exact byte range, finalizes in ETag order, and publishes only in the separate stage', async () => {
    const fetchImpl = videoFetch();
    const li = client(fetchImpl);
    expect(linkedinVideo(video)).toBe(video);
    expect(linkedinVideo('urn:li:video:bad/../posts')).toBeNull();
    expect(await li.prepareVideo({ videoUrl })).toEqual({ id: video });
    expect(fetchImpl.mock.calls.filter(([url]) => new URL(url).pathname === '/rest/posts')).toHaveLength(0);
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ redirect: 'error' });
    expect(fetchImpl.mock.calls[0][1].headers).toBeUndefined();
    expect(bodyOf(fetchImpl.mock.calls[1])).toEqual({ initializeUploadRequest: { owner: org, fileSizeBytes: 80_000, uploadCaptions: false, uploadThumbnail: false } });
    const puts = fetchImpl.mock.calls.filter(([, init]) => init.method === 'PUT');
    expect(puts.map(([, init]) => init.body.length)).toEqual([40_000, 40_000]);
    expect(Buffer.concat(puts.map(([, init]) => init.body))).toEqual(mp4());
    for (const [url, init] of puts) {
      expect(new URL(url).host).toBe('www.linkedin.com');
      expect(init).toMatchObject({ redirect: 'error', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' } });
    }
    expect(bodyOf(fetchImpl.mock.calls.at(-1))).toEqual({ finalizeUploadRequest: { video, uploadToken: 'upload-session', uploadedPartIds: ['part-1', 'part-2'] } });
    expect(await li.readVideo(video)).toEqual({ ready: true, failed: false });
    expect(await li.publishVideo({ videoId: video, message: 'See this workflow. #HomeHealth' })).toEqual({ id: post });
    expect(bodyOf(fetchImpl.mock.calls.at(-1))).toMatchObject({ author: org, commentary: 'See this workflow. {hashtag|\\#|HomeHealth}',
      distribution: { feedDistribution: 'MAIN_FEED' }, lifecycleState: 'PUBLISHED', content: { media: { id: video } } });
  });

  it.each(['PROCESSING', 'WAITING_UPLOAD', 'PROCESSING_FAILED'])('polls %s without posting', async status => {
    const fetchImpl = videoFetch({ status });
    const li = client(fetchImpl);
    expect(await li.readVideo(video)).toEqual({ ready: false, failed: status === 'PROCESSING_FAILED' });
    expect(fetchImpl.mock.calls.every(([, init]) => init.method === 'GET')).toBe(true);
  });

  it('rejects bad sources, oversized downloads and non-MP4 media before asking LinkedIn to upload', async () => {
    for (const invalidUrl of ['http://help.caremetric.ai/a.mp4', 'https://user:secret@help.caremetric.ai/a.mp4', 'https://help.caremetric.ai/unapproved.mp4', `${videoUrl}?x=1`, 'not-a-url']) {
      const fetchImpl = videoFetch();
      await expect(client(fetchImpl).prepareVideo({ videoUrl: invalidUrl })).rejects.toMatchObject({ code: 'linkedin_invalid_video' });
      expect(fetchImpl).not.toHaveBeenCalled();
    }
    for (const input of [{ sourceType: 'image/png' }, { sourceLength: 60 * 1024 * 1024 + 1 }]) {
      const fetchImpl = videoFetch(input);
      await expect(client(fetchImpl).prepareVideo({ videoUrl })).rejects.toMatchObject({ code: 'linkedin_invalid_video' });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
    const fetchImpl = vi.fn(async () => new Response(Buffer.alloc(80_000), { headers: { 'Content-Type': 'video/mp4' } }));
    await expect(client(fetchImpl).prepareVideo({ videoUrl })).rejects.toMatchObject({ code: 'linkedin_invalid_video' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('validates every upload destination and contiguous range before sending any token or bytes', async () => {
    for (const change of [
      { uploadUrl: 'https://evil.example/dms-uploads/video' }, { uploadUrl: 'https://www.linkedin.com.evil.example/video' },
      { uploadUrl: 'http://www.linkedin.com/video' }, { uploadUrl: 'https://user:secret@www.linkedin.com/video' },
      { firstByte: 39_999 }, { lastByte: 80_000 }, { firstByte: '40000' }, { lastByte: 79_998 },
    ]) {
      const parts = instructions(); parts[1] = { ...parts[1], ...change };
      const fetchImpl = videoFetch({ parts });
      await expect(client(fetchImpl).prepareVideo({ videoUrl })).rejects.toMatchObject({ code: 'linkedin_invalid_upload' });
      expect(fetchImpl.mock.calls.some(([, init]) => init.method === 'PUT')).toBe(false);
    }
  });

  it('does not finalize an upload with missing ETags or conceal uncertain publication', async () => {
    const missingEtag = videoFetch({ etag: false });
    await expect(client(missingEtag).prepareVideo({ videoUrl })).rejects.toMatchObject({ code: 'linkedin_unconfirmed' });
    expect(missingEtag.mock.calls.some(([url]) => new URL(url).searchParams.get('action') === 'finalizeUpload')).toBe(false);
    const noPostId = videoFetch({ postId: null });
    await expect(client(noPostId).publishVideo({ videoId: video, message: 'Approved text' })).rejects.toMatchObject({ code: 'linkedin_unconfirmed', transient: false });
    for (const mode of ['network', 'body', 'server', 'server_body']) {
      const known = videoFetch();
      const fetchImpl = vi.fn(async (url, init) => {
        if (new URL(url).pathname !== '/rest/posts') return known(url, init);
        if (mode === 'network') throw new Error(`lost ${token}`);
        if (mode === 'server') return json({}, 503);
        return { ok: mode !== 'server_body', status: mode === 'server_body' ? 503 : 201,
          body: new ReadableStream({ start(controller) { controller.error(new Error('truncated body')); } }) };
      });
      const error = await client(fetchImpl).publishVideo({ videoId: video, message: 'Approved text' }).catch(error => error);
      expect(error).toMatchObject({ code: 'linkedin_unconfirmed', transient: false });
      expect(error.message).not.toContain(token);
      expect(fetchImpl.mock.calls.filter(([url]) => new URL(url).pathname === '/rest/posts')).toHaveLength(1);
    }
  });

  it('refuses a different organization’s media and requires Page configuration', async () => {
    const fetchImpl = videoFetch({ owner: 'urn:li:organization:9' });
    await expect(client(fetchImpl).readVideo(video)).rejects.toMatchObject({ code: 'linkedin_invalid_video' });
    const li = client(vi.fn(), { token: '' });
    await expect(li.prepareVideo({ videoUrl })).rejects.toMatchObject({ code: 'linkedin_not_configured' });
    await expect(li.readVideo(video)).rejects.toMatchObject({ code: 'linkedin_not_configured' });
    await expect(li.publishVideo({ videoId: video, message: 'Approved' })).rejects.toMatchObject({ code: 'linkedin_not_configured' });
  });
});

describe('LinkedIn text and ids', () => {
  it('escapes LinkedIn\'s reserved characters, so nothing a draft says becomes a mention or markup, and keeps real hashtags', () => {
    expect(littleText('Training (annual) @ 100% *done*_ok~ [x] <y> {z} | a\\b')).toBe('Training \\(annual\\) \\@ 100% \\*done\\*\\_ok\\~ \\[x\\] \\<y\\> \\{z\\} \\| a\\\\b');
    expect(littleText('Ready for survey?\n\n#PersonalCareHome #Pennsylvania')).toBe('Ready for survey?\n\n{hashtag|\\#|PersonalCareHome} {hashtag|\\#|Pennsylvania}');
    // A # inside a word or a link is not a hashtag.
    expect(littleText('See https://cmcarebase.com/guide#steps and C#sharp')).toBe('See https://cmcarebase.com/guide\\#steps and C\\#sharp');
  });

  it('accepts only post and comment URNs of the expected shape', () => {
    expect(linkedinPost(post)).toBe(post);
    expect(linkedinPost('urn:li:ugcPost:1')).toBe('urn:li:ugcPost:1');
    expect(linkedinPost('urn:li:share:1/../x')).toBeNull();
    expect(linkedinComment(comment)).toBe(comment);
    expect(linkedinComment('urn:li:comment:(urn:li:activity:1,abc)')).toBeNull();
  });
});

describe('the LinkedIn client', () => {
  it('knows what is connected, from valid ids and a token (or a way to renew one) only', () => {
    expect(client(vi.fn()).configured).toEqual({ page: true, ads: true, member: false });
    expect(linkedinClient({ token, organizationId: org }).configured).toEqual({ page: true, ads: false, member: false });
    expect(linkedinClient({ token, organizationId: '5550001', adAccountId: 'urn:li:sponsoredAccount:5080001' }).ids).toEqual({ organization: '5550001', account: '5080001' });
    expect(linkedinClient({ token: '', organizationId: '5550001', adAccountId: '5080001' }).configured).toEqual({ page: false, ads: false, member: false });
    expect(linkedinClient({ refreshToken: 'AQX-refresh-token-0123456789', clientId: 'app', clientSecret: 'secret', organizationId: '5550001' }).configured).toEqual({ page: true, ads: false, member: false });
    expect(linkedinClient({ token, organizationId: '../me', adAccountId: 'x' }).configured).toEqual({ page: false, ads: false, member: false });
  });

  it('calls only api.linkedin.com with the versioned Rest.li headers, and never puts a token in an error', async () => {
    const fetchImpl = route([[/^POST \/rest\/posts$/, json({}, 201, { 'x-restli-id': post })]]);
    const li = client(fetchImpl, { version: '202609' });
    expect(await li.publishPost({ message: 'Annual training in one place. #PersonalCareHome', link: 'https://cmcarebase.com/pa-training-requirements', linkTitle: 'PA training requirements' })).toEqual({ id: post, image: false });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(new URL(url).host).toBe('api.linkedin.com');
    expect(init.redirect).toBe('error');
    expect(init.headers).toMatchObject({ Authorization: `Bearer ${token}`, 'LinkedIn-Version': '202609', 'X-Restli-Protocol-Version': '2.0.0' });
    expect(bodyOf(fetchImpl.mock.calls[0])).toMatchObject({
      author: org, commentary: 'Annual training in one place. {hashtag|\\#|PersonalCareHome}', visibility: 'PUBLIC', lifecycleState: 'PUBLISHED',
      distribution: { feedDistribution: 'MAIN_FEED' }, content: { article: { source: 'https://cmcarebase.com/pa-training-requirements', title: 'PA training requirements' } },
    });
    const error = await client(route([[/./, json({ message: `bad ${token}` }, 401)]])).recentPosts().catch(caught => caught);
    expect(error).toMatchObject({ code: 'linkedin_token_invalid' });
    expect(JSON.stringify({ message: error.message, code: error.code })).not.toContain(token);
  });

  it('maps LinkedIn errors to codes the Team screen shows, retrying only the transient ones, and never retries a write it may have made', async () => {
    for (const [status, code, transient] of [[429, 'linkedin_rate_limited', true], [403, 'linkedin_permission', false], [503, 'linkedin_unavailable', true], [422, 'linkedin_invalid_request', false]]) {
      await expect(client(route([[/./, json({}, status)]])).adsOverview()).rejects.toMatchObject({ code, transient });
    }
    const lost = client(vi.fn(async () => { throw new TypeError('socket hang up'); }));
    await expect(lost.publishPost({ message: 'Hi' })).rejects.toMatchObject({ code: 'linkedin_unconfirmed', transient: false });
    await expect(lost.recentPosts()).rejects.toMatchObject({ code: 'linkedin_unavailable', transient: true });
  });

  it('renews an expired token once through LinkedIn\'s OAuth endpoint and sends the request again with it', async () => {
    const seen = [];
    const fetchImpl = vi.fn(async (url, init = {}) => {
      const parsed = new URL(url);
      if (parsed.host === 'www.linkedin.com') {
        const form = new URLSearchParams(init.body);
        expect([parsed.pathname, form.get('grant_type'), form.get('refresh_token'), form.get('client_id')]).toEqual(['/oauth/v2/accessToken', 'refresh_token', 'AQX-refresh-token-0123456789', 'app']);
        return json({ access_token: fresh, expires_in: 5_184_000 });
      }
      seen.push(init.headers.Authorization);
      return init.headers.Authorization === `Bearer ${fresh}` ? json({ elements: [] }) : json({}, 401);
    });
    const li = client(fetchImpl, { refreshToken: 'AQX-refresh-token-0123456789', clientId: 'app', clientSecret: 'secret' });
    expect(await li.recentPosts()).toEqual([]);
    expect(seen).toEqual([`Bearer ${token}`, `Bearer ${fresh}`]);
    // Without a way to renew, or when renewing fails, the token is reported invalid and nothing is sent twice.
    const once = route([[/./, json({}, 401)]]);
    await expect(client(once).recentPosts()).rejects.toMatchObject({ code: 'linkedin_token_invalid' });
    expect(once).toHaveBeenCalledTimes(1);
    const refused = vi.fn(async url => (new URL(url).host === 'www.linkedin.com' ? json({ error: 'invalid_grant' }, 400) : json({}, 401)));
    await expect(client(refused, { refreshToken: 'AQX-refresh-token-0123456789', clientId: 'app', clientSecret: 'secret' }).recentPosts()).rejects.toMatchObject({ code: 'linkedin_token_invalid' });
    expect(refused).toHaveBeenCalledTimes(2);
  });

  it('uploads an approved brand image as the link card\'s thumbnail, sending the token only to LinkedIn\'s upload address', async () => {
    const image = 'urn:li:image:C4E10AQFxyz';
    const calls = [];
    const fetchImpl = vi.fn(async (url, init = {}) => {
      const parsed = new URL(url);
      calls.push([init.method ?? 'GET', parsed.host, parsed.pathname, init.headers?.Authorization ?? null]);
      if (parsed.host === 'cdn.example.com') return new Response(new Uint8Array([0xff, 0xd8, 0xff]), { status: 200, headers: { 'Content-Type': 'image/jpeg' } });
      if (parsed.pathname === '/rest/images') return json({ value: { uploadUrl: 'https://www.linkedin.com/dms-uploads/sp/v2/abc', image } });
      if (parsed.pathname.startsWith('/dms-uploads/')) return new Response(null, { status: 201 });
      return json({}, 201, { 'x-restli-id': post });
    });
    const li = client(fetchImpl);
    expect(await li.publishPost({ message: 'Hello', link: 'https://cmcarebase.com/signup', linkTitle: 'Start', imageUrl: 'https://cdn.example.com/brand-1.jpg' })).toEqual({ id: post, image: true });
    expect(calls).toEqual([
      ['GET', 'cdn.example.com', '/brand-1.jpg', null],
      ['POST', 'api.linkedin.com', '/rest/images', `Bearer ${token}`],
      ['PUT', 'www.linkedin.com', '/dms-uploads/sp/v2/abc', `Bearer ${token}`],
      ['POST', 'api.linkedin.com', '/rest/posts', `Bearer ${token}`],
    ]);
    expect(new URL(fetchImpl.mock.calls[1][0]).searchParams.get('action')).toBe('initializeUpload');
    expect(bodyOf(fetchImpl.mock.calls[1])).toEqual({ initializeUploadRequest: { owner: org } });
    expect(bodyOf(fetchImpl.mock.calls[3]).content).toEqual({ article: { source: 'https://cmcarebase.com/signup', title: 'Start', thumbnail: image } });
    // Without a link the image is the post's media.
    await li.publishPost({ message: 'Hello', imageUrl: 'https://cdn.example.com/brand-1.jpg' });
    expect(bodyOf(fetchImpl.mock.calls.at(-1)).content).toEqual({ media: { id: image } });
  });

  it('posts without an image rather than send the token anywhere but LinkedIn, or upload something that is not an image', async () => {
    for (const [uploadUrl, contentType] of [['https://uploads.example.com/x', 'image/png'], ['http://www.linkedin.com/dms-uploads/x', 'image/png'], ['https://www.linkedin.com/dms-uploads/x', 'text/html']]) {
      const fetchImpl = vi.fn(async (url, init = {}) => {
        const parsed = new URL(url);
        if (parsed.host === 'cdn.example.com') return new Response('x', { status: 200, headers: { 'Content-Type': contentType } });
        if (parsed.pathname === '/rest/images') return json({ value: { uploadUrl, image: 'urn:li:image:abc' } });
        if (init.method === 'PUT') throw new Error('the token must not leave LinkedIn');
        return json({}, 201, { 'x-restli-id': post });
      });
      expect(await client(fetchImpl).publishPost({ message: 'Hello', link: 'https://cmcarebase.com/signup', imageUrl: 'https://cdn.example.com/a.png' })).toEqual({ id: post, image: false });
      expect(fetchImpl.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false);
      expect(bodyOf(fetchImpl.mock.calls.at(-1)).content.article).not.toHaveProperty('thumbnail');
    }
    const unreachable = vi.fn(async url => (new URL(url).host === 'cdn.example.com' ? json({}, 404) : json({}, 201, { 'x-restli-id': post })));
    expect(await client(unreachable).publishPost({ message: 'Hello', imageUrl: 'https://cdn.example.com/gone.jpg' })).toEqual({ id: post, image: false });
  });

  it('uses the ad account\'s own app token for ads when there is one, and renews it with that app\'s keys', async () => {
    const adsToken = 'AQX-advertising-app-token-0123456789';
    const renewed = 'AQX-advertising-app-renewed-abcdefghij';
    const used = [];
    const fetchImpl = vi.fn(async (url, init = {}) => {
      const parsed = new URL(url);
      if (parsed.host === 'www.linkedin.com') {
        expect(new URLSearchParams(init.body).get('client_id')).toBe('ads-app');
        return json({ access_token: renewed });
      }
      used.push([parsed.pathname.split('/')[2], init.headers.Authorization]);
      if (init.headers.Authorization === `Bearer ${adsToken}`) return json({}, 401);
      return parsed.pathname === '/rest/posts' && init.method === 'POST' ? json({}, 201, { 'x-restli-id': post }) : json({ elements: [] });
    });
    const li = client(fetchImpl, { adsToken, adsRefreshToken: 'AQX-advertising-refresh-0123456789', adsClientId: 'ads-app', adsClientSecret: 'ads-secret' });
    await li.publishPost({ message: 'Hello' });
    await li.adsOverview({ now: new Date('2026-11-08T15:00:00Z') });
    expect(used[0]).toEqual(['posts', `Bearer ${token}`]);
    expect(used.slice(1).every(([, auth]) => auth === `Bearer ${adsToken}` || auth === `Bearer ${renewed}`)).toBe(true);
    expect(used.some(([, auth]) => auth === `Bearer ${renewed}`)).toBe(true);
    expect(linkedinClient({ adsToken, adAccountId: '5080001' }).configured).toEqual({ page: false, ads: true, member: false });
  });

  it('reads the Page\'s recent posts with their engagement, leaving out sponsored-only posts', async () => {
    const fetchImpl = route([
      [/^GET \/rest\/posts$/, { elements: [
        { id: post, commentary: 'Survey season is here.', publishedAt: Date.parse('2026-11-05T13:45:00Z'), lifecycleState: 'PUBLISHED' },
        { id: 'urn:li:share:7100000000000000002', commentary: 'Sponsored', publishedAt: Date.parse('2026-11-05T13:45:00Z'), adContext: { dscStatus: 'ACTIVE' } },
        { id: 'urn:li:share:7100000000000000003', commentary: 'Draft', lifecycleState: 'DRAFT' },
      ] }],
      [/^GET \/rest\/socialMetadata$/, { results: { [post]: { reactionSummaries: { LIKE: { count: 4 }, PRAISE: { count: 2 } }, commentSummary: { count: 3 } } } }],
    ]);
    expect(await client(fetchImpl).recentPosts()).toEqual([{ platform: 'linkedin', id: post, text: 'Survey season is here.', at: '2026-11-05T13:45:00.000Z',
      url: `https://www.linkedin.com/feed/update/${post}/`, reactions: 6, comments: 3, shares: 0 }]);
    const query = new URL(fetchImpl.mock.calls[0][0]).searchParams;
    expect([query.get('author'), query.get('q')]).toEqual([org, 'author']);
    expect(new URL(fetchImpl.mock.calls[1][0]).search).toContain(`ids=List(${encodeURIComponent(post)})`);
  });

  it('on the Development tier, reads engagement one post at a time for the eight newest and comments on the three newest, never in a batch', async () => {
    const ids = Array.from({ length: 12 }, (_, i) => `urn:li:share:71000000000000001${String(i).padStart(2, '0')}`);
    const fetchImpl = route([
      [/^GET \/rest\/posts$/, { elements: ids.map(id => ({ id, commentary: id, lifecycleState: 'PUBLISHED' })) }],
      [/^GET \/rest\/socialMetadata\/urn:li:share:\d+$/, parsed => json({ reactionSummaries: { LIKE: { count: Number(decodeURIComponent(parsed.pathname).slice(-2)) } }, commentSummary: { count: 1 } })],
      [/^GET \/rest\/socialMetadata$/, json({ message: 'BATCH_GET is not allowed on the Development tier' }, 403)],
      [/^GET \/rest\/socialActions\/urn:li:share:\d+\/comments$/, { elements: [] }],
    ]);
    const li = client(fetchImpl, { tier: 'development' });
    expect(li.tier).toBe('development');
    const posts = await li.recentPosts();
    expect(posts.map(item => [item.id, item.reactions, item.comments])).toEqual(ids.slice(0, 8).map((id, i) => [id, i, 1]));
    const paths = fetchImpl.mock.calls.map(([url]) => decodeURIComponent(new URL(url).pathname) + new URL(url).search);
    expect(paths).toEqual(['/rest/posts?author=urn%3Ali%3Aorganization%3A5550001&q=author&count=20&sortBy=LAST_MODIFIED', ...ids.slice(0, 8).map(id => `/rest/socialMetadata/${id}`)]);
    fetchImpl.mockClear();
    expect(await li.recentInbox({ now: new Date('2026-11-08T15:00:00Z') })).toEqual([]);
    expect(fetchImpl.mock.calls.map(([url]) => decodeURIComponent(new URL(url).pathname))).toEqual(['/rest/posts', ...ids.slice(0, 3).map(id => `/rest/socialActions/${id}/comments`)]);
    // The Standard tier (and a client built without a tier) keeps the batch read and ten posts' comments.
    expect(client(fetchImpl).tier).toBe('standard');
    fetchImpl.mockClear();
    await client(fetchImpl, { tier: 'standard' }).recentInbox({ now: new Date('2026-11-08T15:00:00Z') });
    expect(fetchImpl).toHaveBeenCalledTimes(11);
  });

  it('finds other people\'s new top-level comments by URN only, and reads one again to see whether the Page answered it', async () => {
    const now = new Date('2026-11-08T15:00:00Z');
    const other = 'urn:li:comment:(urn:li:activity:7100000000000000009,7200000000000000003)';
    const fetchImpl = route([
      [/^GET \/rest\/posts$/, { elements: [{ id: post, commentary: 'x', lifecycleState: 'PUBLISHED' }] }],
      [/^GET \/rest\/socialActions\/urn:li:share:\d+\/comments$/, { elements: [
        { commentUrn: comment, actor: 'urn:li:person:abc', message: { text: 'How much is it?' }, created: { time: Date.parse('2026-11-08T14:00:00Z') } },
        { commentUrn: other, actor: org, message: { text: 'Ours' }, created: { time: Date.parse('2026-11-08T14:05:00Z') } },
        { commentUrn: 'urn:li:comment:(urn:li:activity:7100000000000000009,7200000000000000004)', actor: 'urn:li:person:def', created: { time: Date.parse('2026-11-01T14:00:00Z') } },
        { commentUrn: 'urn:li:comment:(urn:li:activity:7100000000000000009,7200000000000000005)', actor: 'urn:li:person:ghi', parentComment: comment, created: { time: Date.parse('2026-11-08T14:10:00Z') } },
      ] }],
      [/^GET \/rest\/socialActions\/urn:li:comment:.+\/comments$/, { elements: [{ commentUrn: 'urn:li:comment:(urn:li:activity:7100000000000000009,7200000000000000006)', actor: org }] }],
    ]);
    const li = client(fetchImpl);
    const items = await li.recentInbox({ now });
    expect(items).toEqual([{ platform: 'linkedin', kind: 'comment', id: comment, parentId: post, url: `https://www.linkedin.com/feed/update/${post}/`, at: '2026-11-08T14:00:00.000Z' }]);
    expect(JSON.stringify(items)).not.toContain('How much');
    expect(await li.readItem({ id: comment, parentId: post })).toEqual({ text: 'How much is it?', fromPage: false, answered: true, history: [] });
    expect(await li.readItem({ id: 'urn:li:comment:(urn:li:activity:7100000000000000009,7299999999999999999)', parentId: post })).toEqual({ gone: true });
    expect(await li.readItem({ id: 'not-a-urn', parentId: post })).toEqual({ gone: true });
  });

  it('replies under the comment itself and deletes a comment by what it is on and its id', async () => {
    const fetchImpl = route([
      [/^POST \/rest\/socialActions\/urn:li:comment:.+\/comments$/, json({}, 201, { 'x-restli-id': 'urn:li:comment:(urn:li:activity:7100000000000000009,7200000000000000007)' })],
      [/^DELETE \/rest\/socialActions\/urn:li:activity:7100000000000000009\/comments\/7200000000000000002$/, new Response(null, { status: 204 })],
    ]);
    const li = client(fetchImpl);
    expect(await li.reply({ id: comment, parentId: post, message: 'Thanks for asking.' })).toEqual({ id: 'urn:li:comment:(urn:li:activity:7100000000000000009,7200000000000000007)' });
    expect(decodeURIComponent(new URL(fetchImpl.mock.calls[0][0]).pathname)).toBe(`/rest/socialActions/${comment}/comments`);
    expect(bodyOf(fetchImpl.mock.calls[0])).toEqual({ actor: org, object: 'urn:li:activity:7100000000000000009', parentComment: comment, message: { text: 'Thanks for asking.' } });
    expect(await li.remove({ id: comment, parentId: post })).toEqual({ deleted: true });
    expect(new URL(fetchImpl.mock.calls[1][0]).searchParams.get('actor')).toBe(org);
    await expect(li.reply({ id: 'urn:li:comment:bad', parentId: post, message: 'x' })).rejects.toMatchObject({ code: 'linkedin_invalid_request' });
    await expect(li.remove({ id: comment, parentId: 'urn:li:share:x' })).rejects.toMatchObject({ code: 'linkedin_invalid_request' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('reads the ad account as ad sets (campaigns, with budgets in cents) and ads (creatives, with the copy of the post they sponsor)', async () => {
    const sponsored = 'urn:li:share:7100000000000000010';
    const fetchImpl = route([
      [/^GET \/rest\/adAccounts\/5080001\/adCampaigns$/, { elements: [{ id: 610001, name: 'PA operators', status: 'ACTIVE', dailyBudget: { amount: '25.00', currencyCode: 'USD' }, objectiveType: 'WEBSITE_VISIT' }] }],
      [/^GET \/rest\/adAccounts\/5080001\/creatives$/, { elements: [
        { id: 'urn:li:sponsoredCreative:820001', campaign: 'urn:li:sponsoredCampaign:610001', intendedStatus: 'ACTIVE', content: { reference: sponsored }, createdAt: Date.parse('2026-10-20T12:00:00Z'), name: 'Survey' },
        { id: 'urn:li:sponsoredCreative:820002', campaign: 'urn:li:sponsoredCampaign:610001', intendedStatus: 'PAUSED', content: { reference: 'urn:li:share:7100000000000000011' } },
      ] }],
      [/^GET \/rest\/posts\/urn:li:share:7100000000000000010$/, { commentary: 'Getting ready for your next DHS inspection?', content: { article: { source: 'https://cmcarebase.com/signup', title: 'Try CareBase free', description: '30-day free trial', thumbnail: 'urn:li:image:C4E10AQbest' } } }],
      [/^GET \/rest\/adAnalytics$/, { elements: [{ pivotValues: ['urn:li:sponsoredCreative:820001'], impressions: 4000, clicks: 70, landingPageClicks: 60, costInLocalCurrency: '84.50', approximateMemberReach: 2000, externalWebsiteConversions: 2, oneClickLeads: 1 }] }],
    ]);
    const overview = await client(fetchImpl).adsOverview({ now: new Date('2026-11-08T15:00:00Z') });
    expect(overview.adsets).toEqual([{ id: '610001', name: 'PA operators', active: true, dailyBudget: 2500, currency: 'USD', objective: 'WEBSITE_VISIT', campaign: 'PA operators' }]);
    expect(overview.ads).toEqual([
      { id: '820001', name: 'Survey', adsetId: '610001', active: true, createdAt: '2026-10-20T12:00:00.000Z', imageHash: 'urn:li:image:C4E10AQbest',
        copy: { message: 'Getting ready for your next DHS inspection?', headline: 'Try CareBase free', description: '30-day free trial', link: 'https://cmcarebase.com/signup' } },
      { id: '820002', name: 'Creative 820002', adsetId: '610001', active: false, createdAt: null, imageHash: null, copy: { message: '', headline: '', description: '', link: null } },
    ]);
    expect(overview.current).toEqual([{ adId: '820001', impressions: 4000, clicks: 60, spendCents: 8450, frequency: 2, results: 3 }]);
    const analytics = fetchImpl.mock.calls.map(([url]) => new URL(url)).filter(url => url.pathname === '/rest/adAnalytics').map(url => decodeURIComponent(url.search));
    expect(analytics).toHaveLength(2);
    expect(analytics[0]).toContain('pivot=CREATIVE');
    expect(analytics[0]).toContain('accounts=List(urn:li:sponsoredAccount:5080001)');
    expect(analytics[0]).toContain('dateRange=(start:(year:2026,month:11,day:1),end:(year:2026,month:11,day:7))');
  });

  it('pauses a creative and sets a campaign budget as partial updates, refusing an id that is not LinkedIn\'s before any call', async () => {
    const fetchImpl = route([
      [/^POST \/rest\/adAccounts\/5080001\/creatives\/urn:li:sponsoredCreative:820001$/, new Response(null, { status: 204 })],
      [/^POST \/rest\/adAccounts\/5080001\/adCampaigns\/610001$/, new Response(null, { status: 204 })],
      [/^GET \/rest\/adAccounts\/5080001\/adCampaigns\/610001$/, { id: 610001, status: 'ACTIVE', dailyBudget: { amount: '25.00', currencyCode: 'USD' } }],
    ]);
    const li = client(fetchImpl);
    expect(await li.pauseAd('820001')).toEqual({ success: true });
    expect(fetchImpl.mock.calls[0][1].headers['X-RestLi-Method']).toBe('PARTIAL_UPDATE');
    expect(bodyOf(fetchImpl.mock.calls[0])).toEqual({ patch: { $set: { intendedStatus: 'PAUSED' } } });
    expect(await li.readAdset('610001')).toEqual({ id: '610001', dailyBudget: 2500, currency: 'USD', active: true });
    expect(await li.setDailyBudget('610001', 3000, { currency: 'USD' })).toEqual({ success: true });
    expect(bodyOf(fetchImpl.mock.calls[2])).toEqual({ patch: { $set: { dailyBudget: { amount: '30.00', currencyCode: 'USD' } } } });
    await expect(li.pauseAd('../1')).rejects.toMatchObject({ code: 'linkedin_invalid_request' });
    await expect(li.setDailyBudget('610001', 30.5)).rejects.toMatchObject({ code: 'linkedin_invalid_request' });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    await expect(linkedinClient({ token, organizationId: '5550001', fetchImpl }).pauseAd('820001')).rejects.toMatchObject({ code: 'linkedin_not_configured' });
  });

  it('starts a new ad as a sponsored-only post, then a creative in the campaign', async () => {
    const dark = 'urn:li:share:7100000000000000020';
    const fetchImpl = route([
      [/^POST \/rest\/posts$/, json({}, 201, { 'x-restli-id': dark })],
      [/^POST \/rest\/adAccounts\/5080001\/creatives$/, json({}, 201, { 'x-restli-id': 'urn:li:sponsoredCreative:820009' })],
    ]);
    const created = await client(fetchImpl).createAd({ adsetId: '610001', message: 'Survey prep, in one place.', headline: 'Try CareBase free', description: '30-day free trial', link: 'https://cmcarebase.com/signup',
      imageHash: 'urn:li:image:C4E10AQbest' });
    expect(created).toEqual({ id: '820009', postId: dark });
    // The new ad reuses the image of the ad it is based on: nothing is uploaded.
    expect(bodyOf(fetchImpl.mock.calls[0])).toMatchObject({ author: org, distribution: { feedDistribution: 'NONE' }, adContext: { dscAdAccount: 'urn:li:sponsoredAccount:5080001', dscStatus: 'ACTIVE' },
      content: { article: { source: 'https://cmcarebase.com/signup', title: 'Try CareBase free', description: '30-day free trial', thumbnail: 'urn:li:image:C4E10AQbest' } } });
    expect(bodyOf(fetchImpl.mock.calls[1])).toEqual({ campaign: 'urn:li:sponsoredCampaign:610001', content: { reference: dark }, intendedStatus: 'ACTIVE' });
    const unconfirmed = route([[/^POST \/rest\/posts$/, json({}, 201)]]);
    await expect(client(unconfirmed).createAd({ adsetId: '610001', message: 'x', headline: 'y', description: 'z', link: 'https://cmcarebase.com/signup' })).rejects.toMatchObject({ code: 'linkedin_unconfirmed' });
  });
});

describe('the founder\'s own profile', () => {
  it('reads the member from the token\'s own profile once, and posts as that member', async () => {
    const calls = [];
    const fetchImpl = vi.fn(async (url, init) => {
      calls.push([url, init]);
      if (url === 'https://api.linkedin.com/v2/userinfo') return new Response(JSON.stringify({ sub: 'AbC123_x' }), { status: 200 });
      return new Response('{}', { status: 201, headers: { 'x-restli-id': 'urn:li:share:7300000000000000001' } });
    });
    const li = linkedinClient({ memberToken: 'AQV-member-token-0123456789', fetchImpl });
    expect(li.configured).toEqual({ page: false, ads: false, member: true });
    expect(await li.publishMemberPost({ message: 'A plain post.' })).toEqual({ id: 'urn:li:share:7300000000000000001' });
    await li.publishMemberPost({ message: 'Another.' });
    expect(calls.filter(([url]) => url.endsWith('/userinfo'))).toHaveLength(1);
    const [url, init] = calls[1];
    expect(url).toBe('https://api.linkedin.com/rest/posts');
    expect(init.headers.Authorization).toBe('Bearer AQV-member-token-0123456789');
    expect(JSON.parse(init.body)).toMatchObject({ author: 'urn:li:person:AbC123_x', commentary: 'A plain post.', visibility: 'PUBLIC', lifecycleState: 'PUBLISHED' });
    await expect(linkedinClient({}).publishMemberPost({ message: 'x' })).rejects.toMatchObject({ code: 'linkedin_not_configured' });
  });
});

describe('new campaigns and lead reports on LinkedIn', () => {
  it('creates a draft campaign group and campaign with the health care audience, and reports a lead by hash and click ID', async () => {
    const calls = [];
    const fetchImpl = vi.fn(async (url, init) => {
      calls.push([url, init]);
      const id = url.endsWith('/adCampaignGroups') ? 'urn:li:sponsoredCampaignGroup:701' : url.endsWith('/adCampaigns') ? 'urn:li:sponsoredCampaign:702' : null;
      return new Response('{}', { status: 201, headers: id ? { 'x-restli-id': id } : {} });
    });
    const li = linkedinClient({ adsToken: 'AQV-ads-token-0123456789abc', adAccountId: '5080001', fetchImpl });
    expect(await li.createCampaign({ name: 'Intel prospecting', dailyBudgetCents: 3000, startAt: '2026-11-17T00:00:00Z' })).toEqual({ campaignGroupId: '701', campaignId: '702' });
    expect(calls[0][0]).toBe('https://api.linkedin.com/rest/adAccounts/5080001/adCampaignGroups');
    const campaign = JSON.parse(calls[1][1].body);
    expect(campaign).toMatchObject({ campaignGroup: 'urn:li:sponsoredCampaignGroup:701', status: 'DRAFT', objectiveType: 'WEBSITE_VISIT', dailyBudget: { amount: '30.00', currencyCode: 'USD' } });
    expect(JSON.stringify(campaign.targetingCriteria)).toContain('urn:li:geo:103644278');
    await expect(li.createCampaign({ name: 'x', dailyBudgetCents: 500 })).rejects.toMatchObject({ code: 'linkedin_invalid_request' });
    const hash = 'b'.repeat(64);
    await li.sendConversion({ conversionId: '123456', eventId: 'l2', happenedAt: 1794225600000, emailHash: hash, liFatId: '0f1e2d3c-1234-4abc-8def-001122334455' });
    expect(calls[2][0]).toBe('https://api.linkedin.com/rest/conversionEvents');
    expect(JSON.parse(calls[2][1].body)).toEqual({ conversion: 'urn:lla:llaPartnerConversion:123456', conversionHappenedAt: 1794225600000, eventId: 'l2',
      user: { userIds: [{ idType: 'SHA256_EMAIL', idValue: hash }, { idType: 'LINKEDIN_FIRST_PARTY_ADS_TRACKING_UUID', idValue: '0f1e2d3c-1234-4abc-8def-001122334455' }] } });
  });

  it('ends a campaign the owner handed over with its month, and starts the group then the campaign once its ad is in', async () => {
    const calls = [];
    const fetchImpl = vi.fn(async (url, init) => {
      calls.push([url, init]);
      const id = url.endsWith('/adCampaignGroups') ? 'urn:li:sponsoredCampaignGroup:701' : url.endsWith('/adCampaigns') ? 'urn:li:sponsoredCampaign:702' : null;
      return new Response(id ? '{}' : null, { status: id ? 201 : 204, headers: id ? { 'x-restli-id': id } : {} });
    });
    const li = linkedinClient({ adsToken: 'AQV-ads-token-0123456789abc', adAccountId: '5080001', fetchImpl });
    const startAt = '2026-11-16T15:20:00.000Z', endAt = '2026-12-01T04:59:59.000Z';
    expect(await li.createCampaign({ name: 'Intel prospecting', dailyBudgetCents: 1500, startAt, endAt })).toEqual({ campaignGroupId: '701', campaignId: '702' });
    const schedule = { start: Date.parse(startAt), end: Date.parse(endAt) };
    expect(JSON.parse(calls[0][1].body)).toMatchObject({ status: 'DRAFT', runSchedule: schedule });
    expect(JSON.parse(calls[1][1].body)).toMatchObject({ status: 'DRAFT', runSchedule: schedule, dailyBudget: { amount: '15.00', currencyCode: 'USD' } });
    await expect(li.createCampaign({ name: 'x', dailyBudgetCents: 1500, startAt, endAt: startAt })).rejects.toMatchObject({ code: 'linkedin_invalid_request' });
    expect(await li.startCampaign({ campaignGroupId: '701', campaignId: '702' })).toEqual({ started: true });
    expect(calls.slice(2).map(([url, init]) => [url, init.headers['X-RestLi-Method'], JSON.parse(init.body)])).toEqual([
      ['https://api.linkedin.com/rest/adAccounts/5080001/adCampaignGroups/701', 'PARTIAL_UPDATE', { patch: { $set: { status: 'ACTIVE' } } }],
      ['https://api.linkedin.com/rest/adAccounts/5080001/adCampaigns/702', 'PARTIAL_UPDATE', { patch: { $set: { status: 'ACTIVE' } } }],
    ]);
    await expect(li.startCampaign({ campaignGroupId: 'urn:li:x', campaignId: '702' })).rejects.toMatchObject({ code: 'linkedin_invalid_request' });
    expect(calls).toHaveLength(4);
  });
});

describe('reach outside cold email (team review 2026-11-17, stage 6)', () => {
  it('reads the ad account once an Eastern day, and reads it again after the team changes the account', async () => {
    const fetchImpl = route([
      [/^GET \/rest\/adAccounts\/5080001\/adCampaigns$/, { elements: [{ id: 610001, name: 'PA operators', status: 'ACTIVE', dailyBudget: { amount: '25.00', currencyCode: 'USD' } }] }],
      [/^GET \/rest\/adAccounts\/5080001\/creatives$/, { elements: [] }],
      [/^GET \/rest\/adAnalytics$/, { elements: [] }],
      [/^POST \/rest\/adAccounts\/5080001\/adCampaigns\/610001$/, new Response(null, { status: 204 })],
    ]);
    const li = client(fetchImpl);
    const reads = () => fetchImpl.mock.calls.filter(([url]) => new URL(url).pathname.endsWith('/adCampaigns')).length;
    const first = await li.adsOverview({ now: new Date('2026-11-09T13:00:00Z') });
    expect(await li.adsOverview({ now: new Date('2026-11-10T04:00:00Z') })).toBe(first); // 11 PM Eastern, the same day
    expect(reads()).toBe(1);
    await li.adsOverview({ now: new Date('2026-11-10T13:00:00Z') });
    expect(reads()).toBe(2);
    await li.setDailyBudget('610001', 3000).catch(() => {});
    await li.adsOverview({ now: new Date('2026-11-10T14:00:00Z') });
    expect(reads()).toBe(3);
    // A read that fails is not kept.
    const failing = client(route([[/^GET /, json({ message: 'down' }, 500)]]));
    await expect(failing.adsOverview({ now: new Date('2026-11-09T13:00:00Z') })).rejects.toBeTruthy();
  });

  it('limits a new campaign to the roster\'s states through LinkedIn\'s own location lookup, and creates nothing when a state is not found', async () => {
    const calls = [];
    const fetchImpl = vi.fn(async (url, init = {}) => {
      calls.push([url, init]);
      const parsed = new URL(url);
      if (parsed.pathname.endsWith('/adTargetingEntities')) {
        const query = decodeURIComponent(parsed.search).match(/query=([^&]+)/)[1];
        if (query === 'Atlantis') return json({ elements: [] });
        return json({ elements: [{ urn: 'urn:li:geo:999', name: `${query} County, United States` }, { urn: query === 'Pennsylvania' ? 'urn:li:geo:101689' : 'urn:li:geo:101651', name: `${query}, United States` }] });
      }
      const id = url.endsWith('/adCampaignGroups') ? 'urn:li:sponsoredCampaignGroup:701' : url.endsWith('/adCampaigns') ? 'urn:li:sponsoredCampaign:702' : null;
      return new Response('{}', { status: 201, headers: id ? { 'x-restli-id': id } : {} });
    });
    const li = linkedinClient({ adsToken: 'AQV-ads-token-0123456789abc', adAccountId: '5080001', fetchImpl });
    const states = [{ code: 'PA', name: 'Pennsylvania' }, { code: 'NJ', name: 'New Jersey' }];
    expect(await li.createCampaign({ name: 'Intel prospecting', dailyBudgetCents: 3000, startAt: '2026-11-17T00:00:00Z', states })).toEqual({ campaignGroupId: '701', campaignId: '702' });
    const lookup = decodeURIComponent(new URL(calls[0][0]).search);
    expect(lookup).toContain('q=typeahead');
    expect(lookup).toContain('facet=urn:li:adTargetingFacet:locations');
    const campaign = JSON.parse(calls.find(([url]) => url.endsWith('/adCampaigns'))[1].body);
    expect(campaign.targetingCriteria.include.and[0]).toEqual({ or: { 'urn:li:adTargetingFacet:locations': ['urn:li:geo:101689', 'urn:li:geo:101651'] } });
    expect(JSON.stringify(campaign.targetingCriteria)).not.toContain('urn:li:geo:103644278');
    calls.length = 0;
    await li.createCampaign({ name: 'Again', dailyBudgetCents: 3000, startAt: '2026-11-17T00:00:00Z', states });
    expect(calls.some(([url]) => url.includes('adTargetingEntities'))).toBe(false);
    calls.length = 0;
    await expect(li.createCampaign({ name: 'Nowhere', dailyBudgetCents: 3000, states: [{ code: 'ZZ', name: 'Atlantis' }] })).rejects.toMatchObject({ code: 'linkedin_geo_unresolved' });
    expect(calls.some(([, init]) => init.method === 'POST')).toBe(false);
  });
});
