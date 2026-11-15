# CareBase and CareMetric Intel customer growth

The Growth workspace at `/admin/growth` adds a Marketing Manager and customer-success work for the Account Manager. **Breathe is deferred.** This implements the Hub-side workflows from [the workforce review](AI_WORKFORCE_REVIEW.md). It does not claim that code deployment alone acquires or retains customers.

## What is implemented

| Review recommendation | Implementation |
| --- | --- |
| Prospect research and qualification | Scheduled or owner-requested public business research, dated sources, model-assisted fit rationale, separate observed intent, manual contact verification and lifecycle qualification |
| Persistent shared customer history | One organization and contact across product opportunities; goals, promises, blockers, objections, loss reasons, owner and dated next action |
| Marketing outreach | Versioned product claims, evidence-backed drafts, individual model-message approval, a maximum of three touches, shared contact frequency across growth and native lifecycle emails, and per-product daily limits |
| Reply and cancellation handling | Signed email webhook ingestion correlates a known sender, classifies simple response signals, stops both product sequences and creates a follow-up/recovery task; complete conversations remain in Communications. Growth capture can never lose an email: if it fails (for example a sender domain the growth records cannot hold) or the growth lock stays busy past a 3-second lock timeout, the message is still saved; for a sender who is already a growth contact, an unsubscribe request is still honoured and unsent outreach is still cancelled; and a `growth.inquiry_failed` audit row records the message and error codes only. The growth lock is held until the inbox commits, so a send claim queued behind a reply always sees it |
| Conversion handoff | Scoped, signed and deduplicated product events transfer trial/customer work to the Account Manager without accepting clinical records |
| Onboarding and retention | First-step onboarding, 48-hour activation check, trial deadlines, adoption recovery with fresh telemetry, support coordination, cancellation recovery, renewal and demonstrated expansion interest |
| Trustworthy health | Missing/stale/billing-only evidence is separate from adoption; stopped/dropped use requires attention; complete account pagination precedes report ranking |
| Threaded support | With the existing customer-text-to-AI switch (Settings → AI team → "Let agents send customer messages to the AI") enabled, ordinary follow-up questions use up to two scrubbed prior messages, fresh product guides and individual review; prior identifiers or sensitive categories abstain |
| Better retrieval | Product/audience filtering, revision metadata, relevant sections from full guide bodies, and a bounded stale cache |
| Search and content | Weekly source-backed product content briefs in the approval queue, campaign identifiers and native signup source attribution; publishing remains in the existing authoring workflow |
| Stronger operations | Weekly SEO catch-up, overdue work in the Chief of Staff brief, shared database model-budget reservations, unknown-delivery reconciliation and external availability monitoring |
| Learning and measurement | Optional stable standard/concise message groups, recorded approvals/rejections, product/cohort replies, meetings, trials, activation, paid conversion, mature 30/60/90-day retention, delivery outcomes and repeatable behavioral evaluation |

The weekly account report combines native activity and usage reports per product and metric, keeping the newest valid observation when both cover the same metric. Telemetry gaps are counted separately from financial health bands. The Growth preview refuses backend reads and mutations.

The existing Billing and weekly account report remain the source of MRR/ARR. The Growth screen reports observed outcomes, not predicted churn or invented attribution. Revenue expansion, acquisition cost allocation, search-demand performance and campaign effectiveness need measured production data before targets or automatic promotion are justified.

## Apply and configure

1. Apply `20261103150101_customer_growth.sql`, then `20261103150102_customer_growth_contract.sql` through the normal migration process. The second migration verifies private tables, RPC authority and prerequisites before declaring `platform.agents.customer-growth.v1`. Existing agent settings are preserved; the new Marketing Manager starts paused in Propose mode.
2. Deploy the server and frontend together. The server registers growth handlers only when the database advertises the feature. Keys and tokens are Railway variables (`.env.example` has their names); every switch and address below is on the Hub's Settings page (see [Settings](SETTINGS.md)). These replaced Railway variables such as `HUB_GROWTH_SEND_ENABLED`, which the Hub copies into Settings once on its first start after the settings migration and which can then be deleted. No secret is sent to the browser.
3. In Railway, set a stable `HUB_GROWTH_SIGNING_KEY` (at least 32 random characters), distinct CareBase/Intel event keys, the HTTPS public origin and the existing mail API key. In the Hub's Settings → Email, check that "Support sender" is a verified SendGrid sender and fill in "Mailing address in email footers". Keep the signing key stable so existing unsubscribe links continue working.
4. Choose the products the team markets under **Products we market** on the AI team page. Intel starts switched on and CareBase off
   while it is in its pilot (see "What the team markets" in [AI_TEAM.md](AI_TEAM.md)): discovery, scoring, plans and cold email skip
   every product switched off, from their next run, and customers' onboarding and support are unaffected.
5. For automatic discovery, configure `HUB_GROWTH_SEARCH_API_KEY` for Brave Search. The adapter requests bounded public search results; snippets are unverified evidence. It does not invent emails. Owner-supplied source evidence works without this provider. Intel's tenant-owned provider lists and campaigns are not imported into CareMetric's sales audience.
6. Configure the signed SendGrid Event Webhook at `/api/growth/delivery` and set `HUB_SENDGRID_EVENT_PUBLIC_KEY`. Subscribe to delivery, bounce, dropped, spam report and unsubscribe events. Keep the existing signed Inbound Parse route for replies; the growth sender's Reply-To points to the configured support inbox.
7. In Growth, map existing tenants to their organizations and classify internal accounts. Add the correct buyer/champion, verify its business source and outreach eligibility, record the goal, and qualify the opportunity. Review each product benefit in its policy (there is no booking link: CareMetric does no demos, calls or meetings). Policies start disabled.
8. Resume Marketing Manager and Account Manager in **Propose** mode for the pilot. The scheduler also needs Settings → AI team → "Run the AI team" switched on. Switch on Settings → Customer growth → "Send growth email" only when the configured channel and reviewed cohort are ready. Approve exact messages in Team; changing policy, contact, or opportunity invalidates stale drafts.
9. Review pilot replies, objections, activation and retention separately for each product. Optional template autonomy needs an active agent in Act mode, an enabled product policy with template sending allowed, and a passing `growth.1` behavioral evaluation recorded in the last 30 days. **Model-written messages require individual approval** unless the owner hands sales follow-ups or cold email over (next section). The latest failed evaluation blocks every message nobody approved.

`npm run evaluate:growth` runs synthetic cases. Supplying `HUB_GROWTH_EVAL_DATABASE_URL` explicitly records those results through the restricted `hub_app_server` role. Leave it unset for local/CI evaluation. A behavioral pass proves guardrail behavior; it does not validate a model's persuasion or factual accuracy on unseen prospects. Review real draft quality before increasing volume.

## Sales follow-ups and capped cold email

The owner chose (2026-11-04) to let the Marketing Manager send two kinds of email on its own, each after one supervised week:
**Sales follow-ups** (outreach and follow-ups to people who contacted CareMetric or that the owner added) and **Cold email**
(first emails to businesses found online). Both are autonomy steps on the Team screen and start off
(`20261105150000_growth_autonomy.sql`, gate `20261105150100_growth_autonomy_contract.sql`, feature
`platform.agents.growth-autonomy.v1`). Each step adds one trust value to the Marketing Manager's list
(`growth.sales_followup`, `growth.cold_email`); a supervised week or Keep approving takes it off, and every message then waits for
the owner, model-written or not.

- **How a growth email looks.** A letter, not a newsletter (`growthEmail` in `server/growth/worker.mjs`): left-aligned and
  without images, so it reads like an email a person typed and is not filed as a promotion. It is in the theme of the
  product's app: an Intel letter is the Intel app's own dark Emberline letter, with the ember accent on its links. It opens with "Hello,", then
  the approved words (the product's own pages are clickable links, nothing else is), then the sign-off with the product's
  website: prospect outreach is the founder's own letter, signed "Dr. Kevin C. Deyarmin, Founder, CareMetric" (owner direction
  2026-11-12), and a customer message is signed by the product's team ("The CareMetric Intel team"), and a small footer with the company, its postal address and the opt-out
  link ("Opt out of these emails", at `/api/growth/preferences/<token>`; the footer and the address avoid the word "unsubscribe" because
  until 2026-11-13 the database read that word anywhere in a reply, quoted text included, as a request to stop, so a prospect who
  replied with the original quoted underneath was opted out by their own quote; replies are now read from the sender's own words,
  see [How replies are read](#how-replies-are-read). The old `/api/growth/unsubscribe/<token>` address still works). The inbox preview is the message's first sentence. The writing rules (`growth.5`) ask for a specific, true opening
  about the organization from its public sources, one likely problem as a question, one concrete way the product helps, and
  one easy next step with its link, in short paragraphs.
- **Contact finder.** After the daily discovery search, the finder reads each new business's own website: https only, its
  domain or `www.` name only (redirects included), robots.txt honoured, never an address literal or a name that resolves to a
  private address, at most six pages (`/`, `/contact`, `/contact-us`, `/about`, `/about-us`, `/contactus`) of 300 KB each, stopping at the
  first that shows a role address (`server/growth/contacts.mjs`). The daily run reads up to 20 businesses, four at a time, and each
  fifteen-minute pipeline sweep reads four more, so a day's discoveries are all read the same day. The finder also keeps a short
  summary of each home page (its title, its description and the start of its text, at most 1,200 characters, dropped if it seems to
  hold a personal identifier) as dated evidence of what the business says it is, so fit is judged from the business's own words and
  not only from a search snippet.
  It keeps one **role address** on that exact domain (`info@`, `contact@`, `office@`, `hello@`, `inquiries@`, `admissions@`,
  `sales@` and a few more); the database admits nothing else as a found contact (`growth_contacts.source_kind = 'role_address'`)
  and refuses one on another domain, one found off the business's site, or one that unsubscribed. A personal address is never
  kept, and no phone number is ever read or texted. A business with none is not read again for 90 days. Only the address and
  the page it was on are stored.
- **Qualification.** Researched prospects whose fresh, cited assessment meets the active rules (`private.growth_qualification_rules`,
  `qualify.1`: fit 75 or more, assessed and evidenced within 30 days, a permitted verified contact that has not unsubscribed,
  not a customer or internal, no "not now" or "not interested") move to qualified before each pipeline sweep. The rule version
  is recorded on the opportunity.
- **Sending on its own.** A message is approved on its own only when the Marketing Manager is active, on Act and trusted with the
  message's class, and the send claim checks that again with the agent's row held, so Keep approving or a pause can never slip
  in between. A message nobody approved also needs a passing `growth.1` evaluation from the last 30 days; the
  `growth.evaluate` task records one for each product every morning at 06:40 Eastern and warns the owner if it fails.
- **Cold email caps.** A cap on cold emails per Eastern day across both products, however each was approved: ten, unless you set
  Settings → Customer growth → "Most cold emails a day" (1 to 100; `20261112120000_growth_cold_email_cap.sql`). Follow-up touches
  count toward it, and so does every copy of a touch to another decision-maker at the business; each product's own daily limit on
  the Growth page still applies beneath it. One business is contacted once (one opportunity and one sequence, up to the policy's
  touch cap, to its contact and to the other decision-makers there you permitted, see
  [Several decision-makers at one organization](#several-decision-makers-at-one-organization)); a customer's organization is never cold-emailed;
  cold email never rides the product policy's template autonomy. Every email carries the unsubscribe link and the postal
  address, and the existing per-contact gap, suppression list, touch cap and per-product daily limit still apply.
- **Product policies** no longer overwrite the agents' lists: turning template sending on adds `growth.message`, turning it off
  everywhere removes only that value.

Nothing is sent until "Send growth email" is on in Settings → Customer growth, a signing key is set and an enabled product
policy is in place, and the finder
runs only with `HUB_GROWTH_SEARCH_API_KEY`. A counsel check of cold email to businesses' public addresses was recommended to the
owner before enabling it. `npm run test:growth-autonomy:db` runs the integration checks against a disposable local database.

### How replies are read

An email that reaches the support inbox from a growth contact (`private.growth_inquiry`, run by the inbox's own trigger) is read
from the sender's own words only (`private.growth_reply_reading`, 2026-11-13):

- **Left out:** lines quoted with ">", the "On <date>, <sender> wrote:" line, a growth email's opt-out line with its link (either
  wording; the same words without the link are the sender's own and a request to stop), and links
  and addresses. Reading stops where a mail program puts the original under a header without marking it (Outlook's
  "From: / Sent:", "-----Original Message-----", a forward) and at a "wrote:" line whose quote is not marked (an HTML-only email).
  Answers written between quoted lines are read.
- **Kinds,** in this order: a cancellation ("cancel my account", not "cancel tomorrow's call" or "I don't want to cancel"), a
  refusal ("not really interested", "no longer interested", "no thank you", "not a good fit", "we'll pass"), not now ("not right
  now", "next quarter", "after the holidays", "circle back in"), interest ("interested", a demo, pricing, "send me more"), else a
  plain reply. A refusal negates the interest itself: "we don't currently have a system and are interested" is interest. A
  refusal or "not now" moves the business to nurture; any reply stops the cold sequence to everyone there.
- **A request to stop** ("unsubscribe", "opt me out", "take me off", "stop sending", "do not email", "remove me") opts the sender
  out and adds the address to the suppression list; "I don't want to unsubscribe" is not one.
- **A colleague** writing from the domain of a business growth email has reached (a message accepted or delivered to one of its
  contacts) joins that business as a contact for review, and the reply counts as the business's reply; a sales inquiry from them
  still opens an opportunity for the inbox's product. Personal mail domains
  (Gmail, Outlook, Yahoo, iCloud, Comcast and the like) never link a sender to a business.

When capture fails, the inbox keeps the email and its fallback still honours a request to stop by the same reading.

## A separate sender for prospecting

Cold email and sales follow-ups (every `growth.message`, whichever step approved it) can come from their own address, so that
complaints, bounces and spam-folder placement from prospecting are scored against that address's domain and never against
support@caremetric.ai, which carries support replies, owner alerts, the Account Manager's customer emails and bulk email. Those
keep coming from the "Support sender" in Settings → Email whatever is set here.

Both settings are in the Hub's Settings → Email:

- "Growth email sender" (optional): the growth sender, on a subdomain of its own, for example `hello@go.caremetric.ai`.
  Empty keeps today's behavior: growth email comes from the support address. The Settings page refuses a value that is not an
  email address; a growth address on the support address's own domain is used but warns in the service log, because it would
  not keep reputation apart.
- "Growth email display name" (optional): the display name, at most 64 characters with no quotes or angle brackets (empty:
  "CareMetric"). The Settings page refuses a name it cannot use.
- **Reply-To does not change.** Growth email still replies to the support inbox ("Reply-To" in Settings → Email, else the support
  address), so a prospect's answer reaches the signed Inbound Parse route, joins Communications and is handed to the Sales
  Executive as before. The unsubscribe link and headers, the postal address and the delivery webhook's message id are the same.

These replaced the `HUB_GROWTH_FROM_EMAIL` and `HUB_GROWTH_FROM_NAME` variables.

What the owner must do before setting it (in this order; none of it is done by the Hub):

1. **Authenticate the subdomain in SendGrid.** Settings → Sender Authentication → Authenticate Your Domain, for the subdomain
   (for example `go.caremetric.ai`), and publish the CNAME records SendGrid gives at the DNS host. They cover SPF (the
   return-path CNAME) and DKIM (`s1`/`s2`); wait until SendGrid reports the domain verified.
2. **Publish DMARC for the subdomain**: a TXT record at `_dmarc.go.caremetric.ai`, starting with monitoring, for example
   `v=DMARC1; p=none; rua=mailto:<a mailbox you read>`, and move to `p=quarantine` once reports show only SendGrid sending.
   Without its own record the subdomain inherits caremetric.ai's policy.
3. **Optionally receive mail at the subdomain.** Replies go to the support inbox, but a person who writes to the From address
   directly reaches nothing unless the subdomain has an MX record to `mx.sendgrid.net` and an Inbound Parse host for it.
4. **Warm the address up slowly.** A new subdomain has no reputation. Keep the cold email cap at ten a day for the first weeks,
   watch bounces, blocks and spam reports in SendGrid's statistics for the subdomain, and raise volume in small steps only
   while they stay low: Settings → Customer growth → "Most cold emails a day" (to 25, then 50), and the product's daily limit on
   the Growth page to match. Bounces above 2% or any spam report mean going back down.
5. Fill in "Growth email sender" (and, if wanted, "Growth email display name") in the Hub's Settings → Email and save; it
   applies within a minute, with no redeploy. Then send one approved message to an address you own to confirm the From, the
   Reply-To and the unsubscribe link.

Nothing in the database changes: no migration is involved.

## The sales playbook (November 8 skills upgrade)

The [workforce skills review](AI_WORKFORCE_SKILLS_REVIEW.md) found the Marketing Manager's method thin: one fixed search per
product, a one-paragraph drafting prompt with no product facts, no sequence plan and no fit rubric. The revenue agents now share
`server/growth/playbook.mjs` (`sales-playbook.1`): per product, the territory, who is and is not a fit, the people involved, the
likely problems and buying triggers to ask about, what may be said, the next step, qualifying questions and how to meet each common
objection; a three-touch outreach plan; and a play for each customer moment. It holds method only: every price, trial, offer and
claim still comes from the fact sheet (`server/agents/content/facts.mjs`, the copy of [GTM facts](GTM_FACTS.md)).

- **Discovery** runs six different segment-and-place searches per marketed product every Eastern day, twenty results each
  (`discoveryQueriesPerDay`; four segments by 36 Pennsylvania places for CareBase, so it never leaves Pennsylvania; six segments by
  104 markets across the country for Intel). No search repeats until the whole grid has been searched; the next pass reads the next
  page of each search. Calls to the search provider are paced a second apart. If a later search fails, the day's searching stops and
  what was found is kept; only a failure of the first search fails the run. Discovery drops directories, listing and review sites,
  provider-number and company-data lookups, trade associations and trade press, social networks, job boards and government or school
  sites, and any host that names itself a directory, a listing, a review or a jobs site, so the contact finder never writes to a
  directory's info@ address. A domain search for one organization is unchanged.
- **Pipeline sweep limits.** A sweep assesses at most 20 prospects, stops starting model calls and website reads 150 seconds after
  it began, and does not ask again for six hours for an assessment or a draft the model could not give or that failed its checks
  (unless the opportunity, its evidence, its contact or the policy changed). The sweep's result counts those drafts as `undrafted`.
- **Fit assessment** (`growth-fit.3`) scores with a written rubric whose bands line up with qualification (`qualify.1`, fit 75 or
  more): only an operator in the product's segment and territory, shown by its own sources, can reach 75; a directory, a vendor or an
  out-of-territory organization stays below 30.
- **Drafting** (`growth.3`) gives the writer the fact sheet and the playbook in the cached system prompt, the touch it is writing
  and that touch's job (1: a likely problem as a question and the free trial; 2: a different angle, a resource or the Founders Sale,
  and one qualifying question; 3: a short close-the-loop), or the play for a customer moment (the trial play explains activating a
  paid plan, with the Founders Sale applied automatically), the organization's name and domain, and the product's own pages it may link to. Every model draft must
  then pass the Content Marketer's claim rules (no unlisted price or number, guarantee, compliance assurance, certification,
  competitor, testimonial, call or demo as a step, "prove" about CareBase), may state only its own product's prices, may link only to
  its product's pages, and has its vocabulary fixed (ALF, surveyor). A draft that fails is dropped. The template
  path used without a model, and every send rule, are unchanged.
- **Campaign tags**: the product pages in every growth message, model-written or template, carry utm_source `caremetric`,
  utm_medium `email` and utm_campaign `growth-<product>-touch<n>` for outreach or `account-<product>-<moment>` for a customer play
  (`server/agents/links.mjs`; no message carries a booking link). The tags are added after the checks and the tagged message is checked
  again; the link check reads a tagged page as that page only when the tags are well formed, so a tag can never carry another host
  or path. The sent email makes the tagged addresses links like the plain ones.
- **Evaluation**: `growth.1` remains the key the database's send claim requires for a recent passing evaluation; it now names the
  guardrail suite, not the prompt (each run records the prompt version). The suite adds cases for an unlisted price, a guarantee, a
  named competitor, product-page links, the other product's page, a tagged product-page link (accepted and given its own tags),
  a tagged link to another host and a tag carrying another address (both rejected), daily discovery rotation and directory filtering.
- The **Sales Executive** (see [AI team](AI_TEAM.md#the-sales-executive)) answers prospects' replies and inquiries from the same
  playbook and sends a weekly pipeline review.

**Selling without demos (owner decision 2026-11-08, `sales-playbook.2`, `growth.3`).** No agent offers or suggests a demo, a sales call
or a meeting. Outreach and customer emails point to the free trial and the product's walkthrough pages and invite a reply by email; the
template path (used without a model) says "You can see how it works and try it free" with the trial link instead of offering a
conversation. The playbook has a "demo" objection for both products: send the walkthrough, the matching guide and the free trial.

**The Founders Sale in the trial check-in.** Billing applies the Founders coupon automatically at checkout and trial conversion (#152),
so every agent says it applies on its own, with no code needed. The Account Manager's trial check-in email states it in its exact
terms (owner decision 2026-11-08).

**Outreach from the founder, easy to read (owner direction 2026-11-12, now `growth.8`).** Prospect outreach is written in the founder's
first person and signed with the founder's name and title (`senderFor` in `server/growth/playbook.mjs`, from `founder` in
`server/agents/content/facts.mjs`). Touch 1 tells the founder's story in one or two sentences, exactly as the fact sheet gives it: the
founder runs a home health and hospice agency and a healthcare consulting company, needed a way to research competitors and find every potential referral source, and built
CareMetric Intel, which the founder uses every day. The story carries no result, agency name or number, and is told only about Intel. For
Intel, the email names the part of the whole workspace that answers the reader's problem, never email campaigns as the point. A draft
with an empty buzzword, a string of fragments or a sentence over 30 words is refused as `unclear` (`unclearCopy`). Customer messages are
still signed by the product's team. To show your own name in the inbox as well, set Settings → Email → Growth email sender.

**No personal demos with anyone (owner decision 2026-11-09, `growth.6`).** No message offers a booking page any more: drafts are
never given one (the policy's old booking link is ignored, and the Growth screen no longer has the field), and the writer is told
never to offer a call, a meeting, a conversation, a chat or a demo, or to ask for a time to talk. Code backs it: `offersMeeting`
(`server/growth/playbook.mjs`) refuses a draft that offers one (`meeting_offer`), while a sentence that declines a demo, or is about
the reader's own meetings, passes. The planner's next steps no longer name a meeting. The guardrail suite adds four cases: a
conversation, a demo or call, and a time to meet are refused; declining a demo is accepted. See
[No demos, calls or meetings](AI_TEAM.md#no-demos-calls-or-meetings).

Changing the playbook's wording changes what the models read: bump `playbookVersion`, run `npm test -- server/growth` and
`npm run evaluate:growth`, and review the next drafts before widening any autonomy.

## The 2026-11-13 additions

The Medicare roster (`growth.roster`), reply reading and website lead follow-up, one re-ask after "not now", named decision-makers
and list imports (`growth.people`), research with web search (`growth.research`) and the weekly "what is working" memo
(`growth.learn`) are described, with their settings and the order to turn them on, in
[AI_WORKFORCE_REVIEW_2026-11-13.md](AI_WORKFORCE_REVIEW_2026-11-13.md). Every draft records the experiment arms it was written under
(`growth_messages.arms`, short codes only) and the memo version it used (`memo_version`), and links carry the arms in `utm_content`.

### The learning memo without "Use this memo" (2026-11-15)

Each Monday's memo used to wait for the owner to choose "Use this memo" on Growth. The autonomy step **Learning memo**
(`learning_memo`, AI team page; it ships held, see [Four more hand-overs](AI_TEAM.md#four-more-hand-overs-owner-decision-2026-11-15))
hands that choice over: while it is automatic, a new memo is used at once (`private.growth_learning_propose`), the product's earlier
memo retires, and the audit row is the one the owner's choice writes (`growth.memo_activated`, with approval `automatic`). A memo
the same as one still waiting is used rather than written again. The memo is still written by code from the team's own counts and the
owner's notes, only while Settings → Customer growth → "Write from what is working" is on, and the Growth screen still shows each one
with its status ("In use", "Replaced").

## Each agency's own market report

Owner decision 2026-11-15: every agency the team writes to gets a free market report of its own. Intel draws the report from public CMS
and Census data, with nothing about any patient:

- the agency's Medicare patients, and its share and rank among the agencies located in its county and its state;
- the county's largest agencies, with the agency highlighted among them;
- the county's demand: beneficiaries, residents aged 65 and over and their growth since 2020, and home health or hospice use;
- the hospitals the county's residents use, and the physicians Intel ranks highest as referral sources;
- the agency's public CMS ratings;
- three moves the figures point to, and the trial with its true terms (a credit card is required to start, and canceling before the
  trial ends avoids any charge).

The link is `https://www.caremetricintel.com/report/<token>`. The Hub signs it (`server/growth/report-link.mjs`) for each CareMetric
Intel prospect whose evidence carries its Medicare roster record, which holds the agency's CCN. The key comes from the marketing feed's
shared secret (`HUB_INTEL_FEED_SECRET`), under a label of its own. Intel verifies the link and serves the PDF (Intel
`server/routes/agencyReport.ts`; protocol in Intel's `docs/HUB_MARKETING_FEED.md`, "Agency report links"). A link lives 150 days. It
names the agency, never a person, and carries the opportunity's id as its reference.

**The first email is built around the report** (owner direction 2026-11-15; `reportTouchAngle` and `reviewTouchAngle` in
`playbook.mjs`, `growth.11`). It goes to the agency's best contact: a named owner, administrator or marketing leader when the team
found one, else the role address.

1. It opens with the founder's story in one or two sentences.
2. It asks two or three questions the reader answers for themselves: is the agency getting its share of the county's referrals, does
   its team know every referral source in its territory, and how well does it know its competitors there.
3. It links the agency's own report and asks them to review it with their managers and marketing team.
4. It asks how much they could grow working from the most current market intelligence, and how Intel sharpens targeted marketing.
5. It ends with the 30-day free trial and its terms in one plain clause: a credit card is required to start, and canceling before the
   trial ends means no charge.

The email may hold three questions and two links, in up to 170 words. "Risk-free" is refused (`guarantee`), as is "no credit card"
(`trial_terms`). An Intel prospect with no roster record gets the same email with the market report page
(`https://www.caremetricintel.com/market-review`, `intel-market-review`) in place of its own link: any agency gets its full report
there by entering its CCN. Later touches follow the sequence plan, and the second may point to the report again. The writer never
states a figure from the report: the reader opens it to see them. CareMetric's own agency (`ownAgencies` in `roster.mjs`) is never a
prospect. The link check accepts that one report link for that one draft, and no other agency's. The report's trial link carries
`utm_content=agency-report`, so the Monday scorecard counts the visits it brings.

## Finding decision-makers and their addresses

The Hub finds the people who decide at its best prospects itself (`growth.people`, every half hour, a few businesses at a time;
owner decision 2026-11-13, replacing Apollo). It needs no paid service and no key.

- **Who**, from three free sources, recorded as people: who the CMS owners file lists as owning or managing the agency (Intel's
  feed), the authorized official on the agency's NPI record (the public NPI registry, matched by the agency's ZIP code and its CMS
  telephone number or name), and the leaders the agency's own website names with a title that decides (owner, administrator,
  executive director, business development). The person written to is the one whose title decides most.
- **Their address**, as far as Settings → Customer growth → Finding people's addresses allows:
  - *Names only: never look for a person's own address*: no address is looked for; outreach goes to the business's public
    address (info@).
  - *Addresses businesses publish on their own websites*: an address on the agency's own domain that its own pages publish and
    that is a usual shape of a named person's name (jdoe@ beside Jane Doe). Free.
  - *Also guess and check addresses with the business's mail server* (the default): otherwise the usual shapes of the person's
    name (jane.doe@, jdoe@, jane@ …, the shape the agency's own addresses follow first, at most six) are asked of the agency's own
    mail server, the way a mail server is asked before a message is delivered, and the conversation ends before anything is sent.
    An address is kept only when the server refuses a made-up mailbox and accepts the guess: a server that accepts everything,
    refuses the Hub, or answers "try later" confirms nothing. Settings → Customer growth → Most address checks a day limits how
    many agencies are checked (10 until you save a number).
- **Every address waits for you** on Growth → Decision-makers to review, which shows how it was found (with the page that publishes
  it) and nothing is sent to it until you permit it. Never a personal address on another domain, never a phone number, never an
  unsubscribed address.
- **Unless you hand it over.** The owner decided on 2026-11-15 to stop reviewing these one by one: the autonomy step **Named
  people's email addresses** (`named_contacts`, AI team page; it ships held, see
  [Four more hand-overs](AI_TEAM.md#four-more-hand-overs-owner-decision-2026-11-15)). While it is automatic, an address the agency
  publishes on its own site, or that its mail server confirmed, is permitted for outreach on its own and becomes the contact of the
  business's opportunities that were never emailed, exactly as **Permit** does, audited as `growth.person_permitted` with approval
  `automatic` (`private.growth_person_address`). What stays the same: a guess nothing confirmed is never kept at all; a list you
  import still waits for you; an unsubscribed address is refused; and an address still waits for you when a contact at the business
  opted out, or the business said "not interested" or "not now". Emailing the person is still cold email: it waits for you unless
  **Cold email** is handed over too, and always counts against "Most cold emails a day".

Checking needs outbound connections to mail servers (port 25), which Railway allows on its Pro plan only. Elsewhere the check finds
every server unreachable, rests for six hours, and the AI team page's "Named decision-makers" row and the Growth screen say so;
choose "Addresses businesses publish on their own websites" to stop trying.

## Several decision-makers at one organization

Owner decision 2026-11-15: the Marketing Manager's cold outreach reaches several decision-makers at the same agency (owner,
administrator, managers and marketing leaders), not one inbox. Each touch to an organization goes to its contact and, as separate
emails, to the other decision-makers there, up to Settings → Customer growth → "Most people to email at one organization" (1 to 5;
three until you save a number, the contact included; 1 turns it off) (`20261115230000_growth_colleagues.sql`, gate
`20261115230100_growth_colleagues_contract.sql`, feature `platform.agents.growth-colleagues.v1`).

- **Separate emails, never CC or BCC.** Each person gets the touch's approved subject and words, the same draft and so the same agency
  report link (it is signed per opportunity), with their own greeting by name, their own opt-out link and their own checks when the
  email is claimed. Nothing new is written by the model: each copy is a message of its own (`growth_messages.primary_message_id` names
  the touch it copies) and goes through every step a message goes through.
- **Who.** People at the same organization other than its contact, permitted by you and verified within 90 days, not unsubscribed,
  with a name or a role: a decision-maker the Hub found (Decision-makers to review) or one on a list you imported. Never a generic
  mailbox (info@, office@, intake@ and the like are only ever a business's contact), and never a person who wrote in or that you typed
  in as a contact: those are sales follow-ups, not cold email. Best first: owner (or founder, president, CEO), administrator (or
  executive director), business development or marketing, then other managers and directors.
- **One sequence per organization.** Touches are still counted on the opportunity: three emails to three people are one touch, and
  the touch cap, the re-ask and the "what is working" counts read touches. Touch 1 goes to the people chosen when it is sent; touch 2
  and every later touch (a re-ask included) go only to the people who received the touch before, so nobody joins a sequence half way.
  The touch's next step and its due date come from the contact's email only. Colleagues get the same touch the same day, a little
  after the contact: the next fifteen-minute sweep records and proposes each one.
- **Every one counts.** Each copy counts toward "Most cold emails a day" and the product's daily limit, waits the policy's minimum gap
  (72 hours by default) between emails to its own address, and is approved exactly as the contact's email is: on its own while the Cold email step is
  handed over (the agent active, on Act, the daily guardrail check passed), otherwise by you in Team, where the proposal says
  "Also to <name> (<role>)". Lowering the number holds back copies not yet sent.
- **Stop rules cover the whole organization.** A reply from anyone there stops everyone's emails (the reply reading already counts
  another mailbox at the business). An opt-out or a spam complaint from anyone there cancels every unsent email to everyone at the
  organization and stops its cold outreach for good; the person who opted out is suppressed as before. A hard bounce of the
  contact's address stops everyone there, as it stopped the sequence before; a colleague whose address bounces is opted out (a hard
  bounce) or simply dropped from later touches (a soft one), and the others go on.
- **On the Growth screen** each touch in an opportunity's message history says how many people it went to and lists each with the
  state of their own email; a copy whose delivery is unconfirmed is reconciled on its own.

The people finder still looks for one address per business (the person whose title decides most), before its first email. The
others come from lists you import, each waiting for you on Decision-makers to review like any found address. Permit them before the
business's first email: a person permitted later joins no sequence already under way.

## Canonical Intel activity and verified billing conversions

With `platform.agents.app-growth.v1`, Intel posts server-only activity to `POST /api/apps/growth` using its existing billing application
key. The payload contains its opaque 24-hex billing account, an immutable event UUID, `heartbeat`, `active` or `first_value`, the event
time, and optional provider-list count. It cannot claim a trial or payment. The Hub authenticates the app, resolves exactly the same
account-to-tenant link as billing, and associates the event with that canonical tenant. A missing link returns retryable 503; the
activity itself carries no name or email. When no Growth organization is linked yet, the Hub first looks for the prospect this
customer was (see [A prospect who starts a trial](#a-prospect-who-starts-a-trial)); only when there is none does it create a customer
record with a reserved `.invalid` identity and Account Manager ownership, an identity that is never a prospect website or a source of
cold outreach.

### A prospect who starts a trial

A customer used to get a Growth organization of its own even when the Marketing Manager had already found and written to that
business, so cold follow-ups kept going to a business in a trial and the trial was never credited to the outreach. Since 2026-11-13
(`private.growth_ensure_customer`), the first trial, payment or product signal for a tenant with no Growth organization reads the
address on its live billing customer, which is the address the application's sign-up gave for the trial:

- **The same address as a growth contact** links that contact's organization, and that contact becomes the product opportunity's
  contact.
- **Otherwise the same business domain** as a prospect organization links it. Personal mail domains (Gmail, Outlook, Yahoo, iCloud,
  Comcast and the like) never do. The person who signed up joins as a contact for review and becomes the product opportunity's
  contact (and the other product's, when a later signal hands that one to the Account Manager), so customer email never goes to
  the person who was cold-emailed because a colleague signed up. A contact the owner sets afterwards is never reset.

Only a prospect that is not already a customer and not internal is linked; a test-mode billing customer never links, and a tenant that
already has a Growth organization keeps it. The send claim refuses cold email to a customer's organization, and unsent marketing drafts
there are cancelled when the link is made. The trial or payment then lands on the prospect's own opportunity, with its history. Each
link is audited as `growth.customer_linked` with the tenant, the product and whether the address or the domain matched, never the
address. The sign-up address is the applicant's claim (Intel starts the trial before confirming it), so a link only stops prospecting
and credits the trial: it sends nothing to anyone new. A linked customer keeps the prospect's real domain, so discovery can find it again; it then adds no
opportunity or evidence to a customer's (or an internal) organization, for either product.

Intel migration `0150_hub_growth_accounts.sql` enrolls billing-confirmed nonlegacy customer workspaces automatically, while preserving
explicit legacy mappings and their enabled switches. The first newly recorded provider list with a real provider member emits first
value once; historical lists and `demo-seed` data do not. Events enter the existing durable outbox in the source transaction. The worker
uses the existing billing configuration unless explicitly paused, preserves exact payload bytes on retry, and retains lease fencing.

Live Hub billing changes enter a private lifecycle outbox: actual trial starts and the first positive paid invoice for a new buyer.
Test mode, zero-dollar trial invoices, open/failed invoices, renewals and pre-rollout paid history do not count as purchases. An old
subscription with unknown prior payment history remains uncounted unless it is a trial ending after rollout. Invoice/subscription
webhook ordering is reconciled. Unverified checkout holds remain held; the existing growth maintenance worker drains eligible events,
backs off individual failures and expires entries after 89 days. No subscription-status inference substitutes for a paid invoice.

The scorecard's `verifiedPaid`, `verifiedTrialStarts` and `lifecycleStartedAt` distinguish these prospective receipts from form submissions
and incomplete historical windows. The original HMAC event endpoint remains available for explicitly mapped producers.

## Native product event integration

`server/growth/event-client.mjs` is a server-only adapter for native applications. Each application must emit from its transactional outbox with a **stable eventKey**; retries reuse the exact event, changing only the signature timestamp. Never put these keys in browser code. A product key cannot authenticate another product's feed.

```js
import { customerActivityClient } from './event-client.mjs';
const activity = customerActivityClient({
  origin: 'https://help.caremetric.ai',
  product: 'carebase', // or caremetric-intel, with its separate key
  key: process.env.CAREMETRIC_GROWTH_EVENT_KEY,
});
await activity.report({
  tenantId: hubTenantId,
  eventKey: `trial:${nativeTrialId}`,
  kind: 'trial_started',
  occurredAt: trialStartedAt,
  facts: { trialEnd: trialEndsAt },
});
```

Package the adapter with `protocol.mjs`, `policy.mjs` and Zod, or implement the documented wire protocol directly in the native stack. The endpoint is `POST /api/growth/events/{carebase|caremetric-intel}` with JSON up to 8 KiB. Set `X-CareMetric-Timestamp` to Unix seconds and `X-CareMetric-Signature` to the hexadecimal HMAC-SHA256 of `${timestamp}.${product}.` followed by the **exact request bytes**. Signatures expire after five minutes. Event timestamps may be up to 90 days old; old lifecycle observations cannot regress newer business events. A reused key with different contents is rejected.

Supported business events: `signup`, `trial_started`, `heartbeat`, `active`, `first_value`, `paid`, `renewed`, `cancel_requested`, `churned`, `support_blocked`, `support_resolved`, `expansion_interest`, `meeting_booked`, and response classifications. Allowed facts are `source` (`direct`, `search`, `outbound`, `referral`), a bounded campaign identifier, `trialEnd`, bounded numeric `count`, and one of `active_users`, `completed_training`, `provider_lists`, `outreach_replies`. Resident/patient identifiers and free-form payload fields are rejected. Map the Hub tenant before its first event.

A heartbeat means the feed is alive. An active event means meaningful use. These must be emitted separately: a missing heartbeat creates a telemetry task, not a claim that the customer abandoned the product. Confirm each product's first-value definition against its native experience: CareBase training/report completion; Intel territory/list/contact-outcome workflow. A billing facility count is not first value.

The native CareBase and Intel codebases are separate from this repository. Their outbox instrumentation, booking-provider callbacks, and authenticated product journey checks must be connected in those deployments. The Hub receiver and adapter are implemented and tested; no native deployment is implied.

## Daily operation

Review the due queue and agreements, not only sent-message counts. Record the observed outcome when resolving work. Supported events close the matching task automatically; adoption recovery requires activity on two distinct days after the recovery task begins. Cancellation and support tasks remain open until a customer outcome is confirmed. Replies that require product-specific answers, pricing negotiation, or unusual commitments stay in Communications with a dated owner task; the agent never invents an answer from an absent transcript.

Inbox-driven growth changes use the individual email message received through the signed provider path, including its own timestamp. Public chat and form addresses are unverified claims: they do not automatically change contacts, suppression, sequences or lifecycle history. Those inquiries remain available for owner review in Communications.

Provider acceptance means the provider accepted the request. Delivery requires a signed event. An interrupted send becomes **unknown** after ten minutes, blocks later contact attempts and is never blindly retried. Reconcile an unknown message using the provider log reference in Growth, or let a signed delivery event settle it. Opt-out, bounce and complaint suppress the shared contact across both products and existing Hub bulk email. Unsubscribe links show a confirmation on GET and apply on POST to avoid accidental changes by link scanners.

Drafts retain the opportunity, contact and policy versions used to write them. An edit during generation discards that output. Each sweep cancels stale unsent drafts, expires their pending approvals and prepares replacements from current context. An unchanged rejected draft is not proposed repeatedly. Accepted and uncertain deliveries remain in the history and are never regenerated merely because a policy changes.

A new product opportunity starts from the observed event: meetings become demos, while heartbeats and replies do not create trials. Late activation, payment and churn events preserve their historical milestone dates without moving the current lifecycle stage backwards. Late events that leave the current context unchanged preserve existing pending drafts. Activation arriving after payment therefore closes onboarding and contributes to conversion reporting. Clearing the Hub tenant ID explicitly removes its mapping so the owner can correct it. Persisted model-budget reservations are released after deferred cost writes settle, including a retry when reservation cleanup temporarily fails.

Growth and native Account Manager email claims share a database lock and check each other’s recipient history before reserving a send. The configured contact gap applies across both workflows, including simultaneous attempts; an overlapping native email is skipped with a visible frequency-limit reason. Their existing approval and daily-volume limits still apply.

Temporarily blocked messages receive a persisted 15-minute retry time; both the queue and direct execution respect it, allowing other agents’ ready actions to proceed.

Pause the agent, disable the product policy, or switch off Settings → Customer growth → "Send growth email" to stop new sends. An already accepted provider request cannot be recalled. The system rechecks the latest contact, policy, opportunity and suppression status immediately before reserving a send; short database mutations serialize independently of model, search and mail calls.

The daily discovery run also researches up to ten existing prospects whose fit is still uncertain (unknown or 30–74), using the same Brave provider and only each organization's own domain. It takes two prospects with verified, permitted contacts for each one of the others, rotating both groups each Eastern day. It starts no search once the run's 150 seconds are spent; the prospects not reached wait for the next run. Only marketed products and Marketing Manager prospects are eligible; customers, internal organizations, opted-out contacts and clear non-fits are excluded. New sources enter the existing dated-evidence history and the next pipeline sweep reassesses them. Duplicate snippets do not trigger another assessment. This does not lower the fit threshold, permit a contact or send anything. Task results show only the number searched and evidence rows returned, including duplicates. The bound is per discovery invocation; owner-requested runs and retries may repeat these searches.

Pipeline and customer-success work run every 15 minutes; discovery searches run daily at 08:00 Eastern. The SEO Analyst can propose a weekly content brief at its 08:30 daily catch-up, when in Propose mode. Review and approve that brief in Team, use it in the existing publishing workflow, and preserve its campaign identifier in landing-page signup events. Publishing and actual search traffic require the native website/analytics integration. Product cohort counts exclude internal organizations. Experiment assignment is stable per organization and enabled explicitly; there is no automatic winner selection from a tiny sample. Use rejection notes, observed objections and loss reasons to revise approved claims and prompts, rerun evaluation, and review the next cohort.

## Verification and rollout limits

The eleven distinct PR review fixes and their regression results are recorded in [PR review-fix evidence](evidence/ai-workforce-pr-review-fixes-2026-11-03.json). The four implementation-review findings and their regression results are recorded in [the review-fix evidence](evidence/ai-workforce-review-fixes-2026-11-03.json). [PR validation](evidence/ai-workforce-pr-validation-2026-11-03.json) records the combined checks after integrating the newer lead, lifecycle and content features from main.

- `npm run check` runs application/UI tests, lint, types, SDK checks and the build.
- `npm run evaluate:growth` runs both products through golden cases for source freshness, citation/link rejection, intent, stop rules and lifecycle choices.
- `HUB_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npm run test:growth:db` exercises real database roles, owner sessions, competing send claims, cross-product frequency, signed inbox handoff (including an email saved when growth capture fails), lifecycle replay and delayed milestones, policy/contact edits during drafting, stale proposal replacement, a queue of 50 deferred messages, unsubscribe, shared budgets and deployment gate drift. It refuses hosted databases and sends no email.
- CI runs existing signup/registration coverage, the growth integration twice to check teardown, and pgTAP boundaries. The external workflow checks public Hub/CareBase/Intel availability every 15 minutes when installed in the repository's default branch. It does not impersonate a customer or claim to test native authenticated activation.

These changes are release artifacts until migrations, deployment, provider configuration and native event wiring are completed. No production records were modified and no prospects were contacted during implementation.

The Customer Growth workspace declares `platform.agents.customer-growth.v1`. The separate website-lead Growth Manager uses `platform.agents.growth.v1`; its lead alerts and reports remain independent. Native Account Manager lifecycle emails and Content Marketer publishing keep their existing approval and transport controls.
