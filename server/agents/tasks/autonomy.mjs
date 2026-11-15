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
  sales_followups: 'the Marketing Manager sends its follow-ups and replies to people who contacted CareMetric or that you added without asking you, within each product\'s daily limit and touch cap.',
  cold_email: 'the Marketing Manager sends first emails to businesses found online without asking you: to the public role address on the business\'s own website or the decision-maker you permitted, and as separate emails to the other decision-makers you permitted there (up to "Most people to email at one organization" in Settings), at most 10 a day unless you change "Most cold emails a day" in Settings, each business once, never a text, each with an unsubscribe link and your postal address.',
  named_contacts: 'the Marketing Manager permits the work address of a prospect\'s decision-maker for outreach without your review when the agency publishes it or its mail server confirms it. Guesses nothing confirmed are never kept, imported lists still wait for you, and unsubscribes and opt-outs still win.',
  learning_memo: 'the Marketing Manager uses its Monday memo for new outreach drafts as soon as it is written, as if you had chosen "Use this memo".',
  ad_campaigns: 'the Social Media Manager starts the monthly campaigns without asking you, each LinkedIn or Meta one with its first ad from creative you already approved, all within your monthly number and daily ad-set limit, each ending with its month.',
  founder_posts: 'the Social Media Manager publishes the posts for your personal LinkedIn profile at their time slots without asking you, once they pass the fact-sheet checks.',
});
const words = step => autonomyWords[step.category] ?? `${step.label.toLowerCase()} run without asking you.`;
const undo = 'To keep approving each one yourself, choose Keep approving next to it on';

export function autonomyHandlers({ store, notifier, publicOrigin, features = null, log = line => console.warn(line) }) {
  if (!declared(features) || typeof store?.autonomyDue !== 'function') return {};
  // The AI team page, where Keep approving is. Without a public address the email names the page instead of linking it.
  const page = typeof publicOrigin === 'string' && publicOrigin ? `${publicOrigin.replace(/\/+$/, '')}/admin/team` : 'the AI team page';

  async function graduate(task) {
    const first = await store.autonomyDue();
    const graduated = [];
    const waiting = [];
    const delivery = [];
    let reached = false;
    let undelivered = false;
    for (const step of first.due ?? []) {
      const outcome = await store.autonomyGraduate(step.category);
      if (!outcome?.graduated) {
        waiting.push(`${step.category}:${outcome?.reason ?? 'unknown'}`);
        // Evidence, not only a week (20261113240000_agent_watchdog.sql): the owner hears why a step did not switch.
        const evidence = outcome?.evidence ?? {};
        const decided = `${Number(evidence.reviewed ?? 0)} decision${Number(evidence.reviewed ?? 0) === 1 ? '' : 's'}`;
        if (outcome?.reason === 'too_many_rejections') {
          await notifier.send({ severity: 'warning', subject: `${step.label}: kept under your review`,
            body: `You turned down ${Number(evidence.rejected ?? 0)} of ${decided} on ${step.label.toLowerCase()} during the supervised week, more than the step allows, so it stays under your review. Look at what you turned down, then start another supervised week ${page} when you are ready.`,
            dedupeKey: `autonomy:held:${step.category}:${step.automaticAt}`, agentKey: task.agentKey, taskId: task.id });
        } else if (outcome?.reason === 'not_enough_reviews') {
          await notifier.send({ severity: 'info', subject: `${step.label}: one more supervised week`,
            body: `Only ${decided} on ${step.label.toLowerCase()} came to you during the supervised week, too few to judge it, so it stays supervised for another week ${page}.`,
            dedupeKey: `autonomy:extended:${step.category}:${outcome?.step?.automaticAt ?? step.automaticAt}`, agentKey: task.agentKey, taskId: task.id });
        }
        continue;
      }
      graduated.push(step.category);
    }
    // The switches the owner has not been told about: the ones just made, and any whose email failed on an earlier run. Each stays pending
    // in the database until its email is delivered, so neither a failed send nor a server that stopped here loses it.
    const { announce = [], soon = [] } = graduated.length > 0 ? await store.autonomyDue() : first;
    for (const step of announce) {
      const results = await notifier.send({
        severity: 'info', subject: `${step.label}: now on their own`,
        body: `Your supervised week for ${step.label.toLowerCase()} has ended. From now on ${words(step)} ${undo} ${page}.`,
        // One email per switch: the key names the moment it switched, so a retry finds what an earlier attempt sent.
        dedupeKey: `autonomy:automatic:${step.category}:${step.automaticAt}`, agentKey: task.agentKey, taskId: task.id,
      });
      reached ||= results.some(delivered);
      delivery.push(...results.map(item => `${step.category}:${item.channel}:${item.delivery}`));
      // A refused send is tried again on the next run; anything else (sent, switched off, or an answer the provider did not confirm) is done.
      if (results.some(item => item.delivery === 'failed')) undelivered = true;
      else await store.autonomyAnnounced(step.category, step.automaticAt);
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
    // The switch itself is done and stays done; the owner must still hear about it, so the task is tried again for the email alone.
    if (undelivered) throw Object.assign(new Error('The owner could not be told about a switch.'), { code: 'notification_failed', transient: true });
    return { result: { graduated, waiting, announced: announce.map(step => step.category), reminded: soon.map(step => step.category), delivery } };
  }

  return { 'autonomy.graduate': graduate };
}

