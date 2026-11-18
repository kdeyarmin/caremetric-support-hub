# Ads and creative workforce review — November 18, 2026

## Production evidence

Read-only review at approximately 00:50 UTC, against Railway deployment
`7ae6bd96-0575-4fd0-ae65-8931606e7b69` (`86a89e8`, successful) and the Hub's production database.
The public health and anonymous-access checks passed. Provider credentials are encrypted in
the Hub; the connected Railway tool exposes variable names only. No direct authenticated
ad-platform inspection was available during this review.

| Area | Observed result |
| --- | --- |
| Workers | Social Media Manager and Creative Director active in Act. Their schedules are enabled and current. |
| Authority | Campaign launch, creative assets, posts and replies already automatic. Creative warnings still require review. |
| Budget | $50 for new campaigns per month, requested flight length 10 days. Platform minimums shorten LinkedIn's flight to five days. |
| Production | 16 briefs completed; latest request saved eight drafts. 54 assets approved, 24 awaiting warning review, 15 drafts, 13 blocked, two rejected, one live. |
| Render queue | Latest sweep reports 40 renders today, the configured default cap. The 15 drafts are waiting for the next Eastern day, not a stalled worker. |
| Publishing | Seven organic posts have published, including an Instagram video on November 17. Eight more posts are approved for future slots. The one live creative is this organic video, not proof of a paid ad. |
| Paid launch | Both recorded campaign attempts failed: LinkedIn permission on November 16, invalid request on November 17. No monthly launch reservation remains. |
| Ad review | Three consecutive reviews saw 19 ad sets and made no changes. The latest records all 18 recommendations skipped as `leads_elsewhere`. |
| Measurement | Stored creative results for the November 16 report show zero attributed impressions, clicks, spend, leads and trials. Missing ad links or inaccessible reads can prevent attribution; these zeros do not establish that the accounts spent nothing. |
| Connections | Meta and LinkedIn connections exist. One recent Facebook post failed `meta_permission`; account permissions still need a successful provider read/write to be considered verified. |

## Defects repaired

The code review covers campaign planning and execution, provider API requests, approved-asset
selection, creative briefing and rendering, and failure recovery. Regression tests accompany
the fixes. The final pull request records the exact verification results.

- A failed preferred platform could keep winning the month's launch slot. Prefer an eligible
  channel with fewer failed attempts, within the existing shared budget.
- Empty paused campaigns could prevent recovery when approved creative arrived. Allow a bounded
  later retry, without creating another empty campaign while still waiting.
- Monday and manual runs could bypass the month's three-attempt retry limit.
- Daily platform budgets could overdeliver relative to the Hub's reservation. Automatic flights
  now send the reserved total as Meta's lifetime budget, LinkedIn's group total budget, or
  Google's custom-period total budget. Daily pacing can vary; the total allocation is bounded.
- Google campaign creation used an unsupported bidding field; use the documented API field.
- LinkedIn Sponsored Content campaign creation omitted its required associated organization.
- LinkedIn sponsored-post read errors were swallowed and cached as empty ad links. Report
  permission and transient failures so they are distinguishable from unrelated destinations.
- LinkedIn refresh copy was checked against Meta's shorter text limits.
- Refresh selection could choose creative already running in the same ad set.
- An incomplete provider creation receipt could be treated as a successful deployment.
- Creative requests could be lost between saving a brief and enqueueing its task, or completed
  when generation was temporarily unavailable.
- Large county figures could extend beyond the rendered image's right edge.

## Release and follow-through

Keep the existing budget, marketed products, geographic scope and approval rules. Do not
approve warning or blocked assets merely to empty the queue. After releasing the fixes,
run the existing ad review and campaign planner and inspect their task/action receipts.
A successful campaign creation is still distinct from platform review, impressions and leads.
Verify delivery and attributed results in the next reporting window before claiming performance.

Production release and post-release observations are recorded below when completed.
