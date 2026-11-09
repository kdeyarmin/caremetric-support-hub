/**
 * Where a piece of creative runs and what each platform accepts: the exact canvas, the file type and size, the copy lengths and the video
 * lengths. `validateAsset` checks a finished asset against them; a hard limit the platform documents is an error (the asset is blocked),
 * a length the platform only recommends is a warning (the owner sees it).
 *
 * Checked on 2026-11-09 against the platforms' own pages where they publish a value, and against current third-party spec sheets where
 * they do not (Meta publishes its primary text, headline and description lengths as recommendations, not limits):
 * - Meta: feed 1:1 and 4:5, Stories and Reels 9:16; images up to 30 MB; primary text about 125 characters before "See more", headline
 *   about 40, description about 30; feed video up to 241 minutes, and Stories and Reels kept to 60 seconds here, the shortest current limit
 *   among their placements.
 * - LinkedIn (business.linkedin.com ads guide and single-image specs): single image 1.91:1 (1200 x 627 is the long-standing size and
 *   1200 x 628 the current recommendation; both are 1.91:1) and square; images up to 5 MB; introductory text 150 characters shown (600 at
 *   most), headline 70 shown (200 at most), description 70 (Audience Network only); video 3 seconds to 30 minutes, MP4, under 500 MB.
 * - Google display (support.google.com/google-ads answers 7005917 and 17090561): responsive display images 1200 x 628 and 1200 x 1200 up
 *   to 5,120 KB; an uploaded 300 x 250 image ad at most 150 KB; short headline 30, long headline 90, description 90 characters.
 * - YouTube: custom thumbnail 1280 x 720 at most 2 MB; title 100 characters; bumper ads up to 6 seconds, non-skippable 7 to 15 seconds,
 *   Shorts up to 3 minutes.
 * When a platform changes a value, change it here and in docs/CREATIVE_DIRECTOR.md; specs.test.mjs holds the table to the documented sizes.
 */
export const specsVersion = '2026-11-09';
export const platforms = Object.freeze(['meta', 'linkedin', 'google', 'youtube']);

const mb = 1024 * 1024;
const kb = 1024;
const freeze = value => Object.freeze(Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, Object.freeze({ key, ...entry })])));

/** Every placement, by key. `aspect` names a video's shape; a static placement has none. */
export const placements = freeze({
  'meta.feed_square': { platform: 'meta', kind: 'static', width: 1080, height: 1080, label: 'Meta feed, square', maxBytes: 30 * mb },
  'meta.feed_portrait': { platform: 'meta', kind: 'static', width: 1080, height: 1350, label: 'Meta feed, portrait', maxBytes: 30 * mb },
  'meta.story': { platform: 'meta', kind: 'static', width: 1080, height: 1920, label: 'Meta Stories and Reels', maxBytes: 30 * mb },
  'meta.video_square': { platform: 'meta', kind: 'video', width: 1080, height: 1080, aspect: '1:1', label: 'Meta feed video, square', maxBytes: 4096 * mb, minSeconds: 1, maxSeconds: 241 * 60 },
  'meta.video_portrait': { platform: 'meta', kind: 'video', width: 1080, height: 1350, aspect: '4:5', label: 'Meta feed video, portrait', maxBytes: 4096 * mb, minSeconds: 1, maxSeconds: 241 * 60 },
  'meta.video_vertical': { platform: 'meta', kind: 'video', width: 1080, height: 1920, aspect: '9:16', label: 'Meta Stories and Reels video', maxBytes: 4096 * mb, minSeconds: 1, maxSeconds: 60 },
  'linkedin.single_image': { platform: 'linkedin', kind: 'static', width: 1200, height: 627, label: 'LinkedIn single image', maxBytes: 5 * mb },
  'linkedin.square': { platform: 'linkedin', kind: 'static', width: 1080, height: 1080, label: 'LinkedIn square image', maxBytes: 5 * mb },
  'linkedin.video_square': { platform: 'linkedin', kind: 'video', width: 1080, height: 1080, aspect: '1:1', label: 'LinkedIn video, square', maxBytes: 500 * mb, minSeconds: 3, maxSeconds: 30 * 60 },
  'linkedin.video_portrait': { platform: 'linkedin', kind: 'video', width: 1080, height: 1350, aspect: '4:5', label: 'LinkedIn video, portrait', maxBytes: 500 * mb, minSeconds: 3, maxSeconds: 30 * 60 },
  'linkedin.video_vertical': { platform: 'linkedin', kind: 'video', width: 1080, height: 1920, aspect: '9:16', label: 'LinkedIn video, vertical', maxBytes: 500 * mb, minSeconds: 3, maxSeconds: 30 * 60 },
  'google.landscape': { platform: 'google', kind: 'static', width: 1200, height: 628, label: 'Google display, landscape', maxBytes: 5120 * kb },
  'google.square': { platform: 'google', kind: 'static', width: 1200, height: 1200, label: 'Google display, square', maxBytes: 5120 * kb },
  'google.rectangle': { platform: 'google', kind: 'static', width: 300, height: 250, label: 'Google display, 300 x 250', maxBytes: 150 * kb },
  'youtube.thumbnail': { platform: 'youtube', kind: 'static', width: 1280, height: 720, label: 'YouTube thumbnail', maxBytes: 2 * mb },
  'youtube.video_square': { platform: 'youtube', kind: 'video', width: 1080, height: 1080, aspect: '1:1', label: 'YouTube video, square', maxBytes: 256 * 1024 * mb, minSeconds: 1, maxSeconds: 12 * 3600 },
  'youtube.video_vertical': { platform: 'youtube', kind: 'video', width: 1080, height: 1920, aspect: '9:16', label: 'YouTube Shorts', maxBytes: 256 * 1024 * mb, minSeconds: 1, maxSeconds: 180 },
});

/**
 * Copy lengths, in characters. `max` is a hard limit (an error); `recommended` is where the platform cuts the text off in the feed (a
 * warning). For Google, `headline` is the short headline, `primaryText` the description and `description` the long headline; for YouTube,
 * `headline` is the video title and `primaryText` its description.
 */
export const textLimits = Object.freeze({
  meta: Object.freeze({ headline: { recommended: 40, max: 255 }, primaryText: { recommended: 125, max: 2200 }, description: { recommended: 30, max: 255 } }),
  linkedin: Object.freeze({ headline: { recommended: 70, max: 200 }, primaryText: { recommended: 150, max: 600 }, description: { recommended: 70, max: 300 } }),
  google: Object.freeze({ headline: { recommended: 30, max: 30 }, primaryText: { recommended: 90, max: 90 }, description: { recommended: 90, max: 90 } }),
  youtube: Object.freeze({ headline: { recommended: 70, max: 100 }, primaryText: { recommended: 150, max: 5000 }, description: { recommended: 150, max: 5000 } }),
});

/** The four video lengths the agent makes, as seconds (inclusive). The long format is 45 to 60 seconds. */
export const videoLengths = Object.freeze({
  '6s': Object.freeze({ min: 5.5, max: 6, target: 6 }),
  '15s': Object.freeze({ min: 14, max: 15, target: 15 }),
  '30s': Object.freeze({ min: 28, max: 30, target: 30 }),
  '45-60s': Object.freeze({ min: 45, max: 60, target: 50 }),
});
export const aspects = Object.freeze(['1:1', '4:5', '9:16']);

/** The placements of a platform, of one kind ("static" or "video"), in a fixed order. */
export const placementsFor = (platform, kind) => Object.values(placements).filter(entry => entry.platform === platform && entry.kind === kind);

/** The video placement of a platform for an aspect, or the platform's first video placement when it has none of that shape. */
export function videoPlacement(platform, aspect) {
  const list = placementsFor(platform, 'video');
  return list.find(entry => entry.aspect === aspect) ?? list[0] ?? null;
}

const fields = ['headline', 'primaryText', 'description'];
const labels = { headline: 'headline', primaryText: 'primary text', description: 'description' };

/**
 * @param {object} asset
 * @param {string} asset.placement a key of `placements`
 * @param {number} asset.width @param {number} asset.height the file's real dimensions
 * @param {number} [asset.bytes] the file's size
 * @param {string} [asset.contentType] image/png or video/mp4
 * @param {number} [asset.durationSeconds] a video's real length
 * @param {string} [asset.lengthKey] the length it was made for (videoLengths)
 * @param {{ headline?: string, primaryText?: string, description?: string }} [asset.copy]
 * @param {boolean} [asset.captions] whether a video carries captions
 * @returns {{ ok: boolean, errors: {code: string, message: string}[], warnings: {code: string, message: string}[] }}
 */
export function validateAsset({ placement: key, width, height, bytes = null, contentType = null, durationSeconds = null, lengthKey = null, copy = {}, captions = null }) {
  const errors = [];
  const warnings = [];
  const spec = placements[key];
  if (!spec) return { ok: false, errors: [{ code: 'unknown_placement', message: `There is no placement called ${String(key).slice(0, 60)}.` }], warnings };
  if (width !== spec.width || height !== spec.height) errors.push({ code: 'wrong_dimensions', message: `${spec.label} must be ${spec.width} x ${spec.height}; this is ${width} x ${height}.` });
  const type = spec.kind === 'video' ? 'video/mp4' : 'image/png';
  if (contentType !== null && contentType !== type) errors.push({ code: 'wrong_type', message: `${spec.label} must be ${type === 'video/mp4' ? 'an MP4 video' : 'a PNG image'}.` });
  if (bytes !== null && (!Number.isFinite(bytes) || bytes <= 0 || bytes > spec.maxBytes)) {
    errors.push({ code: 'too_large', message: `${spec.label} must be at most ${spec.maxBytes >= mb ? `${Math.round(spec.maxBytes / mb)} MB` : `${Math.round(spec.maxBytes / kb)} KB`}.` });
  }
  if (spec.kind === 'video') {
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) errors.push({ code: 'duration_unknown', message: 'The video\'s length could not be read.' });
    else {
      if (durationSeconds < spec.minSeconds) errors.push({ code: 'video_too_short', message: `${spec.label} must be at least ${spec.minSeconds} seconds.` });
      if (durationSeconds > spec.maxSeconds) errors.push({ code: 'video_too_long', message: `${spec.label} may be at most ${spec.maxSeconds} seconds.` });
      const length = videoLengths[lengthKey];
      if (lengthKey !== null && !length) errors.push({ code: 'length_unknown', message: `There is no video length called ${String(lengthKey).slice(0, 10)}.` });
      // A little slack for the last frame: a 6.04-second file is a 6-second video.
      if (length && (durationSeconds < length.min - 0.1 || durationSeconds > length.max + 0.1)) {
        errors.push({ code: 'length_mismatch', message: `A ${lengthKey} video must run ${length.min === length.max ? `${length.max}` : `${length.min} to ${length.max}`} seconds; this runs ${durationSeconds.toFixed(1)}.` });
      }
      if (spec.platform === 'youtube' && lengthKey === '15s' && spec.aspect !== '9:16') warnings.push({ code: 'youtube_skippable', message: 'Over 6 seconds, a YouTube in-stream ad runs as a non-skippable (up to 15 seconds) or skippable ad, not a bumper.' });
    }
    if (captions === false) errors.push({ code: 'captions_missing', message: 'Every video needs captions.' });
  }
  const limits = textLimits[spec.platform];
  for (const field of fields) {
    const value = String(copy?.[field] ?? '');
    const limit = limits[field];
    if (value.length > limit.max) errors.push({ code: 'text_too_long', message: `The ${labels[field]} is ${value.length} characters; ${spec.platform === 'google' ? 'Google' : spec.platform === 'youtube' ? 'YouTube' : spec.platform === 'linkedin' ? 'LinkedIn' : 'Meta'} allows ${limit.max}.` });
    else if (value.length > limit.recommended) warnings.push({ code: 'text_over_recommended', message: `The ${labels[field]} is ${value.length} characters; past ${limit.recommended} the feed cuts it off.` });
  }
  return { ok: errors.length === 0, errors, warnings };
}
