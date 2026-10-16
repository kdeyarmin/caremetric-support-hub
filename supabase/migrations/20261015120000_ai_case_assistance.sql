-- AI case assistance and the customer auto-resolution loop.
--
-- Staff-side assistance (summarize / draft reply / triage suggestion) is served by the
-- Hub server calling Anthropic directly; it needs no schema. This migration carries
-- only what the automated loop needs in the database:
--   * a durable system identity that authors AI thread content (never a human staffer),
--   * 'ai_assistant' as an author role for customer messages and internal notes,
--   * hub.case_ai_automation: the per-case loop state (attempts hard-capped at 2),
--   * the loop stage on the case queue, so escalation is visible to staff, and
--   * hub.record_ai_resolution_response: the customer's explicit fixed / not-fixed
--     answer, authorized and idempotent like the other case mutations.
--
-- Automation stays OFF after this migration: the server loop only runs when
-- HUB_AI_AUTOMATION_ENABLED=true and ANTHROPIC_API_KEY is configured. Applying the
-- migration alone never posts an automated message.

-- The AI assistant is a durable foreign-key identity only: it has no SMS identity,
-- no staff permission and no tenant membership, so it can never sign in, be assigned
-- a case (assignment requires a staff permission), or act through any session RPC.
insert into auth.users (id, aud, role, raw_user_meta_data, raw_app_meta_data, created_at, updated_at, is_anonymous)
values (
  'a1a00000-a1a0-4000-8000-000000000001',
  'authenticated',
  'authenticated',
  jsonb_build_object('display_name', 'CareMetric AI Assistant'),
  jsonb_build_object('provider', 'caremetric_ai', 'providers', '[]'::jsonb),
  now(),
  now(),
  false
)
on conflict (id) do nothing;

insert into hub.profiles (id, display_name)
values ('a1a00000-a1a0-4000-8000-000000000001', 'CareMetric AI Assistant')
on conflict (id) do nothing;

alter table hub.case_messages
  drop constraint if exists case_messages_author_role_check;
alter table hub.case_messages
  add constraint case_messages_author_role_check
  check (author_role in ('customer', 'tenant_admin', 'support_agent', 'support_manager', 'platform_admin', 'ai_assistant'));

alter table private.case_notes
  drop constraint if exists case_notes_author_role_check;
alter table private.case_notes
  add constraint case_notes_author_role_check
  check (author_role in ('support_agent', 'support_manager', 'platform_admin', 'ai_assistant'));

alter table private.support_request_keys
  drop constraint if exists support_request_keys_operation_check;
alter table private.support_request_keys
  add constraint support_request_keys_operation_check
  check (operation in ('case.create', 'case.reply', 'case.ai_resolution'));

create table hub.case_ai_automation (
  case_id uuid primary key references hub.support_cases(id) on delete cascade,
  stage text not null default 'attempt_due'
    check (stage in ('attempt_due', 'awaiting_response', 'escalate_due', 'exhausted', 'resolved', 'halted')),
  attempts integer not null default 0 check (attempts between 0 and 2),
  last_attempt_at timestamptz,
  last_ai_message_id uuid references hub.case_messages(id) on delete set null,
  last_seen_customer_message_id uuid references hub.case_messages(id) on delete set null,
  last_customer_response text check (last_customer_response is null or char_length(last_customer_response) <= 5000),
  follow_up_due_at timestamptz,
  follow_up_sent_at timestamptz,
  responded_at timestamptz,
  response_source text check (response_source is null or response_source in ('portal', 'classification')),
  escalated_at timestamptz,
  halt_reason text check (halt_reason is null or char_length(halt_reason) <= 120),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table hub.case_ai_automation enable row level security;

create policy case_ai_automation_read on hub.case_ai_automation for select to authenticated
using (private.can_view_case_id(case_id));

grant select on hub.case_ai_automation to authenticated;
revoke insert, update, delete on hub.case_ai_automation from anon, authenticated;

create trigger case_ai_automation_set_updated_at
  before update on hub.case_ai_automation
  for each row execute function private.set_updated_at();

create or replace view hub.support_case_queue
with (security_invoker = true)
as
select
  support_case.id,
  support_case.case_number,
  support_case.tenant_id,
  tenant.name as tenant_name,
  support_case.product_id,
  support_case.requester_id,
  support_case.requester_display_name as requester_name,
  support_case.subject,
  support_case.category,
  support_case.priority,
  support_case.status,
  support_case.source,
  support_case.assigned_to,
  support_case.assigned_to_display_name as assigned_to_name,
  support_case.app_version,
  support_case.route,
  support_case.created_at,
  support_case.updated_at,
  support_case.last_message_at,
  automation.stage as ai_stage,
  automation.attempts as ai_attempts
from hub.support_cases support_case
join hub.tenants tenant on tenant.id = support_case.tenant_id
left join hub.case_ai_automation automation on automation.case_id = support_case.id;

create or replace function hub.record_ai_resolution_response(
  p_case_id uuid,
  p_fixed boolean,
  p_request_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_case hub.support_cases%rowtype;
  v_state hub.case_ai_automation%rowtype;
  v_request private.support_request_keys%rowtype;
  v_request_hash text;
  v_inserted integer;
  v_stage text;
begin
  if v_user_id is null or not private.current_user_is_usable() then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if p_request_key is null then
    raise exception 'A request key is required.' using errcode = '22023';
  end if;
  if p_fixed is null then
    raise exception 'A fixed or not-fixed answer is required.' using errcode = '22023';
  end if;

  select * into v_case
  from hub.support_cases
  where id = p_case_id;
  if v_case.id is null
     or not private.can_view_case(v_case.id, v_case.tenant_id, v_case.product_id, v_case.requester_id) then
    raise exception 'Support case not found.' using errcode = '42501';
  end if;
  -- The answer belongs to the customer side of the case. Staff manage escalated
  -- cases through the normal case controls, never through this response.
  if private.has_staff_permission('case.write', v_case.product_id) then
    raise exception 'Support staff manage this case directly.' using errcode = '42501';
  end if;

  v_request_hash := encode(
    extensions.digest(
      jsonb_build_array(p_case_id, p_fixed)::text,
      'sha256'
    ),
    'hex'
  );

  insert into private.support_request_keys (
    actor_id,
    operation,
    request_key,
    request_hash,
    case_id
  ) values (
    v_user_id,
    'case.ai_resolution',
    p_request_key,
    v_request_hash,
    p_case_id
  )
  on conflict (actor_id, operation, request_key) do nothing;

  get diagnostics v_inserted = row_count;
  if v_inserted = 0 then
    select * into v_request
    from private.support_request_keys request
    where request.actor_id = v_user_id
      and request.operation = 'case.ai_resolution'
      and request.request_key = p_request_key;

    if not found or v_request.request_hash is distinct from v_request_hash then
      raise exception 'Request key was already used with a different answer.' using errcode = '22023';
    end if;
    if v_request.completed_at is null then
      raise exception 'The earlier answer did not complete. Use a new request key.' using errcode = 'P0001';
    end if;

    select stage into v_stage
    from hub.case_ai_automation
    where case_id = p_case_id;
    return jsonb_build_object('case_id', p_case_id, 'stage', v_stage, 'replayed', true);
  end if;

  select * into v_state
  from hub.case_ai_automation
  where case_id = p_case_id
  for update;
  if v_state.case_id is null or v_state.stage <> 'awaiting_response' then
    raise exception 'No AI resolution is waiting for an answer on this case.' using errcode = 'P0001';
  end if;

  if p_fixed then
    update hub.support_cases
    set status = 'resolved'::hub.case_status,
        resolved_at = coalesce(resolved_at, now())
    where id = p_case_id;

    update hub.case_ai_automation
    set stage = 'resolved',
        responded_at = now(),
        response_source = 'portal'
    where case_id = p_case_id;
    v_stage := 'resolved';
  else
    v_stage := case when v_state.attempts >= 2 then 'escalate_due' else 'attempt_due' end;
    update hub.case_ai_automation
    set stage = v_stage,
        responded_at = now(),
        response_source = 'portal'
    where case_id = p_case_id;
  end if;

  insert into private.audit_events (
    actor_id,
    action,
    entity_type,
    entity_id,
    tenant_id,
    product_id,
    case_id,
    changed_columns
  ) values (
    v_user_id,
    'case.ai_resolution_answered',
    'support_case',
    p_case_id,
    v_case.tenant_id,
    v_case.product_id,
    p_case_id,
    array['stage']
  );

  update private.support_request_keys
  set entity_id = p_case_id,
      completed_at = now()
  where actor_id = v_user_id
    and operation = 'case.ai_resolution'
    and request_key = p_request_key;

  return jsonb_build_object('case_id', p_case_id, 'stage', v_stage, 'replayed', false);
end;
$$;

revoke all on function hub.record_ai_resolution_response(uuid, boolean, uuid) from public;
grant execute on function hub.record_ai_resolution_response(uuid, boolean, uuid) to authenticated;
