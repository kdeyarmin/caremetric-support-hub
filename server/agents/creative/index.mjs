/**
 * The Creative Director (supabase/migrations/20261109120000_creative_director.sql): turns marketing plans into finished, on-brand,
 * compliant ad creative, proposes it for the owner's approval, hands approved assets to the Social Media Manager and learns from how they
 * perform. See docs/CREATIVE_DIRECTOR.md.
 *
 * Its handlers and executors register only when all of these hold: the database declares `platform.agents.creative.v1`, and
 * HUB_CREATIVE_ENABLED is exactly "true". Like every agent, nothing runs unless HUB_AGENTS_ENABLED is "true" and the owner has resumed it
 * (it is seeded paused), and it works only on the products the owner markets.
 *
 * Settings (all optional):
 * - HUB_CREATIVE_DAILY_RENDER_CAP: renders started per Eastern day across every server (default 40; 0 renders nothing).
 * - HUB_CREATIVE_VIDEO_PROVIDER: "internal" (default: frames drawn here and stitched with ffmpeg-static) or "heygen".
 * - HUB_HEYGEN_API_KEY: HeyGen's key. The HeyGen adapter is used only with it and only for a product whose brand kit names an avatar and
 *   a voice; otherwise videos are made internally.
 */
import { creativeExecutors } from './executor.mjs';
import { heygenClient } from './heygen.mjs';
import { creativeHandlers } from './tasks.mjs';

export const creativeFeature = 'platform.agents.creative.v1';
export const creativeDeclared = features => (features instanceof Set ? features.has(creativeFeature) : Array.isArray(features) && features.includes(creativeFeature));

/** The configuration from the environment, validated. A value it cannot use falls back to the default. */
export function creativeConfig(env = {}) {
  const cap = Number(env.HUB_CREATIVE_DAILY_RENDER_CAP);
  const provider = String(env.HUB_CREATIVE_VIDEO_PROVIDER ?? '').trim().toLowerCase();
  const heygenKey = String(env.HUB_HEYGEN_API_KEY ?? '').trim();
  return {
    enabled: env.HUB_CREATIVE_ENABLED === 'true',
    dailyRenderCap: env.HUB_CREATIVE_DAILY_RENDER_CAP !== undefined && env.HUB_CREATIVE_DAILY_RENDER_CAP !== '' && Number.isInteger(cap) && cap >= 0 && cap <= 1000 ? cap : 40,
    videoProvider: provider === 'heygen' && heygenKey ? 'heygen' : 'internal',
    heygenKey,
  };
}

/** The Creative Director's handlers and executors, or none when it is not enabled on this Hub. */
export function creativeTeam({ creative = null, features = null, fetchImpl = fetch, record = null, heygen: givenHeygen = null }) {
  const config = creative ?? creativeConfig({});
  const on = config.enabled === true && creativeDeclared(features);
  if (!on) return { enabled: false, handlers: () => ({}), executors: () => ({}), heygen: null };
  const heygen = givenHeygen ?? (config.videoProvider === 'heygen' ? heygenClient({ apiKey: config.heygenKey, fetchImpl, record }) : null);
  return {
    enabled: true, heygen,
    handlers: ({ store, notifier, model, meta = null, linkedin = null, publicOrigin, marketed = null, log }) =>
      creativeHandlers({ store, notifier, model, meta, linkedin, heygen, settings: { dailyRenderCap: config.dailyRenderCap, videoProvider: config.videoProvider }, publicOrigin, marketed, log }),
    executors: ({ store }) => creativeExecutors({ store }),
  };
}
