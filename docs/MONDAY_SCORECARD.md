# The Monday scorecard

One email from the Chief of Staff every Monday at 07:50 Eastern (task `scorecard.weekly`, shown as "Monday scorecard") in place of
the five weekly reports: the account report (`accounts.weekly`), the growth report (`growth.weekly`), the SEO report (`seo.weekly`),
the pipeline review (`sales.review`) and the social report (`social.report`). The morning brief (`brief.daily`) is unchanged.

It uses no model and sends nothing to a customer. Code: `server/agents/scorecard/`. Database:
`supabase/migrations/20261109120000_monday_scorecard.sql` and its gate `20261109120100_monday_scorecard_contract.sql`, which declares
`platform.agents.scorecard.v1`.

## What it says

**Needs you**: at most three items, most urgent first, each with a button to the screen that handles it. They come from what the
brief and the five reports already flag:

| Order | Item | From | Screen |
| --- | --- | --- | --- |
| 1 | Products down right now | the brief (open incidents) | AI team |
| 2 | Proposals waiting for your approval | the brief | AI team |
| 3 | Customer accounts that need attention | the account report's "needs you" list (at risk, unpaid, cancelling, urgent cases and the rest it flags) | Billing, Customers |
| 4 | Deals waiting on you in the pipeline | the pipeline review | Customer growth |
| 5 | Ads losing money | the ad rules the daily ad review uses (ads it would pause) | AI team |
| 6 | Urgent website problems | the SEO crawl's high-severity findings | AI team |

When more than three apply, the email says how many smaller items are left.

**The numbers**, for CareBase and CareMetric Intel, each beside last week's figure. The week is Monday to Sunday Eastern, the one
before the week the scorecard is due in, against the week before that.

1. **Website measurement**, only from a configured source. Intel’s [first-party reader](WEBSITE_SESSION_METRICS.md) reports
   anonymous browser-tab sessions after setup; it does not count unique people. CareBase remains “Not connected.” Missing, failed and
   incomplete periods stay unknown; only complete measured periods may report zero.
2. **County reports**: website leads of that kind, excluding test leads. **Trial starts (verified)** count the first processed billing
   trial event per organization and product after the app-growth lifecycle release. Before that capability is available, the row is
   explicitly **Trial sign-ups**, counting website forms rather than claiming a product trial started.
3. **Activated trials**: organizations whose first `first_value` product event fell in the week. A repeat event is not a new activation.
4. **New paying customers and MRR**. MRR is the Billing screen's figure, from the same functions (`src/billing/billingMath.ts`).
   The figure a week earlier is the same calculation over the subscriptions that were paying then, read from each subscription's
   own dates (created, trial end, ended) at today's prices and discounts. **New paying customers (verified)** come separately from
   processed billing events backed by a confirmed positive invoice payment, once per organization and product; subscription status
   or an ended trial alone never proves a purchase. Renewals do not count as new customers. Trial and paid measurement is prospective:
   windows beginning before the persisted lifecycle start timestamp remain unavailable, rather than displaying historical zeros.
5. **Outbound email**: delivered, replies, bounces and complaints for the team's growth emails, by product, from the provider's
   delivery events and the reply events. Internal organizations are left out.
6. **Cost per trial**, across both products: the AI spend recorded on agent runs in the week, plus the ad spend when an ad account
   is connected (Meta and LinkedIn figures from the social report, plus Google Ads account spend including paused or ended campaigns,
   for the same Monday-to-Sunday calendar dates, also on a run later in the week), divided by verified trial starts. Google interprets
   these dates in the advertising account's time zone. It is unavailable when either product's trial count is unknown or any connected
   ad account cannot be read; known AI spend is still shown separately. Before lifecycle
   measurement, this is explicitly **Cost per trial sign-up**, using website form submissions.

With Search Console connected (`HUB_SEARCH_CONSOLE_CREDENTIALS` in Railway and the properties in Settings → Search, see the SEO Analyst), **organic
search clicks** per product are added: the last seven days with final data against the seven before. A property's host decides its
product; other sites (Healthcare Advisors, the help center) are left out. A product with no property has no clicks row, and one whose
properties could not be read says so instead of showing zero.

The same email also carries **up to three search opportunities**, one of each kind: a page seen often but rarely clicked, a search
near the first page, and a search for which two of the company's sites compete. These use the SEO Analyst's existing rules on the
last 28 days of final Google data; the date range is shown separately from the seven-day click totals. A failed detailed read does
not hide available click totals, and a failed totals read does not hide available opportunities. Partial property failures are
reported. Queries that look personal are excluded by the same rules as the full SEO report.

**What changed** lists counts that moved from the week before, totalled over both products only when both periods are known.

A source that cannot be read (billing, the pipeline, the ad accounts, the websites, the brief's facts) is named in the email and
the rest still goes out. Only the scorecard's own counts are required: if they cannot be read the task fails and is tried again.

## The week's constraint (the weekly strategist)

Since 2026-11-17 (`20261117170000_weekly_strategist.sql`, gate `20261117170100_weekly_strategist_contract.sql`, feature
`platform.agents.strategist.v1`; code `server/agents/strategist/`). With **Settings → AI team → Name the week's binding constraint**
on, the Chief of Staff's `strategy.weekly` task (07:35 Eastern, shown as "Name the week's constraint") writes one note for the week the
scorecard reports, and the scorecard opens with it: the constraint, the figure that shows it, why, one move for this week, and the
figure to watch next Monday.

1. **The figures.** `private.growth_strategy_facts(since, until)` reads CareMetric Intel's funnel for the week, counts only: strong
   fits (75 or more) not yet written to and how many have an address the team may write to, roster agencies resolved and still
   unresolved, addresses checked and unanswered, cold first emails and later touches, every cold email attempted (the bounce rate's
   denominator, counted by message), deliveries, hard bounces (addresses the Hub suppressed) and soft ones, complaints, agencies that
   replied or opened their report, trial starts, first value and paid, days the cold-email cap or Intel's own daily limit was reached
   (and both limits), drafts waiting and how many
   of them are approved, briefs written, the Marketing Manager's spend and the days its budget ran out,
   proposals waiting for you, the bounce guard's own window and the current cap and address-check mode. For the strong fits with no
   address, where each stopped (`prospects.noContactSteps`: no website of its own, not searched by the people finder yet, searched with
   nobody named and how many of those are not matched to a Medicare record, or someone named and no address), the people finder's week
   (`addresses.finder`: agencies searched, addresses found, days it ran out of the day's address checks, what the mail servers
   answered) and "Most address checks a day" and "Finding people's addresses" as the finder reads them
   (20261117200000_strategist_reach.sql). Internal organizations never count. Strong fits, where they stopped, waiting drafts and
   approvals are as of the read.
2. **The candidates** (`server/agents/strategist/rules.mjs`), scored 0 to 100 from the figures alone: email bouncing (a complaint, or
   2% or more hard bounces of at least 10 sent; half weight when the bounce guard's window since shows 10 clean sends), too few agencies
   ready, strong fits with no address found (half or more; the move raises "Most address checks a day", doubled, at most 500, only when
   the people finder ran out of checks on 2 or more days, and otherwise names the step that lost the most of them: nobody named, so
   import the addresses you know on Growth; someone named and no mail server confirmed an address, so turn on guessing and checking
   or import them; no website, so look up more roster agencies; not reached yet, so leave the finder running. The first note, on
   2026-11-16, asked to double a limit of 100 that was never reached), strong fits whose address waits for your permission (5 or more; the move
   is your decision on Growth, since more address checks cannot reach them), a daily limit (the cold-email cap or Intel's own "Maximum messages per day" on
   Growth, which the send claim checks first, reached on 4 or more days with 5 or more approved drafts waiting and bounces under 2%;
   the move raises whichever limits sit below the new number, at most 100), first emails not read or answered (30 sent over two weeks, no reply, under 10%
   of the two weeks' first emails opened; while report opens are not recorded, on replies alone, saying opens are unknown), interest without trials, trials without
   first value, the Marketing Manager's budget (3 or more days), and proposals waiting for you (10 or more). A constraint the figures do
   not show is never offered.
3. **The choice.** One call on the top model (high effort, about 10 to 20 cents) reads the figures, the week before's counts, the
   candidates and last week's note with what its watched figure did since, and picks one candidate. Every number it writes must be one
   of the figures (last week's watched figure included), and a link, an address or a person's title is refused. Lengths are checked
   in code: the runtime's answer formats take no length keywords. When the model is not configured, out of budget or refused,
   the top candidate goes as the rules wrote it, and the note says the rules chose it.

The note is kept in `private.agent_strategy_notes` (one row per reported week, closed to every role). A scheduled run writes the week
once; **Run now** writes it again. When the Hub catches up after both morning times have passed, the strategist and the scorecard are
claimed together: a scheduled scorecard then waits three minutes at a time, at most five times, while the strategist's task is running
or due (`private.agent_strategy_pending`), and opens with the note. A strategist that is off, failed or done never holds it. The scorecard's stored body carries the constraint's key only; the note's words travel in the
email's layout blocks. Without a note (the setting off, or the run failed) the scorecard is as before.

## What is kept

The subject, the stored body (the notification log and the Team screen), the run summary and the task result carry counts only. MRR,
spend and cost per trial are only in the email's layout blocks, which the notifier never stores. No customer name, amount or address
is kept, as with the other reports.
Search opportunity queries and page addresses also travel only in those layout blocks.

## Once a week

The schedule fires every morning at 07:50 Eastern. Every scheduled run in an Eastern week uses the alert key `scorecard:<Monday>`:
the first run of the week sends (normally Monday's; a Hub that was down on Monday reports on its next morning), and later runs see
the week sent, on its way or switched off and do no work. A send the email provider refused is tried again a few minutes later
under the same key, and a retry keeps the week it was due in. **Run now** always reports the last full week, under a key of its own.

## The individual weekly reports

The owner's setting "Send the individual weekly reports", under **Weekly reports** on the AI team page, starts **off** once the
scorecard is declared. While it is off and the scorecard is going out (the Chief of Staff is resumed and its "Monday scorecard"
schedule is on), the five reports' scheduled runs stop at once (result `skipped: in_scorecard`) and email
nothing; the scorecard carries their figures. **Run now** on any of them still emails that report in full. Switch the setting on to
get them again beside the scorecard. A stale screen is refused and every change is audited (`agent.individual_reports`). If the
setting cannot be read, or the Chief of Staff is paused, the reports send: a second email is better than a missing one. Without the scorecard's migration nothing
changes: every report emails as before.

The scorecard includes actionable search opportunities without a model call. The SEO Analyst's full report also produces checked
title and description drafts when its model is connected: use **Run now → Weekly SEO check** to request them, or enable
**Send the individual weekly reports** for scheduled drafts. They are suggestions for the owner to apply; no page is changed automatically.

## Boundary

The setting is a one-row table with row level security and no privilege for any role. The Hub server reads it and the figures only
through `private.agent_individual_reports()` and `private.agent_scorecard_facts(since, until)` (a window of up to 31 days): security
definers with a pinned empty search path that refuse every session user but `hub_app_server`. Their helpers are executable by no
role. The owner reads and changes the setting through `hub.get_scorecard_settings()` (administrator session) and
`hub.set_individual_reports(send, expected_changed_at)` (command session), which authorize the session themselves. The gate declares
the feature only when all of that holds and the Chief of Staff has its 07:50 schedule, and it needs the control plane, the hardening,
the brief, the Account Manager, the Growth Manager and customer growth first.

Tests: `server/agents/scorecard/*.test.mjs`, `supabase/tests/075_monday_scorecard.test.sql` and
`server/agents-scorecard-integration.mjs` (the owner's switch and the server's reads through the real roles).

## Switching it on

Apply `20261109120000_monday_scorecard.sql`, then `20261109120100_monday_scorecard_contract.sql`, and restart the Hub so it reads
the new feature. The scorecard goes out only while the Chief of Staff is resumed (it already is if the morning brief arrives); while
it is paused the five reports email as before. Press **Run now** on "Monday scorecard" to see one within a minute. From then on the
five weekly reports' scheduled emails stop until you switch "Send the individual weekly reports" on.
