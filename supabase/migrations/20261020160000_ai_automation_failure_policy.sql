-- A bounded failure policy for the AI auto-resolution loop.
--
-- A step that failed for one case (for example a draft longer than the 5000-character
-- reply limit, which post_message refuses with 22023) left the case at its stage, and
-- the active batch returned it on every sweep: a new provider call each minute, for
-- ever, while the customer got neither a reply nor a human.
--
-- * hub.case_ai_automation.consecutive_failures counts the case's failed steps in a
--   row; any step that goes through sets it back to 0.
-- * hub.case_ai_automation.retry_at is the backoff the loop chose after a failure.
--   The active batch leaves a case out until then, so failing cases neither retry
--   every sweep nor crowd the batch.
-- * private.ai_automation_work returns both, and private.ai_automation_save_state
--   accepts both (consecutiveFailures, retryAt).
--
-- The loop (server/ai-automation.mjs) retries a provider outage for as long as it
-- lasts and hands any other repeated failure to staff through the existing escalation
-- step. The Hub server requires backend feature support.ai-automation-failure-policy.v1,
-- which 20261020160100 declares once this migration is in place.
--
-- Signatures, security definer, the pinned search path and the hub_app_server-only
-- grants are unchanged.

alter table hub.case_ai_automation
  add column consecutive_failures integer not null default 0 check (consecutive_failures >= 0),
  add column retry_at timestamptz;

create or replace function private.ai_automation_active_cases()
returns setof uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if session_user <> 'hub_app_server' then
    raise exception 'Application server required.' using errcode = '42501';
  end if;
  return query
  select automation.case_id
  from hub.case_ai_automation automation
  join hub.support_cases support_case on support_case.id = automation.case_id
  -- A case backing off after a failed step waits until its retry time.
  where (automation.retry_at is null or automation.retry_at <= now())
    and (automation.stage in ('attempt_due', 'escalate_due')
     or (automation.stage = 'awaiting_response' and (
       -- Halts: the case was closed, or staff took it over.
       support_case.status in ('resolved', 'closed')
       or exists (
         select 1 from hub.case_messages message
         where message.case_id = automation.case_id
           and message.author_role in ('support_agent', 'support_manager', 'platform_admin')
       )
       -- A customer reply the loop has not classified yet.
       or (
         select message.id from hub.case_messages message
         where message.case_id = automation.case_id
           and message.author_role in ('customer', 'tenant_admin')
         order by message.created_at desc, message.id desc
         limit 1
       ) is distinct from automation.last_seen_customer_message_id
       -- A follow-up nudge that is due and not yet sent.
       or (automation.follow_up_due_at <= now() and automation.follow_up_sent_at is null)
     )))
  order by automation.updated_at asc, automation.case_id asc
  limit 25;
end;
$$;

create or replace function private.ai_automation_work(p_case_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_state hub.case_ai_automation%rowtype;
  v_case hub.support_cases%rowtype;
begin
  if session_user <> 'hub_app_server' then
    raise exception 'Application server required.' using errcode = '42501';
  end if;
  select * into v_state from hub.case_ai_automation where case_id = p_case_id;
  if not found then
    return null;
  end if;
  select * into v_case from hub.support_cases where id = p_case_id;
  if not found then
    return null;
  end if;
  return jsonb_build_object(
    'caseId', v_case.id,
    'subject', v_case.subject,
    'productId', v_case.product_id,
    'status', v_case.status,
    'priority', v_case.priority,
    'state', jsonb_build_object(
      'stage', v_state.stage,
      'attempts', v_state.attempts,
      'lastSeenCustomerMessageId', v_state.last_seen_customer_message_id,
      'lastCustomerResponse', v_state.last_customer_response,
      'followUpDueAt', v_state.follow_up_due_at,
      'followUpSentAt', v_state.follow_up_sent_at,
      'consecutiveFailures', v_state.consecutive_failures,
      'retryAt', v_state.retry_at
    ),
    'messages', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', message.id,
        'authorId', message.author_id,
        'authorName', message.author_display_name,
        'authorRole', message.author_role,
        'body', message.body,
        'createdAt', message.created_at
      ) order by message.created_at, message.id)
      from hub.case_messages message
      where message.case_id = p_case_id
    ), '[]'::jsonb),
    'notes', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', note.id,
        'authorName', note.author_display_name,
        'authorRole', note.author_role,
        'body', note.body,
        'createdAt', note.created_at
      ) order by note.created_at, note.id)
      from private.case_notes note
      where note.case_id = p_case_id
    ), '[]'::jsonb)
  );
end;
$$;

create or replace function private.ai_automation_save_state(p_case_id uuid, p_patch jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_state hub.case_ai_automation%rowtype;
  v_next hub.case_ai_automation%rowtype;
  v_field text;
begin
  if session_user <> 'hub_app_server' then
    raise exception 'Application server required.' using errcode = '42501';
  end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then
    raise exception 'An automation state change is required.' using errcode = '22023';
  end if;
  for v_field in select jsonb_object_keys(p_patch) loop
    if v_field <> all (array[
      'stage', 'attempts', 'lastAttemptAt', 'lastAiMessageId', 'lastSeenCustomerMessageId',
      'lastCustomerResponse', 'followUpDueAt', 'followUpSentAt', 'respondedAt', 'responseSource',
      'escalatedAt', 'haltReason', 'consecutiveFailures', 'retryAt'
    ]) then
      raise exception 'Unsupported automation state field.' using errcode = '22023';
    end if;
  end loop;

  v_state := private.ai_automation_state_for_step(p_case_id, array['attempt_due', 'awaiting_response', 'escalate_due']);
  v_next := v_state;
  if p_patch ? 'stage' then v_next.stage := p_patch ->> 'stage'; end if;
  if p_patch ? 'attempts' then v_next.attempts := (p_patch ->> 'attempts')::integer; end if;
  if p_patch ? 'lastAttemptAt' then v_next.last_attempt_at := (p_patch ->> 'lastAttemptAt')::timestamptz; end if;
  if p_patch ? 'lastAiMessageId' then v_next.last_ai_message_id := (p_patch ->> 'lastAiMessageId')::uuid; end if;
  if p_patch ? 'lastSeenCustomerMessageId' then v_next.last_seen_customer_message_id := (p_patch ->> 'lastSeenCustomerMessageId')::uuid; end if;
  if p_patch ? 'lastCustomerResponse' then v_next.last_customer_response := p_patch ->> 'lastCustomerResponse'; end if;
  if p_patch ? 'followUpDueAt' then v_next.follow_up_due_at := (p_patch ->> 'followUpDueAt')::timestamptz; end if;
  if p_patch ? 'followUpSentAt' then v_next.follow_up_sent_at := (p_patch ->> 'followUpSentAt')::timestamptz; end if;
  if p_patch ? 'respondedAt' then v_next.responded_at := (p_patch ->> 'respondedAt')::timestamptz; end if;
  if p_patch ? 'responseSource' then v_next.response_source := p_patch ->> 'responseSource'; end if;
  if p_patch ? 'escalatedAt' then v_next.escalated_at := (p_patch ->> 'escalatedAt')::timestamptz; end if;
  if p_patch ? 'haltReason' then v_next.halt_reason := p_patch ->> 'haltReason'; end if;
  if p_patch ? 'consecutiveFailures' then v_next.consecutive_failures := (p_patch ->> 'consecutiveFailures')::integer; end if;
  if p_patch ? 'retryAt' then v_next.retry_at := (p_patch ->> 'retryAt')::timestamptz; end if;

  if v_next.attempts is null or v_next.attempts < v_state.attempts then
    raise exception 'Automated attempts never decrease.' using errcode = '22023';
  end if;
  if v_next.consecutive_failures is null or v_next.consecutive_failures < 0 then
    raise exception 'A failure count of zero or more is required.' using errcode = '22023';
  end if;
  if v_next.last_ai_message_id is distinct from v_state.last_ai_message_id
     and v_next.last_ai_message_id is not null
     and not exists (
       select 1 from hub.case_messages message
       where message.id = v_next.last_ai_message_id
         and message.case_id = p_case_id
         and message.author_role = 'ai_assistant'
     ) then
    raise exception 'The automated reply must belong to this case.' using errcode = '22023';
  end if;
  if v_next.last_seen_customer_message_id is distinct from v_state.last_seen_customer_message_id
     and v_next.last_seen_customer_message_id is not null
     and not exists (
       select 1 from hub.case_messages message
       where message.id = v_next.last_seen_customer_message_id
         and message.case_id = p_case_id
     ) then
    raise exception 'The customer message must belong to this case.' using errcode = '22023';
  end if;

  update hub.case_ai_automation
  set stage = v_next.stage,
      attempts = v_next.attempts,
      last_attempt_at = v_next.last_attempt_at,
      last_ai_message_id = v_next.last_ai_message_id,
      last_seen_customer_message_id = v_next.last_seen_customer_message_id,
      last_customer_response = v_next.last_customer_response,
      follow_up_due_at = v_next.follow_up_due_at,
      follow_up_sent_at = v_next.follow_up_sent_at,
      responded_at = v_next.responded_at,
      response_source = v_next.response_source,
      escalated_at = v_next.escalated_at,
      halt_reason = v_next.halt_reason,
      consecutive_failures = v_next.consecutive_failures,
      retry_at = v_next.retry_at
  where case_id = p_case_id;
end;
$$;
