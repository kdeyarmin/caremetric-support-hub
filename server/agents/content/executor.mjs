/**
 * Carries out an approved `content.publish`: the article the owner read in the preview becomes a public help-center article.
 * The database does the publishing (private.agent_content_publish, 20261103150000_agent_content.sql) from the action's own
 * stored input, so nothing but the approved text can be published, and it records the AI assistant as the author and the owner
 * as the approver. This executor only checks the stored article once more against the content rules (validate.mjs) and turns
 * the database's answer into a coded outcome:
 *
 * - `published`: a new public article; `already_published`: the slug already holds this agent's article (a retry, or a second
 *   approval for the same slug), so nothing new is written. Either way the result carries the article's address (`url`): for a
 *   CareMetric Intel article the address on Intel's website, with the help-center copy in `helpUrl`.
 * - Thrown codes the owner sees: `invalid_article` (the stored article fails the rules now), `approval_required` (it was approved
 *   automatically while article publishing is not handed over: before platform.agents.content-autopublish.v1 always, after it whenever
 *   the database finds the Content Marketer is not trusted with publishing right now), `slug_taken` (another article already uses the
 *   address), `product_unavailable` (the product is retired or closed to support) and `publish_failed`.
 *
 * Registered only when the database declares platform.agents.content.v1. It needs no owner session and no model.
 */
import { articleHomeUrl, articleUrl, servedElsewhere } from './facts.mjs';
import { checkArticle } from './validate.mjs';

export const contentFeature = 'platform.agents.content.v1';
const has = (features, feature) => (features instanceof Set ? features.has(feature) : Array.isArray(features) && features.includes(feature));
export const contentDeclared = features => has(features, contentFeature);
/** Articles the owner handed over publish without their approval (supabase/migrations/20261105130000_content_autopublish.sql). */
export const autopublishFeature = 'platform.agents.content-autopublish.v1';

const refused = new Set(['approval_required', 'slug_taken', 'product_unavailable']);
const failure = code => Object.assign(new Error('The article was not published.'), { code });

export function contentExecutors({ store, features = null, log = line => console.warn(line) }) {
  if (!contentDeclared(features)) return {};
  // Without the hand-over in the database, an article approved on its own is refused here; with it, the database decides, at publication.
  const autopublish = has(features, autopublishFeature);
  async function publish(execution) {
    const problems = checkArticle(execution.input);
    if (problems.length > 0) {
      // Codes only: the article itself stays in the action, which the owner can read.
      log(JSON.stringify({ event: 'hub_content_publish_refused', action_id: execution.id, reasons: problems }));
      throw failure('invalid_article');
    }
    if (execution.autoApproved === true && !autopublish) throw failure('approval_required');
    const answer = await store.contentPublish(execution.id, Number.isInteger(execution.execution) ? execution.execution : null);
    if (answer?.outcome === 'published' || answer?.outcome === 'already_published') {
      // The address the article lives at (Intel's website for an Intel article) and, when that is elsewhere, its help-center copy.
      const product = execution.input?.product;
      return { outcome: answer.outcome, slug: answer.slug, url: articleHomeUrl(product, answer.slug), ...(servedElsewhere(product) ? { helpUrl: articleUrl(answer.slug) } : {}) };
    }
    throw failure(refused.has(answer?.outcome) ? answer.outcome : 'publish_failed');
  }
  return { 'content.publish': publish };
}
