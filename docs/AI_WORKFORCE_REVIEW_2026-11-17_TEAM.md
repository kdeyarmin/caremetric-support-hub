# AI workforce review: the rest of the team, and the path from trial to paid

Reviewed November 17, 2026, against Hub `main` at `6988187` and Intel `main` at `d32ff37`.

- **Production counts:** read only, between 01:23 and 01:40 UTC on November 17. No message text, name or address was read.
- **Earlier reviews:** this follows the [growth review of the same day](AI_WORKFORCE_REVIEW_2026-11-17.md). All three of its stages
  are live (migrations applied, service restarted at 01:19 UTC), with every switch on and send hours 8 to 16. The outgoing email
  review ([kdeyarmin/caremetric-support-hub#261](https://github.com/kdeyarmin/caremetric-support-hub/pull/261)) merged the same night,
  and its migration is applied.
- **Code:** the owner chose all four recommendations (below): stages 4, 5 and 6 in that order, a trial counted once its card is on
  file, the support acknowledgment sent on its own, and paid ads aimed at the roster's states. Stage 4 is in its own pull requests (Hub
  `20261117230000_trial_path.sql`, feature `platform.agents.trial-path.v1`, and Intel's part).

**The owner's ask:** record a baseline of the growth funnel today, then review the parts that earlier reviews barely covered:
- the Support Concierge;
- the Account Manager;
- the Social Media Manager;
- the Creative Director;
- the Content Marketer;
- the Chief of Staff;
- Intel's trial-to-paid path.

On November 24, the funnel is measured again against this baseline.

**Answer in one paragraph.**
- The growth reviews made the cold email work. **The rest of the team would lose the first customers it produces.**
- **A prospect who signs up within three days of a cold email never gets a welcome.**
  - The customer email is refused as "too soon after a growth email".
  - The template is then never proposed again.
- **A sign-up that never adds its card is counted as a trial.**
  - It is sent the welcome and setup emails.
  - It is thanked for trying when it lapses.
- **Every Intel trial is told it hasn't set up.** The Hub reads usage from billing reports Intel never sends, instead of the activity
  events Intel does send.
- **Nothing is sent between day 7 and day 24 of a trial.**
- **A trial that ends unpaid is never recorded as lost.**
- **Nobody answers a trial customer's question.**
  - The Concierge cannot draft an answer to any message: every one of the last 17 had no product, and every help guide is tagged to one.
  - A trial customer's message is never handed to Sales.
  - The acknowledgment counts as the answer, which stops the reminders.
- **The owner's daily picture is noisy and partly wrong.**
  - The morning brief can never say "nothing needs you".
  - Weekly agents are reported idle.
  - Losses the owner can fix sit under "Worth knowing".
- **Outside cold email, little reaches the market.**
  - LinkedIn posts fail and are lost.
  - Facebook posts carry no image.
  - Interested comments never become leads.
  - Paid campaigns target the whole country.
  - Every call to action is the trial rather than the free market report.
  - The Content Marketer runs out of topics in about six weeks.

## Baseline (November 17, 01:23 UTC), to be measured again on November 24

| Measure | Value | Reading |
| --- | --- | --- |
| Cold email | 32 sent (31 in the last 7 days), 4 bounced; 18 of 32 sent on weekdays 8–16 Eastern; 7 approved and waiting | Stages 1–3 start from here |
| Replies and report opens | 0 and 0 | No signal yet |
| Account briefs | 22 | |
| Strong fits (75+) | 137, of which 42 have an address | Reach is still one in three |
| Roster | 59 graduated, 66 unresolved, 487 not yet looked up, 476 excluded | The website search (stage 3) works on the 66 |
| Creative | 43 approved, 36 draft, 9 blocked, 2 rejected | 36 returned to draft after the image re-review |
| Ad campaigns ever launched | 0 | November's flight failed on LinkedIn |
| Social posts | 6 published (last November 11), 2 failed, 10 scheduled; LinkedIn reconnected November 16, no refusal since | |
| Conversations (14 days) | 17, all with no product; the Concierge drafted none (no guide matched) | See finding 2.1 |
| Activity events (14 days) | 3 trial starts, 77 active, 1 first value, 14 heartbeats | All three trials are the owner's or tests |
| Subscriptions | 3 trialing (all internal), 1 active, 1 cancelled; 0 cards recorded at trial start | |
| Customer emails (all time) | 5: 3 welcome, 1 trial check-in, 1 setup nudge | |
| Agents' last run | Content Marketer November 13; Sales Executive never; the rest within a day | Both are flagged idle by the watchdog (finding 3.2) |

The November 24 check reads the same rows. Stages 1–3 are working if, by then:
- cold email went out only on weekdays inside the hours;
- the send queue is ordered by band;
- report opens or replies are above zero;
- the website search confirmed some of the 66 unresolved agencies;
- the live evaluation scored at least one Monday.

## What the review found

### 1. The path from trial to paid (Hub and Intel)

| # | Finding (evidence) |
| --- | --- |
| 1.1 | **A sign-up without a card counts as a trial.** Intel calls the Hub's `/api/apps/trials` when the person opens card setup, before any card exists (Intel `server/routes/billing.ts:119-130`). The Hub creates a trialing Stripe subscription (`server/billing.mjs:880-887`), and a trialing subscription queues `trial_started` (`20261111032204_growth_app_lifecycle.sql:120-122`). Consequences: <ul><li>An abandoned card setup gets the welcome and setup emails, though Intel keeps it on Billing.</li><li>It counts in "Verified trial starts" and cost per trial.</li><li>It is thanked for trying when it lapses.</li><li>It uses the one trial each product allows (`billing.mjs:866-874`).</li></ul> `billing_trial_cards` exists, but only billing reads it. |
| 1.2 | **Every Intel trial is told it hasn't set up.** The setup nudge is due when `hasUsage` is false (`accounts/lifecycle.mjs:112`). `hasUsage` reads `billing_usage_reports` (`20261113300000_lifecycle_save.sql:95`), which Intel never sends. Intel does send `active` and `first_value` events (77 and 1 in 14 days). |
| 1.3 | **A temporary refusal loses a customer email for good.** Any proposal for a template blocks it forever, whatever its status (`lifecycle_save.sql:98-99`). The send claim refuses `frequency_limited` when the address got a growth email within the policy gap, 72 hours (`20261107140000_review_round_two.sql:97-100`). So **a prospect who signs up within three days of a cold email never gets a welcome**: that is exactly the conversion the growth stages aim for. `daily_limit` and an expired proposal lose the template the same way. |
| 1.4 | **The trial goes quiet.** Customer emails are sent at three points (`lifecycle.mjs:110-112`): <ul><li>days 0–2: the welcome;</li><li>days 3–6: the setup nudge;</li><li>5 to 2 days before the end: the check-in.</li></ul> Nothing is sent between day 7 and day 24. Nothing is sent when first value is reached. Nothing in the last two days. The no-card case (1.1) has no email of its own. |
| 1.5 | **An unpaid trial end never reaches growth.** The lifecycle outbox knows only `trial_started` and `paid` (`growth_app_lifecycle.sql:62`), and the trial's end is captured once (`:122`, `on conflict do nothing`). An ended trial stays "Trial ended N days ago" in the Sales review forever (`sales/review.mjs:34`). An extension leaves a stale end date. |
| 1.6 | **Customer success plans pile up unsent.** A self-service trial's contact is missing or marked `review` (`20261113170000_growth_trial_link.sql:60,75-78`). Drafting needs `permitted` (`growth/worker.mjs:225`). So onboarding, activation and trial plans (`growth/policy.mjs:39-55`) stay open and are never sent: 1,172 `growth.success` sweeps in 21 days. Where a contact is permitted, they would go uncoordinated with the customer emails. |
| 1.7 | **Trial extensions mostly delay revenue.** Offers are not checked for usage or a card (`20261105140000_agent_offers.sql:143-160`), and the customer is not told (`docs/AI_TEAM.md`, offers). The seeded offer is off. |
| 1.8 | **Intel, after the card:** <ul><li>the person returns to Billing, not to guided setup (`src/pages/Billing.tsx:362`);</li><li>the only trial-end prompt is the sidebar's "N days left", hidden when the sidebar is collapsed (`BillingStatusWidget.tsx:52-55,96-98`);</li><li>changing plan says "contact CareMetric", and so does choosing a plan after cancelling (`Billing.tsx:504,508`), though the Hub serves self-service plan changes at `/api/apps/billing`;</li><li>a pending cancellation is read from the Hub but never shown (`server/lib/hubBilling.ts:120,217-229`).</li></ul> |
| 1.9 | **Intel never tells the Hub what the trial did.** It sends `active` (a list filled, a call, visit or email done), `first_value` (the first lead list with a real provider: one click in guided setup) and a daily `heartbeat` (the worker ran, not a person). It never sends: <ul><li>card confirmed;</li><li>last sign-in;</li><li>the agency's certification number saved;</li><li>county chosen (the trial shows nothing until one is picked);</li><li>Intel's own activation (a list, 5 real accounts and a visit within 7 days, `server/lib/activation.ts`);</li><li>seats and invites;</li><li>reports or assistant used.</li></ul> |

### 2. Support Concierge and Account Manager

| # | Finding (evidence) |
| --- | --- |
| 2.1 | **The Concierge cannot draft an answer.** Guides are matched by product (`concierge/knowledge.mjs:40`): a guide tagged to a product matches only a conversation of that product. Every published article (12) and course (80) is tagged to a product, and all 17 conversations of the last 14 days had none, so every draft stopped at `no_guides`. Intel has one published article; its Help topics and manual are not in the Hub. |
| 2.2 | **The acknowledgment counts as the answer.** Any outbound message after the first inbound one ends "waiting for a first reply" (`20261103130000_agent_growth.sql:81-84,352-354`). After the fixed "we will reply here with the information you need" (`concierge/templates.mjs:27`): <ul><li>the reminders stop;</li><li>the median first reply counts the acknowledgment;</li><li>nothing tracks the real answer promised.</li></ul> |
| 2.3 | **The lowest-risk message cannot go out on its own.** The fixed acknowledgment is a `communication.reply`. That needs the owner's session and refuses automatic approval (`concierge/executor.mjs:45-46`, `triage.mjs:188-190`), while model drafts can be automated. |
| 2.4 | **Nobody owns a trial customer's message.** <ul><li>The Sales hand-over leaves out the `trial` stage (`20261108180000_sales_executive.sql:67`).</li><li>The Sales prompt has no words for it (`sales/prompt.mjs:73-76`), so its "already in a trial, help them to a paid plan" step is unreachable.</li><li>"free trial" or "sign up" classifies a support question as sales (`concierge/rules.mjs:68-69`), which gets no draft (`policy.mjs:85`).</li><li>The Concierge's snapshot carries no account or trial status (`agent_growth.sql:365-380`).</li></ul> |
| 2.5 | **Smaller gaps.** <ul><li>An inbound text gets no alert (`concierge/settings.mjs:19`).</li><li>A Sales answer to outreach goes out titled "Your message to CareMetric support" (`concierge/answers.mjs:36`), which breaks the thread.</li></ul> |

### 3. Chief of Staff: the owner's picture

| # | Finding (evidence) |
| --- | --- |
| 3.1 | **The morning brief can never say "nothing needs you".** "Opportunities missing a contact" sits under Needs you (`tasks/brief.mjs:90`). It counts every opportunity ever found, in every product, that has no contact (`20261103150101_customer_growth.sql:605`), so it is never zero and the owner can't clear it. |
| 3.2 | **Weekly agents are reported idle.** "Idle" means no run in three days (`tasks/watchdog.mjs:103-108`). A weekly task that skips, or holds its report for the scorecard, records no run, so the watchdog flags: <ul><li>the Content Marketer (last run November 13);</li><li>the SEO Analyst;</li><li>the Sales Executive, which runs only when a prospect writes (never).</li></ul> These rank first and push real losses out of the eight-line cap (`watchdog.mjs:128`). |
| 3.3 | **Losses the owner can act on are buried.** "An ad platform refused a campaign" and "cold email paused by the bounce guard" land under Worth knowing (`brief.mjs:117`). In the scorecard they come after the method notes (`compose.mjs:282,310`). The scorecard also runs the watchdog without the toolkit or the owner's idle setting (`scorecard/index.mjs:171`), so it can disagree with the brief. |
| 3.4 | **Repeats and measures that can't move.** <ul><li>On Mondays the brief and the scorecard both list approvals and products down.</li><li>"Strong fits with no address" appears three times: watchdog, strategist and brief.</li><li>Half the scorecard's rows are CareBase, which is not marketed.</li><li>Cost per trial divides all AI spend (support, SEO, creative) by trials.</li></ul> |
| 3.5 | **The strategist suggests moves nobody can make.** Its activation move says to "call or email each new trial" (`strategist/rules.mjs:172`); calls are against the team's rules. It has no move for sign-ups that never add a card or trials that end unpaid (`rules.mjs:17-28`). |

### 4. Social Media Manager and paid ads

| # | Finding (evidence) |
| --- | --- |
| 4.1 | **LinkedIn posts are lost when the token is refused.** Posts are emailed to the owner to paste only when no token is saved (`social/tasks.mjs:249`). "Configured" means a token exists (`social/linkedin.mjs:96`), so with a refused token they fail at publish (`social/executor.mjs:87-89`) with no fallback. The ads planner already knows a failing platform (`ads/index.mjs:75`, stage 1). |
| 4.2 | **Facebook posts carry no image.** Only Instagram and LinkedIn posts get approved creative (`social/tasks.mjs:262-270`). Facebook posts are bare links, so with LinkedIn down approved images reach only Instagram. |
| 4.3 | **Interested people are lost.** <ul><li>A comment showing interest or asking about price gets only a reply draft and a count in the owner's email (`social/tasks.mjs:354-359,425-434`). No lead is created.</li><li>Comments on LinkedIn ads are filtered out (`linkedin.mjs:300`). Meta reads only the Page feed.</li><li>Platform lead-form leads are never pulled into the Hub (`social/tasks.mjs:511-512`).</li></ul> |
| 4.4 | **It learns from likes, not leads.** Posts are ranked by reactions (`social/rules.mjs:87`), and every link carries `utm_content=post` (`social/tasks.mjs:247`), so a lead can't be traced to a post. |
| 4.5 | **The call to action is the trial** (`social/content.mjs:54,101`), not the free market report the cold email and the ads lead with (`ads/index.mjs:37-39`). |
| 4.6 | **Paid campaigns target the wrong people.** <ul><li>LinkedIn: the whole US, the hospitals industry, manager level and up (`linkedin.mjs:503-507`). The roster company list is a manual step.</li><li>Google: the whole US (`ads/google.mjs:135`), and Google is not connected.</li><li>Meta retargets site visitors only (`social/meta.mjs:309`), and the site has little traffic.</li><li>Ads are bought for clicks, conversion reporting is off by default (`hub-settings.mjs`), and Google campaigns are never read back.</li><li>A $50 flight cannot reach the review's $20 or 1,000 impressions and 3 results, so nothing is learned (`social/rules.mjs:16,53,71`).</li></ul> |
| 4.7 | **A fallback campaign uses up the month.** When no creative fits, the campaign is created paused with no ads (`ads/index.mjs:421-425`), and it still counts as the month's flight (`:63`). |
| 4.8 | **LinkedIn's daily call limit.** On Mondays four jobs each read the whole ad account, up to about 24 calls each (`linkedin.mjs:418-438`). With the inbox's calls this can pass a Development-tier app's 100 a day. |

### 5. Creative Director and Content Marketer

| # | Finding (evidence) |
| --- | --- |
| 5.1 | **The Creative Director learns only from ads** (`creative/performance.mjs:44-60`), and none are running. Organic posts aren't traced back to the creative they used. |
| 5.2 | **Images with a warning can't be approved on their own and expire after seven days** (`20261109200000_creative_director.sql:315-327`). |
| 5.3 | **The Content Marketer will run out of topics.** It has 13 Intel topics, each written once, two a week (`content/topics.mjs:184-390,437-450`), so it runs dry in six to seven weeks. The watchdog doesn't notice an agent whose runs all skip. |
| 5.4 | **No article leads to the market report, and topics ignore search.** Articles link to Intel's home page, pricing or the county report. Topics are scored by priority and inbox counts (`topics.mjs:468`), not Search Console queries or roster counties. |

## Proposed stages

Each stage is one pull request (Intel's part is its own), behind a feature gate where it adds database work. New behaviour that sends
anything starts off; plain fixes need no switch.

### Stage 4: keep the first customers (Hub, and Intel's part)

| # | Change | Fixes | Switch |
| --- | --- | --- | --- |
| 4.1 | **Count a trial only once a card is on file.** <ul><li>For a product that requires a card, `trial_started` waits for the card check (`server/trial-card.mjs`).</li><li>The scorecard's trial starts and cost per trial follow.</li><li>A sign-up with no card is its own state.</li></ul> | 1.1, 3.4 | Plain fix |
| 4.2 | **"Finish adding your card" email** for an Intel sign-up with no card: <ul><li>on day 1 and day 4, with the portal's card-only link;</li><li>never a welcome, setup nudge or "thanks for trying".</li></ul> | 1.1, 1.4 | Account emails' existing approval |
| 4.3 | **The setup nudge reads Intel's activity events** (`active`, `first_value`), not billing usage reports. | 1.2 | Plain fix |
| 4.4 | **A refused customer email is proposed again.** <ul><li>After `daily_limit`, `frequency_limited` or an expired proposal, the template is proposed again the next run, while it is still due.</li><li>A growth email sent before the trial started no longer blocks the welcome.</li></ul> | 1.3 | Plain fix |
| 4.5 | **Two trial emails:** <ul><li>a mid-trial note on day 10–14 when there is no first value, pointing to the one step that shows value (pick a county, build the list);</li><li>a note after first value saying what the paid plan keeps.</li></ul> | 1.4 | New templates, same approval |
| 4.6 | **The trial's end reaches growth.** The mirror queues an unpaid ended trial as lost and updates the end date on an extension. The Sales review drops ended trials after 14 days. | 1.5 | Plain fix |
| 4.7 | **Trial customers' messages get an owner.** <ul><li>The Sales hand-over includes the `trial` stage, and its prompt gains the words.</li><li>The Concierge's snapshot carries the account's stage.</li><li>A question from a customer who is already trialing isn't classified as sales because it says "trial".</li><li>Success plans for a self-service trial are closed, since the customer emails cover it.</li></ul> | 2.4, 1.6 | Plain fix |
| 4.8 | **Intel:** <ul><li>after the card, go to guided setup;</li><li>a trial banner with the end date and the price it converts to;</li><li>a pending-cancellation notice;</li><li>change plan and choose a plan after cancelling through the Hub's `/api/apps/billing`;</li><li>send the Hub card confirmed, county chosen, certification number saved and Intel's activation (four new event kinds, accepted by the Hub's protocol).</li></ul> | 1.8, 1.9 | Intel pull request |

### Stage 5: answer people, and tell the owner the truth

| # | Change | Fixes | Switch |
| --- | --- | --- | --- |
| 5.1 | **The Concierge can draft answers.** <ul><li>A conversation with no product reads guides of every product (a product's own guides first).</li><li>A conversation from an Intel customer or prospect is given Intel as its product.</li><li>The Hub loads Intel's Help topics (the generated Help inventory) as guides.</li></ul> | 2.1 | Plain fix |
| 5.2 | **An acknowledgment is not an answer.** The fixed acknowledgment no longer ends "waiting for a first reply", so reminders continue until a real answer. | 2.2 | Plain fix |
| 5.3 | **The standard acknowledgment can go out on its own** on Act, to a real person only (after #261's sender flags). | 2.3 | "Send the support acknowledgment on its own" |
| 5.4 | **Smaller fixes:** <ul><li>a Sales answer keeps the thread's subject;</li><li>an inbound text alerts the owner.</li></ul> | 2.5 | Plain fix |
| 5.5 | **The morning brief and scorecard:** <ul><li>"Opportunities missing a contact" leaves Needs you;</li><li>the watchdog's top losses join Needs you;</li><li>Monday's brief leaves to the scorecard what the scorecard lists;</li><li>the scorecard passes the same watchdog options as the brief;</li><li>CareBase becomes one pilot line;</li><li>cost per trial is the Marketing Manager's spend plus ad spend, over card-confirmed trials.</li></ul> | 3.1, 3.3, 3.4 | Plain fix |
| 5.6 | **The watchdog judges idleness by each agent's cadence.** <ul><li>A finished task counts as alive, even when it skipped.</li><li>A weekly agent is idle after eight days.</li><li>An agent that runs only on an event is never idle.</li><li>An agent whose runs have all skipped for two weeks is named.</li></ul> | 3.2, 5.3 | Plain fix |
| 5.7 | **The strategist:** the "call or email" move becomes the email path. New moves: sign-ups with no card, and trials that end unpaid. | 3.5 | Plain fix |

### Stage 6: reach outside cold email

| # | Change | Fixes | Switch |
| --- | --- | --- | --- |
| 6.1 | **LinkedIn posts aren't lost.** While LinkedIn refuses the team, the week's LinkedIn posts are emailed to the owner to paste, as when no token is saved, and a failed LinkedIn post is added to that email. | 4.1 | Plain fix |
| 6.2 | **Facebook posts carry the approved image**, as a photo post with the tagged link. | 4.2 | Plain fix |
| 6.3 | **Interest becomes a lead.** <ul><li>An interested or pricing comment, on a post or an ad, creates a Hub lead.</li><li>That puts the person in front of the Sales Executive, and the owner gets an alert with the link.</li></ul> | 4.3 | Existing hand-over |
| 6.4 | **Each post gets its own `utm_content`.** Leads per post feed the weekly plan and the Creative Director's learning. | 4.4, 5.1 | Plain fix |
| 6.5 | **The free market report becomes the call to action** in posts, replies and articles, as in the cold email and ads. | 4.5, 5.4 | Plain fix |
| 6.6 | **Paid campaigns aim at the roster.** <ul><li>Every platform is limited to the roster's states.</li><li>LinkedIn's company list is built from the roster through the API.</li><li>A paused fallback campaign no longer uses up the month.</li><li>The ad account is read once a day and reused.</li></ul> | 4.6, 4.7, 4.8 | Plain fix |
| 6.7 | **The Content Marketer gets topics** from roster counties (a county's home health and hospice picture, linking to that county's report) and Search Console queries. Each topic is written once a quarter at most. | 5.3, 5.4 | Plain fix |
| 6.8 | **An image with a warning is listed for the owner** before it expires, instead of lapsing unseen. | 5.2 | Plain fix |

## What changed (stage 4, Hub)

| # | Change | Where |
| --- | --- | --- |
| 4.1 | An Intel trial counts from the first time Stripe confirms its card: `trial_started` is queued then, once, and the scorecard's trial starts follow. CareBase is unchanged | `growth_trial_card_seen` trigger on `billing_trial_cards`, `private.growth_trial_cards`, `growth_capture_billing` |
| 4.2 | A sign-up with no card gets only the card reminder (from about a day in to day 14), with Intel's card terms word for word and a button to its Billing page; never a welcome, setup help or "thanks for trying". One reminder, not two | `card_reminder` in `accounts/lifecycle.mjs` |
| 4.3 | Setup help reads Intel's `active` and `first_value` events; CareBase keeps its usage reports | `activeAt`, `firstValueAt` in `agent_lifecycle_json` |
| 4.4 | A customer email refused for the day's cap waits for 9 AM Eastern the next day, and one refused for the growth contact gap waits a day, instead of ending. So a prospect who signs up within three days of a cold email is welcomed a little later, not never | `private.agent_lifecycle_defer`, `executor.mjs` |
| 4.5 | Days 10 to 16 with more than 5 days left: the mid-trial next step without first value, or what to do next with it (Intel) | `midtrial_nudge`, `value_followup` |
| 4.6 | A counted trial that ends unpaid is queued as lost (`churned`) once, so the Sales review stops listing it; an extension moves the opportunity's end date. A sign-up that never added its card is not lost | `growth_capture_billing` |
| 4.7 | The Sales hand-over includes a prospect in its trial, and the Sales prompt has words for it. Classifying a trial customer's question as support, and closing success plans the customer emails cover, moved to stage 5 with the rest of the Concierge | `sales_handoff`, `sales/prompt.mjs` |
| 4.8 | Intel's three milestones (`county_chosen`, `agency_saved`, `activated`) are accepted as `active` events. "Card confirmed" needs no event: the Hub already records Stripe's answer | `growth_app_event`, `growth/protocol.mjs` |

Tests: pgTAP 116, `server/agents-trial-path-integration.mjs` (in CI, twice), unit tests for every rule. Three existing integration tests
now confirm a card on their Intel trials, as a real trial must. Nothing changes until the migrations are applied and the Hub restarts.

## Decisions for the owner

The owner chose the recommended answer to each, on November 17.

1. **Which stages, and in what order.** Recommended:
   - **4, then 5, then 6.** Stage 4 protects the customers stages 1–3 are trying to produce. Stage 5 is small and makes the owner's
     picture right. Stage 6 adds reach.
2. **How trials are counted.** Recommended: a trial starts when a card is on file. The scorecard's trial count will drop to the
   card-confirmed number.
3. **The support acknowledgment.** Recommended: let the standard acknowledgment go out on its own, to real people only. It promises
   an answer, and stage 5 keeps reminding until one is sent.
4. **Paid ads.** Recommended: keep Meta and LinkedIn, limited to the roster's states and leading to the market report, and turn on
   "Report leads to the ad platforms". Google search to the market report is the better buy once Google is connected, which is an
   owner step.

## Owner steps (no code)

1. Set Intel's Google Analytics property (Settings → Analytics). Still open.
2. Connect Google Ads (Settings → Social media) if the month's flight should go to search.
3. Keep "Most cold emails a day" at 10 until 50 cold emails in a row bounce under 2%.

## Limits of this review

- Production holds no outside trial, so the trial findings are read from code, not from customers' behaviour. The baseline's three
  trials are the owner's or tests.
- No live platform was called. LinkedIn's daily call count and Meta's reading of ad comments come from the code and the platforms'
  documentation, not from a live account.
- Intel's events and pages were read from its `main`. What its users actually do was not read.
