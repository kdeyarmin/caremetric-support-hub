/**
 * The Nov 24 measurement's follow-up (docs/AI_WORKFORCE_REVIEW_2026-11-17_TEAM.md, "November 24 measurement"): what stood between the
 * team and its first replies and customers after a week of stages 1–6.
 *
 * - Cold email reaches a shared address (info@ and the like) only once a mail server or the verification service confirmed it, and the
 *   day's emails are spread over the send hours (growth/worker.mjs, 20261124150000_first_replies.sql).
 * - The first email asks one thing and gives a dated reason to answer now (growth/draft.mjs, growth/live-evaluation.mjs).
 * - The website search confirms more of the sites it finds, and the owner can use a suggested site in one click (growth/site-search.mjs).
 * - The Support Concierge answers a message that names no product (agents/concierge).
 *
 * The database declares platform.agents.first-replies.v1 (20261124159000_first_replies_contract.sql) once all of it is in place; the
 * server uses each new database function only then.
 */
export const firstRepliesFeature = 'platform.agents.first-replies.v1';

/** Whether the database declares the follow-up (`features` is the backend contract's list or a Set). */
export const hasFirstReplies = features => (features instanceof Set ? features.has(firstRepliesFeature)
  : Array.isArray(features) && features.includes(firstRepliesFeature));
