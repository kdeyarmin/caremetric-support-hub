# AI workforce review: reach more agencies, research them properly, learn who is interested

Reviewed November 16, 2026, against Hub `main` at `1078982` and Intel `main` at `8abe4c6`.

- **Production counts:** read-only. No message text, name or address was read.
- **Earlier reviews:** this follows the [November 15 review](AI_WORKFORCE_REVIEW_2026-11-15.md). Its owner steps were partly done: the roster is loaded and experiments are on.
- **Code:** built in Hub PR [kdeyarmin/caremetric-support-hub#215](https://github.com/kdeyarmin/caremetric-support-hub/pull/215) and Intel PR [kdeyarmin/intel#474](https://github.com/kdeyarmin/intel/pull/474).

**The owner's ask:** make the team far more intelligent at researching prospects, better at outreach and marketing, and more creative with ads, to win the first customers.

**Answer in one paragraph.**
- The team was eleven scheduled prompts, not agents. Every model call was one question and one answer on the mid tier, except one generic web-research step.
- No call read Intel's own data about the agency it was writing to. The writer saw about four web snippets.
- Nothing told the team whether an agency had opened its report.
- Reach was the tighter limit: most agencies the team knew about could not be written to at all.

This change does five things, each behind its own switch:
1. Fixes reach: it checks addresses, stops on bounces, and finds more websites and people.
2. Gives each agency a real research brief, built from Intel's data and dated web triggers and written on the top model.
3. Writes the first email from that brief, on the top model, with a reader's review.
4. Learns which agencies opened their report.
5. Makes the ads sharper: campaigns and county images send agencies to their own market report, county images say how concentrated and crowded the market is for one care setting and cover every county, and a model looks at each image before you do.

Changes 9 to 12 (ads and creative) were added the same day, in the same pull requests.

## What production showed (November 16)

| Measure | Value | Reading |
| --- | --- | --- |
| Medicare roster | 1,066 Pennsylvania agencies, 544 open | The best prospect list now exists |
| Roster agencies with a confirmed website | 9 of the first 44 looked up | The name search left 4 in 5 unresolved |
| Strong fits (75+) with a usable address | 28 of 94 | 66 strong fits could not be reached |
| Decision-makers | 109 agencies searched in 3 days, 92 names, 17 mail-server checks, 5 addresses | About 1 agency in 20 yielded a person |
| Cold email | 22 sent ever, 19 delivered, 3 bounced (14%), 0 replies | All three bounces were addresses read from the agencies' own sites (info@ and the like). The rule is under 2% |
| Engagement signal | None | Open and click tracking off; report opens not recorded; intent empty on all 178 prospects |
| Research | 19 runs, none on the 16 agencies scored 85+; 5 thrown away whole | Research went to borderline agencies, never the ones being emailed |
| Experiments | 30 emails over 15 combinations | Four things varied at once; no combination could reach the 20 sends the memo needs |
| Ads | 34 approved, 0 running, $50 a month, LinkedIn disconnected | Owner steps below |
| Creative | All 34 approved images are generic (headline, checklist, quote); no county image was ever made | County snapshots shipped November 13, but their migration reached production on the evening of November 15, after that day's plan run |

## What changed

| # | Change | Setting (Settings → Customer growth) |
| --- | --- | --- |
| 1 | **Check an address before the first cold email.** The business's mail server is asked whether the mailbox exists (nothing is sent). One that does not exist is never written to, and the people finder looks there again. A silent server is asked three times over two days | Check an address before the first email (off / check / strict) |
| 2 | **Pause cold email when it bounces.** Above your rate of hard bounces in the last seven days (20 emails or more), or after any spam complaint, cold email waits. You are alerted once a day and resume from Growth → Send guard | Pause cold email at this bounce rate (empty: off) |
| 3 | **Find more websites and people.** A second search by the agency's CMS telephone number, accepted only when the site shows that number. When the server refuses every shape of one decision-maker's name, the next decision-maker is tried | Always on |
| 4 | **Stop wasting research.** A line that looks like an identifier is dropped, not the whole run. Job listings and news are kept as dated triggers when they name the agency and are under 180 days old. Later research rounds keep the cached prefix | Always on |
| 5 | **An account brief for every Intel agency** before its first email (details below) | Write an account brief before the first email; Most account briefs a day (25); Most to spend on one account brief (60 cents) |
| 6 | **The first email from the brief, on the top model** (details below) | Write first emails on the top model |
| 7 | **A reader's review.** A second model scores each first email 1 to 5 as the agency's owner would. Below 4 it is rewritten once around its weakest sentence. The score is kept with the email | Have a reader review each first email |
| 8 | **Report opens.** Intel records which agencies opened their report: the agency and the time, never who. You are told on an agency's first open, intent rises, and the second email follows whether it was opened | Learn which agencies opened their report |
| 9 | **Ads send agencies to their own market report.** New Intel campaigns (LinkedIn, Meta and Google search) land on the free market report for the reader's agency, not the county report. The LinkedIn proposal says to use the roster's company list, because the report is for home health agencies and hospices | Always on (campaigns are still proposed only while "Most to spend on new campaigns a month" is set) |
| 10 | **County ads that say how crowded and concentrated the market is.** Intel now sends the share of patients the three largest agencies located in a county serve (only where CMS counted every agency and at least five are, never a name). Each county image is about one care setting, home health or hospice, and leads with that figure or how many agencies billed for the county's residents. It sends readers to their market report | County snapshots a week (Settings → Creative) |
| 11 | **All 67 counties.** County images were chosen only from counties with a roster agency located in them (64 of 67). Intel now lists every county of the roster's states, and the least recently pictured goes first. A run that makes no county image says why | Always on with county snapshots |
| 12 | **The image review.** A model looks at each finished ad image as a person in a feed would. Cut-off, overlapping, unreadable or garbled text, or a wrong figure, is never shown to you. A weak image (below your least score) comes with a warning and the model's note | Have a model look at each image before you see it; Least score from the image review (Settings → Creative) |

The account brief (change 5) is built in four steps:
1. **Intel's data:** the agency's market report as data (share, rank and history, the county's leaders, hospitals, ratings, moves), through the new `agency_brief` feed action.
2. **County figures** for the agency's own setting only: home health figures to a home health agency, hospice figures to a hospice.
3. **Dated triggers** from web research.
4. **The brief itself,** written by the top model.

Code keeps the agency's own share, rank and ratings out of the part the writer reads. Growth shows the brief on the opportunity.

The first email (change 6):
- It opens with the brief's cited sentence, asks one of its questions and leads with its angle.
- It may state one county figure for the agency's own setting, as a fact about the county, never about the agency.
- While experiments run, a quarter of agencies keep the old hashed angle, so the memo can tell whether the brief's choice helps.

What stays the same:
- The send claim decides every send.
- No demos, calls or meetings.
- No new outreach channel.
- An email never states an agency's own share, rank, ratings or patient counts.
- Every new capability ships off.

## What you need to do, in this order

1. **Merge and deploy Intel first** ([kdeyarmin/intel#474](https://github.com/kdeyarmin/intel/pull/474); migration 0171), then the Hub ([kdeyarmin/caremetric-support-hub#215](https://github.com/kdeyarmin/caremetric-support-hub/pull/215); migrations `20261116100000` to `20261116130100`).
2. **Settings → Customer growth:**
   - Check an address before the first email: **Check**.
   - Pause cold email at this bounce rate: **5**.
3. Hold "Most cold emails a day" at 10 until bounces are under 2%. Before raising it, confirm the growth sender's domain records (SPF, DKIM, DMARC); this review did not look them up.
4. **Settings → Customer growth:** turn on Learn which agencies opened their report.
5. **Turn on the brief and the writer:**
   - **Settings → Customer growth:** Write an account brief before the first email, then Write first emails on the top model and Have a reader review each first email.
   - **Read the first five briefs** on Growth before handing anything new over.
   - **Budget:** the migration raised the Marketing Manager's daily budget to $15, as you approved.
6. **Reconnect LinkedIn** (Settings → Social media). Both the Page token and the inbox permission are failing.
7. **Set Intel's Google Analytics property** (Settings → Analytics).
8. **Creative (Settings → Creative):** turn on Have a model look at each image before you see it (Least score 3). Leave County snapshots a week at 3: today's 8:30 plan run is the first that can make them, and Monday's ad plan can use the ones you approve.
9. **Ads:** $50 a month is below LinkedIn's $10-a-day minimum, so Monday's ad plan can only create paused campaigns. When you start one, use an approved county image: it now sends agencies to their own market report.

## Cost

| Item | About |
| --- | --- |
| One brief: research on Sonnet plus the brief on Opus | 30 to 45 cents |
| One first email on Opus at high effort | 7 to 15 cents |
| The reader's review | 1 cent (2 with a rewrite) |
| 25 briefed and reviewed first emails a day, with everything else | $12 to $16 a day |
| The image review, one per static image (about 40 a day at the render cap) | About a cent each, from the Creative Director's $3 budget |

The $15 budget stops the work rather than overspend. A day that runs out of budget leaves the rest for the next day.

## Not built in this pass

- **Ad budget flights.** At $50 a month, a thirtieth a day is below every platform's floor here, so no campaign can run. Spending the month's number in a short flight (for example $5 a day for ten days on Meta) would let ads run and learn. It changes how money is spent, so it waits for your word.
- **Vision review of videos.** Video frames and captions are checked by code; the model looks at static images only.
- **A weekly strategist** that names the one binding constraint at the top of the Monday scorecard.
- **A model that proposes websites** for roster agencies the telephone search still misses. The phone search should show how much of the gap remains.
- **The other experiment factors.** Subject style and length still vary by hash while experiments are on.
- **Trial attribution.** Intel's report PDF now carries the prospect's reference on its trial link (`utm_term`), but the Hub does not yet use it to match a trial to its prospect. It still matches by email address or domain.
- **Nursing homes as prospects.** The roster covers home health and hospice only. Intel now labels nursing home county figures, so the rule is ready for later.

## How to tell it is working (check weekly)

- The cold-email bounce rate, and how many addresses were confirmed, accept any address, do not exist, or got no answer (Growth → Send guard).
- Roster agencies resolved per day, and how many by telephone (`byPhone` on the roster runs).
- Briefs written, and the share with a trigger and a cited opening.
- The reader's scores, and replies by score once 20 of each exist (the Monday memo).
- Report opens per first email, and replies to viewers against non-viewers (the Monday memo, arm `viewed`).
- County images made per week and why a week made none (`snapshotsSkipped` on the creative plan runs); image review scores and blocks (Creative screen, and `hub_creative_vision_blocked` in the server log).
- Market report requests from ads (Intel leads with `utm_medium=paid`).

## Limits of this review

- **Production was read, not written.** Nothing was sent, and no live model, mail server, search provider or Intel endpoint was called.
- **What was tested:**
  - Every change passed the Hub's full check (3,566 tests, typecheck, lint, builds) and the growth evaluation.
  - Each database change passed pgTAP, and a new integration script run twice against a local Supabase stack with every migration applied.
  - The existing growth integrations still pass.
  - Intel's change passed its lint, typecheck, test suite (7,726 tests) and build, plus its database tenancy test against a local Postgres.
- **What is not known yet:**
  - How persuasive the briefs and top-model emails are, which will show in the first weeks of replies and report opens.
  - Whether the telephone search raises the 1-in-5 resolution rate.
- **Cost figures** are estimates from current prices and typical token counts.
