/**
 * The published guides the Concierge may draw an answer from: CareMetric's own help articles, the same
 * public list the Help center shows (`hub.list_published_content`, callable without a session). The list
 * is kept for ten minutes, so a busy inbox does not read it for every message, and a failed read keeps
 * whatever was loaded before. `top(text)` picks up to three articles whose title or summary shares words
 * with the text (the ranking the case assistant already uses) and clips each, so what goes into a request
 * has a known size. Videos and courses are not guides.
 */
import { rankKnowledge } from '../../ai-automation.mjs';

const clip = (text, limit) => {
  const value = String(text ?? '').trim();
  if (value.length <= limit) return value;
  const cut = value.slice(0, limit).search(/\s\S*$/);
  return `${value.slice(0, cut > limit / 2 ? cut : limit).trimEnd()}…`;
};

export function guideLibrary({ load, ttlMs = 600_000, retryMs = 60_000, now = () => Date.now(), log = line => console.warn(line) }) {
  let items = [];
  let expiresAt = Number.NEGATIVE_INFINITY;
  let loading = null;

  async function refresh() {
    try {
      const rows = await load();
      const seen = new Set();
      items = (Array.isArray(rows) ? rows : [])
        .filter(row => row?.kind === 'article' && typeof row.title === 'string' && row.title.trim())
        .map(row => ({ title: row.title.trim(), summary: String(row.summary ?? ''), body: String(row.body_markdown ?? '') }))
        .filter(item => { const key = `${item.title}\n${item.summary}`; if (seen.has(key)) return false; seen.add(key); return true; });
      expiresAt = now() + ttlMs;
    } catch {
      // Keep the last good list, and look again soon.
      log(JSON.stringify({ event: 'hub_agent_guides_unavailable', kept: items.length }));
      expiresAt = now() + retryMs;
    } finally {
      loading = null;
    }
  }

  return {
    /** Up to three guides for `text`, best match first: { title, summary, body }, each clipped. Empty when nothing matches. */
    async top(text) {
      if (now() >= expiresAt) { loading ??= refresh(); await loading; }
      return rankKnowledge(items, text).map(guide => ({ title: clip(guide.title, 150), summary: clip(guide.summary, 400), body: clip(guide.body, 2000) }));
    },
  };
}
