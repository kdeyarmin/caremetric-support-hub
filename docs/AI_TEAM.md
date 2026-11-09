# AI team control plane

The Hub is where the CareMetric AI team lives. This document describes the control plane that
runs it: who the agents are, what each is allowed to do, how the owner stays in charge, and what
is built so far.

> **Status.** The database layer, the server scheduler, the `/admin/team` screen, the Platform
> Engineer's health probes, the Chief of Staff's morning brief, the SEO Analyst's weekly report, the
> Support Concierge's triage of new conversations, with the fixed replies it offers the owner, the
> Account Manager's weekly report on how each customer account is doing, with the short customer emails it
> proposes for the owner to approve (see "Customer emails"), and the Growth Manager, which makes sure no website
> lead waits (see "The Growth Manager"), are in
> place, and so is the model runtime they share (see "The model runtime"). The Content Marketer drafts one public
> help-center article a week for the owner to approve and a month's outreach drafts for the owner to send (see "The
> Content Marketer"); its model calls carry no customer text. The scheduler is inert
> unless `HUB_AGENTS_ENABLED` is exactly `true` and every agent is seeded **paused**. Only the Concierge
> can send customer text to a model, only to draft an answer to a plain question, and only while the owner has set
> `HUB_AGENTS_CUSTOMER_TEXT_TO_AI` to `true` ("Drafted answers"); otherwise customer message text never
> leaves the Hub. The SEO Analyst also calls the model, with the company's own public pages only, to suggest
> titles and descriptions ("The SEO Analyst").
> The Marketing Manager and shared customer-success workspace add CareBase and Intel prospecting, activation and retention workflows. See [Customer growth](CUSTOMER_GROWTH.md) for their separate controls and activation. Breathe remains deferred.
> The **Sales Executive** answers CareBase and Intel prospects with drafts checked against the go-to-market fact sheet and sends a
> weekly pipeline review (see "The Sales Executive"). The revenue agents share one sales playbook, `server/growth/playbook.mjs`. The
> [November 8 workforce skills review](AI_WORKFORCE_SKILLS_REVIEW.md) explains why.
> The **Social Media Manager** runs the Facebook Page, Instagram, the LinkedIn Page and the Meta and LinkedIn ad accounts for engagement: a weekly post plan,
> replies to comments and messages, a daily ad review that pauses, refreshes and (only with your approval) re-budgets ads, and a
> weekly report. See [Social media](SOCIAL_MEDIA.md).
> The **Monday scorecard** from the Chief of Staff replaces the five weekly report emails with one: six numbers per product beside
> last week's, what changed, and at most three decisions (see "The Monday scorecard" and [Monday scorecard](MONDAY_SCORECARD.md)).
> **Only CareMetric Intel is marketed** while CareBase is in its pilot. You switch products on and off under "Products we market" on
> the AI team page (see "What the team markets").

## What the team markets

On 2026-11-08 the owner decided **CareBase stays in a pilot** with a few facilities the owner chooses, and the team markets
**CareMetric Intel only**. The owner switches each product on or off under **Products we market** on the AI team page; the switches
live in the database (`20261108210000_marketing_switches.sql`, gate `20261108210100_marketing_switches_contract.sql`, feature
`platform.agents.marketing.v1`) and every marketing task reads them when it starts (`server/agents/marketing.mjs`), so a change applies
to the next run without a restart. They decide it for every agent:

- **Marketing Manager:** discovers, scores and emails prospects for marketed products only. A prospect of another product gets no
  research, plan or email. The five CareBase prospects found on 2026-11-08 were moved to `nurture` with the note "held for the CareBase
  pilot".
- **Social Media Manager:** posts, links in replies, new ad copy and budget increases for marketed products only. A comment asking about
  CareBase is left for the owner. A losing CareBase ad may still be paused, which only lowers spend.
- **Content Marketer:** help-center articles and monthly outreach drafts for marketed products only.
- **Sales Executive:** drafts no answer about a product that is not marketed. A first message still gets the fixed acknowledgment, and
  the owner is emailed that the conversation is theirs to decide (for CareBase, whether that organization joins the pilot).

Customers are not marketing: the Account Manager's onboarding, trial, renewal and support work for CareBase customers (the pilot
facilities) goes on.

Intel starts switched on; CareBase and Healthcare Advisors start off. To market CareBase when its pilot ends, press **Start marketing**
beside it. Every change is audited (`agent.marketing`), and a change made from an out-of-date page is refused. Until the switches'
migration is applied, the team markets Intel only.

## The model

| Piece | Table | What it holds |
| --- | --- | --- |
| Agents | `private.agents` | One row per agent: status (active or paused), autonomy, model tier, daily budget, tool allowlist, prompt version and settings |
| Schedules | `private.agent_schedules` | When each agent's recurring work is due: every N seconds, or daily at a local time (America/New_York) |
| Tasks | `private.agent_tasks` | The work queue. Every task has a unique request key, so an event or schedule firing can be enqueued any number of times and runs once |
| Runs | `private.agent_runs` | One row per model execution: model, tokens, cost and a short redacted summary. The day's cost against `daily_budget_cents` is the agent's budget |
| Actions | `private.agent_actions` | Every side effect an agent wants: a reply, a note, an incident, an import. Proposed, then approved or rejected by the owner, then executed |
| Owner notifications | `private.owner_notifications` | Messages to the owner (SMS or email) with a dedupe key, so an alert is sent once |

## Autonomy and approvals

Each agent has one autonomy level, changed only by the owner:

- **observe**: reads and reports. It cannot propose actions.
- **propose**: drafts actions. Every one waits for the owner to approve it.
- **act**: carries out the action kinds listed in the agent's `auto_approve_kinds` setting on its
  own and proposes everything else. A customer email (`email.send`) is the exception: it goes out on its
  own only when its template is listed in the agent's `auto_send_templates`, never for its kind.
  See "Customer emails".

An approved action is carried out by the server through the existing reviewed path (for a reply,
the same staff reply operation the inbox uses, under the action's request key), so a retry can
never send twice. A proposal nobody decides within seven days expires.

The owner can also prepare a one-off operational email from the Team screen. It records the exact
recipient, subject and message for review, then uses the existing **Approve and send** control. The
`email.external` action always requires an explicit owner decision, regardless of the Chief of
Staff's autonomy or automatic approval settings. Its private send ledger permits one attempt and
retains an uncertain provider outcome without resending. See [Owner-directed email](OWNER_DIRECTED_EMAIL.md).

Nothing here lets an agent move money, change a plan or price, delete data, merge code, deploy,
or read resident or patient records. Inbound message text is `possible_phi` and never enters audit
metadata, run summaries or task payloads.

### Autonomy steps: a supervised week, then on its own

The owner hands kinds of work over to the team one at a time (`supabase/migrations/20261104220000_agent_autonomy.sql`,
`private.agent_autonomy_steps`). Four ship, all off: **Account emails** (the Account Manager's four templates), **Support
answers**, **Article publishing** and **Offers**; **Sales follow-ups** and **Cold email** (the Marketing Manager's, see
[Customer growth](CUSTOMER_GROWTH.md#sales-follow-ups-and-capped-cold-email)) are added, also off, by
`20261105150000_growth_autonomy.sql`. Each step lists which agents it changes and what it adds to their
auto-approval lists (`auto_send_templates` for the account emails, `auto_approve_kinds` for the others: `communication.answer`
for support answers, `content.publish` for articles, `offer.apply` for offers, and the trust values `growth.sales_followup` and
`growth.cold_email`, which the growth operations read, for the Marketing Manager's two steps); only migrations write that list.
The Marketing Manager's email (both steps, and anything the owner approves) can come from its own sender on a subdomain,
`HUB_GROWTH_FROM_EMAIL`, with replies still going to the support inbox; every other agent's email stays on the support address
(see [A separate sender for prospecting](CUSTOMER_GROWTH.md#a-separate-sender-for-prospecting)).

- **Start supervised week** (Team screen, under "Work the team does on its own"): the step is supervised for seven days. Any
  agent it involves that could only observe moves up to Propose, and the step's values come off the agents' lists (one the owner
  had added by hand included), so every item of that kind waits for the owner's approval all week.
- After the week, the Chief of Staff's hourly `autonomy.graduate` task switches the step: each agent involved is set to Act
  and the step's values are added to its list, in one transaction, audited as `agent.autonomy_step` with source `schedule`.
  The owner gets an email the day before (`autonomy:soon:<step>:<time>`, only for a step whose code is on the Hub) and one at
  the switch (`autonomy:automatic:<step>:<time>`). A switch stays pending announcement in the database until that email is
  delivered (`private.agent_autonomy_announced`), so a refused send fails the task and is retried. The task runs whatever the
  Chief of Staff's own level is; pausing the Chief of Staff pauses it.
- **Keep approving** (hold) takes the step's values back off the lists, leaving anything another automatic step or the
  owner added, and keeps the agent proposing that work. **Make automatic now** skips the rest of the week.
- A step whose code is not on the Hub yet (its feature is not declared: `platform.agents.concierge-autosend.v1`,
  `platform.agents.content-autopublish.v1`, `platform.agents.offers.v1`, `platform.agents.growth-autonomy.v1`) can be supervised but not made automatic; a
  supervised step past its date switches as soon as the code arrives. The screen says so next to it.

The steps table is closed to every role. The server reads due steps and switches one through `private.agent_autonomy_due()`
, `private.agent_autonomy_graduate(text)` and `private.agent_autonomy_announced(text, timestamptz)` (Hub server only); the owner
reads and changes them through `hub.get_agent_autonomy()` and `hub.set_agent_autonomy_step(text, text, timestamptz)`
(`POST /api/admin/team/step`), which authorize the owner's session and lock the step before refusing a stale screen. Both go through one internal function,
`private.agent_autonomy_apply`, which no role may call.

## The Team screen

Platform administrators open **AI team** in the Admin navigation (`/admin/team`). It needs the owner's
SMS sign-in; a lapsed session signs the owner out, as everywhere else in Admin.

- **What the team can use** shows whether the scheduler, the code behind each kind of work, the owner's
  email address, email delivery and text alerts are in place, and how many tasks wait for the owner to be
  signed in, with a **Run what's waiting** button (see "Work that needs the owner's session").
- **Waiting for you** lists every proposed action with a preview. A reply shows the exact text that will
  go to the customer, a link to open its conversation in the inbox, and a button that says "Approve and
  send". The owner may add a note, then approves or rejects. Approving carries the action out once, under
  its request key, and the screen says whether it worked and, when it did not, why in plain words (the
  customer wrote again since the reply was written, the conversation was closed, the provider refused it).
- **Agents** shows each agent with Pause or Resume, its autonomy level, its daily budget (entered in
  dollars) and what it has spent today, its model, last run, task counts and schedules. **Run now**
  appears only for work this server has code for, and only while the agent is active. A change made from
  another device since the page loaded is refused and the screen reloads, so one edit never silently
  overwrites another.
- **What the team has done** has five tabs: runs, tasks, proposed actions, the alerts sent to the owner,
  and the Hub's audit log. Each shows 15 at a time, newest first. All but the audit log can be filtered
  by agent. Message text is never kept in any of them. An action that failed shows why, in plain words, next
  to its status (for example that the customer wrote again before the reply could be sent).

The screen checks every answer against the schemas in `src/admin/teamProtocol.ts`, and the server
integration test (`server/agents-integration.mjs`) parses the real database output with the same
schemas, so a change to the stored JSON cannot reach one side without the other.

## The Platform Engineer

The on-call agent. It uses no model and costs nothing. Every five minutes (task `probe.sweep`,
shown as "Health check") it asks each product's public health address for a page and records how
it answered:

| Product | Address |
| --- | --- |
| Support Hub | the Hub's own public origin, `/api/health` |
| CareBase | `https://cmcarebase.com/health` |
| CareMetric Intel | `https://www.caremetricintel.com/api/ready` (answers only when Intel's database does) |
| Healthcare Advisors | `https://caremetricadvisors.com/health` |

The list is fixed in `server/agents/targets.mjs` and nothing a customer, a task or the database
says can add to it. A product passes with any 2xx answer inside eight seconds. A redirect is a
failure, because a health address that redirects is not the address the product serves (Intel's
bare domain redirects to `www`, so the `www` address is the one checked). Breathe is not listed
until it has a confirmed health route. A page is read for at most 4 KB and thrown away; only a
status code, a latency and one fixed failure word (timeout, network, status or redirect) are kept.

The database decides what a check means (`private.agent_probe_record`, one row-locked statement
per product, so two overlapping sweeps can never open the same incident twice):

- **One failed check is a blip.** Nothing is sent. The run on the Team screen shows what was seen.
- **Two in a row open an incident.** The owner gets a text and an email ("CareBase is down"), and
  an `incident.open` record appears in the agent's actions. The message says when the first
  failed check was, what the last one saw, and that nothing was restarted or changed.
- **The first healthy check closes it.** One email says the product is back and for how long it
  was down, and an `incident.resolve` record closes the incident. A recovery never texts.
- **A relapse within thirty minutes** of a recovery is sent as a warning by email only, so a
  product that flaps cannot wake the owner again and again.
- **An alert that arrives more than an hour after the failure began** (the agent was paused, the
  server was down) goes by email only and says it is late.
- **An observe-only agent** still tells the owner about an incident but proposes no records.

Each incident and recovery has its own request key and alert key, so a retry sends nothing twice.
An alert is recorded before it is sent. When a provider refuses one (a temporary 429, say) the task is
retried, and only the channel that failed is sent again, a bounded number of times; a channel that is
switched off, or a send that may or may not have gone, is not retried, because that could send twice.
Every report that uses the same alert record (the brief, the SEO report, the account report) counts only a
message that was sent, now or by an earlier attempt, as delivered: a repeat that finds an earlier attempt still
pending, unknown or switched off says so instead of "sent". A sweep records a run on the Team screen only when it saw
something or changed something, and once an hour otherwise, so the page shows a pulse without
288 rows a day.

The agent never restarts, redeploys or changes anything. Restart proposals come later, behind the
owner's approval. A probe inside the Hub cannot see the Hub stop; keep the external check described
under "The Hub cannot watch itself" below.

### The lead forms

Every six hours (task `probe.forms`, shown as "Lead form check") the Platform Engineer also checks each product's main
lead form end to end, exactly as [LEAD_INTAKE.md](LEAD_INTAKE.md) says under "Probe mode". It runs only when the database
declares `platform.agents.growth.v1`.

| Form | Address |
| --- | --- |
| CareBase lead form | `https://xsqobvvreaovwibxwyvv.supabase.co/functions/v1/request-demo` |
| Intel lead form | `https://www.caremetricintel.com/api/public/demo-request` |
| Advisors consultation form | `https://caremetricadvisors.com/api/inquiries` |

The list is fixed in `server/agents/targets.mjs`, like the health addresses. For each product whose secret is set on the
Hub (`HUB_LEAD_SECRET_CAREBASE`, `_INTEL`, `_ADVISORS`, at least 32 characters) it posts the endpoint's own JSON body with
invented values (name "CareMetric Form Check", address `probe@caremetric.invalid`, which can never receive mail, and a message
that says the request is an automated check), signed with `X-CareMetric-Probe` and `X-CareMetric-Timestamp`. A product with no
secret on the Hub is skipped, never failed. A form passes when it answers 200 with `probe: true` and `forwarded: true` **and** a
test lead from that product reached the Hub in the last ten minutes. Otherwise the check fails with one word: `timeout` (no
answer within 20 seconds), `network`, `redirect`, `status` (any answer but 200, which is what a form that did not recognise the
probe, or whose secret does not match, gives back), `not_probe` (200 without `probe: true`), `not_forwarded` (the form could not
pass the test lead on; the Hub status it reports is kept) or `not_received` (it said it did, and no test lead arrived).

Each result is recorded under the form's own target (`carebase_forms`, `intel_forms`, `advisors_forms`) through
`private.agent_probe_record`, so a form follows the rules above: one failure is a blip, two in a row open an incident ("Intel
lead form is not working", by text and email, saying what failed and that checks run every six hours), and the first pass closes
it with one email. Because the second failure comes six hours after the first, a form's alert counts as late only after seven
hours. A test lead never opens a conversation, never alerts and never counts in a report. The secret, the request and the
form's answer are never logged or kept: a check keeps a status code, a latency, one failure word and the Hub status.

A form that does not recognise the probe treats it as an ordinary submission. Most need a captcha that the probe does not carry,
so nothing is stored; one that has no captcha may record it as a request from "CareMetric Form Check", whose message says the
form's `HUB_LEAD_SECRET` does not match the Hub's. Set each product's secret before the Hub's.

## The Chief of Staff

Writes the morning brief: one email at 07:00 Eastern (task `brief.daily`, shown as "Morning brief").
It uses no model. The email is composed from counts and times read in one server-only operation
(`private.agent_brief_facts`), so it always arrives and never says anything the database does not.
A model may later write the narrative on top of the same facts.

- **Needs you**: proposed actions waiting for your approval (and how long the oldest has waited),
  tasks waiting for your sign-in, each product that is down right now and since when, tasks that
  failed in the last 24 hours, urgent alerts that reached you by no channel, and subscriptions that
  are past due.
- **Yesterday**, the previous Eastern day from midnight to midnight: runs, tasks done and failed,
  actions carried out, incidents opened and closed, and what the AI cost.
- **Worth knowing**: trials ending within a week, agents that are paused, agents that reached their
  daily budget, and a text channel that is not set up.

When nothing needs you the brief says so. It is sent every day, so silence never has to be read
as "all is well". It carries only counts, product names and times: never a customer's words, an
address or an amount of money. Only live-mode subscriptions are counted.

The scheduled brief is keyed by the Eastern day it was due for (read from the task, not the clock), so a
retry, a restart or a second server sends it once, even a retry that runs after midnight. If the email
provider refuses the send, the task is tried again a few minutes later under the same key. A brief you start
with **Run now** is sent once per request and is not repeated by a retry. It goes by email only, since an incident
already texts you when it happens. If email is not set up or the send fails, the run on the Team
screen says the brief was written but not delivered.

### The Monday scorecard

Every Monday at 07:50 Eastern (task `scorecard.weekly`, shown as "Monday scorecard") the Chief of Staff sends one email in place of
the five weekly reports (`accounts.weekly`, `growth.weekly`, `seo.weekly`, `sales.review` and `social.report`). It uses no model.

- **Needs you**: at most three items, most urgent first, each with a button to the screen that handles it: products down, proposals
  waiting for approval, accounts that need attention, deals waiting on you, ads losing money and urgent website problems, as the brief and the
  five reports flag them.
- **Six numbers per product** (CareBase and Intel), each beside last week's: website visitors (only from a connected source; none is
  connected, so "Not connected", never an estimate), county reports and trial starts, activated trials (first `first_value` events),
  new paying customers and MRR (the Billing screen's maths), outbound email delivered, replies, bounces and complaints, and cost per
  trial (AI spend on agent runs, plus ad spend when an ad account is connected). Organic search clicks are added when Search Console
  is connected.
- **What changed**: every count that moved from the week before.

It reads what the reports already read (the brief's facts, the billing snapshot, the growth pipeline, the ad accounts, the SEO crawl
and Search Console) and one new server-only read, `private.agent_scorecard_facts`. A source that cannot be read is named and the rest
still goes out. The subject, stored body, run and task result carry counts only; money is only in the email's layout blocks. Every
scheduled run in an Eastern week shares `scorecard:<Monday>`, so the week is sent once; a refused send is retried under the same key;
**Run now** reports the last full week under a key of its own.

The owner's setting **Send the individual weekly reports** (AI team page, "Weekly reports") starts off. While it is off and the
Chief of Staff is working, the five reports' scheduled runs are held (`skipped: in_scorecard`) and send nothing; **Run now** on any
of them still emails it. With the Chief of Staff paused, or the setting unreadable, they email as before. Details:
[Monday scorecard](MONDAY_SCORECARD.md).

## The SEO Analyst

Checks the company's public websites once per Eastern week and emails what to fix. The crawl uses no model and reads
only public pages of the sites it is told about: Healthcare Advisors (`caremetricadvisors.com`), CareBase
(`cmcarebase.com`, with `caremetrictrain.com` as another address), CareMetric Intel
(`www.caremetricintel.com`), the help center (`help.caremetric.ai`) and CareBase's Framer home page
(`home.cmcarebase.com`). The list is fixed in `server/agents/seo/sites.mjs`, a check never leaves a site's own
host, and nothing a customer says can add a site. `outboundHosts` in the same file is everything the analyst
may contact: those hosts, their other addresses and Google's two Search Console endpoints.

It reads each site the way a crawler that does not run scripts (and most AI assistants) does: plain GET
requests that follow no redirect, at most 20 pages and 30 links a site, 8 seconds a request, 600 KB a
page and about two and a half minutes a site.

- **The site**: robots.txt exists and does not block everything (User-agent lines that follow one another
  are one group, as in RFC 9309), a sitemap exists and lists pages on the site, plain http redirects
  permanently to the site's own https address (an error answer, or a redirect to http or to another site, is
  a problem), and the other addresses for the site redirect to it with a permanent redirect (or name it as
  canonical). The home page is read first. When it redirects to another of the company's sites (the Framer page
  sent to `cmcarebase.com`, say), its redirects are followed across the company's sites only, at most five of
  them: a chain that ends at a page that loads means the site is checked no further, and the report says where
  it ends and asks only that every redirect be permanent; a loop, or a chain that ends in an error, goes nowhere
  or leaves the company's sites, is urgent.
- **Its pages**, which are the home page and the pages in the sitemap (or the pages the home page links
  to when there is no sitemap): reachable, HTML, not marked noindex, a title and a description of a
  sensible length that no other page shares, a canonical link, one main heading, enough text before
  scripts run, a language, a phone viewport, social sharing tags, structured data that parses, image
  descriptions, and links that work. Two addresses are the same page only when they match exactly: the
  path, the query and a trailing slash are case-sensitive (`/About` and `/about` are two pages, and so are
  `/pricing` and `/pricing/`), and only the site root is written either way. A canonical link that differs
  from the page's address only by case or a trailing slash is therefore reported. Each address and detail in a
  finding is cut to a fixed length (160 and 240 characters), so a very long address in a sitemap cannot make
  the email or the stored result large. A thin page (under 50 words before scripts run) that is built to be
  filled in by scripts (it has the element a single-page app framework renders into, such as
  `<div id="root">`, or loads a module script) is an **app shell**, and the report says plainly that search
  engines and AI assistants that do not run JavaScript see almost nothing on it.
- **Across the sites**: two of the company's hosts serving the same page split what search engines credit to
  it. Two sites that are both home pages for one product (CareBase's own site and its Framer page), a
  canonical link on one host that names another of the company's hosts, or the same title on pages of two
  hosts are reported once per pair of hosts as "pick one canonical home page", with an address on each, and
  counted as worth fixing. A page marked noindex counts for none of them.

Each finding is **urgent** (it could keep pages out of search results), **worth fixing** or **minor**. The
email lists each site's worst problems with an example page and scores each site out of 100 by how many
kinds of problem it has, so a problem on twenty pages counts once. It says when a site was slow or could
not be checked, and it quotes nothing a page says. A site that failed or stopped early is never reported as an
all-clear: with nothing found the email says "nothing found, but not every check finished". A page that looks empty to the check may look fine in
a browser, which is itself worth knowing: many crawlers and AI assistants see only what is there before
scripts run.

### Search Console (optional)

When the Hub service has `HUB_SEARCH_CONSOLE_CREDENTIALS` (a Google service account's JSON key, pasted whole;
a secret) and `HUB_SEARCH_CONSOLE_SITES` (the properties, separated by commas, exactly as Search Console names
them: `sc-domain:cmcarebase.com`, `https://www.caremetricintel.com/`; an address prefix is kept as written, so
write it with its final `/` as Search Console shows it), the analyst reads Search Console while it
crawls (`server/agents/seo/search-console.mjs`). It signs in as the service account with a JWT it signs itself
(RS256 with `node:crypto`, no Google library), exchanged at `https://oauth2.googleapis.com/token` for a
read-only token (`webmasters.readonly`) that is kept in memory until a minute before it expires. Each property
gets five `searchAnalytics.query` calls: the totals for the last 28 days of final data (ending three days back,
in Search Console's Pacific day) and for the 28 days before, and up to 250 rows by search, by page and by both
together. Every request goes to `oauth2.googleapis.com` or `searchconsole.googleapis.com` only, follows no
redirect, gives up after 15 seconds and is tried once more after a timeout, a dropped connection, a rate limit
or a server error; a token Google refuses is replaced once. A property that cannot be read does not stop the
others, and the report says why in plain words (for example that the service account is not a user on it). The
key, the signed assertion and the token never reach a log line, an error, a stored result or the email.

The report then gives, for each property, clicks, impressions, click-through rate and average position against
the 28 days before, with its top searches and pages, and across the properties:

- **Close to the first page** (striking distance): searches at an average position of 8 to 20 with at least 20
  impressions, most seen first. Moving these up is the cheapest win there is.
- **Seen often, rarely clicked**: first-page pages (average position 10 or better) with at least 100
  impressions, clicked less than half as often as a result in that position usually is. Their titles and
  descriptions are worth rewriting.
- **Your own sites compete** (cannibalization): searches for which pages on two of the company's hosts both
  appear, such as `cmcarebase.com` and `home.cmcarebase.com`, with at least 10 impressions between them.

A search that looks personal (an email address, or a phone number or another run of seven or more digits) is
left out of the report and away from the model. Searches are told apart by their whole text (only the label shown
is cut to 80 characters), and when two properties overlap (a domain property and an address prefix inside it) a
row both report is listed once, with the first property's figures, before each list is cut to five. These are
opportunities, not problems: they do not change the
count of things to fix. Without Search Console the report says once that it is not connected, and how to
connect it: in Google Cloud, create a service account and a JSON key for it, and enable the Google Search
Console API in that project; in Search Console, add the service account's email address as a user on each
property (Restricted is enough); then set the two variables on the Hub service and redeploy. The integration
setup panel shows whether they are set.

### Suggested titles and descriptions (optional)

When the model runtime is configured (`ANTHROPIC_API_KEY` is set), the analyst makes one call a week through
the shared runtime (the agent's `fast` tier, its daily budget, 50 cents as seeded, a run row and a usage ledger entry)
for up to five pages chosen by code: first the pages Search Console shows are seen often but rarely clicked,
then pages with no title, then pages whose title is too short, too long or shared, then pages whose
description is missing, the wrong length or shared. A page is offered only if it is in search results and has
at least 50 words of its own before scripts run, so an app shell is never guessed at. The model sees, for each
page, the site's name, the address, why it was picked, its current title and description, the start of its
visible text (2,000 characters) and the searches that show it: public text only, never customer data. The system
prompt is a constant (`server/agents/seo/rewrite.mjs`, version `seo-rewrite.2`), every page's text is escaped
into its own block, and the answer is a closed schema that names pages only by id.

Code checks each suggestion and drops the ones that fail: a title of 20 to 60 characters and a description of
70 to 155; letters, digits and ordinary punctuation only (no markup, quotation marks, emoji, symbols, links or
addresses); no phone number, even one the page shows; no word about money ("free", "paid", "price", "pricing",
"cost", "fee", "discount", "save" and the like); no claim about results ("best", "guaranteed", "HIPAA-compliant"
and the like), compliance among them ("become", "stay" or "be compliant", "compliance guaranteed", "pass your
survey" or "inspection"); no number the page itself does not use; the company's vocabulary (Assisted Living Facility or ALF and surveyor, never Assisted Living Residence, ALR or
auditor); and not the page's current title and description again, or another suggestion's title. The email
shows each suggestion that passes with its page and why it was picked, and says how many were dropped. Nothing
on any site is changed: the owner copies what they want. Without a model the section is left out. A model that
fails, declines, is over budget or would run past its deadline (the call must end within 200 seconds of the
task's start, so the report still goes out inside the scheduler's four minutes) leaves one line instead, and the
report goes out regardless. The call is paid for once per report: a retry in the same server reuses the checked
suggestions, and a report that already has an email under its own dedupe key (sent, on its way or tried) gets no
new call. The stored task result keeps scores, counts and codes only: no page text, no search and no suggestion.

The schedule fires every morning at 06:30 Eastern, because an interval schedule is limited to a day. The
weekly work catches up on the first available morning of the Eastern week; later mornings skip confirmed or uncertain attempts. **Run now** checks on any day and
sends a report every time, while the scheduled report is attempted once per Eastern week, with bounded retries for definite failures.
A task the scheduler has stopped waiting for sends nothing. The audit is read-only. With the customer-growth feature
and Propose mode, a separate task can propose product content briefs; see [Customer growth](CUSTOMER_GROWTH.md).
Turning audit findings into issues for the coder bot is a later step.

## The Support Concierge

Notices every new conversation in the Communications inbox within minutes and tells the owner. By default
it uses no model and keeps no message text: this is customer service by simple rules, so the owner finds out
quickly and nothing a customer wrote leaves the Hub. The owner can switch on drafted answers (see "Drafted
answers" below), which adds one model call for the plainest questions.

Once the Sales Executive is resumed, a CareBase or Intel prospect's message (a website lead, a sales inquiry or a reply to the
Marketing Manager's outreach) is handed to it right after the owner's alert, instead of getting the Concierge's fixed sales
acknowledgment; see "The Sales Executive".

Every five minutes (task `concierge.sweep`, "Look for new messages") it asks the database which
conversations have a newest inbound message that has **settled** (90 seconds old, so a burst of texts counts
once), is **recent** (within 72 hours, so importing old history never triggers a backlog), has **no reply or
note after it**, and has no task yet. Each message gets its own task (`concierge.communication`, "Triage a
message") whose request key is the message's id, so a message is triaged once however often the sweep sees
it, and a customer's next message gets a task of its own. A task is skipped, with the reason recorded, when
the conversation is closed, someone has answered since, a newer message has superseded it, its channel is off
or it is an automatic reply or an empty message.

Triage reads a minimal view of the conversation (`private.agent_communication_snapshot`: no contact name,
email address, phone number, organization or assignee, no internal notes, and the subject only for email,
because the subject of a phone-line message names the caller and a text's carries the number; it does say how
many times each side has written). It then:

1. **Screens for personal identifiers**: a Social Security number, a date of birth next to a birth word, a
   record, member, policy, patient or resident number, a Medicare number, a payment card number that passes
   its check digit. Words like "resident" or "medication" never flag on their own. The screen reports which
   kinds it found, never the text.
2. **Categorizes by word matching**: security, legal, outage, cancellation, billing, sales or general, or an
   automatic reply (`server/agents/concierge/rules.mjs`). The rules favour catching the urgent kinds over
   being right about the rest. A message counts as an automatic reply only when it opens like one: a label a
   mail system adds ("Automatic reply:", "Out of office:", "Undeliverable:") at the start of the subject or the
   message, a message that opens with a sender line from a bounce address ("From: ... mailer-daemon@..."), or an
   out-of-office opening sentence. An address that a person merely mentions ("send it to postmaster@...") or a
   notice they forward after a note of their own proves nothing. An urgent kind always wins over that guess ("our account was
   hacked while I was out of the office" is a security report), and so does a cancellation or a billing matter
   when only an opening sentence suggests an automatic reply.
   Only the first 4,000 characters of a message are read. A message that fills them is never quieter than a
   warning, the alert says the rest was not screened, and nothing is offered to the customer or sent to the
   model for it: it is yours to read. That holds even for a long message that opens like an automatic reply.
3. **Tells the owner**: an outage, a security concern or a legal matter is **urgent** (text and email);
   billing, a cancellation, a sales inquiry or a message with identifiers is a **warning** (email); anything else is
   **information** (email). Alerts say the kind of message, the channel, the product, the reference and how
   long ago it arrived, and "nothing has been sent to the customer". Never what the customer wrote. A prospect's
   message is a sales inquiry whatever its words say (a demo request may read only "Please contact me"): one in a
   conversation a website lead form opened (source `carebase.web`, `intel.web` or `advisors.web`), or in one filed as a
   `sales` or `advisors` inquiry, unless it reads as something urgent, billing or a cancellation. One filed as billing never is.

Alerts are capped so that anyone who can write to the support address cannot flood the owner (the count and the
send go through one at a time, so tasks running together cannot all read the same count): at most 20
individual emails a day at each level (the next one becomes a single rollup email for the day), at most
three urgent texts an hour (after that, urgent alerts go by email only), and one urgent alert per
conversation per day.

If the provider definitely refuses an alert (the delivery fails), the task is retried by the scheduler a few
minutes later, before anything else is done for that message. The retry goes out under the same key, so only
the channel that failed is tried again and one that was sent is never repeated; the notifier makes up to three
attempts per channel. A delivery the provider did not confirm is not retried, because it may have arrived. A
retry resumes the alert under its own key and channels, whatever the caps say by then (a refused try counts toward
them, and it must not turn the alert into an email-only one or a rollup because of itself). If the three tries are
used up and nothing reached you, the task fails and shows on the Team screen, instead of passing for an alert.

It leaves a run on the owner's screen for each message it triaged (model `none`, prompt version `rules.1`,
a summary that names the reference, the channel and the category).

**Fixed replies.** For a plain question it also proposes one reply for the owner to approve
(`communication.reply`; the exact text is the preview). All three are written once, in
`server/agents/concierge/templates.mjs`: an **acknowledgment** (the message arrived and a member of the team
will review it); when the question carries identifiers, a **notice** saying these channels are not set up
for patient or resident information and asking the sender to resend without names, dates of birth, record
numbers or health details; and, for a prospect's first message (above) that reads as a plain question or a sale,
the **sales acknowledgment**, in the owner's own voice: "Thank you for reaching out to CareMetric. I have your
request, and I will follow up with you personally today." When the owner's booking page is set (`HUB_BOOKING_URL`,
an https address of at most 200 characters, with no user name or password) it adds "If you would like to set a time
now, pick a time that suits you: <link>"; a text message carries the link only when it still fits one message. That
template is the only place the Concierge ever offers a link, and the only reply that names a day, because the owner
approves it the day it is sent. None repeats anything the customer wrote, mentions AI, a phone call or voicemail,
names a price or promises an outcome; a text message gets a shorter version that fits one message. A prospect whose
message carries identifiers gets only the notice. The owner answers everything else personally: an outage, a security
or legal matter, billing, a cancellation, a sale in an ordinary conversation, anything else from Healthcare Advisors,
and any follow-up in a thread the team already joined. That holds for how a conversation was filed as well as for its
words: one filed as billing (a phone-line message may read only "Please help") never gets a fixed reply or reaches the
model. The conversation snapshot names the system a conversation came from (`sourceSystem`, one of a fixed list) for
this; a database without the Growth Manager's migration does not, and then the inquiry type alone decides.

An approved reply is sent the way the owner would send it, through the inbox's own reply
(`communications.reply`): it authorizes the owner's live session, is recorded before it is sent, goes out
under the action's request key so a retry never sends twice, and is authored in the thread as the owner. So
it needs that session. It is sent in the same request as the approval, or, if that could not happen (a
restart, a lapsed session), the next time the owner presses **Run what's waiting**. The background clock
never sends it. Before sending, it checks that the conversation is still the one the reply was written for:
if the customer wrote again, or the conversation was closed, it sends nothing and says why. That judgement is
for a new message only: a reply already recorded under the action's key (a restart came after it was sent) is
settled on replay, whatever the thread has done since, instead of being reported as never sent. A reply nobody
approved is refused even for an agent trusted to act. A send the provider did not confirm is never
reported as sent and is not retried; it warns the owner to look at the thread first. So does a send the provider
answered whose delivery the Hub could not record (`delivery_unsettled`).

Every email the Concierge sends has one fixed subject, "Re: Your message to CareMetric support [CM-n]", never
the conversation's own: a subject that named a person or carried an identifier would otherwise be echoed back by
an automated reply. The owner's session reaches only executors that act as the owner (`sessionExecutor`), never
the others. A session that lapsed after the approval and before anything was sent is not a failure: on a database
with the hardening feature the action is handed back to approved (`release`) and waits for **Run what's
waiting**, and the background drain asks the database for the kinds it can run (and the button for the kinds that
need the session) before it limits the list, so replies waiting for the owner cannot hide an incident record.

### Drafted answers

The Concierge can draft an answer from CareMetric's published help articles for the owner to approve, in
place of the fixed acknowledgment. It is **off** until the owner sets `HUB_AGENTS_CUSTOMER_TEXT_TO_AI` to
exactly `true` on the Hub service (with `ANTHROPIC_API_KEY` set and the Concierge in **Propose**); the Team
screen's "Customer text to AI" row says whether it is on. The owner confirmed on 2026-11-02 that the
Anthropic agreement covers support messages. The Hub cannot verify that, which is why the switch is a
separate step and nothing turns it on by merging or deploying.

**What goes to the model.** Only a message that the rules call a plain question (not billing, a
cancellation, an outage, a security or legal matter, a sale or anything from the Advisors form), that the
identifier screen did not flag, that is the only message the customer has sent in its conversation so far
(a follow-up that arrives before anyone has replied is not a first message), with nothing yet sent to the
customer, that can be answered, and that matches at least one published guide. Everything the owner answers
personally stays in the Hub, and so does everything with an identifier. **Observe** mode never calls the
model. What is sent is the message, after spaces, tabs and non-breaking spaces are collapsed (so an address typed with extra
spaces is still found), with links, email addresses, phone numbers, dates, runs of six or more
digits, street addresses, post office boxes and state-and-ZIP endings replaced by words such as `[phone]`,
and `<`, `>` and `&` escaped (`redact.mjs`); an email's subject, scrubbed the same way, and no other
conversation's subject; the channel, the product and how many messages the customer has sent; and up to
three guides. Contact name, address, phone number, organization, assignee, internal notes and the reference
number are never sent. Names cannot be found by pattern, so they stay in; the checks below look for a draft
that repeats one.

**What the model returns** is one object (`prompt.mjs`, prompt version `concierge.2`, a constant that the
request's own text is never part of): a category, an inquiry type, an urgency, whether it thinks the message
carries personal information, whether the owner must act, whether the guides answer the question, which
guides it used and a draft. The customer's message sits in a block the prompt calls untrusted data, so a
message that tells it to ignore its rules or promise something is read as part of the question.

**What the code does with it.** The model never causes anything. Its reading can only add caution: an
ordinary question it calls urgent, or an outage, a security or legal matter, raises a second alert (text and
email, under the same caps) and offers no reply; an urgent reading raises that alert whatever the topic, so a
billing question it calls urgent is texted too; billing, a cancellation or a sale otherwise raises a warning and offers
none; personal information it finds gets the fixed notice that asks the sender to resend
without it, and a warning. A draft is offered only if every check in `draft.mjs` passes: it cites a guide
it was given; fits its channel (320 characters including the greeting for a text message, 1,500 otherwise);
has no markup, link, email address or phone number; passes the same identifier screen as the inbound
message; states no dollar amount or percentage the guides do not; mentions no call, phone, voicemail,
meeting or demo; promises no refund, credit, time frame or day; gives no legal, compliance or medical
advice; does not call itself an AI or mention its instructions; does not repeat a name or an
identifier-like word from the message that the guides do not use; and does not quote the message at
length. Assisted Living Residence and ALR become Assisted Living Facility and ALF, and auditor becomes
surveyor, instead of failing. A draft that fails is dropped and the fixed acknowledgment is offered
instead; only the name of the check is recorded, never the draft or the message.

**What the owner sees.** The same approval as any reply, with the exact text that will be sent (the greeting,
then the draft). It goes out as the owner, with no mention of AI, and is never auto-approved. The approval card
does not yet say that a text was drafted by the model: the Activity tab's run "Read CM-1042 …" and the task's
result (`draft: drafted`) do. The owner's alert is sent before the model is asked, so it is never delayed.

**When the model cannot help.** A used-up budget, an unusable or cut-off answer, a refused key and a model
that is down all end in the fixed acknowledgment, as does a transient failure on its third try (the first two
are retried with the scheduler's backoff). A refusal by the model's safety systems offers nothing at all, for
the owner to read. A refused key, account or model also emails the owner once a day.

**Cost.** Each drafted question is one call: the guides and the scrubbed message in, a short JSON object out,
at the agent's effort (`effort` in its settings: low, medium or high; the seeded value is medium). Expect a
cent or two on the draft tier; look at "Spent today" on the Team screen after the first day, and size the
budget from that. Messages that do not qualify cost nothing. Anyone who can write to the support address can
cause a call, so the agent's daily budget is the cap: once it is used up, drafting pauses until the next
Eastern day and every message still gets its alert and its fixed acknowledgment.

**What it watches** is set in the agent's `config`, which only SQL changes (the Team screen has no settings
editor): `channels` (default email, chat, web form and phone-line messages; text messages stay off until the
toll-free verification covers support texts), `settle_seconds` (90) and `window_hours` (72). Switch it on by
resuming the Concierge on the **AI team** screen, preferably in **Observe**, and press **Run now** on "Look for
new messages". Its handlers register only when the database declares `platform.agents.concierge.v1`, so a
Hub whose database lacks the migration still starts and the sweep stays due instead of failing.

### Answers it sends on its own

With `platform.agents.concierge-autosend.v1` (`supabase/migrations/20261105120000_concierge_answers.sql`), a drafted reply that
cites the guides, for a message in which no identifier was found, going back by email or chat, is proposed as its own action
kind, `communication.answer`, instead of `communication.reply`. The table admits nothing else as an answer (a check constraint:
template `drafted`, `classification.phi` false, one to five sources, route `email` or `chat`, the target its own conversation).
Fixed acknowledgments, the identifier notice, the sales acknowledgment and anything sent by text stay replies the owner sends.

An answer needs no owner session. The owner approves it during the support answers supervised week; once the step is
automatic it is approved on its own (the step adds `communication.answer` to the Concierge's `auto_approve_kinds`) and the tick's
drain sends it. `private.agent_answer_begin` (Hub server only) records it in the conversation as written by the CareMetric AI
Assistant, under the action's request key, before it is sent, and checks again in the same transaction that it may go: for an
answer nobody approved, the Concierge must still be active, on Act and trusted with answers (`answers_off`); the conversation
must not be closed (`conversation_closed`); the customer must not have written again (`thread_changed`); the drafted route must
still be available (`reply_refused`). A restart between recording and sending settles the recorded answer instead of sending a
second one. The email is the same as a staff reply's (fixed subject, "CareMetric Support" signature); the audit row's metadata
says whether it was approved by the owner or automatically.

## The Account Manager

Emails the owner every Monday how the customer accounts are doing (task `accounts.weekly`, shown as "Weekly
account report"), and proposes a few short emails to customers that the owner approves (task `accounts.lifecycle`,
shown as "Customer emails"; see "Customer emails" below). It uses no model and reads only what the Hub already
holds. Stripe's own customer emails (a failed payment, a trial ending, receipts) stay on; this agent never
sends or repeats those, and only tells the owner about them.

**What it reads** is one server-only operation, `private.agent_accounts_snapshot`, over the mirrored Stripe
data, the usage figures the applications report to the Hub and the support case counts. It never reads a
product's own data, so it needs no owner sign-in. The operation builds each account from a list of allowed
fields, so a column added to a billing table later cannot reach the report. An account is a tenant with a
Stripe customer or a subscription, listed by name, up to 200 for the report (the operation allows at most
500). For each it returns the plan and state, whether a billing email exists (never the address), the
subscriptions with their items, discounts and dates, invoice counts and amounts, the latest usage figure
against the one from four weeks earlier, and case counts. It never returns a billing contact's name or
address, a Stripe customer, subscription, invoice or item identifier, a case subject or requester, or a
message. The catalog's product and coupon identifiers stay in the snapshot, because the revenue maths matches
a discount to its items by them, and they never reach the email or any stored record. The Stripe mode filter
is the Billing screen's: the verified mode, or everything while the mode is unverified, and the email says
"Test data" or "Stripe mode not verified" when that applies.

**The health score** (version `health.2`, every weight in `server/agents/accounts/health.mjs`) is advice for
the owner and never changes a plan, a price or anyone's access. It runs from 0 to 100: 75 or more is healthy,
50 to 74 is watch, below 50 is at risk. An account that has been billing for under 14 days is "new" and has no
score, and one with no live subscription is "inactive". Each point off has a reason the email shows, so a
score never appears without why. Missing or stale adoption evidence produces an unknown score, and stopped or sharply dropped use requires attention even if the numeric score would otherwise be healthy.

| Reason | Points off |
| --- | --- |
| Subscription unpaid, past due, an overdue invoice, or the customer marked delinquent | The largest of these (50, 40, 25, 20), once |
| Cancellation scheduled | 35 |
| Account closed but still billing | 30 |
| Usage stopped, or dropped by a quarter or more | 25, or 15 |
| Account suspended | 20 |
| A high-priority case is open | 15 |
| Trial ends within 7 days, subscription paused, several open cases | 10 each |
| No billing email on file | 5, or 15 while a past-due or trial customer has no other way to hear from us |

A case waiting on the customer is not held against the account. Usage is compared with the newest report at
or before 28 days earlier, with a fresh reading within seven days and a baseline within 42 days. Billing quantities alone do not prove adoption. Missing telemetry is shown as unknown. An
overdue invoice is an open one more than three days past its due date, or past its creation when it has none.

**The email** lists, in this order: who needs you (payment trouble, a cancellation scheduled, shown with the date it takes effect first, a trial ending
within a week, a high-priority case, a closed account that still bills, anyone at risk), annual and
multi-month plans renewing within 30 days (a plan with a cancellation date at or before its renewal is
cancelling, not renewing, and appears only under who needs you; an account with several plans renewing in the
window shows the first date, the number of plans and their yearly total), accounts whose usage is growing, then revenue (MRR, ARR, trial MRR,
new and lost subscriptions this week, past due) and how many accounts are in each band. Each list shows at
most ten rows and then "And N more"; names are clipped to 60 characters and escaped. With the growth migration, reports page through the entire account population before ranking it. The revenue figures use the same functions as the Billing screen
(`src/billing/billingMath.ts`): paying and past-due subscriptions after discounts count as MRR, trials are
counted apart, and ARR is twelve times MRR.

**What is stored** is counts only. The email's subject, the stored body (also the preview), the task result and
the run summary hold numbers: no account name, amount or address. Names, reasons and amounts are in the email's
blocks, which the notifier never stores. The report never texts.

**When it sends.** The schedule fires every morning at 07:15 Eastern (an interval schedule is limited to a day)
and every run in an Eastern week (Monday to Sunday, found from the calendar date, so the two nights the clocks
change cannot move it) uses the same alert key, `accounts:weekly:<Monday>`. The first run of a week sends and a
later one finds it already sent, so a server that was down on Monday reports on the next run and a restart or a
second server never sends twice. A failed delivery is retried by the notifier up to three times. A week whose
email was switched off (not set up, so recorded as suppressed), or whose earlier attempt is stuck or unconfirmed,
is not sent again by itself and the skipped run says `earlier_attempt_unconfirmed` instead of `already_sent`:
press **Run now**, which always sends a fresh report under a key of its own. The agent starts paused and observe-only, and in
observe it proposes nothing.

Its handler registers only when the database declares `platform.agents.accounts.v1`, so a Hub whose database
lacks the migration still starts and the schedule stays due instead of failing. The declaration needs the
control plane and the platform billing mirror.

## The Growth Manager

Makes sure no website lead waits, and shows the owner where customers come from. It uses no model, reads leads only
through server-only operations that return no contact name, address, phone number or role and nothing a visitor wrote,
and **sends nothing to a customer**. It starts paused and in Observe, and proposes no actions. Its handlers register only
when the database declares `platform.agents.growth.v1` (which needs the control plane, the probes and the lead desk), so a
Hub whose database lacks the migration still starts and its schedules stay due.

- **New leads** (task `growth.leads`, every five minutes, "Look for new leads"). Each lead that is not a test, from the last
  24 hours, is looked at once (`private.agent_growth_pending`, then `agent_growth_mark_seen`). A **trial sign-up** emails the
  owner at once as a warning: "New CareBase trial: <organization>", with the product, the plan when the product sent one, the
  other facts (the plan always among them) and where the visitor came from, and a button to Leads, under `growth:trial:<lead id>`.
  A demo, consultation or contact request is left to the Support Concierge, which alerts on its conversation (see above). A
  newsletter sign-up, savings model or county report waits for the morning brief and the weekly report. A trial alert the provider
  refused leaves that lead unseen and the task fails transiently once the others are handled, so the scheduler tries it again and
  only the refused channel is sent again; one that used up its tries is set aside (the brief still counts the lead). Marking a lead
  seen never changes its version, so the Leads screen never refuses the owner's change because of it. A run is recorded when
  something arrived, and once an hour otherwise.
- **Unanswered leads** (task `growth.followup`, every fifteen minutes, "Chase unanswered leads"). A lead conversation is
  waiting when its lead is not a test and still `new` on the Leads screen, its conversation is not closed, and nothing after the
  lead's first message answers it: an internal note, or a reply that was not refused. A reply whose delivery failed reached nobody
  and answers nothing; one still pending or of unknown outcome may have gone, so it counts. The owner gets one reminder per lead
  and step of the agent's `followup_minutes` (default an hour, then a day), by email, as a warning: "Still unanswered after 1 hour:
  demo request CM-1042", naming the product and how long it has waited, under `growth:followup:<lead id>:<step>`. A lead found
  late gets only the largest step it has reached. `private.agent_growth_unanswered` leaves out the steps already reminded before
  it limits its list to 50, so a longer backlog is worked through run by run and an older lead is never crowded out. A lead is
  chased for a week (or a day past the largest step, when that is longer); after that it stays in the brief and the weekly report.
  Nothing is sent during the agent's `quiet_hours` (default 21:00 to 07:00 America/New_York): the first run after them sends what
  waited, and the key keeps each reminder once. A reminder the provider refused fails the task transiently once the others are
  sent, so the scheduler tries it again under the same key, at most three times in all. Setting the lead's status on Leads
  (contacted, qualified, won, lost or spam), answering, adding a note or closing the conversation stops the reminders.
- **The weekly report** (task `growth.weekly`, "Weekly growth report"). The schedule fires every morning at 07:30 Eastern and
  only Monday's run reports (the day is the one the task was due for, so a retry after midnight keeps it); every scheduled run in
  an Eastern week uses `growth:weekly:<Monday>`, so the week is reported once, like the Account Manager's. A report the provider
  refused fails the task transiently, so it is tried again under the same key instead of the week going unreported. **Run now**
  reports on any day under a key of its own. It covers the seven Eastern days before the day it runs: leads by kind, product and
  source (utm_source, else the referring host, else "direct"), trials started (trial sign-ups and live-mode Stripe trials that
  began) and converted (live subscriptions whose trial ended in the week and that are active), the median time to a first
  delivered reply (only a reply whose delivery is `sent` counts), the
  lead conversations unanswered now, the top five landing pages and campaigns, and three suggestions. The suggestions are rules
  with fixed words (`server/agents/growth/report.mjs`), first match first: leads still unanswered; a median first reply over an
  hour; no leads at all; no lead from a search engine (connect Search Console); every lead from one source; no campaign tags;
  trials to check in with; report downloads but no demo requests; then three that always apply (a customer quote, an article,
  a referral). Test leads are never counted. It is information by email, with a button to Leads.
- **The morning brief** gains a **Growth** section when the feature is declared (`private.agent_growth_facts` for yesterday):
  new leads by kind, trials started, and the lead conversations unanswered now with the oldest wait. A lead waiting for a first
  reply is also listed under "Needs you". If the figures cannot be read the section says so and the brief still goes out.

**What it reads** (counts only, never a contact or a message): `private.agent_growth_pending` (ids, kinds and products),
`agent_growth_lead` (kind, product, organization, up to six facts with the plan first, where the visitor came from and the
conversation's reference), `agent_growth_unanswered` (lead id, kind, product, reference, minutes waiting and the step reached,
for the steps the handler passes, with the steps already reminded left out), `agent_growth_facts` (the counts above, for a
period of up to 93 days) and `agent_lead_probe_seen` (whether a test lead arrived, for the form check). Its one write is
`agent_growth_mark_seen` (the `private.leads.growth_seen_at` column). The organization is the only name an alert carries.

**Its settings** are in the agent's `config` and change by SQL only: `followup_minutes` (at most five steps, each 1 minute to
30 days) and `quiet_hours` (`start` and `end` on a 24-hour clock and a `timezone`; a start equal to the end means none). A value
it cannot use falls back to the default.

### Customer emails

A trial that hears nothing leaks: CareBase (30 days) and Intel (14 days) trials start through the Hub's billing, and
a CareBase trial without a card cancels silently. The Account Manager proposes four short, fixed emails to the
billing contact of a trial or a new paying account (task `accounts.lifecycle`, every morning at 08:20 Eastern).
They are written once, in `server/agents/accounts/lifecycle.mjs`, use no model, and go out only after the owner
approves the exact text on the Team screen, or, for an agent on **Act**, when the owner listed the template.

| Email | When | What it says |
| --- | --- | --- |
| Welcome | Days 0 to 2 of a trial | Thank you for starting the trial, the first three steps for the product, and a button to its getting-started help (CareBase's help center, Intel's Help page) |
| Setup help | Days 3 to 6 of a trial, only while the product has reported no positive usage for the account (a report of zero is not usage) | An offer of help with setup, and the help link |
| Trial check-in | When 5 days or fewer (and more than 2) are left in a trial | A personal check-in asking whether anything is in the way. It says it is not a billing notice |
| Testimonial request | 45 to 60 days after the account's first paid invoice for the product, on any subscription it has had for it, with no open high or urgent case | Would they share a sentence or two: their words are used only with their permission, in the form they approve, with or without their name, and a reply is how they say yes |

They are warm and short, in the branded layout and in the theme of the product's own app (`server/email-layout.mjs`),
so a customer's emails from the Hub look like the ones the app sends: Intel's are in its Emberline theme (the Intel
logo and "Set your marketing on FIRE!" over the fire image, the dark card, the ember accent and pill buttons, as in
the Intel app's own emails), CareBase's in the CareBase app's email standard (PennTrain: its logo on white over a
blue rule, the app's blue buttons, its footer with support@caremetric.ai). Each has an inbox
preview line, a headline, "Hello,", numbered first steps
with a button to the product's help, the Founders Sale terms in a highlighted box in the trial check-in, the consent
terms in a highlighted box in the testimonial request, and a sign-off from the product's team with its website. Each
has a plain-text part that says the same. They say nothing about AI, quote no price, promise no time or outcome, never
mention a phone call or voicemail, and use the company's vocabulary for CareBase (Assisted Living Facility, ALF,
surveyor). The welcome, the setup offer and the check-in add the owner's booking page as a "Pick a time" button
when `HUB_BOOKING_URL` is an https address. Only CareBase and Intel have these emails. Stripe's own notices are
never duplicated: the check-in never mentions a card, a price, an invoice or a date.

**Who gets one.** The run reads one server-only operation, `private.agent_lifecycle_snapshot`: per account and
product, a live trial or a live paid subscription on an account that first paid for the product at most 90 days ago
(live-mode Stripe records only, by the Billing screen's mode rule, so nothing at all while the verified mode is
test). The first payment is the earliest paid invoice of any live subscription the account ever had for the
product, cancelled ones included, so replacing a subscription neither postpones the testimonial request nor makes an
established account look new. For each it returns the tenant's slug and name, the product, the subscription's
status and dates, that first payment's date, whether a usable billing address exists and whether it unsubscribed
(never the address), whether the product has reported a positive usage quantity, how many high or urgent cases are
open, and what became of each template's email before. The run reads these facts 200 at a time, newest first, up to
2,000, and plans every page together, so newer trials never hide an older account whose email is due; a run that
stops at 2,000 says so. Each template is proposed at most once per account and product, ever: its period key,
`account:<template>:<tenant>:<product>`, is unique across every action, whichever run proposed it. A run proposes
at most 20 emails, one per account (a second waits for the next run), and none to an account with no usable billing
address, one that unsubscribed, one whose subscription is being cancelled, or a suspended or closed tenant.

**What the owner approves.** Each email is an `email.send` action aimed at the account (`billing_account`, its
slug). Its preview is the exact email: the subject line, the message and the footer (why it was sent, the
unsubscribe line and the postal address; the personal unsubscribe link itself is made when it is sent). The card
reads "Email to <account>: <subject>" and its button says "Approve and send". The action keeps only the facts that
rebuild the email (template, account slug and name, product, help and booking links, the period key and a SHA-256
hash of the wording), never an address; the database refuses an action with any other field.

**Autonomy.** In **Observe** the run proposes nothing and records how many of each template it would have
proposed. In **Propose** every email waits for the owner. On **Act** an email is approved on its own only when its
template is listed in the agent's `auto_send_templates` (seeded empty, and only SQL changes it, for example
`update private.agents set config = jsonb_set(config, '{auto_send_templates}', '["welcome"]') where key =
'account_manager'`). Listing `email.send` in `auto_approve_kinds` never approves one. The database applies the rule
when the email is proposed; the task result counts what it recorded, the audit event says `auto`, and an email
approved on its own is refused at send time (`auto_send_off`) if its template has since left the list or the agent
no longer acts. The run finishes once it has proposed: its proposals wait on the Team screen without holding back
the next morning's run.

**Sending.** An approved email is sent at once, or by the next tick when it was approved on its own; it needs no
owner session. Before anything goes out the executor (`server/agents/accounts/executor.mjs`) refuses, with a code the
Team screen explains:

- `not_configured`: the Hub cannot send customer email. It needs the SendGrid key, the company's postal address
  (`HUB_BULK_EMAIL_POSTAL_ADDRESS`, which every footer carries; without it nothing is proposed either) and a bare
  https public origin for the unsubscribe link (`HUB_PUBLIC_ORIGIN`: no credentials, path, query or fragment, so the
  link always reaches the unsubscribe page).
- `wording_changed`: the email rebuilt from the action's facts no longer matches the hash of the approved wording,
  so a newer Hub never sends different words under an old approval.
- `no_longer_applies`: the account changed. The trial emails need a trial that is still a trial (and the setup
  offer still no positive usage); the testimonial needs an account still paying with no open high or urgent case; neither
  goes to a subscription being cancelled.
- Then one database call (`private.agent_lifecycle_begin_send`) refuses `auto_send_off`, `no_address` (no usable
  billing address), `suppressed` (the address is on the suppression list) and `daily_limit` (20 customer emails
  already went out today, Eastern, across every account), and otherwise records the send and hands over the
  account's one billing address. It is the only operation that ever returns one.

The email goes through the same SendGrid sender as bulk email (category `hub-lifecycle-email`), from
`HUB_SUPPORT_FROM_EMAIL` (support@caremetric.ai) with replies to the same address, tracking off, and
`List-Unsubscribe` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click` headers. The outcome is sent,
`delivery_failed` (SendGrid refused it) or `email_unconfirmed` (no answer, so it may have gone). Nothing is retried.
An execution that is started again (the server stopped mid-send and the sweep handed the action back) finds the
recorded send and settles it from the record, whatever has changed since, without sending again.

**Unsubscribing.** The footer's link is personal: a random token whose SHA-256 hash is kept beside the address's
hash. It opens the bulk email unsubscribe page (`/api/email/unsubscribe/<token>`), which changes nothing until its
button or a mail client's one-click request confirms, and then adds the address to the same suppression list. One
list stops both kinds of email. Support replies, receipts and billing notices are not affected.

**What is kept.** The send ledger (`private.agent_lifecycle_emails`) holds the action, the period key, the template,
the address's SHA-256 hash (as bulk email keeps it), the unsubscribe link's hash, the outcome and SendGrid's message
id. The address and the email's text are never stored, logged or returned by the executor; the action's preview is
the approved text, which names the account and holds no address. Task results and run summaries hold counts and
template names only.

The handler and the action register only when the database declares `platform.agents.lifecycle.v1`, which needs
the Account Manager, the hardening and bulk email. To switch the emails on: apply the two migrations, restart the
Hub, set `HUB_BULK_EMAIL_POSTAL_ADDRESS` (and `HUB_BOOKING_URL` if you want the button), resume the Account Manager,
leave it in **Observe** for a morning and read its run ("Observe only: 3 customer emails would be proposed …"), then
switch it to **Propose** and press **Run now** on "Customer emails".

### Offers from your menu

The owner chose (2026-11-04) a fixed menu with caps: the Account Manager may offer only what the owner put on the menu, only to
accounts that qualify, at most once per account for each offer and at most each offer's monthly cap
(`supabase/migrations/20261105140000_agent_offers.sql`, feature `platform.agents.offers.v1`).

- **The menu** (`private.agent_offer_menu`, the "Offers the Account Manager may make" panel on the Team screen): a trial extension
  of 1 to 30 days, or one of the owner's own Stripe coupons (valid and in live mode in the billing mirror), for trials of chosen
  products that end within a window of days, with a monthly cap of 1 to 50. One offer is seeded: 14 more trial days for a trial
  that ends within 7 days, at most 10 a month, **switched off**. The owner switches offers on or off, changes a cap or adds an
  offer (it starts switched off) from the Team screen; each change needs a current administrator session and is audited.
- **The daily run** (`accounts.offers`, 08:40 Eastern, shown as "Offers from your menu") reads the switched-on offers with room
  left this month and the live trials that qualify (`private.agent_offer_candidates`: never an address) and proposes
  `offer.apply` actions, one per account a run, within each offer's room, with exactly what changes as the approval card's text.
  In Observe it proposes nothing. An account that had the offer, has a proposal of it open, or whose proposal the owner rejected
  or Stripe refused is not proposed again.
- **Making an offer** needs no owner session. `private.agent_offer_begin` (Hub server only) checks everything again in one
  transaction: for an offer nobody approved, the Account Manager must still be active, on Act and trusted with `offer.apply`
  (its row held for share: `offers_off`); the offer must be switched on (`offer_disabled`); the menu row is held while the cap
  is counted (`cap_reached`, calendar month, Eastern); once per account (`already_offered`); and the subscription must still be a
  live trial of that product on that account ending within the offer's window (`not_eligible`). It records the use before Stripe
  is asked. The server then asks Stripe once (`platformBilling.agentOffer`: a later `trial_end` with no proration, or the coupon
  added to the subscription's discounts as Stripe holds them now) with the idempotency key `hub-agent-offer-<action request key>`,
  holding the subscription's row lock (the one the owner's subscription commands take) from reading it until Stripe has answered
  and the mirror is refreshed, and writes a `billing.agent_offer` audit row as the AI assistant. A coupon offer's request is
  recorded on its use before it is sent (`private.agent_offer_request`, first one kept), so a retry sends exactly the same request.
  The answer is recorded with `private.agent_offer_settle`: applied; refused (Stripe said no, or billing is not set up: the place
  under the cap and the account's one offer are given back); or unconfirmed (no answer, or Stripe's idempotency error: it may have
  been applied, so it keeps its place, is never retried on its own, and the owner gets a warning to check the subscription in
  Stripe, also when a restart came before the warning). If recording the answer fails, the `agent_offer_settle_on_completion`
  trigger settles the use from how the action ended, in the same transaction, so a refusal is never left counted. A retry after a
  restart repeats the same Stripe request; a settled use is settled from its record. The `agent.offer` audit row says whether the
  owner approved it or it went automatically.
- **Handing it over** is the "Offers" autonomy step: a supervised week (the owner approves each offer), then the Chief of
  Staff's hourly task adds `offer.apply` to the Account Manager's list. Keep approving takes it back.

The customer sees an extension as a later trial end in their product and billing portal, and a coupon on their next invoice;
the Account Manager sends no separate email about it.

## The Sales Executive

The closer. It works the middle of the sales cycle, where a prospect has written to CareMetric and is deciding whether to try and
then buy: until now every such message got a fixed "I will follow up personally today" note and waited for the owner. It starts
**paused, in Propose** (`20261108180000_sales_executive.sql`, gate `20261108180100_sales_executive_contract.sql`, feature
`platform.agents.sales-executive.v1`), with a daily budget of $3.00 on the Draft tier.

**Answering prospects** (task `sales.reply`, "Answer a prospect"). After the Support Concierge has alerted the owner about a new
message, it asks the database whether the message is a prospect's (`private.sales_handoff`): a CareBase or Intel website lead or a
conversation filed as a sales inquiry, or an email from a growth contact on file whose CareBase or Intel opportunity is still open
(not yet a trial or a customer). Only an email received through the signed provider path binds a growth contact; an address typed
into a chat or a form is a visitor's claim. Billing and closed conversations, Advisors and every other product stay with the
Concierge and the owner, and so does any message with identifiers, one too long to have been read, or one about a cancellation, an
outage, security or a legal matter. While the Sales Executive is paused or in Observe, nothing is handed over and the Concierge
behaves exactly as before.

CareMetric sells without demos or meetings (owner decision 2026-11-08). The Sales Executive gives each prospect what they need to
decide on their own: the product's walkthrough pages, the published help-center guides that match their question (public ones, linked
on help.caremetric.ai), the free trial and a written answer. Asked for a demo or a call, it says so kindly and sends the walkthrough
instead.

For a handed-over message it reads the newest message and up to two earlier ones, scrubbed of personal details, and, only while
`HUB_AGENTS_CUSTOMER_TEXT_TO_AI=true` and a model key is set, asks the model for a reading and a draft. The model is given the
product, the prospect's stage, whether CareMetric wrote first, a word limit for the channel, the product's own pages it may link to
and the owner's booking page, with the fact sheet (`server/agents/content/facts.mjs`) and the sales playbook
(`server/growth/playbook.mjs`) in its cached system prompt. Its method: answer what was asked from the fact sheet (exact plan prices
and the Founders Sale terms when cost comes up), offer one next step (usually the free trial; for a trial, activating a paid plan, with the Founders Sale
applied automatically), ask at most one qualifying question, handle objections the playbook's way, and never pressure. The code then checks the
draft (`server/agents/sales/check.mjs`): only that product's listed prices, no other product's; links only to that product's pages
or the booking page; no guarantee, compliance assurance, certification, named competitor, testimonial, call or demo as a step, voice
AI, trial extension, special pricing, refund, time frame, mention of AI, identifier, name from the message or long quotation; the
fixed vocabulary is rewritten (ALF, surveyor); links may go only to the product's pages and the guides it was given. Product pages in a
passing draft get campaign tags (see "Campaign tags on product links"); help-center guides do not. A draft that passes
and goes back by email or chat is proposed as a `communication.answer` (the session-less path the Concierge's support answers use, with
the same database checks); by text message it is a `communication.reply`. The owner gets one email per draft (at most 20 a day). The
**Sales answers** autonomy step (off) hands answers over after a supervised week: they then go out on their own, authored as the
CareMetric AI Assistant, and the owner's email says it answered. Replies by text message and the fixed acknowledgment always wait.

When prospect text may not go to the model, or the model is unavailable, over budget, abstains or its draft fails a check, a first
message gets the same fixed sales acknowledgment the Concierge would have offered ("We have your request and will reply here with the
information you need": it promises no personal follow-up). A message the model reads as carrying identifiers
gets the fixed notice asking to resend without them. A request not to be contacted, a "no", a wrong person, a negotiation, a contract
or security question, a cancellation or anything the fact sheet does not answer is left to the owner (the alert already went out).
Nothing the prospect wrote is kept in the task, the run or the owner's email.

**Weekly pipeline review** (task `sales.review`, "Weekly pipeline review", daily at 07:45 Eastern, sent once a week). It reads every
page of the growth pipeline, leaves out internal organizations and emails the owner, per product, how many prospects, conversations,
trials and customers there are, what moved this week (replies, meetings, trials started, new paying customers), and which deals
need the owner now: a trial that ended with no decision or ends within a week without first value, a prospect who said yes in the
last two weeks but has no trial, an overdue next step or a conversation with no movement for two weeks, and a qualified prospect with
no permitted contact. The stored body carries counts only; organization names travel in the email's blocks. It uses no model.

**To switch it on:** apply the two migrations, restart the Hub so it reads the feature, then resume the Sales Executive on
**AI team** in **Propose** and press **Run now** on "Weekly pipeline review". Prospect replies are drafted only with
`HUB_AGENTS_CUSTOMER_TEXT_TO_AI=true` and `ANTHROPIC_API_KEY`; `HUB_BOOKING_URL` lets drafts offer the owner's booking page.
`npm test -- server/agents/sales` runs its unit tests and `node server/agents-sales-integration.mjs` (with `HUB_TEST_DATABASE_URL`
on a local Supabase) checks the hand-off through the real server role.

## The Social Media Manager

Runs CareMetric's Facebook Page, Instagram professional account, LinkedIn Company Page and the Meta and LinkedIn ad accounts for
engagement (LinkedIn posts are emailed to the owner to paste until LinkedIn is connected). It starts **paused, in Propose**, trusted with
nothing. Its five tasks:

- `social.plan` ("Weekly social plan"): drafts and proposes a week of posts.
- `social.inbox` and `social.interaction` ("Look for new comments and messages", "Answer a comment or message").
- `social.ads` ("Daily ad review"): proposes pausing losers, new copy and measured budget increases.
- `social.report` ("Weekly social report").

Its six action kinds are `social.post`, `social.reply`, `social.moderate`, `social.ad_pause`, `social.ad_create` and
`social.ad_budget`. Three autonomy steps, all off, hand over posts, replies (with hiding spam) and ad tuning (pausing and new ads inside
existing budgets). A budget change is never automatic: the database refuses an automatically approved one and so does the executor.
Nor is deleting a LinkedIn comment (LinkedIn has no "hide"): the executor refuses an automatically approved deletion, and once replies
are handed over such a comment is left for the owner.
Comments and messages reach the model only with `HUB_AGENTS_CUSTOMER_TEXT_TO_AI=true`, and no other person's words are stored. Setup,
the ad rules, the checks and the Meta and LinkedIn permissions are in [Social media](SOCIAL_MEDIA.md).

## The Content Marketer

Writes the help center's public articles, one a week, for the owner to approve, and once a month drafts outreach for the
owner to send personally. CareMetric has no blog or articles written for search; these articles are what search engines and AI
assistants can now find at `https://help.caremetric.ai/help/articles/<address>`. Articles about CareMetric Intel live on Intel's
own website, at `https://www.caremetricintel.com/resources/<address>`, which reads them from the Hub's public article feed (see
"Intel's articles on Intel's website" below), so they build search credit for the site that sells Intel. Every claim comes from the fact sheet,
[GTM_FACTS.md](GTM_FACTS.md) (machine copy `server/agents/content/facts.mjs`), and nothing is published without the owner's
approval. No customer text ever reaches the model: the only thing the inbox contributes is a count of conversations.

**Topics.** A curated backlog in code (`server/agents/content/topics.mjs`): Pennsylvania personal care home and ALF regulations
under 55 Pa. Code Chapters 2600 and 2800 (how the two licenses differ, surveyor visits, annual inspection records, staff
training hours, fire drills, reportable incidents, medication administration training, resident rights notices, emergency
preparedness), Intel topics (home health referral marketing, county market data, hospice relationship plans) and Advisors
topics (reviewing a personal care home or ALF before buying it, outside survey-readiness reviews). Each topic names its
product (the article is published under it), its reader, its angle, the official sources it may cite and the facts it may
state; every regulation fact was read from the cited section of the Pennsylvania Code on 2026-11-03. A topic is never written
twice: not while an article for it is published or waiting for the owner, and not for 90 days after the owner rejects one (an
expired or failed proposal may be tried again). Among the rest, priority leads; products whose inbox conversations were busiest
in the last 90 days (counted by product and inquiry type, never read) come next; the product of the last article steps back.

**What the model is asked for** (`prompt.mjs`, prompt version `content.1`, draft tier): one object with a title, an address
(slug), a meta description, a summary, an outline, the body in Markdown, questions and answers, internal links (ids of the
products' real public pages, never addresses) and citations (addresses from the topic's official sources). The system prompt is
the instructions and the fact sheet, a constant that is cached.

**What the code checks** (`validate.mjs`). Lengths and shapes (title, address, description, summary, outline, body of 1,200 to
4,200 characters in three to eight sections, two to four questions, one to three links); citations only as https addresses on
the allowed hosts (pa.gov and its subdomains such as dhs.pa.gov, pacodeandbulletin.gov, palegis.us, cms.gov and census.gov for
Intel's topics, and the company's own sites) and only to the curated sources, and at least one for a regulation; any other link
in the body, HTML, images or tables; a price, percentage or number with a unit that neither the fact sheet nor the topic's facts
state; a guarantee; a legal or compliance assurance ("ensures compliance", "pass your inspection", survey-proof, avoiding all
citations); a certification or endorsement claim; AI that uses voice or the phone; a call or a demo as a step; a named
competitor; a testimonial; "prove" or "proof" about CareBase; personal or health information, an email address other than
hello@ or support@caremetric.ai, or a phone number; and a claim to be an AI. Assisted Living Residence and ALR become Assisted
Living Facility and ALF, and an auditor or a state audit becomes a surveyor or an inspection; an auditor of another kind (a
financial auditor) cannot be rewritten and rejects the draft. Regulation articles end with a fixed line: general information,
not legal advice. A draft that fails proposes nothing; the task's result and the run's summary name the checks it failed
(`compliance_assurance, unlisted_number`), never the draft.

**What the owner approves.** A `content.publish` action ("Publish a help article") whose preview is the whole article: the
address it will live at (for an Intel article, its address on Intel's website, then its help-center copy), the product, the
title and the description, then the Markdown exactly as it will be published (the summary, the body, the questions and answers,
the sources, the links and, for a regulation, the disclaimer; every product page in it carries the Content Marketer's campaign
tags, the cited sources none). It must fit the
6,000 characters an action's preview holds, so articles are compact (about 300 to 600 words of body).

**How approval publishes.** Approving runs the executor at once; it needs no owner session and no model. It checks the stored
article once more, then `private.agent_content_publish` publishes the action's own stored input, never anything the server hands
it: a content item whose key is the address, owned by the topic's product and the "CareMetric Marketing" team and created by the
CareMetric AI Assistant profile; revision 1, approved by the owner at the moment they decided; a publication to the product for
every visitor (`public`, audience `all`); and an audit event `content.published`. The article then appears in the help center,
at its own address as HTML (see "Public articles for crawlers" below) and in the sitemap; an Intel article also appears on
Intel's website and is left out of the Hub's sitemap. Publishing is idempotent by address:
an execution started again finds the article and writes nothing new (`already_published`). An article is published only with
the owner's approval: one approved on its own (an agent on Act with the kind listed) is refused (`approval_required`). The
other outcomes the Team screen explains: `slug_taken` (another article already uses the address), `product_unavailable`,
`invalid_article` (the stored article fails a rule that changed since) and `publish_failed`.

**Intel's articles on Intel's website.** An article published for CareMetric Intel alone is served by Intel's website at
`https://www.caremetricintel.com/resources/<address>` (the origin is `intelArticleOrigin`, next to `productPages` in
`server/agents/content/facts.mjs`). Intel reads it from the Hub's public article feed, `GET /api/public/articles?product=caremetric-intel`
and `GET /api/public/articles/<address>?product=caremetric-intel` (`server/public-articles.mjs`; shape, caching and what is never
returned in [API.md](API.md), "Public article feed"): published, public articles for every visitor, with their title,
description, Markdown and its parts (summary, body, questions and answers, sources, links), revision and times, never a draft or
an internal field. The help center keeps showing the article at its own address, but its canonical link, Open Graph address
and structured data name Intel's address, and it is left out of the Hub's sitemap. The preview the owner approves, the task's
result (`url`) and the publication's result (`url`, with the help-center copy in `helpUrl`) all name Intel's address. The feed,
the canonical link and the sitemap change all start together, once the database declares `content.public-articles.v1` (apply
`20261109130000_public_articles.sql` and `20261109130100_public_articles_contract.sql`, then restart the Hub); until then the
help center stays every article's home. Apply them when Intel's website is ready to serve `/resources/<address>` from the
feed, so a canonical link never points at an address that does not answer.

**Public articles for crawlers.** The help center is a single-page app, so the Hub server answers `/help/articles/<content key>`
itself (`server/help-center.mjs`) for every public, published article, the Content Marketer's and the ones already there: real
HTML with the title, description, canonical address, Open Graph tags, an Article in JSON-LD and the body rendered from Markdown
by `src/lib/markdown.ts`, which escapes everything and keeps only https and same-site links, inside the app's own page so the
app takes over. Its canonical address is the help center's, except for an Intel article (above). It also serves
`/sitemap.xml` (the help center, the learning library and every public article whose canonical address is the help center's) and
`/robots.txt`. The articles are the ones an anonymous visitor's app reads, cached for five minutes; the security headers and
Content Security Policy are unchanged. The help center's list links each public article to its address.

**The outreach drafts** (`content.outreach`, "Monthly outreach drafts", `outreach.mjs`). Once a month the model drafts up to five
listing descriptions for software directories (Capterra, G2, GetApp, Software Advice; CareBase and Intel) and up to five short
partnership pitches (state and regional provider associations, senior-care consultants, pharmacy and therapy partners,
compliance trainers), from the fact sheet. Each draft gets the same checks as an article (and no markup or links, only the
company's own domains; an address with a query passes only as a campaign-tagged product page); one that fails is left out and only
the name of the check is kept. Under each draft the email gives the product's home page with campaign tags to use with it (a
listing's website field, a pitch's link). The ones that pass go to the owner in
one email, word for word, to adjust and send personally. Nothing is sent to anyone else. The stored copy of the alert (shown on
the Team screen) holds counts only; the drafts travel only in the email.

**When it runs.** `content.weekly` ("Weekly help article") fires every morning at 07:45 Eastern and writes on Tuesdays (read from
the task's due time, so a Tuesday's work put off by the budget still runs the next day). `content.outreach` fires every morning at
08:05 Eastern and writes once a month, from the first Wednesday on, under the month's alert key, so a server that was down that
day writes on its next run and a month is sent once (a delivery that failed is tried again on a later day, up to the notifier's
three tries). **Run now** works on any day and always writes. While an article waits for the owner, the weekly schedule waits too.

**Cost and budget.** One draft-tier call per article (up to 8,000 output tokens; the runtime reserves about 14 cents before the
call and books what it actually used, typically a few cents) and one per month for outreach (about 10 cents reserved). The seeded
budget is $1.50 a day. A used-up budget puts the task off to the next Eastern day. In
**Observe** the agent writes nothing, because it could not propose what it wrote.

**Switching it on.** Apply the two migrations below, restart the Hub so it reads `platform.agents.content.v1`, make sure
`ANTHROPIC_API_KEY` is set (the tasks register only with a key), then resume the Content Marketer on **AI team** (it starts in
**Propose**) and press **Run now** on "Weekly help article". The proposal appears under "Waiting for you" within a minute.

**Turning it off.** Pause the Content Marketer on **AI team**: nothing more is drafted or emailed, and proposals already waiting
can still be rejected (or are left to expire after seven days). Removing `ANTHROPIC_API_KEY` stops both tasks as well. To take a
published article down, retire it: `update hub.content_items set status = 'retired', retired_at = now() where content_key =
'<address>';`. It leaves the help center, the sitemap and its address (which then answers 404) within five minutes.

### Publishing on its own

With `platform.agents.content-autopublish.v1` (`supabase/migrations/20261105130000_content_autopublish.sql`), an article approved
automatically is published too, but only while the owner has handed article publishing over: `private.agent_content_publish`
checks, at publication, that the Content Marketer is active, on Act and trusted with `content.publish` (the articles autonomy
step adds it), and otherwise answers `approval_required` as before. The executor still re-checks every article against the
content rules first. An article published this way records the AI assistant as its approver and says `approval: automatic` in
its revision variables and its audit row; the owner's own approvals are unchanged. The fact sheet the checks read
(`server/agents/content/facts.mjs`, `docs/GTM_FACTS.md`) is what keeps automatic articles accurate: confirm it before the
articles step switches.

## Campaign tags on product links

Every link to one of the company's product pages that an agent puts in front of a person carries utm_source, utm_medium and
utm_campaign (and sometimes utm_content), so a lead shows which agent and channel produced it: the product sites and Intel record the
tags with the lead, the Hub keeps them in `private.leads` and the Growth Manager's weekly report groups leads by source and campaign.
One helper does it, `server/agents/links.mjs` (`taggedUrl`, `tagLinks`, `untaggedUrl`), and one table names every value:

| Who and where | utm_source | utm_medium | utm_campaign | utm_content |
| --- | --- | --- | --- | --- |
| Marketing Manager outreach email | caremetric | email | growth-<product>-touch<n> | |
| Account Manager customer email (growth plays) | caremetric | email | account-<product>-<moment> | |
| Sales Executive answer | caremetric | email, chat or sms | sales-<product> | |
| Social Media Manager post, reply | facebook, instagram or linkedin | social | social-<product> | post, reply |
| Social Media Manager ad | facebook (Meta ads) or linkedin | paid_social | social-<product> | ad |
| Content Marketer article | help_center | article | content-<product> | |
| Monthly outreach: directory listing | the directory (capterra, g2, getapp, software-advice) | directory | outreach-<product> | |
| Monthly outreach: partner pitch | caremetric | email | outreach-<product> | the kind of partner |

`<product>` is carebase, intel or advisors. Values are short and lowercase (letters, digits, "-" and "_", at most 40 characters) and
never hold a name, an address or anything about a person.

- **Only product pages are tagged:** an address that is exactly one of `productPages` in `server/agents/content/facts.mjs`. Citations,
  help-center links (the help center's own guides and the apps' in-app help), unsubscribe links and the booking link are never
  tagged, and neither are the fixed sign-off lines under an email (the product's website), so an approved customer email's wording
  and its hash are unchanged.
- **Tags are added by code after the checks,** never written by the model; tags the model wrote itself are replaced with the agent's
  own. The tagged text is what the owner approves and what is sent.
- **Every link check reads tags strictly** (`untaggedUrl`): a tagged address counts as a page only when its query is nothing but
  utm_source, utm_medium, utm_campaign and utm_content, each once and each a valid value, and the address without them is exactly a page
  the check already allows. Any other parameter, an encoded character, an "@", a tag on another host or path, or a malformed tag fails
  the check as an unknown link. Length limits on social text count the page's own address, so tags never push a post over.
- A Sales Executive answer by text message keeps its link untagged when the tags would not fit in one message.
- The Support Concierge's drafted answers may contain no link at all (`server/agents/concierge/draft.mjs`), so they carry no tags.
- The Account Manager's fixed customer emails (welcome, setup nudge, trial check-in, testimonial ask) link only to the product's
  in-app help and the booking page, which are not tagged; its growth plays (onboarding, activation, trial and the others drafted by
  `server/growth/draft.mjs`) are.

## Boundary

- Every table has row level security and **no** privilege for any browser, service or server role.
- The Hub server reaches them only through `private.agent_*` security definer operations. Each
  refuses every session user except `hub_app_server`.
- The owner reads and decides through `hub.*` operations that authorize the current SMS
  administrator session themselves: reads need the administrator session, changes need the
  command session (under eight hours old). A signed-out or lapsed session fails closed.
- `20261102120100_agent_control_plane_contract.sql` refuses to declare `platform.agents.v1`
  if any of the above has drifted. A function that lost its `search_path` setting
  (`ALTER FUNCTION ... RESET search_path` leaves it null) slipped through that gate's negated test, so
  `20261102180100_agent_hardening_contract.sql` repeats every check, for every operation and helper of
  the control plane, the probes and the brief, in a form that fails closed, and declares
  `platform.agents.hardening.v1`.
- `20261103130100_agent_growth_contract.sql` declares `platform.agents.growth.v1` only when the leads table is still closed
  and has its `growth_seen_at` column, every Growth Manager operation (and the conversation snapshot it extends) is a security
  definer with a pinned empty search path, executable by `hub_app_server` alone and refusing every other session user, its
  helpers are executable by no role, and the agent, its three schedules and the lead form check exist. Every test fails closed.

- `20261109120100_monday_scorecard_contract.sql` declares `platform.agents.scorecard.v1` only when the scorecard setting is one row
  closed to every role, `private.agent_individual_reports` and `private.agent_scorecard_facts` are security definers with a pinned
  empty search path executable by `hub_app_server` alone and refusing every other session user, their helpers are executable by no
  role, `hub.get_scorecard_settings` and `hub.set_individual_reports` authorize the owner's session themselves and are closed to
  anonymous callers, and the Chief of Staff has its 07:50 schedule. Every test fails closed.

## Hardening

`20261102180000_agent_hardening.sql` closes the findings of the review of the first migrations. It adds no
capability, and every signature that existed stays (as a thin wrapper), so a server built before it keeps
working. The Hub server uses the new operations only when the database declares
`platform.agents.hardening.v1`, which it reads once at start; deploy it before or after the migration.

- **A stale worker cannot touch a reclaimed task.** `agent_task_heartbeat` and `agent_task_finish` take the
  attempt number the task was claimed under (`task.attempts`). A task whose lease ran out and was handed out
  again ignores the first worker's heartbeat and finish; the current status comes back.
- **Cancelling rejects what was approved but not started**, not only the undecided proposals. An action
  already being carried out is left alone, because it may be mid-send and its own report settles it. The ready
  and start operations also ignore an action whose task was cancelled.
- **One lock order.** Proposing, cancelling, deciding and settling an execution lock the task first and the
  action second, so none of them can wait on another. The housekeeping sweep locks the tasks of the proposals
  it is about to expire first too, so expiring a task's last open proposal cannot deadlock with the owner's
  decision on it. A proposal that arrives while a cancellation is in flight waits for it and is then refused.
- **Executions are numbered.** `agent_action_execution` reports `execution`, and `agent_action_executed` and
  `agent_action_release` must quote it, so a worker whose execution the sweep reset cannot settle the next
  start. Release hands back an execution that never began its work (the owner's session had lapsed) to the state
  it was approved in.
- **The ready list can be narrowed by kind before it is limited** (`kinds`, `excludeKinds`), so waiting
  replies cannot hide an incident record behind them.
- **A retried alert has its own clock** (`attempted_at`), so the sweep for deliveries nobody settled no longer
  marks a fresh retry unknown.
- **A session task asked to retry waits for its backoff**, in the list that offers it and in the claim, so a
  second press of the button that listed it earlier cannot run it before then. A schedule skips a task still
  waiting for approval instead of firing a second one beside it.
- **The conversation snapshot says what became of a reply** recorded under the request key it is asked about
  (`ownReplyDelivery`: pending, sent, failed or unknown, else null), so a reply whose execution stopped before
  it was settled can be settled on replay instead of being judged against a thread that has since moved on.
- **A relapse is flapping** when its first failed check came within half an hour of the last recovery.
- **The brief** counts incidents from the probe tasks (which exist whether or not the on-call agent records
  actions) on the day the incident began or closed, and treats an urgent alert as undelivered only when no
  channel of it, whenever it was sent, reached the owner.

## Operations

Server (`hub_app_server` only): `agent_schedule_fire`, `agent_maintenance`, `agent_task_enqueue`,
`agent_task_claim` (lease based, with crash recovery), `agent_task_heartbeat`, `agent_task_finish`,
`agent_session_tasks`, `agent_session_task_claim`, `agent_run_start`, `agent_run_finish`,
`agent_budget`, `agent_action_propose`, `agent_actions_ready`, `agent_action_execution`,
`agent_action_executed`, `agent_action_release`, `agent_notify_begin`, `agent_notify_finish`, `owner_contact`, `agent_probe_record`, `agent_brief_facts`,
`agent_concierge_pending`, `agent_communication_snapshot`, `agent_notification_count`, `agent_accounts_snapshot`,
`agent_growth_pending`, `agent_growth_lead`, `agent_growth_mark_seen`, `agent_growth_unanswered`, `agent_growth_facts`,
`agent_lead_probe_seen`,
`agent_lifecycle_snapshot`, `agent_lifecycle_begin_send`, `agent_lifecycle_finish_send`,
`agent_content_state`, `agent_content_publish`, `agent_individual_reports`, `agent_scorecard_facts`.

Owner (current administrator session): `get_agent_team`, `list_agent_activity`,
`list_audit_events` (reads) and `set_agent_status`, `set_agent_autonomy`, `set_agent_budget`,
`decide_agent_action`, `request_agent_task`, `cancel_agent_task` (changes), and `get_scorecard_settings` (read) and
`set_individual_reports` (change) for the Monday scorecard.

## What runs on the server

`server/agents/` is wired into `server/main.mjs` as one timer, once a minute (`team.tick()`):

1. **Housekeeping**: expired proposals, executions the server never finished, session tasks that lost
   their lease, tasks waiting on approval that have nothing left open, notifications never settled.
2. **Fire schedules**: due schedules of active agents become tasks, but only for task kinds that have a
   handler in this server. A schedule for a kind with no handler stays due, so a schedule seeded ahead of
   its code never fires tasks nobody can run.
3. **Claim and run**: up to three tasks under a ten-minute lease, extended every minute while a handler
   works. A handler that does not finish in four minutes is stopped, and so is one whose task the owner
   cancelled or another worker took over: the heartbeat tells the worker the task is no longer its own, and the
   handler's signal is aborted so it stops sending alerts or making model calls. A failure is retried after five,
   ten, twenty and then thirty minutes; an error that is not a provider outage stops after the third
   attempt, and the database fails any task after five.
4. **Carry out actions**: approved and auto-approved actions run through their executor, once.

A handler is `async (task, { signal }) => { status?, result?, errorCode?, retryAt? }`; a status of
`awaiting_approval` leaves the task waiting for the owner. Logs name the task, the agent, the kind and an
error code, never an error message. The service environment is `HUB_AGENTS_ENABLED` and `HUB_OWNER_EMAIL`
(see `.env.example`); the integration setup panel shows whether they are set.

**Owner alerts** are recorded before they are sent, under a dedupe key, so a retried task never texts or
emails twice. An urgent item goes by text (to the administrator's verified number, through the Hub's
Twilio settings) and by email; everything else by email. A channel that is not configured is recorded as
suppressed instead of failing the task. Each channel ends as sent, failed, unknown or suppressed. Failed means
nothing reached you (a provider refusal, or a text whose number could not be looked up) and is retried; unknown
means the provider was given the message and then errored, so it may have gone and is never resent. Alert text
carries counts, names and references, never inbound customer text.

**The Hub cannot watch itself.** A probe that runs inside the Hub reports a database or network problem
from the Hub's point of view, but nothing inside a stopped process can notice that it stopped. Keep one
external check on `GET /api/health` (an uptime monitor, or a scheduled workflow that opens an issue).

## Budgets

Each agent has a daily budget in cents; the day runs midnight to midnight Eastern. Model calls
are checked against it where the tokens are spent, so a budget that is used up stops that agent's
model calls until the next day without holding back model-free work such as health probes.
The rules the check follows are under "The model runtime".

## The model runtime

`server/agents/runtime/` is how an agent calls a model. It is shared by every agent and used by none yet:
an agent's handler asks for it (`model.run(task, request, { signal })`), so the Concierge's drafted answers,
the Account Manager and the Content Marketer can be built on one metered path. It adds the official
Anthropic SDK (`@anthropic-ai/sdk`, pinned to an exact version) beside the Hub's older case assistant,
which keeps its own small client. The SDK's origin is fixed to `https://api.anthropic.com` (a base URL
variable on the host cannot redirect it), its logger is off, it never retries and it times out after 90
seconds, so a call can never outlive the scheduler's four-minute limit for a task. A retry inside the SDK
would be a second billable request that the run (one reservation, one booked call) never sees; the
scheduler's own retry starts a separate run with its own budget check.

**One call per task.** The loop is written by hand rather than handed to the SDK's tool runner, because
the Hub keeps its own budget, deadline and accounting. A run makes one call and has no tools: a model that
stops for any reason except finishing has produced nothing usable. The request names the agent's tier
(`fast`, `draft` or `quality`, which pick the Haiku, Sonnet or Opus 5.5 model), a closed JSON schema the
answer must fit, an effort of low, medium or high, and system blocks marked for caching. It never sends a
sampling parameter, a thinking setting or a prefill, and `max_tokens` (3,000 by default, 8,000 at most)
covers the model's thinking as well as its answer. The answer is checked again in code against the schema
and against the agent's own `validate`; the model never causes a side effect, the handler does.

**Budget.** A call is allowed only if the agent's remaining cents for the Eastern day, less what other
calls in this process have reserved and not yet booked, cover its worst case: an upper bound on the prompt
at the cache-write price, and every output token up to `max_tokens`. The bound is the UTF-8 length in bytes
of the serialized request plus a margin of 512 tokens. No tokenizer produces more tokens than the text has
bytes, so the bound cannot be too small whatever the script, symbols or emoji (a characters-per-token guess
can: Japanese and emoji run denser). It is several times the real count for English, and the money it holds
is released when the call is booked at its real usage. A call that is refused makes no request, leaves a
`budget_exhausted` run for the owner to see and tells the handler, which should put the task off until the
next Eastern day.

The cost of a run reaches the database only when its run row is closed, and up to three tasks run at once.
For one agent, reading the budget and reserving against it happen alone, and a reservation is released
through the same queue after its cost is booked. A call that finishes while another is reading the budget
is therefore counted once, as a reservation or as booked cost, and never not at all. The row is closed
straight after the response, before anything can fail. A call whose outcome is unknown (a timeout, an
abort, a dropped connection) is booked at its input bound instead of at nothing, and a response that
reports no usage is booked at the reserve. If closing the row fails, the answer is still returned, the cost
stays against the agent's budget in memory and the write is retried at the next call, so the money is not
spent twice while the database is failing; a retry the database answers with "already closed" counts as
booked. A cost counts only against the Eastern day its run started in (the day the database counts it in), and
a write that fails five times is given up with a log line, so a failure that never clears cannot shrink every
later day's budget. Settling removes only the costs it settled, so one that went unbooked in the meantime stays. A server that stops mid-call loses that call's cost: at most the three reserves it held.

**Prices** are per million tokens: Haiku 5.5 $0.10 in and $0.50 out (above a 100,000-token prompt, $0.50
and $2.50 for the whole call), Sonnet 5.5 $2 and $10, Opus 5.5 $4 and $20; a cache read costs $0.01 (Haiku
at the short rate) or $0.20 and a five-minute cache write 1.25 times the input price. A model with no price
in the table is refused. The table is keyed by the literal model ids, and a test holds it to the tiers the
Hub names, so pointing a tier at a new model cannot quietly give it the old model's rates: it stops the
agents until the new model is priced. Costs are rounded up at the fourth decimal of a cent.

**How a run ends**, in `private.agent_runs`: `completed`; `refused` (the model declined; not retried);
`budget_exhausted`; `no_result` (the answer was cut off, or was not valid JSON, did not fit the schema or
failed the agent's own checks; the failure is `output_truncated` or `output_invalid`, and it stops after
three attempts); `failed` with a code; `cancelled` (the scheduler's deadline or a shutdown reached the
call). Failure codes are lowercase words: `rate_limited`, `provider_outage` (any 5xx, including overload),
`provider_unreachable` and `run_aborted` are transient and retried with the scheduler's backoff;
`request_rejected`, `ai_auth_failed`, `ai_not_permitted`, `model_not_found`, `unknown_model`,
`ai_not_configured`, `output_truncated`, `output_invalid` and `ai_error` are not. A refused key, account or
model also emails the owner once a day.

**Ledger.** Each real call writes one `private.ai_usage` row, as for the case assistant: actor `automation`,
feature `agent_<agent key>`, the model, `completed` or `failed`, the whole prompt's tokens (input, cache
reads and cache writes) and the output tokens. An agent's calls belong to no support case, so the control
center counts them as unattributed and labels them by feature. A refused call has no row.

**Nothing from a request is kept.** The request text may be customer text. It is never logged, stored in a
run, task, alert or error, or used in a summary: logs carry the agent, the kind, a code, the HTTP status and
the provider's request id; the provider's own error message (which can quote the request) is dropped; and a
run's summary comes from the agent's `describe`, which returns counts and fixed words only.

**Using it.** A handler that calls the model checks `signal.aborted` before it proposes an action or sends an
alert (the scheduler can stop waiting for a handler but cannot stop its code). The runtime is on
`team.model` and is handed to function-style `handlers` beside the store and the notifier. It is "Ready" on
the Team screen when `ANTHROPIC_API_KEY` is set, and no agent calls it unless its own code was written to.
To check the key and the tier models once, from a machine of your own, run
`HUB_RUNTIME_SMOKE=one-synthetic-call ANTHROPIC_API_KEY=… node server/agents-runtime-smoke.mjs fast`: one
invented sentence, a fraction of a cent, never run in CI.

## Work that needs the owner's session

Reading another application (Advisors inquiries, Breathe phone messages) requires the owner's live
SMS session, by design. Such tasks are marked `requires_session`: their schedule creates them waiting
(`awaiting_session`) and the tick never claims them. Unattended reads need a separate, reviewed decision.

The owner runs what is waiting from the **AI team** screen. The banner under "What the team can use"
shows how many tasks wait and has a **Run what's waiting** button (`POST /api/admin/team/waiting`). The
route asks the database to confirm a current administrator session (the same check any change needs, so a
session older than eight hours gets 401 and nothing is claimed), claims up to three waiting tasks, starts
them in the background and answers at once with how many started. **Run now** on an import does the same
for just that task. The database hands each task to one caller, so pressing twice runs nothing twice.

The session token is borrowed for the run and never kept: it reaches only the handler of a task marked
`requires_session`, and a result that contains it is refused before it is stored. Nothing in a table, log
line or alert holds it.

Two handlers use this today, both calling the inbox's own sync (`communications.sync`, which dedupes by
source and message, so reading a message twice never creates it twice):

- `import.advisors` copies consultation requests from Healthcare Advisors; `import.breathe` copies Breathe
  phone-line messages. Each run makes at most three calls of 200 messages from the newest end of the list and
  always reads its whole window, even when the first call finds nothing new: an earlier run may have copied the
  newest 200 and then lost its session, so an empty first window says nothing about the older ones. History
  beyond 600 messages is brought in with the **Import** buttons on the Communications page, which resume where
  they stopped.
- The result records `source`, `read`, `created`, `skipped`, `calls`, `complete` and `nextOffset`.
  A lapsed session parks the task again (`session_required`); an application that has not connected its
  administrator session finishes quietly as `not_connected`; an outage waits for the next press
  (`bridge_unavailable`, `rate_limited`); a refusal fails the task (`not_permitted`, `request_rejected`).

## Applying it to production

Apply the migrations in order with the usual procedure:

1. `20261102120000_agent_control_plane.sql`, then its gate `20261102120100_agent_control_plane_contract.sql`,
   which declares `platform.agents.v1`.
2. `20261102130000_agent_probes.sql`, then its gate `20261102130100_agent_probes_contract.sql`, which
   declares `platform.agents.probes.v1`.
3. `20261102140000_agent_brief.sql`, then its gate `20261102140100_agent_brief_contract.sql`, which
   declares `platform.agents.brief.v1` (and needs platform billing, the probes and the control plane).
4. `20261102150000_agent_seo.sql`, then its gate `20261102150100_agent_seo_contract.sql`, which seeds
   the SEO Analyst (paused) and declares `platform.agents.seo.v1`.
5. `20261102160000_agent_concierge.sql`, then its gate `20261102160100_agent_concierge_contract.sql`,
   which adds the Concierge's three server-only reads, slows its sweep to every five minutes, gives it
   its settings and declares `platform.agents.concierge.v1` (it needs the control plane and the unified
   communications).
6. `20261102170000_agent_accounts.sql`, then its gate `20261102170100_agent_accounts_contract.sql`, which seeds
   the Account Manager (paused, observe) and its schedule, adds the server-only account snapshot and declares
   `platform.agents.accounts.v1` (it needs the control plane and the platform billing mirror, not the
   Concierge). Deploy the Hub after applying them: the server reads the declared features once, at start.
7. `20261102180000_agent_hardening.sql`, then its gate `20261102180100_agent_hardening_contract.sql`, which
   fences stale workers, makes cancellation reject approved actions, numbers executions, narrows the ready list
   by kind, gives each alert retry its own clock and declares `platform.agents.hardening.v1` (it needs the
   control plane, the probes and the brief). Apply it before you resume any agent, and restart the Hub after
   it so the server reads the feature.
8. `20261103130000_agent_growth.sql`, then its gate `20261103130100_agent_growth_contract.sql`, which seeds the Growth
   Manager (paused, observe) and its three schedules, adds the Platform Engineer's lead form check every six hours, the
   server-only lead reads and `private.leads.growth_seen_at`, names the source system in the Concierge's snapshot, and
   declares `platform.agents.growth.v1` (it needs the control plane, the probes and the lead desk, `support.leads.v1`). Apply
   it after the lead desk's migrations and restart the Hub so the server reads the feature.
9. `20261103140000_agent_lifecycle.sql`, then its gate `20261103140100_agent_lifecycle_contract.sql`, which add the
   `email.send` action with its shape check and once-per-period index, the per-template rule for an agent on Act,
   the send ledger, the three server-only operations, a customer-email link on the shared unsubscribe page, the daily
   schedule and the empty `auto_send_templates` setting, and declare `platform.agents.lifecycle.v1` (it needs the
   Account Manager, the hardening and bulk email). Restart the Hub after it.
10. `20261103150000_agent_content.sql`, then its gate `20261103150100_agent_content_contract.sql`, which adds the
   `content.publish` action kind (widening the kind and target checks without dropping any kind another change added),
   its shape check and its once-per-address and once-per-topic indexes, the two server-only operations, and the Content
   Marketer (paused, Propose) with its two schedules, and declares `platform.agents.content.v1` (it needs the control
   plane, the hardening, governed publications and the communications inbox). Restart the Hub after it.
11. `20261104220000_agent_autonomy.sql`, then its gate `20261104220100_agent_autonomy_contract.sql`, which add the
   autonomy steps (all off) and the Chief of Staff's hourly `autonomy.graduate` schedule, and declare
   `platform.agents.autonomy.v1` (it needs the control plane, the hardening and the customer emails). Restart the Hub
   after it so the server registers the hourly task and the Team screen shows the steps.
12. `20261105120000_concierge_answers.sql`, then its gate `20261105120100_concierge_answers_contract.sql`, which add the
   `communication.answer` action kind with its shape check and the server-only operation that records an answer, and declare
   `platform.agents.concierge-autosend.v1` (it needs the Concierge, the hardening, the communications inbox and autonomy steps).
   Restart the Hub after it. Answers are drafted only with `HUB_AGENTS_CUSTOMER_TEXT_TO_AI=true` and a model key.
13. `20261105130000_content_autopublish.sql`, then its gate `20261105130100_content_autopublish_contract.sql`, which replace the
   publishing operation so an automatically approved article is published while the Content Marketer is trusted with publishing,
   and declare `platform.agents.content-autopublish.v1` (it needs the Content Marketer, the hardening and autonomy steps). Restart
   the Hub after it.
14. `20261105150000_growth_autonomy.sql`, then its gate `20261105150100_growth_autonomy_contract.sql`, which add role
   addresses found on a business's own website, the qualification rules, the Marketing Manager's two steps (off) and its daily
   `growth.evaluate` schedule, re-check the hand-over when proposing and claiming a growth message, cap cold email at ten a day and
   one business once, stop a product policy from overwriting an agent's list, and declare `platform.agents.growth-autonomy.v1`
   (it needs customer growth, the hardening and autonomy steps). Restart the Hub after it. Nothing is sent until
   `HUB_GROWTH_SEND_ENABLED=true` and the signing key are set, and the contact finder runs only with `HUB_GROWTH_SEARCH_API_KEY`.
15. `20261105140000_agent_offers.sql`, then its gate `20261105140100_agent_offers_contract.sql`, which add the offer menu (one
   14-day trial extension, switched off), the record of offers made, the `offer.apply` action kind with its shape check, the
   server-only operations, the owner's menu operations and the Account Manager's daily `accounts.offers` schedule, and declare
   `platform.agents.offers.v1` (it needs the control plane, the hardening, the customer emails, autonomy steps and platform
   billing). Restart the Hub after it. Nothing is offered until the owner switches an offer on.
16. `20261105160000_growth_snapshot_redraft.sql`, which adds to the pipeline's snapshot whether each work item's last message was
   withdrawn and the versions it was drafted against, so the Marketing Manager no longer pays for a new draft of work whose last
   message was cancelled while nothing changed. No gate and no new feature: a Hub on a database without it drafts as before. No restart
   is needed.
17. `20261108180000_sales_executive.sql`, then its gate `20261108180100_sales_executive_contract.sql`, which seed the Sales
   Executive (paused, Propose) and its daily `sales.review` schedule, add the server-only `private.sales_handoff` and declare
   `platform.agents.sales-executive.v1` (it needs customer growth, the Concierge, the hardening and the communications inbox).
   Restart the Hub after it. Nothing changes until the owner resumes the Sales Executive.
18. `20261108190000_social_manager.sql`, then its gate `20261108190100_social_manager_contract.sql`, which seed the Social Media
   Manager (paused, Propose) and its four schedules, add the six `social.*` action kinds and four targets with their ownership check
   (a budget change can never be automatically approved), the server-only `private.social_open_targets` and `private.social_schedule`,
   and the three autonomy steps (off), and declare `platform.agents.social.v1` (it needs the control plane, the hardening, autonomy
   steps and customer growth). Restart the Hub after it. Nothing reaches Meta until `HUB_META_ACCESS_TOKEN` and `HUB_META_PAGE_ID` are set
   and the owner resumes the agent.
19. `20261109120000_monday_scorecard.sql`, then its gate `20261109120100_monday_scorecard_contract.sql`, which add the owner's
   "Send the individual weekly reports" setting (off), the server-only `private.agent_individual_reports` and
   `private.agent_scorecard_facts`, the owner's `hub.get_scorecard_settings` and `hub.set_individual_reports`, and the Chief of
   Staff's daily `scorecard.weekly` schedule at 07:50 Eastern, and declare `platform.agents.scorecard.v1` (it needs the control
   plane, the hardening, the brief, the Account Manager, the Growth Manager and customer growth). Restart the Hub after it. While the
   Chief of Staff is resumed, the five weekly reports' scheduled emails then stop and the scorecard carries them; switch "Send the
   individual weekly reports" on under **Weekly reports** to get them as well. See [Monday scorecard](MONDAY_SCORECARD.md).

The Hub build does not require any of these features, so a Hub whose database lacks them still starts and
serves everything else. The AI team is opt-in twice over: nothing runs unless `HUB_AGENTS_ENABLED`
is `true`, and every agent is paused until the owner resumes it. Apply the migrations before doing
either. With the code but not the tables, the AI team page shows a read failure and every task fails.

To switch the Platform Engineer on: apply the migrations, set `HUB_AGENTS_ENABLED=true` and
`HUB_OWNER_EMAIL`, open **AI team**, resume the Platform Engineer, press **Run now** on its health
check and read the run it records. To switch the brief on, resume the Chief of Staff and press
**Run now** on its morning brief: the first email arrives within a minute, and the next one at 07:00.
To switch the SEO report on, resume the SEO Analyst and press **Run now** on its weekly check.
To switch the weekly account report on, apply the two Account Manager migrations, restart the Hub so it
reads the new feature, resume the Account Manager and press **Run now** on its weekly report: the first email
arrives within a minute and the next on Monday. Check the "Test data" and "Stripe mode" notes against what you
expect before relying on the figures.

To switch the Growth Manager on: apply the lead desk's migrations and the two Growth Manager migrations, set
`HUB_BOOKING_URL` on the Hub service if you want prospects offered your booking page (optional; an https link, for example
a Calendly or Cal.com page), restart the Hub so it reads the new feature, then resume the Growth Manager on **AI team** and
press **Run now** on "Weekly growth report": the first email arrives within a minute. New trials then email you within five
minutes, unanswered lead conversations remind you after an hour and a day (never between 21:00 and 07:00 Eastern), and the
morning brief carries a Growth section. The Concierge's sales acknowledgment needs the Concierge resumed in **Propose**.
For the lead form check, set each product's `HUB_LEAD_SECRET` to the same value as the Hub's
`HUB_LEAD_SECRET_CAREBASE`, `_INTEL` or `_ADVISORS` and deploy the product's probe support first; then, with the Platform
Engineer resumed, press **Run now** on "Lead form check" and read its run: each form should say "passed".

`supabase/schema.sql` is a reference snapshot that stopped being appended in October; these
migrations are not mirrored into it.
