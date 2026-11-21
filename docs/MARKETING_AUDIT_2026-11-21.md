# Marketing audit — November 21, 2026

The Hub's marketing workers are running, but Google lead reporting is blocked. This audit combines current production receipts with a source review and regression fixes. It does not certify end-to-end delivery or attribution for every channel.

## Production findings

The [read-only evidence snapshot](evidence/marketing-live-audit-2026-11-21.json) records deployment `c93f35d` and the following observations:

- Google campaign `24493303819` was enabled and serving in the latest stored provider read, with one approved ad targeting Pennsylvania, a $50 total budget, and a November 27 end date. The read reported $16.96 spend, two clicks and zero conversions. Its one-impression figure remains unresolved; it is preserved as reported, not used as evidence of a reliable click-through rate.
- Google conversion uploads stopped 108 times with `google_datamanager_disabled`. The sanitized provider reason is `SERVICE_DISABLED`. One lead remains eligible for retry until November 26 at 23:27 UTC. Enable **Data Manager API** in the Google Cloud project used by the Hub's Google credentials; the existing worker retries automatically. Confirm a subsequent successful conversion receipt before considering this repaired. Google Cloud management access is unavailable in this session.
- Facebook, Instagram and company LinkedIn have recent successful organic publications. The personal LinkedIn token last failed on November 19 and has no later successful publication evidence. Renew that personal connection in **Settings → Social media → LinkedIn** before relying on automatic founder posts.
- Meta advertising review read 19 ad sets and 18 ads; 15 destinations were unreadable and three pointed to Facebook. These results do not establish that the ads are broken or authorize retargeting them. LinkedIn returned no ad sets. Paid-account permissions and destination behavior need separate verification.
- No marketing schedule was overdue, and no marketing task failed in the preceding 72 hours. However, conversion tasks marked `done` include the blocked Google uploads. Creative has no draft backlog; blocked assets remain blocked.
- Hub public health returned HTTP 200 with `ok: true`. Direct Intel and CareBase landing-page checks were blocked by the execution environment's proxy. Form submission, email receipt, and downstream conversion completion remain unverified.

## Code repairs

- Recheck Google campaign destinations against the current approved product offer before execution, including import-file fallback. Reject invalid or below-minimum campaign budgets before provider writes.
- Reject malformed or truncated Google reports instead of treating them as empty results. Retry throttled requests appropriately while preserving reservations for ambiguous campaign writes.
- Include Google account spend in the weekly scorecard, including campaigns that are now paused or removed. If a connected ad source cannot be read, report total cost per trial as unavailable. Distinguish failed Search Console reads from missing setup.
- Require valid Meta and LinkedIn publication/reply receipts and explicit Meta update confirmation. An uploaded image alone no longer counts as a published Facebook story.
- Skip malformed SendGrid webhook rows without blocking valid delivery, complaint or unsubscribe events later in the same signed batch.
- Make the setup checklist recognize Google-only configurations and match conversion identifiers to connected providers. Report Creative decisions accurately when approval has expired or handover is pending.

Regression tests cover these changes. Release follows the repository's pull-request and CI workflow; this audit does not change live campaigns, spending, credentials, approvals, or deployment settings. No database migration is required.

Local verification used a clean `npm ci` and `SUPPORT_HUB_ALLOW_DEMO_BUILD=true VITE_DEMO_MODE=true npm run check`: 4,298 Hub tests and 24 SDK tests passed, alongside documentation checks, type checking, lint and builds. The final Google response-validation regressions and focused lint also passed. Hosted database and runtime-image checks remain the pull request's CI responsibility; no production form or outbound marketing message was submitted for testing.
