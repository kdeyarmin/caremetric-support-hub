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

- **How a marketing email to an Intel agency looks** (owner direction 2026-11-17, on the plain letter: "something that I'd throw
  away without even reading", "there's no explanation of what else the software does"). The three emails to a home health agency
  or hospice are laid out in Intel's own look (`growthEmail`, `server/growth/campaign.mjs`, the marketing blocks in
  `server/email-layout.mjs`): Intel's header, a short line in capitals, the subject as the headline, the writer's opening, then
  the email's own sections. [Each agency's own market report](#each-agencys-own-market-report) says what each email holds. The
  text part stays the approved words, as a letter. Every other growth email is the letter described next. A designed email is
  more likely to be filed under Promotions than a plain letter; the owner chose the designed email knowing that.
- **How every other growth email looks.** A letter, not a newsletter (`growthEmail` in `server/growth/worker.mjs`): left-aligned and
  without images, so it reads like an email a person typed and is not filed as a promotion. It is in the theme of the
  product's app: an Intel letter is the Intel app's own dark Emberline letter, with the ember accent on its links. It opens with "Hello,", then
  the approved words (the product's own pages are clickable links, nothing else is), then the sign-off with the product's
  website: prospect outreach is the founder's own letter, signed "Dr. Kevin C. Deyarmin, Founder, CareMetric" (owner direction
  2026-11-12), and a customer message is signed by the product's team ("The CareMetric Intel team"), and a small footer with the company, its postal address and the opt-out
  link ("Opt out of these emails", at `/api/growth/preferences/<token>`; the footer and the address avoid the word "unsubscribe" because
  until 2026-11-13 the database read that word anywhere in a reply, quoted text included, as a request to stop, so a prospect who
  replied with the original quoted underneath was opted out by their own quote; replies are now read from the sender's own words,
  see [How replies are read](#how-replies-are-read). The old `/api/growth/unsubscribe/<token>` address still works). The inbox preview is the message's first sentence
  (`firstSentence`: a full stop after "St.", "Dr." or "Inc." in an agency's name does not end it). Since 2026-11-17 a link on a line of its own
  is shown by a short label in the HTML part (`linkLabels`: "Open your agency's market report (PDF)", "Start a CareMetric Intel free
  trial", or the page's own label), where it was the whole address, some 300 characters of token and campaign tags; the plain-text part
  keeps the address. A founder-signed email arrives from the founder's name unless a display name is set
  (see [A separate sender for prospecting](#a-separate-sender-for-prospecting)). The writing rules (`growth.5`) ask for a specific, true opening
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
- "Growth email display name" (optional): the display name, at most 64 characters with no quotes or angle brackets. The Settings
  page refuses a name it cannot use. Empty (owner decision 2026-11-17): a founder-signed email (cold email, its follow-ups and a
  quiet follow-up) arrives from "Dr. Kevin Deyarmin, CareMetric" (`founder.fromName` in `facts.mjs`), and every other growth email
  from "CareMetric". A name set here is used for all of them.
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
  (`discoveryQueriesPerDay`; four segments by 36 Pennsylvania places for CareBase, so it never leaves Pennsylvania; eight segments by
  104 markets across the country for Intel: six for home health and hospice agencies and, since 2026-11-16, two for nursing homes,
  the first of them right after the first agency segment). No search repeats until the whole grid has been searched; the next pass
  reads the next page of each search. Intel's free reports serve home health and hospice agencies only, so a prospect that is clearly a
  nursing home gets its own emails, in a nursing home's words, and no report page (`intelSetting` and `nursingHomeAngles` in `playbook.mjs`). Calls to the search provider are paced a second apart. If a later search fails, the day's searching stops and
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
- **The product's catalog** (owner direction 2026-11-16: Intel's in `growth.13`, CareBase's in `growth.14`): every message gives the
  writer its own product's published catalog (`server/agents/content/features.mjs`), as its own cached block after the instructions,
  the way the Sales Executive and the Social Media Manager get it. Its numbers join the fact sheet's in that message's checks, so a
  sentence about the product may state them as the catalog words them, and no other figure: for Intel, the figures its site publishes
  about its data ("150+ public healthcare datasets", "33,000+ ZIP areas and 3,200+ counties"); for CareBase, the Pennsylvania
  requirements its site states ("12 hours of training a year" for a personal care home's direct care workers, 16 in an ALF). Neither
  message may state the other product's numbers.
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

Owner decision 2026-11-15: every agency the team writes to gets a free market report of its own. Intel draws the report from CMS
and Census data, with nothing about any patient:

- the agency's Medicare patients, and its share and rank among the agencies located in its county and its state;
- the county's largest agencies, with the agency highlighted among them;
- the county's demand: beneficiaries, residents aged 65 and over and their growth since 2020, and home health or hospice use;
- the hospitals the county's residents use, and the highest-ranked physicians for outreach;
- the agency's CMS ratings;
- up to three moves the figures point to, and the 30-day free trial. Since 2026-11-17 the report's trial box does not bring up the
  card (owner direction; Intel's sign-up page states the terms where the card is entered).

The link is `https://www.caremetricintel.com/report/<token>`. The Hub signs it (`server/growth/report-link.mjs`) for each CareMetric
Intel prospect whose evidence carries its Medicare roster record, which holds the agency's CCN. The key comes from the marketing feed's
shared secret (`HUB_INTEL_FEED_SECRET`), under a label of its own. Intel verifies the link and serves the PDF (Intel
`server/routes/agencyReport.ts`; protocol in Intel's `docs/HUB_MARKETING_FEED.md`, "Agency report links"). A link lives 150 days. It
names the agency, never a person, and carries the opportunity's id as its reference.

A draft carries the link only once Intel has answered it with the PDF (`checkedLinkFor`: one GET with a 20-second timeout; the
answer is kept per agency for 12 hours when the report opens and an hour when it doesn't). An agency certified after CMS's newest
post-acute file gets its county's report built around it, saying CMS hasn't published its own patients yet. One Medicare's
directory doesn't list yet has no report, so its email offers the market review page instead of a link that opens to "No report for
this link".

**The first email leads with the report, then says what the software does and offers the trial** (owner direction 2026-11-15 for
the report; owner direction 2026-11-17 for the rest: a first email that was the report and nothing else, which this section
described for a few hours that day, was "the worst marketing email that I've ever seen", with "no explanation of what else the
software does"). A prospect that is clearly a nursing home gets the same designed email without a report, as Intel's reports
serve home health and hospice agencies only (see "Written for the reader's kind of business" below). The email goes to the agency's best contact: a named owner, administrator or marketing leader
when the team found one, else the role address, and, as separate emails, the other decision-makers there (see
[Several decision-makers at one organization](#several-decision-makers-at-one-organization)).

**Who writes what.** The writer writes only the **opening**, for this one agency (`reportTouchAngle` and `reviewTouchAngle` in
`playbook.mjs`, `growth.17`): two or three sentences that say a free market report was made for the agency, by name, from Medicare
data, with the report's link on its own line and at most one question. A county figure from the brief comes first, about the county.
Code holds the opening to that (`shortFormProblem`): at most 120 words, at most one question, the report's link and no other, no
trial and no price. Everything after the opening is written once, for each kind of business, in `server/growth/campaign.mjs` from
the fact sheet, and added to the email when it is drafted (`withCampaign`). So **the email you approve on the Growth page is the
whole email**, sections included, and the sent text part is those words. `campaign.test.mjs` runs every section through the checks
a written email passes (the fact sheet's numbers, no card, no "public", no rank or rating of an agency, no demo, nothing about opens).

What the three emails hold, in order:

| Email | Line above the headline | The writer's opening | Then, the sections for that kind of agency |
| --- | --- | --- | --- |
| First | Your free market report is ready | The report made for this agency, and its link | A card that previews the report (where you stand, who leads the county, top hospitals, top physicians for outreach; the values stay in the report) with the button "Open your market report". What CareMetric Intel does, in five numbered points. Four figures about its data. The founder's story as a signed quote. A closing panel with the 30-day free trial's button. |
| Second, four days later | From your market report to a plan | What a team does with a report, and one question | A week in CareMetric Intel in four cards (Monday, every day, after each visit, Friday). The Founders Sale, in its approved words. The free trial's button, and the report's link again. |
| Third | A last note | A short close: the report stays, forward it to whoever handles marketing | The report's button, three lines on what Intel does, and the trial as a link. |

**Written for the reader's kind of business** (owner direction 2026-11-17, on a block that told every reader about home health
agencies and hospices alike: "they don't care what the ranking is. Make the email customized to the recipient's business
industry").

| The reader | Who it reads about | Its referral sources | Report |
| --- | --- | --- | --- |
| Home health agency | Every home health agency in its territory, ranked by Medicare share, with alerts | The physicians who certify home health, plus hospitals and facilities | Yes |
| Hospice | Every hospice in its territory, ranked by Medicare share, with alerts; its "liaisons", not "marketers" | Physicians ranked for hospice outreach, plus hospitals and nursing homes | Yes |
| Home health and hospice under one name | Both kinds | Physicians, hospitals and facilities | Yes |
| An agency whose kind nothing states | "Every agency like yours": neither kind is named | Physicians, hospitals and facilities | Yes |
| Nursing home | Every nursing home in its territory, ranked by Medicare share, with ratings, staffing, inspections and owner, and alerts when a rating or owner changes (Intel ranks nursing homes since 2026-11-17) | The hospitals its county's residents use, plus physicians and facilities; its county's use and supply of skilled nursing | No |

- **How the kind is told** (`prospectKind` in `playbook.mjs`): the agency's Medicare record first, then a nursing home by its name
  or research (`intelSetting`), then the name ("hospice", "home health"), then a brief written for a hospice, then what its
  research says.
- **The writer is told the kind too** (`organization.setting`), and to name only that kind's competitors and referral sources.
- **A nursing home gets the same three designed emails** (`nursingHomeAngles`): what Intel does for a nursing home, a week of the
  work, and a short close, each with the trial. No market report is offered or mentioned. Until 2026-11-17 a nursing home got the
  plain letter.
- **Intel's own email** for a requested market report lists what Intel does the same way, for a home health agency or a hospice.

- **The headline is the subject.** The subject names the agency or its county and the report, or asks the question the report
  answers.
- **The second email never says whether the report was opened.** Its sections are the same words to every agency; only the
  writer's angle differs (`viewedTouchAngle`, `unviewedTouchAngle`).
- **If you edit an email's sections on the Growth page**, it is sent with your words as a plain letter, not in the designed layout:
  the layout is applied only when the sections read back exactly as written (`readCampaign`). Editing the opening keeps the layout.
- **Changing what the sections say** is a code change in `campaign.mjs`, checked against the fact sheet by its test. They hold no
  setting: the trial's length and the Founders Sale's words come from the fact sheet.
- **Without a model** the email keeps its shape: a fixed opening, then the same sections.
- **No prospect email brings up the credit card** (owner direction 2026-11-17). One that does is refused when written and withdrawn
  when it would be sent (`card_terms`). "Risk-free" is refused (`guarantee`), as is "no credit card" (`trial_terms`).
- **Nothing about Intel calls its data public** (owner direction 2026-11-17, first for email, then for everything the same day).
  It names the source instead: "Medicare data", "CMS and Census data", "CMS ratings". One rule in code, `public_data`
  (`publicDataWords` and `callsDataPublic` in `server/agents/content/validate.mjs`), refuses it in prospect and customer email,
  sales replies, social posts and replies, ads and articles; a queued prospect email that has it is withdrawn when it would be sent.
  Every writer reads the rule on the fact sheet (`dataMention`). The writer is also told never to call the data
  proprietary, exclusive or licensed, and the Sales Executive answers plainly when a prospect asks where it comes from. If your
  approved pitch on the Growth page says "public", edit it there: the writer is given that pitch as written.
- **Every email is easy to read** (owner direction 2026-11-17: "I don't need full file names, years cited, or super formal
  sentences"). The writer is told to write the way people talk: everyday words, short sentences, contractions. No prospect email
  cites a data file or its year ("(CMS, 2024)", "the Provider of Services file", "2026Q3"); one that does is rewritten
  (`data_citation`, `citesDataFile` in `draft.mjs`). A county figure is stated without the file and year that follow it in its
  source. The fixed sections keep every sentence to 25 words or fewer and hold no year (`campaign.test.mjs`), and the Founders
  Sale is said there in everyday words. The trial and customer emails use the same voice; only the card terms and the Founders
  Sale in the trial check-in keep their exact terms.
- **The rank check no longer refuses the writer's own words.** Until 2026-11-17 the instructions said "the physicians Intel ranks
  highest as referral sources" and the check for an agency's own rank (`emailStatesStanding`) refused "ranks highest", so a draft
  that followed its instructions failed. A rank that is plainly about physicians or referral sources now passes, and the
  instructions say "the highest-ranked physicians for outreach".

An Intel prospect with no roster record gets the same email with the market report page
(`https://www.caremetricintel.com/market-review`, `intel-market-review`) in place of its own link: any agency gets its full report
there by entering its CCN. Its card's button reads "Get your free market report", and its second email (`reviewFollowupAngle`)
points to that page again and offers the trial. The writer never
states a figure from the report: the reader opens it to see them. CareMetric's own agency (`ownAgencies` in `roster.mjs`) is never a
prospect. The link check accepts that one report link for that one draft, and no other agency's. The report's trial link carries
`utm_content=agency-report`, so the Monday scorecard counts the visits it brings.

**Prospects found on the web get their own report too** (`growth.match`, every hour; `server/growth/agency-match.mjs`,
`20261115233000_growth_roster_match.sql`). A prospect found by web search has no roster record and so no CCN. The Marketing Manager
finds it:

1. The database hands out up to ten CareMetric Intel prospects an hour that the Marketing Manager owns in an open prospecting stage
   (identified, researched, qualified, contacted) and that have no roster record yet, best fit first, within Settings → Customer
   growth → **Most web prospects to match a day** (40; 0 stops matching). Matching uses Intel's feed, so it runs while **Find
   prospects from the Medicare roster** is on; it needs no states and no web search.
2. The contact finder reads each one's own website (the usual contact pages, robots.txt honoured) for the telephone numbers it
   publishes (call links first, never a fax) and its postal address. Where the site gives no address, the place comes from the Hub's
   own evidence on the prospect: an address in its search snippet or home page summary, else the state of the discovery market it
   names (where discovery searched), else the one state it names. A market is where the team searched, not where the agency is, so it
   gives a state and no city: such a prospect can be matched only by a number it publishes. A prospect nothing places in a state is
   not sent.
3. One signed request to Intel's marketing feed (`agency_match`, Intel's `docs/HUB_MARKETING_FEED.md`) asks which home health or
   hospice CCN each one is. Intel matches by a published local number that the agency's Care Compare record lists in the same state,
   backed by its name or domain; or by name and place, when the distinctive words of the names agree (legal forms, business words,
   setting words and the place's own name aside, with "home care" never taken for "home health") and the agency is the only one of
   that name in its state, in the same city or ZIP code. A wrong match would send one agency another agency's report, so Intel
   answers none when two agencies tie, a number and a name point two ways, or the evidence is thin, and the Hub takes only what it
   answers.
4. A match is saved exactly as the roster saves an agency (`rosterRow`: its public record as a dated claim, its size and position as
   a research-only line) and attached to the prospect's organization, so `rosterAgency` reads its CCN and the next draft links its own
   report. CareMetric's own agency (CCN 398009, `ownAgencies`) is never attached, nor one CMS shows closed, one already tied to
   another organization, or one the roster is looking up at that moment.

No match: the prospect is tried again in 30 days, then every 90 (a website may add its address; CMS publishes a new quarter); one the
website or the feed could not answer, in an hour. A website whose read failed (a timeout, a refused connection) is tried again in an
hour for the first three attempts, then on the 30 and 90-day schedule. Until then its emails offer the market report page, as before. The telephone
numbers go to Intel in the one request and nowhere else: they are never stored, logged, written into evidence or shown to a model.
A matched agency's record is observed again whenever the weekly roster read covers its state. The Growth screen's roster list shows a
matched agency with its organization, as it shows one the roster resolved.

To release it, apply `20261115233000_growth_roster_match.sql` and then `20261115233100_growth_roster_match_contract.sql`, which
checks the table is closed, the two functions are the Hub server's alone and save through the roster's own functions, the setting
exists and the task is scheduled, before it declares `platform.agents.growth-roster-match.v1`. The server registers `growth.match`
only once the database declares it. `server/agents-growth-roster-match-integration.mjs` runs it through the real roles in CI.

## Interest and our own trials (2026-11-17)

- **Intent follows what the business did** (`20261117180000_work_recovery.sql`, trigger `growth_event_intent`). It was set only by the
  fit assessment, which stops once a business is researched, so it was empty on all 235 Intel opportunities, the three trials included.
  Each recorded event now sets it: a trial, a sign-up, first value, a payment or a meeting 100, a positive reply 75, a reply 60, an
  opened report 50 (at least); "not now" sets it to 25 and "no" to 0, the business's latest word standing over its earlier interest.
- **Our own trials are internal.** A trial started from your own address (Settings → AI team → your email) or an address on a CareMetric
  domain marks its organization internal (`private.growth_internal_address`, audited `growth.marked_internal`), so the scorecard does
  not count it and no customer email is drafted for it. A trial from another address of yours on a personal mail domain is marked by
  hand on Growth ("Internal account; exclude from outreach"). By your decision of 2026-11-16 the three Intel trials open that day were
  marked once.

## Finding decision-makers and their addresses

The Hub finds the people who decide at its best prospects itself (`growth.people`, every half hour, a few businesses at a time;
owner decision 2026-11-13, replacing Apollo). It needs no paid service and no key.

- **Who**, from three free sources, recorded as people: who the CMS owners file lists as owning or managing the agency (Intel's
  feed), the authorized official on the agency's NPI record (the public NPI registry, matched by the agency's ZIP code and its CMS
  telephone number or name), and the leaders the agency's own website names with a title that decides (owner, administrator,
  executive director, business development). The person written to is the one whose title decides most.
  - An agency found on the web and not matched to its Medicare record has no CMS owners and no CMS place. The registry is asked
    where the agency's own website's postal address places it (its ZIP code, else its city), as home health and as hospice, and
    a record is taken only when its telephone number is one the site publishes or its name is the agency's (since 2026-11-17).
  - A business is searched once and then left for 60 days. One matched to its Medicare record after its search, with nobody
    named, is searched again at once, so its CMS owners and NPI official are read. On 2026-11-17 every business searched with
    nobody named and not matched was searched again once, with the registry at its website's address
    (`20261117220500_growth_research_people.sql`).
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
  - *A verification service when the mail server won't answer* (since 2026-11-17, off until you switch on Settings → Customer
    growth → Ask a verification service when a mail server won't answer). Most mail servers refuse to answer the Hub's cloud
    server: on 2026-11-16 the check confirmed 2 of 27 addresses, and every reason recorded since was a policy refusal. With the
    switch on, when the mail server gives no clear answer (a refusal about the Hub, a temporary answer, no answer at all, or the
    checker resting), ZeroBounce is asked about the same shapes, best first, at most three a person, and stops at the first it
    answers for. Valid confirms the address (recorded as found by the verification service, auto-permitted under your hand-over like
    a mail server's confirmation); catch-all and unknown confirm nothing; invalid, spam trap, abuse and do-not-mail refuse it (a
    role address such as info@ that is do-not-mail only for being a role address counts as its mailbox answering). Each check is
    one ZeroBounce credit, about a cent (its first 100 a month are free), reserved first under Settings → Customer growth → Most
    verification service checks a day (50 until you save a number). It needs the ZeroBounce API key (`ZEROBOUNCE_API_KEY`, a
    Railway secret). The `growth.people` and `growth.verify` results count its answers (`byService`). Only the address is sent to
    ZeroBounce; no name or page.
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

## Which agencies opened their market report

Owner decision 2026-11-16: Intel may record when an agency's market report link is opened (which agency and when, never who or an IP
address) and tell the Hub. Open and click tracking stay off in both mail services, so before this the team knew nothing between an email
and a reply (`20261116120000_growth_report_views.sql`, gate `20261116120100_growth_report_views_contract.sql`, feature
`platform.agents.growth-report-views.v1`; Intel's side is `docs/HUB_MARKETING_FEED.md` "Report views" in the Intel repository).

- **Settings → Customer growth → Learn which agencies opened their report.** Every 15 minutes the Marketing Manager's `growth.views` task
  (`server/growth/views.mjs`) reads the opens Intel recorded since its last read (`POST /api/hub/report-views`, signed with the roster's
  shared secret). Intel counts only a person's browser: never a prefetch, a link scanner or a bot, once an hour at most per link.
- **What counts.** An open counts for a CareMetric Intel opportunity only when its first email went out at least two minutes earlier (your
  own preview and a mail service's scan at delivery come before that), once per open. It is recorded as a `report_viewed` activity
  event, raises the opportunity's intent to at least 50 and notes when its report was first opened. The Hub's own check that a report
  opens before offering it is signed without the reference, so it is never counted.
- **You are told** the first time an agency opens its report ("<agency> opened its market report").
- **The second email follows it.** For an agency whose first email carried its own report, the second email either picks up from the
  report (one concrete way Intel turns it into a plan, a question, the trial) when someone opened it, or brings a new angle with the report
  link again when nobody did. It never says or hints that you know. Which one is recorded as an arm (`viewed`: `yes` or `no`), so the
  Monday memo can compare replies.
- An open does not stop or start any email.

`server/agents-growth-report-views-integration.mjs` runs the database side through the real roles in CI.

## An account brief before the first email, written and reviewed on the top model

Owner decision 2026-11-16 ([review](AI_WORKFORCE_REVIEW_2026-11-16.md)): research every Intel agency before it is first written to,
write the first email from that research on the top model, and have a second model read it as the buyer would. Before this, the writer
saw about four web snippets, and research went only to borderline prospects, never to the ones about to be emailed
(`20261116110000_growth_brief.sql`, gate `20261116110100_growth_brief_contract.sql`, feature `platform.agents.growth-brief.v1`).

**The brief** (Settings → Customer growth → Write an account brief before the first email; Most account briefs a day, 25; Most to spend
on one account brief, 60 cents). Every 20 minutes the Marketing Manager's `growth.brief` task (`server/growth/brief.mjs`) briefs one
agency: qualified ones with a permitted contact first (they are about to be written to), then the best fit, then agencies the Medicare
roster confirmed; never one already emailed. A saved brief rests the agency 30 days; an attempt that saved none (a timeout, a failure,
today's budget spent) rests it a day, then it is tried again. Writer-part sentences that state any rating, rank or share are left out
whatever their numbers (`server/growth/standing.mjs`), and an Intel email that states an agency's star rating or rank is refused
(`own_standing`); asking where the agency stands is fine.

1. **Code gathers** the agency's market report as data from Intel's feed (`agency_brief`: its Medicare share and rank and how they have
   moved, the county's leaders, the hospitals its residents use, its CMS ratings and three moves; never physician names or the
   SSVI), the county's figures for the agency's own setting (home health figures to a home health agency, hospice figures to a
   hospice; never a dollar figure), the evidence the Hub holds and the leaders already found. A nursing home found on the web (one
   `intelSetting` reads as a nursing home, with no roster agency) is briefed as a nursing home: no market report is asked for, the
   writer is told it is not an agency, and only nursing home figures are its own. Intel's shares are rounded to four places first: JSON writes every digit
   of a fraction, and the identifier screen read those runs of digits as card numbers, so nine briefs in ten were skipped
   (`skipped: identifier`) until 2026-11-16.
2. **Web research** on the draft tier looks for dated triggers: a job listing for a liaison or marketer, a new location or service
   line, a leadership change, an award, news (`research.2`, shared with `growth.research`). What it keeps becomes evidence.
3. **The top model** (Opus, high effort, `brief.3`) writes the brief: what the agency is, where, what kind of owner it has, its triggers, two or
   three questions about problems Intel answers, the angle to lead with, one cited opening sentence and the county figure most worth
   stating, plus its own fit and what is still unknown.
4. **Code checks it.** A brief has two parts (`private.growth_briefs`). The writer part may state only what a citable source states:
   a sentence with any other number is dropped, so the agency's own share, rank, ratings and patient counts never reach an email (the
   owner's rule); a source address it was not given is dropped. A sentence that names someone on the agency's people list (its
   president, an owner from CMS's ownership file) is dropped too, since an email addresses the agency, never a person (`brief.2` and later,
   2026-11-16). The research part keeps those for you. Growth shows both on the opportunity. The writer reads only the writer part
   (`private.growth_brief_writer`). A county figure reads with the county's name in its place: "billing for Dallas County's Medicare
   FFS beneficiaries" (before 2026-11-16 the name was added at the end, "...located in other counties in Dallas County").

While briefs are on, an Intel agency's first email waits up to a day for its brief (`held.brief_pending` on the sweep); after that it is
written as before.

**The first email** (Settings → Customer growth → Write first emails on the top model). An Intel agency's first cold email that has a
brief is written on the top model at high effort (`growth.13`), from the brief: its opening, one of its questions, its angle, and the
county figure (the writer may state it once, as a fact about the county with its source, never about the agency; a brief written for
an agency gives a nursing home no figure, and one written for a nursing home gives an agency none). The brief's angle
replaces the hashed angle; while experiments run, a quarter of agencies keep the hashed one (`arms.angle_by`: `brief` or `hash`), so the
learning memo can tell whether the brief's choice draws more replies. At most one such email per fifteen-minute sweep, started early in
it (`held.top_model_later`); a repair pass stays on the agent's own tier.

**The reader's review** (Settings → Customer growth → Have a reader review each first email). A second model reads each first email as
the owner of an agency like this one and scores it 1 to 5 for being specific, relevant, clear in its ask and worth a reply.
Below 4 the email is rewritten once around its weakest sentence, on the same tier, and the better-scored version is kept. The score is
recorded with the email (`arms.critic`, `arms.rewritten`), and the Monday memo compares replies by score once there are 20 of each.
Since 2026-11-17 (`20261117160000_growth_diagnostics.sql`, feature `platform.agents.growth-diagnostics.v1`) what the reader said is
kept beside the email in `private.growth_message_reviews`: the four scores and the sentence that most made them stop reading, for the
first read and the rewrite's, and what became of the rewrite (`not_needed`, `no_time`, `no_answer`, `failed_checks` with the check's
code, `unread`, `scored_lower` or `kept`). On the first day all four reviewed emails scored 2 or 3, each was rewritten and none scored
higher; after about 20 first emails these rows decide whether the rewrite (about 10 cents and 30 to 45 seconds each) is kept. A
review that cannot be recorded never holds the email (the sweep counts it as `unreviewed`).
Since 2026-11-17 (`critic.2`, [review](AI_WORKFORCE_REVIEW_2026-11-17.md)): the first version scored all four emails it read 2 or 3,
having been told most cold email deserves that, and kept only one number. Now each score has a description (a careful, specific email
earns a 4), the reader sees the brief's writer part and the writer's own rules, and it names one weakness from a fixed list
(`generic_opening`, `about_sender`, `too_long`, `too_many_asks`, `unclear_ask`, `wrong_problem`, `no_reason_now`, `reads_as_template`, or
`none`). All four scores and the weakness are kept with the email (`arms.criticSpecific`, `criticRelevant`, `criticAsk`, `weakness`; no
text), a rewrite is told the weakness too, and the Monday memo names the commonest weakness once three drafts share it.
Since `critic.3` (2026-11-17, later that day): the reader sees the whole first email to an Intel agency and is told that the writer
wrote only its opening, so it judges the opening (does it make you open the report?) and never scores opening with the county or the
report as a weakness. Scores under `critic.2` and `critic.3` judge different emails and are not compared.

**Money.** A brief costs about 30 to 45 cents (research on the draft tier, the brief on the top model); a first email on the top model
about 7 to 15 cents, the review about a cent. The migration raises the Marketing Manager's daily budget to $15 (owner decision
2026-11-16), enough for about 25 briefed and reviewed first emails a day. Nothing spends it until the settings are on.
`server/agents-growth-brief-integration.mjs` runs the database side through the real roles in CI.

## Spending the day's cold emails well, and acting on interest (2026-11-17)

Stage 2 of the [November 17 review](AI_WORKFORCE_REVIEW_2026-11-17.md) (`20261117190000_growth_priority.sql`, feature
`platform.agents.growth-priority.v1`). Ten cold emails a day is the whole machine, and on November 16 they went to whoever was approved
first, a third of them on a Sunday afternoon. Each switch below is under Settings → Customer growth and starts off.

- **Send to the best prospects first** (`growth.send_priority`). The day's growth emails go out band by band
  (`private.growth_priority_band`): 1, a follow-up to an agency that opened its report; 2, a first email with an account brief to a named
  person whose mailbox was confirmed; 3, a first email with a brief; 4, the rest. Within a band, by fit, and ten points an hour of
  waiting (at most what three bands are worth), so nothing waits forever (`private.growth_action_score`). Every other kind of action keeps
  its place ahead of them. The drafting sweep reads the pipeline in the same order, and each first email keeps its band (`arms.band`), so
  the memo can compare bands. An email over the day's cap waits for the next Eastern day instead of being tried every 15 minutes. An
  agency's first open of its report brings its second email forward to the policy's own gap after the first (72 hours) instead of four
  days (`growth_report_open_followup`, no new version, so colleagues' emails on the same touch are not cancelled).
- **Send cold email from this hour / until this hour** (`growth.send_from_hour`, `growth.send_until_hour`). Eastern time, Monday to
  Friday; the "until" hour itself is outside (16 stops at 4 pm). The send claim refuses a cold email outside them (`outside_hours`) and it
  waits for the next opening (`private.growth_next_send_at`). Replies and customer emails are never held. Both empty, or "until" not
  after "from": any time, as before.
- **Test a short first email** (`growth.short_first_email`): **retired on 2026-11-17** by the owner's decision. It wrote half of the
  Intel first emails that link the agency's own report short (the report and one question, with the trial in the second email). Every
  first email built around a market report now has one form, a short opening and the email's own sections (see
  [Each agency's own market report](#each-agencys-own-market-report)), so the switch is gone from the Settings page. Its row stays in
  the database, because the stage's release gate checks for it (`retiredSettings` in `server/hub-settings.mjs`). Each such email still
  records `arms.form` as `short`, which the database reads as the first email's form (`first_form`); the weekly memo no longer compares
  forms.
- **Follow up when a prospect who replied goes quiet** (`growth.quiet_followup`). A prospect whose latest word was a reply with interest or
  a question, which was answered by email, and who has not written since, gets at most two short notes: four days after our answer, then
  five days after the first note (`private.growth_quiet_candidates`). Each is a customer email (purpose `success`, the Sales follow-ups
  step), drafted and checked like any growth email, with the same send claim, caps and opt-out link; a reply, a no, a "not now", a
  meeting, a trial, an opt-out or a complaint ends them. The note asks whether the answer helped and gives the one self-serve next step; it
  never says it noticed anything the prospect did. The fixed acknowledgment ("we have your request and will reply here",
  `private.agent_growth_acknowledgment`) is not an answer: a prospect who got only that gets no follow-up until someone answers
  (`20261117260000_review_repairs.sql`).
- **Give the Sales Executive the account brief** (`growth.sales_context`). When drafting a reply to a prospect, the Sales Executive also
  reads the brief's writer part (never the research part, so never a leader's name, a fit or the agency's own standing), which of our
  emails was answered (its touch, subject and form) and whether the report was opened (yes or no), through
  `private.sales_growth_context` (`sales.6`). It must never say or imply that it knows the report was opened (check `mentions_open`), and
  never state the agency's own share, rank, ratings or patient counts (check `own_standing`).

Plain fixes (no switch):

- **Briefs only for an agency that can be emailed.** Ten of the 22 briefs written by November 16 were for agencies with no address; a brief
  now needs the opportunity's contact to be permitted.
- **The brief's write-up has a ceiling.** It holds what is left of "Most to spend on one account brief" after the research
  (`ceilingCents` on the model call): a shorter answer when that fits, no call when even 1,500 tokens would not.
- **The memo compares report opens until there are replies.** Each arm also counts the sent emails that linked the agency's own report and
  how many of those agencies opened it within 30 days (`private.growth_learning_facts`). An arm that cannot be compared on replies is
  compared on opens: at least 15 such emails for each value, the best with at least 3 opens and a lead of at least 10 points. Band and
  "opened" are never compared on opens, because an open is what decides them.

`server/agents-growth-priority-integration.mjs` runs the database side through the real roles in CI, twice.

## Reaching the right agencies, and checking the writing (2026-11-17)

Stage 3 of the [November 17 review](AI_WORKFORCE_REVIEW_2026-11-17.md) (`20261117210000_growth_reach.sql`, feature
`platform.agents.growth-reach.v1`), with the owner's decisions of that day.

- **Agencies under pressure first** (`rankTarget`, `pressureWeights` in `server/growth/roster.mjs`). Each roster read also asks Intel's
  `agency_facts` for the page's open agencies (25 a call) and keeps, in the target's facts, the county and state share and rank, the
  HHVBP payment adjustment and its year, and the Hospice Care Index. They are research only: never in the claim, the research line or an
  email (the `own_standing` check is unchanged). The rank adds: a share under 5% of a county with 10 or more agencies +8 ("Small share of
  a crowded county"), an HHVBP payment adjustment below 0 +8 or of -2% or lower +10 ("Medicare pay cut"), home health quality stars of
  2.5 or less +5, a Hospice Care Index of 7 or less +5; it takes 10 from the county's leader (first among 3 or more) and 3 from stars of
  4.5 or more. A new certification (+25) and a new owner (+20) still lead. When the feed refuses or the run's time is spent, the rest are
  ranked without these figures until the next weekly read. The rank decides which agencies are looked up first.
- **A web search for agencies not found** (Settings → Customer growth → "Search the web for roster agencies not found", "Most agencies to
  search the web for a day", "Most to spend on one website search"; task `growth.sites`, hourly, `server/growth/site-search.mjs`). An
  agency the name and phone searches did not find (`no_site` or `not_confirmed`), not searched in 30 days, gets one web search by the
  Marketing Manager: the model is told only its name, city, state, setting and CMS telephone number and names at most two candidate
  sites, never a directory or a government site. Each candidate is read by the contact finder and checked exactly as a lookup's
  (`confirmsSite`: the CMS number on its pages, or the agency's name and place on its home page; the shared-host rule); a confirmed one
  graduates through `private.growth_roster_resolved`, as a lookup does. An unconfirmed candidate is only a suggestion on Growth ("Suggested
  by a web search, not confirmed"); nothing is sent to it, and there is no button to use it (owner's decision).
- **A live writing evaluation each Monday** (Settings → Customer growth → "Run a live writing evaluation each Monday"; task
  `growth.evaluate_live`, 06:50 Eastern, `server/growth/live-evaluation.mjs`). Twelve made-up Intel agencies (invented names, `.example`
  sites, CCNs 990101 to 990104, no person, address or telephone number) cover the four triggers (a new agency, a new owner, a CMS record,
  the web), each with three of the four pairings of brief or none and the agency's own report or the market report page (until
  2026-11-17, short or standard). Each is written on the real writer, with the active memo and the top model as the settings say, and
  read by the reader (`critic.3`). The run passes when every draft passes the
  checks, the reader scored every draft, the average "would reply" is at least 3.5 and none is below 2. Each grade is kept as it is
  written (`private.growth_live_eval_cases`, 120 days), so the twelve run over a few tries inside the scheduler's limit. The result is
  recorded as `growth.live.1`, never `growth.1`, so it never holds up sending; the Monday scorecard reports it, and you are told only when
  it does not pass. A day's budget running out ends it as not finished. About $1.50 to $3 a week from the Marketing Manager's budget.

`server/agents-growth-sites-integration.mjs` and `server/agents-growth-live-eval-integration.mjs` run the database side through the real
roles in CI, twice each.

## The outgoing email review (2026-11-17)

A review of every email the Hub sends, read against the real messages of the previous two weeks
(`20261117220000_email_review.sql`; no new feature: the server reads the new keys as absent until the migration is applied, and
behaves as before).

- **What a draft may not say, now also checked when it is sent.** Between November 8 and 15, 23 cold emails promised an Intel trial
  with "no credit card", after Intel's trial began to need one; the draft check added on November 15 (`trial_terms`) stopped new ones
  but not an email already approved and waiting for its turn under the caps and send hours. Each growth email is now read again when it
  is claimed for sending (`outdatedWords` in `server/growth/draft.mjs`): an Intel trial with no credit card, a sentence that implies we
  saw the reader open something we sent, or Intel's internal word "the book". One that fails is never sent: it is withdrawn
  (`private.growth_withdraw_message`: cancelled, its claim undone so it counts toward no cap, with `withdrawn_at`, so the next sweep
  writes that work again under today's rules) and recorded as `growth.message_withdrawn` in the audit log. Before the migration is
  applied it is marked failed instead.
- **Two more draft checks** (`draftProblem`, writer `growth.16`). `mentions_open`: never say or imply the reader opened, viewed or read
  what we sent ("thanks for taking a look at the report", "now that you have seen where your agency stands"); the Sales Executive's
  check of the same name now reads the same patterns (`server/growth/opens.mjs`). `jargon`: never "the book", Intel's word for its
  list of referral sources and accounts, which the writer had copied from the fact sheet ("shows what the book says about why" went
  to an agency on November 16). The writer is told both, and each has a repair hint.
- **The market report is described as Intel describes it.** The first email's instructions said the report shows "the hospitals and
  physicians who refer the most"; public Medicare data does not show who referred whom (GTM facts). It now says "the hospitals its
  county's residents use and the physicians Intel ranks highest as referral sources", and the trial is "the way to see the referral
  sources in a county they serve" (the trial covers one county), not "every source in their territory". (Later the same day the
  physicians became "the highest-ranked physicians for outreach": the rank check refused "ranks highest". See
  [Each agency's own market report](#each-agencys-own-market-report).)
- **A quiet follow-up is signed by the founder.** It goes to a prospect, from the growth sender, like the rest of the prospect's
  emails, but was signed "The CareMetric Intel team". The send claim now says which email is a quiet follow-up (`quiet`), and it is
  signed as the founder. Customer emails keep the product team's sign-off (owner direction 2026-11-12).
- **"Prospect emails are ready on Growth"** replaces "Customer growth work is ready", which came eleven times in one week, around
  midnight, as "312 follow-up tasks reviewed; 0 message drafts prepared". It is sent once a day per agent, and only when an email was
  written.
- **A separate growth sender on a domain of its own** works as well as a subdomain, but the domain must be authenticated (DKIM) in the
  same SendGrid account as the Hub's key. Otherwise SendGrid signs with its own domain, DMARC fails, and a domain with a quarantine
  policy sends the email to spam while SendGrid reports it delivered. Send one email to a mailbox you own and check that it shows
  DMARC: pass.

## Checking an address before the first email, and the bounce guard

Owner decision 2026-11-16 ([review](AI_WORKFORCE_REVIEW_2026-11-16.md)). Of the first 22 cold emails, 3 bounced (14%), all to
addresses read from the agencies' own websites. Mailbox providers judge a sender by its bounces, and the rule for raising "Most cold
emails a day" is under 2%. Two settings, both off until you save them (`20261116100000_growth_address_check.sql`, gate
`20261116100100_growth_address_check_contract.sql`, feature `platform.agents.growth-address-check.v1`):

- **Settings → Customer growth → Check an address before the first email.** Before the first cold email to an address (a role
  address such as info@, a named person, an imported one), the Marketing Manager's `growth.verify` task (every half hour,
  `server/growth/verify.mjs`) asks the business's own mail server whether the mailbox exists, with the same checker the people finder
  uses: a made-up mailbox first, then the address, from the null sender, and the conversation ends before anything is sent. Addresses
  with an email already waiting go first, then the best fit. Until the answer arrives, no first email is drafted (no model call is
  paid for it) and one already approved waits.
  - *Exists*, or a server that accepts any address (it can say no more): the email goes as before.
  - *Does not exist*: the contact becomes **undeliverable** (a new eligibility; only "permitted" is ever written to), its waiting
    emails are cancelled, the business's never-emailed opportunities may take another contact, and the people finder looks there
    again. Unlike "Do not contact" it says nothing about the business's wishes, so it never blocks a named person there. You can
    change it on Growth.
  - *No answer* (a greylisting or silent server): asked again after 16 hours, three times at most. Then **Check** sends as before;
    **Strict** sends the address to your review (eligibility "Needs review") instead. Since 2026-11-17 the contact keeps why the
    latest unanswered try got no answer (`mailbox_reason`: `temporary`, `blocked`, `refused`, `sender_refused`, `unexpected`,
    `dropped`, `no_mail`, `invalid`, `unreachable`, `error`, or the STARTTLS reasons below; never the server's words), also after a
    later try answers, and each
    run counts them (`why`). On the first day 25 of 47 addresses went unanswered; these say whether asking again ever helps.
  - It needs Railway's Pro plan (port 25), like the people finder's checks, and is not counted in "Most address checks a day". When
    three servers in a row cannot be reached the checker rests six hours and spends no tries. A server that gives no clear answer
    sends the address to the verification service while that is switched on (see "Finding decision-makers and their addresses"):
    one check, within its own daily number.
  - Since 2026-11-17 ([review](AI_WORKFORCE_REVIEW_2026-11-17.md): 25 of 44 checks had no answer and nothing said why):
    - A server that offers STARTTLS is asked over TLS, as servers that refuse a plain sender expect (the certificate is not checked:
      nothing but the questions crosses it); one that asks for TLS without offering it says so (`tls_required`), and a TLS
      conversation that fails is `tls_failed`. Both are kept on the contact and counted with the other reasons (`why` in the
      `growth.verify` and `growth.people` results), so a paid checking service is decided on the reasons, not guessed.
    - An address the people finder already confirmed with the business's mail server is recorded as confirmed, so the check does not
      ask the same server again.
- **Settings → Customer growth → Pause cold email at this bounce rate** (1 to 50; empty: off). When two or more cold emails sent in
  the last seven days bounced for good and they are more than this percent of those sent, counted as at least 20 (so 2 bounces in 10
  emails trip it at 5% and 1 does not; review 2026-11-17: at ten a day the old "at least 20 of them" never filled and 4 bounces in 32
  emails never tripped it), or anyone marked one as spam, cold email waits: no first
  email is drafted and every approved cold email is held before the send claim, tried again every 15 minutes. A soft bounce (a full
  mailbox, a server that was down) does not count. Replies to people who wrote in and customer emails are never held. You are told
  once a day ("Cold email is paused") and resume it on Growth → Send guard → **Resume cold email**, which starts the seven days
  afresh (audited as `growth.cold_email_resumed`). A trip holds until you resume or change the number: the bounces behind it leaving
  the seven days never start cold email again by themselves (`private.growth_send_guard.tripped_at`). Saving the number also starts them afresh, so bounces from before you switched the
  guard on never trip it. 5 suits a small volume.

The send claim (`private.growth_claim_message`) is unchanged and still decides every send; the checks above only make an email wait.
Growth → Send guard shows the mode, the guard's counts and how many addresses were confirmed, accept anything, do not exist, have not
answered yet or are waiting. `server/agents-growth-address-check-integration.mjs` runs all of it through the real roles in CI.

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
- **Who.** People at the same organization other than its contact, permitted (by you, or on their own while **Named people's email
  addresses** is handed over) and verified within 90 days, not unsubscribed,
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
  organization and stops its cold outreach for good; the person who opted out is suppressed as before. A request to stop written in
  a reply ("please remove me") stops the organization the same way, also after a "not now" reply would otherwise let it be reopened
  later (`private.growth_outreach_stopped`: someone there who is opted out and has written to us). A hard bounce of the
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

**An Intel trial counts from its card** (`platform.agents.trial-path.v1`, `20261117230000_trial_path.sql`, team review 2026-11-17,
stage 4). Intel asks the Hub to open its trial when someone opens card setup, and Stripe starts the trial before any card is entered,
so a trialing Intel subscription proves nothing. The mirror no longer queues `trial_started` for one: the first time Stripe confirms its
card (`private.billing_trial_cards`, written on every entitlement check) queues it, once, under the same key, and
`private.growth_trial_cards` keeps when that was after the trial ends (for the trials live when this was released, their start:
`20261117260000_review_repairs.sql` corrects the time the release copied from the last entitlement check). A CareBase trial, which needs no card, still counts when it
starts. A counted trial that ends (canceled, expired or paused) with nothing ever paid on it is queued as `churned`
(`billing:trial_lost:<subscription>`); a sign-up that never added its card was never a trial and is not lost either. An extended
trial's new end date reaches its opportunity. Intel may also send three milestones as `active` events (`facts.metric`:
`county_chosen`, `agency_saved`, `activated`); the Account Manager's facts read whether the county was chosen.

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


### Personalized report rendering and learning

Apply `20261115234000_growth_report_learning.sql` before deploying the report-label change: it allows the
noncomparative `report` variant and replaces the learning aggregate. Report-led Intel first touches retain
the 170-word instruction and angle/subject experiments; ordinary messages retain control/concise length.
The send renderer checks the existing report-token signature and expiry, exact Intel origin and path;
the draft validator still accepts only the specific report offered to that opportunity.

Historical `growth.11` messages did not persist their prompt version or applied word limit. The learning
query therefore omits only the length dimension of unmarked Intel cold first touches created on or after
November 15, 2026 UTC, including drafts delivered later. This conservatively omits any earlier non-report
first touches on that date too. Prior sends establish later touches; inbound, re-ask and CareBase lengths,
all angle/subject counts, and overall delivery counts remain available. New rows carry `length_basis`.
No historical message rewrite is needed. Previously saved learning memos are unchanged; review or replace
any existing memo containing a length conclusion based on the affected rows after rollout. This change
does not resend existing email or alter reports already delivered.
