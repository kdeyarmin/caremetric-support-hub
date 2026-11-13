import { transaction } from '../sms-auth.mjs';

/**
 * The Hub server's only path to the AI team tables. hub_app_server holds no table
 * privilege (supabase/migrations/20261102120000_agent_control_plane.sql), so every
 * method is one call to a private.agent_* security definer operation that refuses any
 * other role. Nothing here decides anything: the database keeps the rules (leases,
 * autonomy, idempotency, budgets) and this module only carries values to and from it.
 *
 * `fenced` is true when the database declares platform.agents.hardening.v1. Then a task's heartbeat
 * and finish quote the attempt it was claimed under (a worker whose lease ran out and whose task was
 * handed out again can no longer touch it), an action's settlement quotes the execution it started,
 * the ready list can be narrowed by kind before it is limited, and an execution that never began its
 * work can be handed back. Against a database without those operations the calls keep their old shape
 * and the extras are ignored, so a server can be deployed before the migration is applied.
 */
export function sqlAgentStore(pool, { fenced = false, growth = false, social = false, socialVideo = false, marketing = false, scorecard = false, creative = false, creativeData = false } = {}) {
  const call = (operation, args = []) => transaction(pool, async client =>
    (await client.query(`select ${operation}(${args.map((_, index) => `$${index + 1}`).join(', ')}) as result`, args)).rows[0].result);
  return {
    fenced,
    // A deferred growth message waits 15 minutes; a social post waits for its time slot (platform.agents.social.v1).
    ...(growth || social ? { deferExecution:(actionId,execution,kind=null)=>(String(kind??'').startsWith('social.')
      ? (social ? call('private.social_schedule',[actionId,execution]) : false)
      : (growth ? call('private.growth_defer_action',[actionId,execution]) : false)) } : {}),
    ...(social ? {
      /** Targets with an open social action ("kind:target"), so a change is never proposed twice. */
      socialOpenTargets: () => call('private.social_open_targets'),
      /** Holds a proposed or approved post until its `scheduledFor`. */
      socialSchedule: (actionId, execution = null) => call('private.social_schedule', [actionId, execution]),
    } : {}),
    ...(socialVideo ? {
      /** Durable upload/publish intent, fenced by the current action execution and its approved video asset. */
      socialVideoStage: (actionId, execution, phase = 'read', providerId = null) => call('private.social_video_stage', [actionId, execution, phase, providerId]),
    } : {}),
    // The Creative Director (platform.agents.creative.v1). Briefs, assets and files are reached only through these operations.
    ...(creative ? {
      /** Marketing plan output with no creative yet: CareMetric's own words, product, platform and pillar. */
      creativePlanInputs: (days = 7) => call('private.creative_plan_inputs', [days]),
      /** Both brand kits, no file bytes. */
      /** Records a brief once per request key: `{ id, created, status }`. */
      creativeBriefCreate: brief => call('private.creative_brief_create', [JSON.stringify(brief)]),
      creativeBriefContext: id => call('private.creative_brief_context', [id]),
      // County snapshots and article links (20261113210000_creative_data.sql); absent until the database declares them.
      ...(creativeData ? {
        creativeDataCounties: (perWeek, weekStart) => call('private.creative_data_counties', [perWeek, weekStart]),
        socialRecentArticles: days => call('private.social_recent_articles', [days]),
      } : {}),
      creativeBriefFinish: (id, status, result = null) => call('private.creative_brief_finish', [id, status, result === null ? null : JSON.stringify(result)]),
      creativeDraftsSave: (briefId, taskId, assets) => call('private.creative_drafts_save', [briefId, taskId, JSON.stringify(assets)]),
      /** Claims drafts to render within the day's cap: `{ claimed, renderedToday, cap }`. */
      creativeRenderClaim: (limit, dailyCap, products) => call('private.creative_render_claim', [limit, dailyCap, products]),
      creativeRenderJobs: (limit = 5) => call('private.creative_render_jobs', [limit]),
      creativeRenderJob: (assetId, job) => call('private.creative_render_job', [assetId, JSON.stringify(job)]),
      creativeRenderFinish: (assetId, outcome, file, contentType, compliance, meta = {}) =>
        call('private.creative_render_finish', [assetId, outcome, file, contentType, compliance === null ? null : JSON.stringify(compliance), JSON.stringify(meta ?? {})]),
      creativeReady: (limit, products) => call('private.creative_ready', [limit, products]),
      creativeAssetProposed: (assetId, actionId) => call('private.creative_asset_proposed', [assetId, actionId]),
      /** The owner's logo or a screenshot, as bytes. */
      creativeBrandFile: id => call('private.creative_brand_file', [id]),
      creativeHandoff: (actionId, execution) => call('private.creative_handoff', [actionId, execution]),
      creativeRetire: (actionId, execution) => call('private.creative_retire', [actionId, execution]),
      /** Approved creative the Social Media Manager may use, for a product and platform. */
      creativeApproved: ({ product, platform, limit = 5 }) => call('private.creative_approved', [product, platform, limit]),
      creativeMarkLive: (assetId, ref) => call('private.creative_mark_live', [assetId, ref]),
      /** `{ contentType, bytes }` for an approved or live asset's public token, or null. */
      creativePublicFile: token => transaction(pool, async client => {
        const row = (await client.query('select content_type, bytes from private.creative_public_file($1)', [token])).rows[0];
        return row ? { contentType: row.content_type, bytes: row.bytes } : null;
      }),
      creativeLiveAssets: products => call('private.creative_live_assets', [products]),
      creativePerformanceSave: rows => call('private.creative_performance_save', [JSON.stringify(rows)]),
      creativeLearningsSave: rows => call('private.creative_learnings_save', [JSON.stringify(rows)]),
      creativeLeads: (since, until) => call('private.creative_leads', [since, until]),
      creativeOpenTargets: () => call('private.creative_open_targets'),
      /** Counts for the morning brief. */
      creativeBriefFacts: () => call('private.creative_brief_facts'),
    } : {}),
    // The owner's marketing switches (platform.agents.marketing.v1): the product keys switched on right now.
    ...(marketing ? { marketedProducts: () => call('private.marketed_products') } : {}),
    // The Chief of Staff's Monday scorecard (platform.agents.scorecard.v1).
    ...(scorecard ? {
      /** Whether the five weekly reports' scheduled runs email the owner beside the scorecard (the owner's setting; off by default). */
      individualReports: () => call('private.agent_individual_reports'),
      /** Per product, between `since` and `until`: county reports, trial sign-ups, first activations, outbound email outcomes and replies, and the AI spend. Counts only. */
      scorecardFacts: ({ since, until }) => call('private.agent_scorecard_facts', [since, until]),
    } : {}),
    ...(growth ? { reserveBudget:(taskId,cents)=>call('private.growth_budget_reserve',[taskId,cents]),releaseBudget:id=>call('private.growth_budget_release',[id]),accountsPage: ({limit=200,offset=0}={})=>call('private.agent_accounts_page',[limit,offset]), notificationStatus: key=>call('private.growth_notification_status',[key]) } : {}),
    /** Turns due schedules of the given task kinds (the ones this server can handle) into tasks. */
    fireSchedules: (kinds, limit = 10) => call('private.agent_schedule_fire', [limit, kinds]),
    maintenance: () => call('private.agent_maintenance'),
    claim: (limit, leaseSeconds) => call('private.agent_task_claim', [limit, leaseSeconds]),
    heartbeat: (taskId, leaseSeconds, attempt = null) => (fenced && Number.isInteger(attempt)
      ? call('private.agent_task_heartbeat', [taskId, leaseSeconds, attempt])
      : call('private.agent_task_heartbeat', [taskId, leaseSeconds])),
    finish: (taskId, status, { result = null, errorCode = null, retryAt = null, attempt = null } = {}) => (fenced && Number.isInteger(attempt)
      ? call('private.agent_task_finish', [taskId, status, result, errorCode, retryAt, attempt])
      : call('private.agent_task_finish', [taskId, status, result, errorCode, retryAt])),
    enqueue: (agentKey, kind, requestKey, { payload = {}, priority = 5, dueAt = null, sourceKind = null, sourceRef = null, requiresSession = false } = {}) =>
      call('private.agent_task_enqueue', [agentKey, kind, requestKey, payload, priority, dueAt, sourceKind, sourceRef, requiresSession]),
    sessionTasks: (limit = 10) => call('private.agent_session_tasks', [limit]),
    claimSessionTask: (taskId, leaseSeconds) => call('private.agent_session_task_claim', [taskId, leaseSeconds]),
    startRun: (taskId, model, promptVersion) => call('private.agent_run_start', [taskId, model, promptVersion]),
    finishRun: (runId, outcome, usage = {}, summary = null, errorCode = null) =>
      call('private.agent_run_finish', [runId, outcome, usage, summary, errorCode]),
    budget: agentKey => call('private.agent_budget', [agentKey]),
    proposeAction: ({ taskId, runId = null, kind, targetKind = null, targetId = null, preview, input = {} }) =>
      call('private.agent_action_propose', [taskId, runId, kind, targetKind, targetId, preview, input]),
    /** Approved actions ready to carry out, oldest first. `kinds` and `excludeKinds` narrow the list before the limit (hardened databases only). */
    readyActions: (limit = 10, { kinds = null, excludeKinds = null } = {}) => (fenced
      ? call('private.agent_actions_ready', [limit, kinds, excludeKinds])
      : call('private.agent_actions_ready', [limit])),
    beginExecution: actionId => call('private.agent_action_execution', [actionId]),
    /** `execution` is the number beginExecution reported for this start; a report for any other start is refused. */
    completeExecution: (actionId, ok, result = null, execution = null) => (fenced && Number.isInteger(execution)
      ? call('private.agent_action_executed', [actionId, ok, result, execution])
      : call('private.agent_action_executed', [actionId, ok, result])),
    /** Hands an execution that never began its work back to its approved state. False when the database cannot (not hardened) or it is no longer that execution. */
    releaseExecution: async (actionId, execution = null) => (fenced && Number.isInteger(execution)
      ? call('private.agent_action_release', [actionId, execution])
      : false),
    notifyBegin: ({ channel, severity, subject, body, dedupeKey, agentKey = null, taskId = null }) =>
      call('private.agent_notify_begin', [channel, severity, subject, body, dedupeKey, agentKey, taskId]),
    notifyFinish: (id, delivery, providerMessageId = null) => call('private.agent_notify_finish', [id, delivery, providerMessageId]),
    ownerContact: () => call('private.owner_contact'),
    /** Counts and times for the morning brief: what needs the owner, what the team did yesterday. No names, no text. */
    briefFacts: async () => {
      const facts = await call('private.agent_brief_facts');
      const withGrowth = growth ? { ...facts, customerGrowth: await call('private.growth_brief_counts') } : facts;
      // A failure to read the creative counts never holds back the brief: the section says they could not be read.
      return creative ? { ...withGrowth, creative: await call('private.creative_brief_facts').catch(() => ({ unavailable: true })) } : withGrowth;
    },
    /** Conversations whose newest inbound message has settled and nobody has answered or triaged. Ids and counts only. */
    conciergePending: ({ limit = 10, settleSeconds = 90, windowHours = 72, channels = null } = {}) =>
      call('private.agent_concierge_pending', [limit, settleSeconds, windowHours, channels]),
    /**
     * Hands one prospect message to the Sales Executive when it is working and the message is a CareBase or Intel prospect's
     * (platform.agents.sales-executive.v1): `{ handoff: true, product }`, or `{ handoff: false, reason }`. Ids only, never text.
     */
    salesHandoff: ({ communicationId, messageId }) => call('private.sales_handoff', [communicationId, messageId]),
    /** A minimal view of one conversation (no contact details, no notes) with up to `messages` recent messages clipped to `chars`. */
    communicationSnapshot: ({ id, requestKey = null, messages = 0, chars = 2000 }) =>
      call('private.agent_communication_snapshot', [id, requestKey, messages, chars]),
    /** How many alerts whose dedupe key starts with `prefix` went out on `channel` (any when null) since `since`. */
    notificationCount: ({ prefix, channel = null, since }) => call('private.agent_notification_count', [prefix, channel, since]),
    /** A snapshot of every account's billing facts, usage and case counts for the weekly report: names and numbers, never a contact address. */
    accountsSnapshot: ({ limit = 200 } = {}) => call('private.agent_accounts_snapshot', [limit]),
    /**
     * The facts the customer emails need, per account and product (or one account and product): names, dates and flags, never an
     * address. Newest first, `limit` rows from `offset`; `truncated` says more rows follow this page.
     */
    lifecycleSnapshot: ({ limit = 200, tenant = null, product = null, offset = 0 } = {}) => call('private.agent_lifecycle_snapshot', [limit, tenant, product, offset]),
    /**
     * Records one approved customer email before it is sent and returns the one address it goes to (`{ state: 'ready', to }`), or why
     * it may not go (`no_address`, `suppressed`, `daily_limit`, `auto_send_off`), or what an earlier attempt recorded (`recorded`, `status`).
     * With no `unsubscribeHash` it only says whether a send was recorded (`recorded` or `unrecorded`) and changes nothing.
     */
    lifecycleBeginSend: ({ actionId, execution = null, unsubscribeHash }) => call('private.agent_lifecycle_begin_send', [actionId, execution, unsubscribeHash]),
    lifecycleFinishSend: ({ actionId, delivery, providerMessageId = null }) => call('private.agent_lifecycle_finish_send', [actionId, delivery, providerMessageId]),
    /** The owner-authored email ledger returns a prior outcome, or claims exactly one send of its immutable payload. */
    externalEmailBeginSend: ({ actionId, execution, claim = true }) => call('private.agent_external_email_begin_send', [actionId, execution, claim]),
    externalEmailFinishSend: ({ actionId, execution, delivery, providerMessageId = null }) => call('private.agent_external_email_finish_send', [actionId, execution, delivery, providerMessageId]),
    /** Lists approved/stale external emails; only the owner's command opts into recovering stale executions. */
    externalEmailReady: ({ limit = 10, recover = false } = {}) => call('private.agent_external_email_ready', [limit, recover]),
    /**
     * What the Content Marketer needs to choose a topic: its latest article action per topic, which of `slugs` another content
     * item already uses, recent inbox conversations counted by product and inquiry type (never text) and the months whose
     * outreach email is recorded.
     */
    contentState: (slugs = []) => call('private.agent_content_state', [slugs]),
    /** Publishes the article an approved content.publish action carries, as the AI assistant with the owner's approval. */
    contentPublish: (actionId, execution = null) => call('private.agent_content_publish', [actionId, execution]),
    /**
     * Autonomy steps the hourly task acts on: supervised ones whose week has ended (`due`), switches the owner has not been told about
     * (`announce`), and supervised ones with their code that end within a day (`soon`). Categories, labels and dates, nothing else.
     */
    autonomyDue: () => call('private.agent_autonomy_due'),
    /** Switches one due step to automatic, or says why not (`{ graduated: false, reason: 'not_due' | 'code_missing' }`). */
    autonomyGraduate: category => call('private.agent_autonomy_graduate', [category]),
    /** Records that the owner was told about the switch a step made at `automaticAt`, so it is not announced again. */
    autonomyAnnounced: (category, automaticAt) => call('private.agent_autonomy_announced', [category, automaticAt]),
    // The Account Manager's offers from the owner's menu (platform.agents.offers.v1).
    /** Switched-on offers with room left this month and the accounts that qualify: offer keys, slugs, names, dates and Stripe ids; never an address. */
    offerCandidates: (limit = 50) => call('private.agent_offer_candidates', [limit]),
    /** Checks one approved offer again and records it before Stripe is asked (`ready`), or says what an earlier attempt recorded or why not. */
    offerBegin: (actionId, execution = null) => call('private.agent_offer_begin', [actionId, execution]),
    /** Records a coupon offer's request before it is sent; the first one recorded is kept and returned, to be sent verbatim. */
    offerRequest: (actionId, execution, discounts) => call('private.agent_offer_request', [actionId, execution, JSON.stringify(discounts)]),
    /** Records Stripe's answer for a recorded offer: applied, refused (its place is given back) or unconfirmed. */
    offerSettle: (actionId, status) => call('private.agent_offer_settle', [actionId, status]),
    /** One health check for one product. The database decides when that opens or closes an incident. */
    probeRecord: ({ targetKey, ok, statusCode, latencyMs, failure = null, threshold = 2, agentKey = 'platform_engineer' }) =>
      call('private.agent_probe_record', [targetKey, ok, statusCode, latencyMs, failure, threshold, agentKey]),
    // The Growth Manager's reads (platform.agents.growth.v1). None returns a contact's name, address, phone number or message.
    /** Website leads the Growth Manager has not looked at yet, oldest first, from the last `windowHours`: ids, kinds and products only. Test leads never appear. */
    growthPending: ({ limit = 50, windowHours = 24 } = {}) => call('private.agent_growth_pending', [limit, windowHours]),
    /** One lead as an alert may name it: kind, product, organization, a few facts, where it came from and its conversation's reference. */
    growthLead: id => call('private.agent_growth_lead', [id]),
    /** Marks leads as looked at, so each is handled once. Returns how many were newly marked. */
    growthMarkSeen: ids => call('private.agent_growth_mark_seen', [ids]),
    /** One website lead into growth (20261113160000_growth_inbound.sql): what it did, never the person's details. */
    growthLeadCapture: id => call('private.growth_lead_capture', [id]),
    /** The Sales Executive's reading of one inbound message, which corrects the keyword reading of the same message. */
    growthReplyDisposition: (messageId, intent, objection = null) => call('private.growth_reply_disposition', [messageId, intent, objection]),
    /**
     * Lead conversations to remind the owner about: waiting at least the smallest of `steps` (minutes) and less than `maxMinutes`, whose
     * current step has not been reminded yet, the most recent first, each with its step. Reminded steps are left out before the limit.
     */
    growthUnanswered: ({ steps, maxMinutes, limit = 50 }) => call('private.agent_growth_unanswered', [steps, maxMinutes, limit]),
    /** Counts for the reports: leads by kind, product and source, trials, replies and what is still unanswered, between `since` and `until`. */
    growthFacts: ({ since, until }) => call('private.agent_growth_facts', [since, until]),
    /** Whether a test lead from `source` reached the Hub at or after `since`: the end of a lead form check. */
    leadProbeSeen: ({ source, since }) => call('private.agent_lead_probe_seen', [source, since]),
  };
}
