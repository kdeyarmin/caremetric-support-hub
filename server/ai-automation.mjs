import { transaction } from './sms-auth.mjs';

// The durable system identity created by the AI case assistance migration. AI
// messages and notes are authored by this user, never by a human staffer; the
// private.ai_automation_* database operations write as it.
export const aiAssistantUserId = 'a1a00000-a1a0-4000-8000-000000000001';
export const aiAssistantDisplayName = 'CareMetric AI Assistant';

// Hard cap: a case gets at most two automated attempts, ever. Enforced here and by
// the attempts check constraint on hub.case_ai_automation.
export const maxAiAttempts = 2;

// A case whose automated step fails this many times in a row is handed to staff,
// unless the failure is a provider outage, which is retried with backoff for as long
// as it lasts. Each failure waits retryDelayMs doubled per failure, up to
// maxRetryDelayMs, before the case is picked up again.
export const maxConsecutiveFailures = 3;

// The private.ai_automation_post_message / post_note body limit (and the
// hub.case_messages.body check). JavaScript counts UTF-16 code units, never fewer
// than the code points Postgres counts, so a body within it here is within it there.
export const maxAiMessageCharacters = 5000;
export const automatedSignature = '— CareMetric AI Assistant (automated reply)';

const staffRoles = new Set(['support_agent', 'support_manager', 'platform_admin']);
const terminalStages = new Set(['exhausted', 'resolved', 'halted']);

const followUpNudge = [
  'Just checking in — did the steps in our last message fix the problem?',
  'If it did, you can mark this case resolved with the "That fixed it" button on the case. If you are still seeing the problem, reply here and tell us what happened, and we will keep working on it.',
  '',
  automatedSignature,
].join('\n');

// Replaces the closing question a shortened draft loses with its tail.
const shortenedDraftClosing = 'Did these steps fix the problem? Reply here and let us know.';

function clip(value, limit) {
  const text = typeof value === 'string' ? value : '';
  return text.length > limit ? text.slice(0, limit) : text;
}

// Cuts text to at most limit characters: at the last paragraph break within it, else
// the last line break or sentence end, as long as the cut keeps at least half of the
// limit; otherwise at the last word break, marked with an ellipsis.
function cutAtBoundary(text, limit) {
  if (text.length <= limit) return text;
  const floor = Math.floor(limit / 2);
  // One character past the limit shows whether a sentence ends exactly at it.
  const head = text.slice(0, limit + 1);
  const paragraph = head.lastIndexOf('\n\n');
  if (paragraph >= floor) return head.slice(0, paragraph).trimEnd();
  let sentence = -1;
  // A period after a digit is usually a list number ("2. Open Reports"), not an end.
  for (const match of head.matchAll(/(?<!\d)[.!?](?=\s)|\n/g)) {
    const end = match[0] === '\n' ? match.index : match.index + 1;
    if (end <= limit) sentence = end;
  }
  if (sentence >= floor) return head.slice(0, sentence).trimEnd();
  // The ellipsis takes the last character, so cut strictly inside the limit.
  let cut = head.slice(0, limit).search(/\s\S*$/);
  if (cut < floor) cut = limit - 1;
  // Never split a surrogate pair.
  if (/[\uD800-\uDBFF]/.test(head[cut - 1] ?? '')) cut -= 1;
  return `${head.slice(0, cut).trimEnd()}…`;
}

/** A draft that fits the post limit is posted exactly as written. A longer one would
 * be refused on every sweep, so it is cut back to a paragraph or sentence boundary
 * and closed with the question it lost and the required automated-reply signature. */
export function fitAutomatedReply(draft) {
  const text = String(draft ?? '').trim();
  if (text.length <= maxAiMessageCharacters) return text;
  const body = text.endsWith(automatedSignature) ? text.slice(0, -automatedSignature.length).trimEnd() : text;
  const ending = `\n\n${shortenedDraftClosing}\n\n${automatedSignature}`;
  return `${cutAtBoundary(body, maxAiMessageCharacters - ending.length)}${ending}`;
}

function stripHtml(value) {
  return String(value ?? '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim();
}

function rankKnowledge(items, sourceText) {
  const terms = new Set(String(sourceText ?? '').toLowerCase().split(/[^a-z0-9]+/).filter((term) => term.length >= 4));
  return items.map((item) => {
    const text = `${item.title ?? ''} ${item.summary ?? ''}`.toLowerCase();
    return { item, score: [...terms].filter((term) => text.includes(term)).length };
  }).filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score).slice(0, 3)
    .map(({ item }) => ({ title: item.title, summary: item.summary ?? '', body: stripHtml(item.body) }));
}

/** Postgres-backed automation store. The Hub server pool connects as hub_app_server,
 * which does not bypass RLS and holds no privilege on the case, content or audit
 * tables. Each step is a narrow private.ai_automation_* operation that only the server
 * role may execute (supabase/migrations/20261020120000_ai_automation_server_boundary.sql):
 * it acts only on cases under automation, at the stage the step belongs to, and
 * writes only as the AI assistant identity. */
export function sqlAutomationStore(pool) {
  const query = (text, values = []) => transaction(pool, (client) => client.query(text, values));
  return {
    async findNewEligibleCaseIds() {
      const result = await query('select case_id from private.ai_automation_eligible_cases() as case_id');
      return result.rows.map((row) => row.case_id);
    },

    async claimCase(caseId) {
      const result = await query('select private.ai_automation_claim($1) as claimed', [caseId]);
      return result.rows[0].claimed === true;
    },

    async findActiveCaseIds() {
      const result = await query('select case_id from private.ai_automation_active_cases() as case_id');
      return result.rows.map((row) => row.case_id);
    },

    async loadWork(caseId) {
      const result = await query('select private.ai_automation_work($1) as work', [caseId]);
      return result.rows[0].work ?? null;
    },

    async knowledgeForCase({ caseId, subject, latestCustomerBody }) {
      const result = await query('select title, summary, body from private.ai_automation_knowledge($1)', [caseId]);
      return rankKnowledge(result.rows, `${subject ?? ''} ${latestCustomerBody ?? ''}`);
    },

    async postAiMessage(caseId, body) {
      const result = await query('select private.ai_automation_post_message($1, $2) as id', [caseId, body]);
      return result.rows[0].id;
    },

    async postAiNote(caseId, body) {
      await query('select private.ai_automation_post_note($1, $2)', [caseId, body]);
    },

    async escalateCase(caseId) {
      await query('select private.ai_automation_escalate($1)', [caseId]);
    },

    async resolveCase(caseId) {
      await query('select private.ai_automation_resolve($1)', [caseId]);
    },

    async saveState(caseId, patch) {
      await query('select private.ai_automation_save_state($1, $2::jsonb)', [caseId, JSON.stringify(patch)]);
    },
  };
}

function threadForAi(work) {
  const messages = work.messages.map((message) => ({
    authorName: message.authorName, authorRole: message.authorRole, body: message.body,
    createdAt: message.createdAt, visibility: 'customer',
  }));
  const notes = work.notes.map((note) => ({
    authorName: note.authorName, authorRole: note.authorRole, body: note.body,
    createdAt: note.createdAt, visibility: 'internal',
  }));
  return [...messages, ...notes].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

function latestCustomerMessage(work) {
  return [...work.messages].reverse().find((message) => message.authorRole === 'customer' || message.authorRole === 'tenant_admin') ?? null;
}

/**
 * The auto-resolution loop. Driven by an in-server interval sweep (see main.mjs);
 * every transition is persisted in hub.case_ai_automation, so a restart resumes
 * exactly where the loop left off. Fail-closed: the sweep does nothing unless it is
 * explicitly enabled AND the AI provider is configured.
 *
 * A step that fails leaves its case where it was and is retried after a backoff
 * (consecutive_failures / retry_at, migration 20261020160000). A provider outage is
 * retried for as long as it lasts; any other failure hands the case to staff once
 * maxConsecutiveFailures steps in a row have failed, so a case can never cost a
 * provider call every sweep while the customer gets neither a reply nor a human.
 */
export function aiAutomation({ ai, store, enabled = false, followUpDelayMs = 24 * 60 * 60 * 1000, retryDelayMs = 5 * 60 * 1000, maxRetryDelayMs = 30 * 60 * 1000, draftTier = 'draft', now = () => new Date(), log = (line) => console.log(line) }) {
  let running = false;
  const active = () => enabled === true && Boolean(ai?.configured);

  // A step that went through ends a failure streak and its backoff. Sent only when
  // there is a streak, so the loop runs unchanged on a backend without the columns.
  const recovered = (state) => (state.consecutiveFailures > 0 ? { consecutiveFailures: 0, retryAt: null } : {});

  async function runAttempt(work) {
    const { state } = work;
    if (state.attempts >= maxAiAttempts) return escalate(work);
    const latest = latestCustomerMessage(work);
    const knowledge = await store.knowledgeForCase({ caseId: work.caseId, subject: work.subject, latestCustomerBody: latest?.body });
    const draft = await ai.draftReply({
      subject: work.subject,
      messages: threadForAi(work).filter((entry) => entry.visibility === 'customer'),
      knowledge,
      tier: draftTier,
      automated: true,
      attempt: state.attempts + 1,
      failureContext: state.lastCustomerResponse,
    });
    const messageId = await store.postAiMessage(work.caseId, fitAutomatedReply(draft));
    const attemptedAt = now();
    await store.saveState(work.caseId, {
      stage: 'awaiting_response',
      attempts: state.attempts + 1,
      lastAttemptAt: attemptedAt,
      lastAiMessageId: messageId,
      lastSeenCustomerMessageId: latest?.id ?? null,
      followUpDueAt: new Date(attemptedAt.getTime() + followUpDelayMs),
      followUpSentAt: null,
      respondedAt: null,
      ...recovered(state),
    });
  }

  async function exhaustedNote(work) {
    let summary;
    try {
      summary = clip(await ai.summarizeForEscalation({ subject: work.subject, messages: threadForAi(work) }), 3000);
    } catch {
      summary = `Automated help was attempted ${work.state.attempts} time(s) without resolving this case.`
        + (work.state.lastCustomerResponse ? ` The customer's latest response: "${clip(work.state.lastCustomerResponse, 500)}"` : '');
    }
    return [
      'ESCALATED — AI attempts exhausted.',
      '',
      summary,
      '',
      `The customer still reports the problem is not fixed after ${work.state.attempts} automated attempt(s). A support team member needs to take over this case.`,
    ].join('\n');
  }

  // No provider call: whatever kept failing may well be the provider.
  function failureNote(state) {
    return [
      'ESCALATED — AI automation could not complete.',
      '',
      `The AI assistant's last ${state.consecutiveFailures} automated steps on this case failed, so it stopped retrying. `
        + (state.attempts > 0 ? `It had sent ${state.attempts} automated attempt(s) to the customer.` : 'The customer has not received an automated reply.')
        + (state.lastCustomerResponse ? ` The customer's latest response: "${clip(state.lastCustomerResponse, 500)}"` : ''),
      '',
      'A support team member needs to take over this case.',
    ].join('\n');
  }

  async function escalate(work) {
    const note = work.state.consecutiveFailures >= maxConsecutiveFailures ? failureNote(work.state) : await exhaustedNote(work);
    await store.postAiNote(work.caseId, note);
    await store.escalateCase(work.caseId);
    await store.saveState(work.caseId, { stage: 'exhausted', escalatedAt: now() });
  }

  // Records a failed step. The case stays at its stage and waits out a doubling
  // backoff; after maxConsecutiveFailures failures that are not provider outages it
  // goes to staff through the escalation step instead. An escalation that itself
  // fails only backs off: it needs no provider call once the streak is that long.
  async function recordFailure(caseId, error) {
    const work = await store.loadWork(caseId);
    if (!work || !work.state || terminalStages.has(work.state.stage)) return;
    const failures = (work.state.consecutiveFailures ?? 0) + 1;
    if (error?.transient === true || failures < maxConsecutiveFailures || work.state.stage === 'escalate_due') {
      const delay = Math.min(retryDelayMs * 2 ** (failures - 1), maxRetryDelayMs);
      await store.saveState(caseId, { consecutiveFailures: failures, retryAt: new Date(now().getTime() + delay) });
      return;
    }
    await store.saveState(caseId, { stage: 'escalate_due', consecutiveFailures: failures, retryAt: null });
    log(JSON.stringify({ event: 'hub_ai_automation_escalated_after_failures', case_id: caseId, consecutive_failures: failures }));
    await escalate({ ...work, state: { ...work.state, stage: 'escalate_due', consecutiveFailures: failures } });
  }

  async function processCase(caseId) {
    const work = await store.loadWork(caseId);
    if (!work || !work.state || terminalStages.has(work.state.stage)) return;
    if (work.status === 'resolved' || work.status === 'closed') {
      await store.saveState(caseId, { stage: 'halted', haltReason: 'case_closed' });
      return;
    }
    const staffEngaged = work.messages.some((message) => staffRoles.has(message.authorRole));
    if (staffEngaged) {
      await store.saveState(caseId, { stage: 'halted', haltReason: 'staff_engaged' });
      return;
    }
    const { state } = work;

    if (state.stage === 'attempt_due') return runAttempt(work);
    if (state.stage === 'escalate_due') return escalate(work);
    if (state.stage !== 'awaiting_response') return;

    const latest = latestCustomerMessage(work);
    if (latest && latest.id !== state.lastSeenCustomerMessageId) {
      const outcome = await ai.classifyResolution({ text: latest.body });
      if (outcome === 'fixed') {
        await store.resolveCase(caseId);
        await store.saveState(caseId, {
          stage: 'resolved', respondedAt: now(), responseSource: 'classification',
          lastSeenCustomerMessageId: latest.id, lastCustomerResponse: clip(latest.body, 5000),
        });
        return;
      }
      if (outcome === 'not_fixed') {
        const nextStage = state.attempts >= maxAiAttempts ? 'escalate_due' : 'attempt_due';
        await store.saveState(caseId, {
          stage: nextStage, respondedAt: now(), responseSource: 'classification',
          lastSeenCustomerMessageId: latest.id, lastCustomerResponse: clip(latest.body, 5000),
          ...recovered(state),
        });
        const refreshed = await store.loadWork(caseId);
        if (!refreshed) return;
        return nextStage === 'escalate_due' ? escalate(refreshed) : runAttempt(refreshed);
      }
      // Unclear: record that the message was seen so it is not reclassified, and
      // keep waiting for a clearer answer or the portal buttons.
      await store.saveState(caseId, { lastSeenCustomerMessageId: latest.id, ...recovered(state) });
      return;
    }

    if (state.followUpDueAt && !state.followUpSentAt && new Date(state.followUpDueAt).getTime() <= now().getTime()) {
      await store.postAiMessage(caseId, followUpNudge);
      await store.saveState(caseId, { followUpSentAt: now(), ...recovered(state) });
    }
  }

  const errorMessage = (error) => (error instanceof Error ? error.message : 'unknown');

  async function sweepCase(caseId) {
    try {
      await processCase(caseId);
    } catch (error) {
      log(JSON.stringify({ event: 'hub_ai_automation_error', case_id: caseId, message: errorMessage(error), transient: error?.transient === true }));
      await recordFailure(caseId, error).catch((failure) => log(JSON.stringify({ event: 'hub_ai_automation_failure_handling_error', case_id: caseId, message: errorMessage(failure) })));
    }
  }

  async function tick() {
    if (running || !active()) return { processed: 0, skipped: true };
    running = true;
    let processed = 0;
    try {
      for (const caseId of await store.findNewEligibleCaseIds()) {
        if (await store.claimCase(caseId)) {
          await sweepCase(caseId);
          processed += 1;
        }
      }
      for (const caseId of await store.findActiveCaseIds()) {
        await sweepCase(caseId);
        processed += 1;
      }
    } finally {
      running = false;
    }
    return { processed, skipped: false };
  }

  return { tick, active, processCase };
}
