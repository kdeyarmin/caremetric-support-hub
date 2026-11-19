import { describe, expect, it, vi } from 'vitest';
import { publishApprovedVideo } from './video.mjs';

const moment = new Date('2026-11-11T15:00:00Z');
const publicOrigin = 'https://help.caremetric.ai';
const videoUrl = `${publicOrigin}/api/creative/a/${'f'.repeat(64)}.mp4`;
const action = (overrides = {}) => ({ id: 'action-1', execution: 1, input: {
  platform: 'linkedin', product: 'caremetric-intel', message: 'CareMetric Intel brings territory planning into one place.',
  videoUrl, imageUrl: null, creativeAssetId: '11111111-1111-4111-8111-111111111111',
}, ...overrides });

function fixture({ phase = 'new', providerId = null, publishedId = null, createdAt = moment.toISOString(), statuses = [true], failureAt = null } = {}) {
  let state = { phase, providerId, publishedId, createdAt };
  let statusIndex = 0;
  const store = { socialVideoStage: vi.fn(async (id, execution, next, provider) => {
    if (failureAt === next) throw new Error('checkpoint failed');
    if (next !== 'read') {
      state = { ...state, phase: next };
      if (next === 'processing') state.providerId = provider;
      if (next === 'published') state.publishedId = provider;
    }
    return { ...state };
  }) };
  const client = {
    prepareVideo: vi.fn(async () => ({ id: 'urn:li:video:prepared' })),
    readVideo: vi.fn(async () => {
      const next = statuses[Math.min(statusIndex++, statuses.length - 1)];
      if (next instanceof Error) throw next;
      return typeof next === 'object' ? next : { ready: next, failed: false };
    }),
    publishVideo: vi.fn(async () => ({ id: 'urn:li:share:123' })),
  };
  const options = { store, linkedin: client, meta: client, publicOrigin, now: () => moment };
  return { store, client, options, state: () => ({ ...state }), run: (execution = action()) => publishApprovedVideo(execution, options) };
}

describe('durable approved video publishing', () => {
  // Review 2026-11-19: a Facebook Page video is published by its upload, so past the hour it may still appear on the Page.
  it('calls a Facebook video unconfirmed, not failed, when processing outlasts the hour, and still times out a LinkedIn one', async () => {
    const late = new Date(moment.getTime() - 61 * 60_000).toISOString();
    const facebook = fixture({ phase: 'processing', providerId: '900', createdAt: late, statuses: [false] });
    await expect(facebook.run(action({ input: { ...action().input, platform: 'facebook' } }))).rejects.toMatchObject({ code: 'social_unconfirmed' });
    expect(facebook.client.publishVideo).not.toHaveBeenCalled();
    const linkedin = fixture({ phase: 'processing', providerId: 'urn:li:video:prepared', createdAt: late, statuses: [false] });
    await expect(linkedin.run()).rejects.toMatchObject({ code: 'video_processing_timeout' });
  });

  it('takes a Facebook video through the same recorded stages, uploading it once', async () => {
    const h = fixture({ statuses: [false, true] });
    h.client.prepareVideo.mockResolvedValue({ id: '900' });
    h.client.publishVideo.mockResolvedValue({ id: '900' });
    const facebook = execution => action({ ...execution, input: { ...action().input, platform: 'facebook' } });
    await expect(h.run(facebook())).rejects.toMatchObject({ code: 'action_deferred' });
    expect(await h.run(facebook({ execution: 2 }))).toEqual({ id: '900' });
    expect(h.client.prepareVideo).toHaveBeenCalledTimes(1);
    expect(h.state()).toMatchObject({ phase: 'published', providerId: '900', publishedId: '900' });
  });

  it('persists upload state, defers processing, and resumes without uploading the video again', async () => {
    const h = fixture({ statuses: [false, true] });
    await expect(h.run()).rejects.toMatchObject({ code: 'action_deferred' });
    expect(h.state()).toMatchObject({ phase: 'processing', providerId: 'urn:li:video:prepared' });
    expect(h.client.prepareVideo).toHaveBeenCalledTimes(1);
    expect(h.client.publishVideo).not.toHaveBeenCalled();
    expect(await h.run(action({ execution: 2 }))).toEqual({ id: 'urn:li:share:123' });
    expect(h.client.prepareVideo).toHaveBeenCalledTimes(1);
    expect(h.client.readVideo).toHaveBeenCalledTimes(2);
    expect(h.client.publishVideo).toHaveBeenCalledTimes(1);
    expect(h.store.socialVideoStage.mock.calls.map(([, execution, phase]) => [execution, phase])).toEqual([
      [1, 'read'], [1, 'uploading'], [1, 'processing'], [2, 'read'], [2, 'publishing'], [2, 'published'],
    ]);
    // Publication was recorded durably: a completion replay performs no provider operation.
    expect(await h.run(action({ execution: 3 }))).toEqual({ id: 'urn:li:share:123' });
    expect(h.client.publishVideo).toHaveBeenCalledTimes(1);
  });

  it.each(['uploading', 'publishing'])('never repeats a provider mutation after the %s intent', async phase => {
    const h = fixture({ phase, providerId: 'urn:li:video:prepared' });
    await expect(h.run()).rejects.toMatchObject({ code: 'social_unconfirmed' });
    expect(h.client.prepareVideo).not.toHaveBeenCalled();
    expect(h.client.readVideo).not.toHaveBeenCalled();
    expect(h.client.publishVideo).not.toHaveBeenCalled();
    expect(h.store.socialVideoStage).toHaveBeenCalledTimes(1);
  });

  it('does not retry an upload whose provider result could not be recorded', async () => {
    const h = fixture({ failureAt: 'processing' });
    await expect(h.run()).rejects.toMatchObject({ code: 'social_unconfirmed' });
    expect(h.state().phase).toBe('uploading');
    await expect(h.run(action({ execution: 2 }))).rejects.toMatchObject({ code: 'social_unconfirmed' });
    expect(h.client.prepareVideo).toHaveBeenCalledTimes(1);
    expect(h.client.publishVideo).not.toHaveBeenCalled();
  });

  it('does not repeat a publish whose completion could not be recorded', async () => {
    const h = fixture({ failureAt: 'published' });
    await expect(h.run()).rejects.toMatchObject({ code: 'social_unconfirmed' });
    expect(h.state().phase).toBe('publishing');
    expect(h.client.publishVideo).toHaveBeenCalledTimes(1);
    await expect(h.run(action({ execution: 2 }))).rejects.toMatchObject({ code: 'social_unconfirmed' });
    expect(h.client.publishVideo).toHaveBeenCalledTimes(1);
  });

  it('records publishing intent before invoking the provider and never treats an empty confirmation as success', async () => {
    const h = fixture();
    h.client.publishVideo.mockImplementation(async () => {
      expect(h.state().phase).toBe('publishing');
      return { id: '' };
    });
    await expect(h.run()).rejects.toMatchObject({ code: 'social_unconfirmed' });
    expect(h.store.socialVideoStage.mock.calls.some(([, , phase]) => phase === 'published')).toBe(false);
  });

  it('retries only processing reads and leaves completed upload state intact', async () => {
    const retry = Object.assign(new Error('provider read temporarily unavailable'), { transient: true });
    const h = fixture({ phase: 'processing', providerId: 'urn:li:video:prepared', statuses: [retry, true] });
    await expect(h.run()).rejects.toMatchObject({ code: 'action_deferred' });
    expect(h.state().phase).toBe('processing');
    expect(await h.run(action({ execution: 2 }))).toEqual({ id: 'urn:li:share:123' });
    expect(h.client.prepareVideo).not.toHaveBeenCalled();
    expect(h.client.publishVideo).toHaveBeenCalledTimes(1);
  });

  it('refuses failed or expired processing without trying to publish or upload again', async () => {
    const old = fixture({ phase: 'processing', providerId: 'urn:li:video:prepared', createdAt: new Date(moment.getTime() - 61 * 60_000).toISOString() });
    await expect(old.run()).rejects.toMatchObject({ code: 'video_processing_timeout' });
    expect(old.client.readVideo).not.toHaveBeenCalled();
    expect(old.client.prepareVideo).not.toHaveBeenCalled();
    expect(old.client.publishVideo).not.toHaveBeenCalled();
    const failed = fixture({ phase: 'processing', providerId: 'urn:li:video:prepared', statuses: [{ ready: false, failed: true }] });
    await expect(failed.run()).rejects.toMatchObject({ code: 'video_processing_failed' });
    expect(failed.client.publishVideo).not.toHaveBeenCalled();
  });

  it('requires the exact Hub creative URL, an asset id and a fenced execution before any provider operation', async () => {
    for (const input of [
      { videoUrl: videoUrl.replace('help.caremetric.ai', 'other.example') },
      { videoUrl: `${videoUrl}?unexpected=1` }, { videoUrl: `${videoUrl}#fragment` },
      { videoUrl: `${publicOrigin}/unapproved.mp4` }, { creativeAssetId: '' }, { imageUrl: `${publicOrigin}/image.png` },
    ]) {
      const h = fixture();
      await expect(h.run(action({ input: { ...action().input, ...input } }))).rejects.toMatchObject({ code: 'invalid_video' });
      expect(h.store.socialVideoStage).not.toHaveBeenCalled();
      expect(h.client.prepareVideo).not.toHaveBeenCalled();
    }
    const h = fixture();
    await expect(h.run(action({ execution: undefined }))).rejects.toMatchObject({ code: 'invalid_video' });
    expect(h.store.socialVideoStage).not.toHaveBeenCalled();
  });

  it('requires migration support and an implementation before mutating provider state', async () => {
    const h = fixture();
    await expect(publishApprovedVideo(action(), { ...h.options, store: {} })).rejects.toMatchObject({ code: 'video_not_available' });
    await expect(publishApprovedVideo(action(), { ...h.options, linkedin: {} })).rejects.toMatchObject({ code: 'video_not_available' });
    expect(h.store.socialVideoStage).not.toHaveBeenCalled();
    expect(h.client.prepareVideo).not.toHaveBeenCalled();
  });
});
