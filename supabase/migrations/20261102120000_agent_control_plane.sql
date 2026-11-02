-- AI team control plane: the registry, schedules, work queue, runs, proposed actions
-- and owner notifications that let AI agents work for the owner from inside the Hub.
--
-- Boundary (the same closed shape as the AI automation operations in 20261020120000
-- and the usage ledger in 20261021120000):
--   * every table has row level security and NO privilege for any browser, service or
--     server role;
--   * the Hub server (hub_app_server) reaches them only through the security definer
--     operations below. Each refuses every other session user and acts on one task,
--     run, action or notification at a time;
--   * the owner reads and decides through hub.* operations that authorize the current
--     SMS administrator session themselves (authorize_app_admin for reads,
--     authorize_app_command for decisions), so a signed-out or lapsed session fails
--     closed;
--   * rows carry kinds, counts, references, decisions and short operator-facing
--     previews. Inbound message bodies never enter audit metadata, run summaries or
--     task payloads (SECURITY.md: inbound text is possible_phi).
--
-- Every agent is seeded PAUSED. Nothing runs until the server flag HUB_AGENTS_ENABLED
-- is set (a later change) and the owner resumes an agent on the Team screen.

create table private.agents (
  key text primary key check (key ~ '^[a-z][a-z0-9_]{1,40}$'),
  display_name text not null check (char_length(display_name) between 1 and 80),
  role_summary text not null check (char_length(role_summary) <= 400),
  status text not null default 'paused' check (status in ('active', 'paused')),
  -- observe: reads and reports only. propose: drafts actions the owner approves.
  -- act: executes the action kinds listed in config.auto_approve_kinds, proposes the rest.
  autonomy text not null default 'observe' check (autonomy in ('observe', 'propose', 'act')),
  model_tier text not null default 'draft' check (model_tier in ('fast', 'draft', 'quality')),
  daily_budget_cents integer not null default 200 check (daily_budget_cents between 0 and 100000),
  tool_allowlist text[] not null default array[]::text[],
  prompt_version text not null default 'v1' check (prompt_version ~ '^[a-z0-9.-]{1,20}$'),
  config jsonb not null default '{}'::jsonb check (jsonb_typeof(config) = 'object' and pg_column_size(config) <= 8192),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table private.agent_schedules (
  id uuid primary key default gen_random_uuid(),
  agent_key text not null references private.agents(key) on delete cascade,
  task_kind text not null check (task_kind ~ '^[a-z][a-z0-9_.]{1,60}$'),
  cadence text not null check (cadence in ('interval', 'daily')),
  every_seconds integer check (every_seconds between 60 and 86400),
  at_local time,
  timezone text not null default 'America/New_York' check (timezone in ('America/New_York', 'UTC')),
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object' and pg_column_size(payload) <= 16384),
  -- A task that reads another application needs the owner's live SMS session, so it
  -- waits (awaiting_session) until the owner is signed in instead of running unattended.
  requires_session boolean not null default false,
  enabled boolean not null default true,
  next_run_at timestamptz not null default now(),
  last_run_at timestamptz,
  last_task_id uuid,
  unique (agent_key, task_kind),
  check ((cadence = 'interval') = (every_seconds is not null)),
  check ((cadence = 'daily') = (at_local is not null))
);

create table private.agent_tasks (
  id uuid primary key default gen_random_uuid(),
  agent_key text not null references private.agents(key) on delete restrict,
  kind text not null check (kind ~ '^[a-z][a-z0-9_.]{1,60}$'),
  -- Idempotency: the same event or schedule firing can be enqueued any number of times.
  request_key text not null unique check (char_length(request_key) between 1 and 200),
  source_kind text check (source_kind in ('schedule', 'communication', 'billing_event', 'probe', 'owner', 'agent')),
  source_ref text check (char_length(source_ref) <= 200),
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object' and pg_column_size(payload) <= 16384),
  priority integer not null default 5 check (priority between 1 and 9),
  requires_session boolean not null default false,
  status text not null default 'queued'
    check (status in ('queued', 'running', 'awaiting_approval', 'awaiting_session', 'done', 'failed', 'cancelled')),
  due_at timestamptz not null default now(),
  claimed_at timestamptz,
  lease_until timestamptz,
  attempts integer not null default 0 check (attempts between 0 and 10),
  last_error_code text check (last_error_code ~ '^[a-z_]{1,60}$'),
  result jsonb check (result is null or (jsonb_typeof(result) = 'object' and pg_column_size(result) <= 16384)),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz
);
create index agent_tasks_claimable on private.agent_tasks (status, due_at, priority) where status in ('queued', 'running');
create index agent_tasks_agent on private.agent_tasks (agent_key, created_at desc);

-- One row per model execution. Tokens and cost are provenance for the budget and the
-- Team screen; the summary is operator-facing text the server has already redacted.
create table private.agent_runs (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references private.agent_tasks(id) on delete cascade,
  agent_key text not null references private.agents(key) on delete restrict,
  model text not null check (model ~ '^[a-z0-9.-]{1,80}$'),
  prompt_version text not null check (prompt_version ~ '^[a-z0-9.-]{1,20}$'),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  outcome text check (outcome in ('completed', 'failed', 'budget_exhausted', 'no_result', 'refused', 'cancelled')),
  rounds integer not null default 0 check (rounds >= 0),
  tool_calls integer not null default 0 check (tool_calls >= 0),
  input_tokens bigint not null default 0 check (input_tokens >= 0),
  output_tokens bigint not null default 0 check (output_tokens >= 0),
  cache_read_tokens bigint not null default 0 check (cache_read_tokens >= 0),
  cache_write_tokens bigint not null default 0 check (cache_write_tokens >= 0),
  cost_cents numeric(10, 4) not null default 0 check (cost_cents >= 0),
  summary text check (char_length(summary) <= 2000),
  error_code text check (error_code ~ '^[a-z_]{1,60}$')
);
create index agent_runs_agent_day on private.agent_runs (agent_key, started_at desc);
create index agent_runs_task on private.agent_runs (task_id);

-- Every side effect an agent wants. Nothing here is executed by the database: the server
-- performs an approved action through the existing reviewed path and reports the result.
create table private.agent_actions (
  id uuid primary key default gen_random_uuid(),
  task_id uuid references private.agent_tasks(id) on delete set null,
  run_id uuid references private.agent_runs(id) on delete set null,
  agent_key text not null references private.agents(key) on delete restrict,
  kind text not null check (kind in
    ('communication.reply', 'communication.note', 'communication.update', 'incident.open', 'incident.resolve', 'import.run')),
  target_kind text check (target_kind in ('communication', 'probe_target', 'import_source')),
  target_id text not null default '' check (char_length(target_id) <= 200),
  -- Becomes the request key of the inbox operation that carries the action out, so a
  -- retried execution can never send or record twice.
  request_key uuid not null unique default gen_random_uuid(),
  preview text not null check (char_length(preview) between 1 and 6000),
  input jsonb not null default '{}'::jsonb check (jsonb_typeof(input) = 'object' and pg_column_size(input) <= 16384),
  status text not null default 'proposed'
    check (status in ('proposed', 'approved', 'auto_approved', 'executing', 'rejected', 'executed', 'failed', 'expired')),
  decided_by uuid references auth.users(id) on delete set null,
  decided_at timestamptz,
  decision_note text check (char_length(decision_note) <= 1000),
  executing_at timestamptz,
  executed_at timestamptz,
  result jsonb check (result is null or (jsonb_typeof(result) = 'object' and pg_column_size(result) <= 16384)),
  expires_at timestamptz not null default now() + interval '7 days',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- A retried task proposes the same action once.
create unique index agent_actions_once_per_task on private.agent_actions (task_id, kind, target_id) where task_id is not null;
create index agent_actions_open on private.agent_actions (status, created_at) where status in ('proposed', 'approved', 'auto_approved', 'executing');

create table private.owner_notifications (
  id uuid primary key default gen_random_uuid(),
  dedupe_key text not null check (char_length(dedupe_key) between 1 and 200),
  channel text not null check (channel in ('sms', 'email')),
  severity text not null check (severity in ('info', 'warning', 'urgent')),
  subject text not null check (char_length(subject) <= 200),
  body text not null check (char_length(body) <= 4000),
  status text not null default 'pending' check (status in ('pending', 'sent', 'failed', 'unknown', 'suppressed')),
  attempts integer not null default 1 check (attempts between 1 and 3),
  provider_message_id text check (char_length(provider_message_id) <= 400),
  agent_key text references private.agents(key) on delete set null,
  task_id uuid references private.agent_tasks(id) on delete set null,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  unique (dedupe_key, channel)
);
create index owner_notifications_recent on private.owner_notifications (created_at desc);

alter table private.agents enable row level security;
alter table private.agent_schedules enable row level security;
alter table private.agent_tasks enable row level security;
alter table private.agent_runs enable row level security;
alter table private.agent_actions enable row level security;
alter table private.owner_notifications enable row level security;
revoke all on private.agents, private.agent_schedules, private.agent_tasks, private.agent_runs,
  private.agent_actions, private.owner_notifications
  from public, anon, authenticated, service_role, hub_app_server;

-- ---------------------------------------------------------------------------------------
-- Internal helpers. No role executes these directly; the operations below call them.
-- ---------------------------------------------------------------------------------------

-- The agents' budgets reset at midnight Eastern, the owner's working day.
create function private.agent_day_start() returns timestamptz
language sql stable set search_path = '' as $$
  select date_trunc('day', now() at time zone 'America/New_York') at time zone 'America/New_York';
$$;

create function private.agent_spent_today_cents(p_agent_key text) returns numeric
language sql stable set search_path = '' as $$
  select coalesce(sum(r.cost_cents), 0)
  from private.agent_runs r
  where r.agent_key = p_agent_key and r.started_at >= private.agent_day_start();
$$;

create function private.agent_budget_json(p_agent_key text) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'budgetCents', a.daily_budget_cents,
    'spentCents', s.spent,
    'remainingCents', greatest(a.daily_budget_cents - s.spent, 0),
    'dayStart', private.agent_day_start())
  from private.agents a
  cross join lateral (select private.agent_spent_today_cents(a.key) as spent) s
  where a.key = p_agent_key;
$$;

-- The next run strictly after p_now. An interval schedule stays on its own grid (anchor +
-- k * interval), so a server that was down fires once and resumes, never a backlog. A daily
-- schedule fires at the same local wall-clock time through daylight-saving changes.
create function private.agent_schedule_next(
  p_cadence text, p_every_seconds integer, p_at_local time, p_timezone text,
  p_now timestamptz, p_anchor timestamptz
) returns timestamptz
language plpgsql stable set search_path = '' as $$
declare
  v_steps bigint;
  v_local timestamp;
  v_candidate timestamp;
begin
  if p_cadence = 'interval' then
    if p_anchor is null then
      return p_now + make_interval(secs => p_every_seconds);
    end if;
    v_steps := floor(extract(epoch from (p_now - p_anchor)) / p_every_seconds)::bigint + 1;
    return p_anchor + make_interval(secs => (v_steps * p_every_seconds)::double precision);
  end if;
  v_local := p_now at time zone p_timezone;
  v_candidate := date_trunc('day', v_local) + p_at_local;
  if v_candidate <= v_local then
    v_candidate := v_candidate + interval '1 day';
  end if;
  return v_candidate at time zone p_timezone;
end;
$$;

-- A task as the server's scheduler needs it: the work, the agent's current settings and
-- today's budget. Settings are read at claim time, so a pause or autonomy change applies
-- to the next task, not to a stale snapshot.
create function private.agent_task_json(p_task_id uuid) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', t.id, 'agentKey', t.agent_key, 'kind', t.kind, 'requestKey', t.request_key,
    'payload', t.payload, 'priority', t.priority, 'attempts', t.attempts,
    'sourceKind', t.source_kind, 'sourceRef', t.source_ref, 'requiresSession', t.requires_session,
    'leaseUntil', t.lease_until,
    'agent', jsonb_build_object(
      'autonomy', a.autonomy, 'modelTier', a.model_tier, 'promptVersion', a.prompt_version,
      'toolAllowlist', to_jsonb(a.tool_allowlist), 'config', a.config),
    'budget', private.agent_budget_json(a.key))
  from private.agent_tasks t
  join private.agents a on a.key = t.agent_key
  where t.id = p_task_id;
$$;

-- One agent as the owner sees it on the Team screen.
create function private.agent_summary_json(p_key text) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'key', a.key, 'displayName', a.display_name, 'roleSummary', a.role_summary,
    'status', a.status, 'autonomy', a.autonomy, 'modelTier', a.model_tier,
    'dailyBudgetCents', a.daily_budget_cents,
    'spentTodayCents', private.agent_spent_today_cents(a.key),
    'promptVersion', a.prompt_version, 'toolAllowlist', to_jsonb(a.tool_allowlist),
    'config', a.config, 'updatedAt', a.updated_at,
    'lastRun', (
      select jsonb_build_object('startedAt', r.started_at, 'outcome', r.outcome)
      from private.agent_runs r where r.agent_key = a.key order by r.started_at desc limit 1),
    'counts', (
      select jsonb_build_object(
        'queued', count(*) filter (where t.status = 'queued'),
        'running', count(*) filter (where t.status = 'running'),
        'awaitingApproval', count(*) filter (where t.status = 'awaiting_approval'),
        'awaitingSession', count(*) filter (where t.status = 'awaiting_session'),
        'failedLast24h', count(*) filter (where t.status = 'failed' and t.finished_at > now() - interval '24 hours'))
      from private.agent_tasks t where t.agent_key = a.key),
    'schedules', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', sc.id, 'taskKind', sc.task_kind, 'cadence', sc.cadence, 'everySeconds', sc.every_seconds,
        'atLocal', sc.at_local, 'timezone', sc.timezone, 'requiresSession', sc.requires_session,
        'enabled', sc.enabled, 'nextRunAt', sc.next_run_at, 'lastRunAt', sc.last_run_at) order by sc.task_kind), '[]'::jsonb)
      from private.agent_schedules sc where sc.agent_key = a.key))
  from private.agents a
  where a.key = p_key;
$$;

-- A task that waited for approval finishes once nothing it proposed is still open.
create function private.agent_close_task_if_settled(p_task_id uuid) returns void
language plpgsql set search_path = '' as $$
begin
  if p_task_id is null then
    return;
  end if;
  update private.agent_tasks t
  set status = 'done', finished_at = now(), lease_until = null, updated_at = now()
  where t.id = p_task_id and t.status = 'awaiting_approval'
    and not exists (
      select 1 from private.agent_actions x
      where x.task_id = t.id and x.status in ('proposed', 'approved', 'auto_approved', 'executing'));
end;
$$;

-- ---------------------------------------------------------------------------------------
-- The first three agents, paused. Settings are the starting point the owner tunes on the
-- Team screen; prompts and tools live in server code and are reviewed like any change.
-- ---------------------------------------------------------------------------------------
insert into private.agents (key, display_name, role_summary, status, autonomy, model_tier, daily_budget_cents, tool_allowlist, config) values
  ('chief_of_staff', 'Chief of Staff',
   'Writes the morning brief: what needs the owner today, what the team did, and what to watch.',
   'paused', 'act', 'draft', 100, array['get_team_facts', 'notify_owner'],
   '{"effort": "low", "auto_approve_kinds": []}'::jsonb),
  ('platform_engineer', 'Platform Engineer',
   'On call: probes every product health endpoint, opens an incident after repeated failures and writes the recovery note.',
   'paused', 'act', 'fast', 50, array['notify_owner'],
   '{"effort": "low", "auto_approve_kinds": ["incident.open", "incident.resolve"]}'::jsonb),
  ('support_concierge', 'Support Concierge',
   'Triages every new conversation in the Communications inbox and drafts a reply for the owner to approve.',
   'paused', 'propose', 'draft', 300,
   array['get_communication', 'search_knowledge', 'propose_reply', 'propose_classification', 'add_internal_note', 'notify_owner'],
   '{"effort": "medium", "auto_approve_kinds": []}'::jsonb);

insert into private.agent_schedules (agent_key, task_kind, cadence, every_seconds, at_local, timezone, requires_session, next_run_at) values
  ('chief_of_staff', 'brief.daily', 'daily', null, '07:00', 'America/New_York', false,
   private.agent_schedule_next('daily', null, '07:00', 'America/New_York', now(), null)),
  ('platform_engineer', 'probe.sweep', 'interval', 300, null, 'America/New_York', false, now()),
  ('support_concierge', 'concierge.sweep', 'interval', 120, null, 'America/New_York', false, now()),
  ('support_concierge', 'import.advisors', 'interval', 1800, null, 'America/New_York', true, now()),
  ('support_concierge', 'import.breathe', 'interval', 1800, null, 'America/New_York', true, now());

-- ---------------------------------------------------------------------------------------
-- Server operations. Executable by hub_app_server only; each refuses every other session
-- user, exactly like the AI automation operations.
-- ---------------------------------------------------------------------------------------

create function private.agent_budget(p_agent_key text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_hub_app_server();
  return private.agent_budget_json(p_agent_key);
end;
$$;

-- Turns every due schedule of an active agent into a task, then moves the schedule to its
-- next run. A schedule whose previous task is still unfinished is skipped, not stacked, so
-- a stuck run is never buried under more of the same. p_kinds names the task kinds the
-- running server has a handler for: a schedule for any other kind stays due and untouched,
-- so schedules seeded ahead of the code that handles them (or after a rollback of that code)
-- never fire tasks nobody can run. Null fires every kind. Returns the tasks it created.
create function private.agent_schedule_fire(p_limit integer default 10, p_kinds text[] default null) returns uuid[]
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
        and t.status in ('queued', 'running', 'awaiting_session')
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

-- Housekeeping, once per scheduler tick: proposals nobody decided in time expire; an
-- execution the server never finished (a restart mid-send) goes back to its approved state
-- (the inbox request key makes a second attempt safe); a task whose lease ran out while it
-- waited on the owner's session is parked again; a task waiting on approval finishes once
-- nothing it proposed is still open.
create function private.agent_maintenance() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_expired integer;
  v_reset integer;
  v_parked integer;
  v_failed integer;
  v_settled integer;
begin
  perform private.require_hub_app_server();
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

  return jsonb_build_object('expiredActions', v_expired, 'resetExecutions', v_reset,
    'parkedTasks', v_parked, 'failedTasks', v_failed, 'settledTasks', v_settled);
end;
$$;

-- Adds a task. The request key makes any event or firing idempotent: a duplicate returns
-- null and changes nothing. A task that needs the owner's session waits for it.
create function private.agent_task_enqueue(
  p_agent_key text, p_kind text, p_request_key text, p_payload jsonb default '{}'::jsonb,
  p_priority integer default 5, p_due_at timestamptz default null,
  p_source_kind text default null, p_source_ref text default null, p_requires_session boolean default false
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
begin
  perform private.require_hub_app_server();
  insert into private.agent_tasks (agent_key, kind, request_key, payload, priority, due_at, source_kind, source_ref, requires_session, status)
  values (p_agent_key, p_kind, p_request_key, coalesce(p_payload, '{}'::jsonb), p_priority, coalesce(p_due_at, now()),
          p_source_kind, p_source_ref, coalesce(p_requires_session, false),
          case when coalesce(p_requires_session, false) then 'awaiting_session' else 'queued' end)
  on conflict (request_key) do nothing
  returning id into v_id;
  return v_id;
end;
$$;

-- Hands out due work to the server under a lease. A task whose lease ran out (the server
-- died mid-run) is handed out again; one that lost its lease five times is stopped so a
-- poison task can never block the queue. Paused agents hand out nothing. The token budget
-- is enforced where tokens are spent (before each model call), so a model-free task such
-- as a health probe is never held back by it.
create function private.agent_task_claim(p_limit integer default 3, p_lease_seconds integer default 600) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_ids uuid[];
begin
  perform private.require_hub_app_server();
  if p_limit is null or p_limit < 1 or p_limit > 10 then
    raise exception 'Claim between 1 and 10 tasks.' using errcode = '22023';
  end if;
  if p_lease_seconds is null or p_lease_seconds < 30 or p_lease_seconds > 3600 then
    raise exception 'Choose a lease between 30 and 3600 seconds.' using errcode = '22023';
  end if;

  update private.agent_tasks
  set status = 'failed', last_error_code = 'lease_expired', lease_until = null, finished_at = now(), updated_at = now()
  where status = 'running' and not requires_session and lease_until < now() and attempts >= 5;

  with candidate as (
    select t.id
    from private.agent_tasks t
    join private.agents a on a.key = t.agent_key
    where a.status = 'active' and not t.requires_session
      and ((t.status = 'queued' and t.due_at <= now()) or (t.status = 'running' and t.lease_until < now()))
    order by t.priority, t.due_at, t.created_at
    limit p_limit
    for update of t skip locked
  ), claimed as (
    update private.agent_tasks t
    set status = 'running', attempts = t.attempts + 1, claimed_at = now(), last_error_code = null,
        lease_until = now() + make_interval(secs => p_lease_seconds), updated_at = now()
    from candidate c
    where t.id = c.id
    returning t.id
  )
  select coalesce(array_agg(claimed.id), array[]::uuid[]) into v_ids from claimed;

  return (
    select coalesce(jsonb_agg(x.document order by x.priority, x.created_at), '[]'::jsonb)
    from (
      select private.agent_task_json(t.id) as document, t.priority, t.created_at
      from private.agent_tasks t where t.id = any (v_ids)
    ) x
  );
end;
$$;

create function private.agent_task_heartbeat(p_task_id uuid, p_lease_seconds integer default 600) returns boolean
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
  where id = p_task_id and status = 'running'
  returning true into v_alive;
  return coalesce(v_alive, false);
end;
$$;

-- Ends a claimed task: done, failed, waiting for approval, waiting for the owner's session,
-- or queued again for a later retry (failed instead once it has been tried five times).
-- A task the owner cancelled, or one that already finished, is left as it is.
create function private.agent_task_finish(
  p_task_id uuid, p_status text, p_result jsonb default null, p_error_code text default null,
  p_retry_at timestamptz default null
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
  if v_task.status <> 'running' then
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
      due_at = case when v_status = 'queued' then coalesce(p_retry_at, now() + interval '5 minutes') else due_at end,
      claimed_at = case when v_status in ('queued', 'awaiting_session') then null else claimed_at end,
      lease_until = null,
      finished_at = case when v_status in ('done', 'failed') then now() else finished_at end,
      updated_at = now()
  where id = p_task_id;
  return v_status;
end;
$$;

-- Tasks that are waiting for the owner to be signed in, for the Team screen's banner and
-- the executor the owner triggers. Only active agents' tasks are offered.
create function private.agent_session_tasks(p_limit integer default 10) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_hub_app_server();
  if p_limit is null or p_limit < 1 or p_limit > 50 then
    raise exception 'List between 1 and 50 tasks.' using errcode = '22023';
  end if;
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', x.id, 'agentKey', x.agent_key, 'kind', x.kind, 'priority', x.priority, 'createdAt', x.created_at)
      order by x.priority, x.created_at), '[]'::jsonb)
    from (
      select t.id, t.agent_key, t.kind, t.priority, t.created_at
      from private.agent_tasks t
      join private.agents a on a.key = t.agent_key
      where t.status = 'awaiting_session' and t.due_at <= now() and a.status = 'active'
      order by t.priority, t.created_at
      limit p_limit
    ) x
  );
end;
$$;

create function private.agent_session_task_claim(p_task_id uuid, p_lease_seconds integer default 600) returns jsonb
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
  where t.id = p_task_id and t.status = 'awaiting_session' and a.key = t.agent_key and a.status = 'active'
  returning t.id into v_id;
  if v_id is null then
    return null;
  end if;
  return private.agent_task_json(v_id);
end;
$$;

create function private.agent_run_start(p_task_id uuid, p_model text, p_prompt_version text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_agent text;
  v_id uuid;
begin
  perform private.require_hub_app_server();
  select agent_key into v_agent from private.agent_tasks where id = p_task_id and status = 'running';
  if not found then
    raise exception 'The task is not running.' using errcode = '55000';
  end if;
  insert into private.agent_runs (task_id, agent_key, model, prompt_version)
  values (p_task_id, v_agent, p_model, p_prompt_version)
  returning id into v_id;
  return v_id;
end;
$$;

-- Closes a run with its usage. The summary is clipped rather than rejected so a long one
-- can never stop the cost from being recorded against the day's budget.
create function private.agent_run_finish(
  p_run_id uuid, p_outcome text, p_usage jsonb default '{}'::jsonb, p_summary text default null,
  p_error_code text default null
) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_hub_app_server();
  update private.agent_runs
  set finished_at = now(),
      outcome = p_outcome,
      rounds = coalesce((p_usage ->> 'rounds')::integer, 0),
      tool_calls = coalesce((p_usage ->> 'toolCalls')::integer, 0),
      input_tokens = coalesce((p_usage ->> 'inputTokens')::bigint, 0),
      output_tokens = coalesce((p_usage ->> 'outputTokens')::bigint, 0),
      cache_read_tokens = coalesce((p_usage ->> 'cacheReadTokens')::bigint, 0),
      cache_write_tokens = coalesce((p_usage ->> 'cacheWriteTokens')::bigint, 0),
      cost_cents = coalesce((p_usage ->> 'costCents')::numeric, 0),
      summary = left(p_summary, 2000),
      error_code = p_error_code
  where id = p_run_id and finished_at is null;
  if not found then
    raise exception 'Unknown or finished agent run.' using errcode = 'P0002';
  end if;
end;
$$;

-- Records what a running task wants done. An observe-only agent cannot propose. An agent
-- on "act" has the kinds it lists in config.auto_approve_kinds approved on the spot; every
-- other proposal waits for the owner. Proposing the same thing twice from one task returns
-- the first proposal.
create function private.agent_action_propose(
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
  select * into v_task from private.agent_tasks where id = p_task_id;
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

-- Approved and auto-approved actions that are ready to carry out, oldest first. The
-- scheduler drains these every tick, so an approval is never lost to a restart.
create function private.agent_actions_ready(p_limit integer default 10) returns jsonb
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
      order by a.created_at
      limit p_limit
    ) x
  );
end;
$$;

-- Starts carrying out one ready action. Exactly one caller gets it (the others get null),
-- which is what keeps an approval from being executed twice.
create function private.agent_action_execution(p_action_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_action private.agent_actions%rowtype;
begin
  perform private.require_hub_app_server();
  update private.agent_actions
  set status = 'executing', executing_at = now(), updated_at = now()
  where id = p_action_id and status in ('approved', 'auto_approved')
  returning * into v_action;
  if not found then
    return null;
  end if;
  return jsonb_build_object(
    'id', v_action.id, 'agentKey', v_action.agent_key, 'taskId', v_action.task_id, 'kind', v_action.kind,
    'targetKind', v_action.target_kind, 'targetId', v_action.target_id, 'input', v_action.input,
    'requestKey', v_action.request_key, 'autoApproved', v_action.decided_by is null);
end;
$$;

-- Records how the execution went and writes the audit event, as the AI assistant identity
-- (the same durable identity the automation loop uses). The audit metadata names the agent
-- and the kind, never the content.
create function private.agent_action_executed(p_action_id uuid, p_ok boolean, p_result jsonb default null) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_action private.agent_actions%rowtype;
begin
  perform private.require_hub_app_server();
  update private.agent_actions
  set status = case when p_ok then 'executed' else 'failed' end,
      executed_at = now(), result = p_result, updated_at = now()
  where id = p_action_id and status = 'executing'
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

-- Records a message to the owner before it is sent. The dedupe key makes a repeated alert
-- a no-op; only a delivery that definitely failed is retried, twice at most.
create function private.agent_notify_begin(
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
  set status = 'pending', attempts = attempts + 1
  where dedupe_key = p_dedupe_key and channel = p_channel and status = 'failed' and attempts < 3
  returning * into v_row;
  if found then
    return jsonb_build_object('id', v_row.id, 'duplicate', false, 'status', v_row.status);
  end if;
  select * into v_row from private.owner_notifications where dedupe_key = p_dedupe_key and channel = p_channel;
  return jsonb_build_object('id', v_row.id, 'duplicate', true, 'status', v_row.status);
end;
$$;

create function private.agent_notify_finish(p_id uuid, p_delivery text, p_provider_message_id text default null) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_hub_app_server();
  if p_delivery is null or p_delivery not in ('sent', 'failed', 'unknown', 'suppressed') then
    raise exception 'Unsupported delivery outcome.' using errcode = '22023';
  end if;
  update private.owner_notifications
  set status = p_delivery, provider_message_id = left(p_provider_message_id, 400),
      sent_at = case when p_delivery = 'sent' then now() else sent_at end
  where id = p_id and status = 'pending';
  if not found then
    raise exception 'Unknown or settled notification.' using errcode = 'P0002';
  end if;
end;
$$;

-- Where to text the owner: the verified number of the single active platform
-- administrator. With none, or more than one, nobody is texted (null) rather than guessing.
create function private.owner_contact() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_count integer;
  v_phone text;
begin
  perform private.require_hub_app_server();
  select count(*), min(i.phone_e164) into v_count, v_phone
  from private.staff_permissions sp
  join private.sms_identities i on i.user_id = sp.user_id
  join auth.users u on u.id = sp.user_id
  where sp.permission = 'platform.admin' and sp.revoked_at is null and sp.product_id is null
    and i.revoked_at is null and i.verified_at is not null
    and u.deleted_at is null and (u.banned_until is null or u.banned_until <= now())
    and not coalesce(u.is_anonymous, false);
  if v_count <> 1 then
    return null;
  end if;
  return jsonb_build_object('phone', v_phone);
end;
$$;

-- ---------------------------------------------------------------------------------------
-- Owner operations. Each authorizes the current SMS administrator session itself, so a
-- signed-out, lapsed or non-administrator session fails closed with 28000. Reads need
-- the administrator session; every change needs the command assurance (a session under
-- eight hours old), the same bar as the other Hub administrator changes.
-- ---------------------------------------------------------------------------------------

create function hub.get_agent_team() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform hub.authorize_app_admin();
  return jsonb_build_object(
    'loadedAt', now(),
    'dayStart', private.agent_day_start(),
    'agents', (
      select coalesce(jsonb_agg(private.agent_summary_json(a.key) order by a.display_name), '[]'::jsonb)
      from private.agents a),
    'approvals', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', x.id, 'agentKey', x.agent_key, 'agentName', x.agent_name, 'taskId', x.task_id,
        'kind', x.kind, 'targetKind', x.target_kind, 'targetId', x.target_id, 'preview', x.preview,
        'createdAt', x.created_at, 'expiresAt', x.expires_at) order by x.created_at), '[]'::jsonb)
      from (
        select ac.id, ac.agent_key, ag.display_name as agent_name, ac.task_id, ac.kind, ac.target_kind,
               ac.target_id, ac.preview, ac.created_at, ac.expires_at
        from private.agent_actions ac
        join private.agents ag on ag.key = ac.agent_key
        where ac.status = 'proposed' and ac.expires_at > now()
        order by ac.created_at
        limit 50
      ) x),
    'approvalCount', (select count(*) from private.agent_actions ac where ac.status = 'proposed' and ac.expires_at > now()),
    'awaitingSessionCount', (select count(*) from private.agent_tasks t where t.status = 'awaiting_session'));
end;
$$;

-- One page of the team's history: runs, tasks, proposed actions or owner notifications,
-- newest first, optionally for one agent.
create function hub.list_agent_activity(
  p_kind text, p_agent_key text default null, p_offset integer default 0, p_limit integer default 25
) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_items jsonb;
  v_total bigint;
begin
  perform hub.authorize_app_admin();
  if p_kind is null or p_kind not in ('runs', 'tasks', 'actions', 'notifications') then
    raise exception 'Choose runs, tasks, actions or notifications.' using errcode = '22023';
  end if;
  if p_offset is null or p_offset < 0 or p_offset > 10000 or p_limit is null or p_limit < 1 or p_limit > 50 then
    raise exception 'Choose a valid page.' using errcode = '22023';
  end if;
  if p_agent_key is not null and p_agent_key !~ '^[a-z][a-z0-9_]{1,40}$' then
    raise exception 'Unknown agent.' using errcode = '22023';
  end if;

  if p_kind = 'runs' then
    select count(*) into v_total from private.agent_runs r where p_agent_key is null or r.agent_key = p_agent_key;
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', x.id, 'taskId', x.task_id, 'agentKey', x.agent_key, 'model', x.model, 'promptVersion', x.prompt_version,
      'startedAt', x.started_at, 'finishedAt', x.finished_at, 'outcome', x.outcome, 'rounds', x.rounds,
      'toolCalls', x.tool_calls, 'inputTokens', x.input_tokens, 'outputTokens', x.output_tokens,
      'cacheReadTokens', x.cache_read_tokens, 'cacheWriteTokens', x.cache_write_tokens, 'costCents', x.cost_cents,
      'summary', x.summary, 'errorCode', x.error_code) order by x.started_at desc, x.id), '[]'::jsonb)
    into v_items
    from (
      select r.* from private.agent_runs r where p_agent_key is null or r.agent_key = p_agent_key
      order by r.started_at desc, r.id offset p_offset limit p_limit
    ) x;
  elsif p_kind = 'tasks' then
    select count(*) into v_total from private.agent_tasks t where p_agent_key is null or t.agent_key = p_agent_key;
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', x.id, 'agentKey', x.agent_key, 'kind', x.kind, 'status', x.status, 'priority', x.priority,
      'sourceKind', x.source_kind, 'sourceRef', x.source_ref, 'requiresSession', x.requires_session,
      'dueAt', x.due_at, 'attempts', x.attempts, 'lastErrorCode', x.last_error_code, 'result', x.result,
      'createdAt', x.created_at, 'finishedAt', x.finished_at) order by x.created_at desc, x.id), '[]'::jsonb)
    into v_items
    from (
      select t.* from private.agent_tasks t where p_agent_key is null or t.agent_key = p_agent_key
      order by t.created_at desc, t.id offset p_offset limit p_limit
    ) x;
  elsif p_kind = 'actions' then
    select count(*) into v_total from private.agent_actions a where p_agent_key is null or a.agent_key = p_agent_key;
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', x.id, 'taskId', x.task_id, 'agentKey', x.agent_key, 'kind', x.kind, 'targetKind', x.target_kind,
      'targetId', x.target_id, 'status', x.status, 'preview', x.preview, 'decisionNote', x.decision_note,
      'createdAt', x.created_at, 'expiresAt', x.expires_at, 'decidedAt', x.decided_at, 'executedAt', x.executed_at,
      'result', x.result) order by x.created_at desc, x.id), '[]'::jsonb)
    into v_items
    from (
      select a.* from private.agent_actions a where p_agent_key is null or a.agent_key = p_agent_key
      order by a.created_at desc, a.id offset p_offset limit p_limit
    ) x;
  else
    select count(*) into v_total from private.owner_notifications n where p_agent_key is null or n.agent_key = p_agent_key;
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', x.id, 'agentKey', x.agent_key, 'channel', x.channel, 'severity', x.severity, 'subject', x.subject,
      'body', x.body, 'status', x.status, 'attempts', x.attempts, 'createdAt', x.created_at,
      'sentAt', x.sent_at) order by x.created_at desc, x.id), '[]'::jsonb)
    into v_items
    from (
      select n.* from private.owner_notifications n where p_agent_key is null or n.agent_key = p_agent_key
      order by n.created_at desc, n.id offset p_offset limit p_limit
    ) x;
  end if;
  return jsonb_build_object('kind', p_kind, 'items', v_items, 'total', v_total, 'offset', p_offset, 'limit', p_limit);
end;
$$;

-- The first reader of the audit log. Audit rows hold metadata only (the table's own rule),
-- so the owner sees what happened and who did it, never a message body.
create function hub.list_audit_events(
  p_action_prefix text default null, p_offset integer default 0, p_limit integer default 25
) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_items jsonb;
  v_total bigint;
begin
  perform hub.authorize_app_admin();
  if p_offset is null or p_offset < 0 or p_offset > 10000 or p_limit is null or p_limit < 1 or p_limit > 50 then
    raise exception 'Choose a valid page.' using errcode = '22023';
  end if;
  if p_action_prefix is not null and p_action_prefix !~ '^[a-z_]+(\.[a-z_]+)*\.?$' then
    raise exception 'Choose a valid action prefix.' using errcode = '22023';
  end if;
  select count(*) into v_total
  from private.audit_events e
  where p_action_prefix is null or starts_with(e.action, p_action_prefix);
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', x.id, 'action', x.action, 'entityType', x.entity_type, 'entityId', x.entity_id,
    'actorId', x.actor_id, 'actorName', x.actor_name, 'tenantId', x.tenant_id, 'productId', x.product_id,
    'caseId', x.case_id, 'changedColumns', to_jsonb(x.changed_columns), 'reasonCode', x.reason_code,
    'metadata', x.metadata, 'createdAt', x.created_at) order by x.id desc), '[]'::jsonb)
  into v_items
  from (
    select e.*, p.display_name as actor_name
    from private.audit_events e
    left join hub.profiles p on p.id = e.actor_id
    where p_action_prefix is null or starts_with(e.action, p_action_prefix)
    order by e.id desc
    offset p_offset limit p_limit
  ) x;
  return jsonb_build_object('items', v_items, 'total', v_total, 'offset', p_offset, 'limit', p_limit);
end;
$$;

create function hub.set_agent_status(p_key text, p_status text, p_expected_updated_at timestamptz) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_actor jsonb;
  v_agent private.agents%rowtype;
begin
  v_actor := hub.authorize_app_command();
  if p_status is null or p_status not in ('active', 'paused') then
    raise exception 'Choose active or paused.' using errcode = '22023';
  end if;
  select * into v_agent from private.agents where key = p_key for update;
  if not found then
    raise exception 'Unknown agent.' using errcode = 'P0002';
  end if;
  if v_agent.updated_at is distinct from p_expected_updated_at then
    raise exception 'This agent changed. Refresh and review again.' using errcode = '40001';
  end if;
  update private.agents set status = p_status, updated_at = now() where key = p_key;
  insert into private.audit_events (actor_id, action, entity_type, metadata)
  values ((v_actor ->> 'user_id')::uuid, 'agent.status', 'agent', jsonb_build_object('agent', p_key, 'status', p_status));
  return private.agent_summary_json(p_key);
end;
$$;

create function hub.set_agent_autonomy(p_key text, p_autonomy text, p_expected_updated_at timestamptz) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_actor jsonb;
  v_agent private.agents%rowtype;
begin
  v_actor := hub.authorize_app_command();
  if p_autonomy is null or p_autonomy not in ('observe', 'propose', 'act') then
    raise exception 'Choose observe, propose or act.' using errcode = '22023';
  end if;
  select * into v_agent from private.agents where key = p_key for update;
  if not found then
    raise exception 'Unknown agent.' using errcode = 'P0002';
  end if;
  if v_agent.updated_at is distinct from p_expected_updated_at then
    raise exception 'This agent changed. Refresh and review again.' using errcode = '40001';
  end if;
  update private.agents set autonomy = p_autonomy, updated_at = now() where key = p_key;
  insert into private.audit_events (actor_id, action, entity_type, metadata)
  values ((v_actor ->> 'user_id')::uuid, 'agent.autonomy', 'agent',
          jsonb_build_object('agent', p_key, 'from', v_agent.autonomy, 'to', p_autonomy));
  return private.agent_summary_json(p_key);
end;
$$;

create function hub.set_agent_budget(p_key text, p_daily_budget_cents integer, p_expected_updated_at timestamptz) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_actor jsonb;
  v_agent private.agents%rowtype;
begin
  v_actor := hub.authorize_app_command();
  if p_daily_budget_cents is null or p_daily_budget_cents < 0 or p_daily_budget_cents > 100000 then
    raise exception 'Choose a daily budget between 0 and 100,000 cents.' using errcode = '22023';
  end if;
  select * into v_agent from private.agents where key = p_key for update;
  if not found then
    raise exception 'Unknown agent.' using errcode = 'P0002';
  end if;
  if v_agent.updated_at is distinct from p_expected_updated_at then
    raise exception 'This agent changed. Refresh and review again.' using errcode = '40001';
  end if;
  update private.agents set daily_budget_cents = p_daily_budget_cents, updated_at = now() where key = p_key;
  insert into private.audit_events (actor_id, action, entity_type, metadata)
  values ((v_actor ->> 'user_id')::uuid, 'agent.budget', 'agent',
          jsonb_build_object('agent', p_key, 'from', v_agent.daily_budget_cents, 'to', p_daily_budget_cents));
  return private.agent_summary_json(p_key);
end;
$$;

-- Approve or reject one proposal. The database only records the decision; the server then
-- carries an approved action out through the reviewed inbox path. Deciding twice is safe:
-- the second call reports the current state and decided = false. A proposal that waited
-- past its deadline is marked expired instead of decided.
create function hub.decide_agent_action(p_action_id uuid, p_decision text, p_note text default null) returns jsonb
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

-- "Run now": queues one of the agent's own scheduled task kinds. The browser chooses
-- neither the payload nor an arbitrary kind, so this cannot be used to make an agent do
-- anything it does not already do on a schedule.
create function hub.request_agent_task(p_agent_key text, p_task_kind text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_actor jsonb;
  v_agent private.agents%rowtype;
  v_schedule private.agent_schedules%rowtype;
  v_id uuid;
  v_status text;
begin
  v_actor := hub.authorize_app_command();
  select * into v_agent from private.agents where key = p_agent_key;
  if not found then
    raise exception 'Unknown agent.' using errcode = 'P0002';
  end if;
  if v_agent.status <> 'active' then
    raise exception 'Resume this agent before running it.' using errcode = '55000';
  end if;
  select * into v_schedule from private.agent_schedules where agent_key = p_agent_key and task_kind = p_task_kind;
  if not found then
    raise exception 'This agent has no such task.' using errcode = 'P0002';
  end if;
  v_status := case when v_schedule.requires_session then 'awaiting_session' else 'queued' end;
  insert into private.agent_tasks (agent_key, kind, request_key, payload, priority, requires_session, source_kind, status)
  values (p_agent_key, p_task_kind, 'owner:' || gen_random_uuid()::text, v_schedule.payload, 4,
          v_schedule.requires_session, 'owner', v_status)
  returning id into v_id;
  insert into private.audit_events (actor_id, action, entity_type, entity_id, metadata)
  values ((v_actor ->> 'user_id')::uuid, 'agent.task.requested', 'agent_task', v_id,
          jsonb_build_object('agent', p_agent_key, 'kind', p_task_kind));
  return jsonb_build_object('id', v_id, 'status', v_status);
end;
$$;

create function hub.cancel_agent_task(p_task_id uuid) returns jsonb
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
    where task_id = p_task_id and status = 'proposed';
    insert into private.audit_events (actor_id, action, entity_type, entity_id, metadata)
    values ((v_actor ->> 'user_id')::uuid, 'agent.task.cancelled', 'agent_task', v_task.id,
            jsonb_build_object('agent', v_task.agent_key, 'kind', v_task.kind));
  end if;
  return jsonb_build_object('id', v_task.id, 'status', v_task.status);
end;
$$;

-- ---------------------------------------------------------------------------------------
-- Grants. Helpers: nobody. Server operations: the Hub server role only. Owner operations:
-- signed-in sessions (they authorize the administrator session themselves).
-- ---------------------------------------------------------------------------------------
revoke all on function
  private.agent_day_start(),
  private.agent_spent_today_cents(text),
  private.agent_budget_json(text),
  private.agent_schedule_next(text, integer, time without time zone, text, timestamp with time zone, timestamp with time zone),
  private.agent_task_json(uuid),
  private.agent_summary_json(text),
  private.agent_close_task_if_settled(uuid),
  private.agent_budget(text),
  private.agent_schedule_fire(integer, text[]),
  private.agent_maintenance(),
  private.agent_task_enqueue(text, text, text, jsonb, integer, timestamp with time zone, text, text, boolean),
  private.agent_task_claim(integer, integer),
  private.agent_task_heartbeat(uuid, integer),
  private.agent_task_finish(uuid, text, jsonb, text, timestamp with time zone),
  private.agent_session_tasks(integer),
  private.agent_session_task_claim(uuid, integer),
  private.agent_run_start(uuid, text, text),
  private.agent_run_finish(uuid, text, jsonb, text, text),
  private.agent_action_propose(uuid, uuid, text, text, text, text, jsonb),
  private.agent_actions_ready(integer),
  private.agent_action_execution(uuid),
  private.agent_action_executed(uuid, boolean, jsonb),
  private.agent_notify_begin(text, text, text, text, text, text, uuid),
  private.agent_notify_finish(uuid, text, text),
  private.owner_contact()
from public, anon, authenticated, service_role, hub_app_server;

grant execute on function
  private.agent_budget(text),
  private.agent_schedule_fire(integer, text[]),
  private.agent_maintenance(),
  private.agent_task_enqueue(text, text, text, jsonb, integer, timestamp with time zone, text, text, boolean),
  private.agent_task_claim(integer, integer),
  private.agent_task_heartbeat(uuid, integer),
  private.agent_task_finish(uuid, text, jsonb, text, timestamp with time zone),
  private.agent_session_tasks(integer),
  private.agent_session_task_claim(uuid, integer),
  private.agent_run_start(uuid, text, text),
  private.agent_run_finish(uuid, text, jsonb, text, text),
  private.agent_action_propose(uuid, uuid, text, text, text, text, jsonb),
  private.agent_actions_ready(integer),
  private.agent_action_execution(uuid),
  private.agent_action_executed(uuid, boolean, jsonb),
  private.agent_notify_begin(text, text, text, text, text, text, uuid),
  private.agent_notify_finish(uuid, text, text),
  private.owner_contact()
to hub_app_server;

revoke all on function
  hub.get_agent_team(),
  hub.list_agent_activity(text, text, integer, integer),
  hub.list_audit_events(text, integer, integer),
  hub.set_agent_status(text, text, timestamp with time zone),
  hub.set_agent_autonomy(text, text, timestamp with time zone),
  hub.set_agent_budget(text, integer, timestamp with time zone),
  hub.decide_agent_action(uuid, text, text),
  hub.request_agent_task(text, text),
  hub.cancel_agent_task(uuid)
from public, anon;

grant execute on function
  hub.get_agent_team(),
  hub.list_agent_activity(text, text, integer, integer),
  hub.list_audit_events(text, integer, integer),
  hub.set_agent_status(text, text, timestamp with time zone),
  hub.set_agent_autonomy(text, text, timestamp with time zone),
  hub.set_agent_budget(text, integer, timestamp with time zone),
  hub.decide_agent_action(uuid, text, text),
  hub.request_agent_task(text, text),
  hub.cancel_agent_task(uuid)
to authenticated;
