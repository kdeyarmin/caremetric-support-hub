/**
 * Learning what works (20261113200000_growth_learning.sql). `growth.learn` runs every morning and does its work on Mondays (or when the
 * owner presses Run now), while Settings → Customer growth → "Write from what is working" is on:
 *
 * 1. The database counts the last 90 days of each product's outreach: emails sent under each experiment arm and what came back (replies,
 *    positive, negative, not now, bounced), the playbook objections the Sales Executive recorded, how often a draft failed a check, and
 *    the owner's own notes on drafts they turned down. Counts and the owner's words only: no message text, address or prospect name.
 * 2. Code, not a model, writes a short memo from those counts. A comparison appears only when every arm in it has at least 20 sends, an
 *    objection only after three replies raised it, a check only after five drafts failed it. With nothing to say, nothing is proposed.
 *    Since 2026-11-17 an arm replies cannot tell yet is compared on report opens (each value with 15 emails that linked the agency's own
 *    report, 3 opens and a 10-point lead), and the reader's commonest weakness in first emails is named after three drafts.
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
// Which band of the send order an email went in (2026-11-17, "Send to the best prospects first", priority.mjs).
armNames.band = { 1: 'follow-ups to agencies that opened their report', 2: 'first emails with a brief and a checked named person',
  3: 'first emails with a brief', 4: 'other emails' };
// The first email's form is no longer compared (2026-11-17): every first email built around a market report is the report and nothing
// else, so "short" against "standard" would set emails written under different instructions side by side.
const armOrder = ['viewed', 'band', 'angle_by', 'critic', 'angle', 'subject', 'length'];
const percent = (part, whole) => `${Math.round((100 * part) / whole)}%`;
const replyRate = arm => arm.replied / arm.sent;

/**
 * Report opens, until replies can tell (2026-11-17, review stage 2). Ten cold emails a day take months to give two replies an arm, but an
 * agency opening the market report its email linked comes sooner. An arm is compared on opens only when it cannot be compared on replies,
 * only among values with at least 15 emails that linked the agency's own report, when the best has at least 3 opens and leads the worst by
 * 10 points. An open is the agency opening its report (Intel's record, never a person). The order of sending, and whether the agency had
 * already opened its report, are not compared on opens: both are decided by an open.
 */
export const minimumReported = 15;
const minimumOpens = 3;
const openLead = 0.10;
const notComparedOnOpens = new Set(['viewed', 'band']);
const openRate = arm => Number(arm.opened) / Number(arm.reported);

/** The reader's weakest point in a first email (critic.2), as the memo names it, and one sentence on what to do about it. */
const minimumWeakness = 3;
export const weaknessNotes = {
  generic_opening: { finding: 'the opening could go to any agency',
    remedy: 'Open with something true of this agency alone: its setting, its county or a dated event from the sources.' },
  about_sender: { finding: 'it talks about CareMetric before the agency',
    remedy: 'Start with the agency and its problem; the product comes after, in one sentence.' },
  too_long: { finding: 'it is too long', remedy: 'Keep only the one point that matters most to this agency, and cut every sentence that does not serve it.' },
  too_many_asks: { finding: 'it asks for too much at once', remedy: 'Ask for one thing only.' },
  unclear_ask: { finding: 'what it asks for is unclear', remedy: 'End with one plain question the reader can answer in a line.' },
  wrong_problem: { finding: 'it is aimed at a problem the agency may not have',
    remedy: 'Lead with a problem an agency of this setting plausibly has, as the sources describe it, not a general one.' },
  no_reason_now: { finding: 'it gives no reason to read it now', remedy: 'Say why it matters now: the dated event or the county figure from the sources.' },
  reads_as_template: { finding: 'it reads like a template', remedy: 'Write as one person to another, without stock phrases or marketing language.' },
};
/** Known weakness codes with whole positive counts, from the facts' `weaknesses` object. */
const knownWeaknesses = counts => Object.fromEntries(Object.entries(counts ?? {})
  .filter(([code, n]) => Object.hasOwn(weaknessNotes, code) && Number.isInteger(Number(n)) && Number(n) > 0).map(([code, n]) => [code, Number(n)]));

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
    const named = (facts?.arms ?? []).filter(item => item.arm === arm && armNames[arm]?.[item.value]);
    const values = named.filter(item => Number(item.sent) >= minimumSends);
    if (values.length >= 2) {
      const ranked = [...values].sort((a, b) => replyRate(b) - replyRate(a) || b.sent - a.sent);
      const [best, worst] = [ranked[0], ranked.at(-1)];
      if (best.replied >= 2 && replyRate(best) - replyRate(worst) >= 0.02) {
        lines.push(`In this product's outreach, ${armNames[arm][best.value]} drew replies to ${best.replied} of ${best.sent} emails (${percent(best.replied, best.sent)}); ${armNames[arm][worst.value]} drew ${worst.replied} of ${worst.sent} (${percent(worst.replied, worst.sent)}).`);
        continue;
      }
    }
    // Replies cannot tell this arm yet: compare the opens of the reports its emails linked.
    if (notComparedOnOpens.has(arm)) continue;
    const linked = named.filter(item => Number.isInteger(Number(item.reported)) && Number(item.reported) >= minimumReported
      && Number.isInteger(Number(item.opened)) && Number(item.opened) >= 0 && Number(item.opened) <= Number(item.reported));
    if (linked.length < 2) continue;
    const byOpens = [...linked].sort((a, b) => openRate(b) - openRate(a) || b.reported - a.reported || String(a.value).localeCompare(String(b.value)));
    const [best, worst] = [byOpens[0], byOpens.at(-1)];
    if (Number(best.opened) < minimumOpens || openRate(best) - openRate(worst) < openLead) continue;
    lines.push(`Replies are still too few to compare, so this compares report opens. Of the emails in this product's outreach that linked the agency's own market report, the agency opened it after ${best.opened} of ${best.reported} ${armNames[arm][best.value]} (${percent(best.opened, best.reported)}) and after ${worst.opened} of ${worst.reported} ${armNames[arm][worst.value]} (${percent(worst.opened, worst.reported)}).`);
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
  // The reader's commonest finding in recent first emails (critic.2), with what to do about it.
  const found = knownWeaknesses(facts?.weaknesses);
  const [commonest] = Object.entries(found).filter(([, n]) => n >= minimumWeakness).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (commonest) lines.push(`The reader's commonest finding in ${commonest[1]} recent first emails: ${weaknessNotes[commonest[0]].finding}. ${weaknessNotes[commonest[0]].remedy}`);
  // The owner's own notes on drafts they turned down.
  const notes = [...new Set((facts?.ownerNotes ?? []).map(ownerNote).filter(Boolean))].slice(0, 5);
  if (notes.length) lines.push(`The owner turned down recent drafts with these notes: ${notes.map(note => `"${note}"`).join('; ')}.`);
  const stats = { sent: Number(facts?.sent ?? 0), replied: Number(facts?.replied ?? 0), positive: Number(facts?.positive ?? 0), bounced: Number(facts?.bounced ?? 0),
    reported: Number(facts?.reported ?? 0), opened: Number(facts?.opened ?? 0), weaknesses: found,
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
