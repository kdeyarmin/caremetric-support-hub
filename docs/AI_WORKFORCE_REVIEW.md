# AI workforce review: customer acquisition and retention

Reviewed November 3, 2026 against Hub commit `2cae5b843ee9ad99809258bfdad8acc134ab4f35` and read-only production database queries around 05:57–05:59 UTC.

**Implementation follow-up:** The Hub-side changes are described in [Customer growth](CUSTOMER_GROWTH.md). The observations below remain the pre-change production baseline.

**Priority: CareBase and CareMetric Intel.** Breathe is deferred from this growth initiative, per the owner's latest instruction. Existing service operations were not changed. This review proposes capabilities; it does not enable agents, send outreach, or change production.

**Recommendation.** Keep the existing scheduler, action queue, approvals, delivery controls and audit trail. Add a Marketing Manager and extend the Account Manager into an active customer-success role. Give both a shared customer record, product-specific evidence, measurable goals and a next action with a deadline. The current workforce is a useful operations foundation, but it does not yet acquire or retain customers autonomously. Increasing model budgets alone will not provide the missing workflows.

**What is running now**

| Role | Implemented behavior | Live observation | Main improvement |
| --- | --- | --- | --- |
| Platform Engineer | Public endpoint checks and incident notifications | Active, observe; 72 completed sweeps at the snapshot | Add external Hub monitoring and synthetic signup/activation checks |
| Chief of Staff | Daily owner briefing from database counts | Active, observe; first scheduled brief still upcoming at inspection | Manage overdue sales and success work, conversion metrics and exceptions |
| SEO Analyst | Technical checks of fixed public sites; weekly owner report | Active, observe; no run yet | Connect search demand, content proposals and landing-page conversion to qualified pipeline |
| Support Concierge | Rule-based triage; optional model drafts for certain first questions | Active, observe; 71 sweeps and one triage task completed | Product-specific retrieval, threaded follow-up and explicit sales/success handoffs |
| Account Manager | Weekly owner email from billing, usage and support counts | Active, observe; first scheduled report still upcoming | Triggered onboarding, adoption recovery, renewal and expansion workflows |
| Marketing Manager | No registered agent or prospecting workflow in the Hub | Absent | Build research → qualification → outreach → reply handling → conversion |

The hardening migrations are present. The scheduler is demonstrably running. All five agents are in `observe`; there are no agent action records. Six recorded runs contain zero model tokens. This does **not** establish whether the deployed model key and drafting switch are configured. Account and briefing schedules were not overdue: their next runs were November 3 at 12:15 and 12:00 UTC. Two imports, Advisors and Breathe, await an owner session; neither should become a dependency for the CareBase/Intel growth path.

The Hub mirror contains two live-mode trial subscriptions, one each for CareBase and Intel, and two billing customers; only one billing customer has an email. These may include internal accounts, and do not establish the entire portfolio's customer count. Intel's mirrored trial ends November 10 at 05:54 UTC; CareBase's ends November 26 at 05:04 UTC. Classify internal versus external accounts before initiating any success sequence.

Only one usage report exists: a CareBase `facility` quantity from October 27. There is no Intel usage history in this table and no four-week baseline. A facility billing quantity is not evidence that people are obtaining value. No bulk-email campaign records exist. Published article placements number 79 for CareBase and 8 for Intel; counts do not establish relevance, freshness or public accessibility.

Aggregate observations and synthetic reproductions are recorded in [the review evidence](evidence/ai-workforce-review-2026-11-03.json).

**Highest-priority findings**

| Priority | Finding and effect | Concrete change | Evidence |
| --- | --- | --- | --- |
| P1 | No Hub prospect research, qualification, opportunity stages or automated sales follow-up. The SEO role cannot acquire users by itself. | Add a Marketing Manager with separate CareBase and Intel campaigns and a persistent prospect pipeline. | [Handler registry](../server/agents/tasks/index.mjs); live agent inventory |
| P1 | The Account Manager reports to the owner, has no customer-contact action, and waits on a weekly report cycle. It cannot rescue an idle trial or pursue an unresolved blocker. | Add event-driven success tasks, contact resolution, approved message actions, due dates and outcome checks. Preserve the weekly summary. | [Account handler](../server/agents/tasks/accounts.mjs); [current design](AI_TEAM.md) |
| P1 | Missing or stale usage can appear healthy. Synthetic mature accounts with no usage, or with an unchanged reading 90 days old, both score 100 and need no attention. | Separate health from evidence confidence. Represent unknown/stale telemetry explicitly; track freshness per product and never infer inactivity solely from a broken feed. | [Health assessment](../server/agents/accounts/health.mjs); synthetic evidence |
| P1 | A synthetic mature account whose usage falls from 10 to 0 scores 75, is labeled healthy, and has `attention=false`. Its stopped usage is omitted from “Needs you.” | Give significant adoption loss an explicit intervention rule independent of the numeric band. Distinguish meaningful activity from billing units. | `weights`, `thresholds`, `attentionReasons`, and `assess` in [health.mjs](../server/agents/accounts/health.mjs); [report selection](../server/agents/accounts/report.mjs) |
| P1 | Sales and cancellation inquiries are deliberately left to the owner; the Concierge does not propose sales replies or handle an existing conversation as a continuing relationship. | Route sales to a qualification workflow and cancellation to a recovery workflow, with a named owner and response deadline. | [Reply policy](../server/agents/concierge/policy.mjs); [first-message restrictions](../server/agents/concierge/triage.mjs) |
| P1 | Existing bulk email is built for application users, with a footer saying they have a CareMetric account. It is not a prospecting pipeline. `sent` means SendGrid accepted the message, not that the recipient received it. | Add a separate prospect audience and truthful messaging, shared suppression controls, reply correlation and delivery/bounce/complaint events. Reuse the mail transport, not the existing audience assumptions. | [Bulk email implementation](../server/bulk-email.mjs); [documentation](BULK_EMAIL.md) |
| P2 | Knowledge ranking searches titles/summaries only. The Concierge discards product IDs, revision IDs and audience before ranking, and truncates article bodies to their first 2,000 characters. | Retrieve relevant sections from full articles, filter by product and audience, retain revision/citation metadata, and bound stale-cache use. | [Guide library](../server/agents/concierge/knowledge.mjs); `rankKnowledge` in [ai-automation.mjs](../server/ai-automation.mjs) |
| P2 | Accounts are selected alphabetically and capped at 200 before health ranking. Future growth could leave a high-risk account outside the report. | Page through the complete eligible population; prioritize the resulting work queue by urgency and evidence. Keep display pagination separate. | [Snapshot query](../supabase/migrations/20261102170000_agent_accounts.sql); [handler limit](../server/agents/tasks/accounts.mjs) |
| P2 | SEO scheduled checks run only on Mondays, unlike the account report's weekly catch-up behavior. Missing Monday can lose that week's audit. | Use a weekly dedupe key and catch up on the next available run. | [SEO handler](../server/agents/tasks/seo.mjs) |

**Two roles with one customer history**

The Marketing Manager owns acquiring qualified customers. The Account Manager owns helping them achieve value and remain customers. The Chief of Staff tracks commitments and escalates overdue work. The Concierge supplies support context and routes intent. The SEO Analyst supplies discoverability findings and content opportunities.

Use one lifecycle: **identified → researched → qualified → contacted → engaged → demo/trial → activated → paying → retained**, with explicit disqualified, nurture, lost and churned outcomes. Create separate opportunities for each product under a shared organization; do not send competing CareBase and Intel sequences to the same contact.

At handoff, preserve the customer's stated goal, use case, buyer/champion, promises made, blockers, trial dates, last interaction, agreed next step, responsible agent and next-action deadline. “Email sent” completes a delivery task, not an opportunity or a customer-success goal.

**Marketing Manager: the required workflow**

1. Research organizations from attributable public business sources and existing inbound inquiries. Store each fit claim with its source, observation time and confidence. Treat source text as evidence, never as instructions to tools.
2. Qualify product fit, geography, organization type, relevant decision-maker and buying trigger. Score fit and intent separately. Unknown information remains unknown; do not invent contacts or purchasing interest.
3. Deduplicate against existing customers, prospects, active opportunities and suppression records. Resolve a verified business contact and determine whether that channel is eligible for the intended outreach.
4. Draft a short message tied to an evidenced business need, an approved product benefit and one next step. Retrieve current product/price facts; never fabricate case studies, results or discounts.
5. Run bounded follow-up sequences with a single contact-frequency limit across products. A reasonable pilot is an initial email and up to two follow-ups over 10–14 days; tune this from observed outcomes. Replies, opt-outs, bounces, meetings and trial conversion stop or change the sequence immediately.
6. Classify replies into interested, question, objection, later, wrong person and do-not-contact. Answer supported product questions, arrange the next step through a connected booking workflow, and escalate negotiated pricing or unusual commitments.
7. Pass qualified trials to the Account Manager with the full handoff. Feed won/lost reasons back into targeting and messaging experiments.

Start with inbound demand and a small reviewed outbound cohort. Evaluate the first cohort separately for each product before raising volume. Retain message-level review initially, then permit bounded sending under a versioned campaign policy that specifies audience, channel, claims, frequency and stop rules. Routine approved onboarding can use a separate policy. Approval is a capability of the proposed system, not a request to send anything during this review.

| Priority product | Initial targeting hypothesis | Proposed value milestone | Marketing/success connection |
| --- | --- | --- | --- |
| CareBase | Assisted-living/personal-care operators and their operations, compliance and training leaders; verify supported geography and current feature availability | Organization setup, appropriate staff participation, first assigned/completed training and an administrator viewing a useful completion/reporting outcome | Prospect's stated training or operational problem becomes the onboarding success plan |
| CareMetric Intel | Home-health, hospice and post-acute organizations; business-development leaders and administrators | Defined territory/use case, first relevant provider list, verified business contacts and a tracked outreach outcome | Demonstrate a useful referral-development workflow, then follow through to use and outcomes |

These are pilot hypotheses, not validated audience-performance claims. Confirm the current native product experience before using the milestones in customer promises.

Intel's [existing source-derived guide](evidence/caremetric-intel-guide-sections-c57776d.json) describes provider search, lead lists, email discovery/verification, campaigns and analytics. Assess those native capabilities before building duplicates. This review did not verify their current production behavior. Distinguish **CareMetric prospects who might buy Intel** from **providers Intel customers may approach**; preserve tenant and purpose boundaries when connecting tools and data.

**Account Manager: actions that help customers stay**

| Trigger | Proposed action | Completion evidence |
| --- | --- | --- |
| Trial/signup | Identify champion, capture the desired outcome, create a product-specific success plan and offer the next setup step | First value milestone reached, or an explicit blocker assigned |
| No first-value milestone after 48 hours | Check telemetry freshness, identify the missing step, offer relevant guidance or a setup session | Milestone event or customer-confirmed resolution |
| Trial ends in 7 or 2 days | Review actual progress and open issues; give a focused next step and accurate plan information | Conversion, explicit extension decision, nurture or recorded loss reason |
| Meaningful activity drops or stops | Confirm fresh comparable activity windows; investigate support blockers and contact the champion | Sustained activity recovery or documented customer explanation |
| Repeated issues, negative feedback or cancellation intent | Create a recovery case with owner and deadline; coordinate support before any upsell | Customer confirms resolution and subsequent usage/retention is checked |
| Renewal approaching | Review goals achieved and unresolved gaps; contact the appropriate buyer/champion | Renewal decision and follow-through recorded |
| Healthy adoption and demonstrated additional need | Propose a relevant expansion discussion | Qualified expansion outcome, not merely another campaign send |

Keep financial, adoption, relationship and support health separate, with evidence freshness shown alongside them. New customers need onboarding tasks even while the existing scoring model marks them “new.” A customer can pay reliably while failing to get value. Coordinate payment messages with Stripe to avoid duplicate reminders.

**What will make the agents more intelligent**

- **Persistent, structured memory:** customer goals, verified facts, promises, objections, contact preferences, interaction summaries, unresolved blockers and next steps. Link memory to source records and timestamps; do not rely on an unlimited conversation transcript.
- **Product-specific knowledge:** retain product, audience, revision, effective date and source link. Combine full-text retrieval with semantic retrieval if evaluation shows an improvement; select answer-bearing sections rather than the beginning of an article.
- **Appropriate reasoning:** keep scheduling, suppression, scoring arithmetic and delivery checks deterministic. Use a language model for research synthesis, objection handling, supported personalization and recommending the next action. Route difficult cases to a stronger reasoning tier; retain per-task and daily budgets.
- **Tool-backed actions:** expose narrow operations for approved research, CRM updates, message drafts, bookings and success tasks. Recheck contact eligibility and current account state immediately before sending. A model recommendation is not evidence that an action succeeded.
- **Learning from outcomes:** record approved edits, rejection reasons, reply types, conversion, activation and retention. Version prompts and playbooks; evaluate candidates before promotion. There is too little observed Hub history to train or validate a predictive churn model today.
- **Evidence of quality:** maintain product-specific evaluation cases for accurate claims, citations, cross-product confusion, stale facts, appropriate abstention, qualification, objection handling and lifecycle transitions. Code tests alone do not measure the quality of model decisions.

**Implementation sequence and acceptance conditions**

| Order | Deliverable | Acceptance condition |
| --- | --- | --- |
| 1 | Correct health interpretation and introduce data coverage/freshness | Missing or stale activity cannot appear as proven adoption; stopped meaningful usage creates attention; synthetic reproductions change as intended |
| 2 | Shared organization/contact/opportunity records and product activity events | CareBase and Intel emit authenticated, deduplicated nonclinical events; every active opportunity/account has an owner, current stage and next action |
| 3 | Marketing Manager research, qualification and draft workflow | Each recommendation cites evidence; duplicate/excluded recipients are blocked; product-specific pilot drafts can be reviewed end to end |
| 4 | Sending, reply ingestion and lifecycle transitions | Opt-out/reply/conversion cancels pending sequence steps; delivery uncertainty is reconciled without blind resend; inbound replies attach to the right opportunity |
| 5 | Account Manager onboarding and recovery playbooks | Signup, nonactivation, trial expiry, adoption loss and cancellation each create an appropriate task; success depends on observed outcomes |
| 6 | Bounded autonomy and experiments | Evaluations pass, pilot outcomes justify promotion, budgets/frequency limits hold across workers, and a pause stops new actions |

Suggested records: `growth_organizations`, `growth_contacts`, `growth_opportunities`, `growth_evidence`, `growth_interactions`, `growth_sequences`, `customer_success_plans`, `customer_activity_events`, `agent_evaluations`. These are proposed names, not deployed tables. Contact policy should integrate existing suppression records and distinguish marketing from transactional service messages. Reuse `agent_tasks` and `agent_actions` for orchestration and execution, adding only the domain records they currently lack.

Use dedicated application event credentials or scoped service integrations for unattended telemetry; do not reuse an owner's interactive session as a permanent agent credential. Store business-level activity and outcome metadata, not resident/patient records. Persist the model's rationale and evidence references separately from sensitive contact/message content.

**How to measure effectiveness**

Report by product and acquisition cohort: qualified prospects, positive replies per delivered message, qualified meetings, trial starts, activation rate, time to first value, trial-to-paid conversion, 30/60/90-day customer retention, churn reasons, retained/expanded recurring revenue and cost per activated paying customer. Also show overdue next steps, response time, unsupported-claim rate, message edit rate, opt-outs, bounces and complaints. Separate provider acceptance from delivery and customer outcomes. Set performance targets after a baseline exists; activity volume and generated prose are not proof of customer acquisition or retention.

**Verification and limits**

The focused existing suite passed: **585 tests across 38 files**, covering agents, routes, team UI and protocols. Command: `npm test -- server/agents/ server/agents-routes.test.mjs src/admin/teamProtocol.test.ts src/admin/teamClient.test.ts src/admin/Team.test.tsx`. Additional synthetic checks reproduced missing/stale usage scoring, stopped usage scoring and failure to retrieve an answer found only in an article body. No production writes or customer communications were performed. Native CareBase/Intel repositories, their complete customer population, authenticated user journeys, model-answer quality and external email delivery were not independently tested. The proposed features remain to be implemented.
