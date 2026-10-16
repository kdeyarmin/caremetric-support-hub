import { HttpError } from './sms-auth.mjs';
import { AiNotConfiguredError } from './ai-assistance.mjs';

const staffRoles = new Set(['support_agent', 'support_manager', 'platform_admin']);

function mapAiError(error) {
  if (error instanceof AiNotConfiguredError) return new HttpError(503, 'AI assistance is not configured.', 'AI_NOT_CONFIGURED');
  return error;
}

/** Knowledge guides ranked by simple keyword overlap with the case. Retrieval runs
 * through the caller's own staff session (list_published_content), so a staffer only
 * ever drafts from content they are allowed to read. */
async function knowledgeFor(rpc, sessionToken, subject, messages) {
  try {
    const listed = await rpc('list_published_content', {}, sessionToken);
    const items = (Array.isArray(listed) ? listed : []).filter((item) => item && item.kind === 'article' && typeof item.body_markdown === 'string' && item.body_markdown.trim());
    if (!items.length) return [];
    const latestCustomer = [...messages].reverse().find((message) => message.visibility === 'customer');
    const terms = new Set(`${subject ?? ''} ${latestCustomer?.body ?? ''}`.toLowerCase().split(/[^a-z0-9]+/).filter((term) => term.length >= 4));
    return items.map((item) => {
      const text = `${item.title ?? ''} ${item.summary ?? ''}`.toLowerCase();
      return { item, score: [...terms].filter((term) => text.includes(term)).length };
    }).filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score).slice(0, 3)
      .map(({ item }) => ({ title: item.title, summary: item.summary ?? '', body: item.body_markdown }));
  } catch {
    return [];
  }
}

/**
 * Staff AI case actions, behind the same SMS session and actor authorization as the
 * neighboring case endpoints: the caller must hold a staff role in
 * get_support_actor_context, and the case must be visible in their queue. The
 * handlers are read-only with respect to the case system — summarize and triage
 * return values, and draft generation returns text for the staffer's own reply box.
 * Nothing here can post, send or update a case.
 */
export function aiCaseAssistance({ ai, rpc, rows }) {
  async function handle(sessionToken, action, caseId, body) {
    if (!ai || !ai.configured) throw new HttpError(503, 'AI assistance is not configured.', 'AI_NOT_CONFIGURED');
    try {
      const context = await rpc('get_support_actor_context', {}, sessionToken);
      if (!staffRoles.has(context?.role)) throw new HttpError(403, 'AI case assistance is available to support staff only.');
      const queue = await rows('support_case_queue', sessionToken);
      const supportCase = (Array.isArray(queue) ? queue : []).find((row) => row?.id === caseId);
      if (!supportCase) throw new HttpError(404, 'Support case not found.');
      const thread = await rpc('get_support_case_thread', { p_case_id: caseId }, sessionToken);
      const messages = (Array.isArray(thread) ? thread : []).map((message) => ({
        authorName: message.author_name,
        authorRole: message.author_role,
        body: message.body,
        createdAt: message.created_at,
        visibility: message.visibility,
      }));
      const input = { subject: supportCase.subject, messages };
      if (action === 'summary') return { summary: await ai.summarize(input) };
      if (action === 'triage-suggestion') return ai.suggestTriage(input);
      const tier = body?.qualityTier === 'quality' ? 'quality' : 'draft';
      const knowledge = await knowledgeFor(rpc, sessionToken, supportCase.subject, messages);
      return { draft: await ai.draftReply({ ...input, knowledge, tier }) };
    } catch (error) {
      throw mapAiError(error);
    }
  }

  return { handle };
}
