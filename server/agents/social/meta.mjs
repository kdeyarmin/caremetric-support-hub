/**
 * The Social Media Manager's only path to Meta: the Graph API for CareMetric's Facebook Page, its Instagram professional account and
 * its ad account. Server-only. The token (a system user token from the owner's Meta Business account, HUB_META_ACCESS_TOKEN) is sent
 * only to graph.facebook.com or graph-video.facebook.com and never logged, stored or put in an error. Every read is bounded (15 seconds, 1 MB) and every call is
 * one HTTPS request to a fixed host; nothing a comment, a message or a model says can choose a host or a path.
 *
 * Comments and messages are read when they are handled and returned to the caller only: this module keeps nothing.
 *
 * Errors carry a code the Team screen can show: meta_token_invalid (expired or revoked token), meta_permission (a permission the
 * token lacks), meta_rate_limited and meta_unavailable (transient: the scheduler retries), meta_invalid_request and meta_error.
 */
const host = 'https://graph.facebook.com';
const readLimit = 1_000_000;
const idPattern = /^[0-9]{1,40}(?:_[0-9]{1,40})?$/;

const failure = (code, transient = false) => Object.assign(new Error('Meta refused the request.'), { code, transient });
/** Whether a platform's video is published by its upload (a Facebook Page video), so a later processing timeout is not a failure. */
export const videoPublishedOnUpload = platform => platform === 'facebook';
function codeFor(status, error) {
  const code = Number(error?.code);
  if (code === 190 || code === 102) return failure('meta_token_invalid');
  if ([4, 17, 32, 613, 80000, 80001, 80002, 80003, 80004, 80005, 80006, 80008, 80009, 80014].includes(code)) return failure('meta_rate_limited', true);
  if (code === 10 || (code >= 200 && code <= 299)) return failure('meta_permission');
  if (code === 1 || code === 2 || status >= 500) return failure('meta_unavailable', true);
  if (code === 100 || status === 400) return failure('meta_invalid_request');
  return failure('meta_error');
}
export const metaId = value => (typeof value === 'string' && idPattern.test(value) ? value : null);

export function metaClient({ token = '', pageId = '', instagramId = '', adAccountId = '', version = 'v23.0', fetchImpl = fetch, timeoutMs = 15_000 } = {}) {
  const page = metaId(pageId);
  const instagram = metaId(instagramId);
  const account = metaId(String(adAccountId ?? '').replace(/^act_/, ''));
  const graph = /^v\d{1,2}\.\d$/.test(version) ? version : 'v23.0';
  const hasToken = typeof token === 'string' && token.length >= 20;
  const configured = { pages: hasToken && Boolean(page), instagram: hasToken && Boolean(page) && Boolean(instagram), ads: hasToken && Boolean(account) };
  let pageToken = null;

  async function request(method, path, params = {}, { as = 'system', signal, videoUpload = false } = {}) {
    if (!hasToken) throw failure('meta_not_configured');
    if (!/^[A-Za-z0-9_/]+$/.test(path)) throw failure('meta_invalid_request');
    const credential = as === 'page' ? await tokenForPage(signal) : token;
    const values = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null) values.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
    values.set('access_token', credential);
    const destination = videoUpload ? 'https://graph-video.facebook.com' : host;
    const url = method === 'GET' ? `${destination}/${graph}/${path}?${values}` : `${destination}/${graph}/${path}`;
    let response;
    try {
      response = await fetchImpl(url, {
        method, redirect: 'error', headers: { Accept: 'application/json', ...(method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
        ...(method === 'POST' ? { body: values.toString() } : {}),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (signal?.aborted && method === 'GET') throw error;
      // A POST that may have reached Meta is not known to have failed: the caller says so instead of trying again.
      throw failure(method === 'POST' ? 'meta_unconfirmed' : 'meta_unavailable', method !== 'POST');
    }
    let text;
    try { text = await readBounded(response); }
    catch (error) { if (method === 'POST') throw failure('meta_unconfirmed'); throw error; }
    let data = null;
    try { data = text ? JSON.parse(text) : {}; } catch { data = null; }
    // A write can have reached Meta before its response fails. Never replay it as a transient read failure.
    if (method === 'POST' && (response.status >= 500 || !data)) throw failure('meta_unconfirmed');
    if (!response.ok || !data || data.error) throw codeFor(response.status, data?.error);
    return data;
  }

  async function readBounded(response) {
    if (!response.body?.getReader) return response.text();
    const reader = response.body.getReader();
    const chunks = [];
    let bytes = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > readLimit) throw failure('meta_response_too_large');
        chunks.push(Buffer.from(value));
      }
    } finally { await reader.cancel().catch(() => {}); }
    return Buffer.concat(chunks).toString('utf8');
  }

  // A system user token reads the Page's own token; a Page token given directly has none to read and is used as it is.
  async function tokenForPage(signal) {
    if (pageToken) return pageToken;
    const data = await request('GET', page, { fields: 'access_token' }, { signal });
    pageToken = typeof data.access_token === 'string' && data.access_token.length >= 20 ? data.access_token : token;
    return pageToken;
  }

  const get = (path, params, options) => request('GET', path, params, options);
  const post = (path, params, options) => request('POST', path, params, options);
  const list = data => (Array.isArray(data?.data) ? data.data : []);
  const regionCache = new Map();
  /**
   * Meta's region keys for US states, found by its location search (`search?type=adgeolocation`), never written by hand. `states` is
   * [{ code, name }]. Each key is kept for the life of the process. A state with no exact US region match fails as meta_geo_unresolved.
   */
  async function regionKeys(states, { signal } = {}) {
    const keys = [];
    for (const state of states) {
      const code = String(state?.code ?? '');
      const wanted = String(state?.name ?? '');
      if (!/^[A-Z]{2}$/.test(code) || !wanted) throw failure('meta_geo_unresolved');
      if (!regionCache.has(code)) {
        const data = await get('search', { type: 'adgeolocation', location_types: '["region"]', q: wanted, country_code: 'US', limit: 10 }, { signal });
        const match = list(data).find(item => item.type === 'region' && item.country_code === 'US' && String(item.name ?? '').toLowerCase() === wanted.toLowerCase() && /^[0-9]{1,10}$/.test(String(item.key ?? '')));
        if (!match) throw failure('meta_geo_unresolved');
        regionCache.set(code, String(match.key));
      }
      keys.push(regionCache.get(code));
    }
    return keys;
  }
  const at = value => { const time = Date.parse(value ?? ''); return Number.isFinite(time) ? new Date(time).toISOString() : null; };
  // A video mutation can have reached Meta even if its response is unreadable or a server error. Never retry such a mutation.
  const mutateVideo = async work => {
    try { return await work(); } catch (error) {
      if (error?.transient || ['meta_error', 'meta_response_too_large'].includes(error?.code) || !error?.code) throw failure('meta_unconfirmed');
      throw error;
    }
  };

  return {
    configured,
    ids: { page, instagram, account },

    /** Read-only setup check. Never publish, send a message or change an ad. */
    async checkConnection({ signal, includeAds = true } = {}) {
      if (!configured.pages) throw failure('meta_not_configured');
      await get(`${page}/posts`, { fields: 'id', limit: 1 }, { as: 'page', signal });
      if (configured.instagram) await get(`${instagram}/media`, { fields: 'id', limit: 1 }, { signal });
      if (includeAds && configured.ads) await get(`act_${account}`, { fields: 'id' }, { signal });
    },

    /** Recent posts with their public engagement counts (reactions or likes, comments, shares). Our own words only. */
    async recentPosts({ signal } = {}) {
      const posts = [];
      if (configured.pages) {
        const data = await get(`${page}/posts`, { fields: 'id,message,created_time,permalink_url,reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0),shares', limit: 25 }, { as: 'page', signal });
        for (const item of list(data)) posts.push({ platform: 'facebook', id: String(item.id), text: String(item.message ?? ''), at: at(item.created_time), url: item.permalink_url ?? null,
          reactions: Number(item.reactions?.summary?.total_count ?? 0), comments: Number(item.comments?.summary?.total_count ?? 0), shares: Number(item.shares?.count ?? 0) });
      }
      if (configured.instagram) {
        const data = await get(`${instagram}/media`, { fields: 'id,caption,timestamp,permalink,like_count,comments_count', limit: 25 }, { signal });
        for (const item of list(data)) posts.push({ platform: 'instagram', id: String(item.id), text: String(item.caption ?? ''), at: at(item.timestamp), url: item.permalink ?? null,
          reactions: Number(item.like_count ?? 0), comments: Number(item.comments_count ?? 0), shares: 0 });
      }
      return posts;
    },

    /** New comments and messages from other people: ids, where and when only. Their words are read by `readItem`. */
    async recentInbox({ signal, now = new Date(), hours = 48, adComments = false } = {}) {
      const since = now.getTime() - hours * 3_600_000;
      const items = [];
      const recent = value => (Date.parse(value ?? '') || 0) >= since;
      // Comments on running ads (Settings → Social media → "Read and answer comments on ads", team review 2026-11-17, stage 6): an ad's post
      // is not in the Page's feed, so the active ads' posts (their creative's effective_object_story_id) are read too, at most five.
      // Reading them is extra: when Meta refuses or fails it (the ad account's access, a rate limit), only the ad comments not yet read
      // wait for the next run (the inbox looks back 48 hours); the Page's comments, Messenger and Instagram are still read.
      if (adComments && configured.ads && configured.pages) {
        try {
          const ads = await get(`act_${account}/ads`, { fields: 'id,effective_status,creative{effective_object_story_id}', effective_status: '["ACTIVE"]', limit: 25 }, { signal });
          const stories = [...new Set(list(ads).map(item => String(item.creative?.effective_object_story_id ?? '')).filter(id => /^[0-9]{1,40}_[0-9]{1,40}$/.test(id)))].slice(0, 5);
          for (const story of stories) {
            const data = await get(`${story}/comments`, { fields: 'id,created_time,from{id},permalink_url', order: 'reverse_chronological', limit: 25 }, { as: 'page', signal });
            for (const comment of list(data)) {
              if (String(comment.from?.id ?? '') === page || !recent(comment.created_time) || !metaId(String(comment.id))) continue;
              items.push({ platform: 'facebook', kind: 'comment', id: String(comment.id), parentId: story, url: comment.permalink_url ?? null, at: at(comment.created_time), ad: true });
            }
          }
        } catch (error) {
          if (signal?.aborted) throw error;
        }
      }
      if (configured.pages) {
        const feed = await get(`${page}/feed`, { fields: 'id,permalink_url,comments.order(reverse_chronological).limit(25){id,created_time,from{id},permalink_url}', limit: 10 }, { as: 'page', signal });
        for (const postItem of list(feed)) for (const comment of list(postItem.comments)) {
          if (String(comment.from?.id ?? '') === page || !recent(comment.created_time) || !metaId(String(comment.id))) continue;
          // An ad made from a published Page post: its comments were read above, marked as on an ad.
          if (items.some(item => item.platform === 'facebook' && item.id === String(comment.id))) continue;
          items.push({ platform: 'facebook', kind: 'comment', id: String(comment.id), parentId: String(postItem.id), url: comment.permalink_url ?? postItem.permalink_url ?? null, at: at(comment.created_time) });
        }
        const inbox = await get(`${page}/conversations`, { platform: 'messenger', fields: 'id,updated_time,messages.limit(1){id,from{id},created_time}', limit: 20 }, { as: 'page', signal });
        for (const conversation of list(inbox)) {
          const latest = list(conversation.messages)[0];
          if (!latest || String(latest.from?.id ?? '') === page || !recent(latest.created_time)) continue;
          items.push({ platform: 'messenger', kind: 'message', id: String(latest.id).slice(0, 150), parentId: String(conversation.id).slice(0, 150), url: null, at: at(latest.created_time) });
        }
      }
      if (configured.instagram) {
        const media = await get(`${instagram}/media`, { fields: 'id,permalink,comments.limit(25){id,timestamp,from{id}}', limit: 10 }, { signal });
        for (const postItem of list(media)) for (const comment of list(postItem.comments)) {
          if (String(comment.from?.id ?? '') === instagram || !recent(comment.timestamp) || !metaId(String(comment.id))) continue;
          items.push({ platform: 'instagram', kind: 'comment', id: String(comment.id), parentId: String(postItem.id), url: postItem.permalink ?? null, at: at(comment.timestamp) });
        }
      }
      return items;
    },

    /**
     * One comment or message, read now: its text, whether it is still the newest and unanswered, and who to reply to. For a message,
     * up to two earlier messages too. `{ gone: true }` when it was deleted or cannot be read any more.
     */
    async readItem(item, { signal, now = new Date() } = {}) {
      if (item.kind === 'comment' && item.platform === 'facebook') {
        const data = await get(item.id, { fields: 'message,created_time,from{id},comments.limit(25){from{id}}' }, { as: 'page', signal });
        return { text: String(data.message ?? ''), fromPage: String(data.from?.id ?? '') === page, answered: list(data.comments).some(reply => String(reply.from?.id ?? '') === page), history: [] };
      }
      if (item.kind === 'comment' && item.platform === 'instagram') {
        const data = await get(item.id, { fields: 'text,timestamp,from{id},replies{from{id}}' }, { signal });
        return { text: String(data.text ?? ''), fromPage: String(data.from?.id ?? '') === instagram, answered: list(data.replies).some(reply => String(reply.from?.id ?? '') === instagram), history: [] };
      }
      if (item.kind === 'message') {
        const data = await get(item.parentId, { fields: 'messages.limit(5){id,message,from{id},created_time}' }, { as: 'page', signal });
        const messages = list(data.messages);
        const latest = messages[0];
        if (!latest) return { gone: true };
        const own = id => String(id ?? '') === page || String(id ?? '') === instagram;
        // Meta allows a reply to a message within 24 hours of the person's last message.
        const open = now.getTime() - (Date.parse(latest.created_time ?? '') || 0) < 23.5 * 3_600_000;
        return {
          text: String(latest.message ?? ''), fromPage: own(latest.from?.id), answered: String(latest.id) !== item.id || own(latest.from?.id), recipient: metaId(String(latest.from?.id ?? '')), open,
          history: messages.slice(1, 3).reverse().map(message => ({ direction: own(message.from?.id) ? 'outbound' : 'inbound', text: String(message.message ?? '') })),
        };
      }
      return { gone: true };
    },

    async publishPost({ platform, message, link = null, imageUrl = null }, { signal } = {}) {
      // A Facebook post with an approved image is a photo post (Page photos, the caption its message, which carries the link); without
      // one, a link post as before (team review 2026-11-17, stage 6).
      if (platform === 'facebook' && imageUrl) {
        if (!/^https:\/\//.test(imageUrl)) throw failure('meta_invalid_request');
        const photo = await post(`${page}/photos`, { url: imageUrl, message, published: true }, { as: 'page', signal });
        return { id: String(photo.post_id ?? photo.id ?? '') };
      }
      if (platform === 'facebook') return { id: String((await post(`${page}/feed`, { message, ...(link ? { link } : {}) }, { as: 'page', signal })).id ?? '') };
      if (platform === 'instagram') {
        const created = await post(`${instagram}/media`, { image_url: imageUrl, caption: message }, { signal });
        return { id: String((await post(`${instagram}/media_publish`, { creation_id: created.id }, { signal })).id ?? '') };
      }
      throw failure('meta_invalid_request');
    },

    /**
     * A story from an approved 1080×1920 image (shown for 24 hours): on Instagram a STORIES container published like a post; on the
     * Facebook Page the photo uploaded unpublished, then posted as a photo story.
     */
    async publishStory({ platform, imageUrl }, { signal } = {}) {
      if (platform === 'instagram') {
        const created = await post(`${instagram}/media`, { image_url: imageUrl, media_type: 'STORIES' }, { signal });
        return { id: String((await post(`${instagram}/media_publish`, { creation_id: created.id }, { signal })).id ?? '') };
      }
      if (platform === 'facebook') {
        const photo = await post(`${page}/photos`, { url: imageUrl, published: false }, { as: 'page', signal });
        const story = await post(`${page}/photo_stories`, { photo_id: photo.id }, { as: 'page', signal });
        return { id: String(story.post_id ?? photo.id ?? '') };
      }
      throw failure('meta_invalid_request');
    },

    /**
     * Upload a Page video, or stage an Instagram Reel container. Its id is persisted before any later processing check.
     *
     * A Page video is uploaded and published in one request (review 2026-11-19). Meta documents creating and publishing a Page video
     * together, with the pages_manage_posts access the Page's photo posts already use. An unpublished Page video is documented only as
     * an ads post, with no way to publish it later: the November 17 video uploaded and processed, then switching it to published was
     * refused as meta_permission. So `publishVideo` sends nothing for Facebook; Meta shows the post once processing ends.
     */
    async prepareVideo({ platform, videoUrl, message }, { signal } = {}) {
      let url;
      try { url = new URL(videoUrl); } catch { throw failure('meta_invalid_request'); }
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !/^\/api\/creative\/a\/[0-9a-f]{64}\.mp4$/.test(url.pathname)) throw failure('meta_invalid_request');
      let created;
      if (platform === 'facebook' && configured.pages) created = await mutateVideo(() => post(`${page}/videos`, { file_url: videoUrl, published: true, description: message }, { as: 'page', signal, videoUpload: true }));
      else if (platform === 'instagram' && configured.instagram) created = await mutateVideo(() => post(`${instagram}/media`, { media_type: 'REELS', video_url: videoUrl, caption: message, share_to_feed: true }, { signal }));
      else throw failure('meta_not_configured');
      if (!metaId(created.id)) throw failure('meta_unconfirmed');
      return { id: created.id };
    },

    async readVideo(id, { platform, signal } = {}) {
      if (!metaId(id)) throw failure('meta_invalid_request');
      if (platform === 'instagram') {
        const state = (await get(id, { fields: 'status_code' }, { signal })).status_code;
        return { ready: state === 'FINISHED', failed: ['ERROR', 'EXPIRED'].includes(state) };
      }
      if (platform !== 'facebook') throw failure('meta_invalid_request');
      const state = (await get(id, { fields: 'status' }, { as: 'page', signal })).status?.video_status;
      return { ready: state === 'ready', failed: ['error', 'expired', 'upload_failed'].includes(state) };
    },

    /**
     * Called once only after a ready state and a durable publishing intent. A Reel is published here; a Page video was published by its
     * upload (prepareVideo), so for Facebook this only returns its id, with no request to Meta.
     */
    async publishVideo({ platform, videoId }, { signal } = {}) {
      if (!metaId(videoId)) throw failure('meta_invalid_request');
      if (platform === 'instagram') {
        const published = await mutateVideo(() => post(`${instagram}/media_publish`, { creation_id: videoId }, { signal }));
        if (!metaId(published.id)) throw failure('meta_unconfirmed');
        return { id: published.id };
      }
      if (platform !== 'facebook') throw failure('meta_invalid_request');
      return { id: videoId };
    },

    async reply({ platform, kind, id, recipient = null, message }, { signal } = {}) {
      if (kind === 'comment' && platform === 'facebook') return { id: String((await post(`${id}/comments`, { message }, { as: 'page', signal })).id ?? '') };
      if (kind === 'comment' && platform === 'instagram') return { id: String((await post(`${id}/replies`, { message }, { signal })).id ?? '') };
      if (kind === 'message' && metaId(recipient)) {
        return { id: String((await post(`${page}/messages`, { recipient: { id: recipient }, messaging_type: 'RESPONSE', message: { text: message } }, { as: 'page', signal })).message_id ?? '') };
      }
      throw failure('meta_invalid_request');
    },

    async hide({ platform, id }, { signal } = {}) {
      if (platform === 'facebook') return post(id, { is_hidden: true }, { as: 'page', signal });
      if (platform === 'instagram') return post(id, { hide: true }, { signal });
      throw failure('meta_invalid_request');
    },

    /** The ad account as the daily review needs it: ad sets, ads with their copy, and two seven-day windows of insights. */
    async adsOverview({ signal, now = new Date() } = {}) {
      const day = iso => iso.toISOString().slice(0, 10);
      const until = new Date(now.getTime() - 86_400_000);
      const windows = [[new Date(until.getTime() - 6 * 86_400_000), until], [new Date(until.getTime() - 13 * 86_400_000), new Date(until.getTime() - 7 * 86_400_000)]];
      const [adsets, ads, current, previous] = await Promise.all([
        get(`act_${account}/adsets`, { fields: 'id,name,status,effective_status,daily_budget,lifetime_budget,campaign{name,objective}', limit: 100 }, { signal }),
        get(`act_${account}/ads`, { fields: 'id,name,status,effective_status,adset_id,created_time,creative{id,image_hash,object_story_spec}', limit: 200 }, { signal }),
        ...windows.map(([since, end]) => get(`act_${account}/insights`, { level: 'ad', fields: 'ad_id,impressions,inline_link_clicks,spend,frequency,actions', time_range: { since: day(since), until: day(end) }, limit: 500 }, { signal })),
      ]);
      return {
        adsets: list(adsets).map(item => ({ id: String(item.id), name: String(item.name ?? ''), active: item.effective_status === 'ACTIVE', dailyBudget: item.daily_budget ? Number(item.daily_budget) : null, objective: item.campaign?.objective ?? null, campaign: item.campaign?.name ?? '' })),
        ads: list(ads).map(item => {
          const link = item.creative?.object_story_spec?.link_data ?? {};
          return { id: String(item.id), name: String(item.name ?? ''), adsetId: String(item.adset_id ?? ''), active: item.effective_status === 'ACTIVE', createdAt: at(item.created_time),
            imageHash: typeof link.image_hash === 'string' ? link.image_hash : (typeof item.creative?.image_hash === 'string' ? item.creative.image_hash : null),
            copy: { message: String(link.message ?? ''), headline: String(link.name ?? ''), description: String(link.description ?? ''), link: typeof link.link === 'string' ? link.link : null } };
        }),
        current: list(current).map(insight), previous: list(previous).map(insight),
      };
    },

    pauseAd: (adId, { signal } = {}) => post(adId, { status: 'PAUSED' }, { signal }),
    setDailyBudget: (adsetId, cents, { signal } = {}) => post(adsetId, { daily_budget: cents }, { signal }),
    async readAdset(adsetId, { signal } = {}) {
      const data = await get(adsetId, { fields: 'id,daily_budget,effective_status' }, { signal });
      return { id: String(data.id ?? ''), dailyBudget: data.daily_budget ? Number(data.daily_budget) : null, active: data.effective_status === 'ACTIVE' };
    },
    // An image is the base ad's image hash or, for an approved Creative Director asset, its address (Meta fetches it: link_data.picture).
    /**
     * A new campaign and its ad set, both PAUSED: traffic to the landing page, shown only to the retargeting audience (website visitors),
     * with the approved daily budget on the ad set. The owner starts it in Ads Manager or by approving an ad into it. `endAt` (a launch
     * the owner handed over) ends the ad set then, so it can never spend past its month.
     */
    async createCampaign({ name, dailyBudgetCents, lifetimeBudgetCents = null, audienceId, startAt = null, endAt = null, states = [] }, { signal } = {}) {
      if (!configured.ads) throw failure('meta_not_configured');
      if (!Number.isInteger(dailyBudgetCents) || dailyBudgetCents < 100 || !/^[0-9]{5,30}$/.test(String(audienceId ?? ''))) throw failure('meta_invalid_request');
      const end = endAt === null ? null : Date.parse(endAt);
      if (end !== null && !(Number.isFinite(end) && end > Date.now())) throw failure('meta_invalid_request');
      const start = startAt === null ? null : Date.parse(startAt);
      if (lifetimeBudgetCents !== null && (!Number.isInteger(lifetimeBudgetCents) || lifetimeBudgetCents < dailyBudgetCents
        || !Number.isFinite(start) || !Number.isFinite(end) || end <= start)) throw failure('meta_invalid_request');
      // Limited to the roster's states (team review 2026-11-17, stage 6), each found through Meta's own location search before anything
      // is created: a state it cannot name stops the campaign rather than letting it run nationwide.
      const geo = states.length ? { regions: (await regionKeys(states, { signal })).map(key => ({ key })) } : { countries: ['US'] };
      const campaign = await post(`act_${account}/campaigns`, { name: name.slice(0, 100), objective: 'OUTCOME_TRAFFIC', status: 'PAUSED',
        special_ad_categories: [], is_adset_budget_sharing_enabled: false }, { signal });
      if (!metaId(campaign.id)) throw failure('meta_unconfirmed');
      const adset = await post(`act_${account}/adsets`, { name: name.slice(0, 100), campaign_id: campaign.id, status: 'PAUSED',
        ...(lifetimeBudgetCents === null ? { daily_budget: dailyBudgetCents } : { lifetime_budget: lifetimeBudgetCents, start_time: Math.floor(start / 1000) }),
        billing_event: 'IMPRESSIONS', optimization_goal: 'LINK_CLICKS', bid_strategy: 'LOWEST_COST_WITHOUT_CAP', destination_type: 'WEBSITE',
        targeting: { custom_audiences: [{ id: String(audienceId) }], geo_locations: geo }, ...(end === null ? {} : { end_time: Math.floor(end / 1000) }) }, { signal });
      if (!metaId(adset.id)) throw failure('meta_unconfirmed');
      return { campaignId: String(campaign.id ?? ''), adsetId: String(adset.id ?? '') };
    },

    regionKeys,

    /** Starts a campaign created paused, once its first ad is in it: the ad set, then the campaign. Used only for a launch the owner handed over. */
    async startCampaign({ campaignId, adsetId }, { signal } = {}) {
      if (!configured.ads) throw failure('meta_not_configured');
      if (!metaId(String(campaignId ?? '')) || !metaId(String(adsetId ?? ''))) throw failure('meta_invalid_request');
      if ((await post(adsetId, { status: 'ACTIVE' }, { signal })).success !== true) throw failure('meta_unconfirmed');
      if ((await post(campaignId, { status: 'ACTIVE' }, { signal })).success !== true) throw failure('meta_unconfirmed');
      return { started: true };
    },

    /** One lead from a Meta ad click, reported to the Pixel's dataset by a hashed email and the click (Conversions API). */
    async sendConversion({ pixelId, eventName, eventId, eventTime, emailHash, fbclid, clickedAt }, { signal } = {}) {
      if (!/^[0-9]{5,30}$/.test(String(pixelId ?? '')) || !/^[a-f0-9]{64}$/.test(emailHash ?? '')) throw failure('meta_invalid_request');
      const data = [{ event_name: eventName, event_time: eventTime, event_id: eventId, action_source: 'website',
        user_data: { em: [emailHash], ...(fbclid ? { fbc: `fb.1.${clickedAt}.${fbclid}` } : {}) } }];
      const answer = await post(`${pixelId}/events`, { data }, { signal });
      return { received: Number(answer.events_received ?? 0) };
    },

    async createAd({ adsetId, name, message, headline, description, link, imageHash, imageUrl = null, callToAction }, { signal } = {}) {
      const creative = await post(`act_${account}/adcreatives`, {
        name: name.slice(0, 100),
        object_story_spec: { page_id: page, link_data: { link, message, name: headline, description, ...(imageHash ? { image_hash: imageHash } : imageUrl ? { picture: imageUrl } : {}), call_to_action: { type: callToAction, value: { link } } } },
      }, { signal });
      if (!metaId(creative.id)) throw failure('meta_unconfirmed');
      const ad = await post(`act_${account}/ads`, { name: name.slice(0, 100), adset_id: adsetId, creative: { creative_id: creative.id }, status: 'ACTIVE' }, { signal });
      if (!metaId(ad.id)) throw failure('meta_unconfirmed');
      return { id: String(ad.id ?? ''), creativeId: String(creative.id ?? '') };
    },
  };
}

// Results are leads and sign-ups, whichever the ad was optimized for; clicks are clicks to the destination.
const resultActions = new Set(['lead', 'onsite_conversion.lead_grouped', 'offsite_conversion.fb_pixel_lead', 'complete_registration', 'offsite_conversion.fb_pixel_complete_registration']);
function insight(row) {
  const results = (Array.isArray(row.actions) ? row.actions : []).filter(action => resultActions.has(action.action_type)).reduce((sum, action) => sum + Number(action.value ?? 0), 0);
  return { adId: String(row.ad_id ?? ''), impressions: Number(row.impressions ?? 0), clicks: Number(row.inline_link_clicks ?? 0), spendCents: Math.round(Number(row.spend ?? 0) * 100), frequency: Number(row.frequency ?? 0), results };
}
