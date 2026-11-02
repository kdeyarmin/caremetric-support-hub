-- Health probe state for the AI team's on-call agent (the Platform Engineer).
--
-- Every five minutes the server checks each product's public health endpoint and reports the
-- result here. This table remembers, per product, whether it is up or down and how many checks
-- in a row have failed, and the operation below turns that into at most one incident per outage:
--   * a product that fails `p_threshold` checks in a row opens an incident (one task for the
--     on-call agent), and
--   * the first healthy check after that closes it (one recovery task).
-- The decision is made here, in one row-locked statement, so two overlapping sweeps (a restart,
-- a second replica) can never open the same incident twice. Request keys carry the incident
-- number, so a retry never queues a second alert either.
--
-- Nothing here is readable or writable by a browser, service or server role directly: the Hub
-- server reaches it only through the operation below, exactly like the rest of the control plane.
-- Results hold only a status code, a latency and a fixed failure word. Never a response body.

create table private.agent_probe_state (
  target_key text primary key check (target_key ~ '^[a-z][a-z0-9_]{1,40}$'),
  state text not null default 'unknown' check (state in ('unknown', 'up', 'down')),
  consecutive_failures integer not null default 0 check (consecutive_failures between 0 and 100000),
  -- The first failed check of the current streak; cleared by the next healthy check.
  failing_since timestamptz,
  last_checked_at timestamptz,
  last_ok_at timestamptz,
  -- 0 means the product did not answer at all.
  last_status_code integer check (last_status_code between 0 and 999),
  last_latency_ms integer check (last_latency_ms >= 0),
  last_failure text check (last_failure ~ '^[a-z_]{1,40}$'),
  incident_seq integer not null default 0 check (incident_seq >= 0),
  last_recovered_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table private.agent_probe_state enable row level security;
revoke all on private.agent_probe_state from public, anon, authenticated, service_role, hub_app_server;

-- Records one check. Returns { target, state, transition, failures, incident, taskId } where
-- transition is none, down (an incident just opened) or recovered (it just closed). A new
-- incident within thirty minutes of the last recovery is marked flapping, so the on-call agent
-- can send it as a warning by email instead of waking the owner by text again.
create function private.agent_probe_record(
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
                                 'flapping', v.last_recovered_at is not null and v.last_recovered_at > now() - interval '30 minutes'),
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

revoke all on function private.agent_probe_record(text, boolean, integer, integer, text, integer, text)
  from public, anon, authenticated, service_role, hub_app_server;
grant execute on function private.agent_probe_record(text, boolean, integer, integer, text, integer, text) to hub_app_server;
