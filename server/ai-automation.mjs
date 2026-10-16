import { transaction } from './sms-auth.mjs';

// The durable system identity created by the AI case assistance migration. AI
// messages and notes are authored by this user, never by a human staffer.
export const aiAssistantUserId = 'a1a00000-a1a0-4000-8000-000000000001';
export const aiAssistantDisplayName = 'CareMetric AI Assistant';

// Hard cap: a case gets at most two automated attempts, ever. Enforced here and by
// the attempts check constraint on hub.case_ai_automation.
export const maxAiAttempts = 2;

const staffRoles = new Set(['support_agent', 'support_manager', 'platform_admin']);
const terminalStages = new Set(['exhausted', 'resolved', 'halted']);

const followUpNudge = [
  'Just checking in — did the steps in our last message fix the problem?',
  'If it did, you can mark this case resolved with the "That fixed it" button on the case. If you are still seeing the problem, reply here and tell us what happened, and we will keep working on it.',
  '',
  '— CareMetric AI Assistant (automated reply)',
].join('\n');

function clip(value, limit) {
  const text = typeof value === 'string' ? value : '';
  return text.length > limit ? text.slice(0, limit) : text;
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

/** Postgres-backed automation store. The server role bypasses RLS by design (the
 * same trust level as the other in-server workers); every write is parameterized and
 * attributed to the AI assistant identity. */
export function sqlAutomationStore(pool) {
  return {
    async findNewEligibleCaseIds() {
      return transaction(pool, async (client) => {
        const result = await client.query(`
          select support_case.id
          from hub.support_cases support_case
          where support_case.source = 'portal'
            and support_case.status in ('open', 'in_progress')
            and support_case.created_at > now() - interval '7 days'
            and not exists (select 1 from hub.case_ai_automation automation where automation.case_id = support_case.id)
            and not exists (
              select 1 from hub.case_messages message
              where message.case_id = support_case.id
                and message.author_role in ('support_agent', 'support_manager', 'platform_admin')
            )
          order by support_case.created_at asc
          limit 10
        `);
        return result.rows.map((row) => row.id);
      });
    },

    async claimCase(caseId) {
      return transaction(pool, async (client) => {
        const result = await client.query(
          'insert into hub.case_ai_automation (case_id) values ($1) on conflict (case_id) do nothing returning case_id',
          [caseId],
        );
        return result.rowCount > 0;
      });
    },

    async findActiveCaseIds() {
      return transaction(pool, async (client) => {
        const result = await client.query(`
          select automation.case_id
          from hub.case_ai_automation automation
          where automation.stage in ('attempt_due', 'awaiting_response', 'escalate_due')
          order by automation.updated_at asc
          limit 25
        `);
        return result.rows.map((row) => row.case_id);
      });
    },

    async loadWork(caseId) {
      return transaction(pool, async (client) => {
        const supportCase = await client.query(
          'select id, subject, product_id as "productId", status, priority from hub.support_cases where id = $1',
          [caseId],
        );
        if (!supportCase.rows[0]) return null;
        const state = await client.query('select * from hub.case_ai_automation where case_id = $1', [caseId]);
        const messages = await client.query(`
          select id, author_id as "authorId", author_display_name as "authorName", author_role as "authorRole",
                 body, created_at as "createdAt"
          from hub.case_messages where case_id = $1 order by created_at asc, id asc
        `, [caseId]);
        const notes = await client.query(`
          select id, author_display_name as "authorName", author_role as "authorRole", body, created_at as "createdAt"
          from private.case_notes where case_id = $1 order by created_at asc, id asc
        `, [caseId]);
        const row = state.rows[0];
        return {
          caseId,
          subject: supportCase.rows[0].subject,
          productId: supportCase.rows[0].productId,
          status: supportCase.rows[0].status,
          priority: supportCase.rows[0].priority,
          state: row ? {
            stage: row.stage,
            attempts: row.attempts,
            lastSeenCustomerMessageId: row.last_seen_customer_message_id,
            lastCustomerResponse: row.last_customer_response,
            followUpDueAt: row.follow_up_due_at,
            followUpSentAt: row.follow_up_sent_at,
          } : null,
          messages: messages.rows,
          notes: notes.rows,
        };
      });
    },

    async knowledgeForCase({ productId, subject, latestCustomerBody }) {
      return transaction(pool, async (client) => {
        // The list_published_content publication filters, restricted to
        // customer-safe articles: automated replies must never draw on staff-only
        // content, and there is no caller session to scope access with here.
        const result = await client.query(`
          select revision.title, revision.summary, revision.body_markdown as body
          from hub.content_publications publication
          join hub.content_items item on item.id = publication.item_id
          join hub.content_revisions revision on revision.id = publication.revision_id and revision.item_id = publication.item_id
          join hub.products product on product.id = publication.product_id
          where publication.product_id = $1
            and item.status = 'published'
            and revision.review_state = 'approved'
            and product.status <> 'retired' and product.support_enabled
            and (revision.product_overlay_id is null or revision.product_overlay_id = publication.product_id)
            and publication.published_at <= now()
            and (publication.expires_at is null or publication.expires_at > now())
            and item.access_level in ('public', 'customer')
            and item.kind = 'article'
          order by publication.published_at desc
          limit 12
        `, [productId]);
        return rankKnowledge(result.rows, `${subject ?? ''} ${latestCustomerBody ?? ''}`);
      });
    },

    async postAiMessage(caseId, body) {
      return transaction(pool, async (client) => {
        const inserted = await client.query(`
          insert into hub.case_messages (case_id, author_id, author_display_name, author_role, body)
          values ($1, $2, $3, 'ai_assistant', $4) returning id
        `, [caseId, aiAssistantUserId, aiAssistantDisplayName, body]);
        await client.query(`
          update hub.support_cases
          set last_message_at = now(),
              status = case when status in ('open', 'in_progress') then 'waiting_on_customer'::hub.case_status else status end
          where id = $1
        `, [caseId]);
        return inserted.rows[0].id;
      });
    },

    async postAiNote(caseId, body) {
      return transaction(pool, async (client) => {
        await client.query(`
          insert into private.case_notes (case_id, author_id, author_display_name, author_role, body)
          values ($1, $2, $3, 'ai_assistant', $4)
        `, [caseId, aiAssistantUserId, aiAssistantDisplayName, body]);
      });
    },

    async escalateCase(caseId) {
      return transaction(pool, async (client) => {
        await client.query(`
          update hub.support_cases
          set status = 'in_progress'::hub.case_status, priority = 'high'::hub.case_priority, resolved_at = null
          where id = $1 and status not in ('resolved', 'closed')
        `, [caseId]);
        await client.query(`
          insert into private.audit_events (actor_id, action, entity_type, entity_id, tenant_id, product_id, case_id, changed_columns)
          select $2, 'case.updated', 'support_case', support_case.id, support_case.tenant_id, support_case.product_id, support_case.id,
                 array['status', 'priority']
          from hub.support_cases support_case where support_case.id = $1
        `, [caseId, aiAssistantUserId]);
      });
    },

    async resolveCase(caseId) {
      return transaction(pool, async (client) => {
        await client.query(`
          update hub.support_cases
          set status = 'resolved'::hub.case_status, resolved_at = coalesce(resolved_at, now())
          where id = $1
        `, [caseId]);
        await client.query(`
          insert into private.audit_events (actor_id, action, entity_type, entity_id, tenant_id, product_id, case_id, changed_columns)
          select $2, 'case.ai_auto_resolved', 'support_case', support_case.id, support_case.tenant_id, support_case.product_id, support_case.id,
                 array['status']
          from hub.support_cases support_case where support_case.id = $1
        `, [caseId, aiAssistantUserId]);
      });
    },

    async saveState(caseId, patch) {
      const columns = {
        stage: 'stage', attempts: 'attempts', lastAttemptAt: 'last_attempt_at', lastAiMessageId: 'last_ai_message_id',
        lastSeenCustomerMessageId: 'last_seen_customer_message_id', lastCustomerResponse: 'last_customer_response',
        followUpDueAt: 'follow_up_due_at', followUpSentAt: 'follow_up_sent_at', respondedAt: 'responded_at',
        responseSource: 'response_source', escalatedAt: 'escalated_at', haltReason: 'halt_reason',
      };
      const entries = Object.entries(patch).filter(([key]) => columns[key]);
      if (!entries.length) return;
      const assignments = entries.map(([key], index) => `${columns[key]} = $${index + 2}`).join(', ');
      await transaction(pool, async (client) => {
        await client.query(`update hub.case_ai_automation set ${assignments} where case_id = $1`,
          [caseId, ...entries.map(([, value]) => value)]);
      });
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
 */
export function aiAutomation({ ai, store, enabled = false, followUpDelayMs = 24 * 60 * 60 * 1000, draftTier = 'draft', now = () => new Date(), log = (line) => console.log(line) }) {
  let running = false;
  const active = () => enabled === true && Boolean(ai?.configured);

  async function runAttempt(work) {
    const { state } = work;
    if (state.attempts >= maxAiAttempts) return escalate(work);
    const latest = latestCustomerMessage(work);
    const knowledge = await store.knowledgeForCase({ productId: work.productId, subject: work.subject, latestCustomerBody: latest?.body });
    const draft = await ai.draftReply({
      subject: work.subject,
      messages: threadForAi(work).filter((entry) => entry.visibility === 'customer'),
      knowledge,
      tier: draftTier,
      automated: true,
      attempt: state.attempts + 1,
      failureContext: state.lastCustomerResponse,
    });
    const messageId = await store.postAiMessage(work.caseId, draft);
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
    });
  }

  async function escalate(work) {
    let summary;
    try {
      summary = await ai.summarizeForEscalation({ subject: work.subject, messages: threadForAi(work) });
    } catch {
      summary = `Automated help was attempted ${work.state.attempts} time(s) without resolving this case.`
        + (work.state.lastCustomerResponse ? ` The customer's latest response: "${clip(work.state.lastCustomerResponse, 500)}"` : '');
    }
    await store.postAiNote(work.caseId, [
      'ESCALATED — AI attempts exhausted.',
      '',
      summary,
      '',
      `The customer still reports the problem is not fixed after ${work.state.attempts} automated attempt(s). A support team member needs to take over this case.`,
    ].join('\n'));
    await store.escalateCase(work.caseId);
    await store.saveState(work.caseId, { stage: 'exhausted', escalatedAt: now() });
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
        });
        const refreshed = await store.loadWork(caseId);
        if (!refreshed) return;
        return nextStage === 'escalate_due' ? escalate(refreshed) : runAttempt(refreshed);
      }
      // Unclear: record that the message was seen so it is not reclassified, and
      // keep waiting for a clearer answer or the portal buttons.
      await store.saveState(caseId, { lastSeenCustomerMessageId: latest.id });
      return;
    }

    if (state.followUpDueAt && !state.followUpSentAt && new Date(state.followUpDueAt).getTime() <= now().getTime()) {
      await store.postAiMessage(caseId, followUpNudge);
      await store.saveState(caseId, { followUpSentAt: now() });
    }
  }

  async function tick() {
    if (running || !active()) return { processed: 0, skipped: true };
    running = true;
    let processed = 0;
    try {
      for (const caseId of await store.findNewEligibleCaseIds()) {
        if (await store.claimCase(caseId)) {
          await processCase(caseId).catch((error) => log(JSON.stringify({ event: 'hub_ai_automation_error', case_id: caseId, message: error instanceof Error ? error.message : 'unknown' })));
          processed += 1;
        }
      }
      for (const caseId of await store.findActiveCaseIds()) {
        await processCase(caseId).catch((error) => log(JSON.stringify({ event: 'hub_ai_automation_error', case_id: caseId, message: error instanceof Error ? error.message : 'unknown' })));
        processed += 1;
      }
    } finally {
      running = false;
    }
    return { processed, skipped: false };
  }

  return { tick, active, processCase };
}
