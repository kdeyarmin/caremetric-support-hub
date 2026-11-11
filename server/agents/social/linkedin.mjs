/**
 * The Social Media Manager's only path to LinkedIn: the REST API (api.linkedin.com/rest) for CareMetric's Company Page (posts,
 * comments on them, engagement) and its LinkedIn ad account (campaigns, creatives, analytics). Server-only. The access token
 * (HUB_LINKEDIN_ACCESS_TOKEN, from an admin of the Page through the owner's LinkedIn developer app) is sent only to api.linkedin.com;
 * when a refresh token and the app's client id and secret are set, an expired token is renewed once through www.linkedin.com. LinkedIn
 * keeps its Page API (Community Management) on an app of its own, so the ad account may use a second app's token
 * (HUB_LINKEDIN_ADS_ACCESS_TOKEN and its own refresh settings); without one, the Page token is used for ads too. No token is ever
 * logged, stored or put in an error. Every call is one HTTPS request to a fixed host, bounded to 15 seconds and 1 MB.
 *
 * LinkedIn offers no API for a Page's private messages, so those stay with the owner. LinkedIn has no "hide" for a comment either:
 * moderation deletes it, which cannot be undone, so a deletion always needs the owner's own approval (never an automatic one).
 *
 * The client returns the same shapes as meta.mjs, so the tasks, the ad rules and the executors treat both platforms alike: a
 * campaign is an "ad set" (it holds the daily budget) and a creative is an "ad". Ids are LinkedIn's numeric ids; posts and comments
 * keep their URNs. An ad's "image hash" is the image URN of the post it sponsors, so a new ad can reuse its image.
 *
 * LinkedIn does not build a link preview for a post made through its API, so a post's image is uploaded first (Images API) from one of
 * the owner's approved brand images: fetched without any credential, at most 8 MB of JPEG, PNG or GIF, and sent with the token only to
 * the upload address LinkedIn returns on a linkedin.com host. An image that cannot be uploaded leaves the post without one.
 *
 * Errors carry a code the Team screen can show: linkedin_token_invalid, linkedin_permission, linkedin_rate_limited and
 * linkedin_unavailable (transient: retried), linkedin_invalid_request, linkedin_unconfirmed (a write LinkedIn may have received).
 */
const api = 'https://api.linkedin.com/rest';
const oauth = 'https://www.linkedin.com/oauth/v2/accessToken';
const readLimit = 1_000_000;
const imageLimit = 8_000_000;
// The Hub's creative-file store caps assets at 60 MiB; do not buffer arbitrary provider-sized (500 MB) videos in the worker.
const videoLimit = 60 * 1024 * 1024;
const imageUrn = value => (typeof value === 'string' && /^urn:li:image:[A-Za-z0-9_-]{1,100}$/.test(value) ? value : null);
export const linkedinVideo = value => (typeof value === 'string' && /^urn:li:video:[A-Za-z0-9_-]{1,100}$/.test(value) ? value : null);
const linkedinHost = host => host === 'linkedin.com' || host.endsWith('.linkedin.com');
const numeric = value => (typeof value === 'string' && /^\d{1,30}$/.test(value) ? value : null);
const postUrn = /^urn:li:(?:share|ugcPost):\d{1,30}$/;
const commentUrn = /^urn:li:comment:\(urn:li:(?:activity|share|ugcPost):\d{1,30},\d{1,30}\)$/;
export const linkedinPost = value => (typeof value === 'string' && postUrn.test(value) ? value : null);
export const linkedinComment = value => (typeof value === 'string' && commentUrn.test(value) ? value : null);
/** A comment URN names what it is on and its own id: urn:li:comment:(urn:li:activity:1,2) is comment 2 on activity 1. */
const commentParts = value => {
  const match = /^urn:li:comment:\((urn:li:(?:activity|share|ugcPost):\d{1,30}),(\d{1,30})\)$/.exec(linkedinComment(value) ?? '');
  return match ? { object: match[1], id: match[2] } : null;
};

const failure = (code, transient = false) => Object.assign(new Error('LinkedIn refused the request.'), { code, transient });
function codeFor(status) {
  if (status === 401) return failure('linkedin_token_invalid');
  if (status === 403) return failure('linkedin_permission');
  if (status === 429) return failure('linkedin_rate_limited', true);
  if (status >= 500) return failure('linkedin_unavailable', true);
  return failure('linkedin_invalid_request');
}

/**
 * LinkedIn's "little text" format reserves | { } @ [ ] ( ) < > # \ * _ ~ in a post's commentary: each is escaped, so nothing a draft
 * says can become a mention or markup, and a #Hashtag becomes a real hashtag.
 */
export function littleText(text) {
  // Only a # that starts a word is a hashtag; one inside a word or a link is escaped like any other reserved character.
  const parts = String(text ?? '').split(/((?<=^|\s)#[A-Za-z][A-Za-z0-9]{1,29}\b)/);
  return parts.map(part => (/^#[A-Za-z][A-Za-z0-9]{1,29}$/.test(part) ? `{hashtag|\\#|${part.slice(1)}}` : part.replace(/[|{}@[\]()<>#\\*_~]/g, char => `\\${char}`))).join('');
}

const enc = value => encodeURIComponent(value);
const dateParam = day => `(year:${day.getUTCFullYear()},month:${day.getUTCMonth() + 1},day:${day.getUTCDate()})`;
const money = amount => Math.round(Number(amount ?? 0) * 100);

export function linkedinClient({
  token = '', refreshToken = '', clientId = '', clientSecret = '',
  adsToken = '', adsRefreshToken = '', adsClientId = '', adsClientSecret = '',
  organizationId = '', adAccountId = '', version = '202609', fetchImpl = fetch, timeoutMs = 15_000,
} = {}) {
  const organization = numeric(String(organizationId ?? '').replace(/^urn:li:organization:/, ''));
  const account = numeric(String(adAccountId ?? '').replace(/^urn:li:sponsoredAccount:/, ''));
  const org = organization ? `urn:li:organization:${organization}` : null;
  const accountUrn = account ? `urn:li:sponsoredAccount:${account}` : null;
  const apiVersion = /^20\d{4}$/.test(version) ? version : '202609';
  // One credential per LinkedIn app: the Page's, and the ad account's when it has an app of its own.
  const credential = (value, refresh, id, secret) => ({
    current: typeof value === 'string' && value.length >= 20 ? value : '',
    refresh: typeof refresh === 'string' && refresh.length >= 20 && id && secret ? { refresh, id, secret } : null,
  });
  const pageAuth = credential(token, refreshToken, clientId, clientSecret);
  const ownAds = credential(adsToken, adsRefreshToken, adsClientId || clientId, adsClientSecret || clientSecret);
  const adsAuth = ownAds.current || ownAds.refresh ? ownAds : pageAuth;
  const usable = auth => Boolean(auth.current || auth.refresh);
  const configured = { page: usable(pageAuth) && Boolean(org), ads: usable(adsAuth) && Boolean(account) };

  async function readBytes(response, limit) {
    if (!response.body?.getReader) {
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > limit) throw failure('linkedin_response_too_large');
      return bytes;
    }
    const reader = response.body.getReader();
    const chunks = [];
    let bytes = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > limit) throw failure('linkedin_response_too_large');
        chunks.push(Buffer.from(value));
      }
    } finally { await reader.cancel().catch(() => {}); }
    return Buffer.concat(chunks);
  }
  const bounded = async response => (await readBytes(response, readLimit)).toString('utf8');
  const timeout = signal => (signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs));

  async function renew(auth, signal) {
    if (!auth.refresh) return false;
    let response;
    try {
      response = await fetchImpl(oauth, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: auth.refresh.refresh, client_id: auth.refresh.id, client_secret: auth.refresh.secret }).toString(),
        signal: timeout(signal) });
    } catch { return false; }
    let data = null;
    try { data = JSON.parse(await bounded(response)); } catch { data = null; }
    if (!response.ok || typeof data?.access_token !== 'string' || data.access_token.length < 20) return false;
    auth.current = data.access_token;
    return true;
  }

  /**
   * One call. `path` is built here from validated ids only; `query` is LinkedIn's Rest.li query string, already encoded. `auth` is the
   * Page's credential unless the call is for the ad account.
   */
  async function call(method, path, { query = '', body = null, headers = {}, signal, retried = false, auth = pageAuth } = {}) {
    if (!auth.current && !(await renew(auth, signal))) throw failure('linkedin_not_configured');
    const url = `${api}/${path}${query ? `?${query}` : ''}`;
    let response;
    try {
      response = await fetchImpl(url, {
        method, redirect: 'error',
        headers: { Authorization: `Bearer ${auth.current}`, 'LinkedIn-Version': apiVersion, 'X-Restli-Protocol-Version': '2.0.0', Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: timeout(signal),
      });
    } catch (error) {
      if (signal?.aborted && method === 'GET') throw error;
      throw failure(method === 'GET' ? 'linkedin_unavailable' : 'linkedin_unconfirmed', method === 'GET');
    }
    if (response.status === 401 && !retried && auth.refresh) {
      // LinkedIn did not act on a request it refused as unauthorised, so it is safe to send again once with a renewed token.
      await response.body?.cancel?.().catch(() => {});
      if (await renew(auth, signal)) return call(method, path, { query, body, headers, signal, retried: true, auth });
      throw failure('linkedin_token_invalid');
    }
    let text;
    try { text = await bounded(response); }
    catch (error) { if (method !== 'GET') throw failure('linkedin_unconfirmed'); throw error; }
    if (method !== 'GET' && response.status >= 500) throw failure('linkedin_unconfirmed');
    if (!response.ok) throw codeFor(response.status);
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = {}; }
    return { data, id: response.headers?.get?.('x-restli-id') ?? response.headers?.get?.('x-linkedin-id') ?? null };
  }
  const get = (path, query, options = {}) => call('GET', path, { ...options, query }).then(result => result.data);
  const elements = data => (Array.isArray(data?.elements) ? data.elements : []);
  const iso = ms => (Number.isFinite(Number(ms)) && Number(ms) > 0 ? new Date(Number(ms)).toISOString() : null);
  const postUrl = urn => `https://www.linkedin.com/feed/update/${urn}/`;
  const needPage = () => { if (!configured.page) throw failure('linkedin_not_configured'); };
  const needAds = () => { if (!configured.ads) throw failure('linkedin_not_configured'); };
  const campaignId = value => { const id = numeric(String(value ?? '')); if (!id) throw failure('linkedin_invalid_request'); return id; };
  const bareId = (value, prefix) => numeric(String(value ?? '').replace(prefix, ''));

  /** Uploads an approved brand image for the organization and returns its URN, or null when it cannot (the post then goes without). */
  async function uploadImage(imageUrl, auth, signal) {
    let source;
    try { source = new URL(imageUrl); } catch { return null; }
    if (source.protocol !== 'https:' || source.username || source.password || !org) return null;
    try {
      const image = await fetchImpl(source.toString(), { redirect: 'error', signal: timeout(signal) });
      const type = String(image.headers?.get?.('content-type') ?? '').split(';')[0].trim().toLowerCase();
      if (!image.ok || !['image/jpeg', 'image/png', 'image/gif'].includes(type)) { await image.body?.cancel?.().catch(() => {}); return null; }
      const bytes = await readBytes(image, imageLimit);
      const started = await call('POST', 'images', { query: 'action=initializeUpload', auth, signal, body: { initializeUploadRequest: { owner: org } } });
      const { uploadUrl, image: urn } = started.data?.value ?? {};
      const target = new URL(String(uploadUrl ?? ''));
      if (target.protocol !== 'https:' || !linkedinHost(target.hostname) || !imageUrn(urn)) return null;
      const put = await fetchImpl(target.toString(), { method: 'PUT', redirect: 'error', headers: { Authorization: `Bearer ${auth.current}`, 'Content-Type': type }, body: bytes, signal: timeout(signal) });
      await put.body?.cancel?.().catch(() => {});
      return put.ok ? urn : null;
    } catch (error) {
      if (signal?.aborted) throw error;
      return null;
    }
  }

  /**
   * The Videos API's multipart upload, using the exact byte ranges LinkedIn returns. It prepares a private media asset only; the
   * caller persists the returned URN and polls readVideo before a separate approved publish. Captions are already burned into Hub
   * creative. See https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/videos-api?view=li-lms-2026-09.
   */
  async function prepareVideo({ videoUrl }, { signal } = {}) {
    needPage();
    let source;
    try { source = new URL(videoUrl); } catch { throw failure('linkedin_invalid_video'); }
    if (source.protocol !== 'https:' || source.username || source.password || source.port || source.hash || source.search
      || !/^\/api\/creative\/a\/[0-9a-f]{64}\.mp4$/.test(source.pathname)) throw failure('linkedin_invalid_video');
    let response;
    try { response = await fetchImpl(source.toString(), { redirect: 'error', signal: timeout(signal) }); }
    catch (error) { if (signal?.aborted) throw error; throw failure('linkedin_video_unavailable', true); }
    const type = String(response.headers?.get?.('content-type') ?? '').split(';')[0].trim().toLowerCase();
    const length = Number(response.headers?.get?.('content-length'));
    if (!response.ok || type !== 'video/mp4' || length > videoLimit) {
      await response.body?.cancel?.().catch(() => {});
      throw failure('linkedin_invalid_video');
    }
    const bytes = await readBytes(response, videoLimit);
    if (bytes.length < 75_000 || bytes.toString('ascii', 4, 8) !== 'ftyp') throw failure('linkedin_invalid_video');
    const started = await call('POST', 'videos', { query: 'action=initializeUpload', signal,
      body: { initializeUploadRequest: { owner: org, fileSizeBytes: bytes.length, uploadCaptions: false, uploadThumbnail: false } } });
    const { video, uploadToken, uploadInstructions } = started.data?.value ?? {};
    if (!linkedinVideo(video) || typeof uploadToken !== 'string' || uploadToken.length > 10_000
      || !Array.isArray(uploadInstructions) || !uploadInstructions.length || uploadInstructions.length > 64) throw failure('linkedin_unconfirmed');
    // Validate every destination and range before sending any bytes or credential. Parts must cover the entire file exactly once.
    let nextByte = 0;
    const parts = uploadInstructions.map(part => {
      let target;
      try { target = new URL(part.uploadUrl); } catch { throw failure('linkedin_invalid_upload'); }
      if (target.protocol !== 'https:' || target.username || target.password || target.port || target.hash || !linkedinHost(target.hostname)
        || !Number.isSafeInteger(part.firstByte) || !Number.isSafeInteger(part.lastByte) || part.firstByte !== nextByte
        || part.lastByte < part.firstByte || part.lastByte >= bytes.length) throw failure('linkedin_invalid_upload');
      nextByte = part.lastByte + 1;
      return { url: target.toString(), first: part.firstByte, end: nextByte };
    });
    if (nextByte !== bytes.length) throw failure('linkedin_invalid_upload');
    const uploadedPartIds = [];
    for (const part of parts) {
      signal?.throwIfAborted();
      let put;
      try { put = await fetchImpl(part.url, { method: 'PUT', redirect: 'error', headers: { Authorization: `Bearer ${pageAuth.current}`, 'Content-Type': 'application/octet-stream' }, body: bytes.subarray(part.first, part.end), signal: timeout(signal) }); }
      catch { throw failure('linkedin_unconfirmed'); }
      await put.body?.cancel?.().catch(() => {});
      if (!put.ok) throw codeFor(put.status);
      const etag = put.headers?.get?.('etag')?.replace(/^"(.*)"$/, '$1');
      if (typeof etag !== 'string' || !etag.length || etag.length > 10_000 || /[\u0000-\u001f\u007f]/.test(etag)) throw failure('linkedin_unconfirmed');
      uploadedPartIds.push(etag);
    }
    await call('POST', 'videos', { query: 'action=finalizeUpload', signal, body: { finalizeUploadRequest: { video, uploadToken, uploadedPartIds } } });
    return { id: video };
  }

  async function readVideo(id, { signal } = {}) {
    needPage();
    if (!linkedinVideo(id)) throw failure('linkedin_invalid_video');
    const data = await get(`videos/${enc(id)}`, '', { signal });
    if ((data.id && data.id !== id) || (data.owner && data.owner !== org)) throw failure('linkedin_invalid_video');
    return { ready: data.status === 'AVAILABLE', failed: data.status === 'PROCESSING_FAILED' };
  }

  async function publishVideo({ videoId, message }, { signal } = {}) {
    needPage();
    if (!linkedinVideo(videoId)) throw failure('linkedin_invalid_video');
    // The durable executor waits for readVideo().ready, then records publishing intent before this one write. Do not introduce a
    // second status read after that checkpoint: a failed read would leave a known-unsent post looking uncertain.
    const result = await call('POST', 'posts', { signal, body: {
      author: org, commentary: littleText(message), visibility: 'PUBLIC',
      distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
      lifecycleState: 'PUBLISHED', isReshareDisabledByAuthor: false, content: { media: { id: videoId } },
    } });
    if (!linkedinPost(result.id)) throw failure('linkedin_unconfirmed');
    return { id: result.id };
  }

  async function pagePosts(signal) {
    const data = await get('posts', `author=${enc(org)}&q=author&count=20&sortBy=LAST_MODIFIED`, { signal });
    return elements(data).filter(item => linkedinPost(item.id) && (item.lifecycleState ?? 'PUBLISHED') === 'PUBLISHED' && !item.adContext);
  }
  async function comments(urn, signal) {
    const data = await get(`socialActions/${enc(urn)}/comments`, 'count=50', { signal });
    return elements(data).map(item => ({
      urn: linkedinComment(item.commentUrn ?? item.$URN ?? '') ?? null, actor: String(item.actor ?? ''), text: String(item.message?.text ?? ''), at: iso(item.created?.time),
      parent: typeof item.parentComment === 'string' ? item.parentComment : null,
    })).filter(item => item.urn);
  }

  return {
    configured,
    ids: { organization, account },
    prepareVideo, readVideo, publishVideo,

    /** Read-only setup check; publishing and ad changes retain their normal approval path. */
    async checkConnection({ signal } = {}) {
      if (!configured.page) throw failure('linkedin_not_configured');
      await get('posts', `author=${enc(org)}&q=author&count=1&sortBy=LAST_MODIFIED`, { signal });
      if (configured.ads) await get(`adAccounts/${account}`, '', { signal, auth: adsAuth });
    },

    async recentPosts({ signal } = {}) {
      if (!configured.page) return [];
      const posts = await pagePosts(signal);
      if (!posts.length) return [];
      const meta = await get('socialMetadata', `ids=List(${posts.map(post => enc(post.id)).join(',')})`, { signal });
      const results = meta?.results ?? {};
      return posts.map(post => {
        const social = results[post.id] ?? {};
        const reactions = Object.values(social.reactionSummaries ?? {}).reduce((sum, entry) => sum + Number(entry?.count ?? 0), 0);
        return { platform: 'linkedin', id: post.id, text: String(post.commentary ?? ''), at: iso(post.publishedAt ?? post.createdAt), url: postUrl(post.id),
          reactions, comments: Number(social.commentSummary?.count ?? 0), shares: 0 };
      });
    },

    /** New top-level comments by other people on the Page's recent posts: URNs, where and when only. */
    async recentInbox({ signal, now = new Date(), hours = 48 } = {}) {
      if (!configured.page) return [];
      const since = now.getTime() - hours * 3_600_000;
      const items = [];
      for (const post of (await pagePosts(signal)).slice(0, 10)) {
        for (const comment of await comments(post.id, signal)) {
          if (comment.actor === org || comment.parent || (Date.parse(comment.at ?? '') || 0) < since) continue;
          items.push({ platform: 'linkedin', kind: 'comment', id: comment.urn, parentId: post.id, url: postUrl(post.id), at: comment.at });
        }
      }
      return items;
    },

    /** One comment, read now: its text, and whether the Page already answered it. */
    async readItem(item, { signal } = {}) {
      if (!linkedinPost(item.parentId) || !linkedinComment(item.id)) return { gone: true };
      const found = (await comments(item.parentId, signal)).find(comment => comment.urn === item.id);
      if (!found) return { gone: true };
      // Replies to a comment are comments on the comment.
      const replies = await get(`socialActions/${enc(item.id)}/comments`, 'count=50', { signal });
      return { text: found.text, fromPage: found.actor === org, answered: elements(replies).some(reply => String(reply.actor ?? '') === org), history: [] };
    },

    /** A Page post: the text, and the link as a card with the image as its thumbnail (or the image alone without a link). */
    async publishPost({ message, link = null, linkTitle = null, imageUrl = null }, { signal } = {}) {
      needPage();
      const image = imageUrl ? await uploadImage(imageUrl, pageAuth, signal) : null;
      const content = link ? { article: { source: link, title: String(linkTitle ?? 'CareMetric').slice(0, 200), ...(image ? { thumbnail: image } : {}) } }
        : image ? { media: { id: image } } : null;
      const result = await call('POST', 'posts', { signal, body: {
        author: org, commentary: littleText(message), visibility: 'PUBLIC',
        distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
        lifecycleState: 'PUBLISHED', isReshareDisabledByAuthor: false,
        ...(content ? { content } : {}),
      } });
      return { id: String(result.id ?? ''), image: Boolean(image) };
    },

    /** A reply nested under the comment: posted on the comment, naming what the comment is on and the comment as its parent. */
    async reply({ id, parentId, message }, { signal } = {}) {
      needPage();
      const parts = commentParts(id);
      if (!linkedinPost(parentId) || !parts) throw failure('linkedin_invalid_request');
      const result = await call('POST', `socialActions/${enc(id)}/comments`, { signal, body: { actor: org, object: parts.object, parentComment: id, message: { text: message } } });
      return { id: String(result.id ?? '') };
    },

    /** Deletes another member's comment on the Page's post (LinkedIn has no "hide"). */
    async remove({ id, parentId }, { signal } = {}) {
      needPage();
      const parts = commentParts(id);
      if (!linkedinPost(parentId) || !parts) throw failure('linkedin_invalid_request');
      await call('DELETE', `socialActions/${enc(parts.object)}/comments/${parts.id}`, { signal, query: `actor=${enc(org)}` });
      return { deleted: true };
    },

    /** The ad account as the daily review needs it: campaigns as ad sets, creatives as ads with their copy, two weeks of analytics. */
    async adsOverview({ signal, now = new Date() } = {}) {
      needAds();
      const until = new Date(now.getTime() - 86_400_000);
      const windows = [[new Date(until.getTime() - 6 * 86_400_000), until], [new Date(until.getTime() - 13 * 86_400_000), new Date(until.getTime() - 7 * 86_400_000)]];
      const fields = 'impressions,clicks,landingPageClicks,costInLocalCurrency,externalWebsiteConversions,oneClickLeads,approximateMemberReach,pivotValues';
      const analytics = ([start, end]) => get('adAnalytics', `q=analytics&pivot=CREATIVE&timeGranularity=ALL&dateRange=(start:${dateParam(start)},end:${dateParam(end)})&accounts=List(${enc(accountUrn)})&fields=${fields}`, { signal, auth: adsAuth });
      const [campaigns, creatives, current, previous] = await Promise.all([
        get(`adAccounts/${account}/adCampaigns`, 'q=search&search=(status:(values:List(ACTIVE,PAUSED)))&pageSize=100', { signal, auth: adsAuth }),
        get(`adAccounts/${account}/creatives`, 'q=criteria&pageSize=100', { signal, auth: adsAuth }),
        analytics(windows[0]), analytics(windows[1]),
      ]);
      const ads = [];
      for (const creative of elements(creatives)) {
        const id = bareId(creative.id, /^urn:li:sponsoredCreative:/);
        const campaign = bareId(creative.campaign, /^urn:li:sponsoredCampaign:/);
        if (!id || !campaign) continue;
        const active = creative.intendedStatus === 'ACTIVE';
        let copy = { message: '', headline: '', description: '', link: null };
        let image = null;
        // The copy lives on the post the creative sponsors; read it for active creatives only (at most 20).
        if (active && linkedinPost(creative.content?.reference) && ads.filter(ad => ad.active).length < 20) {
          try {
            const post = await get(`posts/${enc(creative.content.reference)}`, '', { signal, auth: adsAuth });
            const article = post?.content?.article ?? {};
            copy = { message: String(post?.commentary ?? ''), headline: String(article.title ?? ''), description: String(article.description ?? ''), link: typeof article.source === 'string' ? article.source : null };
            image = imageUrn(article.thumbnail);
          } catch (error) { if (signal?.aborted) throw error; }
        }
        ads.push({ id, name: String(creative.name ?? `Creative ${id}`), adsetId: campaign, active, createdAt: iso(creative.createdAt), imageHash: image, copy });
      }
      const insight = row => {
        const reach = Number(row.approximateMemberReach ?? 0);
        const impressions = Number(row.impressions ?? 0);
        return { adId: bareId(row.pivotValues?.[0], /^urn:li:sponsoredCreative:/) ?? '', impressions,
          clicks: Number(row.landingPageClicks ?? row.clicks ?? 0), spendCents: money(row.costInLocalCurrency),
          frequency: reach > 0 ? impressions / reach : 0, results: Number(row.oneClickLeads ?? 0) + Number(row.externalWebsiteConversions ?? 0) };
      };
      return {
        adsets: elements(campaigns).map(item => ({ id: String(item.id ?? ''), name: String(item.name ?? ''), active: item.status === 'ACTIVE',
          dailyBudget: item.dailyBudget?.amount ? money(item.dailyBudget.amount) : null, currency: item.dailyBudget?.currencyCode ?? 'USD', objective: item.objectiveType ?? null, campaign: String(item.name ?? '') }))
          .filter(item => numeric(item.id)),
        ads, current: elements(current).map(insight).filter(row => row.adId), previous: elements(previous).map(insight).filter(row => row.adId),
      };
    },

    async pauseAd(creativeId, { signal } = {}) {
      needAds();
      const id = campaignId(creativeId);
      await call('POST', `adAccounts/${account}/creatives/${enc(`urn:li:sponsoredCreative:${id}`)}`,
        { signal, auth: adsAuth, headers: { 'X-RestLi-Method': 'PARTIAL_UPDATE' }, body: { patch: { $set: { intendedStatus: 'PAUSED' } } } });
      return { success: true };
    },
    async readAdset(id, { signal } = {}) {
      needAds();
      const data = await get(`adAccounts/${account}/adCampaigns/${campaignId(id)}`, '', { signal, auth: adsAuth });
      return { id: String(data.id ?? ''), dailyBudget: data.dailyBudget?.amount ? money(data.dailyBudget.amount) : null, currency: data.dailyBudget?.currencyCode ?? 'USD', active: data.status === 'ACTIVE' };
    },
    async setDailyBudget(id, cents, { currency = 'USD', signal } = {}) {
      needAds();
      if (!Number.isInteger(cents) || cents <= 0 || !/^[A-Z]{3}$/.test(currency)) throw failure('linkedin_invalid_request');
      await call('POST', `adAccounts/${account}/adCampaigns/${campaignId(id)}`,
        { signal, auth: adsAuth, headers: { 'X-RestLi-Method': 'PARTIAL_UPDATE' }, body: { patch: { $set: { dailyBudget: { amount: (cents / 100).toFixed(2), currencyCode: currency } } } } });
      return { success: true };
    },

    /**
     * A new creative in a campaign: a sponsored-only post (not on the Page's feed) carrying the copy, the link and the image (the image
     * URN of the ad it is based on, or an approved brand image uploaded now), then the creative.
     */
    async createAd({ adsetId, message, headline, description, link, imageHash = null, imageUrl = null }, { signal } = {}) {
      needAds();
      if (!org) throw failure('linkedin_not_configured');
      const campaign = campaignId(adsetId);
      const thumbnail = imageUrn(imageHash) ?? (imageUrl ? await uploadImage(imageUrl, adsAuth, signal) : null);
      // The sponsored-only post is the ad account's work, so it goes with the ad account's credential.
      const post = await call('POST', 'posts', { signal, auth: adsAuth, body: {
        author: org, commentary: littleText(message), visibility: 'PUBLIC',
        distribution: { feedDistribution: 'NONE', targetEntities: [], thirdPartyDistributionChannels: [] },
        content: { article: { source: link, title: headline, description, ...(thumbnail ? { thumbnail } : {}) } },
        adContext: { dscAdAccount: accountUrn, dscStatus: 'ACTIVE' }, lifecycleState: 'PUBLISHED', isReshareDisabledByAuthor: true,
      } });
      if (!linkedinPost(post.id)) throw failure('linkedin_unconfirmed');
      // The sponsored-only post exists now; if LinkedIn does not confirm the creative, the owner is asked to look before a retry.
      let creative;
      try { creative = await call('POST', `adAccounts/${account}/creatives`, { signal, auth: adsAuth, body: { campaign: `urn:li:sponsoredCampaign:${campaign}`, content: { reference: post.id }, intendedStatus: 'ACTIVE' } }); }
      catch (error) { if (signal?.aborted || error?.code === 'linkedin_unconfirmed') throw error; throw Object.assign(failure(error?.code ?? 'linkedin_invalid_request'), { postId: post.id }); }
      return { id: bareId(creative.id, /^urn:li:sponsoredCreative:/) ?? String(creative.id ?? ''), postId: post.id };
    },
  };
}
