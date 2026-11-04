-- Owner-directed external email. The owner supplies and approves the exact message through
-- the existing SMS command and action decision boundaries. No agent or autonomy setting can
-- originate or automatically approve this kind. The private record claims a send before a
-- provider is called; a reclaimed execution can report the outcome but can never send again.

do $$
declare
  v_kinds text[];
  v_targets text[];
begin
  select coalesce(array_agg(distinct m[1]), array[]::text[]) into v_kinds
  from pg_constraint c cross join lateral regexp_matches(pg_get_constraintdef(c.oid), '''([^'']+)''', 'g') m
  where c.conrelid = 'private.agent_actions'::regclass and c.conname = 'agent_actions_kind_check';
  select coalesce(array_agg(distinct m[1]), array[]::text[]) into v_targets
  from pg_constraint c cross join lateral regexp_matches(pg_get_constraintdef(c.oid), '''([^'']+)''', 'g') m
  where c.conrelid = 'private.agent_actions'::regclass and c.conname = 'agent_actions_target_kind_check';
  if not v_kinds @> array['communication.reply', 'email.send', 'content.publish', 'growth.message', 'growth.content']
    or not v_targets @> array['communication', 'billing_account', 'content_item', 'growth_message', 'growth_content']
    or exists (select 1 from unnest(v_kinds || v_targets) value where value !~ '^[a-z][a-z0-9_.]{1,60}$') then
    raise exception 'The agent action kinds could not be read' using errcode = '55000';
  end if;
  execute format('alter table private.agent_actions drop constraint agent_actions_kind_check, add constraint agent_actions_kind_check check (kind in (%s))',
    (select string_agg(quote_literal(k), ', ' order by k) from (select distinct unnest(v_kinds || array['email.external']) as k) x));
  execute format('alter table private.agent_actions drop constraint agent_actions_target_kind_check, add constraint agent_actions_target_kind_check check (target_kind in (%s))',
    (select string_agg(quote_literal(k), ', ' order by k) from (select distinct unnest(v_targets || array['external_email']) as k) x));
end $$;

-- The generic model/task proposal path always has a task. Only the owner command below
-- creates this task-free action; the message itself is kept out of generic action input.
alter table private.agent_actions add constraint agent_actions_external_email_check check (
  kind <> 'email.external' or coalesce(
    agent_key = 'chief_of_staff' and task_id is null and run_id is null
    and target_kind = 'external_email' and target_id = request_key::text
    and input = jsonb_build_object('requestKey', request_key::text)
    and status <> 'auto_approved', false));

-- One canonical validation rule is used by the request operation and the private table.
-- Preserve all approved text; reject header injection, additional recipients and control
-- characters rather than silently rewriting them. CR, LF and tab are allowed in the body.
create function private.agent_external_email_valid(p_to text, p_subject text, p_body text) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(
    char_length(p_to) between 3 and 320
    and p_to ~ '^[A-Za-z0-9.!#$%&''*+/=?^_`{|}~-]+@[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$'
    and p_to !~ '[[:cntrl:]]'
    and char_length(p_subject) between 1 and 200 and p_subject ~ '[^[:space:]]'
    and p_subject !~ '[[:cntrl:]]'
    and char_length(p_body) between 1 and 5000 and p_body ~ '[^[:space:]]'
    and translate(p_body, chr(9) || chr(10) || chr(13), '') !~ '[[:cntrl:]]', false);
$$;

create table private.agent_external_emails (
  action_id uuid primary key references private.agent_actions(id) on delete cascade,
  request_key uuid not null unique,
  requested_by uuid references auth.users(id) on delete set null,
  recipient text not null,
  subject text not null,
  body text not null,
  status text not null default 'requested' check (status in ('requested', 'sending', 'sent', 'failed', 'unknown')),
  execution integer check (execution > 0),
  provider_message_id text check (char_length(provider_message_id) between 1 and 200 and provider_message_id !~ '[[:cntrl:]]'),
  created_at timestamptz not null default now(),
  attempted_at timestamptz,
  finished_at timestamptz,
  constraint agent_external_emails_payload_check check (private.agent_external_email_valid(recipient, subject, body)),
  constraint agent_external_emails_attempt_check check (
    (status = 'requested' and execution is null and attempted_at is null and finished_at is null)
    or (status = 'sending' and execution is not null and attempted_at is not null and finished_at is null)
    or (status in ('sent', 'failed', 'unknown') and execution is not null and attempted_at is not null and finished_at is not null)),
  constraint agent_external_emails_provider_check check (provider_message_id is null or status = 'sent')
);
alter table private.agent_external_emails enable row level security;
revoke all on private.agent_external_emails from public, anon, authenticated, service_role, hub_app_server;
comment on table private.agent_external_emails is
  'Exact owner-requested message and once-only send attempt. Sent means provider accepted, not delivered. A sending or unknown record is never automatically retried.';

-- A caller may retry a lost HTTP response with the same key. Serialize that key before
-- checking it, so concurrent identical requests return one action and one audit event.
-- A changed message, another owner, or another action using that key is a conflict.
create function hub.request_agent_email(p_to text, p_subject text, p_body text, p_request_key uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_actor jsonb;
  v_email private.agent_external_emails%rowtype;
  v_action private.agent_actions%rowtype;
  v_id uuid;
begin
  v_actor := hub.authorize_app_command();
  if p_request_key is null or not private.agent_external_email_valid(p_to, p_subject, p_body) then
    raise exception 'Supply one email address, a subject of up to 200 characters and a message of up to 5,000 characters.' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('private.agent_external_emails:' || p_request_key::text, 0));
  select * into v_email from private.agent_external_emails where request_key = p_request_key;
  if found then
    if v_email.requested_by is distinct from (v_actor ->> 'user_id')::uuid
      or v_email.recipient is distinct from p_to or v_email.subject is distinct from p_subject or v_email.body is distinct from p_body then
      raise exception 'This request key already belongs to another email request.' using errcode = '40001';
    end if;
    select * into v_action from private.agent_actions where id = v_email.action_id;
    return jsonb_build_object('id', v_action.id, 'kind', v_action.kind, 'status', v_action.status,
      'requestKey', p_request_key, 'created', false);
  end if;
  if exists (select 1 from private.agent_actions where request_key = p_request_key) then
    raise exception 'This request key already belongs to another action.' using errcode = '40001';
  end if;
  v_id := gen_random_uuid();
  insert into private.agent_actions (id, agent_key, kind, target_kind, target_id, request_key, preview, input, status)
  values (v_id, 'chief_of_staff', 'email.external', 'external_email', p_request_key::text, p_request_key,
    'To: ' || p_to || E'\nSubject: ' || p_subject || E'\n\n' || p_body,
    jsonb_build_object('requestKey', p_request_key::text), 'proposed');
  insert into private.agent_external_emails (action_id, request_key, requested_by, recipient, subject, body)
  values (v_id, p_request_key, (v_actor ->> 'user_id')::uuid, p_to, p_subject, p_body);
  insert into private.audit_events (actor_id, action, entity_type, entity_id, metadata)
  values ((v_actor ->> 'user_id')::uuid, 'agent.email.requested', 'agent_action', v_id,
    jsonb_build_object('agent', 'chief_of_staff', 'kind', 'email.external'));
  return jsonb_build_object('id', v_id, 'kind', 'email.external', 'status', 'proposed',
    'requestKey', p_request_key, 'created', true);
end;
$$;

-- Preserve the current lifecycle/template and task-locking rules. This new kind is an
-- explicit owner request only, even if an agent's autonomy lists it among allowed kinds.
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
  if p_kind = 'email.external' then
    raise exception 'External emails require an explicit owner request.' using errcode = '42501';
  end if;
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
    when v_agent.autonomy <> 'act' then 'proposed'
    when p_kind = 'email.send' then case
      when jsonb_typeof(v_agent.config -> 'auto_send_templates') = 'array'
        and (v_agent.config -> 'auto_send_templates') ? coalesce(p_input ->> 'template', '') then 'auto_approved'
      else 'proposed' end
    when coalesce(v_agent.config -> 'auto_approve_kinds', '[]'::jsonb) ? p_kind then 'auto_approved'
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

-- Only the current, explicitly approved action execution may obtain the message. Claiming
-- locks the action then its ledger: concurrent callers can obtain 'ready' only once.
-- p_claim=false reports an earlier attempt before sender readiness is checked; it never
-- creates an attempt. A send whose execution was replaced is durably marked unknown.
create function private.agent_external_email_begin_send(p_action_id uuid, p_execution integer, p_claim boolean default true) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_action private.agent_actions%rowtype;
  v_email private.agent_external_emails%rowtype;
begin
  perform private.require_hub_app_server();
  if p_execution is null or p_execution < 1 or p_claim is null then
    raise exception 'A current action execution is required.' using errcode = '22023';
  end if;
  select * into v_action from private.agent_actions where id = p_action_id for update;
  if not found or v_action.kind <> 'email.external' then
    raise exception 'Unknown external email action.' using errcode = 'P0002';
  end if;
  if v_action.status <> 'executing' or v_action.executions <> p_execution
    or v_action.decided_by is null or v_action.decided_at is null then
    raise exception 'The approved email is not being carried out by this execution.' using errcode = '55000';
  end if;
  select * into v_email from private.agent_external_emails where action_id = p_action_id for update;
  if not found or v_email.request_key <> v_action.request_key
    or v_action.preview is distinct from 'To: ' || v_email.recipient || E'\nSubject: ' || v_email.subject || E'\n\n' || v_email.body then
    raise exception 'The approved email does not match its recorded request.' using errcode = '55000';
  end if;
  if v_email.status <> 'requested' then
    if v_email.status = 'sending' and v_email.execution <> p_execution then
      update private.agent_external_emails set status = 'unknown', finished_at = now()
      where action_id = p_action_id returning * into v_email;
    end if;
    return jsonb_build_object('state', 'recorded', 'status', v_email.status, 'providerMessageId', v_email.provider_message_id);
  end if;
  if not p_claim then
    return jsonb_build_object('state', 'unrecorded');
  end if;
  update private.agent_external_emails set status = 'sending', execution = p_execution, attempted_at = now()
  where action_id = p_action_id;
  return jsonb_build_object('state', 'ready', 'to', v_email.recipient, 'subject', v_email.subject, 'body', v_email.body);
end;
$$;

-- Completion is fenced by both the action and the attempt that claimed this message. It
-- records only the first outcome and never reopens an attempted message for another send.
create function private.agent_external_email_finish_send(
  p_action_id uuid, p_execution integer, p_delivery text, p_provider_message_id text default null
) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_action private.agent_actions%rowtype;
begin
  perform private.require_hub_app_server();
  if p_execution is null or p_execution < 1 or p_delivery is null or p_delivery not in ('sent', 'failed', 'unknown')
    or (p_provider_message_id is not null and (char_length(p_provider_message_id) not between 1 and 200
      or p_provider_message_id ~ '[[:cntrl:]]' or p_delivery <> 'sent')) then
    raise exception 'Invalid delivery outcome.' using errcode = '22023';
  end if;
  select * into v_action from private.agent_actions where id = p_action_id for update;
  if not found or v_action.kind <> 'email.external' or v_action.status <> 'executing'
    or v_action.executions <> p_execution or v_action.decided_by is null then
    return false;
  end if;
  update private.agent_external_emails
  set status = p_delivery, provider_message_id = p_provider_message_id, finished_at = now()
  where action_id = p_action_id and execution = p_execution and status = 'sending';
  if not found then
    return false;
  end if;
  insert into private.audit_events (actor_id, action, entity_type, entity_id, metadata)
  values ('a1a00000-a1a0-4000-8000-000000000001', 'agent.email.outcome', 'agent_action', p_action_id,
    jsonb_build_object('kind', 'email.external', 'delivery', p_delivery));
  return true;
end;
$$;

revoke all on function private.agent_external_email_valid(text, text, text),
  private.agent_external_email_begin_send(uuid, integer, boolean),
  private.agent_external_email_finish_send(uuid, integer, text, text),
  private.agent_action_propose(uuid, uuid, text, text, text, text, jsonb)
  from public, anon, authenticated, service_role, hub_app_server;
grant execute on function private.agent_external_email_begin_send(uuid, integer, boolean),
  private.agent_external_email_finish_send(uuid, integer, text, text),
  private.agent_action_propose(uuid, uuid, text, text, text, text, jsonb) to hub_app_server;
revoke all on function hub.request_agent_email(text, text, text, uuid) from public, anon, authenticated, service_role, hub_app_server;
grant execute on function hub.request_agent_email(text, text, text, uuid) to authenticated;
