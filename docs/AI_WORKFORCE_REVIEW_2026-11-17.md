# AI workforce review: stop losing finished work, then spend the ten sends well

Reviewed November 16 and 17, 2026, against Hub `main` at `ae35e2d` and Intel `main`.

- **Production counts:** read-only, the evening of November 16. No message text, name or address was read.
- **Earlier reviews:** this follows the [November 16 review](AI_WORKFORCE_REVIEW_2026-11-16.md). Its owner steps were done: the roster,
  briefs, the top-model writer, the reader's review, report opens, the address check, the bounce guard and budget flights are all on.
- **Code:** stage 1 is in [kdeyarmin/caremetric-support-hub#255](https://github.com/kdeyarmin/caremetric-support-hub/pull/255). Stage 2 is
  in its own pull request, after it (`20261117190000_growth_priority.sql`, feature `platform.agents.growth-priority.v1`).

**The owner's ask:** a comprehensive review of the AI workforce, and ways to make it more intelligent and better at winning new
customers.

**Answer in one paragraph.**
- Everything is switched on and handed over: 11 agents on Act, all 16 hand-over steps automatic, about $10 of the Marketing Manager's
  $15 a day in use. The team is no longer idle.
- But after 28 delivered cold emails there are still no replies, no outside leads and no ad running.
- The main reason is not the writing: **the team's own code throws finished work away, and nothing says so.** Every county snapshot
  was blocked by the render's reading of its own figure. The month's only ad flight went to LinkedIn while LinkedIn refused the team's
  token, and nobody was told. The image review blocked three images in four for the brand's own small print.
- Second, **ten cold emails a day is the whole machine, and they are not spent well.** The cap is reached with a queue behind it, the
  order is random, a third went out on a Sunday afternoon, 4 of 32 bounced, and the bounce guard could not trip at this volume.
- Third, **nothing can be learned yet.** Learning waits for replies, the reader's review keeps one number, a report open changes one
  sentence, and a prospect who replies and goes quiet gets nothing.

Stage 1 stops the losses and makes the team report them. Stage 2 makes each of the ten sends go to the best prospect at a sensible
hour and acts on interest. Stage 3 waits for a week of clean data.

## What production showed (November 16, evening)

| Measure | Value | Reading |
| --- | --- | --- |
| Agents and hand-overs | 11 active on Act; 16 of 16 steps automatic | Approval is no longer a limit |
| Model spend | $17.11 in 7 days; $10.22 of $15 by the Marketing Manager in the last 24 hours | In use, not short |
| Roster (Pennsylvania) | 612 open agencies; 125 looked up, 59 with a confirmed website (47%); 487 not yet looked up | About ten more days at 50 a day |
| Strong fits (75+) | 135; **45 have an address, 90 do not** (at 85+: 11 of 28) | Reach is still one in three |
| Named people | 182 found, 9 with an address (5%) | The people finder finds names, not addresses |
| Address checks (36 hours) | 44 checked: 7 confirmed, 11 accept any address, **25 no answer**, 1 unreachable | Why there was no answer was not kept |
| Cold email | 57 drafted; 28 delivered, **4 bounced (12.5%; 3 hard)**, 16 cancelled, 9 waiting | 3 of the 4 bounces were unchecked role addresses |
| Daily volume | 10 attempted on November 16 (cap 10); 6 approved and queued, 12 qualified with no draft, 11 held for an address check | **The cap is the limit** |
| When they went | 18 on weekdays in working hours, 3 at night, **11 on Sunday at 1pm** | No send window exists |
| Replies, report opens | 0 and 0 (4 emails carried a personal report link) | No signal yet |
| Reader's review | 4 scored: 2, 3, 3 and 3 (one after a rewrite) | None reached the pass mark of 4 |
| Account briefs | 22 written, 19 cents each; **10 for agencies with no address** | Half cannot be used yet |
| First email on the top model | 27 to 30 cents (the November 16 review estimated 7 to 15) | Twice the estimate |
| Website leads | 3 county reports from your own address; 2 trial sign-ups; none tagged | No outside lead on record |
| Trials | 3 open (1 activated), all yours or tests | Counted by the scorecard until marked internal |
| Ads | **None running.** November's flight failed on `linkedin_permission`; nobody was told | It would have failed again on November 23, and November 30 is too late |
| Creative | 43 approved, none live; **39 blocked: all 20 county snapshots, 18 of 24 by the image review, 1 other** | The team's own checks, mostly false alarms |
| Daily ad review | 18 recommendations, 18 skipped, every day | Nothing said why |
| Social | 6 posts published (the last on November 11), 2 failed, 12 scheduled November 17 to 22; LinkedIn token invalid | Owner step still open |
| Analytics | Intel's Google Analytics property not set | Owner step still open |

## What changed (stage 1)

| # | Finding | Change | Setting |
| --- | --- | --- | --- |
| 1 | **Every county snapshot was blocked.** 12 failed at render, where the copy rules read the code-printed figure ("72%") as a number the fact sheet does not state; 8 failed when drafted, because the model's alt text repeated the figure. Each still used the week and kept its county out for eight weeks | A snapshot is checked at render against its brief's data, as when drafted. Code writes its alt text from the figure, label and source. A county counts as pictured only while its snapshot is in the works or one of its images survived; one whose snapshot was all blocked waits a week and gives the week its room back. The 12 blocked at render are rendered once more | None (a fix) |
| 2 | **The month's flight went to a disconnected platform.** The plan tried LinkedIn first because a token was saved, not because it worked; the failed launch told nobody; and the next plan was a week away | The plan skips a platform whose last refusal of the team's sign-in or permission is newer than its last reconnect. A refused campaign tells you at once. A flight that failed is tried again the next day on a working platform, at most three times a month | None |
| 3 | **The image review blocked 18 of 24 images, mostly for the brand's small print.** The site address and the product name inside the logo were "too small", and the supporting line was "a number the image was not meant to show" because the reviewer was not told it was there | The reviewer is told every string the layout drew and which parts are furniture; each defect names its element; only a defect on the ad's own words blocks. The layouts were fixed where it saw real faults: every checklist item drawn (landscape drew 3 of 5), the headline layout fitted to its room, no supporting line cut off with "…", small print at least 2.2% of the width. Images blocked only by the first version are reviewed again once | Existing: Have a model look at each image before you see it |
| 4 | **The bounce guard could not trip.** It needed 20 cold emails inside a window each save restarts; at ten a day that never filled, so 4 bounces in 32 never tripped it | It trips on two or more hard bounces above your percentage, counted against at least 20 emails: 2 in 10 trip it at 5%, 1 does not | Existing: Pause cold email at this bounce rate |
| 5 | **Most address checks got no answer, and the reason was thrown away** | Servers that offer TLS are asked over TLS; each run counts why it had no answer (greylisting, blocked, TLS required and the rest); an address the people finder already confirmed is not asked again | None |
| 6 | **Interest was never recorded.** Intent was empty on all 235 opportunities, the trials included | Each recorded event sets it: trial, sign-up, first value, payment or meeting 100; positive reply 75; reply 60; opened report 50; "not now" 25; "no" 0 | None |
| 7 | **Your own trials counted as customers** | A trial from your address or a CareMetric domain is internal. The three open Intel trials were marked once, by your decision | None |
| 8 | **The daily ad review hid why it skipped** | Each run counts its skips by reason and keeps each platform's access error | None |
| 9 | **The watchdog saw none of this** | It now names, with its likely cause: most of a week's images blocked, a refused campaign with nothing since, prospects waiting a day with nothing drafted (and why), cold email bouncing, the cap reached with a queue, most strong fits without an address, and an ad budget with nothing running | None |

Turned-down drafts stay final, as before (a prospect behind one waits for you). The watchdog now counts them, and a one-time rewrite from
your note is listed below as not built.

The database side is one migration pair (`20261117180000_work_recovery.sql`, gate `20261117180100_work_recovery_contract.sql`, feature
`platform.agents.work-recovery.v1`). It changes no table and adds no setting.

What stays the same:
- The send claim decides every send.
- No demos, calls or meetings.
- An email never states an agency's own share, rank, ratings or patient counts.
- Never a physician's name or NPI, never the SSVI.
- Only migrations write the auto-approve lists.

## What changed (stage 2)

Each new behaviour has its own switch, off (or empty) until you set it; the details are in
[Customer growth](CUSTOMER_GROWTH.md#spending-the-days-cold-emails-well-and-acting-on-interest-2026-11-17).

| # | Change | Setting (Settings → Customer growth), off until you set it |
| --- | --- | --- |
| 1 | Send to the best prospects first: a second email to an agency that opened its report, then a first email with a brief and a confirmed named person, then with a brief, then the rest, by fit, with waiting time so nothing starves. A capped email waits for the next day instead of retrying every 15 minutes | Send to the best prospects first |
| 2 | On a first report open, the second email comes due as early as the 72-hour gap allows | (with 1) |
| 3 | Cold email only inside your weekday hours, Eastern | Send cold email from this hour / until this hour |
| 4 | Briefs only for agencies the team can write to, and the write-up inside "Most to spend on one account brief" | None (a fix) |
| 5 | The reader's review sees the brief and the writer's rules, scores against a described scale, names a weakness from a fixed list, and keeps all four scores; the Monday memo names the commonest weakness | Existing: Have a reader review each first email |
| 6 | A short first email as a test for half of report-led first emails: about 70 words, the agency's report and one question; the trial and its card terms move to the second email | Test a short first email |
| 7 | The Monday memo compares arms on report opens until replies exist | Existing: Write from what is working |
| 8 | At most two follow-ups to a prospect who replied, was answered and went quiet (four days after the answer, then five days later), through the same send claim, caps and opt-out; a customer email, so the Sales follow-ups step hands it over | Follow up when a prospect who replied goes quiet |
| 9 | The Sales Executive answers with the account brief, which email was answered and whether the report was opened (never said to the prospect) | Give the Sales Executive the account brief |

## What changed (stage 3)

Started on 2026-11-17 at the owner's request, before the week of clean data the review had planned; the owner's decisions that day are
marked. Details are in [Customer growth](CUSTOMER_GROWTH.md#reaching-the-right-agencies-and-checking-the-writing-2026-11-17)
(`20261117200000_growth_reach.sql`, feature `platform.agents.growth-reach.v1`).

| # | Change | Setting (Settings → Customer growth) |
| --- | --- | --- |
| 1 | **Agencies under pressure first** (owner's decision). Intel already sent each agency's county and state share and rank, and its HHVBP adjustment and Hospice Care Index; the Hub dropped them. They are kept as research (never in an email) and ranked: a small share of a crowded county +8, a Medicare pay cut under HHVBP +8 (+10 at 2% or more), low quality stars +5, a low Hospice Care Index +5; the county's leader -10, top stars -3. A new certification (+25) and a new owner (+20) still lead. The rank decides which agencies are looked up first | None (the roster's own rank) |
| 2 | **A web search for the agencies not found** (66 on 2026-11-16). The model proposes up to two sites; one is used only when the usual checks confirm it, through the same path as a lookup (owner's decision). An unconfirmed suggestion is only shown on Growth | Search the web for roster agencies not found; Most agencies to search the web for a day (10); Most to spend on one website search (10 cents) |
| 3 | **A live writing evaluation each Monday** (owner approved cases, grading and cost): twelve made-up Intel agencies across the four triggers, with and without a brief, short and standard, written on the real writer and read by the reader. Passes when every draft passes the checks and the reader's average "would reply" is at least 3.5 with none below 2. Recorded as `growth.live.1`, so it never holds up sending; the Monday scorecard reports it | Run a live writing evaluation each Monday |

The fourth stage 3 item, a Monday note naming the week's binding constraint, was built separately (kdeyarmin/caremetric-support-hub#258).

## What you need to do, in this order

1. **Merge this pull request** once its checks pass. Railway deploys it; the migrations are applied to production by hand, before the
   switches are turned on.
2. **Reconnect LinkedIn** (Settings → Social media). It also decides where the month's flight can run: until then the plan gives it to
   Meta, the day after the deploy.
3. **Set Intel's Google Analytics property** (Settings → Analytics).
4. **Confirm the growth sender's domain records** (SPF, DKIM, DMARC). This review did not look them up.
5. **Keep "Most cold emails a day" at 10** until 50 cold emails in a row bounce under 2%.
6. **Read the first watchdog findings** in the next morning brief. They say what is still being lost and why.
7. **After stage 2 merges:** set the send hours (8 to 16 suggested) and turn on "Send to the best prospects first" (Settings → Customer
   growth). A week later, once the bands look right, turn on "Test a short first email", "Follow up when a prospect who replied goes
   quiet" and "Give the Sales Executive the account brief".

## Cost

| Item | About |
| --- | --- |
| Stage 1 itself | No new model call. The image review is one call per image as before |
| Images reviewed again once | Up to 18 images at about a cent each, from the Creative Director's $3 a day |
| Snapshots rendered again once | 12 renders inside "Most renders a day" |
| Stage 3 | The website search: up to 10 agencies a day at most 10 cents each (about $1 a day at most, and only until the 66 are done). The live evaluation: about $1.50 to $3 a week. Ranking: no model call; one more call to Intel's feed per 25 agencies when the roster is read |
| Stage 2 | The reader's review reads the brief and the rules (a little more input, about a cent an email as before); each quiet follow-up is one draft call (about 2 cents); the Sales Executive's context adds a few hundred input tokens to a reply. The brief's write-up now has a ceiling, so a brief never costs more than "Most to spend on one account brief" |

## Not built (in order of what it would add)

- **Slipping stars in the rank.** Intel sends one star rating, with no history; a trend would need Intel to send the previous release.
- **Approving a suggested website by hand.** By the owner's decision only a code-confirmed site is used.
- **Usage-aware trial emails.** Intel reports only lists built and activities done; first sign-in, setup and seats would need an Intel change.
- **Public county market pages on Intel**, for search traffic.
- **A paid address-checking service**, once the new reason counts show why checks go unanswered.
- **More roster states**, once the cap rises.
- **Half-price batch pricing for briefs**, before volume goes up.
- **A one-time rewrite of a draft you turned down**, from your note.
- **A code check that blocks text running past its room.** The line estimate is too rough to block on; the image review judges it.

## How to tell it is working (check weekly)

- County snapshots approved rather than blocked, and county images in the Monday plan (`snapshots` on the creative plan runs).
- A flight reserved on a working platform this month (`ads.launch_reserved` in the audit log), and `<platform>_connection_failing` in
  the plan's result while LinkedIn is disconnected.
- Images reviewed again (`requeued` on the render runs) and the image review's blocks per week.
- The watchdog's findings in the morning brief, and fewer of them each week.
- Why address checks went unanswered (`why` on the `growth.verify` and `growth.people` runs, and `mailbox_reason` on each contact).
- The bounce guard's state on Growth → Send guard.
- After stage 2: sends by priority band and by hour, four reader scores and a weakness per first email, opens per arm.

## Limits of this review

- **Production was read, not written.** Nothing was sent, and no live model, mail server, search provider, ad platform or Intel endpoint
  was called.
- **What was tested:**
  - The Hub's unit tests for every changed area, the full check before pushing, and the growth evaluation.
  - Against a local Supabase stack with every migration applied: all pgTAP tests (the new `112_work_recovery` included), the backend
    contract replay, the new `server/agents-work-recovery-integration.mjs` run twice, and the existing creative review, address check,
    social, people finder, hand-over, lifecycle, report views, inbound, creative data, hardening, growth, accounts and sales scripts.
- **What is not known yet:**
  - Whether TLS turns the unanswered address checks into answers; the reason counts will show it within a day.
  - Whether the version 2 image review passes images a reader would also pass. Its blocks and scores are kept for each image.
  - How persuasive the emails are: no reply has arrived yet to judge them by.
