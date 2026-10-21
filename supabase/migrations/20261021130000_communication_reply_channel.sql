-- The reply contract also returns the conversation's channel, so the Hub server can
-- give an emailed reply a subject the customer recognizes. Imported phone-line
-- messages are titled for staff ("Billing call from Jordan Rivera"); the caller's
-- copy is named for what they did instead. Additive: the server keeps the stored
-- subject when an older database omits the field, and nothing else changes.
do $$ begin
  if (hub.get_backend_contract()->'features' @> '["support.communications.v1"]'::jsonb) is not true then
    raise exception 'Apply the unified communications foundation first' using errcode='55000';
  end if;
end $$;

-- Records an outbound reply before the Hub server sends it, so a retry can never
-- send twice. Callable only through the Hub server's verified SMS session.
create or replace function hub.begin_communication_reply(p_id uuid, p_body text, p_request_key uuid, p_available text[]) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_actor uuid := private.require_communication_staff(); c private.communications; v_body text := private.communication_body(p_body);
  v_route text; v_to text; existing private.communication_messages; v_message uuid;
begin
  if not private.current_app_session_verified() then
    raise exception 'Reply through the CareMetric Hub.' using errcode = '28000';
  end if;
  select * into c from private.communications where id = p_id for update;
  if not found or not private.has_staff_permission('case.write', c.product_id) then
    raise exception 'Conversation not found.' using errcode = '42501';
  end if;
  if p_request_key is null or v_body is null or char_length(v_body) > 5000 then
    raise exception 'Write a reply of up to 5,000 characters.' using errcode = '22023';
  end if;
  select * into existing from private.communication_messages m where m.communication_id = p_id and m.request_key = p_request_key;
  if found then
    -- A request key replays only the exact reply it first recorded; changed text needs a new key.
    if existing.direction <> 'outbound' or existing.body is distinct from v_body then
      raise exception 'This request key was already used for a different message.' using errcode = '22023';
    end if;
    return jsonb_build_object('messageId', existing.id, 'replay', true, 'delivery', existing.delivery, 'deliveryChannel', existing.delivery_channel);
  end if;
  v_route := case
    when c.channel in ('chat','sms','email') then c.channel
    when c.contact_email is not null and 'email' = any(p_available) then 'email'
    when c.contact_phone ~ '^\+[1-9][0-9]{7,14}$' and 'sms' = any(p_available) then 'sms'
    when c.contact_email is not null then 'email'
    when c.contact_phone ~ '^\+[1-9][0-9]{7,14}$' then 'sms'
    else null end;
  if v_route is null then
    raise exception 'This contact left no email address or mobile number. Call them back and record a note instead.' using errcode = 'P0001';
  end if;
  if v_route <> 'chat' and not (v_route = any(coalesce(p_available, '{}'))) then
    raise exception '% replies are not configured in the Hub yet. Record a note and reply from the original channel.',
      case v_route when 'sms' then 'Text message' else 'Email' end using errcode = 'P0001';
  end if;
  v_to := case v_route when 'sms' then c.contact_phone when 'email' then c.contact_email else null end;
  if v_route = 'sms' and v_to !~ '^\+[1-9][0-9]{7,14}$' then
    raise exception 'This conversation has no mobile number to text.' using errcode = 'P0001';
  end if;
  if v_route = 'email' and v_to is null then
    raise exception 'This conversation has no email address.' using errcode = 'P0001';
  end if;
  insert into private.communication_messages(communication_id, direction, body, author_id, author_name, delivery, delivery_channel, request_key)
    values (p_id, 'outbound', v_body, v_actor, (select display_name from hub.profiles where id = v_actor),
      case when v_route = 'chat' then 'sent' else 'pending' end, v_route, p_request_key)
    returning id into v_message;
  update private.communications set status = 'waiting', last_message_at = clock_timestamp(), updated_at = clock_timestamp() where id = p_id;
  insert into private.audit_events(actor_id, action, entity_type, entity_id, metadata)
    values (v_actor, 'communication.reply', 'communication', p_id, jsonb_build_object('message_id', v_message, 'channel', v_route));
  return jsonb_build_object('messageId', v_message, 'replay', false, 'delivery', case when v_route = 'chat' then 'sent' else 'pending' end,
    'deliveryChannel', v_route, 'to', v_to, 'reference', c.reference, 'subject', c.subject, 'channel', c.channel);
end;
$$;
revoke all on function hub.begin_communication_reply(uuid,text,uuid,text[]) from public, anon;
grant execute on function hub.begin_communication_reply(uuid,text,uuid,text[]) to authenticated;
