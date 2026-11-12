# AI workforce review: getting the first customers

Reviewed November 12, 2026 against Hub `main` at `488787e` and read-only production counts taken the same day (agents, runs, tasks,
actions, the growth pipeline, leads and the billing mirror; no message text, address or name was read). It follows the
[November 3](AI_WORKFORCE_REVIEW.md) and [November 8](AI_WORKFORCE_SKILLS_REVIEW.md) reviews.

**The owner's ask:** make the team as productive, profitable and creative as it can be at winning and keeping customers, and amplify
the creative and marketing agents now, because the company has no customers yet.

**Answer in one paragraph.** All eleven agents are switched on and almost every kind of work is handed over, but the team is close
to idle: it spent 87 cents on the model in seven days against about $20 a day of budget, and in four days of prospecting it found 23
organizations, most of them directories, and sent one cold email. Nothing has replied, no real lead has come in, and no product
events reach the Hub. Money and autonomy are not the constraint; the top of the funnel is. This change raises prospecting volume
roughly tenfold, lets fit be judged from each prospect's own website, fixes two faults that would have thrown away the first replies,
and removes several stalls in content, social and ads. The cold-email cap (ten a day, in the database) and the missing inbound path
are now the next limits; both need an owner decision.

## What production shows (November 12)

| Measure | Value | Reading |
| --- | --- | --- |
| Agents active | 11 of 11; 7 on Act | Autonomy is not the constraint |
| Model spend, 7 days | $0.87 in total | Budgets (about $20 a day) are almost unused |
| Organizations discovered | 23 in four daily runs | One search a day, ten results |
| Intel prospects by fit | 2 at 75 or more; 3 at 72; 12 below 60 | At least 6 of 18 are directories or lookups that passed the filter |
| Role addresses found | 7 | Only one of the two qualified prospects has one |
| Cold emails delivered | 1 (November 8) | The cap of 10 a day has never been reached |
| Replies, trials from outreach | 0 | The Sales Executive has never run |
| Real website leads | 3 county reports from one address | No inbound demand yet |
| Product activity events | 0 | Activation and retention plays cannot see usage |
| Billing mirror | 1 active subscription, 1 cancelled trial | No external paying customer |
| Creative assets approved | 22 images, 6 videos (November 12) | Supply already exceeds the week's post slots |

## What this change does

| Agent | Change | Why |
| --- | --- | --- |
| Marketing Manager | Six searches a day per marketed product, twenty results each, over a 624-search Intel grid (six segments by 104 markets) that pages forward on each pass | One search of ten results a day found about five organizations |
| Marketing Manager | Directory filter extended (the five that leaked in production, provider-number and company lookups, trade press, marketplaces, and hosts that name themselves a directory, listing, review or jobs site) | A third of the pipeline was not an operator |
| Marketing Manager | The contact finder reads 20 businesses per daily run, four at a time, plus four on every fifteen-minute sweep, across six pages instead of four | Ten a day could not keep up with discovery |
| Marketing Manager | The finder keeps a summary of each home page as dated evidence | Fit was scored from search snippets only; three prospects sat at 72 waiting for facts their own site states |
| Marketing Manager | Own-site research raised from three to ten prospects a day, two contact-ready for each other | Prospects below the threshold waited days for more evidence |
| Marketing Manager | A sweep assesses at most 20 prospects, stops model work after 150 seconds, and does not re-buy a failed assessment or draft for six hours | A failed draft was retried every 15 minutes at about 3 cents; one stuck prospect could spend the day's $3 and block all sending |
| Marketing Manager | Growth emails say "Opt out of these emails" at `/api/growth/preferences/…` | The database reads "unsubscribe" anywhere in a reply as a request to stop: a prospect who replied with the original quoted was opted out and suppressed |
| Support Concierge | Billing and cancellation are judged from the sender's own words, not the quoted original | Intel outreach says "no credit card"; a quoted reply was filed as billing and never reached the Sales Executive |
| Content Marketer | Ten more Intel topics (13 in all), written Tuesdays and Fridays | Three topics lasted three weeks, then the task skipped silently; a missed Tuesday lost the week |
| Social Media Manager | 4 Facebook, 3 Instagram and 4 LinkedIn posts a week (was 3, 2, 3) | More reach on the two pages buyers read at work |
| Social Media Manager | The daily ad review finishes once it has proposed | An undecided budget proposal stopped the review, and the pausing of losing ads, for up to seven days |
| Social Media Manager and Creative Director | LinkedIn ads are checked against LinkedIn's 70-character headline and description | Creative written to LinkedIn's length was silently dropped by Meta's 40-character check |

Nothing here sends more than the database already allows: the cap of ten cold emails a day, the 72-hour gap, three touches, the
qualification threshold of 75 and every claim check are unchanged.

## What the owner needs to do

1. **Decide the cold-email cap.** Ten a day across both products is written into `private.growth_claim_message`. With follow-ups
   counted, that is three or four new businesses a day. Once the first week at ten shows bounces under 2% and no complaints, a
   migration should make the cap a Hub setting and raise it in steps (25, then 50). Confirm the separate growth sender
   (Settings → Email → "Growth email sender") is set first, so prospecting cannot harm the support address's reputation.
2. **Check the search plan.** Discovery now makes up to 16 search calls a day (about 500 a month). Confirm the Brave plan behind
   `HUB_GROWTH_SEARCH_API_KEY` allows it.
3. **Connect an ad account and set a budget.** With no customers and no audience, organic posts will not produce trials soon. The
   28 approved creatives are ready; a small daily budget on LinkedIn and Meta pointed at the free county report is the fastest
   inbound path the team can already run.
4. **Connect Intel's product events** (trial started, first value, paid). Without them nobody is told when a prospect starts a
   trial, and the Account Manager cannot time a single play.
5. **Read the first drafts.** Open Growth after the first full day and read what the Marketing Manager wrote. Persuasiveness cannot
   be tested without real drafts.

## Findings not fixed here, in priority order

Each needs a database migration or an owner decision, so none is in this change.

| Priority | Finding | Effect |
| --- | --- | --- |
| P0 | `private.growth_inquiry` reads quoted text. The footer change above stops new emails from triggering it, but "not really interested" still reads as a positive reply, and a reply from another mailbox at the same business is not linked at all | Touches 2 and 3 keep going to a business that already answered |
| P0 | A prospect who starts a trial is not linked to its opportunity; billing creates a second organization | Cold follow-ups can reach someone already in a trial, and outreach can never be credited with a trial |
| P1 | Inbound leads (county reports, newsletter sign-ups) are counted, never followed up; a trial sign-up gets an owner alert that says nothing was sent | The warmest contacts the company has get no email |
| P1 | No follow-up after a reply or after touch 3; `nurture` is a dead end | "Not now" is never asked again |
| P1 | One discovery source. Every Medicare-certified home health and hospice agency is in the public CMS provider data the fact sheet already cites | A complete, county-tagged target list exists and is not used |
| P1 | Draft checks reject ordinary specifics: any number not on the fact sheet ("12 counties", "two locations"), and the words "solution" or "journey" even inside a prospect's own name | Personalized openings are the ones most often thrown away; rejection reasons are not stored, so the rate is unknown |
| P1 | No repair pass: a draft that fails one check is discarded, not corrected | Each failure costs a full attempt |
| P2 | Nothing learns from outcomes: rejection notes, reply types and the Sales Executive's reading of objections reach no prompt; the only experiment varies length | The team cannot get better at what works |
| P2 | Customers who arrive through billing have no contact on file, so no success email can be drafted for them; no churn-save, dunning or win-back exists | Retention plays are owner to-dos until this is built |
| P2 | Autonomy steps graduate on the calendar, not on evidence; cold email went automatic before discovery had ever run | Hand-over does not mean the work was ever reviewed |
| P2 | The scheduler runs three tasks per tick and waits for all three; the Chief of Staff reports counts but not an idle agent or a blocked funnel | A week of near-zero output raised no alert |
| P3 | Story-format images are made and approved but no publisher uses them; the SEO Analyst's suggestions are copied by hand; social posts cannot link to a new article | Work is produced and not used |

## Verification and limits

- `npm run check` passed with CI's settings (`VITE_DEMO_MODE=true`, `SUPPORT_HUB_ALLOW_DEMO_BUILD=true`): the docs check, types,
  lint, 3,260 application tests in 286 files, 24 SDK tests, the SDK build and the app build. `npm run evaluate:growth` passed 29 cases
  per product. New and changed tests cover discovery volume, paging and pacing, the
  directory filter, the contact finder's home page summary, sweep limits and back-off, the opt-out wording and address, quoted
  replies, the article schedule and backlog, the ad review's status and LinkedIn ad lengths.
- No live model, search provider or website was called, and nothing was sent. How many organizations six searches a day really
  yield, how many publish a role address, and how persuasive the drafts are will only be known from the first days in production.
- Production was read, not written. The counts above are one day's snapshot of a system four days into prospecting.
- The retention findings were traced in code, not exercised against a database.
