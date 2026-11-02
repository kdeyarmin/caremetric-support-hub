-- The Support Concierge's reads, and the alert caps it needs.
--
-- Triage runs with nobody signed in, so it cannot use the staff operations on conversations (they need the
-- owner's session). These are the reads it needs, callable by the Hub server role alone like the rest of the
-- control plane:
--
--   agent_concierge_pending:      which conversations have an inbound message nobody has answered or triaged yet
--   agent_communication_snapshot: a minimal view of one conversation: its state and, when asked, the last few messages
--   agent_notification_count:     how many alerts of one kind went to the owner since a time, for the alert caps
--
-- The snapshot is deliberately not private.communication_json: it carries no contact name, email address, phone
-- number, organization or assignee, and no internal notes. Message text does come back (clipped, and only to the
-- Hub server) because triage reads it; it is never written to a task payload, run summary, alert or log.

-- A conversation is pending when its latest inbound message has settled (a burst of texts counts once), is recent
-- (an import of old history never triggers a backlog of triage), has no reply or note after it, and has no task yet.
create function private.agent_concierge_pending(
  p_limit integer, p_settle_seconds integer, p_window_hours integer, p_channels text[] default null
) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_hub_app_server();
  if p_limit is null or p_limit < 1 or p_limit > 50 then
    raise exception 'List between 1 and 50 conversations.' using errcode = '22023';
  end if;
  if p_settle_seconds is null or p_settle_seconds < 0 or p_settle_seconds > 3600 then
    raise exception 'Choose a settle time between 0 and 3600 seconds.' using errcode = '22023';
  end if;
  if p_window_hours is null or p_window_hours < 1 or p_window_hours > 720 then
    raise exception 'Choose a window between 1 and 720 hours.' using errcode = '22023';
  end if;
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', x.id, 'reference', x.reference, 'channel', x.channel, 'messageId', x.message_id, 'receivedAt', x.received_at)
      order by x.received_at, x.message_id), '[]'::jsonb)
    from (
      select c.id, c.reference, c.channel, m.id as message_id, m.created_at as received_at
      from private.communications c
      cross join lateral (
        select i.id, i.created_at from private.communication_messages i
        where i.communication_id = c.id and i.direction = 'inbound'
        order by i.created_at desc, i.id desc limit 1) m
      where c.status in ('new', 'open')
        and c.last_message_at >= now() - make_interval(hours => p_window_hours)
        and (p_channels is null or c.channel = any (p_channels))
        and m.created_at <= now() - make_interval(secs => p_settle_seconds)
        and m.created_at >= now() - make_interval(hours => p_window_hours)
        and not exists (
          select 1 from private.communication_messages a
          where a.communication_id = c.id and a.direction in ('outbound', 'note')
            and (a.created_at, a.id) > (m.created_at, m.id))
        and not exists (select 1 from private.agent_tasks t where t.request_key = 'concierge:' || m.id::text)
      order by m.created_at, m.id
      limit p_limit
    ) x
  );
end;
$$;

-- One conversation, as little of it as the caller asks for. headMessageId is the newest inbound or outbound message
-- other than the outbound that carries p_request_key, so a reply sent under that key never changes the head it was
-- approved against (the guard that refuses to send into a thread that moved on). p_messages = 0 returns heads only.
-- Returns null when the conversation does not exist.
create function private.agent_communication_snapshot(
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
    'messages', v_messages);
end;
$$;

-- How many alerts matching a dedupe key prefix went out since a time. An alert that was never sent (no channel
-- configured) does not count: the caps exist to stop a flood reaching the owner, not to ration records.
create function private.agent_notification_count(p_dedupe_prefix text, p_channel text, p_since timestamptz) returns integer
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_hub_app_server();
  if p_dedupe_prefix is null or char_length(p_dedupe_prefix) not between 1 and 100 then
    raise exception 'Choose a dedupe prefix of 1 to 100 characters.' using errcode = '22023';
  end if;
  if p_channel is not null and p_channel not in ('sms', 'email') then
    raise exception 'Choose sms, email or no channel.' using errcode = '22023';
  end if;
  if p_since is null then
    raise exception 'Choose a start time.' using errcode = '22023';
  end if;
  return (
    select count(*)::integer from private.owner_notifications n
    where left(n.dedupe_key, char_length(p_dedupe_prefix)) = p_dedupe_prefix
      and (p_channel is null or n.channel = p_channel)
      and n.status <> 'suppressed'
      and n.created_at >= p_since);
end;
$$;

revoke all on function private.agent_concierge_pending(integer, integer, integer, text[]),
  private.agent_communication_snapshot(uuid, uuid, integer, integer),
  private.agent_notification_count(text, text, timestamptz)
  from public, anon, authenticated, service_role, hub_app_server;
grant execute on function private.agent_concierge_pending(integer, integer, integer, text[]),
  private.agent_communication_snapshot(uuid, uuid, integer, integer),
  private.agent_notification_count(text, text, timestamptz)
  to hub_app_server;

-- A sweep every two minutes would add 720 task rows a day; every five minutes matches the health checks.
update private.agent_schedules set every_seconds = 300
where agent_key = 'support_concierge' and task_kind = 'concierge.sweep' and cadence = 'interval' and every_seconds = 120;

-- What the Concierge watches. Editable by SQL only (the Team screen has no settings editor): the channels it triages
-- (text messages stay off until the toll-free verification covers support texts), how long a burst of messages settles
-- before it is triaged, and how old an unanswered message may be before it is left to the owner. A value the owner
-- already set is kept.
update private.agents
set config = jsonb_build_object('channels', jsonb_build_array('email', 'chat', 'web_form', 'phone'), 'settle_seconds', 90, 'window_hours', 72) || config
where key = 'support_concierge';

update private.agents
set role_summary = 'Notices every new conversation in the Communications inbox within minutes, screens it for patient information, alerts you (by text when it looks urgent) and offers a fixed acknowledgment for you to approve. With model drafting switched on it also drafts answers from the published guides.'
where key = 'support_concierge'
  and role_summary = 'Triages every new conversation in the Communications inbox and drafts a reply for the owner to approve.';
