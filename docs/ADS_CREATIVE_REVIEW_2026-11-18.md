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

## Release and live verification

PR [#275](https://github.com/kdeyarmin/caremetric-support-hub/pull/275) merged as
`05267811420941ea1b90b5f580f40d961dd2b66c`. Railway deployment
`870b8832-a52e-4ba6-8dd3-ddca5216e6c2` succeeded. The atomic brief queue migration
was applied and verified: the Hub server can execute it; authenticated browser roles cannot.
All CI jobs passed, including the production image, database tests, integration tests and
restore checks. The integrated local suite passed 4,112 Hub tests and 24 SDK tests.

A follow-up production check at 11:08 a.m. Eastern on November 18 confirmed:

- The automatic planner launched Google campaign `24493303819` in account `3021386768`
  at 9:21 a.m. Eastern. Its reservation is **$50 total over ten days**, ending **November 27**.
  The entire November allocation is reserved; another campaign should not be launched
  against the same allocation. This confirms the provider creation receipt, not impressions
  or conversions.
- Creative rendering completed **19 assets on November 18**, below the cap of 40, and the draft queue
  is empty. There are **55 approved**, **39 proposed**, **11 blocked**, **two live** and
  **two rejected** assets. That day's plan found no additional county snapshot due.
- All four images requeued for clipped figures rendered again successfully. The clipping
  blocks are gone. They remain proposed because of text-density, caption-wrapping or other
  quality warnings; none was approved by this review.
- The LinkedIn company-page video published at 8:48 a.m. Eastern on November 18. The Instagram
  video published November 17. These are organic posts, separate from the Google paid campaign.
- The latest daily social ad review still skips 18 recommendations as `leads_elsewhere`.
  Direct inspection of those provider destinations was unavailable, so their cause and the
  account-wide delivery metrics remain unverified.
- Latest failed social publications still show Facebook `meta_permission` and the founder's
  personal LinkedIn `linkedin_token_invalid`. The company LinkedIn page's successful video
  does not validate the separate personal-profile token. Reconnect those credentials in
  Settings → Social media before claiming those paths are healthy.

At verification, the live service included the later campaign-creative validation release, PR #276,
at `ff9333bc34429dd07760312c0c923881a289d644`, also deployed successfully. Its changes
were not authored as part of this review. Public Hub health and an approved creative image
returned HTTP 200 after #275's deployment. The Google Ads browser session was signed out,
so platform review status, impressions, clicks and conversions could not be independently
checked in Campaign Manager.

## Delivery and attribution check (afternoon, November 18)

A further read-only check at about 2:00 p.m. Eastern, against the production database and Railway (Railway deployment
`cac6a733-b2bd-43b3-bd87-deed74fc9794`, successful), found nothing that proves delivery or attribution yet:

- **Google campaign `24493303819`.** The only paid campaign the Hub has created this month. Its action (`966e6738…`) executed at
  9:21 a.m. Eastern, launched live with a reservation of **$5.00 a day for 10 days ($50 committed)**, ending **November 27**. The
  proposal names **Pennsylvania** as its location and the Intel free market review as its landing page, tagged
  `utm_source=google&utm_medium=cpc&utm_campaign=search-intel`. These are the Hub's own receipts. Google's approval status, serving,
  impressions, spend and conversions were still unread, because nothing in the Hub read Google back.
- **LinkedIn.** The two automatic November attempts remain the only LinkedIn campaign actions: `linkedin_permission` on November 16
  and `linkedin_invalid_request` on November 17. Neither has been retried.
- **Ad review.** The daily review (latest 9:10 a.m. Eastern) read 19 ad sets with no platform refusal recorded, so its reads
  succeeded, and skipped all 18 recommendations as `leads_elsewhere`. The receipt does not say which platform the ad sets are on.
  Meta's ad read takes a link only from a creative's `link_data`. An ad built from an existing post, a video or carousel ad, or a
  lead form carries no link the review reads, and such an ad was counted as `leads_elsewhere` too. So the 18 skips may be ads with
  unreadable links rather than ads that lead to another site.
- **Leads and conversions.** November has five non-test Intel leads, none with UTM values or ad click IDs. `ads_conversions` holds five
  `no_click` skips each for Meta and LinkedIn (last November 14) and no submission. The Hub reports leads to Meta and LinkedIn only;
  Intel's pages carry Google Analytics but no Google Ads conversion tag, so Google's own conversion tracking is unknown.
- **Landing page and health.** `www.caremetricintel.com/market-review` and the Hub's session health endpoint returned HTTP 200.
  Intel's lead form sends the stored UTM values and any `gclid`, `fbclid` or `li_fat_id` with the lead.

### Changes in this branch (not deployed until merged)

- `ads.plan` now reads Google back each day (read only, the same API access that creates campaigns): see
  [Social media → Reading Google back](SOCIAL_MEDIA.md#new-campaigns-launched-on-their-own-2026-11-15). After merge and deployment, the
  9:20 a.m. Eastern run's result (`private.agent_tasks.result -> 'google'`) answers approval, serving, budget, end date, places,
  results, auto-tagging and conversion tracking for campaign `24493303819`. If Google refuses the read, the result records the fixed code
  and Google's error enum, and the plan goes on.
- The daily ad review separates `no_ad_link` (a link it could not read) from `leads_elsewhere` (a readable link to another site),
  and records per platform the ad sets, ads, unreadable links, skips and the hosts that ads leading elsewhere point to.

Neither change creates, starts, pauses or changes a campaign or a budget, and neither needs a migration.

### Proposed for the owner's approval: deploy only after CI (not applied)

Railway deploys the Hub's `support-hub-web` service from `main` with **Wait for CI off** (`source.checkSuites: false`), so a merge
deploys while CI is still running. Intel's service already waits for CI and runs `npm run db:migrate` before each deploy. The Hub's
migrations are applied to Supabase separately and must precede the image that needs them (see
[Backend release contract](BACKEND_RELEASE_CONTRACT.md)).

1. Turn on **Wait for CI** for `support-hub-web` (Railway → service → Settings → Source; `checkSuites: true`). A merge then deploys only
   after the **Support Hub CI** workflow passes on that commit. A failed CI run means no deployment.
2. For a release that adds a migration, apply it after CI passes on the pull request and **before** merging. Many server paths check the
   database's declared features and keep their earlier behavior until it is applied, but not every change does, so migration first is
   the order the contract describes. Record the applied version (`supabase_migrations.schema_migrations`) in the pull request.

Nothing in Railway was changed by this review.
