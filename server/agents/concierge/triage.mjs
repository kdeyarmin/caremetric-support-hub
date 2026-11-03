/**
 * `concierge.communication`: one task per inbound message. It reads a minimal view of the
 * conversation (never contact details or internal notes), screens the message for personal
 * identifiers, categorizes it by word matching, and tells the owner: by text and email when it
 * looks urgent, by email otherwise. It calls no model and keeps no message text: the alert, the
 * run summary and the task result carry kinds, the channel, the product, the reference number and
 * how long ago the message arrived.
 *
 * For a plain question it also proposes a fixed reply for the owner to approve (see templates.mjs): an
 * acknowledgment, or a notice asking the sender to resend without the identifiers it carried. A prospect's
 * first message (a website lead, or a conversation filed as a sales or Advisors inquiry) is a sales inquiry, a
 * warning, and gets the sales acknowledgment instead (with the owner's booking link when one is set). Everything
 * else is the owner's to answer, and so is a follow-up in a thread the team already joined.
 *
 * When customer text to the model is switched on (see `drafting`), one more step may follow for a plain, first
 * question that is not flagged and matches a published guide: the scrubbed text and the guides go to the model, which
 * returns a second reading and a draft answer. The reading can only make the handling more careful (a later, louder
 * alert; a fixed notice about identifiers; no reply offered at all). The draft is offered to the owner only if every
 * check in draft.mjs passes, and otherwise the fixed acknowledgment is offered as before. A model that is unavailable,
 * over budget or unusable never leaves a message without its alert or its acknowledgment.
 *
 * Alerts are capped so that anyone who can write to the support address cannot flood the owner:
 * at most 20 individual emails a day for each level (after that, one rollup email for the day) and
 * at most three urgent texts an hour (after that, urgent alerts go by email only).
 */
import { minutesBetween, permanent, plural, recordRun } from '../tasks/shared.mjs';
import { checkDraft } from './draft.mjs';
import { alertWords, categoryWord, channelWord, decide, replyFor, replyRoute, salesConversation, severityRank } from './policy.mjs';
import { buildUserMessage, promptVersion, responseSchema, systemPrompt } from './prompt.mjs';
import { redact } from './redact.mjs';
import { categorize } from './rules.mjs';
import { screenIdentifiers } from './screen.mjs';
import { conciergeSettings } from './settings.mjs';
import { replyBody } from './templates.mjs';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const dailyEmailCap = 20;
const hourlyTextCap = 3;
// How much of a message the snapshot returns, and so how much is screened and categorized. A message that fills it may be longer.
const readChars = 4000;
// A transient model failure is retried by the scheduler; from this attempt on the fixed acknowledgment is offered instead.
const modelAttempts = 3;
const efforts = new Set(['low', 'medium', 'high']);
const draftWords = {
  drafted: 'drafted reply proposed', no_answer: 'the guides do not answer it', owner_only: 'the model says it needs you', phi: 'the model found identifiers',
  refused: 'the model declined', budget: 'the model budget is used up', unavailable: 'the model was unavailable', no_guides: 'no guide matches', no_text: 'too little text to read',
};
const easternDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });

/**
 * A delivery the provider definitely refused (`failed`) is an alert the owner never got. The task is retried by the scheduler a few
 * minutes later and the notifier reopens only that channel under the same key, so a channel that was sent is never sent again.
 * An unknown delivery may have arrived and is not retried; a suppressed channel has nothing to retry.
 */
const undelivered = results => (results.some(item => item.delivery === 'failed')
  ? Object.assign(new Error('The owner alert could not be delivered.'), { code: 'alert_not_delivered', transient: true })
  : null);
// After the notifier's attempts are used up, every try says "duplicate" and the earlier status says why. When nothing reached the owner and a
// channel ended failed, there is nothing left to retry: the task fails, which shows on the Team screen, instead of passing for an alert.
const given = item => item.delivery === 'sent' || (item.delivery === 'duplicate' && item.original === 'sent');
const exhausted = results => (results.some(item => item.delivery === 'duplicate' && item.original === 'failed') && !results.some(given)
  ? Object.assign(new Error('The owner alert could not be delivered.'), { code: 'alert_not_delivered' })
  : null);

function skipReason(snapshot, payload, settings) {
  if (!snapshot) return 'not_found';
  if (snapshot.status === 'closed') return 'closed';
  // A newer message arrived: it gets its own task once it has settled.
  if (snapshot.latestInboundId !== payload.messageId) return 'superseded';
  if (snapshot.answered) return 'answered';
  if (!settings.channels.includes(snapshot.channel)) return 'channel_off';
  return null;
}

/**
 * `drafting` is `{ model, guides }` when customer text may go to the model (the owner's explicit switch, a model key
 * and the guide library), and null otherwise, which keeps the handler exactly as it is without a model.
 * `bookingUrl` is the owner's booking page (HUB_BOOKING_URL): the sales acknowledgment offers it, and nothing else does.
 */
export function triageHandler({ store, notifier, drafting = null, bookingUrl = null, log = line => console.warn(line) }) {
  // Whether this alert has been tried before in a channel: its key already has a row there. A refused try counts toward the caps like any
  // other, so a retry has to resume the alert under its own key and channels instead of being judged by the caps again, which would turn it
  // into an email-only alert or a rollup because of itself.
  const tried = async (key, channel) => await store.notificationCount({ prefix: key, channel, since: new Date(0) }) > 0;

  async function deliverAlert({ task, snapshot, payload, words, severity, now }) {
    const day = easternDate.format(now());
    const dayStart = task.budget?.dayStart ? new Date(task.budget.dayStart) : new Date(now().getTime() - 24 * 3_600_000);
    const base = { subject: words.subject, body: words.body, agentKey: task.agentKey, taskId: task.id, communicationReference: snapshot.reference };
    const rollup = level => notifier.send({
      severity: 'warning', subject: 'Many new messages today',
      body: `More than ${dailyEmailCap} ${{ urgent: 'urgent', warning: 'flagged', info: 'new' }[level]} messages have reached the Hub today, so they are no longer emailed one at a time.\n\nOpen Communications to see all of them.`,
      dedupeKey: `concierge:rollup:${level}:${day}`, agentKey: task.agentKey, taskId: task.id,
    });
    if (severity === 'urgent') {
      const urgentKey = `concierge:urgent:${snapshot.id}:${day}`;
      const [textTried, emailTried] = await Promise.all([tried(urgentKey, 'sms'), tried(urgentKey, 'email')]);
      if (textTried || emailTried) return notifier.send({ ...base, severity: textTried ? 'urgent' : 'warning', dedupeKey: urgentKey });
      const [texts, emails] = await Promise.all([
        store.notificationCount({ prefix: 'concierge:urgent:', channel: 'sms', since: new Date(now().getTime() - 3_600_000) }),
        store.notificationCount({ prefix: 'concierge:urgent:', channel: 'email', since: dayStart }),
      ]);
      if (emails >= dailyEmailCap) return rollup('urgent');
      // Past the hourly limit on texts, an urgent alert still goes by email.
      return notifier.send({ ...base, severity: texts >= hourlyTextCap ? 'warning' : 'urgent', dedupeKey: urgentKey });
    }
    const prefix = severity === 'warning' ? 'concierge:warn:' : 'concierge:new:';
    const key = `${prefix}${payload.messageId}`;
    if (await tried(key, 'email')) return notifier.send({ ...base, severity, dedupeKey: key });
    if (await store.notificationCount({ prefix, channel: 'email', since: dayStart }) >= dailyEmailCap) return rollup(severity);
    return notifier.send({ ...base, severity, dedupeKey: key });
  }

  // The caps are a count followed by a send, and up to three tasks run at once in this process: left alone, each would read the same
  // count and all would send. Alerts go one at a time through the counting and the sending, so the caps say what they mean.
  let alertQueue = Promise.resolve();
  const sendAlert = input => {
    const turn = alertQueue.then(() => deliverAlert(input), () => deliverAlert(input));
    alertQueue = turn.catch(() => {});
    return turn;
  };

  /**
   * One call to the model for a message that qualifies (the caller decides that). Returns what happened as a `state` and what
   * it means for the handling, never any text: drafted (with the checked draft), rejected (a check failed: `reason`),
   * no_answer, owner_only, phi, refused, budget, unavailable, no_guides or no_text. A transient failure early on is thrown so the
   * scheduler retries it; any other failure ends in `unavailable`, and the fixed acknowledgment is offered instead.
   */
  async function askModel({ task, snapshot, inbound, route, signal }) {
    const prior=drafting.followups?(snapshot.messages??[]).filter(m=>m.id!==inbound.id).slice(-2):[];
    if(prior.some(m=>m.body.length>=readChars))return {state:'unavailable',reason:'thread_truncated'};
    if(prior.some(m=>screenIdentifiers(m.body).flagged))return {state:'phi',phi:true};
    if(prior.some(m=>{const c=categorize({text:m.body}).category;return c && c!=='general' && c!=='sales';}))return {state:'owner_only'};
    const history=prior.map(m=>({direction:m.direction,text:redact(m.body,{limit:1000}).text}));
    const text = redact(inbound.body);
    if (text.text.length < 8) return { state: 'no_text' };
    const subject = snapshot.channel === 'email' && snapshot.subject ? redact(snapshot.subject, { limit: 300 }).text : null;
    // The alert is already sent: whatever goes wrong here, the message still gets its acknowledgment.
    let guides = [];
    try { guides = await drafting.guides.top(`${subject ?? ''} ${text.text}`, { productSlug: snapshot.productSlug }); } catch { return { state: 'no_guides' }; }
    if (!Array.isArray(guides) || guides.length === 0) return { state: 'no_guides' };
    const effort = efforts.has(task.agent?.config?.effort) ? task.agent.config.effort : 'low';
    let result;
    try {
      result = await drafting.model.run(task, {
        promptVersion, system: [{ text: systemPrompt, cache: true }], schema: responseSchema, effort, maxTokens: 4000,
        user: buildUserMessage({ channel: snapshot.channel, productSlug: snapshot.productSlug, inboundCount: snapshot.inboundCount ?? 1, subject, text: text.text, guides, history }),
        describe: output => `Read CM-${snapshot.reference} (${channelWord(snapshot.channel)}): ${categoryWord(output.category)}, ${output.urgency}${output.possiblePhi ? ', possible identifiers' : ''}; ${plural(output.citations.length, 'guide')} cited.`,
      }, { signal });
    } catch (error) {
      if (signal?.aborted || (error?.transient === true && (task.attempts ?? 1) < modelAttempts)) throw error;
      return { state: 'unavailable', reason: /^[a-z][a-z_]{0,59}$/.test(error?.code ?? '') ? error.code : 'ai_error' };
    }
    if (result.outcome === 'budget_exhausted') return { state: 'budget' };
    if (result.outcome === 'refused') return { state: 'refused' };
    const reading = result.output;
    // The model's reading can only add caution: an ordinary question it calls urgent or a sale is recorded as that.
    let category = reading.category;
    if (category === 'general' && reading.inquiryType === 'sales') category = 'sales';
    if (category === 'general' && reading.urgency === 'urgent') category = 'urgent';
    // How pressing the message is stays separate from what it is about: a billing question that cannot wait is still urgent.
    const found = { category: category === 'general' ? null : category, phi: reading.possiblePhi === true, urgent: reading.urgency === 'urgent' };
    if (found.phi) return { state: 'phi', ...found };
    if (category !== 'general') return { state: 'owner_only', ...found };
    if (reading.needsOwner || !reading.canAnswerFromGuides || !reading.reply.trim()) return { state: 'no_answer', ...found };
    // The model saw the subject as well as the body, so a name or a quotation taken from either is caught.
    const checked = checkDraft({ reply: reading.reply, citations: reading.citations, guides, text: [subject,text.text,...history.map(m=>m.text)].filter(Boolean).join('\n'), route });
    if (!checked.ok) return { state: 'rejected', reason: checked.reason, ...found };
    return { state: 'drafted', draft: { ...checked, sources: checked.citations.map(id => guides[Number(id.slice(1)) - 1].title) }, ...found };
  }

  // The owner approves the exact text. A fixed template is written here from words that repeat nothing the customer wrote; a draft was
  // checked in draft.mjs and is shown to the owner as it will be sent.
  async function proposeReply({ task, snapshot, category, phi, unread = false, draft = null }) {
    // A message too long to have been screened is the owner's to read and answer.
    if (unread) return { reply: 'owner_only' };
    const template = draft ? 'drafted' : replyFor({ category, phi, productSlug: snapshot.productSlug, inquiryType: snapshot.inquiryType, sourceSystem: snapshot.sourceSystem ?? null });
    if (!template) return { reply: 'owner_only' };
    if ((snapshot.outboundCount ?? 0) > 0 && !draft) return { reply: 'follow_up', template };
    if (task.agent?.autonomy === 'observe') return { reply: 'observe_only', template };
    const route = replyRoute(snapshot);
    if (!route) return { reply: 'no_route', template };
    const body = draft ? draft.body : replyBody(template, route, { bookingUrl });
    try {
      const proposal = await store.proposeAction({
        taskId: task.id, kind: 'communication.reply', targetKind: 'communication', targetId: `CM-${snapshot.reference}`, preview: body,
        input: {
          communicationId: snapshot.id, reference: snapshot.reference, channel: snapshot.channel, route, basedOnMessageId: snapshot.headMessageId,
          body, classification: { category, phi, ...(draft ? { drafted: true } : {}) }, template, ...(draft ? { sources: draft.sources } : {}),
        },
      });
      return { reply: proposal.created === false ? 'already_proposed' : 'proposed', template };
    } catch (error) {
      if (error?.code === '42501') return { reply: 'observe_only', template };
      throw error;
    }
  }

  // One alert, counted and sent in turn. A definite failure ends the attempt, before anything else is done, so the retry starts clean.
  async function tellOwner(input) {
    const results = await sendAlert(input);
    const refused = undelivered(results) ?? exhausted(results);
    if (refused) throw refused;
    return results.map(item => `${item.channel}:${item.delivery}`);
  }

  async function communication(task, { now = () => new Date(), signal } = {}) {
    const payload = task.payload ?? {};
    if (!uuid.test(payload.communicationId ?? '') || !uuid.test(payload.messageId ?? '')) throw permanent('invalid_payload');
    const settings = conciergeSettings(task.agent?.config);
    const snapshot = await store.communicationSnapshot({ id: payload.communicationId, messages: drafting?.followups ? 3 : 1, chars: readChars });
    const skip = skipReason(snapshot, payload, settings);
    if (skip) return { result: { outcome: 'skipped', reason: skip, reference: snapshot?.reference ?? null } };
    const inbound = (snapshot.messages ?? []).find(message => message.id === snapshot.latestInboundId);
    if (!inbound) return { result: { outcome: 'skipped', reason: 'no_message', reference: snapshot.reference } };

    // Both checks read the original text; neither keeps any of it.
    const screen = screenIdentifiers(`${snapshot.subject ?? ''}\n${inbound.body}`);
    const matched = categorize({ text: inbound.body, subject: snapshot.subject });
    // A prospect's message is a sales inquiry whatever its words say: a demo request may read only "Please contact me".
    const prospect = matched.category === 'general' && salesConversation({ sourceSystem: snapshot.sourceSystem ?? null, inquiryType: snapshot.inquiryType });
    const ruleCategory = prospect ? 'sales' : matched.category;
    const reasons = prospect ? ['sales.conversation'] : matched.reasons;
    let { severity } = decide({ category: ruleCategory, phi: screen.flagged });
    // Only the first readChars characters were screened and categorized. A message that fills them may say more, so it is never
    // quieter than a warning, and nothing is offered to the customer or sent to the model for it: not even one that opens like an
    // automatic reply, because its unread end could hold anything.
    const unread = inbound.body.length >= readChars;
    if (severity === null && !unread) return { result: { outcome: 'skipped', reason: ruleCategory, reference: snapshot.reference } };
    if (severity === null || (unread && severityRank[severity] < severityRank.warning)) severity = 'warning';

    const minutes = minutesBetween(inbound.at, now());
    const alert = alertWords({ category: ruleCategory, phi: screen.flagged, severity, channel: snapshot.channel, productSlug: snapshot.productSlug, reference: snapshot.reference, minutes, unread });
    const delivery = await tellOwner({ task, snapshot, payload, words: alert, severity, now });

    // Ordinary product questions may use reviewed guides, including bounded follow-ups when the growth feature is present.
    // Pricing, cancellation, incidents and identifiers remain owner-only; the existing customer-text opt-in still applies.
    let category = ruleCategory;
    let phi = screen.flagged;
    let asked = null;
    const route = replyRoute(snapshot);
    const eligible = drafting && !screen.flagged && !unread && route !== null && task.agent?.autonomy !== 'observe'
      && (drafting.followups || ((snapshot.inboundCount ?? 1) === 1 && (snapshot.outboundCount ?? 0) === 0))
      && (replyFor({ category: ruleCategory, phi: false, productSlug: snapshot.productSlug, inquiryType: snapshot.inquiryType, sourceSystem: snapshot.sourceSystem ?? null }) === 'standard'
        || (drafting.followups && matched.category==='general' && ['carebase','caremetric-intel'].includes(snapshot.productSlug) && snapshot.inquiryType==='sales'));
    if (eligible) {
      asked = await askModel({ task, snapshot, inbound, route, signal });
      // The scheduler has stopped waiting for this task: nothing more is sent or proposed from here.
      if (signal?.aborted) throw Object.assign(new Error('The task was stopped.'), { code: 'task_timeout', transient: true });
      if (asked.category) category = asked.category;
      if (asked.phi) phi = true;
      const reread = decide({ category, phi, urgent: asked.urgent === true }).severity;
      if (severityRank[reread] > severityRank[severity]) {
        const louder = alertWords({ category, phi, severity: reread, channel: snapshot.channel, productSlug: snapshot.productSlug, reference: snapshot.reference, minutes, source: 'model' });
        delivery.push(...(await tellOwner({ task, snapshot, payload, words: louder, severity: reread, now })));
        severity = reread;
      }
    }

    // A model that declined saw something its provider objected to: a person should read it, so nothing is offered automatically.
    const proposal = asked?.state === 'refused' ? { reply: 'model_refused' } : await proposeReply({ task, snapshot, category, phi, unread, draft: asked?.draft ?? null });
    const proposed = proposal.reply === 'proposed' || proposal.reply === 'already_proposed';
    const proposedWords = { drafted: 'drafted reply', phi: 'identifier notice', sales: 'sales acknowledgment' }[proposal.template] ?? 'acknowledgment';
    const modelWords = asked && asked.state !== 'drafted' ? `; ${asked.state === 'rejected' ? `draft not used (${asked.reason.replaceAll('_', ' ')})` : asked.state === 'unavailable' ? `the model was unavailable (${asked.reason.replaceAll('_', ' ')})` : draftWords[asked.state]}` : '';
    await recordRun({ store, log }, task, {
      promptVersion: 'rules.1',
      summary: `Triaged CM-${snapshot.reference} (${channelWord(snapshot.channel)}): ${categoryWord(category)}${phi ? ', identifiers found' : ''}; ${severity} alert (${delivery.join(', ')})${proposed ? `; ${proposedWords} proposed` : ''}${modelWords}.`,
    });
    return {
      // A proposed reply keeps the task open until the owner approves or rejects it.
      status: proposed ? 'awaiting_approval' : 'done',
      result: {
        outcome: 'alerted', reference: snapshot.reference, channel: snapshot.channel, product: snapshot.productSlug ?? null, category, phi,
        severity, delivery, reply: proposal.reply, ...(proposal.template ? { template: proposal.template } : {}), screen: screen.kinds, rules: reasons,
        ...(unread ? { unread: true } : {}),
        ...(asked ? { draft: asked.state, ...(asked.reason ? { draftReason: asked.reason } : {}) } : {}),
      },
    };
  }

  return communication;
}
