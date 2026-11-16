/**
 * What the Sales Executive may know about a growth prospect when it drafts a reply (review 2026-11-17, row 2.9; Settings → Customer
 * growth → "Give the Sales Executive the account brief", growth.sales_context). Read by `private.sales_growth_context`
 * (20261117190000_growth_priority.sql), which finds the prospect as the hand-over does:
 *
 * - the account brief's writer part, as the first-email writer reads it: its summary, the problems as questions, the angle and the cited
 *   opening sentence (never the research part, so never a leader's name, a fit score or the agency's own standing);
 * - which of CareMetric's emails was answered: its touch number, its subject and its form (short or standard) when it was a test arm;
 * - whether the agency opened its market report, yes or no. The reply never says it knows (check.mjs `mentionsOpen`).
 *
 * Nothing here decides anything. A sentence that carries an identifier, an email address, a phone number or a statement of an agency's
 * standing is left out, whatever the database returned, and every value is escaped like the prospect's own text.
 */
import { transaction } from '../../sms-auth.mjs';
import { escapeMarkup } from '../concierge/redact.mjs';
import { screenIdentifiers } from '../concierge/screen.mjs';
import { statesStanding } from '../../growth/standing.mjs';
import { phonesIn } from '../../growth/roster.mjs';

const emailAddress = /[^\s@]+@[^\s@]+\.[a-z]{2,}/i;
const sentences = value => String(value ?? '').replace(/\s+/g, ' ').trim()
  .split(/(?<=[.!?])(?<!\b(?:[A-Za-z]|Dr|Mr|Mrs|Ms|Jr|Sr|St|Inc|Co|Ltd|Corp)\.)\s+(?=[A-Z0-9"“(])/);
const safeSentence = sentence => Boolean(sentence) && !screenIdentifiers(sentence).flagged && !emailAddress.test(sentence)
  && phonesIn(sentence).size === 0 && !statesStanding(sentence);
/** A field's sentences that may reach the model, escaped, or null. */
const clean = (value, limit) => {
  const kept = sentences(value).filter(safeSentence).join(' ').slice(0, limit).trim();
  return kept ? escapeMarkup(kept) : null;
};

/** `(communicationId, messageId) => context | null`, one call to the database's operation for the server. */
export function salesGrowthContextReader(pool) {
  return (communicationId, messageId) => transaction(pool, async client =>
    (await client.query('select private.sales_growth_context($1, $2) as result', [communicationId, messageId])).rows[0].result);
}

/**
 * The context as the user message carries it: `{ brief, answered, reportOpened }`, any part left out when it holds nothing usable, or
 * null when nothing is.
 */
export function salesContextFor(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const brief = raw.brief && typeof raw.brief === 'object' ? {
    summary: clean(raw.brief.summary, 600),
    angle: /^[a-z_]{1,40}$/.test(raw.brief.angle ?? '') ? raw.brief.angle.replaceAll('_', ' ') : null,
    pains: (Array.isArray(raw.brief.pains) ? raw.brief.pains : []).filter(pain => typeof pain === 'string').map(pain => clean(pain, 300)).filter(Boolean).slice(0, 3),
    hook: clean(raw.brief.hook, 400),
  } : null;
  const usableBrief = brief && (brief.summary || brief.angle || brief.pains.length || brief.hook) ? brief : null;
  const touch = Number(raw.answered?.touch);
  const answered = raw.answered && Number.isInteger(touch) && touch >= 1 && touch <= 20 ? {
    touch, purpose: raw.answered.purpose === 'success' ? 'success' : 'marketing',
    subject: clean(raw.answered.subject, 150), form: /^[a-z_]{1,20}$/.test(raw.answered.form ?? '') ? raw.answered.form : null,
  } : null;
  const reportOpened = typeof raw.reportOpened === 'boolean' ? raw.reportOpened : null;
  if (!usableBrief && !answered && reportOpened === null) return null;
  return { brief: usableBrief, answered, reportOpened };
}
