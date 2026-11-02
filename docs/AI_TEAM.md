# AI team control plane

The Hub is where the CareMetric AI team lives. This document describes the control plane that
runs it: who the agents are, what each is allowed to do, how the owner stays in charge, and what
is built so far.

> **Status.** The database layer, the server scheduler, the `/admin/team` screen, the Platform
> Engineer's health probes, the Chief of Staff's morning brief, the SEO Analyst's weekly report and the
> Support Concierge's triage of new conversations, with the fixed replies it offers the owner, are in
> place, and so is the model runtime they will share (see "The model runtime"). The scheduler is inert
> unless `HUB_AGENTS_ENABLED` is exactly `true` and every agent is seeded **paused**. None of the working
> agents calls a model yet, and customer message text never leaves the Hub. The Concierge's drafted answers
> arrive in a following change.

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
  by agent. Message text is never kept in any of them.

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
An alert is recorded before it is sent. A sweep records a run on the Team screen only when it saw
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

The scheduled brief is keyed by the Eastern date, so a retry, a restart or a second server sends it
once. A brief you start with **Run now** is sent every time. It goes by email only, since an incident
already texts you when it happens. If email is not set up or the send fails, the run on the Team
screen says the brief was written but not delivered.

## The SEO Analyst

Checks the company's public websites every Monday and emails what to fix. It uses no model and reads
only public pages of the sites it is told about: Healthcare Advisors (`caremetricadvisors.com`),
CareBase (`cmcarebase.com`, with `caremetrictrain.com` as another address) and CareMetric Intel
(`www.caremetricintel.com`). The list is fixed in `server/agents/seo/sites.mjs`, a check never leaves a
site's own host, and nothing a customer says can add a site.

It reads each site the way a crawler that does not run scripts (and most AI assistants) does: plain GET
requests that follow no redirect, at most 20 pages and 30 links a site, 8 seconds a request, 600 KB a
page and about two and a half minutes a site.

- **The site**: robots.txt exists and does not block everything, a sitemap exists and lists pages on the
  site, plain http redirects to https, and the other addresses for the site redirect to it with a
  permanent redirect (or name it as canonical).
- **Its pages**, which are the home page and the pages in the sitemap (or the pages the home page links
  to when there is no sitemap): reachable, HTML, not marked noindex, a title and a description of a
  sensible length that no other page shares, a canonical link, one main heading, enough text before
  scripts run, a language, a phone viewport, social sharing tags, structured data that parses, image
  descriptions, and links that work.

Each finding is **urgent** (it could keep pages out of search results), **worth fixing** or **minor**. The
email lists each site's worst problems with an example page and scores each site out of 100 by how many
kinds of problem it has, so a problem on twenty pages counts once. It says when a site was slow or could
not be checked, and it quotes nothing a page says. A page that looks empty to the check may look fine in
a browser, which is itself worth knowing: many crawlers and AI assistants see only what is there before
scripts run.

The schedule fires every morning at 06:30 Eastern, because an interval schedule is limited to a day. The
weekly work happens only on Monday and the other mornings finish at once. **Run now** checks on any day and
sends a report every time, while the scheduled report is sent once per Monday. The analyst is observe-only
and proposes no actions. Turning findings into issues for the coder bot is a later step.

## The Support Concierge

Notices every new conversation in the Communications inbox within minutes and tells the owner. It uses no
model and keeps no message text: this is customer service by simple rules, so the owner finds out quickly
and nothing a customer wrote leaves the Hub.

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
   being right about the rest.
3. **Tells the owner**: an outage, a security concern or a legal matter is **urgent** (text and email);
   billing, a cancellation or a message with identifiers is a **warning** (email); anything else is
   **information** (email). Alerts say the kind of message, the channel, the product, the reference and how
   long ago it arrived, and "nothing has been sent to the customer". Never what the customer wrote.

Alerts are capped so that anyone who can write to the support address cannot flood the owner: at most 20
individual emails a day at each level (the next one becomes a single rollup email for the day), at most
three urgent texts an hour (after that, urgent alerts go by email only), and one urgent alert per
conversation per day.

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

An approved reply is sent the way the owner would send it, through the inbox's own reply
(`communications.reply`): it authorizes the owner's live session, is recorded before it is sent, goes out
under the action's request key so a retry never sends twice, and is authored in the thread as the owner. So
it needs that session. It is sent in the same request as the approval, or, if that could not happen (a
restart, a lapsed session), the next time the owner presses **Run what's waiting**. The background clock
never sends it. Before sending, it checks that the conversation is still the one the reply was written for:
if the customer wrote again, or the conversation was closed, it sends nothing and says why. A reply nobody
approved is refused even for an agent trusted to act. A send the provider did not confirm is never
reported as sent and is not retried; it warns the owner to look at the thread first.

Drafted answers from the published guides, with the model, come only after the owner confirms an Anthropic
agreement that covers support messages.

**What it watches** is set in the agent's `config`, which only SQL changes (the Team screen has no settings
editor): `channels` (default email, chat, web form and phone-line messages; text messages stay off until the
toll-free verification covers support texts), `settle_seconds` (90) and `window_hours` (72). Switch it on by
resuming the Concierge on the **AI team** screen, preferably in **Observe**, and press **Run now** on "Look for
new messages". Its handlers register only when the database declares `platform.agents.concierge.v1`, so a
Hub whose database lacks the migration still starts and the sweep stays due instead of failing.

## Boundary

- Every table has row level security and **no** privilege for any browser, service or server role.
- The Hub server reaches them only through `private.agent_*` security definer operations. Each
  refuses every session user except `hub_app_server`.
- The owner reads and decides through `hub.*` operations that authorize the current SMS
  administrator session themselves: reads need the administrator session, changes need the
  command session (under eight hours old). A signed-out or lapsed session fails closed.
- `20261102120100_agent_control_plane_contract.sql` refuses to declare `platform.agents.v1`
  if any of the above has drifted.

## Operations

Server (`hub_app_server` only): `agent_schedule_fire`, `agent_maintenance`, `agent_task_enqueue`,
`agent_task_claim` (lease based, with crash recovery), `agent_task_heartbeat`, `agent_task_finish`,
`agent_session_tasks`, `agent_session_task_claim`, `agent_run_start`, `agent_run_finish`,
`agent_budget`, `agent_action_propose`, `agent_actions_ready`, `agent_action_execution`,
`agent_action_executed`, `agent_notify_begin`, `agent_notify_finish`, `owner_contact`, `agent_probe_record`, `agent_brief_facts`,
`agent_concierge_pending`, `agent_communication_snapshot`, `agent_notification_count`.

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
   works. A handler that does not finish in four minutes is stopped. A failure is retried after five,
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
suppressed instead of failing the task. Alert text carries counts, names and references, never inbound
customer text.

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
variable on the host cannot redirect it), its logger is off, and it retries once with a 90 second timeout,
so a call can never outlive the scheduler's four-minute limit for a task.

**One call per task.** The loop is written by hand rather than handed to the SDK's tool runner, because
the Hub keeps its own budget, deadline and accounting. A run makes one call and has no tools: a model that
stops for any reason except finishing has produced nothing usable. The request names the agent's tier
(`fast`, `draft` or `quality`, which pick the Haiku, Sonnet or Opus 5.5 model), a closed JSON schema the
answer must fit, an effort of low, medium or high, and system blocks marked for caching. It never sends a
sampling parameter, a thinking setting or a prefill, and `max_tokens` (3,000 by default, 8,000 at most)
covers the model's thinking as well as its answer. The answer is checked again in code against the schema
and against the agent's own `validate`; the model never causes a side effect, the handler does.

**Budget.** A call is allowed only if the agent's remaining cents for the Eastern day, less what other
calls in this process have reserved and not yet booked, cover its worst case: every input character taken
as a token (two and a half characters to a token, on purpose too few) at the cache-write price, and every
output token up to `max_tokens`. A call that is refused makes no request, leaves a `budget_exhausted` run
for the owner to see and tells the handler, which should put the task off until the next Eastern day. The
cost of a run reaches the database only when its run row is closed, and up to three tasks run at once, so
the row is closed straight after the response, before anything can fail, and the reservation is released
only after that. A call whose outcome is unknown (a timeout, an abort, a dropped connection) is booked at
its input estimate instead of at nothing, and a response that reports no usage is booked at the reserve.
A server that stops mid-call loses that call's cost: at most the three reserves it held.

**Prices** are per million tokens: Haiku 5.5 $0.10 in and $0.50 out (above a 100,000-token prompt, $0.50
and $2.50 for the whole call), Sonnet 5.5 $2 and $10, Opus 5.5 $4 and $20; a cache read costs $0.01 (Haiku
at the short rate) or $0.20 and a five-minute cache write 1.25 times the input price. A model with no price
in the table is refused, and a test holds the table to the tiers the Hub names, so changing a tier cannot
leave the agents spending unmetered. Costs are rounded up at the fourth decimal of a cent.

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
  phone-line messages. Each run makes at most three calls of 200 messages from the newest end of the list.
  Advisors lists newest first, so its run stops at the first window with nothing new. Breathe's order has
  not been checked, so its run reads its whole window. History beyond 600 messages is brought in with the
  **Import** buttons on the Communications page, which resume where they stopped.
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
   communications). Deploy the Hub after applying them: the server reads the declared features once, at
   start.

The Hub build does not require any of these features, so a Hub whose database lacks them still starts and
serves everything else. The AI team is opt-in twice over: nothing runs unless `HUB_AGENTS_ENABLED`
is `true`, and every agent is paused until the owner resumes it. Apply the migrations before doing
either. With the code but not the tables, the AI team page shows a read failure and every task fails.

To switch the Platform Engineer on: apply the migrations, set `HUB_AGENTS_ENABLED=true` and
`HUB_OWNER_EMAIL`, open **AI team**, resume the Platform Engineer, press **Run now** on its health
check and read the run it records. To switch the brief on, resume the Chief of Staff and press
**Run now** on its morning brief: the first email arrives within a minute, and the next one at 07:00.
To switch the SEO report on, resume the SEO Analyst and press **Run now** on its weekly check.

`supabase/schema.sql` is a reference snapshot that stopped being appended in October; these
migrations are not mirrored into it.
