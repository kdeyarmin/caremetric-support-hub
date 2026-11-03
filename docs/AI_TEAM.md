# AI team control plane

The Hub is where the CareMetric AI team lives. This document describes the control plane that
runs it: who the agents are, what each is allowed to do, how the owner stays in charge, and what
is built so far.

> **Status.** The database layer, the server scheduler, the `/admin/team` screen, the Platform
> Engineer's health probes, the Chief of Staff's morning brief, the SEO Analyst's weekly report, the
> Support Concierge's triage of new conversations, with the fixed replies it offers the owner, and the
> Account Manager's weekly report on how each customer account is doing are in
> place, and so is the model runtime they share (see "The model runtime"). The scheduler is inert
> unless `HUB_AGENTS_ENABLED` is exactly `true` and every agent is seeded **paused**. Only the Concierge
> can send customer text to a model, only to draft an answer to a plain question, and only while the owner has set
> `HUB_AGENTS_CUSTOMER_TEXT_TO_AI` to `true` ("Drafted answers"); otherwise customer message text never
> leaves the Hub. The SEO Analyst also calls the model, with the company's own public pages only, to suggest
> titles and descriptions ("The SEO Analyst").

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
  own and proposes everything else.

An approved action is carried out by the server through the existing reviewed path (for a reply,
the same staff reply operation the inbox uses, under the action's request key), so a retry can
never send twice. A proposal nobody decides within seven days expires.

Nothing here lets an agent move money, change a plan or price, delete data, merge code, deploy,
or read resident or patient records. Inbound message text is `possible_phi` and never enters audit
metadata, run summaries or task payloads.

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

## The SEO Analyst

Checks the company's public websites every Monday and emails what to fix. The crawl uses no model and reads
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
weekly work happens only on Monday and the other mornings finish at once. **Run now** checks on any day and
sends a report every time, while the scheduled report is sent once per Monday. A task the scheduler has
stopped waiting for (its time is up, or the owner cancelled it) sends nothing. The analyst is observe-only
and proposes no actions. Turning findings into issues for the coder bot is a later step.

## The Support Concierge

Notices every new conversation in the Communications inbox within minutes and tells the owner. By default
it uses no model and keeps no message text: this is customer service by simple rules, so the owner finds out
quickly and nothing a customer wrote leaves the Hub. The owner can switch on drafted answers (see "Drafted
answers" below), which adds one model call for the plainest questions.

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
   billing, a cancellation or a message with identifiers is a **warning** (email); anything else is
   **information** (email). Alerts say the kind of message, the channel, the product, the reference and how
   long ago it arrived, and "nothing has been sent to the customer". Never what the customer wrote.

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
(`communication.reply`; the exact text is the preview). Both are written once, in
`server/agents/concierge/templates.mjs`: an **acknowledgment** (the message arrived and a member of the team
will review it) and, when the question carries identifiers, a **notice** saying these channels are not set up
for patient or resident information and asking the sender to resend without names, dates of birth, record
numbers or health details. Neither repeats anything the customer wrote, mentions AI or a phone call, or
promises a time or an outcome; a text message gets a shorter version that fits one message. The owner answers
everything else personally: an outage, a security or legal matter, billing, a cancellation, a sales or
consulting inquiry, anything from the Advisors form, and any follow-up in a thread the team already joined.
That holds for how a conversation was filed as well as for its words: one filed as billing (a phone-line
message may read only "Please help") never gets a fixed reply or reaches the model.

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
billing question it calls urgent is texted too; billing or a cancellation otherwise raises a warning and offers none;
a sale offers none; personal information it finds gets the fixed notice that asks the sender to resend
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

## The Account Manager

Emails the owner every Monday how the customer accounts are doing (task `accounts.weekly`, shown as "Weekly
account report"). It uses no model, reads only what the Hub already holds, and **sends nothing to a
customer**. Stripe's own customer emails (a failed payment, a trial ending, receipts) stay on; this agent
never sends those and only tells the owner about them. Customer emails from the Account Manager, each one
approved by the owner template by template, are a later step.

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

**The health score** (version `health.1`, every weight in `server/agents/accounts/health.mjs`) is advice for
the owner and never changes a plan, a price or anyone's access. It runs from 0 to 100: 75 or more is healthy,
50 to 74 is watch, below 50 is at risk. An account that has been billing for under 14 days is "new" and has no
score, and one with no live subscription is "inactive". Each point off has a reason the email shows, so a
score never appears without why.

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
or before 28 days earlier, so an application that never reported usage is never marked down for it. An
overdue invoice is an open one more than three days past its due date, or past its creation when it has none.

**The email** lists, in this order: who needs you (payment trouble, a cancellation scheduled, shown with the date it takes effect first, a trial ending
within a week, a high-priority case, a closed account that still bills, anyone at risk), annual and
multi-month plans renewing within 30 days (a plan with a cancellation date at or before its renewal is
cancelling, not renewing, and appears only under who needs you; an account with several plans renewing in the
window shows the first date, the number of plans and their yearly total), accounts whose usage is growing, then revenue (MRR, ARR, trial MRR,
new and lost subscriptions this week, past due) and how many accounts are in each band. Each list shows at
most ten rows and then "And N more", names are clipped to 60 characters and escaped, and a list cut at 200
accounts says so. The revenue figures use the same functions as the Billing screen
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
observe it proposes nothing, since it has no actions yet.

Its handler registers only when the database declares `platform.agents.accounts.v1`, so a Hub whose database
lacks the migration still starts and the schedule stays due instead of failing. The declaration needs the
control plane and the platform billing mirror.

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
`agent_concierge_pending`, `agent_communication_snapshot`, `agent_notification_count`, `agent_accounts_snapshot`.

Owner (current administrator session): `get_agent_team`, `list_agent_activity`,
`list_audit_events` (reads) and `set_agent_status`, `set_agent_autonomy`, `set_agent_budget`,
`decide_agent_action`, `request_agent_task`, `cancel_agent_task` (changes).

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

`supabase/schema.sql` is a reference snapshot that stopped being appended in October; these
migrations are not mirrored into it.
