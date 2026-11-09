/**
 * The HeyGen adapter: a presenter video read from the asset's own copy. It is used only when Settings → Creative → "How videos are made"
 * says HeyGen and HUB_HEYGEN_API_KEY (a secret, in Railway) is set, and only for a product whose brand kit names a HeyGen avatar and voice; otherwise the internal renderer
 * makes every video. HeyGen renders in the background: `submit` starts a render and returns its id, the render task checks `status` on
 * its next runs, and `download` fetches the finished file from HeyGen's own asset hosts only.
 *
 * What HeyGen is sent: the script (the headline, the beats and the call to action: CareMetric's own words, already checked), the avatar
 * and voice ids, a background color and the size. Never anything a customer wrote. Captions are asked for, and the captioned file is the
 * one kept; a render HeyGen returns without one is blocked like any video without captions. The key never reaches a log, an error or a
 * stored result. Each render HeyGen is asked for is written to the AI usage ledger (model `heygen`).
 */
// HeyGen's asset hosts, the same list bulk media import trusts (server/learning-media-import.mjs, DEFAULT_MEDIA_IMPORT_HOSTS).
export const heygenHosts = Object.freeze(['resource2.heygen.ai', 'files.heygen.ai', 'files2.heygen.ai']);
const api = 'https://api.heygen.com';
const maxBytes = 60 * 1024 * 1024;
const failure = (code, transient = false) => Object.assign(new Error('HeyGen could not make the video.'), { code, transient });

/** Spoken words for a video: about 2.4 words a second, so a 15-second video is about 36 words. */
export function heygenScript(content, seconds) {
  const lines = [content.headline, ...(Array.isArray(content.overlay?.beats) ? content.overlay.beats : []), content.cta ? `${content.cta}.` : ''].map(line => String(line ?? '').trim()).filter(Boolean);
  const budget = Math.max(10, Math.round(seconds * 2.4));
  const words = [];
  for (const line of lines) {
    const next = line.split(/\s+/);
    if (words.length + next.length > budget) break;
    words.push(...next);
  }
  return words.join(' ').replace(/([^.!?])$/, '$1.');
}

export function heygenClient({ apiKey = '', fetchImpl = fetch, hosts = heygenHosts, record = null, log = line => console.warn(line) } = {}) {
  const configured = typeof apiKey === 'string' && apiKey.trim().length >= 10;
  async function call(path, { method = 'GET', body = null, signal } = {}) {
    if (!configured) throw failure('heygen_not_configured');
    let response;
    try {
      response = await fetchImpl(`${api}${path}`, { method, redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
        headers: { 'X-Api-Key': apiKey.trim(), Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    } catch {
      throw failure('heygen_unavailable', true);
    }
    const data = await response.json().catch(() => null);
    if (response.status === 401 || response.status === 403) throw failure('heygen_refused');
    if (response.status === 429 || response.status >= 500) throw failure('heygen_unavailable', true);
    if (!response.ok || !data || data.error) {
      log(JSON.stringify({ event: 'hub_creative_heygen_error', status: response.status }));
      throw failure('heygen_refused');
    }
    return data.data ?? {};
  }
  const ledger = async (outcome, latencyMs) => {
    if (!record) return;
    try { await record({ caseId: null, actor: 'automation', feature: 'agent_creative_director', model: 'heygen', outcome, inputTokens: null, outputTokens: null, latencyMs }); }
    catch { log(JSON.stringify({ event: 'hub_creative_usage_not_recorded' })); }
  };

  return {
    configured,
    /** Starts a render. Returns `{ videoId }`. */
    async submit({ script, avatarId, voiceId, width, height, background, title }, { signal } = {}) {
      const started = Date.now();
      try {
        const data = await call('/v2/video/generate', { method: 'POST', signal, body: {
          title: String(title ?? 'CareMetric creative').slice(0, 100), caption: true, dimension: { width, height },
          video_inputs: [{ character: { type: 'avatar', avatar_id: avatarId, avatar_style: 'normal' }, voice: { type: 'text', input_text: script, voice_id: voiceId },
            background: { type: 'color', value: background } }],
        } });
        if (typeof data.video_id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(data.video_id)) throw failure('heygen_refused');
        await ledger('completed', Date.now() - started);
        return { videoId: data.video_id };
      } catch (error) {
        await ledger('failed', Date.now() - started);
        throw error;
      }
    },
    /** Where a render stands: `{ state: 'working' | 'done' | 'failed', url?, captioned?, durationSeconds? }`. */
    async status(videoId, { signal } = {}) {
      if (!/^[A-Za-z0-9_-]{1,100}$/.test(String(videoId ?? ''))) throw failure('heygen_refused');
      const data = await call(`/v1/video_status.get?video_id=${encodeURIComponent(videoId)}`, { signal });
      if (data.status === 'completed') {
        const url = data.video_url_caption || data.video_url;
        return { state: 'done', url: typeof url === 'string' ? url : null, captioned: typeof data.video_url_caption === 'string' && Boolean(data.video_url_caption),
          durationSeconds: Number.isFinite(Number(data.duration)) ? Number(data.duration) : null };
      }
      if (data.status === 'failed') return { state: 'failed' };
      return { state: 'working' };
    },
    /** The finished file, from HeyGen's asset hosts only, at most 60 MB. */
    async download(url, { signal } = {}) {
      let address;
      try { address = new URL(url); } catch { throw failure('heygen_download_refused'); }
      if (address.protocol !== 'https:' || address.username || address.password || !hosts.includes(address.hostname)) throw failure('heygen_download_refused');
      let response;
      try { response = await fetchImpl(address.href, { redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(90_000)]) : AbortSignal.timeout(90_000) }); }
      catch { throw failure('heygen_unavailable', true); }
      if (!response.ok) throw failure(response.status >= 500 ? 'heygen_unavailable' : 'heygen_download_refused', response.status >= 500);
      const length = Number(response.headers.get('content-length') ?? 0);
      if (length > maxBytes) throw failure('heygen_too_large');
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > maxBytes || bytes.length < 8) throw failure('heygen_too_large');
      return bytes;
    },
  };
}
