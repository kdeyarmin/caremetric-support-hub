-- Sweep safety for the AI auto-resolution loop's server-role operations.
--
-- * The active batch returns only cases with something to do. Before, it returned the
--   25 least recently updated automation rows; a case waiting on a customer who never
--   answers (follow-up already sent) never changes its row, so 25 of them would hold
--   that batch forever and later replies would never be classified or escalated.
-- * Posting a reply consumes the step it belongs to in the same transaction. An
--   attempt moves the case from attempt_due to awaiting_response and counts the
--   attempt; a follow-up nudge must be due and is marked sent. A second Hub process
--   sweeping concurrently (deploy overlap), or a retry after a crash between posting
--   and saving state, can no longer post the same attempt or nudge twice, so the
--   two-attempt cap holds for customer-facing replies too.
--
-- Signatures, security definer, the pinned search path and the hub_app_server-only
-- grants are unchanged.

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
  where automation.stage in ('attempt_due', 'escalate_due')
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
     ))
  order by automation.updated_at asc, automation.case_id asc
  limit 25;
end;
$$;

create or replace function private.ai_automation_post_message(p_case_id uuid, p_body text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_state hub.case_ai_automation%rowtype;
  v_status hub.case_status;
  v_message_id uuid;
begin
  if session_user <> 'hub_app_server' then
    raise exception 'Application server required.' using errcode = '42501';
  end if;
  if p_body is null or char_length(btrim(p_body)) = 0 or char_length(p_body) > 5000 then
    raise exception 'An automated reply of 1 to 5000 characters is required.' using errcode = '22023';
  end if;
  v_state := private.ai_automation_state_for_step(p_case_id, array['attempt_due', 'awaiting_response']);
  -- While awaiting the customer, the only automated reply is the one follow-up nudge.
  if v_state.stage = 'awaiting_response'
     and (v_state.follow_up_due_at is null or v_state.follow_up_due_at > now() or v_state.follow_up_sent_at is not null) then
    raise exception 'No automated reply is due on this case.' using errcode = 'P0001';
  end if;
  select status into v_status from hub.support_cases where id = p_case_id for update;
  if v_status in ('resolved', 'closed') then
    raise exception 'Automated replies are never posted on a resolved or closed case.' using errcode = 'P0001';
  end if;

  insert into hub.case_messages (case_id, author_id, author_display_name, author_role, body)
  values (p_case_id, 'a1a00000-a1a0-4000-8000-000000000001', 'CareMetric AI Assistant', 'ai_assistant', p_body)
  returning id into v_message_id;

  update hub.support_cases
  set last_message_at = now(),
      status = case when status in ('open', 'in_progress') then 'waiting_on_customer'::hub.case_status else status end
  where id = p_case_id;

  if v_state.stage = 'attempt_due' then
    -- The attempt is counted with the reply; the loop then records the follow-up
    -- schedule it chose.
    update hub.case_ai_automation
    set stage = 'awaiting_response',
        attempts = v_state.attempts + 1,
        last_attempt_at = now(),
        last_ai_message_id = v_message_id,
        last_seen_customer_message_id = (
          select message.id from hub.case_messages message
          where message.case_id = p_case_id
            and message.author_role in ('customer', 'tenant_admin')
          order by message.created_at desc, message.id desc
          limit 1
        ),
        follow_up_due_at = null,
        follow_up_sent_at = null,
        responded_at = null
    where case_id = p_case_id;
  else
    update hub.case_ai_automation
    set follow_up_sent_at = now()
    where case_id = p_case_id;
  end if;

  return v_message_id;
end;
$$;
