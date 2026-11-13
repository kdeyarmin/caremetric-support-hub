# Marketing workforce: tools and activation

Reviewed November 11, 2026 against Hub source and read-only production evidence. The team already has most of the core tools for
research, content, sales replies, social publishing, ad optimization, and customer retention. The immediate opportunity is to connect
and activate those tools, improve the evidence behind prospect qualification, and measure trials through paid conversion.

This review does **not** mean the changes below are deployed. The production snapshot is in
[marketing-workforce-live-audit-2026-11-11.json](evidence/marketing-workforce-live-audit-2026-11-11.json). It contains configuration
presence and aggregate counts, without secret values or customer contact details. Configuration alone does not verify a provider's
permissions, delivery, or results.

## What is built and what is running

| Team member | Tools and responsibility | Observed production status | Next action |
| --- | --- | --- | --- |
| Marketing Manager | Brave business search, public contact discovery, evidence and fit assessment, outreach and follow-ups | Active. Search has worked since November 8. Three recent discovery runs returned 21 candidates and found six contacts; those runs qualified none. | Improve domain-specific research and contact coverage; review fit and evidence before sending. Search is already connected; no replacement subscription is needed. |
| Sales Executive | Fact-checked written answers, self-serve trial guidance, pipeline review | Active in Propose. Weekly review is consolidated into the scorecard. | Review the first real prospect answers and measure answer time, trial starts, and paid conversion. |
| Content Marketer | Product facts, feature inventory, help articles, outreach drafts, publishing controls | Active. The newer public-article feature is not declared in production. | Release the existing public-article migrations, then verify the published article and its product call to action. |
| SEO Analyst | Site crawl, Search Console query/page analysis, title and description suggestions, research briefs | Active in Observe. Search Console is not configured. Scheduled SEO reports are held for the scorecard; content research skips in Observe. | Connect Search Console. Preserve actionable SEO findings in the scorecard. Move to Propose only if research briefs are wanted; that change does not itself publish a brief. |
| Social Media Manager | Facebook, Instagram, LinkedIn, comments, post scheduling, ad review and creative refresh | Paused; its four schedules have never run. Meta and LinkedIn credentials are absent. | Connect the chosen accounts and permissions, then resume in Propose and review the first plan. |
| Creative Director | Brand assets, ad images, internal short-video rendering, optional HeyGen | Source is built; the production migration and agent registration are absent. | Release the existing Creative Director migrations, enable it in Settings → Creative, and resume the agent. Start with internal rendering. |
| Growth Manager | Website lead alerts and follow-up reminders | Active; recurring tasks are running. | Verify each marketed product's lead path and response time. |
| Account Manager | Trial activation, customer-success work, retention and approved offers | Active. No native product activity events have been received. | Release the canonical Intel activity feed and Hub billing lifecycle relay; verify first-value, trial, and payment receipts. |
| Chief of Staff | Daily brief, Monday scorecard, approval coordination | Active. Billing is read; ad, Search Console, and visitor sources are missing. | Connect available measurement sources and use trials, activation, paid conversion, and revenue to choose the next work. |
| Platform Engineer | Product health and lead-form probes | Active; recurring tasks are current. | Keep these checks running and resolve broken signup or lead paths before increasing traffic. |

The database contains 20 opportunities: 14 researched Intel prospects, one contacted Intel prospect, and five CareBase prospects in
nurture. Six contacts are verified and permitted, and one growth email is recorded as delivered. These are pipeline counts, not a
claim of 20 sales-ready leads. Among the researched Intel prospects, only one reaches the current qualification minimum of 75; that
prospect lacks a contact. A different prospect has a permitted contact but a fit score of 72. Improve evidence and reachability;
lowering the threshold would conceal the actual bottleneck.

## Changes prepared with this review

- **Marketing toolkit on AI team:** shows the configuration each capability needs, missing setup, and links to the relevant workspace.
  A configured capability still needs a running agent and successful provider access.
- **Bounded prospect research:** gathers additional evidence for an organization's own domain within a per-run limit, so discovery
  snippets are not the only input to qualification and research does not consume an unbounded budget.
- **Actionable SEO in the Monday scorecard:** carries useful search and website opportunities into the combined report instead of
  losing them when individual weekly emails are suppressed.
- **Reuse approved creative without a drafting model:** an ad refresh can use an approved asset even when new AI copy cannot be
  generated. New copy still requires the model.

The normal repository checks and review must complete before release. These changes do not supply missing account credentials,
create ad campaigns, or establish that a marketing channel is profitable.

## Activation order

1. **Complete the existing release.** Production's latest migration at review was `20261109120100`, the Monday scorecard contract.
   The existing public-article, Hub Settings, and Creative Director migrations still need the normal migration and reviewed release
   process. Follow [production rollout](PRODUCTION_ROLLOUT.md) and [Settings migration](SETTINGS.md#moving-off-the-railway-variables).
   Preserve current settings when moving them into the Hub. Publish source changes through the reviewed PR and normal Railway
   deployment; do not substitute an ad hoc deployment.
2. **Release and verify the conversion events.** Intel uses its existing server billing application key and canonical account binding
   for `/api/apps/growth`; no additional event signing key or manual tenant matching is needed for this path. Its first real nonempty
   provider list emits first value prospectively. The Hub emits trial starts from live billing trials and purchases only from positive
   paid invoices, preserving checkout holds. Legacy explicitly mapped HMAC producers still work. Release both applications' migrations
   and workers, then verify natural customer events arrive once. The scorecard reports verified measurement only for complete windows
   after rollout; it does not infer past conversions or count old subscriptions as new buyers. Follow [Customer growth](CUSTOMER_GROWTH.md).
3. **Connect the chosen social accounts.** Follow [Social media](SOCIAL_MEDIA.md#setting-it-up) and
   [Connecting LinkedIn](SOCIAL_MEDIA.md#connecting-linkedin). Put account ids, images, limits, and API versions in Settings → Social
   media; keep credentials in secret storage. LinkedIn API access needs LinkedIn's approval. Resume Social Media Manager in Propose
   when the intended channel is ready. Ads require an existing campaign/ad set and an ad to evaluate; the agent does not create the
   first campaign. Set a result-cost target and spending cap before reviewing budget changes.
4. **Connect search measurement.** Give the service account access to the correct Search Console property, configure its credential,
   and enter the properties in Settings → Search. Verify a report can read them. See
   [Search Console setup](AI_TEAM.md#search-console-optional). Track organic clicks alongside trials; clicks alone do not establish
   sales impact.
5. **Activate creative production.** Use Settings → Creative and [Creative Director](CREATIVE_DIRECTOR.md). Internal image and video
   rendering does not require HeyGen. Add HeyGen only when presenter videos serve a specific campaign; it is optional. Review approved
   images through the social publishing path. Video creation does not imply automated video publishing to every listed platform.
6. **Connect first-party session measurement.** The [Intel reader](WEBSITE_SESSION_METRICS.md) adds anonymous public-site sessions to
   the scorecard after the native endpoint, dedicated shared key and Hub setting are configured. It requires no analytics subscription.
   Historical weeks before collection remain unknown. Sessions and product events are separate populations; matched visitor-to-trial
   conversion is not claimed.

## Working rhythm and success measures

Daily, the team should find and research appropriate prospects, answer incoming sales questions, progress permitted follow-ups,
check trial activation, and review connected ads. The owner should clear proposals and inspect failed or skipped work. An agent
being active, or a task ending in Done, is not evidence that it produced a useful result.

Weekly, review the Monday scorecard and choose the few changes most likely to improve the funnel: clearer targeting, a stronger
article or creative angle, an easier trial start, or help reaching first value. Compare qualified prospects, delivered messages,
replies, trial starts, first activations, new paying customers, revenue, and churn. Include acquisition cost when channel spend is
available. Keep the dates and denominators explicit; compare trial cohorts through paid conversion rather than dividing unrelated
weekly totals. Use engagement, clicks, and generated assets as diagnostic measures, not the objective.

Review a sample of evidence, sales drafts, public content, and results before expanding autonomy. Existing approvals, suppression,
contact eligibility, product claims, and spending limits remain in effect. Keep one shared
[go-to-market fact sheet](GTM_FACTS.md) and [sales playbook](../server/growth/playbook.mjs) across the revenue team.

**Current commercial scope remains CareMetric Intel only.** CareBase stays in the owner-selected pilot; Advisors marketing stays
off. The team sells through self-serve pages, trials, guides, and written answers. It does not offer calls, meetings, or demos. See
[product marketing switches](AI_TEAM.md#what-the-team-markets) and [self-serve selling](AI_TEAM.md#no-demos-calls-or-meetings).

## Added 2026-11-13

New readiness rows on the AI team page: Medicare roster prospecting (`prospect_roster`), named decision-makers (`decision_makers`),
prospect research with web search (`prospect_deep_research`), posts for your own LinkedIn profile (`founder_posts`), county snapshot
images (`county_snapshots`), new paid campaigns (`paid_campaigns`) and leads reported to the ad platforms (`ad_conversions`). Each
row names the setting or secret still missing. The morning brief's watchdog quotes the first missing step when an agent goes quiet.
What each does and the order to turn them on: [AI_WORKFORCE_REVIEW_2026-11-13.md](AI_WORKFORCE_REVIEW_2026-11-13.md).
