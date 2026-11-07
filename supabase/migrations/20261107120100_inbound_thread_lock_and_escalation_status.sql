-- Two fixes found in the November 7 feature review. Both replace a function with the same signature, so grants are kept.
--
-- 1. private.ingest_inbound_communication locked on the provider message id only. When a new number sent two texts at once
--    (or two emails opened the same thread), both transactions found no conversation and both inserted one; the second failed
--    on the (source_system, source_key) key, the webhook answered 500, and Twilio does not retry, so that text was lost.
--    It now also locks on the thread, after the message lock.
-- 2. hub.request_human_support set the case to in_progress and then posted the customer's request through
--    hub.reply_to_support_case, whose customer branch sets the case back to open. The request is now posted first.

CREATE OR REPLACE FUNCTION private.ingest_inbound_communication(p_channel text, p_thread_key text, p_provider_message_id text, p_reference bigint, p_product_slug text, p_subject text, p_body text, p_contact_name text, p_contact_email text, p_contact_phone text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_body text := private.communication_body(p_body); v_email text := lower(private.communication_line(p_contact_email, 320));
  v_id uuid; v_reference bigint; v_created boolean := false;
begin
  if p_channel not in ('sms','email') or private.communication_line(p_thread_key, 300) is null
    or private.communication_line(p_provider_message_id, 380) is null or v_body is null
    or (p_channel = 'sms' and p_contact_phone !~ '^\+[1-9][0-9]{7,14}$')
    or (v_email is not null and v_email !~ '^[^[:space:]@]+@[^[:space:]@]+$') then
    raise exception 'Invalid inbound message.' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('hub-communication-inbound:' || p_channel || ':' || p_provider_message_id, 0));
  -- Two first messages from the same sender can arrive at once with different provider ids. Serialize on the thread too (always
  -- after the message lock), so the second finds the conversation the first created instead of failing on its unique key.
  perform pg_advisory_xact_lock(hashtextextended('hub-communication-thread:' || p_channel || ':' || p_thread_key, 0));
  select c.id, c.reference into v_id, v_reference from private.communication_messages m join private.communications c on c.id = m.communication_id
    where m.direction = 'inbound' and m.provider_message_id = p_channel || ':' || p_provider_message_id;
  if found then return jsonb_build_object('id', v_id, 'reference', v_reference, 'created', false, 'duplicate', true); end if;
  -- An email reply carrying a Hub reference joins that conversation only when it comes from the same address.
  if p_channel = 'email' and p_reference is not null then
    select c.id into v_id from private.communications c
      where c.reference = p_reference and c.contact_email is not null and lower(c.contact_email) = v_email for update;
  end if;
  if v_id is null then
    select c.id into v_id from private.communications c where c.source_system = 'hub.' || p_channel and c.source_key = p_thread_key for update;
  end if;
  if v_id is null then
    insert into private.communications(channel, source_system, source_key, product_id, subject, contact_name, contact_email, contact_phone)
      values (p_channel, 'hub.' || p_channel, p_thread_key, private.communication_product(p_product_slug),
        coalesce(private.communication_line(p_subject, 200), case p_channel when 'sms' then 'Text message from ' || p_contact_phone else 'Email without a subject' end),
        private.communication_line(p_contact_name, 160), v_email, private.communication_line(p_contact_phone, 40))
      returning id into v_id;
    v_created := true;
  end if;
  insert into private.communication_messages(communication_id, direction, body, delivery, provider_message_id)
    values (v_id, 'inbound', v_body, 'received', p_channel || ':' || p_provider_message_id);
  update private.communications set
    status = case when status in ('waiting','closed') then 'open' else status end,
    last_message_at = clock_timestamp(), updated_at = clock_timestamp()
  where id = v_id returning reference into v_reference;
  return jsonb_build_object('id', v_id, 'reference', v_reference, 'created', v_created, 'duplicate', false);
end;
$function$;

CREATE OR REPLACE FUNCTION hub.request_human_support(p_case_id uuid, p_request_key uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare c hub.support_cases; state hub.case_ai_automation;
begin
 perform private.require_hub_app_server();
 if not private.current_app_session_verified() or not private.current_user_is_usable() then
  raise exception 'Sign in to continue' using errcode='28000';
 end if;
 if p_request_key is null then raise exception 'A request key is required' using errcode='22023';end if;
 select * into c from hub.support_cases where id=p_case_id;
 if not found or not private.can_view_case(c.id,c.tenant_id,c.product_id,c.requester_id)
  or private.has_staff_permission('case.write',c.product_id) then
  raise exception 'Support case unavailable' using errcode='42501';
 end if;
 if c.status in ('resolved','closed') then raise exception 'This case is already closed' using errcode='22023';end if;
 insert into hub.case_ai_automation(case_id,stage,halt_reason)
 values(p_case_id,'halted','human_requested') on conflict(case_id) do nothing;
 -- The worker locks automation before changing a case; use the same order.
 select * into state from hub.case_ai_automation where case_id=p_case_id for update;
 if state.halt_reason='human_requested' and state.escalated_at is not null then
  return jsonb_build_object('stage','halted','replayed',true);
 end if;
 -- Post the request first: a customer's reply reopens the case as 'open', so the escalation's own status must come after it.
 perform hub.reply_to_support_case(p_case_id,
  'Human support requested. Please have a support team member follow up on this case.',
  'customer',p_request_key);
 update hub.support_cases set status='in_progress',resolved_at=null,
  priority=case when priority in ('low','normal') then 'high'::hub.case_priority else priority end
 where id=p_case_id and status not in ('resolved','closed');
 if not found then raise exception 'This case is already closed' using errcode='22023';end if;
 update hub.case_ai_automation set stage='halted',halt_reason='human_requested',
  escalated_at=coalesce(escalated_at,now()),responded_at=now(),response_source='portal',
  follow_up_due_at=null,retry_at=null where case_id=p_case_id;
 insert into private.audit_events(actor_id,action,entity_type,entity_id,tenant_id,product_id,case_id,changed_columns)
 values(auth.uid(),'case.human_requested','support_case',c.id,c.tenant_id,c.product_id,c.id,array['status','priority','ai_stage']);
 return jsonb_build_object('stage','halted','replayed',false);
end;$function$;
