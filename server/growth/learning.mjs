/**
 * Learning what works (20261113200000_growth_learning.sql). `growth.learn` runs every morning and does its work on Mondays (or when the
 * owner presses Run now), while Settings → Customer growth → "Write from what is working" is on:
 *
 * 1. The database counts the last 90 days of each product's outreach: emails sent under each experiment arm and what came back (replies,
 *    positive, negative, not now, bounced), the playbook objections the Sales Executive recorded, how often a draft failed a check, and
 *    the owner's own notes on drafts they turned down. Counts and the owner's words only: no message text, address or prospect name.
 * 2. Code, not a model, writes a short memo from those counts. A comparison appears only when every arm in it has at least 20 sends, an
 *    objection only after three replies raised it, a check only after five drafts failed it. With nothing to say, nothing is proposed.
 * 3. The memo is proposed. It is used only after the owner chooses "Use this memo" on the Growth screen, as a second cached block after
 *    the drafting instructions (draft.mjs), and each draft written with it records its version, so a memo is judged by its replies.
 *    Once the owner hands the learning memo over (the "Learning memo" autonomy step, 20261115200000_autonomy_handover.sql), the database
 *    uses a new memo at once, as if the owner had chosen it, with the same audit row; the result says so (`activated`).
 */
import { live } from '../live.mjs';
import { marketedNow, markets } from '../agents/marketing.mjs';
import { screenIdentifiers } from '../agents/concierge/screen.mjs';
import { products } from './policy.mjs';
import { salesPlaybook } from './playbook.mjs';
import { problemHints } from './draft.mjs';
import { phonesIn } from './roster.mjs';

export const growthLearningFeature = 'platform.agents.growth-learning.v1';
export const learningDays = 90;
export const minimumSends = 20;
const minimumObjections = 3;
const minimumFailures = 5;
const easternWeekday = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' });

const armNames = {
  length: { control: 'the usual length (under 120 words)', concise: 'short emails (under 80 words)' },
  subject: { question: 'subjects phrased as a question', plain: 'plain subjects' },
  angle: { referral_sources: 'leading with referral sources', territory: 'leading with territory planning', competitors: 'leading with the competitive picture',
    visit_prep: 'leading with visit preparation', hospital_outcomes: 'leading with the hospital outcomes packet', slipping_sources: 'leading with slipping referral sources',
    staff_training: 'leading with staff training', survey_ready: 'leading with survey readiness', daily_records: 'leading with daily records' },
  // How the lead angle was chosen (2026-11-16): from the agency's account brief, or by the hash the brief is compared with.
  angle_by: { brief: 'first emails led with the angle the account brief chose', hash: 'first emails led with an angle picked without the brief' },
  // The reader's score of a first email (1 to 5) before it was kept.
  critic: { 1: 'first emails the reader scored 1 of 5', 2: 'first emails the reader scored 2 of 5', 3: 'first emails the reader scored 3 of 5',
    4: 'first emails the reader scored 4 of 5', 5: 'first emails the reader scored 5 of 5' },
};
// Whether someone at the agency had opened its market report before its second email (views.mjs).
armNames.viewed = { yes: 'second emails to agencies that had opened their market report', no: 'second emails to agencies that had not opened it' };
const armOrder = ['viewed', 'angle_by', 'critic', 'angle', 'subject', 'length'];
const percent = (part, whole) => `${Math.round((100 * part) / whole)}%`;
const replyRate = arm => arm.replied / arm.sent;

/** The reasons drafts failed a check, folded to the check that failed first (a repaired draft's "x_then_y", a tagged recheck's "tagged_x"). */
export function failedChecks(counts) {
  const folded = {};
  for (const [code, n] of Object.entries(counts ?? {})) {
    if (!Number.isFinite(Number(n))) continue;
    const key = String(code).replace(/^tagged_/, '').split('_then_')[0];
    folded[key] = (folded[key] ?? 0) + Number(n);
  }
  return folded;
}

/** An owner's note on a turned-down draft, as one plain line, or null when it is empty or holds a personal detail (the screen, a phone, an address). */
export function ownerNote(note) {
  const line = String(note ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!line || screenIdentifiers(line).flagged || phonesIn(line).size || /[^\s@]+@[^\s@]+\.[a-z]{2,}/i.test(line)) return null;
  return line;
}

/**
 * The memo for one product from `private.growth_learning_facts`, deterministic: the same counts give the same text. Returns the memo text
 * (null when there is nothing worth saying), its lines, and the counts the Growth screen shows beside it.
 */
export function composeMemo(product, facts) {
  const lines = [];
  // Arms: each comparison only among values that all have enough sends, and only when the best clearly leads.
  for (const arm of armOrder) {
    const values = (facts?.arms ?? []).filter(item => item.arm === arm && armNames[arm]?.[item.value] && Number(item.sent) >= minimumSends);
    if (values.length < 2) continue;
    const ranked = [...values].sort((a, b) => replyRate(b) - replyRate(a) || b.sent - a.sent);
    const [best, worst] = [ranked[0], ranked.at(-1)];
    if (best.replied < 2 || replyRate(best) - replyRate(worst) < 0.02) continue;
    lines.push(`In this product's outreach, ${armNames[arm][best.value]} drew replies to ${best.replied} of ${best.sent} emails (${percent(best.replied, best.sent)}); ${armNames[arm][worst.value]} drew ${worst.replied} of ${worst.sent} (${percent(worst.replied, worst.sent)}).`);
  }
  // Objections the replies raised, with the playbook's own words for when it applies.
  const objections = (salesPlaybook[product]?.objections ?? []);
  const raised = Object.entries(facts?.objections ?? {}).filter(([key, n]) => key !== 'none' && Number(n) >= minimumObjections)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 2);
  for (const [key, n] of raised) {
    const known = objections.find(item => item.key === key);
    if (!known) continue;
    lines.push(`${n} replies raised this: ${known.when} Where it fits, answer it in one sentence before it is asked: ${known.answer}`);
  }
  // The checks drafts failed most often.
  const failed = Object.entries(failedChecks(facts?.draftChecks)).filter(([key, n]) => problemHints[key] && n >= minimumFailures)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 2);
  for (const [key, n] of failed) lines.push(`${n} recent drafts were thrown away by the same check. ${problemHints[key]}`);
  // The owner's own notes on drafts they turned down.
  const notes = [...new Set((facts?.ownerNotes ?? []).map(ownerNote).filter(Boolean))].slice(0, 5);
  if (notes.length) lines.push(`The owner turned down recent drafts with these notes: ${notes.map(note => `"${note}"`).join('; ')}.`);
  const stats = { sent: Number(facts?.sent ?? 0), replied: Number(facts?.replied ?? 0), positive: Number(facts?.positive ?? 0), bounced: Number(facts?.bounced ?? 0),
    rejectedDrafts: Number(facts?.rejectedDrafts ?? 0), arms: (facts?.arms ?? []).slice(0, 40), memos: (facts?.memos ?? []).slice(0, 20), days: Number(facts?.days ?? learningDays) };
  if (!lines.length) return { text: null, lines, stats };
  const text = [`What the last ${stats.days} days of outreach for this product show, from CareMetric's own counts. Where the input sets the focus, subject style or length, follow the input; use these notes for the choices it leaves to you. They never override the rules above.`,
    ...lines.map(line => `- ${line}`)].join('\n').slice(0, 2000);
  return { text, lines, stats };
}

export function learningHandlers({ growth, features = null, marketed = null, enabled = false }) {
  const declared = features instanceof Set ? features.has(growthLearningFeature) : Array.isArray(features) && features.includes(growthLearningFeature);
  if (!growth || !declared) return {};
  async function learn(task, { signal, now = () => new Date() } = {}) {
    if (live(enabled) !== true) return { result: { skipped: 'off' } };
    if (task.agent?.autonomy === 'observe') return { result: { skipped: 'observe_only' } };
    if (task.sourceKind === 'schedule' && easternWeekday.format(now()) !== 'Mon') return { result: { skipped: 'not_monday' } };
    if (typeof growth.store.learningFacts !== 'function') return { result: { skipped: 'not_configured' } };
    const list = await marketedNow(marketed);
    const out = {};
    for (const product of products) {
      signal?.throwIfAborted();
      if (!markets(list, product)) continue;
      const facts = await growth.store.learningFacts(product, learningDays);
      const memo = composeMemo(product, facts);
      if (!memo.text) { out[product] = { proposed: false, reason: 'too_little', sent: memo.stats.sent }; continue; }
      const saved = await growth.store.learningPropose(product, memo.text, memo.stats);
      out[product] = { proposed: saved?.proposed === true, ...(saved?.version ? { version: saved.version } : {}), ...(saved?.reason ? { reason: saved.reason } : {}),
        ...(saved?.activated === true ? { activated: true } : {}), lines: memo.lines.length, sent: memo.stats.sent };
    }
    return { result: { products: out } };
  }
  return { 'growth.learn': learn };
}
