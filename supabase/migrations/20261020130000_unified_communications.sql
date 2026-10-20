-- Unified communications. Every customer-service and technical-support inquiry
-- that arrives by phone, text message, email, chat or web form becomes one
-- conversation in the Hub, for every connected application. Inbound text is
-- untrusted and may contain PHI: it lives only in the private schema, is reached
-- only through the reviewed functions below, and is never copied into audit
-- metadata. Provider credentials never enter the database.

create table private.communications (
  id uuid primary key default gen_random_uuid(),
  reference bigint generated always as identity (start with 1001) unique,
  channel text not null check (channel in ('phone','sms','email','chat','web_form')),
  source_system text not null check (source_system in ('hub.sms','hub.email','hub.chat','breathe.phone','advisors.web')),
  source_key text not null check (char_length(source_key) between 1 and 300),
  product_id uuid references hub.products(id) on delete restrict,
  inquiry_type text not null default 'unclassified'
    check (inquiry_type in ('technical_support','customer_service','billing','sales','advisors','unclassified')),
  status text not null default 'new' check (status in ('new','open','waiting','closed')),
  subject text not null check (char_length(subject) between 1 and 200),
  contact_name text check (char_length(contact_name) <= 160),
  contact_email text check (contact_email is null or (char_length(contact_email) <= 320 and contact_email ~ '^[^[:space:]@]+@[^[:space:]@]+$')),
  contact_phone text check (char_length(contact_phone) <= 40),
  organization text check (char_length(organization) <= 200),
  assigned_to uuid references auth.users(id) on delete set null,
  chat_token_hash text unique check (chat_token_hash is null or chat_token_hash ~ '^[0-9a-f]{64}$'),
  data_classification text not null default 'possible_phi' check (data_classification = 'possible_phi'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_message_at timestamptz not null default now(),
  unique (source_system, source_key),
  check ((channel = 'chat') = (chat_token_hash is not null)),
  check ((channel = 'chat') = (source_system = 'hub.chat'))
);
create index communications_activity on private.communications(last_message_at desc, id);
create index communications_product on private.communications(product_id);
create index communications_assignee on private.communications(assigned_to) where assigned_to is not null;

create table private.communication_messages (
  id uuid primary key default gen_random_uuid(),
  communication_id uuid not null references private.communications(id) on delete cascade,
  direction text not null check (direction in ('inbound','outbound','note')),
  body text not null check (char_length(body) between 1 and 20000),
  author_id uuid references auth.users(id) on delete set null,
  author_name text check (char_length(author_name) <= 160),
  delivery text not null check (delivery in ('received','pending','sent','failed','unknown','recorded')),
  delivery_channel text check (delivery_channel in ('sms','email','chat')),
  provider_message_id text check (char_length(provider_message_id) <= 400),
  request_key uuid,
  created_at timestamptz not null default now(),
  unique (communication_id, request_key),
  check ((direction = 'inbound') = (delivery = 'received')),
  check ((direction = 'note') = (delivery = 'recorded')),
  check ((direction = 'outbound') = (delivery_channel is not null))
);
create index communication_messages_thread on private.communication_messages(communication_id, created_at, id);
create unique index communication_messages_inbound_provider on private.communication_messages(provider_message_id)
  where direction = 'inbound' and provider_message_id is not null;

-- Public chat abuse limits. Client addresses are stored only as SHA-256 hashes.
create table private.communication_rate_events (
  id bigint generated always as identity primary key,
  bucket text not null check (bucket in ('chat.start','chat.message')),
  client_hash text not null check (client_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now()
);
create index communication_rate_recent on private.communication_rate_events(bucket, created_at);
create index communication_rate_client on private.communication_rate_events(bucket, client_hash, created_at);

alter table private.communications enable row level security;
alter table private.communication_messages enable row level security;
alter table private.communication_rate_events enable row level security;
revoke all on private.communications, private.communication_messages, private.communication_rate_events
  from public, anon, authenticated, hub_app_server;
comment on table private.communications is
  'One conversation per inquiry from phone, SMS, email, chat or web form. Untrusted possible-PHI text; reached only through reviewed functions.';

-- Owner-recognizable application names map to registered products; unknown names stay unassigned for triage.
create or replace function private.communication_product(p_slug text) returns uuid
language sql stable security definer set search_path = '' as $$
  select p.id from hub.products p
  where p.status <> 'retired' and p.support_enabled
    and p.slug = case lower(btrim(coalesce(p_slug, '')))
      when 'pennfit' then 'breathe' when 'penntrain' then 'carebase' when 'caremetric-pennsync' then 'pennsync'
      when 'intel' then 'caremetric-intel' when 'emr' then 'caremetric-emr' when 'go' then 'caremetric-go'
      when 'healthcare-advisors' then 'advisors'
      else lower(btrim(coalesce(p_slug, ''))) end;
$$;

-- Single-line fields lose every control character; bodies keep line breaks and tabs.
create or replace function private.communication_line(p_value text, p_max integer) returns text
language sql immutable set search_path = '' as $$
  select nullif(btrim(left(regexp_replace(coalesce(p_value, ''), '[[:cntrl:]]+', ' ', 'g'), p_max)), '');
$$;
create or replace function private.communication_body(p_value text) returns text
language sql immutable set search_path = '' as $$
  select case when char_length(cleaned) > 19900
    then left(cleaned, 19900) || E'\n\n[Message shortened in the Hub. Ask the sender for anything that was cut off.]'
    else cleaned end
  from (select nullif(btrim(regexp_replace(replace(coalesce(p_value, ''), E'\r\n', E'\n'), '[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]', '', 'g')), '') as cleaned) value;
$$;

create or replace function private.can_read_communication(p_product_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.has_staff_permission('case.read', p_product_id) or private.has_staff_permission('case.write', p_product_id);
$$;

create or replace function private.communication_json(p_id uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', c.id, 'reference', c.reference, 'channel', c.channel, 'sourceSystem', c.source_system,
    'productId', c.product_id, 'inquiryType', c.inquiry_type, 'status', c.status, 'subject', c.subject,
    'contactName', c.contact_name, 'contactEmail', c.contact_email, 'contactPhone', c.contact_phone,
    'organization', c.organization, 'assignedTo', c.assigned_to,
    'assignedToName', (select profile.display_name from hub.profiles profile where profile.id = c.assigned_to),
    'createdAt', c.created_at, 'updatedAt', c.updated_at, 'lastMessageAt', c.last_message_at,
    'messageCount', (select count(*) from private.communication_messages m where m.communication_id = c.id and m.direction <> 'note'))
  from private.communications c where c.id = p_id;
$$;

create or replace function private.require_communication_staff() returns uuid
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or not private.current_user_is_usable() or not private.current_session_is_verified()
    or not exists (select 1 from private.staff_permissions sp where sp.user_id = auth.uid() and sp.revoked_at is null
      and sp.permission in ('case.read','case.write','platform.admin')) then
    raise exception 'Support staff access required.' using errcode = '42501';
  end if;
  return auth.uid();
end;
$$;

create or replace function hub.list_communications(
  p_status text default null, p_channel text default null, p_product_id uuid default null,
  p_search text default null, p_offset integer default 0, p_limit integer default 25
) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_search text := nullif(btrim(coalesce(p_search, '')), ''); v_result jsonb;
begin
  perform private.require_communication_staff();
  if (p_status is not null and p_status not in ('active','new','open','waiting','closed'))
    or (p_channel is not null and p_channel not in ('phone','sms','email','chat','web_form'))
    or p_offset is null or p_offset < 0 or p_offset > 10000 or p_limit is null or p_limit < 1 or p_limit > 50
    or char_length(v_search) > 100 or v_search ~ '[[:cntrl:]]' then
    raise exception 'Invalid conversation filter.' using errcode = '22023';
  end if;
  with visible as materialized (
    select c.id, c.status, c.last_message_at from private.communications c
    where private.can_read_communication(c.product_id)
      and (p_channel is null or c.channel = p_channel)
      and (p_product_id is null or c.product_id = p_product_id)
      and (v_search is null or strpos(lower(concat_ws(' ', c.subject, c.contact_name, c.contact_email, c.contact_phone, c.organization, 'cm-' || c.reference)), lower(v_search)) > 0)
  ), filtered as (
    select v.id, v.last_message_at from visible v
    where p_status is null or v.status = p_status or (p_status = 'active' and v.status <> 'closed')
  )
  select jsonb_build_object(
    'items', (select coalesce(jsonb_agg(private.communication_json(page.id) order by page.last_message_at desc, page.id), '[]'::jsonb)
      from (select f.id, f.last_message_at from filtered f order by f.last_message_at desc, f.id offset p_offset limit p_limit) page),
    'total', (select count(*) from filtered), 'limit', p_limit, 'offset', p_offset,
    'statusCounts', (select coalesce(jsonb_object_agg(grouped.status, grouped.n), '{}'::jsonb)
      from (select v.status, count(*) as n from visible v group by v.status) grouped))
  into v_result;
  return v_result;
end;
$$;

create or replace function hub.get_communication(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_product uuid;
begin
  perform private.require_communication_staff();
  select c.product_id into v_product from private.communications c where c.id = p_id;
  if not found or not private.can_read_communication(v_product) then
    raise exception 'Conversation not found.' using errcode = '42501';
  end if;
  return private.communication_json(p_id) || jsonb_build_object('messages', (
    select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'direction', m.direction, 'body', m.body,
      'authorName', m.author_name, 'delivery', m.delivery, 'deliveryChannel', m.delivery_channel, 'createdAt', m.created_at)
      order by m.created_at, m.id), '[]'::jsonb)
    from private.communication_messages m where m.communication_id = p_id));
end;
$$;

create or replace function hub.update_communication(
  p_id uuid, p_status text, p_inquiry_type text, p_product_id uuid, p_change_product boolean,
  p_assigned_to uuid, p_change_assignment boolean, p_expected_updated_at timestamptz
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_actor uuid := private.require_communication_staff(); c private.communications; v_product uuid; v_changed text[] := '{}';
begin
  select * into c from private.communications where id = p_id for update;
  if not found or not private.has_staff_permission('case.write', c.product_id) then
    raise exception 'Conversation not found.' using errcode = '42501';
  end if;
  if c.updated_at is distinct from p_expected_updated_at then
    raise exception 'This conversation changed. Reload it before saving.' using errcode = '40001';
  end if;
  if (p_status is not null and p_status not in ('new','open','waiting','closed'))
    or (p_inquiry_type is not null and p_inquiry_type not in ('technical_support','customer_service','billing','sales','advisors','unclassified'))
    or p_change_product is null or p_change_assignment is null then
    raise exception 'Invalid conversation update.' using errcode = '22023';
  end if;
  v_product := case when p_change_product then p_product_id else c.product_id end;
  if p_change_product then
    if p_product_id is not null and not exists (select 1 from hub.products p where p.id = p_product_id and p.status <> 'retired') then
      raise exception 'Choose an active application.' using errcode = '22023';
    end if;
    if not private.has_staff_permission('case.write', p_product_id) then
      raise exception 'You do not have access to that application.' using errcode = '42501';
    end if;
    v_changed := array_append(v_changed, 'product');
  end if;
  if p_change_assignment and p_assigned_to is not null and not exists (
    select 1 from private.staff_permissions permission
    join auth.users assignee on assignee.id = permission.user_id
    join hub.profiles assignee_profile on assignee_profile.id = permission.user_id
    where permission.user_id = p_assigned_to and permission.revoked_at is null
      and permission.permission in ('case.read','case.write','platform.admin')
      and (permission.product_id is null or permission.product_id = v_product)
      and assignee.deleted_at is null and (assignee.banned_until is null or assignee.banned_until <= now())
      and not coalesce(assignee.is_anonymous, false)) then
    raise exception 'Assignee is not authorized for this application.' using errcode = '42501';
  end if;
  if p_change_assignment then v_changed := array_append(v_changed, 'assigned_to'); end if;
  if p_status is not null and p_status <> c.status then v_changed := array_append(v_changed, 'status'); end if;
  if p_inquiry_type is not null and p_inquiry_type <> c.inquiry_type then v_changed := array_append(v_changed, 'inquiry_type'); end if;
  update private.communications set
    status = coalesce(p_status, status), inquiry_type = coalesce(p_inquiry_type, inquiry_type), product_id = v_product,
    assigned_to = case when p_change_assignment then p_assigned_to else assigned_to end,
    updated_at = clock_timestamp()
  where id = p_id;
  insert into private.audit_events(actor_id, action, entity_type, entity_id, metadata)
    values (v_actor, 'communication.update', 'communication', p_id, jsonb_build_object('changed', to_jsonb(v_changed)));
  return private.communication_json(p_id);
end;
$$;

create or replace function hub.add_communication_note(p_id uuid, p_body text, p_request_key uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_actor uuid := private.require_communication_staff(); v_product uuid; v_body text := private.communication_body(p_body); v_message uuid;
begin
  select c.product_id into v_product from private.communications c where c.id = p_id for update;
  if not found or not private.has_staff_permission('case.write', v_product) then
    raise exception 'Conversation not found.' using errcode = '42501';
  end if;
  if p_request_key is null or v_body is null or char_length(v_body) > 5000 then
    raise exception 'Write a note of up to 5,000 characters.' using errcode = '22023';
  end if;
  select m.id into v_message from private.communication_messages m where m.communication_id = p_id and m.request_key = p_request_key;
  if v_message is null then
    insert into private.communication_messages(communication_id, direction, body, author_id, author_name, delivery, request_key)
      values (p_id, 'note', v_body, v_actor, (select display_name from hub.profiles where id = v_actor), 'recorded', p_request_key)
      returning id into v_message;
    update private.communications set updated_at = clock_timestamp() where id = p_id;
    insert into private.audit_events(actor_id, action, entity_type, entity_id, metadata)
      values (v_actor, 'communication.note', 'communication', p_id, jsonb_build_object('message_id', v_message));
  end if;
  return hub.get_communication(p_id);
end;
$$;

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
    if existing.direction <> 'outbound' then raise exception 'This request key was already used.' using errcode = '22023'; end if;
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
    'deliveryChannel', v_route, 'to', v_to, 'reference', c.reference, 'subject', c.subject);
end;
$$;

-- Server-only: record the provider outcome of a pending reply exactly once.
create or replace function private.finish_communication_delivery(p_message_id uuid, p_delivery text, p_provider_message_id text) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if p_delivery not in ('sent','failed','unknown') or char_length(p_provider_message_id) > 400 then
    raise exception 'Invalid delivery outcome.' using errcode = '22023';
  end if;
  update private.communication_messages set delivery = p_delivery, provider_message_id = p_provider_message_id
    where id = p_message_id and direction = 'outbound' and delivery = 'pending';
  return found;
end;
$$;

-- Server-only: an authenticated SMS or email webhook delivers one inbound message.
create or replace function private.ingest_inbound_communication(
  p_channel text, p_thread_key text, p_provider_message_id text, p_reference bigint, p_product_slug text,
  p_subject text, p_body text, p_contact_name text, p_contact_email text, p_contact_phone text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
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
$$;

create or replace function private.communication_rate_allowed(p_bucket text, p_client_hash text, p_client_limit integer, p_global_limit integer, p_window interval)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('hub-communication-rate:' || p_bucket, 0));
  delete from private.communication_rate_events where id in (
    select id from private.communication_rate_events where created_at < now() - interval '1 day' limit 500);
  if (select count(*) from private.communication_rate_events e where e.bucket = p_bucket and e.client_hash = p_client_hash and e.created_at > now() - p_window) >= p_client_limit
    or (select count(*) from private.communication_rate_events e where e.bucket = p_bucket and e.created_at > now() - p_window) >= p_global_limit then
    return false;
  end if;
  insert into private.communication_rate_events(bucket, client_hash) values (p_bucket, p_client_hash);
  return true;
end;
$$;

-- Server-only: a website visitor starts a chat. The browser keeps only an opaque token.
create or replace function private.start_chat(p_token_hash text, p_client_hash text, p_name text, p_email text, p_product_slug text, p_body text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_body text := private.communication_body(p_body); v_name text := private.communication_line(p_name, 160);
  v_email text := lower(private.communication_line(p_email, 320)); v_id uuid; v_reference bigint;
begin
  if p_token_hash !~ '^[0-9a-f]{64}$' or p_client_hash !~ '^[0-9a-f]{64}$' or v_name is null or v_body is null or char_length(v_body) > 4000
    or v_email is null or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'Enter your name, email address and question.' using errcode = '22023';
  end if;
  if not private.communication_rate_allowed('chat.start', p_client_hash, 3, 300, interval '1 hour') then
    raise exception 'Too many chats were started. Please wait and try again, or call (877) 521-2890.' using errcode = '53400';
  end if;
  insert into private.communications(channel, source_system, source_key, product_id, subject, contact_name, contact_email, chat_token_hash)
    values ('chat', 'hub.chat', gen_random_uuid()::text, private.communication_product(p_product_slug),
      private.communication_line('Chat: ' || split_part(v_body, E'\n', 1), 200), v_name, v_email, p_token_hash)
    returning id, reference into v_id, v_reference;
  insert into private.communication_messages(communication_id, direction, body, delivery) values (v_id, 'inbound', v_body, 'received');
  return jsonb_build_object('reference', v_reference);
end;
$$;

create or replace function private.read_chat(p_token_hash text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c private.communications;
begin
  select * into c from private.communications where chat_token_hash = p_token_hash and created_at > now() - interval '30 days';
  if not found then raise exception 'Chat not found.' using errcode = '42501'; end if;
  return jsonb_build_object('reference', c.reference, 'status', c.status, 'messages', (
    select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'from', case m.direction when 'inbound' then 'visitor' else 'support' end,
      'body', m.body, 'createdAt', m.created_at) order by m.created_at, m.id), '[]'::jsonb)
    from private.communication_messages m where m.communication_id = c.id and m.direction <> 'note'
      and (m.direction = 'inbound' or m.delivery = 'sent')));
end;
$$;

create or replace function private.post_chat_message(p_token_hash text, p_client_hash text, p_body text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_body text := private.communication_body(p_body); c private.communications;
begin
  if p_client_hash !~ '^[0-9a-f]{64}$' or v_body is null or char_length(v_body) > 4000 then
    raise exception 'Write a message of up to 4,000 characters.' using errcode = '22023';
  end if;
  select * into c from private.communications where chat_token_hash = p_token_hash and created_at > now() - interval '30 days' for update;
  if not found then raise exception 'Chat not found.' using errcode = '42501'; end if;
  if c.status = 'closed' then
    raise exception 'This chat was closed. Start a new chat if you need more help.' using errcode = 'P0001';
  end if;
  if not private.communication_rate_allowed('chat.message', p_client_hash, 30, 2000, interval '10 minutes')
    or (select count(*) from private.communication_messages m where m.communication_id = c.id and m.direction = 'inbound'
      and m.created_at > now() - interval '10 minutes') >= 20 then
    raise exception 'Please wait a moment before sending another message.' using errcode = '53400';
  end if;
  insert into private.communication_messages(communication_id, direction, body, delivery) values (c.id, 'inbound', v_body, 'received');
  update private.communications set status = case when status = 'waiting' then 'open' else status end,
    last_message_at = clock_timestamp(), updated_at = clock_timestamp() where id = c.id;
  return private.read_chat(p_token_hash);
end;
$$;

-- A platform administrator copies messages that other applications received
-- (the Breathe phone line and the Advisors consultation form) into the Hub. Each
-- source message is imported once; staff changes are never overwritten.
create or replace function hub.import_communications(p_source_system text, p_items jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_actor jsonb := hub.authorize_app_admin(); item jsonb; v_key text; v_at timestamptz; v_id uuid;
  v_created integer := 0; v_skipped integer := 0; v_body text;
begin
  if p_source_system not in ('breathe.phone','advisors.web') or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 50 then
    raise exception 'Invalid communication import.' using errcode = '22023';
  end if;
  for item in select value from jsonb_array_elements(p_items) loop
    if jsonb_typeof(item) <> 'object'
      or (select count(*) from jsonb_object_keys(item)) <> 11
      or not item ?& array['sourceKey','receivedAt','status','productSlug','inquiryType','subject','body','contactName','contactEmail','contactPhone','organization']
      or item->>'status' not in ('new','open','closed')
      or exists (select 1 from jsonb_each(item) field where jsonb_typeof(field.value) not in ('string','null'))
      or item->>'inquiryType' not in ('technical_support','customer_service','billing','sales','advisors','unclassified')
      or (p_source_system = 'breathe.phone' and item->>'sourceKey' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
      or (p_source_system = 'advisors.web' and item->>'sourceKey' !~ '^CM-[A-F0-9]{12}$')
      or item->>'receivedAt' is null or char_length(item->>'body') > 4000 then
      raise exception 'Invalid communication import item.' using errcode = '22023';
    end if;
    v_at := (item->>'receivedAt')::timestamptz;
    v_body := private.communication_body(item->>'body');
    if v_at > now() + interval '5 minutes' or v_body is null then
      raise exception 'Invalid communication import item.' using errcode = '22023';
    end if;
    v_key := item->>'sourceKey';
    insert into private.communications(channel, source_system, source_key, status, product_id, inquiry_type, subject,
        contact_name, contact_email, contact_phone, organization, created_at, updated_at, last_message_at)
      values (case p_source_system when 'breathe.phone' then 'phone' else 'web_form' end, p_source_system, v_key, item->>'status',
        private.communication_product(item->>'productSlug'), item->>'inquiryType',
        coalesce(private.communication_line(item->>'subject', 200), 'Message received'),
        private.communication_line(item->>'contactName', 160),
        case when lower(btrim(item->>'contactEmail')) ~ '^[^[:space:]@]+@[^[:space:]@]+$' then lower(private.communication_line(item->>'contactEmail', 320)) end,
        private.communication_line(item->>'contactPhone', 40), private.communication_line(item->>'organization', 200), v_at, now(), v_at)
      on conflict (source_system, source_key) do nothing
      returning id into v_id;
    if v_id is null then v_skipped := v_skipped + 1; continue; end if;
    insert into private.communication_messages(communication_id, direction, body, delivery, provider_message_id, created_at)
      values (v_id, 'inbound', v_body, 'received', p_source_system || ':' || v_key, v_at);
    v_created := v_created + 1;
  end loop;
  insert into private.audit_events(actor_id, action, entity_type, entity_id, metadata)
    values ((v_actor->>'user_id')::uuid, 'communication.import', 'communication_source', null,
      jsonb_build_object('source_system', p_source_system, 'created', v_created, 'skipped', v_skipped));
  return jsonb_build_object('created', v_created, 'skipped', v_skipped);
end;
$$;

revoke all on function private.communication_product(text), private.communication_line(text,integer), private.communication_body(text),
  private.can_read_communication(uuid), private.communication_json(uuid), private.require_communication_staff(),
  private.finish_communication_delivery(uuid,text,text),
  private.ingest_inbound_communication(text,text,text,bigint,text,text,text,text,text,text),
  private.communication_rate_allowed(text,text,integer,integer,interval),
  private.start_chat(text,text,text,text,text,text), private.read_chat(text), private.post_chat_message(text,text,text)
  from public, anon, authenticated;
grant execute on function private.finish_communication_delivery(uuid,text,text),
  private.ingest_inbound_communication(text,text,text,bigint,text,text,text,text,text,text),
  private.start_chat(text,text,text,text,text,text), private.read_chat(text), private.post_chat_message(text,text,text)
  to hub_app_server;
revoke all on function hub.list_communications(text,text,uuid,text,integer,integer), hub.get_communication(uuid),
  hub.update_communication(uuid,text,text,uuid,boolean,uuid,boolean,timestamptz), hub.add_communication_note(uuid,text,uuid),
  hub.begin_communication_reply(uuid,text,uuid,text[]), hub.import_communications(text,jsonb)
  from public, anon;
grant execute on function hub.list_communications(text,text,uuid,text,integer,integer), hub.get_communication(uuid),
  hub.update_communication(uuid,text,text,uuid,boolean,uuid,boolean,timestamptz), hub.add_communication_note(uuid,text,uuid),
  hub.begin_communication_reply(uuid,text,uuid,text[]), hub.import_communications(text,jsonb)
  to authenticated;
