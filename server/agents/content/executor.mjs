/**
 * Carries out an approved `content.publish`: the article the owner read in the preview becomes a public help-center article.
 * The database does the publishing (private.agent_content_publish, 20261103150000_agent_content.sql) from the action's own
 * stored input, so nothing but the approved text can be published, and it records the AI assistant as the author and the owner
 * as the approver. This executor only checks the stored article once more against the content rules (validate.mjs) and turns
 * the database's answer into a coded outcome:
 *
 * - `published`: a new public article; `already_published`: the slug already holds this agent's article (a retry, or a second
 *   approval for the same slug), so nothing new is written. Either way the result carries the article's address.
 * - Thrown codes the owner sees: `invalid_article` (the stored article fails the rules now), `approval_required` (it was approved
 *   automatically; an article is only ever published with the owner's approval), `slug_taken` (another article already uses the
 *   address), `product_unavailable` (the product is retired or closed to support) and `publish_failed`.
 *
 * Registered only when the database declares platform.agents.content.v1. It needs no owner session and no model.
 */
import { articleUrl } from './facts.mjs';
import { checkArticle } from './validate.mjs';

export const contentFeature = 'platform.agents.content.v1';
export const contentDeclared = features => (features instanceof Set ? features.has(contentFeature) : Array.isArray(features) && features.includes(contentFeature));

const refused = new Set(['approval_required', 'slug_taken', 'product_unavailable']);
const failure = code => Object.assign(new Error('The article was not published.'), { code });

export function contentExecutors({ store, features = null, log = line => console.warn(line) }) {
  if (!contentDeclared(features)) return {};
  async function publish(execution) {
    const problems = checkArticle(execution.input);
    if (problems.length > 0) {
      // Codes only: the article itself stays in the action, which the owner can read.
      log(JSON.stringify({ event: 'hub_content_publish_refused', action_id: execution.id, reasons: problems }));
      throw failure('invalid_article');
    }
    if (execution.autoApproved === true) throw failure('approval_required');
    const answer = await store.contentPublish(execution.id, Number.isInteger(execution.execution) ? execution.execution : null);
    if (answer?.outcome === 'published' || answer?.outcome === 'already_published') {
      return { outcome: answer.outcome, slug: answer.slug, url: articleUrl(answer.slug) };
    }
    throw failure(refused.has(answer?.outcome) ? answer.outcome : 'publish_failed');
  }
  return { 'content.publish': publish };
}
