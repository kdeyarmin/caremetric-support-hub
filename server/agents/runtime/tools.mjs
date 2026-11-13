/**
 * The server-side tools an agent may use in a research run (run.mjs `research`): Anthropic's web search and web fetch, which run on
 * Anthropic's side and return their results in the same response. Checked against the Claude API reference on 2026-11-13:
 *
 * - On Claude Sonnet 5.5 and Claude Opus 5.5 the current versions, `web_search_20260209` and `web_fetch_20260209` (dynamic filtering;
 *   no code execution tool may be declared beside them). Claude Haiku 5.5 is not on their list, so it gets the basic versions,
 *   `web_search_20250305` and `web_fetch_20250910`.
 * - `max_uses` caps each tool per request; web fetch reads only addresses already in the conversation (a search result, or one the
 *   request names), and `max_content_tokens` bounds what one fetch adds to the prompt.
 * - A web search costs $10 per 1,000 searches on top of tokens; a web fetch costs only the tokens it adds (pricing.mjs).
 *
 * The definitions depend only on the model and the caps, never on the prospect, so the prompt cache that follows them is reused.
 */
export const researchToolNames = Object.freeze(['web_search', 'web_fetch']);
export const fetchContentTokens = 8000;
const current = new Set(['claude-sonnet-5-5', 'claude-opus-5-5']);

export function serverTools(model, { tools, maxSearches, maxFetches }) {
  const modern = current.has(model);
  return [
    ...(tools.includes('web_search') ? [{ type: modern ? 'web_search_20260209' : 'web_search_20250305', name: 'web_search', max_uses: maxSearches }] : []),
    ...(tools.includes('web_fetch') ? [{ type: modern ? 'web_fetch_20260209' : 'web_fetch_20250910', name: 'web_fetch', max_uses: maxFetches, max_content_tokens: fetchContentTokens }] : []),
  ];
}

/** Every address a research response saw: search results, fetched pages and the citations of its text. */
export function sourcesOf(content) {
  const found = new Map();
  const add = (url, title = '') => {
    if (typeof url !== 'string' || !/^https:\/\//.test(url) || url.length > 2000 || found.has(url)) return;
    found.set(url, { url, title: typeof title === 'string' ? title.slice(0, 300) : '' });
  };
  for (const block of Array.isArray(content) ? content : []) {
    if (block?.type === 'web_search_tool_result' && Array.isArray(block.content)) for (const result of block.content) add(result?.url, result?.title);
    if (block?.type === 'web_fetch_tool_result' && block.content?.type === 'web_fetch_result') add(block.content.url, block.content.content?.title);
    if (block?.type === 'text' && Array.isArray(block.citations)) for (const citation of block.citations) add(citation?.url, citation?.title);
  }
  return [...found.values()];
}
