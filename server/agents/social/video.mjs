/** Durable, approved-only organic video publishing. Provider mutations are attempted once; processing reads may retry. */
const failure = code => Object.assign(new Error('The video could not be published.'), { code });
const defer = () => failure('action_deferred');
export const videoFeature = 'platform.agents.social-video.v1';

export async function publishApprovedVideo(execution, { store, publicOrigin, meta, linkedin, now = () => new Date() }) {
  const input = execution.input ?? {};
  if (typeof store?.socialVideoStage !== 'function') throw failure('video_not_available');
  let origin, url;
  try { origin = new URL(publicOrigin); url = new URL(input.videoUrl); } catch { throw failure('invalid_video'); }
  if (origin.protocol !== 'https:' || url.origin !== origin.origin || url.username || url.password || url.search || url.hash
    || !/^\/api\/creative\/a\/[0-9a-f]{64}\.mp4$/.test(url.pathname) || !/^[0-9a-f-]{36}$/.test(input.creativeAssetId ?? '')
    || input.imageUrl || !Number.isInteger(execution.execution)) throw failure('invalid_video');
  const client = input.platform === 'linkedin' ? linkedin : meta;
  if (!['prepareVideo', 'readVideo', 'publishVideo'].every(key => typeof client?.[key] === 'function')) throw failure('video_not_available');
  const transition = (phase, providerId = null) => store.socialVideoStage(execution.id, execution.execution, phase, providerId);
  let state = await transition('read');
  if (state.phase === 'published') return { id: state.publishedId };
  // These intents mean a previous process may have sent the request. Never start another upload or publish.
  if (['uploading', 'publishing'].includes(state.phase)) throw failure('social_unconfirmed');
  if (state.phase === 'new') {
    await transition('uploading');
    const prepared = await client.prepareVideo({ platform: input.platform, videoUrl: input.videoUrl, message: input.message });
    try { state = await transition('processing', prepared.id); } catch { throw failure('social_unconfirmed'); }
  }
  if (state.phase !== 'processing' || !state.providerId) throw failure('invalid_video');
  const started = Date.parse(state.createdAt);
  if (!Number.isFinite(started) || now().getTime() - started > 60 * 60_000) throw failure('video_processing_timeout');
  let status;
  try { status = await client.readVideo(state.providerId, { platform: input.platform }); }
  catch (error) { if (error?.transient) throw defer(); throw error; }
  if (status.failed) throw failure('video_processing_failed');
  if (!status.ready) throw defer();
  await transition('publishing');
  const published = await client.publishVideo({ platform: input.platform, videoId: state.providerId, message: input.message });
  if (typeof published.id !== 'string' || !published.id) throw failure('social_unconfirmed');
  try { await transition('published', published.id); } catch { throw failure('social_unconfirmed'); }
  return published;
}
