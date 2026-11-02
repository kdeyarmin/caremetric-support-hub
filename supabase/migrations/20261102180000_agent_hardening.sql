-- Hardening for the AI team control plane, from the review of the first eight AI team migrations.
--
-- Nothing here adds a capability. Each change closes a way the existing operations could be
-- misused or could misreport, and none of them is reachable by any role that could not already
-- reach the operation it replaces:
--   * A worker that stalled past its lease could still extend or finish the task another worker
--     had since reclaimed. Heartbeat and finish now take the attempt number the task was claimed
--     under, and a superseded attempt changes nothing.
--   * Cancelling a task rejected only its undecided proposals, so an action that was already
--     approved (or auto-approved) stayed ready to run after its task was reported cancelled. The
--     ready and start operations also ignore an action whose task was cancelled.
--   * Proposing an action did not lock its task, so a cancellation could commit between the status
--     check and the insert. Cancelling, deciding, proposing and settling an execution now take the
--     task's row lock first and the action's second, so none of them can wait on another. The
--     housekeeping sweep does the same for the actions it expires or resets.
--   * A retried notification kept its original creation time, so the sweep for deliveries nobody
--     settled could mark a fresh retry unknown at once. Each attempt now has its own time.
--   * A session task that failed and was queued again ignored its backoff, and a second press of "Run
--     what's waiting" could claim it before the backoff had passed. The schedule skipped a task still
--     waiting for approval and fired another beside it.
--   * The ready list took its oldest rows before the server skipped the kinds it cannot run
--     without the owner's session, so enough waiting replies could hide an incident record behind
--     them forever. The list can now be filtered by kind before it is limited.
--   * An execution the sweep had reset could be settled by the worker that first started it. Each
--     start has a number, and settling or releasing must quote it.
--   * An incident that began within half an hour of the last recovery was judged by when the second
--     failed check ran instead of when the relapse began.
--   * The morning brief counted incidents from actions (which an observe-only agent never records,
--     and which are dated by approval), and treated an urgent alert as undelivered when a different
--     channel of it had gone out outside the 24-hour window.
--   * A reply the server recorded and sent, whose execution then stopped before it was settled, was
--     refused on its replay when the customer had written meanwhile, and reported as never sent. The
--     conversation snapshot now says what became of the reply recorded under the request key it is asked
--     about, so the replay can settle that delivery instead of judging the thread.
--
-- Signatures that existed are kept, so a server built before this migration keeps working: the old
-- operation is now a thin wrapper that calls the new one without an attempt number. The new
-- signatures carry no defaults, so a call can never be ambiguous between the two.

alter table private.owner_notifications add column if not exists attempted_at timestamptz not null default now();
alter table private.agent_actions add column if not exists executions integer not null default 0 check (executions >= 0);

-- A schedule whose previous task is unfinished is skipped, not stacked: that includes a task
-- still waiting for the owner to decide what it proposed.
create or replace function private.agent_schedule_fire(p_limit integer default 10, p_kinds text[] default null) returns uuid[]
language plpgsql security definer set search_path = '' as $$
declare
  s private.agent_schedules%rowtype;
  v_task uuid;
  v_ids uuid[] := array[]::uuid[];
begin
  perform private.require_hub_app_server();
  if p_limit is null or p_limit < 1 or p_limit > 50 then
    raise exception 'Fire between 1 and 50 schedules.' using errcode = '22023';
  end if;
  for s in
    select sc.*
    from private.agent_schedules sc
    join private.agents a on a.key = sc.agent_key
    where sc.enabled and a.status = 'active' and sc.next_run_at <= now()
      and (p_kinds is null or sc.task_kind = any (p_kinds))
    order by sc.next_run_at, sc.id
    limit p_limit
    for update of sc skip locked
  loop
    v_task := null;
    if not exists (
      select 1 from private.agent_tasks t
      where t.agent_key = s.agent_key and t.kind = s.task_kind and t.source_kind = 'schedule'
        and t.status in ('queued', 'running', 'awaiting_approval', 'awaiting_session')
    ) then
      insert into private.agent_tasks (agent_key, kind, request_key, payload, priority, requires_session, source_kind, source_ref, status)
      values (s.agent_key, s.task_kind,
              'schedule:' || s.id::text || ':' || to_char(s.next_run_at at time zone 'UTC', 'YYYYMMDD"T"HH24MISS"Z"'),
              s.payload, 5, s.requires_session, 'schedule', s.id::text,
              case when s.requires_session then 'awaiting_session' else 'queued' end)
      on conflict (request_key) do nothing
      returning id into v_task;
    end if;
    update private.agent_schedules
    set next_run_at = private.agent_schedule_next(s.cadence, s.every_seconds, s.at_local, s.timezone, now(), s.next_run_at),
        last_run_at = case when v_task is null then last_run_at else now() end,
        last_task_id = coalesce(v_task, last_task_id)
    where id = s.id;
    if v_task is not null then
      v_ids := v_ids || v_task;
    end if;
  end loop;
  return v_ids;
end;
$$;

-- Housekeeping, as before, except that a notification is unsettled when its latest attempt, not
-- its first, started more than fifteen minutes ago.
create or replace function private.agent_maintenance() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_expired integer;
  v_reset integer;
  v_parked integer;
  v_failed integer;
  v_settled integer;
  v_unsettled integer;
begin
  perform private.require_hub_app_server();
  -- The same lock order as every command that touches both: the task first, then its actions. Expiring
  -- the last open proposal of a task settles that task below, so without this the sweep would hold the
  -- action and then wait for the task while the owner's decision on the same proposal holds the task and
  -- waits for the action. The tasks are locked in id order so two sweeps cannot wait on each other either.
  perform 1 from private.agent_tasks t
  where t.id in (select a.task_id from private.agent_actions a where a.status = 'proposed' and a.expires_at <= now())
  order by t.id
  for update;
  update private.agent_actions set status = 'expired', updated_at = now()
  where status = 'proposed' and expires_at <= now();
  get diagnostics v_expired = row_count;

  update private.agent_actions
  set status = case when decided_by is null then 'auto_approved' else 'approved' end, updated_at = now()
  where status = 'executing' and executing_at < now() - interval '10 minutes';
  get diagnostics v_reset = row_count;

  update private.agent_tasks
  set status = 'failed', last_error_code = 'lease_expired', lease_until = null, finished_at = now(), updated_at = now()
  where status = 'running' and requires_session and lease_until < now() and attempts >= 5;
  get diagnostics v_failed = row_count;

  update private.agent_tasks
  set status = 'awaiting_session', lease_until = null, claimed_at = null, updated_at = now()
  where status = 'running' and requires_session and lease_until < now() and attempts < 5;
  get diagnostics v_parked = row_count;

  update private.agent_tasks t
  set status = 'done', finished_at = now(), lease_until = null, updated_at = now()
  where t.status = 'awaiting_approval'
    and not exists (
      select 1 from private.agent_actions x
      where x.task_id = t.id and x.status in ('proposed', 'approved', 'auto_approved', 'executing'));
  get diagnostics v_settled = row_count;

  update private.owner_notifications set status = 'unknown'
  where status = 'pending' and attempted_at < now() - interval '15 minutes';
  get diagnostics v_unsettled = row_count;

  return jsonb_build_object('expiredActions', v_expired, 'resetExecutions', v_reset,
    'parkedTasks', v_parked, 'failedTasks', v_failed, 'settledTasks', v_settled, 'unsettledNotifications', v_unsettled);
end;
$$;

-- Claims a task that is waiting for the owner's session. Like the list that offers it, the claim
-- honors the task's due time: two presses of "Run what's waiting" can list the same task, and the
-- second must not run it the moment the first one asked for it to be retried later.
create or replace function private.agent_session_task_claim(p_task_id uuid, p_lease_seconds integer default 600) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
begin
  perform private.require_hub_app_server();
  if p_lease_seconds is null or p_lease_seconds < 30 or p_lease_seconds > 3600 then
    raise exception 'Choose a lease between 30 and 3600 seconds.' using errcode = '22023';
  end if;
  update private.agent_tasks t
  set status = 'running', attempts = t.attempts + 1, claimed_at = now(), last_error_code = null,
      lease_until = now() + make_interval(secs => p_lease_seconds), updated_at = now()
  from private.agents a
  where t.id = p_task_id and t.status = 'awaiting_session' and t.due_at <= now()
    and a.key = t.agent_key and a.status = 'active'
  returning t.id into v_id;
  if v_id is null then
    return null;
  end if;
  return private.agent_task_json(v_id);
end;
$$;

-- ---------------------------------------------------------------------------------------
-- Heartbeat and finish, fenced by the attempt number the task was claimed under. A call from a
-- superseded attempt (the lease ran out and the task was handed out again) changes nothing.
-- ---------------------------------------------------------------------------------------
create function private.agent_task_heartbeat(p_task_id uuid, p_lease_seconds integer, p_attempt integer) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_alive boolean;
begin
  perform private.require_hub_app_server();
  if p_lease_seconds is null or p_lease_seconds < 30 or p_lease_seconds > 3600 then
    raise exception 'Choose a lease between 30 and 3600 seconds.' using errcode = '22023';
  end if;
  update private.agent_tasks
  set lease_until = now() + make_interval(secs => p_lease_seconds), updated_at = now()
  where id = p_task_id and status = 'running' and (p_attempt is null or attempts = p_attempt)
  returning true into v_alive;
  return coalesce(v_alive, false);
end;
$$;

create or replace function private.agent_task_heartbeat(p_task_id uuid, p_lease_seconds integer default 600) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_hub_app_server();
  return private.agent_task_heartbeat(p_task_id, p_lease_seconds, null::integer);
end;
$$;

-- Ends a claimed task. A task the owner cancelled, one that already finished, and one that was
-- claimed again under a newer attempt are left as they are (the current status is returned). A task
-- that needs the owner's session and is asked to retry waits for its retry time before it is offered
-- again, like any other task.
create function private.agent_task_finish(
  p_task_id uuid, p_status text, p_result jsonb, p_error_code text, p_retry_at timestamptz, p_attempt integer
) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_task private.agent_tasks%rowtype;
  v_status text;
begin
  perform private.require_hub_app_server();
  if p_status is null or p_status not in ('done', 'failed', 'awaiting_approval', 'awaiting_session', 'queued') then
    raise exception 'Unsupported task status.' using errcode = '22023';
  end if;
  select * into v_task from private.agent_tasks where id = p_task_id for update;
  if not found then
    raise exception 'Unknown agent task.' using errcode = 'P0002';
  end if;
  if v_task.status <> 'running' or (p_attempt is not null and v_task.attempts <> p_attempt) then
    return v_task.status;
  end if;
  v_status := p_status;
  if v_status = 'queued' and v_task.attempts >= 5 then
    v_status := 'failed';
  elsif v_status = 'queued' and v_task.requires_session then
    v_status := 'awaiting_session';
  end if;
  update private.agent_tasks
  set status = v_status,
      result = coalesce(p_result, result),
      last_error_code = p_error_code,
      due_at = case when p_status = 'queued' and v_status in ('queued', 'awaiting_session')
                    then coalesce(p_retry_at, now() + interval '5 minutes') else due_at end,
      claimed_at = case when v_status in ('queued', 'awaiting_session') then null else claimed_at end,
      lease_until = null,
      finished_at = case when v_status in ('done', 'failed') then now() else finished_at end,
      updated_at = now()
  where id = p_task_id;
  return v_status;
end;
$$;

create or replace function private.agent_task_finish(
  p_task_id uuid, p_status text, p_result jsonb default null, p_error_code text default null,
  p_retry_at timestamptz default null
) returns text
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_hub_app_server();
  return private.agent_task_finish(p_task_id, p_status, p_result, p_error_code, p_retry_at, null::integer);
end;
$$;

-- ---------------------------------------------------------------------------------------
-- Proposals. The task is locked while its status is checked and the action is inserted, so a
-- cancellation either completes first (and the proposal is refused) or waits for the proposal
-- (and then rejects it with the rest).
-- ---------------------------------------------------------------------------------------
create or replace function private.agent_action_propose(
  p_task_id uuid, p_run_id uuid, p_kind text, p_target_kind text, p_target_id text,
  p_preview text, p_input jsonb default '{}'::jsonb
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_task private.agent_tasks%rowtype;
  v_agent private.agents%rowtype;
  v_status text;
  v_id uuid;
  v_key uuid;
begin
  perform private.require_hub_app_server();
  select * into v_task from private.agent_tasks where id = p_task_id for update;
  if not found then
    raise exception 'Unknown agent task.' using errcode = 'P0002';
  end if;
  if v_task.status <> 'running' then
    raise exception 'Only a running task can propose an action.' using errcode = '55000';
  end if;
  if p_run_id is not null and not exists (select 1 from private.agent_runs r where r.id = p_run_id and r.task_id = p_task_id) then
    raise exception 'That run does not belong to this task.' using errcode = '55000';
  end if;
  select * into v_agent from private.agents where key = v_task.agent_key;
  if v_agent.autonomy = 'observe' then
    raise exception 'This agent is observe-only and cannot propose actions.' using errcode = '42501';
  end if;
  v_status := case
    when v_agent.autonomy = 'act' and coalesce(v_agent.config -> 'auto_approve_kinds', '[]'::jsonb) ? p_kind then 'auto_approved'
    else 'proposed' end;
  insert into private.agent_actions (task_id, run_id, agent_key, kind, target_kind, target_id, preview, input, status)
  values (p_task_id, p_run_id, v_task.agent_key, p_kind, p_target_kind, coalesce(p_target_id, ''), p_preview,
          coalesce(p_input, '{}'::jsonb), v_status)
  on conflict (task_id, kind, target_id) where task_id is not null do nothing
  returning id, request_key into v_id, v_key;
  if v_id is null then
    select a.id, a.request_key, a.status into v_id, v_key, v_status
    from private.agent_actions a
    where a.task_id = p_task_id and a.kind = p_kind and a.target_id = coalesce(p_target_id, '');
    return jsonb_build_object('id', v_id, 'status', v_status, 'requestKey', v_key, 'created', false);
  end if;
  return jsonb_build_object('id', v_id, 'status', v_status, 'requestKey', v_key, 'created', true);
end;
$$;

-- ---------------------------------------------------------------------------------------
-- Ready actions and executions. The list can be narrowed by kind before it is limited, and an
-- action whose task was cancelled is never ready or started.
-- ---------------------------------------------------------------------------------------
create function private.agent_actions_ready(p_limit integer, p_kinds text[], p_exclude_kinds text[]) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_hub_app_server();
  if p_limit is null or p_limit < 1 or p_limit > 50 then
    raise exception 'List between 1 and 50 actions.' using errcode = '22023';
  end if;
  return (
    select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'kind', x.kind, 'agentKey', x.agent_key) order by x.created_at), '[]'::jsonb)
    from (
      select a.id, a.kind, a.agent_key, a.created_at
      from private.agent_actions a
      where a.status in ('approved', 'auto_approved')
        and (p_kinds is null or a.kind = any (p_kinds))
        and (p_exclude_kinds is null or a.kind <> all (p_exclude_kinds))
        and not exists (select 1 from private.agent_tasks t where t.id = a.task_id and t.status = 'cancelled')
      order by a.created_at
      limit p_limit
    ) x
  );
end;
$$;

create or replace function private.agent_actions_ready(p_limit integer default 10) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_hub_app_server();
  return private.agent_actions_ready(p_limit, null::text[], null::text[]);
end;
$$;

-- Starts carrying out one ready action: exactly one caller gets it, and it learns the number of
-- this start ('execution'), which it must quote when it settles or releases the action.
create or replace function private.agent_action_execution(p_action_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_action private.agent_actions%rowtype;
begin
  perform private.require_hub_app_server();
  update private.agent_actions a
  set status = 'executing', executing_at = now(), executions = a.executions + 1, updated_at = now()
  where a.id = p_action_id and a.status in ('approved', 'auto_approved')
    and not exists (select 1 from private.agent_tasks t where t.id = a.task_id and t.status = 'cancelled')
  returning a.* into v_action;
  if not found then
    return null;
  end if;
  return jsonb_build_object(
    'id', v_action.id, 'agentKey', v_action.agent_key, 'taskId', v_action.task_id, 'kind', v_action.kind,
    'targetKind', v_action.target_kind, 'targetId', v_action.target_id, 'input', v_action.input,
    'requestKey', v_action.request_key, 'autoApproved', v_action.decided_by is null, 'execution', v_action.executions);
end;
$$;

-- Records how an execution went, as the AI assistant identity. A report that quotes an execution
-- number other than the current one (the sweep reset a slow execution and another worker started
-- it) is refused. The task is locked before the action, the same order cancellation uses.
create function private.agent_action_executed(p_action_id uuid, p_ok boolean, p_result jsonb, p_execution integer) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_action private.agent_actions%rowtype;
  v_task uuid;
begin
  perform private.require_hub_app_server();
  select a.task_id into v_task from private.agent_actions a where a.id = p_action_id;
  if v_task is not null then
    perform 1 from private.agent_tasks t where t.id = v_task for update;
  end if;
  update private.agent_actions
  set status = case when p_ok then 'executed' else 'failed' end,
      executed_at = now(), result = p_result, updated_at = now()
  where id = p_action_id and status = 'executing' and (p_execution is null or executions = p_execution)
  returning * into v_action;
  if not found then
    raise exception 'That action is not being carried out.' using errcode = '55000';
  end if;
  insert into private.audit_events (actor_id, action, entity_type, entity_id, metadata)
  values ('a1a00000-a1a0-4000-8000-000000000001',
          case when p_ok then 'agent.action.executed' else 'agent.action.failed' end,
          'agent_action', v_action.id,
          jsonb_build_object('agent', v_action.agent_key, 'kind', v_action.kind, 'auto', v_action.decided_by is null));
  perform private.agent_close_task_if_settled(v_action.task_id);
end;
$$;

create or replace function private.agent_action_executed(p_action_id uuid, p_ok boolean, p_result jsonb default null) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_hub_app_server();
  perform private.agent_action_executed(p_action_id, p_ok, p_result, null::integer);
end;
$$;

-- Hands an execution back, unstarted in effect: the action returns to the state it was approved in
-- and can be started again. It is for an execution that could not begin its work at all (the owner's
-- session had lapsed before anything was sent), never for one that may have had an effect.
create function private.agent_action_release(p_action_id uuid, p_execution integer) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_released boolean;
begin
  perform private.require_hub_app_server();
  update private.agent_actions
  set status = case when decided_by is null then 'auto_approved' else 'approved' end, executing_at = null, updated_at = now()
  where id = p_action_id and status = 'executing' and (p_execution is null or executions = p_execution)
  returning true into v_released;
  return coalesce(v_released, false);
end;
$$;

-- ---------------------------------------------------------------------------------------
-- Notifications: each attempt has its own start time.
-- ---------------------------------------------------------------------------------------
create or replace function private.agent_notify_begin(
  p_channel text, p_severity text, p_subject text, p_body text, p_dedupe_key text,
  p_agent_key text default null, p_task_id uuid default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_row private.owner_notifications%rowtype;
begin
  perform private.require_hub_app_server();
  insert into private.owner_notifications (dedupe_key, channel, severity, subject, body, agent_key, task_id)
  values (p_dedupe_key, p_channel, p_severity, left(p_subject, 200), left(p_body, 4000), p_agent_key, p_task_id)
  on conflict (dedupe_key, channel) do nothing
  returning * into v_row;
  if found then
    return jsonb_build_object('id', v_row.id, 'duplicate', false, 'status', v_row.status);
  end if;
  update private.owner_notifications
  set status = 'pending', attempts = attempts + 1, attempted_at = now()
  where dedupe_key = p_dedupe_key and channel = p_channel and status = 'failed' and attempts < 3
  returning * into v_row;
  if found then
    return jsonb_build_object('id', v_row.id, 'duplicate', false, 'status', v_row.status);
  end if;
  select * into v_row from private.owner_notifications where dedupe_key = p_dedupe_key and channel = p_channel;
  return jsonb_build_object('id', v_row.id, 'duplicate', true, 'status', v_row.status);
end;
$$;

-- ---------------------------------------------------------------------------------------
-- Owner operations. Deciding locks the task before the action (the order cancellation uses), and
-- cancelling also rejects the actions that were approved but not yet started.
-- ---------------------------------------------------------------------------------------
create or replace function hub.decide_agent_action(p_action_id uuid, p_decision text, p_note text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_actor jsonb;
  v_action private.agent_actions%rowtype;
  v_decided boolean := false;
begin
  v_actor := hub.authorize_app_command();
  if p_decision is null or p_decision not in ('approve', 'reject') then
    raise exception 'Choose approve or reject.' using errcode = '22023';
  end if;
  if p_note is not null and char_length(p_note) > 1000 then
    raise exception 'Keep the note under 1,000 characters.' using errcode = '22023';
  end if;
  perform 1 from private.agent_tasks t where t.id = (select a.task_id from private.agent_actions a where a.id = p_action_id) for update;
  select * into v_action from private.agent_actions where id = p_action_id for update;
  if not found then
    raise exception 'Unknown agent action.' using errcode = 'P0002';
  end if;
  if v_action.status = 'proposed' and v_action.expires_at <= now() then
    update private.agent_actions set status = 'expired', updated_at = now()
    where id = p_action_id returning * into v_action;
    perform private.agent_close_task_if_settled(v_action.task_id);
  elsif v_action.status = 'proposed' then
    update private.agent_actions
    set status = case p_decision when 'approve' then 'approved' else 'rejected' end,
        decided_by = (v_actor ->> 'user_id')::uuid, decided_at = now(),
        decision_note = nullif(btrim(p_note), ''), updated_at = now()
    where id = p_action_id returning * into v_action;
    v_decided := true;
    insert into private.audit_events (actor_id, action, entity_type, entity_id, metadata)
    values ((v_actor ->> 'user_id')::uuid, 'agent.action.decided', 'agent_action', v_action.id,
            jsonb_build_object('agent', v_action.agent_key, 'kind', v_action.kind, 'decision', p_decision));
    if p_decision = 'reject' then
      perform private.agent_close_task_if_settled(v_action.task_id);
    end if;
  end if;
  return jsonb_build_object(
    'id', v_action.id, 'status', v_action.status, 'decided', v_decided, 'kind', v_action.kind,
    'targetKind', v_action.target_kind, 'targetId', v_action.target_id, 'agentKey', v_action.agent_key,
    'taskId', v_action.task_id, 'requestKey', v_action.request_key);
end;
$$;

-- An action that is already being carried out is not touched: it may be mid-send, and its own
-- report settles it.
create or replace function hub.cancel_agent_task(p_task_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_actor jsonb;
  v_task private.agent_tasks%rowtype;
begin
  v_actor := hub.authorize_app_command();
  select * into v_task from private.agent_tasks where id = p_task_id for update;
  if not found then
    raise exception 'Unknown agent task.' using errcode = 'P0002';
  end if;
  if v_task.status in ('queued', 'running', 'awaiting_approval', 'awaiting_session') then
    update private.agent_tasks
    set status = 'cancelled', finished_at = now(), lease_until = null, updated_at = now()
    where id = p_task_id returning * into v_task;
    update private.agent_actions
    set status = 'rejected', decided_by = (v_actor ->> 'user_id')::uuid, decided_at = now(),
        decision_note = 'The task was cancelled.', updated_at = now()
    where task_id = p_task_id and status in ('proposed', 'approved', 'auto_approved');
    insert into private.audit_events (actor_id, action, entity_type, entity_id, metadata)
    values ((v_actor ->> 'user_id')::uuid, 'agent.task.cancelled', 'agent_task', v_task.id,
            jsonb_build_object('agent', v_task.agent_key, 'kind', v_task.kind));
  end if;
  return jsonb_build_object('id', v_task.id, 'status', v_task.status);
end;
$$;

-- ---------------------------------------------------------------------------------------
-- Health probes: a relapse is flapping when its first failed check came within thirty minutes of
-- the last recovery. failing_since is the first failure of the current streak, so the incident
-- being opened on the second failed check no longer hides a relapse that began at 12:25.
-- ---------------------------------------------------------------------------------------
create or replace function private.agent_probe_record(
  p_target_key text, p_ok boolean, p_status_code integer, p_latency_ms integer, p_failure text default null,
  p_threshold integer default 2, p_agent_key text default 'platform_engineer'
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v private.agent_probe_state%rowtype;
  v_failures integer;
  v_transition text := 'none';
  v_task uuid;
begin
  perform private.require_hub_app_server();
  if p_target_key is null or p_target_key !~ '^[a-z][a-z0-9_]{1,40}$' then
    raise exception 'Choose a valid probe target.' using errcode = '22023';
  end if;
  if p_ok is null or p_status_code is null or p_status_code not between 0 and 999
    or p_latency_ms is null or p_latency_ms not between 0 and 600000
    or p_threshold is null or p_threshold not between 1 and 10
    or (p_ok and p_failure is not null)
    or (not p_ok and (p_failure is null or p_failure !~ '^[a-z_]{1,40}$')) then
    raise exception 'Invalid probe result.' using errcode = '22023';
  end if;
  if not exists (select 1 from private.agents where key = p_agent_key) then
    raise exception 'Unknown agent.' using errcode = 'P0002';
  end if;

  insert into private.agent_probe_state (target_key) values (p_target_key) on conflict (target_key) do nothing;
  select * into v from private.agent_probe_state where target_key = p_target_key for update;

  if p_ok then
    if v.state = 'down' then
      v_transition := 'recovered';
      insert into private.agent_tasks (agent_key, kind, request_key, source_kind, source_ref, payload, priority)
      values (p_agent_key, 'probe.recovery', 'probe.recovery:' || p_target_key || ':' || v.incident_seq, 'probe', p_target_key,
              jsonb_build_object('target', p_target_key, 'incident', v.incident_seq, 'downSince', v.failing_since,
                                 'recoveredAt', now(), 'statusCode', p_status_code),
              3)
      on conflict (request_key) do nothing
      returning id into v_task;
    end if;
    update private.agent_probe_state
    set state = 'up', consecutive_failures = 0, failing_since = null, last_checked_at = now(), last_ok_at = now(),
        last_status_code = p_status_code, last_latency_ms = p_latency_ms, last_failure = null,
        last_recovered_at = case when v_transition = 'recovered' then now() else last_recovered_at end,
        updated_at = now()
    where target_key = p_target_key
    returning * into v;
  else
    v_failures := least(v.consecutive_failures + 1, 100000);
    v.failing_since := case when v.consecutive_failures = 0 then now() else v.failing_since end;
    if v_failures >= p_threshold and v.state <> 'down' then
      v_transition := 'down';
      v.incident_seq := v.incident_seq + 1;
      insert into private.agent_tasks (agent_key, kind, request_key, source_kind, source_ref, payload, priority)
      values (p_agent_key, 'probe.incident', 'probe.incident:' || p_target_key || ':' || v.incident_seq, 'probe', p_target_key,
              jsonb_build_object('target', p_target_key, 'incident', v.incident_seq, 'since', v.failing_since,
                                 'failures', v_failures, 'statusCode', p_status_code, 'failure', p_failure,
                                 'flapping', coalesce(v.failing_since < v.last_recovered_at + interval '30 minutes', false)),
              1)
      on conflict (request_key) do nothing
      returning id into v_task;
    end if;
    update private.agent_probe_state
    set state = case when v_transition = 'down' then 'down' else state end,
        consecutive_failures = v_failures, failing_since = v.failing_since, incident_seq = v.incident_seq,
        last_checked_at = now(), last_status_code = p_status_code, last_latency_ms = p_latency_ms, last_failure = p_failure,
        updated_at = now()
    where target_key = p_target_key
    returning * into v;
  end if;

  return jsonb_build_object('target', p_target_key, 'state', v.state, 'transition', v_transition,
                            'failures', v.consecutive_failures, 'incident', v.incident_seq, 'taskId', v_task);
end;
$$;

-- ---------------------------------------------------------------------------------------
-- The morning brief's facts. Incidents are counted from the probe tasks, which exist whether or
-- not the on-call agent records actions, and are dated by when the incident began or closed. An
-- urgent alert is undelivered only when no channel of that alert (whenever it was sent) reached
-- the owner.
-- ---------------------------------------------------------------------------------------
create or replace function private.agent_brief_facts() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_today timestamptz := private.agent_day_start();
  v_yesterday timestamptz := (date_trunc('day', now() at time zone 'America/New_York') - interval '1 day') at time zone 'America/New_York';
begin
  perform private.require_hub_app_server();
  return jsonb_build_object(
    'generatedAt', now(),
    'yesterdayStart', v_yesterday,
    'todayStart', v_today,
    'approvals', (select jsonb_build_object('count', count(*), 'oldestAt', min(created_at))
                  from private.agent_actions where status = 'proposed'),
    'awaitingSession', (select count(*) from private.agent_tasks where status = 'awaiting_session'),
    'incidents', (select coalesce(jsonb_agg(jsonb_build_object('target', target_key, 'since', failing_since, 'failures', consecutive_failures)
                                            order by failing_since, target_key), '[]'::jsonb)
                  from private.agent_probe_state where state = 'down'),
    'failedTasks', (select count(*) from private.agent_tasks where status = 'failed' and finished_at >= now() - interval '24 hours'),
    -- An urgent alert "did not reach the owner" when no channel of it was sent. The alerts looked at are the ones
    -- with urgent activity in the last day; their other rows count whenever they were written.
    'undeliveredAlerts', (select count(*) from (
                            select 1 from private.owner_notifications n
                            where n.dedupe_key in (select u.dedupe_key from private.owner_notifications u
                                                   where u.severity = 'urgent' and u.created_at >= now() - interval '24 hours')
                            group by n.dedupe_key having bool_and(n.status <> 'sent')) unsent),
    'yesterday', jsonb_build_object(
      'runs', (select count(*) from private.agent_runs where started_at >= v_yesterday and started_at < v_today),
      'tasksDone', (select count(*) from private.agent_tasks where status = 'done' and finished_at >= v_yesterday and finished_at < v_today),
      'tasksFailed', (select count(*) from private.agent_tasks where status = 'failed' and finished_at >= v_yesterday and finished_at < v_today),
      'actionsExecuted', (select count(*) from private.agent_actions where status = 'executed' and executed_at >= v_yesterday and executed_at < v_today),
      'incidentsOpened', (select count(*) from private.agent_tasks
                          where kind = 'probe.incident' and created_at >= v_yesterday and created_at < v_today),
      'incidentsClosed', (select count(*) from private.agent_tasks
                          where kind = 'probe.recovery' and created_at >= v_yesterday and created_at < v_today),
      'spendCents', (select coalesce(sum(cost_cents), 0) from private.agent_runs where started_at >= v_yesterday and started_at < v_today)),
    'agents', (select coalesce(jsonb_agg(jsonb_build_object(
                         'key', a.key, 'name', a.display_name, 'status', a.status, 'budgetCents', a.daily_budget_cents,
                         'spentCents', coalesce(s.spent, 0), 'hitBudget', coalesce(s.hit, false)) order by a.key), '[]'::jsonb)
               from private.agents a
               left join lateral (
                 select sum(r.cost_cents) as spent, bool_or(r.outcome = 'budget_exhausted') as hit
                 from private.agent_runs r
                 where r.agent_key = a.key and r.started_at >= v_yesterday and r.started_at < v_today) s on true),
    'billing', jsonb_build_object(
      'pastDue', (select count(*) from private.billing_subscriptions where livemode and status in ('past_due', 'unpaid')),
      'trialsEnding', (select count(*) from private.billing_subscriptions
                       where livemode and status = 'trialing' and trial_end >= now() and trial_end < now() + interval '7 days'))
  );
end;
$$;

-- ---------------------------------------------------------------------------------------
-- The conversation snapshot, as before, plus ownReplyDelivery: the delivery status (pending, sent, failed or
-- unknown) of the outbound message recorded under p_request_key, or null when there is none or no key is given.
-- ---------------------------------------------------------------------------------------
create or replace function private.agent_communication_snapshot(
  p_id uuid, p_request_key uuid, p_messages integer, p_chars integer
) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  c private.communications%rowtype;
  v_inbound_id uuid;
  v_inbound_at timestamptz;
  v_head uuid;
  v_answered boolean := false;
  v_messages jsonb := '[]'::jsonb;
begin
  perform private.require_hub_app_server();
  if p_messages is null or p_messages < 0 or p_messages > 10 then
    raise exception 'Read between 0 and 10 messages.' using errcode = '22023';
  end if;
  if p_chars is null or p_chars < 100 or p_chars > 4000 then
    raise exception 'Clip messages to between 100 and 4000 characters.' using errcode = '22023';
  end if;
  select * into c from private.communications where id = p_id;
  if not found then
    return null;
  end if;
  select i.id, i.created_at into v_inbound_id, v_inbound_at from private.communication_messages i
  where i.communication_id = c.id and i.direction = 'inbound'
  order by i.created_at desc, i.id desc limit 1;
  select m.id into v_head from private.communication_messages m
  where m.communication_id = c.id and m.direction in ('inbound', 'outbound')
    and (p_request_key is null or m.request_key is distinct from p_request_key)
  order by m.created_at desc, m.id desc limit 1;
  if v_inbound_id is not null then
    v_answered := exists (
      select 1 from private.communication_messages a
      where a.communication_id = c.id and a.direction in ('outbound', 'note') and (a.created_at, a.id) > (v_inbound_at, v_inbound_id));
  end if;
  if p_messages > 0 then
    select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'direction', t.direction, 'at', t.created_at, 'body', left(t.body, p_chars))
                              order by t.created_at, t.id), '[]'::jsonb)
    into v_messages
    from (
      select m.id, m.direction, m.created_at, m.body from private.communication_messages m
      where m.communication_id = c.id and m.direction in ('inbound', 'outbound')
      order by m.created_at desc, m.id desc limit p_messages) t;
  end if;
  return jsonb_build_object(
    'id', c.id, 'reference', c.reference, 'channel', c.channel, 'status', c.status, 'inquiryType', c.inquiry_type,
    'productSlug', (select p.slug from hub.products p where p.id = c.product_id),
    'createdAt', c.created_at, 'updatedAt', c.updated_at,
    'canEmail', c.contact_email is not null,
    'canText', coalesce(c.contact_phone ~ '^\+[1-9][0-9]{7,14}$', false),
    -- Subjects of phone and web-form conversations name the caller, and a text's carries the number.
    'subject', case when c.channel = 'email' then c.subject end,
    'headMessageId', v_head, 'latestInboundId', v_inbound_id, 'answered', v_answered,
    -- How many times each side has written, so a first message (nobody has replied yet) can be told from a follow-up.
    'inboundCount', (select count(*) from private.communication_messages x where x.communication_id = c.id and x.direction = 'inbound'),
    'outboundCount', (select count(*) from private.communication_messages x where x.communication_id = c.id and x.direction = 'outbound'),
    'ownReplyDelivery', (select o.delivery from private.communication_messages o
                         where p_request_key is not null and o.communication_id = c.id and o.direction = 'outbound' and o.request_key = p_request_key),
    'messages', v_messages);
end;
$$;

-- ---------------------------------------------------------------------------------------
-- Grants for the new signatures: the Hub server role only, like every operation above.
-- ---------------------------------------------------------------------------------------
revoke all on function
  private.agent_task_heartbeat(uuid, integer, integer),
  private.agent_task_finish(uuid, text, jsonb, text, timestamp with time zone, integer),
  private.agent_actions_ready(integer, text[], text[]),
  private.agent_action_executed(uuid, boolean, jsonb, integer),
  private.agent_action_release(uuid, integer)
from public, anon, authenticated, service_role, hub_app_server;

grant execute on function
  private.agent_task_heartbeat(uuid, integer, integer),
  private.agent_task_finish(uuid, text, jsonb, text, timestamp with time zone, integer),
  private.agent_actions_ready(integer, text[], text[]),
  private.agent_action_executed(uuid, boolean, jsonb, integer),
  private.agent_action_release(uuid, integer)
to hub_app_server;
