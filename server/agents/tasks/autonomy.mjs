/**
 * `autonomy.graduate`: the Chief of Staff's hourly check of the owner's autonomy steps (supabase/migrations/20261104220000_agent_autonomy.sql).
 *
 * When the owner hands a kind of work over, it first runs a supervised week: the agents propose and the owner approves each item. This
 * task switches a step whose week has ended to automatic (the database does the switch and audits it) and emails the owner once at
 * that moment, and once the day before, so "Keep approving" is always one click away. A step whose code is not on the Hub yet stays
 * supervised and is switched as soon as it is. The switch itself is the owner's choice, made when the week started, so this task runs
 * whatever the Chief of Staff's own autonomy is; pausing the Chief of Staff pauses it.
 *
 * Nothing here reads customer data. The emails name the kind of work and the date, nothing else.
 */
import { delivered } from '../notify.mjs';
import { recordRun, when } from './shared.mjs';

export const autonomyFeature = 'platform.agents.autonomy.v1';
const declared = features => (features instanceof Set ? features.has(autonomyFeature) : Array.isArray(features) && features.includes(autonomyFeature));

/** What each step hands over, in the owner's words: the sentence that follows "From now on". */
export const autonomyWords = Object.freeze({
  account_emails: 'the Account Manager sends the welcome, setup help, trial check-in and testimonial request emails without asking you, up to 20 a day, each with an unsubscribe link.',
  support_answers: 'the Support Concierge answers questions it can answer from your published guides without asking you. Billing, cancellations, outages, legal questions and anything with personal details still come to you.',
  articles: 'the Content Marketer publishes articles that pass the content checks without asking you.',
  offers: 'the Account Manager makes offers from your menu without asking you, within the menu\'s caps.',
});
const words = step => autonomyWords[step.category] ?? `${step.label.toLowerCase()} run without asking you.`;
const undo = 'To keep approving each one yourself, choose Keep approving next to it on';

export function autonomyHandlers({ store, notifier, publicOrigin, features = null, log = line => console.warn(line) }) {
  if (!declared(features) || typeof store?.autonomyDue !== 'function') return {};
  // The AI team page, where Keep approving is. Without a public address the email names the page instead of linking it.
  const page = typeof publicOrigin === 'string' && publicOrigin ? `${publicOrigin.replace(/\/+$/, '')}/admin/team` : 'the AI team page';

  async function graduate(task) {
    const { due = [], soon = [] } = await store.autonomyDue();
    const graduated = [];
    const waiting = [];
    const delivery = [];
    let reached = false;
    for (const step of due) {
      const outcome = await store.autonomyGraduate(step.category);
      if (!outcome?.graduated) { waiting.push(`${step.category}:${outcome?.reason ?? 'unknown'}`); continue; }
      graduated.push(step.category);
      const switched = outcome.step ?? step;
      const results = await notifier.send({
        severity: 'info', subject: `${step.label}: now on their own`,
        body: `Your supervised week for ${step.label.toLowerCase()} has ended. From now on ${words(step)} ${undo} ${page}.`,
        // One email per switch: the key names the moment it switched, so a retried task finds it already sent.
        dedupeKey: `autonomy:automatic:${step.category}:${switched.automaticAt ?? step.automaticAt}`, agentKey: task.agentKey, taskId: task.id,
      });
      reached ||= results.some(delivered);
      delivery.push(...results.map(item => `${step.category}:${item.channel}:${item.delivery}`));
    }
    for (const step of soon) {
      const results = await notifier.send({
        severity: 'info', subject: `${step.label}: on their own from ${when(step.automaticAt)}`,
        body: `Your supervised week for ${step.label.toLowerCase()} ends ${when(step.automaticAt)}. From then on ${words(step)} ${undo} ${page}.`,
        dedupeKey: `autonomy:soon:${step.category}:${step.automaticAt}`, agentKey: task.agentKey, taskId: task.id,
      });
      delivery.push(...results.map(item => `${step.category}:${item.channel}:${item.delivery}`));
    }
    if (graduated.length > 0) {
      await recordRun({ store, log }, task, {
        promptVersion: 'autonomy.1', outcome: 'completed',
        summary: `Switched to automatic after the supervised week: ${graduated.join(', ')}.${reached ? '' : ' The email telling the owner was not confirmed.'}`,
      });
    }
    return { result: { graduated, waiting, reminded: soon.map(step => step.category), delivery } };
  }

  return { 'autonomy.graduate': graduate };
}

