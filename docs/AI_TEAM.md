# AI team control plane

The Hub is where the CareMetric AI team lives. This document describes the control plane that
runs it: who the agents are, what each is allowed to do, how the owner stays in charge, and what
is built so far.

> **Status.** The database layer is in place (this change). **Nothing runs yet:** the agent
> runtime, the scheduler, the `/admin/team` screen and the first agents arrive in the following
> changes, behind `HUB_AGENTS_ENABLED`. Every agent is seeded **paused**.

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
`agent_action_executed`, `agent_notify_begin`, `agent_notify_finish`, `owner_contact`.

Owner (current administrator session): `get_agent_team`, `list_agent_activity`,
`list_audit_events` (reads) and `set_agent_status`, `set_agent_autonomy`, `set_agent_budget`,
`decide_agent_action`, `request_agent_task`, `cancel_agent_task` (changes).

## Budgets

Each agent has a daily budget in cents; the day runs midnight to midnight Eastern. Model calls
are checked against it where the tokens are spent, so a budget that is used up stops that agent's
model calls until the next day without holding back model-free work such as health probes.

## Work that needs the owner's session

Reading another application (Advisors inquiries, Breathe phone messages) requires the owner's live
SMS session, by design. Such tasks are marked `requires_session` and wait as `awaiting_session`
until the owner is signed in and runs them. Unattended reads need a separate, reviewed decision.

## Applying it to production

Apply `20261102120000_agent_control_plane.sql` and then `20261102120100_agent_control_plane_contract.sql`
with the usual migration procedure. This change adds only the database layer and declares
`platform.agents.v1` ahead of time; no deployed code calls the new operations yet, so the order
relative to merging this change does not matter. The Hub build that introduces the agent runtime
adds `platform.agents.v1` to the features the server and the connected build require, and from
then on the migrations must be applied first.

`supabase/schema.sql` is a reference snapshot that stopped being appended in October; these
migrations are not mirrored into it.
