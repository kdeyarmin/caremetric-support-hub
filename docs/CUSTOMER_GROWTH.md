# CareBase and CareMetric Intel customer growth

The Growth workspace at `/admin/growth` adds a Marketing Manager and customer-success work for the Account Manager. **Breathe is deferred.** This implements the Hub-side workflows from [the workforce review](AI_WORKFORCE_REVIEW.md). It does not claim that code deployment alone acquires or retains customers.

## What is implemented

| Review recommendation | Implementation |
| --- | --- |
| Prospect research and qualification | Scheduled or owner-requested public business research, dated sources, model-assisted fit rationale, separate observed intent, manual contact verification and lifecycle qualification |
| Persistent shared customer history | One organization and contact across product opportunities; goals, promises, blockers, objections, loss reasons, owner and dated next action |
| Marketing outreach | Versioned product claims, booking link, evidence-backed drafts, individual model-message approval, a maximum of three touches, shared contact frequency across growth and native lifecycle emails, and per-product daily limits |
| Reply and cancellation handling | Signed email webhook ingestion correlates a known sender, classifies simple response signals, stops both product sequences and creates a follow-up/recovery task; complete conversations remain in Communications |
| Conversion handoff | Scoped, signed and deduplicated product events transfer trial/customer work to the Account Manager without accepting clinical records |
| Onboarding and retention | First-step onboarding, 48-hour activation check, trial deadlines, adoption recovery with fresh telemetry, support coordination, cancellation recovery, renewal and demonstrated expansion interest |
| Trustworthy health | Missing/stale/billing-only evidence is separate from adoption; stopped/dropped use requires attention; complete account pagination precedes report ranking |
| Threaded support | With the existing customer-text-to-AI switch enabled, ordinary follow-up questions use up to two scrubbed prior messages, fresh product guides and individual review; prior identifiers or sensitive categories abstain |
| Better retrieval | Product/audience filtering, revision metadata, relevant sections from full guide bodies, and a bounded stale cache |
| Search and content | Weekly source-backed product content briefs in the approval queue, campaign identifiers and native signup source attribution; publishing remains in the existing authoring workflow |
| Stronger operations | Weekly SEO catch-up, overdue work in the Chief of Staff brief, shared database model-budget reservations, unknown-delivery reconciliation and external availability monitoring |
| Learning and measurement | Optional stable standard/concise message groups, recorded approvals/rejections, product/cohort replies, meetings, trials, activation, paid conversion, mature 30/60/90-day retention, delivery outcomes and repeatable behavioral evaluation |

The weekly account report combines native activity and usage reports per product and metric, keeping the newest valid observation when both cover the same metric. Telemetry gaps are counted separately from financial health bands. The Growth preview refuses backend reads and mutations.

The existing Billing and weekly account report remain the source of MRR/ARR. The Growth screen reports observed outcomes, not predicted churn or invented attribution. Revenue expansion, acquisition cost allocation, search-demand performance and campaign effectiveness need measured production data before targets or automatic promotion are justified.

## Apply and configure

1. Apply `20261103150101_customer_growth.sql`, then `20261103150102_customer_growth_contract.sql` through the normal migration process. The second migration verifies private tables, RPC authority and prerequisites before declaring `platform.agents.customer-growth.v1`. Existing agent settings are preserved; the new Marketing Manager starts paused in Propose mode.
2. Deploy the server and frontend together. The server registers growth handlers only when the database advertises the feature. Use `.env.example` for setting names. No secret is sent to the browser.
3. Set a stable `HUB_GROWTH_SIGNING_KEY` (at least 32 random characters), distinct CareBase/Intel event keys, a verified SendGrid sender, `HUB_BULK_EMAIL_POSTAL_ADDRESS`, the HTTPS public origin and the existing mail API key. Keep the signing key stable so existing unsubscribe links continue working.
4. For automatic discovery, configure `HUB_GROWTH_SEARCH_API_KEY` for Brave Search. The adapter requests bounded public search results; snippets are unverified evidence. It does not invent emails. Owner-supplied source evidence works without this provider. Intel's tenant-owned provider lists and campaigns are not imported into CareMetric's sales audience.
5. Configure the signed SendGrid Event Webhook at `/api/growth/delivery` and set `HUB_SENDGRID_EVENT_PUBLIC_KEY`. Subscribe to delivery, bounce, dropped, spam report and unsubscribe events. Keep the existing signed Inbound Parse route for replies; the growth sender's Reply-To points to the configured support inbox.
6. In Growth, map existing tenants to their organizations and classify internal accounts. Add the correct buyer/champion, verify its business source and outreach eligibility, record the goal, and qualify the opportunity. Review each product benefit and booking URL in its policy. Policies start disabled.
7. Resume Marketing Manager and Account Manager in **Propose** mode for the pilot. The scheduler also needs `HUB_AGENTS_ENABLED=true`. Set `HUB_GROWTH_SEND_ENABLED=true` only when the configured channel and reviewed cohort are ready. Approve exact messages in Team; changing policy, contact, or opportunity invalidates stale drafts.
8. Review pilot replies, objections, activation and retention separately for each product. Optional template autonomy needs an active agent in Act mode, an enabled product policy with template sending allowed, and a passing `growth.1` behavioral evaluation recorded in the last 30 days. **Model-written messages always require individual approval.** The latest failed evaluation blocks automatic templates too.

`npm run evaluate:growth` runs synthetic cases. Supplying `HUB_GROWTH_EVAL_DATABASE_URL` explicitly records those results through the restricted `hub_app_server` role. Leave it unset for local/CI evaluation. A behavioral pass proves guardrail behavior; it does not validate a model's persuasion or factual accuracy on unseen prospects. Review real draft quality before increasing volume.

## Native product event integration

`server/growth/event-client.mjs` is a server-only adapter for native applications. Each application must emit from its transactional outbox with a **stable eventKey**; retries reuse the exact event, changing only the signature timestamp. Never put these keys in browser code. A product key cannot authenticate another product's feed.

```js
import { customerActivityClient } from './event-client.mjs';
const activity = customerActivityClient({
  origin: 'https://help.caremetric.ai',
  product: 'carebase', // or caremetric-intel, with its separate key
  key: process.env.CAREMETRIC_GROWTH_EVENT_KEY,
});
await activity.report({
  tenantId: hubTenantId,
  eventKey: `trial:${nativeTrialId}`,
  kind: 'trial_started',
  occurredAt: trialStartedAt,
  facts: { trialEnd: trialEndsAt },
});
```

Package the adapter with `protocol.mjs`, `policy.mjs` and Zod, or implement the documented wire protocol directly in the native stack. The endpoint is `POST /api/growth/events/{carebase|caremetric-intel}` with JSON up to 8 KiB. Set `X-CareMetric-Timestamp` to Unix seconds and `X-CareMetric-Signature` to the hexadecimal HMAC-SHA256 of `${timestamp}.${product}.` followed by the **exact request bytes**. Signatures expire after five minutes. Event timestamps may be up to 90 days old; old lifecycle observations cannot regress newer business events. A reused key with different contents is rejected.

Supported business events: `signup`, `trial_started`, `heartbeat`, `active`, `first_value`, `paid`, `renewed`, `cancel_requested`, `churned`, `support_blocked`, `support_resolved`, `expansion_interest`, `meeting_booked`, and response classifications. Allowed facts are `source` (`direct`, `search`, `outbound`, `referral`), a bounded campaign identifier, `trialEnd`, bounded numeric `count`, and one of `active_users`, `completed_training`, `provider_lists`, `outreach_replies`. Resident/patient identifiers and free-form payload fields are rejected. Map the Hub tenant before its first event.

A heartbeat means the feed is alive. An active event means meaningful use. These must be emitted separately: a missing heartbeat creates a telemetry task, not a claim that the customer abandoned the product. Confirm each product's first-value definition against its native experience: CareBase training/report completion; Intel territory/list/contact-outcome workflow. A billing facility count is not first value.

The native CareBase and Intel codebases are separate from this repository. Their outbox instrumentation, booking-provider callbacks, and authenticated product journey checks must be connected in those deployments. The Hub receiver and adapter are implemented and tested; no native deployment is implied.

## Daily operation

Review the due queue and agreements, not only sent-message counts. Record the observed outcome when resolving work. Supported events close the matching task automatically; adoption recovery requires activity on two distinct days after the recovery task begins. Cancellation and support tasks remain open until a customer outcome is confirmed. Replies that require product-specific answers, pricing negotiation, or unusual commitments stay in Communications with a dated owner task; the agent never invents an answer from an absent transcript.

Inbox-driven growth changes use the individual email message received through the signed provider path, including its own timestamp. Public chat and form addresses are unverified claims: they do not automatically change contacts, suppression, sequences or lifecycle history. Those inquiries remain available for owner review in Communications.

Provider acceptance means the provider accepted the request. Delivery requires a signed event. An interrupted send becomes **unknown** after ten minutes, blocks later contact attempts and is never blindly retried. Reconcile an unknown message using the provider log reference in Growth, or let a signed delivery event settle it. Opt-out, bounce and complaint suppress the shared contact across both products and existing Hub bulk email. Unsubscribe links show a confirmation on GET and apply on POST to avoid accidental changes by link scanners.

Drafts retain the opportunity, contact and policy versions used to write them. An edit during generation discards that output. Each sweep cancels stale unsent drafts, expires their pending approvals and prepares replacements from current context. An unchanged rejected draft is not proposed repeatedly. Accepted and uncertain deliveries remain in the history and are never regenerated merely because a policy changes.

A new product opportunity starts from the observed event: meetings become demos, while heartbeats and replies do not create trials. Late activation, payment and churn events preserve their historical milestone dates without moving the current lifecycle stage backwards. Late events that leave the current context unchanged preserve existing pending drafts. Activation arriving after payment therefore closes onboarding and contributes to conversion reporting. Clearing the Hub tenant ID explicitly removes its mapping so the owner can correct it. Persisted model-budget reservations are released after deferred cost writes settle, including a retry when reservation cleanup temporarily fails.

Growth and native Account Manager email claims share a database lock and check each other’s recipient history before reserving a send. The configured contact gap applies across both workflows, including simultaneous attempts; an overlapping native email is skipped with a visible frequency-limit reason. Their existing approval and daily-volume limits still apply.

Temporarily blocked messages receive a persisted 15-minute retry time; both the queue and direct execution respect it, allowing other agents’ ready actions to proceed.

Pause the agent, disable the product policy, or disable `HUB_GROWTH_SEND_ENABLED` to stop new sends. An already accepted provider request cannot be recalled. The system rechecks the latest contact, policy, opportunity and suppression status immediately before reserving a send; short database mutations serialize independently of model, search and mail calls.

Pipeline and customer-success work run every 15 minutes; discovery searches run daily at 08:00 Eastern. The SEO Analyst can propose a weekly content brief at its 08:30 daily catch-up, when in Propose mode. Review and approve that brief in Team, use it in the existing publishing workflow, and preserve its campaign identifier in landing-page signup events. Publishing and actual search traffic require the native website/analytics integration. Product cohort counts exclude internal organizations. Experiment assignment is stable per organization and enabled explicitly; there is no automatic winner selection from a tiny sample. Use rejection notes, observed objections and loss reasons to revise approved claims and prompts, rerun evaluation, and review the next cohort.

## Verification and rollout limits

The eleven distinct PR review fixes and their regression results are recorded in [PR review-fix evidence](evidence/ai-workforce-pr-review-fixes-2026-11-03.json). The four implementation-review findings and their regression results are recorded in [the review-fix evidence](evidence/ai-workforce-review-fixes-2026-11-03.json). [PR validation](evidence/ai-workforce-pr-validation-2026-11-03.json) records the combined checks after integrating the newer lead, lifecycle and content features from main.

- `npm run check` runs application/UI tests, lint, types, SDK checks and the build.
- `npm run evaluate:growth` runs both products through golden cases for source freshness, citation/link rejection, intent, stop rules and lifecycle choices.
- `HUB_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npm run test:growth:db` exercises real database roles, owner sessions, competing send claims, cross-product frequency, signed inbox handoff, lifecycle replay and delayed milestones, policy/contact edits during drafting, stale proposal replacement, a queue of 50 deferred messages, unsubscribe, shared budgets and deployment gate drift. It refuses hosted databases and sends no email.
- CI runs existing signup/registration coverage, the growth integration twice to check teardown, and pgTAP boundaries. The external workflow checks public Hub/CareBase/Intel availability every 15 minutes when installed in the repository's default branch. It does not impersonate a customer or claim to test native authenticated activation.

These changes are release artifacts until migrations, deployment, provider configuration and native event wiring are completed. No production records were modified and no prospects were contacted during implementation.

The Customer Growth workspace declares `platform.agents.customer-growth.v1`. The separate website-lead Growth Manager uses `platform.agents.growth.v1`; its lead alerts and reports remain independent. Native Account Manager lifecycle emails and Content Marketer publishing keep their existing approval and transport controls.
