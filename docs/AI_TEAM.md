# AI team control plane

The Hub is where the CareMetric AI team lives. This document describes the control plane that
runs it: who the agents are, what each is allowed to do, how the owner stays in charge, and what
is built so far.

> **Status.** The database layer, the server scheduler, the `/admin/team` screen and the Platform
> Engineer's health probes are in place. The scheduler is inert unless `HUB_AGENTS_ENABLED` is
> exactly `true` and every agent is seeded **paused**. The Platform Engineer is the only agent with
> work to do yet; the model runtime, the Chief of Staff and the Support Concierge arrive in the
> following changes.

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
  signed in.
- **Waiting for you** lists every proposed action with a preview. A reply shows the exact text that will
  go to the customer and its button says "Approve and send". The owner may add a note, then approves or
  rejects. Approving carries the action out once, under its request key, and the screen says whether it
  worked.
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
`agent_action_executed`, `agent_notify_begin`, `agent_notify_finish`, `owner_contact`, `agent_probe_record`.

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

## Work that needs the owner's session

Reading another application (Advisors inquiries, Breathe phone messages) requires the owner's live
SMS session, by design. Such tasks are marked `requires_session` and wait as `awaiting_session`
until the owner is signed in and runs them. Unattended reads need a separate, reviewed decision.

## Applying it to production

Apply the migrations in order with the usual procedure:

1. `20261102120000_agent_control_plane.sql`, then its gate `20261102120100_agent_control_plane_contract.sql`,
   which declares `platform.agents.v1`.
2. `20261102130000_agent_probes.sql`, then its gate `20261102130100_agent_probes_contract.sql`, which
   declares `platform.agents.probes.v1`.

The Hub build does not require either feature, so a Hub whose database lacks them still starts and
serves everything else. The AI team is opt-in twice over: nothing runs unless `HUB_AGENTS_ENABLED`
is `true`, and every agent is paused until the owner resumes it. Apply the migrations before doing
either. With the code but not the tables, the AI team page shows a read failure and every task fails.

To switch the Platform Engineer on: apply the migrations, set `HUB_AGENTS_ENABLED=true` and
`HUB_OWNER_EMAIL`, open **AI team**, resume the Platform Engineer, press **Run now** on its health
check and read the run it records.

`supabase/schema.sql` is a reference snapshot that stopped being appended in October; these
migrations are not mirrored into it.
