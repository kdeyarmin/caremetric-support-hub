/**
 * `sales.reply`: one task per prospect message the Support Concierge hands over (private.sales_handoff), after the owner's alert
 * has gone out. The Sales Executive reads a minimal view of the conversation (never contact details or internal notes), and:
 *
 * - when customer text may go to the model (the owner's switch in Settings and a model key), it sends the scrubbed message, up to two
 *   earlier messages, the product and the prospect's stage to the model with the fact sheet and the sales playbook, checks the draft
 *   (check.mjs) and proposes it to the owner as a `communication.reply`, which only the owner can approve;
 * - otherwise, or when the model abstains, is unavailable, over budget or its draft fails a check, it proposes the same fixed sales
 *   acknowledgment the Concierge would have (a first message only), so handing a prospect over never leaves them without an answer;
 * - a message the model reads as carrying personal identifiers gets the fixed notice asking to resend without them;
 * - a request not to be contacted, a cancellation, a negotiation, a contract or security question and anything else the model routes to
 *   the owner gets nothing from the agent: the owner already has the alert;
 * - a prospect asking about a product the team does not market (marketing.mjs: CareBase while it is in its pilot) is not sent to the
 *   model and gets no drafted answer: a first message gets the fixed acknowledgment, and the owner is told the conversation is theirs.
 *
 * It keeps no message text: the task result, the run summary and the owner's email carry kinds, the product and the reference only.
 */
import { replyRoute } from '../concierge/policy.mjs';
import { redact } from '../concierge/redact.mjs';
import { screenIdentifiers } from '../concierge/screen.mjs';
import { replyBody } from '../concierge/templates.mjs';
import { easternDate, easternMidnight } from '../accounts/week.mjs';
import { permanent, recordRun } from '../tasks/shared.mjs';
import { marketedNow, markets } from '../marketing.mjs';
import { checkSalesReply, guideLinks, replyLinks, wordLimits } from './check.mjs';
import { buildUserMessage, responseSchema, salesPromptVersion, systemPrompt } from './prompt.mjs';
import { live } from '../../live.mjs';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const products = { carebase: 'CareMetric CareBase', 'caremetric-intel': 'CareMetric Intel' };
const readChars = 4000;
const modelAttempts = 3;
const dailyDraftAlerts = 20;
const efforts = new Set(['low', 'medium', 'high']);
// Model readings that the owner answers personally: nothing is proposed for them, not even the acknowledgment. A support question
// that reached the sales desk gets the plain support acknowledgment on a first message.
const ownerOnly = new Set(['unsubscribe', 'not_interested', 'wrong_person']);

function skipReason(snapshot, payload) {
  if (!snapshot) return 'not_found';
  if (snapshot.status === 'closed') return 'closed';
  if (snapshot.latestInboundId !== payload.messageId) return 'superseded';
  if (snapshot.answered) return 'answered';
  return null;
}

/**
 * `drafting` is `{ model, guides? }` when prospect text may go to the model (the owner's explicit switch and a model key), and null
 * otherwise; `guides` is the published guide library, whose public guides a reply may link to. `answers` is true when the database
 * admits session-less answers (platform.agents.concierge-autosend.v1): a checked, drafted answer going back by email or chat is then a
 * `communication.answer`, which goes out without the owner's session once approved, or on its own once the owner hands "Sales answers"
 * over. Nothing it proposes offers a demo, a call or a meeting (owner decisions 2026-11-08 and 2026-11-09).
 */
export function salesReplyHandler({ store, notifier = null, drafting: draftingOption = null, answers = false, marketed = null, log = line => console.warn(line) }) {
  // `drafting` may be a function (the owner's switch in Settings), read once per message.
  async function askModel({ task, snapshot, inbound, route, payload, signal, drafting }) {
    const prior = (snapshot.messages ?? []).filter(message => message.id !== inbound.id).slice(-2);
    if (prior.some(message => message.body.length >= readChars)) return { state: 'unavailable', reason: 'thread_truncated' };
    if (prior.some(message => screenIdentifiers(message.body).flagged)) return { state: 'phi' };
    const history = prior.map(message => ({ direction: message.direction, text: redact(message.body, { limit: 1000 }).text }));
    const text = redact(inbound.body).text;
    if (text.length < 4) return { state: 'no_text' };
    const links = replyLinks(payload.product);
    // The published guides that match the question, as manuals the prospect can read on their own (public ones only).
    let guides = [];
    try { guides = guideLinks(await drafting.guides?.top?.(text, { productSlug: payload.product }) ?? []); } catch { guides = []; }
    const effort = efforts.has(task.agent?.config?.effort) ? task.agent.config.effort : 'medium';
    let result;
    try {
      result = await drafting.model.run(task, {
        promptVersion: salesPromptVersion, system: [{ text: systemPrompt, cache: true }], schema: responseSchema, effort, maxTokens: 3000,
        user: buildUserMessage({
          product: products[payload.product], channel: snapshot.channel, stage: payload.opportunity?.stage ?? null, contacted: payload.opportunity?.contacted === true,
          firstMessage: (snapshot.outboundCount ?? 0) === 0, words: wordLimits[route], links, guides, text, history,
        }),
        describe: output => `Read CM-${snapshot.reference} (${products[payload.product]} prospect): ${output.intent}${output.needsOwner ? ', needs the owner' : ''}${output.possiblePhi ? ', possible identifiers' : ''}; next step ${output.nextStep}.`,
      }, { signal });
    } catch (error) {
      if (signal?.aborted || (error?.transient === true && (task.attempts ?? 1) < modelAttempts)) throw error;
      return { state: 'unavailable', reason: /^[a-z][a-z_]{0,59}$/.test(error?.code ?? '') ? error.code : 'ai_error' };
    }
    if (result.outcome === 'budget_exhausted') return { state: 'budget' };
    if (result.outcome === 'refused') return { state: 'refused' };
    const reading = result.output;
    if (reading.possiblePhi) return { state: 'phi', intent: reading.intent };
    if (ownerOnly.has(reading.intent)) return { state: 'owner_only', intent: reading.intent };
    if (reading.intent === 'support') return { state: 'support', intent: reading.intent };
    if (reading.needsOwner || !reading.reply.trim()) return { state: 'needs_owner', intent: reading.intent };
    const checked = checkSalesReply({ reply: reading.reply, product: payload.product, route, guides, text: [text, ...history.map(message => message.text)].join('\n') });
    if (!checked.ok) return { state: 'rejected', reason: checked.reason, intent: reading.intent };
    const cited = guides.filter(guide => checked.reply.includes(guide.url)).map(guide => guide.label);
    return { state: 'drafted', intent: reading.intent, nextStep: reading.nextStep, draft: checked, sources: ['CareMetric fact sheet', 'Sales playbook', ...cited].slice(0, 5) };
  }

  async function propose({ task, snapshot, route, body, template, intent, payload, sources = [] }) {
    const base = { communicationId: snapshot.id, reference: snapshot.reference, channel: snapshot.channel, route, basedOnMessageId: snapshot.headMessageId, body };
    // A checked draft going back by email or chat is an answer: exactly the fields the database admits for one.
    const answer = answers && template === 'drafted' && (route === 'email' || route === 'chat') && sources.length >= 1;
    try {
      const proposal = await store.proposeAction(answer
        ? { taskId: task.id, kind: 'communication.answer', targetKind: 'communication', targetId: `CM-${snapshot.reference}`, preview: body,
          input: { ...base, classification: { category: 'sales', phi: false, drafted: true }, template: 'drafted', sources } }
        : { taskId: task.id, kind: 'communication.reply', targetKind: 'communication', targetId: `CM-${snapshot.reference}`, preview: body,
          input: {
            ...base, classification: { category: template === 'standard' ? 'general' : 'sales', phi: template === 'phi', ...(template === 'drafted' ? { drafted: true } : {}) }, template,
            ...(template === 'drafted' ? { sources: sources.length ? sources : ['CareMetric fact sheet', 'Sales playbook'], intent } : {}), product: payload.product,
          } });
      if (proposal.created === false) return 'already_proposed';
      return answer ? (proposal.status === 'auto_approved' ? 'answer_approved' : 'answer_proposed') : 'proposed';
    } catch (error) {
      if (error?.code === '42501') return 'observe_only';
      throw error;
    }
  }

  // The owner already has the Concierge's alert about the message; this one says a drafted answer is waiting for approval, or that it
  // is going out on its own because the owner handed sales answers over.
  async function tellOwner({ task, snapshot, payload, now, sent = false }) {
    if (!notifier) return null;
    try {
      const since = easternMidnight(easternDate(now()));
      if (await store.notificationCount({ prefix: 'sales:draft:', channel: 'email', since }) >= dailyDraftAlerts) return 'capped';
      const results = await notifier.send({
        severity: 'info',
        subject: sent ? `Answered CM-${snapshot.reference}, a ${products[payload.product]} prospect` : `Reply drafted for CM-${snapshot.reference}, a ${products[payload.product]} prospect`,
        body: sent
          ? `The Sales Executive answered CM-${snapshot.reference} on its own, from the fact sheet, the sales playbook and your published guides.\n\nOpen the conversation in Communications to read it. Anything that needs you personally is still left for you.`
          : `The Sales Executive drafted an answer to CM-${snapshot.reference} from the fact sheet, the sales playbook and your published guides.\n\nOpen the AI team to read it and approve it. Nothing has been sent to the prospect.`,
        dedupeKey: `sales:draft:${payload.messageId}`, agentKey: task.agentKey, taskId: task.id, communicationReference: snapshot.reference,
      });
      return results.map(item => `${item.channel}:${item.delivery}`).join(',');
    } catch {
      log(JSON.stringify({ event: 'hub_agent_sales_alert_unsent', task_id: task.id }));
      return 'unsent';
    }
  }

  /** A prospect asking about a product the team does not market: the owner decides (for CareBase, who joins the pilot). */
  async function tellOwnerNotMarketed({ task, snapshot, payload }) {
    if (!notifier) return null;
    try {
      const results = await notifier.send({
        severity: 'info', subject: `CM-${snapshot.reference}: a ${products[payload.product]} inquiry for you`,
        body: `A prospect asked about ${products[payload.product]}, which the AI team is not marketing right now, so the Sales Executive did not draft an answer. The conversation is yours: decide whether this organization should join the pilot and reply in Communications.`,
        dedupeKey: `sales:not-marketed:${snapshot.id}`, agentKey: task.agentKey, taskId: task.id,
      });
      return results.map(item => `${item.channel}:${item.delivery}`).join(',') || 'none';
    } catch {
      log(JSON.stringify({ event: 'hub_agent_sales_alert_unsent', task_id: task.id }));
      return 'unsent';
    }
  }

  return async function reply(task, { now = () => new Date(), signal } = {}) {
    const drafting = live(draftingOption);
    const payload = task.payload ?? {};
    if (!uuid.test(payload.communicationId ?? '') || !uuid.test(payload.messageId ?? '') || !products[payload.product]) throw permanent('invalid_payload');
    const snapshot = await store.communicationSnapshot({ id: payload.communicationId, messages: 3, chars: readChars });
    const skip = skipReason(snapshot, payload);
    if (skip) return { result: { outcome: 'skipped', reason: skip, reference: snapshot?.reference ?? null } };
    const inbound = (snapshot.messages ?? []).find(message => message.id === snapshot.latestInboundId);
    if (!inbound) return { result: { outcome: 'skipped', reason: 'no_message', reference: snapshot.reference } };
    const route = replyRoute(snapshot);
    if (!route) return { result: { outcome: 'skipped', reason: 'no_route', reference: snapshot.reference } };
    // The Concierge hands over only messages its screen passed and read whole; check again, since this reads the thread anew.
    if (inbound.body.length >= readChars) return { result: { outcome: 'skipped', reason: 'unread', reference: snapshot.reference } };
    const flagged = screenIdentifiers(`${snapshot.subject ?? ''}\n${inbound.body}`).flagged;

    const marketedProduct = markets(await marketedNow(marketed), payload.product);
    const asked = flagged ? { state: 'phi' } : !marketedProduct ? { state: 'not_marketed' } : drafting ? await askModel({ task, snapshot, inbound, route, payload, signal, drafting }) : { state: 'off' };
    if (signal?.aborted) throw Object.assign(new Error('The task was stopped.'), { code: 'task_timeout', transient: true });

    const first = (snapshot.outboundCount ?? 0) === 0;
    let outcome = 'owner_only';
    let template = null;
    let body = null;
    if (asked.state === 'drafted') { template = 'drafted'; body = asked.draft.body; }
    else if (asked.state === 'phi') { template = 'phi'; body = replyBody('phi', route); }
    else if (first && asked.state === 'support') { template = 'standard'; body = replyBody('standard', route); }
    else if (first && !['owner_only', 'refused'].includes(asked.state)) { template = 'sales'; body = replyBody('sales', route); }

    let alert = null;
    if (asked.state === 'not_marketed') alert = await tellOwnerNotMarketed({ task, snapshot, payload });
    if (template) {
      outcome = await propose({ task, snapshot, route, body, template, intent: asked.intent ?? null, payload, sources: asked.sources ?? [] });
      if (template === 'drafted' && ['proposed', 'answer_proposed', 'answer_approved'].includes(outcome)) alert = await tellOwner({ task, snapshot, payload, now, sent: outcome === 'answer_approved' });
    }
    // An answer waits like a reply: for the owner, or for the drain that sends it once approved on its own.
    const proposed = ['proposed', 'already_proposed', 'answer_proposed', 'answer_approved'].includes(outcome);
    const words = { drafted: outcome === 'answer_approved' ? 'answer approved to send' : 'drafted answer', phi: 'identifier notice', sales: 'sales acknowledgment', standard: 'acknowledgment' }[template] ?? null;
    const why = asked.state === 'drafted' ? '' : asked.state === 'rejected' ? `; draft not used (${asked.reason.replaceAll('_', ' ')})`
      : asked.state === 'unavailable' ? `; the model was unavailable (${asked.reason.replaceAll('_', ' ')})` : asked.state === 'off' ? '; prospect text to AI is off' : `; ${asked.state.replaceAll('_', ' ')}`;
    await recordRun({ store, log }, task, {
      promptVersion: 'sales-rules.1',
      summary: `Handled CM-${snapshot.reference} (${products[payload.product]} prospect)${asked.intent ? `: ${asked.intent}` : ''}${proposed && words ? `; ${words} proposed` : '; left for the owner'}${why}.`,
    });
    return {
      status: proposed ? 'awaiting_approval' : 'done',
      result: {
        outcome: proposed ? 'proposed' : outcome, reference: snapshot.reference, product: payload.product, reply: template ?? 'owner_only', draft: asked.state,
        ...(asked.intent ? { intent: asked.intent } : {}), ...(asked.reason ? { draftReason: asked.reason } : {}), ...(alert ? { alert } : {}),
      },
    };
  };
}
