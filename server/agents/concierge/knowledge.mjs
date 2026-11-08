/**
 * Published, revision-aware, product-scoped retrieval. Failure never extends the maximum cache age. A public article also carries its
 * address in the help center (`url`), so an agent can send a prospect or a customer to the guide itself.
 */
import { articleUrl } from '../content/facts.mjs';
const contentKey = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const clip = (text, limit) => {
  const value = String(text ?? '').trim();
  if (value.length <= limit) return value;
  const cut = value.slice(0, limit).search(/\s\S*$/);
  return `${value.slice(0, cut > limit / 2 ? cut : limit).trimEnd()}…`;
};
const termsOf = text => [...new Set(String(text ?? '').toLowerCase().match(/[a-z0-9]{4,}/g) ?? [])]
  .filter(term => !['what', 'when', 'where', 'with', 'this', 'that', 'have', 'does', 'your', 'please'].includes(term));
const score = (text, terms) => terms.filter(term => text.toLowerCase().includes(term)).length;
export function guideLibrary({ load, loadProducts = async () => [], ttlMs = 600_000, retryMs = 60_000, maxStaleMs = 3_600_000, now = () => Date.now(), log = line => console.warn(line) }) {
  let items = [], expiresAt = -Infinity, loadedAt = -Infinity, loading = null;
  async function refresh() {
    try {
      const [rows, products] = await Promise.all([load(), loadProducts()]);
      const slugs = new Map(products.map(product => [product.id, product.slug]));
      const seen = new Set();
      items = (Array.isArray(rows) ? rows : []).filter(row => row?.kind === 'article' && row.title?.trim())
        .map(row => ({ title: row.title.trim(), summary: String(row.summary ?? ''), body: String(row.body_markdown ?? ''),
          id: row.id, revision: row.revision_no, audience: row.audience ?? [],
          url: row.access_level === 'public' && (row.status ?? 'published') === 'published' && typeof row.content_key === 'string' && contentKey.test(row.content_key) ? articleUrl(row.content_key) : null,
          products: row.product_slugs ?? (row.product_ids ?? []).map(id => slugs.get(id) ?? id),
        })).filter(item => { const key = item.id ?? `${item.title}\n${item.summary}\n${item.products.join(',')}`; if (seen.has(key)) return false; seen.add(key); return true; });
      loadedAt = now(); expiresAt = loadedAt + ttlMs;
    } catch {
      log(JSON.stringify({ event: 'hub_agent_guides_unavailable', kept: items.length }));
      expiresAt = now() + retryMs;
    } finally { loading = null; }
  }
  return {
    async top(text, { productSlug = null, audience = null } = {}) {
      if (now() >= expiresAt) { loading ??= refresh(); await loading; }
      if (now() - loadedAt > maxStaleMs) return [];
      const terms = termsOf(text);
      return items.filter(item => (!item.products.length || item.products.includes(productSlug))
        && (!audience || !item.audience.length || item.audience.includes(audience)))
        .map(item => {
          // Score bounded overlapping sections, so an answer near the end of a long guide is retrievable.
          const sections = [];
          for (let i = 0; i < Math.min(item.body.length, 200_000); i += 1500) sections.push(item.body.slice(i, i + 2000));
          const best = sections.sort((a, b) => score(b, terms) - score(a, terms))[0] ?? '';
          return { item, best, rank: 3 * score(item.title, terms) + 2 * score(item.summary, terms) + score(best, terms) };
        }).filter(row => row.rank > 0).sort((a,b) => b.rank - a.rank).slice(0,3)
        .map(({ item, best }) => ({ title: clip(item.title,150), summary: clip(item.summary,400), body: clip(best,2000),
          ...(item.id ? { sourceId: item.id, revision: item.revision, products: item.products } : {}), ...(item.url ? { url: item.url } : {}),
        }));
    },
  };
}
