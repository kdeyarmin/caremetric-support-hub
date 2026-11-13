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
      if (signal?.aborted) throw error;
      // A POST that may have reached Meta is not known to have failed: the caller says so instead of trying again.
      throw failure(method === 'POST' ? 'meta_unconfirmed' : 'meta_unavailable', method !== 'POST');
    }
    const text = await readBounded(response);
    let data = null;
    try { data = text ? JSON.parse(text) : {}; } catch { data = null; }
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
    async checkConnection({ signal } = {}) {
      if (!configured.pages) throw failure('meta_not_configured');
      await get(`${page}/posts`, { fields: 'id', limit: 1 }, { as: 'page', signal });
      if (configured.instagram) await get(`${instagram}/media`, { fields: 'id', limit: 1 }, { signal });
      if (configured.ads) await get(`act_${account}`, { fields: 'id' }, { signal });
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
    async recentInbox({ signal, now = new Date(), hours = 48 } = {}) {
      const since = now.getTime() - hours * 3_600_000;
      const items = [];
      const recent = value => (Date.parse(value ?? '') || 0) >= since;
      if (configured.pages) {
        const feed = await get(`${page}/feed`, { fields: 'id,permalink_url,comments.order(reverse_chronological).limit(25){id,created_time,from{id},permalink_url}', limit: 10 }, { as: 'page', signal });
        for (const postItem of list(feed)) for (const comment of list(postItem.comments)) {
          if (String(comment.from?.id ?? '') === page || !recent(comment.created_time) || !metaId(String(comment.id))) continue;
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

    /** Stage an unpublished Page video or Instagram Reel container. Its id is persisted before any later processing check. */
    async prepareVideo({ platform, videoUrl, message }, { signal } = {}) {
      let url;
      try { url = new URL(videoUrl); } catch { throw failure('meta_invalid_request'); }
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !/^\/api\/creative\/a\/[0-9a-f]{64}\.mp4$/.test(url.pathname)) throw failure('meta_invalid_request');
      let created;
      if (platform === 'facebook' && configured.pages) created = await mutateVideo(() => post(`${page}/videos`, { file_url: videoUrl, published: false, description: message }, { as: 'page', signal, videoUpload: true }));
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

    /** Called once only after a ready state and a durable publishing intent. */
    async publishVideo({ platform, videoId, message }, { signal } = {}) {
      if (!metaId(videoId)) throw failure('meta_invalid_request');
      if (platform === 'instagram') {
        const published = await mutateVideo(() => post(`${instagram}/media_publish`, { creation_id: videoId }, { signal }));
        if (!metaId(published.id)) throw failure('meta_unconfirmed');
        return { id: published.id };
      }
      if (platform !== 'facebook') throw failure('meta_invalid_request');
      const published = await mutateVideo(() => post(videoId, { published: true, description: message }, { as: 'page', signal }));
      if (published.success !== true && published.id !== videoId) throw failure('meta_unconfirmed');
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
    async createAd({ adsetId, name, message, headline, description, link, imageHash, imageUrl = null, callToAction }, { signal } = {}) {
      const creative = await post(`act_${account}/adcreatives`, {
        name: name.slice(0, 100),
        object_story_spec: { page_id: page, link_data: { link, message, name: headline, description, ...(imageHash ? { image_hash: imageHash } : imageUrl ? { picture: imageUrl } : {}), call_to_action: { type: callToAction, value: { link } } } },
      }, { signal });
      const ad = await post(`act_${account}/ads`, { name: name.slice(0, 100), adset_id: adsetId, creative: { creative_id: creative.id }, status: 'ACTIVE' }, { signal });
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
