# AI workforce review: smarter research, better outreach, ads that run

Reviewed November 15, 2026 against Hub `main` at `55cc6bf` and Intel `main` at `0b7acf0`, with read-only production counts
for the seven days to November 15 (agents, runs, tasks, actions, the growth pipeline, leads, creative assets and settings; no
message text, address or name was read). It follows the [November 12 review](AI_WORKFORCE_REVIEW_2026-11-12.md) and the
[November 13 build-out](AI_WORKFORCE_REVIEW_2026-11-13.md).

**The owner's ask:** make the team much smarter at researching prospects, better at outreach and marketing, and more creative with
ads, to win the first customers.

**Answer in one paragraph.** The team is not short of agents, budget or creativity. It spent **$4.85 on the model in seven days**
against about $20 a day of budget. The Creative Director's prompts are good, and **32 ads are approved but none is running**. What
holds the funnel back is plumbing and aim. The Medicare roster has returned nothing for a week. **60 of the 85 agencies scored as
strong fits have no email address.** Fourteen drafts are waiting for your approval. Every email is written the same way, so nothing
can be learned. The research budget goes to borderline prospects, and the agencies actually being emailed get none. The fixes below
come in two parts: owner actions that take minutes, and code changes that put research where it pays.

## What production shows (seven days to November 15)

| Measure | Value | Reading |
| --- | --- | --- |
| Model spend | $4.85 in total ($3.60 Marketing Manager, $1.03 Creative Director) | About 3% of budget. Money is not the limit |
| Agencies found | 174 (Intel: 85 at fit 75 or more, 2 at 30–59, 56 below 30) | Discovery works; about half of what it finds is not a fit |
| Strong fits with an address | 25 of 85 (41 role addresses and 3 named people in total) | **The main research bottleneck.** 60 strong fits cannot be reached |
| Medicare roster | 101 runs, all `roster_not_loaded`; 0 roster targets | Intel reports no Provider of Services quarter loaded. The best prospect source is dark |
| Deep research | 15 prospects ever; "nothing to research" today | Only fit 30–74 is eligible, and that queue is empty |
| Drafts | 25 written, all model-generated; **14 waiting on you** (3 to 45 hours old) | Approval is the current send limit, not the 10-a-day cap |
| Delivered | 11 (1 bounce), 0 replies | Too few to judge the writing |
| Experiments | Off for Intel; all 25 drafts in one arm (`control`, trigger `web`) | Monday's learning memo will have nothing to compare |
| Evidence a draft sees | About 4 web snippets per agency; 0 CMS records | Every opening line comes from a search snippet |
| Creative | 36 assets: 32 approved, 2 proposed, **0 live, 0 with results** | The weekly learning loop has no data to learn from |
| Paid ads | $50 a month allowed for new campaigns | Too little to learn anything inside a month |
| Social | LinkedIn token invalid (plan); inbox refused `linkedin_permission` (today); 2 failed posts | LinkedIn is where Intel's buyers are, and it is disconnected |
| Website leads | 5 real (3 county reports, 2 trial sign-ups), 2 this week, **none with a UTM tag** | Nothing yet traces back to outreach or ads |
| Analytics | Intel's Google Analytics property is not set in the Hub (CareBase's is) | The scorecard cannot see Intel site visits from emails or ads |

## Fix this week: owner actions, no code

1. **Clear the 14 waiting drafts** on Growth, today. Nothing is sent until you decide. Note the reason for each one you turn down: those
   notes feed the learning memo.
2. **Load the CMS Provider of Services file in Intel** (Data Center, reference dataset `cms_pos`). The Hub's roster asks Intel for
   every Medicare-certified home health agency and hospice in Pennsylvania. Intel answers that no quarter is loaded
   (`hubMarketingFeed.ts`, `latestRosterPeriod`). Loading it adds every Pennsylvania agency, each with its CMS telephone number for
   matching its website. It also starts the strongest triggers in the playbook: newly certified and new owner.
3. **Turn on experiments for Intel** (Growth → CareMetric Intel policy → experiments). Without them every draft leads the same way, and
   the learning memo cannot tell what works.
4. **Set Intel's Google Analytics property** (Settings → Analytics). Without it, visits from email and ad tags cannot be counted.
5. **Reconnect LinkedIn** (Settings → Social media). Both the Page token and the inbox permission are failing.
6. **Put real money behind the approved ads.** $50 a month buys a few days of one LinkedIn campaign. A test that can teach anything
   needs about $15–25 a day for two to three weeks, split between LinkedIn (company and title targeting) and Meta retargeting. Raise
   "Most to spend on new campaigns a month" and add the first ad to each draft campaign from the approved creative.

## Make the team smarter: code changes, in order of payoff

### 1. Research the agencies you are about to email, for the opening line

`private.growth_research_next` picks only prospects with fit unknown or 30–74, so research is used to decide **whether** to write, never
**what** to write. The 25 agencies emailed so far got nothing beyond a few search snippets. The research prompt
(`server/growth/deep-research.mjs`, `researchSystem`) also asks only fit questions.

- Research every qualified Intel prospect once before touch 1, and again before a re-ask.
- Add a "what changed" brief: a new branch or county, a new service line, a new administrator or director of business development
  named on the agency's own site, a recent award or accreditation, news, and referral partners it names. Each item is dated and tied to
  a source address, as now.
- Let the draft open on the freshest dated fact. Today a draft opens on whatever the search snippet said.
- For touch 1 to a prospect at fit 85 or more, write with the quality tier (Opus 5.5). At about 5 cents a draft, this is negligible next
  to the value of one reply.

Cost: 25 prospects a week at the existing 30-cent ceiling is about $7.50 a week.

### 2. Keep hiring signals instead of throwing them away

The playbook's strongest buying signal is "hiring marketers, community liaisons or business development staff". Discovery already
searches `hospice "community liaison"`. But `operatorHost` drops every job-board result before it is recorded
(`server/growth/research.mjs:49`: Indeed, ZipRecruiter, Glassdoor, Workday and others). `keptFacts` drops the same hosts from deep
research. A posting such as "Community Liaison, [agency], Pittsburgh" is discarded.

- Read job-board results as **trigger evidence about the employer**, never as the prospect. Match the employer's name to its own domain
  (the roster's telephone-and-place check can be reused), then record "is hiring a community liaison (posted <date>)" as dated
  evidence.
- Add job-search segments to the Intel discovery grid: liaison, hospice marketer, director of business development, and home health
  sales representative.
- In the fit rubric, an agency hiring for a marketing role gets the trigger bonus. The email may say "as you build out your liaison
  team", which is true, public and timely.

### 3. Offer the free agency market review

Intel already has its most personal lead magnet: `/market-review`. It shows an agency's Medicare share and rank in its own county and
state, its county's largest agencies and its public ratings, emailed as a PDF. **No Hub agent can link to it**, because it is missing
from `productPages` (`server/agents/content/facts.mjs`). The outreach, the Sales Executive, the social posts and every ad send people
to the trial or the county report instead.

- Add `/market-review` to `productPages`, to the Intel playbook's `pages` and to the creative landing pages.
- Make it touch 2's offer and the main call to action for LinkedIn ads.
- In Intel, let `/market-review?ccn=` (or, better, a signed token from the Hub) prefill the agency. One click then opens the agency's own
  review.
- The email still never states the agency's rank or scores, which keeps the current rule. The reader chooses to see them.

### 4. Ask for less in the first email

Touch 1 ends with "start a free trial". That asks a stranger for a sign-up from a cold email. Add an experiment arm whose touch 1 asks
for a one-word reply instead: "Reply 'review' and I'll send your county's market picture", or the one-click market review. The Sales
Executive already answers replies; give it a play that sends the review link. Compare reply and trial rates by arm. That needs item
3 of the owner list (experiments on).

### 5. Read each draft the way the buyer would

Every check on a draft today is a compliance check: claims, links, numbers and no meetings (`draftProblem` in
`server/growth/draft.mjs`). Nothing asks whether the draft would get a reply.

- Add a short critic pass. The model reads the draft as the persona (an owner or director of business development in that county)
  and scores it 1 to 5 on specificity, relevance and "would I reply". It names the weakest sentence, and a draft below 4 gets one
  rewrite.
- Store the score with the message, so the Monday memo can test whether high-scoring drafts really earn more replies.

Cost: about 1 cent a draft on the fast tier.

### 6. Reach the 60 strong fits with no address

- **LinkedIn company targeting.** Each week, export "qualified, no address" plus the roster to a LinkedIn company list, and run the
  market-review ad at those agencies only. The Growth roster panel can already download the file; the step is to make it automatic and
  attach it to the monthly LinkedIn campaign. LinkedIn will not serve a company list until a few hundred companies match, so this needs
  the Medicare roster loaded first.
- **More address checks.** "Most address checks a day" is 10. Raise it to 25 while bounces stay under 2%.
- **The agency's website contact form** is a channel no rule covers yet. It needs your decision before any agent uses it.

### 7. Choose the angle from the agency's signal, not a coin flip

With experiments on, `messageArms` picks the lead angle by a hash of the organization's id. Once the roster loads, the Hub already
receives research-only facts from Intel (new owner, newly certified, size, HHVBP, the Hospice Care Index). It uses them only to rank.
Use them to choose the angle as well:

| Agency's signal | Lead angle |
| --- | --- |
| Newly certified or new owner | `referral_sources` |
| Opened a branch or entered a county | `territory` |
| A crowded county | `competitors` |
| An established agency | `slipping_sources` or `hospital_outcomes` |

Keep the hash only as the control arm. The draft still never states the score, which keeps the current rule.

### 8. Point creative at the offers that convert

The Creative Director's craft is strong. It drafts five headlines and keeps the best, writes with direct-response discipline and checks
every claim. What it lacks is a strong offer and results to learn from.

- Make **"See your agency's Medicare market share in your county, free"** (the market review) a standing brief, alongside the county
  snapshots. A specific, personal offer beats a generic trial ad.
- Once items 3 and 6 of the owner list are done, results will join by `utm_content`, and the weekly learnings will finally have data.

## What I would not do

- **Do not raise the cold-email cap yet.** Ten a day has never been reached. Approvals and missing addresses are the limits.
- **Do not add more agents.** Eleven agents spent $4.85 in a week. The work is aiming the existing ones and connecting what is
  disconnected.
- **Do not loosen "never state an agency's own ratings, scores or rank" in emails.** Use those facts to choose whom to write to, when,
  and with which angle. The reader's market review shows them.

## How to tell it is working (check weekly, by product)

- Strong fits with a permitted address (today 25 of 85).
- Drafts decided within 24 hours.
- Reply rate by experiment arm.
- Market-review and county-report requests carrying an outreach or ad tag (today none).
- Trials with a source tag.
- Ad cost per market-review request.

Set targets after two weeks of baseline.

## Limits of this review

Production was read, not written, and nothing was sent. Eleven delivered emails are too few to judge the writing; the draft quality
claims above come from reading the prompts and checks, not from reply data. The 19 ad sets the daily ad review sees, and why it skipped
18 recommendations, were not investigated. Intel's production database was not queried directly. The roster finding rests on the
answer Intel's feed returned (`period: null`): either the Provider of Services reference file has not been loaded, or its home health
and hospice rows are stored under categories the feed's query does not match.
