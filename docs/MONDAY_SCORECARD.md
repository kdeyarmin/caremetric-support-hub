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
| 3 | Customer accounts at risk | the account report's health bands | Billing, Customers |
| 4 | Deals waiting on you in the pipeline | the pipeline review | Customer growth |
| 5 | Ads losing money | the ad rules the daily ad review uses (ads it would pause) | AI team |
| 6 | Urgent website problems | the SEO crawl's high-severity findings | AI team |

When more than three apply, the email says how many smaller items are left.

**The numbers**, for CareBase and CareMetric Intel, each beside last week's figure. The week is Monday to Sunday Eastern, the one
before the week the scorecard is due in, against the week before that.

1. **Website visitors**, only from a connected analytics source. None is connected to the Hub today, so the email says "Not
   connected". It is never estimated.
2. **County reports and trial starts**: website leads of those kinds (test leads left out), the same leads the growth report counts.
3. **Activated trials**: organizations whose first `first_value` product event fell in the week. A repeat event is not a new activation.
4. **New paying customers and MRR**. MRR is the Billing screen's figure, from the same functions (`src/billing/billingMath.ts`).
   The figure a week earlier is the same calculation over the subscriptions that were paying then, read from each subscription's
   own dates (created, trial end, ended) at today's prices and discounts. A new paying customer is an account whose first paying
   subscription for the product started paying (its trial ended, or it began without one) in the week: one that converts and cancels
   in the same week counts, and one that comes back after a gap is not counted again.
5. **Outbound email**: delivered, replies, bounces and complaints for the team's growth emails, by product, from the provider's
   delivery events and the reply events. Internal organizations are left out.
6. **Cost per trial**, across both products: the AI spend recorded on agent runs in the week, plus the ad spend when an ad account
   is connected (the same Meta and LinkedIn figures the social report reads, for the same Monday-to-Sunday week, also on a run later in
   the week), divided by the trial starts.

With Search Console connected (`HUB_SEARCH_CONSOLE_CREDENTIALS` and `HUB_SEARCH_CONSOLE_SITES`, see the SEO Analyst), **organic
search clicks** per product are added: the last seven days with final data against the seven before. A property's host decides its
product; other sites (Healthcare Advisors, the help center) are left out. A product with no property has no clicks row, and one whose
properties could not be read says so instead of showing zero.

**What changed** lists every count that moved from the week before, totalled over both products.

A source that cannot be read (billing, the pipeline, the ad accounts, the websites, the brief's facts) is named in the email and
the rest still goes out. Only the scorecard's own counts are required: if they cannot be read the task fails and is tried again.

## What is kept

The subject, the stored body (the notification log and the Team screen), the run summary and the task result carry counts only. MRR,
spend and cost per trial are only in the email's layout blocks, which the notifier never stores. No customer name, amount or address
is kept, as with the other reports.

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
