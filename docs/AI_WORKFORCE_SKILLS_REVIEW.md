# AI workforce skills review: marketing, sales and retention

Reviewed November 8, 2026 against Hub `main` at `118f2cb` (after the Founders Sale release). This review read the code, prompts and
documents of every agent. It did not read production data, contact anyone or change production. It follows the
[November 3 workforce review](AI_WORKFORCE_REVIEW.md), whose recommendations became [Customer growth](CUSTOMER_GROWTH.md).

**The owner's ask:** make sure every agent has the best skills for its job, and add a new team member who is the best at marketing,
finding and reaching prospective customers, and moving them through the sales cycle to becoming and remaining customers.

**Answer in one paragraph.** The team's guardrails are strong; its selling skills were thin. The Marketing Manager searched the same
query every day (so discovery stopped finding anyone new after day one), searched nationally for a product sold only in Pennsylvania,
could record directories as prospects, scored fit without a rubric, and wrote outreach from a one-paragraph prompt that knew no product
facts and could not mention the free trial or the Founders Sale. And the most important moment in the funnel had no one on it: when a
prospect wrote back, the Concierge offered only "I will follow up personally today" and the owner had to write every sales answer.
This change gives the revenue agents one shared sales playbook, fixes the Marketing Manager's discovery, scoring and writing, and adds
a ninth agent, the **Sales Executive**, who drafts fact-checked answers to every CareBase and Intel prospect for the owner's approval
and sends a weekly pipeline review.

## The team after this change

| Agent | Job | Skill before | What changed |
| --- | --- | --- | --- |
| **Sales Executive** (new) | Answer prospects and move them to a free trial and a paid plan; weekly pipeline review | Did not exist. Prospect replies got a fixed acknowledgment | Drafts answers from the fact sheet and playbook (exact prices, the trial, the Founders Sale, one next step, one qualifying question, objection handling), checked by code, approved by the owner; weekly review of stuck deals, warm prospects and trials at risk |
| Marketing Manager | Find, qualify and first contact prospects | Static search; no fit rubric; prompt without product facts; touches unaware of each other | Daily rotating, Pennsylvania-only CareBase search; directory filter; written fit rubric aligned to qualification; touch plan; fact sheet, playbook and product pages in its prompt; drafts held to the Content Marketer's claim rules and to their own product's prices |
| Account Manager | Onboard, activate, renew and keep customers | Model drafts for customer moments had one-line generic steps | Each customer moment has a play (the trial play explains activating a paid plan, with the Founders Sale applied automatically; support issues come before any upsell) |
| Support Concierge | Triage every message; answer from guides | Correctly cautious, but sales was out of its scope | Hands CareBase and Intel prospects to the Sales Executive after the owner's alert; everything else unchanged |
| Content Marketer | Weekly help article; monthly outreach drafts | Strong: fact sheet, claim validator, curated links | Unchanged; its validator now also guards the Marketing Manager and Sales Executive |
| Growth Manager | No website lead waits | Fit for purpose (alerts and reminders, no model) | Unchanged |
| SEO Analyst | Site health, titles and descriptions | Fit for purpose | Unchanged |
| Chief of Staff | Morning brief, autonomy hand-overs | Fit for purpose; the brief already carries growth counts | Unchanged |
| Platform Engineer | Health and lead form checks | Fit for purpose (no model) | Unchanged |

## Addendum: the Social Media Manager

The owner then asked for the team to run CareMetric's social media for engagement: posts, replies to social requests, the most
appealing ads, and continual evaluation and change. A tenth agent, the **Social Media Manager**, does that for the Facebook Page,
Instagram, the LinkedIn Company Page and the Meta and LinkedIn ad accounts (LinkedIn connects once LinkedIn approves CareMetric's
developer app; until then its posts are drafted for pasting). Its skills:

- **Content craft:** a hook in the first line, one idea per post, useful before promotional, one call to action, a weekly mix of tips,
  capability, engagement questions and at most one offer, and a style for each platform.
- **Learning:** each plan learns from the last four weeks' engagement.
- **Ad copywriting:** distinct angles, written within Meta's personal-attributes policy.
- **Replies:** short, warm and private-first.
- **Evaluation:** a fixed set of rules (`social-rules.1`) that pauses losing ads, refreshes tiring ones and raises a budget only under the
  owner's cap with the owner's approval.

Everything is checked against the same fact-sheet rules. See [Social media](SOCIAL_MEDIA.md).

## Findings

| Priority | Finding | Effect | Change |
| --- | --- | --- | --- |
| P1 | Discovery ran one fixed query per product every day (`playbooks[product].query`) | The same ten results daily; after the first run, no new organizations | `discoveryQuery` walks a segment-by-place grid one step per Eastern day (144 CareBase searches, 120 Intel) |
| P1 | CareBase discovery searched "assisted living personal care operator" with no place | Out-of-state operators, who cannot buy a Pennsylvania Chapter 2600/2800 product, entered the pipeline | Every CareBase query is a Pennsylvania place; the rubric scores out-of-territory organizations below 30 |
| P1 | Search results from directories, listing sites, job boards and government pages became "organizations" | The contact finder could email a directory's info@ address as a cold prospect | `operatorHost` drops them before they are recorded |
| P1 | Prospects' replies and sales inquiries got only a fixed acknowledgment; the Concierge's model is told to write nothing for sales | Speed to a real answer depended entirely on the owner | The Sales Executive drafts the answer, checked by code, for one-click approval |
| P1 | The drafting prompt forbade prices and offers and contained no product facts | Outreach could not mention the 30-day or 14-day free trial or the Founders Sale, the strongest reasons to act now | The fact sheet and playbook are in the prompt; drafts state facts exactly as written and are checked against them |
| P2 | Model drafts were checked for citations, links and identifiers but not claims | A guarantee, a compliance assurance, a competitor or an invented price could reach the owner's queue (and, under cold-email autonomy, a prospect) | Drafts pass `textProblems` (the Content Marketer's rules) and a same-product price check |
| P2 | Touches 2 and 3 used the same instruction as touch 1 | Repetitive follow-ups, which lower reply rates | Each touch has its own job; the writer is told which touch it is writing |
| P2 | Fit assessment had no rubric while auto-qualification needs fit ≥ 75 | Scores were arbitrary; a plausible directory could qualify | Written bands; only an evidenced, in-territory operator reaches 75 |
| P3 | The growth evaluation recorded the prompt version as its key, which the database pins to `growth.1` | Any prompt change would silently block unapproved sends | `growthEvaluationVersion` keeps the database's key; the prompt version is recorded separately |

## The Sales Executive's skills

- **Where it sits.** After the Concierge alerts the owner about a new message, `private.sales_handoff` decides whether the sender is a
  prospect: a CareBase or Intel website lead or sales inquiry, or a growth contact on file (bound only by signed email) whose
  opportunity is still open. Billing, closed conversations, Advisors, identifiers, unread long messages, cancellations, outages,
  security and legal matters never reach it. Paused or in Observe, it takes nothing and the Concierge behaves as before.
- **How it sells.** Answer the actual question first; quote listed prices exactly (never totals); offer one next step (the free trial,
  or activating a paid plan, with the Founders Sale applied automatically); ask at most one qualifying question; handle price, timing, current-system, switching,
  authority, security, fit, data-trust and results objections the playbook's way; say "not now" gracefully and ask when to check back;
  route negotiations, contracts, security questionnaires, cancellations and opt-outs to the owner.
- **What it may never do.** Send anything itself (the reply executor refuses unapproved replies), state an unlisted price or the other
  product's price, link anywhere but that product's pages or the booking page, promise outcomes, refunds, extensions or special pricing,
  name competitors, quote results, offer a call or demo as a requirement, mention AI, or repeat names from the message.
- **How it reports.** A weekly email: pipeline by stage per product, this week's replies, meetings, trials and new customers, and the
  deals that need the owner now, ranked: expired trials, trials ending without first value, prospects who said yes, overdue and stalled
  conversations, and qualified prospects without a permitted contact.

## What the owner needs to do

1. **Merge, then apply the two migrations** (`20261108180000_sales_executive.sql`, `20261108180100_sales_executive_contract.sql`) through the
   normal migration process and let Railway redeploy. Nothing changes until step 2.
2. **Resume the Sales Executive** on AI team, in Propose, and press Run now on "Weekly pipeline review".
3. **Let prospect text reach the model** to get drafted answers: `HUB_AGENTS_CUSTOMER_TEXT_TO_AI=true` with `ANTHROPIC_API_KEY` (the same
   switch the Concierge's drafted answers use). Without it, prospects still get the acknowledgment.
4. **Keep discovery fed:** `HUB_GROWTH_SEARCH_API_KEY` must be set for the rotating search; review each product policy's approved claim and
   booking URL in Growth.
5. **Connect product events** from the native CareBase and Intel apps (trial started, first value, paid; see
   [Customer growth](CUSTOMER_GROWTH.md#native-product-event-integration)). Without them the review cannot see trials at risk and the
   Account Manager cannot time its plays.

## Owner decisions (November 8)

- **Founders Sale in the trial check-in email: yes.** The fixed trial check-in now states the Founders Sale in its exact terms: 50% off
  eligible subscription charges for the first 12 months of paid service, applied on its own when the trial converts, with no code
  needed. Billing applies the coupon automatically at checkout and conversion (#152).
- **No demos.** Every agent sells self-serve: walkthrough pages, matching help-center guides and manuals, the free trial and written
  answers; none offers a call or a meeting. The Sales Executive can be handed "Sales answers" to answer prospects on its own.
- **Cold email: approved.** It was already automatic in production (Nov 5), but discovery has never run: `HUB_GROWTH_SEARCH_API_KEY` is
  not set, so no business has been found to write to. Setting it starts the daily discovery.
- **Confirm the GTM facts** still marked "owner to confirm": a PDF of the fact sheet was sent for review.
- **Widen autonomy only on evidence:** review a few weeks of Sales Executive drafts (edit rate, objections, replies, trials started) before
  considering any hand-over. This change adds no autonomy step for it.

## Verification and limits

- `npm run check` passed: the docs check, types, lint, 2,750 application tests and 24 SDK tests, the SDK build and the app build. The 43
  new tests cover the Sales Executive (24: checks, prompt, replies, review, registration), the playbook (7), research filtering (3),
  drafting (3), discovery rotation (1) and the Concierge's hand-off (5). `npm run evaluate:growth` passed 22 cases per product.
- The pgTAP test (`072_sales_executive.test.sql`), the server-role integration test (`server/agents-sales-integration.mjs`, added to CI)
  and the contract replay were written for CI's local Supabase stack; they were not run in the authoring environment, which has no
  Docker.
- No live model was called. Guardrail tests prove what a draft may not say, not how persuasive the drafts are. Judge that from the first
  reviewed drafts and from replies, trials and paid conversions per product.
