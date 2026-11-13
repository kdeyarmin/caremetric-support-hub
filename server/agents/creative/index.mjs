/**
 * The Creative Director (supabase/migrations/20261109200000_creative_director.sql): turns marketing plans into finished, on-brand,
 * compliant ad creative, proposes it for the owner's approval, hands approved assets to the Social Media Manager and learns from how they
 * perform. See docs/CREATIVE_DIRECTOR.md.
 *
 * Its handlers and executors register when the database declares `platform.agents.creative.v1`. Its work runs only while
 * Settings → Creative → "Turn on the Creative Director" is on (read on each run, so a change applies without a restart); otherwise each
 * task is put aside without work. Like every agent, nothing runs unless Settings → AI team → "Run the AI team" is on and the owner has
 * resumed it (it is seeded paused), and it works only on the products the owner markets.
 *
 * Settings → Creative (server/hub-settings.mjs): "Most renders a day" (renders started per Eastern day across every server, default 40;
 * 0 renders nothing) and "How videos are made" (made here, frames drawn and stitched with ffmpeg-static, or HeyGen presenter videos).
 * HeyGen's key is the one Railway variable, a secret: HUB_HEYGEN_API_KEY. HeyGen is used only with it and only for a product whose brand
 * kit names an avatar and a voice; otherwise videos are made here.
 */
import { live, rebuilt } from '../../live.mjs';
import { creativeExecutors } from './executor.mjs';
import { heygenClient } from './heygen.mjs';
import { creativeHandlers } from './tasks.mjs';

export const creativeFeature = 'platform.agents.creative.v1';
export const creativeDeclared = features => (features instanceof Set ? features.has(creativeFeature) : Array.isArray(features) && features.includes(creativeFeature));

/**
 * The configuration, validated: the switch, the render cap and the video provider from Settings → Creative (`setting`: hub-settings
 * `get`), and HeyGen's key from Railway (`env`). Without `setting`, the Creative Director is off and the defaults apply.
 */
export function creativeConfig(env = {}, setting = null) {
  const value = key => (setting ? setting(key) : undefined);
  const cap = value('creative.daily_render_cap');
  const heygenKey = String(env.HUB_HEYGEN_API_KEY ?? '').trim();
  return {
    enabled: value('creative.enabled') === true,
    dailyRenderCap: Number.isInteger(cap) && cap >= 0 && cap <= 1000 ? cap : 40,
    countySnapshotsPerWeek: (snapshots => (Number.isInteger(snapshots) && snapshots >= 0 && snapshots <= 7 ? snapshots : 3))(value('creative.county_snapshots_per_week')),
    videoProvider: value('creative.video_provider') === 'heygen' && heygenKey ? 'heygen' : 'internal',
    heygenKey,
  };
}

/**
 * The Creative Director's handlers and executors when the database declares it. `creative` is its configuration, or a function that
 * returns it (server/main.mjs: read from the Hub's settings each time). `enabled()` and `config()` answer for now.
 */
export function creativeTeam({ creative = null, features = null, fetchImpl = fetch, record = null, heygen: givenHeygen = null }) {
  const config = () => live(creative) ?? creativeConfig({});
  if (!creativeDeclared(features)) return { declared: false, enabled: () => false, config, handlers: () => ({}), executors: () => ({}), heygen: null };
  // Built again only when the provider or the key changes; a client without a key says it is not configured.
  const heygen = givenHeygen ?? rebuilt(() => ({ provider: config().videoProvider, key: config().heygenKey }),
    input => heygenClient({ apiKey: input?.provider === 'heygen' ? input.key : '', fetchImpl, record }));
  const enabled = () => config().enabled === true;
  return {
    declared: true, enabled, config, heygen,
    handlers: ({ store, notifier, model, meta = null, linkedin = null, publicOrigin, marketed = null, log, feed = null }) => {
      const handlers = creativeHandlers({ store, notifier, model, meta, linkedin, heygen, publicOrigin, marketed, log, feed,
        settings: { get dailyRenderCap() { return config().dailyRenderCap; }, get videoProvider() { return config().videoProvider; },
          get countySnapshotsPerWeek() { return config().countySnapshotsPerWeek; } } });
      // Off in Settings → Creative: a task is put aside without work, and nothing is rendered, proposed or sent.
      return Object.fromEntries(Object.entries(handlers).map(([kind, handler]) => [kind, (task, context) => (enabled() ? handler(task, context) : { result: { skipped: 'creative_off' } })]));
    },
    executors: ({ store }) => creativeExecutors({ store }),
  };
}
