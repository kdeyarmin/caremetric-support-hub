-- Bulk email from the platform administrator to the users of each application,
-- narrowed by role and account status.
--
-- Audience: the Hub server reads each chosen application's user directory
-- (users.list) page by page inside the administrator's own session and records
-- the rows here. Each application decides its users' roles and statuses; the
-- Hub groups by the values it is given and never invents them.
--
-- Sending: queuing turns the selected members into one recipient per email
-- address (duplicates across applications and unsubscribed addresses are left
-- out) and deletes the audience copy. The Hub server role then delivers each
-- message once through SendGrid and records the outcome. An address and its
-- unsubscribe token are kept only until that outcome is recorded; afterwards
-- only a SHA-256 hash of the address remains, for history and unsubscribe.
-- An uncertain delivery is recorded as unknown and never sent again.
--
-- Every message carries a one-click unsubscribe link. Unsubscribing suppresses
-- the address for all future bulk email from the Hub.
--
-- No browser role reaches these tables. Administrator functions recheck the
-- current administrator session; queuing a send needs the command session.

create table private.email_campaigns (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'loading' check (status in ('loading', 'ready', 'sending', 'sent', 'cancelled')),
  subject text not null default '' check (char_length(subject) <= 150 and subject !~ '[[:cntrl:]]'),
  body text not null default '' check (char_length(body) <= 20000),
  recipient_count integer not null default 0 check (recipient_count between 0 and 25000),
  version integer not null default 1 check (version > 0),
  created_by uuid references auth.users(id) on delete set null,
  queued_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  queued_at timestamptz,
  completed_at timestamptz,
  check (status not in ('sending', 'sent') or queued_at is not null),
  check ((status in ('sent', 'cancelled')) = (completed_at is not null))
);
create index email_campaigns_recent on private.email_campaigns(created_at desc);
create index email_campaigns_created_by on private.email_campaigns(created_by);
create index email_campaigns_queued_by on private.email_campaigns(queued_by);

-- One row per application in a campaign: how far its directory has been read,
-- and which roles and statuses the administrator selected.
create table private.email_campaign_sources (
  campaign_id uuid not null references private.email_campaigns(id) on delete cascade,
  product_id uuid not null references hub.products(id) on delete restrict,
  directory text not null check (directory in ('carebase', 'breathe', 'caremetric-emr', 'pennsync', 'intel', 'caremetric-go')),
  total integer check (total between 0 and 10000000),
  next_offset integer not null default 0 check (next_offset between 0 and 10050),
  loaded_at timestamptz,
  roles text[] not null default '{}',
  statuses text[] not null default '{}',
  primary key (campaign_id, product_id)
);
create index email_campaign_sources_product on private.email_campaign_sources(product_id);

-- The audience copy of each directory row. Deleted when the campaign is queued
-- or cancelled, and for drafts left untouched for a day.
create table private.email_audience_members (
  campaign_id uuid not null,
  product_id uuid not null,
  user_ref text not null check (char_length(user_ref) between 1 and 128),
  email text check (email is null or (char_length(email) <= 320 and email ~ '^[^[:space:]@<>"]+@[^[:space:]@<>"]+\.[^[:space:]@<>"]+$')),
  role text not null check (char_length(role) between 1 and 100),
  status text not null check (char_length(status) between 1 and 100),
  primary key (campaign_id, product_id, user_ref),
  foreign key (campaign_id, product_id) references private.email_campaign_sources(campaign_id, product_id) on delete cascade
);

create table private.email_recipients (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references private.email_campaigns(id) on delete cascade,
  email_hash text not null check (email_hash ~ '^[0-9a-f]{64}$'),
  email text check (email is null or char_length(email) <= 320),
  unsubscribe_token text check (unsubscribe_token is null or unsubscribe_token ~ '^[0-9a-f]{64}$'),
  unsubscribe_hash text not null unique check (unsubscribe_hash ~ '^[0-9a-f]{64}$'),
  applications text not null check (char_length(applications) between 1 and 1000),
  status text not null default 'queued' check (status in ('queued', 'sending', 'sent', 'failed', 'unknown', 'cancelled')),
  provider_message_id text check (char_length(provider_message_id) <= 200),
  claimed_at timestamptz,
  finished_at timestamptz,
  unique (campaign_id, email_hash),
  -- The address and token exist only while delivery is outstanding.
  check (case when status in ('queued', 'sending') then email is not null and unsubscribe_token is not null
    else email is null and unsubscribe_token is null end),
  check (status <> 'sending' or (claimed_at is not null and finished_at is null))
);
create index email_recipients_outstanding on private.email_recipients(campaign_id, status) where status in ('queued', 'sending');

create table private.email_suppressions (
  email_hash text primary key check (email_hash ~ '^[0-9a-f]{64}$'),
  reason text not null default 'unsubscribed' check (reason = 'unsubscribed'),
  campaign_id uuid references private.email_campaigns(id) on delete set null,
  created_at timestamptz not null default now()
);
create index email_suppressions_campaign on private.email_suppressions(campaign_id);

alter table private.email_campaigns enable row level security;
alter table private.email_campaign_sources enable row level security;
alter table private.email_audience_members enable row level security;
alter table private.email_recipients enable row level security;
alter table private.email_suppressions enable row level security;
revoke all on private.email_campaigns, private.email_campaign_sources, private.email_audience_members,
  private.email_recipients, private.email_suppressions from public, anon, authenticated, service_role, hub_app_server;
comment on table private.email_recipients is
  'Bulk email deliveries. Addresses and unsubscribe tokens are cleared once the outcome is recorded; only a SHA-256 hash remains.';

create function private.email_hash(p_email text) returns text
language sql immutable set search_path = '' as $$
  select encode(extensions.digest(lower(btrim(p_email)), 'sha256'), 'hex');
$$;

-- Statuses that read as switched off. They start unselected; the administrator
-- can still include them.
create function private.email_inactive_status(p_status text) returns boolean
language sql immutable set search_path = '' as $$
  select lower(p_status) ~ '(disabled|inactive|suspend|deactivat|banned|revoked|deleted|archiv|closed|locked|blocked|removed|expired|terminated)';
$$;

create function private.require_email_campaign(p_campaign_id uuid, p_statuses text[]) returns private.email_campaigns
language plpgsql set search_path = '' as $$
declare campaign private.email_campaigns;
begin
  select * into campaign from private.email_campaigns where id = p_campaign_id for update;
  if not found then raise exception 'Email not found.' using errcode = '22023'; end if;
  if not (campaign.status = any(p_statuses)) then
    raise exception 'This email is % and can no longer be changed that way. Refresh to see it.',
      case campaign.status when 'loading' then 'still loading its audience' when 'ready' then 'a draft' when 'sending' then 'sending'
        when 'sent' then 'already sent' else 'cancelled' end using errcode = 'P0001';
  end if;
  return campaign;
end;
$$;

-- The campaign as the administrator sees it: message, per-application reading
-- progress, role and status breakdowns, the audience the current selection
-- reaches, and delivery counts.
create function private.email_campaign_json(p_campaign_id uuid) returns jsonb
language sql stable set search_path = '' as $$
  with campaign as (select * from private.email_campaigns where id = p_campaign_id),
  selected as (
    select m.email, m.product_id from private.email_audience_members m
    join private.email_campaign_sources s on s.campaign_id = m.campaign_id and s.product_id = m.product_id
    where m.campaign_id = p_campaign_id and m.role = any(s.roles) and m.status = any(s.statuses)
  ), addresses as (
    select private.email_hash(email) as email_hash from selected where email is not null group by 1
  )
  select jsonb_build_object(
    'id', c.id, 'status', c.status, 'subject', c.subject, 'body', c.body, 'version', c.version,
    'createdAt', c.created_at, 'updatedAt', c.updated_at, 'queuedAt', c.queued_at, 'completedAt', c.completed_at,
    'recipientCount', c.recipient_count,
    'sources', (select coalesce(jsonb_agg(jsonb_build_object(
        'productId', s.product_id, 'productName', p.name, 'productSlug', p.slug,
        'total', s.total, 'read', (select count(*) from private.email_audience_members m where m.campaign_id = s.campaign_id and m.product_id = s.product_id),
        'nextOffset', s.next_offset, 'loaded', s.loaded_at is not null,
        'truncated', s.loaded_at is not null and s.total is not null and s.next_offset < s.total,
        'roles', to_jsonb(s.roles), 'statuses', to_jsonb(s.statuses),
        'roleCounts', (select coalesce(jsonb_agg(jsonb_build_object('value', role, 'users', users, 'withEmail', with_email) order by users desc, role), '[]'::jsonb)
          from (select m.role, count(*) as users, count(m.email) as with_email from private.email_audience_members m
            where m.campaign_id = s.campaign_id and m.product_id = s.product_id group by m.role) r),
        'statusCounts', (select coalesce(jsonb_agg(jsonb_build_object('value', status, 'users', users, 'withEmail', with_email) order by users desc, status), '[]'::jsonb)
          from (select m.status, count(*) as users, count(m.email) as with_email from private.email_audience_members m
            where m.campaign_id = s.campaign_id and m.product_id = s.product_id group by m.status) st)
      ) order by p.name), '[]'::jsonb)
      from private.email_campaign_sources s join hub.products p on p.id = s.product_id where s.campaign_id = c.id),
    'audience', case when c.status in ('loading', 'ready') then jsonb_build_object(
        'selectedUsers', (select count(*) from selected),
        'withoutEmail', (select count(*) from selected where email is null),
        'unsubscribed', (select count(*) from addresses a join private.email_suppressions x on x.email_hash = a.email_hash),
        'recipients', (select count(*) from addresses a where not exists (select 1 from private.email_suppressions x where x.email_hash = a.email_hash)))
      else null end,
    'delivery', (select jsonb_build_object(
        'queued', count(*) filter (where status = 'queued'), 'sending', count(*) filter (where status = 'sending'),
        'sent', count(*) filter (where status = 'sent'), 'failed', count(*) filter (where status = 'failed'),
        'unknown', count(*) filter (where status = 'unknown'), 'cancelled', count(*) filter (where status = 'cancelled'))
      from private.email_recipients where campaign_id = c.id),
    'unsubscribed', (select count(*) from private.email_suppressions where campaign_id = c.id)
  ) from campaign c;
$$;

-- Starts an email to the users of one or more applications. The directories
-- are read next, page by page, through the administrator's session.
create function hub.create_email_campaign(p_product_ids uuid[]) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare actor jsonb := hub.authorize_app_admin(); v_id uuid; v_count integer;
begin
  if p_product_ids is null or cardinality(p_product_ids) not between 1 and 6
    or (select count(distinct id) from unnest(p_product_ids) id) <> cardinality(p_product_ids) then
    raise exception 'Choose up to six applications, each once.' using errcode = '22023';
  end if;
  select count(*) into v_count from hub.products where id = any(p_product_ids) and status <> 'retired'
    and slug in ('carebase', 'breathe', 'caremetric-emr', 'pennsync', 'caremetric-intel', 'caremetric-go');
  if v_count <> cardinality(p_product_ids) then
    raise exception 'Choose applications that have a user directory.' using errcode = '22023';
  end if;
  insert into private.email_campaigns(created_by) values ((actor->>'user_id')::uuid) returning id into v_id;
  insert into private.email_campaign_sources(campaign_id, product_id, directory)
    select v_id, id, case slug when 'caremetric-intel' then 'intel' else slug end from hub.products where id = any(p_product_ids);
  insert into private.audit_events(actor_id, action, entity_type, entity_id, metadata)
    values ((actor->>'user_id')::uuid, 'email_campaign.create', 'email_campaign', v_id, jsonb_build_object('applications', cardinality(p_product_ids)));
  return private.email_campaign_json(v_id);
end;
$$;

-- The next directory page to read, or null once the audience is no longer loading.
create function hub.next_email_audience_page(p_campaign_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare source private.email_campaign_sources;
begin
  perform hub.authorize_app_admin();
  if (private.require_email_campaign(p_campaign_id, array['loading', 'ready', 'sending', 'sent', 'cancelled'])).status <> 'loading' then return null; end if;
  select * into source from private.email_campaign_sources where campaign_id = p_campaign_id and loaded_at is null
    order by directory limit 1;
  if not found then return null; end if;
  return jsonb_build_object('productId', source.product_id, 'directory', source.directory, 'offset', source.next_offset);
end;
$$;

-- Records one page of an application's users.list response. Pages must arrive
-- in order; a user seen twice keeps the first row. When every application is
-- read, all roles and the statuses that do not read as switched off start
-- selected and the campaign becomes a draft.
create function hub.add_email_audience_page(p_campaign_id uuid, p_product_id uuid, p_offset integer, p_total integer, p_items jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare source private.email_campaign_sources; item jsonb; v_count integer; v_email text; v_done boolean; v_remaining integer;
begin
  perform hub.authorize_app_admin();
  perform private.require_email_campaign(p_campaign_id, array['loading']);
  select * into source from private.email_campaign_sources where campaign_id = p_campaign_id and product_id = p_product_id for update;
  if not found or source.loaded_at is not null or source.next_offset is distinct from p_offset then
    raise exception 'The audience changed while it was loading. Refresh and try again.' using errcode = 'P0001';
  end if;
  if p_total is null or p_total < 0 or p_total > 10000000 or p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 50 then
    raise exception 'Invalid directory page.' using errcode = '22023';
  end if;
  v_count := jsonb_array_length(p_items);
  for item in select value from jsonb_array_elements(p_items) loop
    if jsonb_typeof(item) <> 'object' or (select count(*) from jsonb_object_keys(item)) <> 4 or not item ?& array['id', 'email', 'role', 'status']
      or jsonb_typeof(item->'id') <> 'string' or jsonb_typeof(item->'role') <> 'string' or jsonb_typeof(item->'status') <> 'string'
      or jsonb_typeof(item->'email') not in ('string', 'null')
      or char_length(item->>'id') not between 1 and 128 or char_length(item->>'role') not between 1 and 100 or char_length(item->>'status') not between 1 and 100
      or char_length(coalesce(item->>'email', '')) > 500 then
      raise exception 'Invalid directory page.' using errcode = '22023';
    end if;
    -- An address that does not look deliverable counts as no email.
    v_email := lower(btrim(item->>'email'));
    if v_email is not null and (char_length(v_email) > 320 or v_email !~ '^[^[:space:]@<>"]+@[^[:space:]@<>"]+\.[^[:space:]@<>"]+$') then v_email := null; end if;
    insert into private.email_audience_members(campaign_id, product_id, user_ref, email, role, status)
      values (p_campaign_id, p_product_id, item->>'id', v_email, item->>'role', item->>'status') on conflict do nothing;
  end loop;
  -- users.list reaches offsets up to 10,000 with pages of 50.
  v_done := v_count < 50 or p_offset + v_count >= p_total or p_offset + v_count > 10000;
  update private.email_campaign_sources set next_offset = p_offset + v_count, total = p_total,
    loaded_at = case when v_done then now() else null end
    where campaign_id = p_campaign_id and product_id = p_product_id;
  select count(*) into v_remaining from private.email_campaign_sources where campaign_id = p_campaign_id and loaded_at is null;
  if v_remaining = 0 then
    update private.email_campaign_sources s set
      roles = coalesce((select array_agg(distinct m.role order by m.role) from private.email_audience_members m
        where m.campaign_id = s.campaign_id and m.product_id = s.product_id), '{}'),
      statuses = coalesce((select array_agg(distinct m.status order by m.status) from private.email_audience_members m
        where m.campaign_id = s.campaign_id and m.product_id = s.product_id and not private.email_inactive_status(m.status)), '{}')
      where s.campaign_id = p_campaign_id;
    update private.email_campaigns set status = 'ready', version = version + 1, updated_at = clock_timestamp() where id = p_campaign_id;
  else
    update private.email_campaigns set updated_at = clock_timestamp() where id = p_campaign_id;
  end if;
  return jsonb_build_object('loaded', v_remaining = 0, 'productLoaded', v_done, 'read', p_offset + v_count);
end;
$$;

create function hub.get_email_campaign(p_campaign_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare result jsonb;
begin
  perform hub.authorize_app_admin();
  result := private.email_campaign_json(p_campaign_id);
  if result is null then raise exception 'Email not found.' using errcode = '22023'; end if;
  return result;
end;
$$;

create function hub.list_email_campaigns() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform hub.authorize_app_admin();
  return jsonb_build_object('campaigns', (select coalesce(jsonb_agg(jsonb_build_object(
      'id', c.id, 'status', c.status, 'subject', c.subject, 'recipientCount', c.recipient_count,
      'createdAt', c.created_at, 'queuedAt', c.queued_at, 'completedAt', c.completed_at,
      'applications', (select coalesce(jsonb_agg(p.name order by p.name), '[]'::jsonb) from private.email_campaign_sources s join hub.products p on p.id = s.product_id where s.campaign_id = c.id),
      'delivery', (select jsonb_build_object('outstanding', count(*) filter (where status in ('queued', 'sending')), 'sent', count(*) filter (where status = 'sent'),
          'failed', count(*) filter (where status = 'failed'), 'unknown', count(*) filter (where status = 'unknown'), 'cancelled', count(*) filter (where status = 'cancelled'))
        from private.email_recipients r where r.campaign_id = c.id),
      'unsubscribed', (select count(*) from private.email_suppressions x where x.campaign_id = c.id)
    ) order by c.created_at desc), '[]'::jsonb) from (select * from private.email_campaigns order by created_at desc limit 50) c),
    'loadedAt', now());
end;
$$;

-- Saves the message and, per application, the roles and statuses to include.
-- Only values present in that application's directory can be chosen.
create function hub.save_email_campaign(p_campaign_id uuid, p_subject text, p_body text, p_selection jsonb, p_expected_version integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare campaign private.email_campaigns; source private.email_campaign_sources; choice jsonb; v_roles text[]; v_statuses text[];
begin
  perform hub.authorize_app_admin();
  campaign := private.require_email_campaign(p_campaign_id, array['ready']);
  if campaign.version is distinct from p_expected_version then
    raise exception 'This email changed in another window. Refresh before saving.' using errcode = 'P0001';
  end if;
  if p_subject is null or char_length(p_subject) > 150 or p_subject ~ '[[:cntrl:]]' then
    raise exception 'Write a subject of up to 150 characters on one line.' using errcode = '22023';
  end if;
  if p_body is null or char_length(p_body) > 20000 or p_body ~ '[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]' then
    raise exception 'Write a message of up to 20,000 characters.' using errcode = '22023';
  end if;
  if p_selection is null or jsonb_typeof(p_selection) <> 'object'
    or (select count(*) from jsonb_object_keys(p_selection)) <> (select count(*) from private.email_campaign_sources where campaign_id = p_campaign_id) then
    raise exception 'Choose roles and statuses for every application.' using errcode = '22023';
  end if;
  for source in select * from private.email_campaign_sources where campaign_id = p_campaign_id for update loop
    choice := p_selection->(source.product_id::text);
    if choice is null or jsonb_typeof(choice) <> 'object' or (select count(*) from jsonb_object_keys(choice)) <> 2
      or jsonb_typeof(choice->'roles') <> 'array' or jsonb_typeof(choice->'statuses') <> 'array'
      or exists (select 1 from jsonb_array_elements(choice->'roles') v where jsonb_typeof(v) <> 'string')
      or exists (select 1 from jsonb_array_elements(choice->'statuses') v where jsonb_typeof(v) <> 'string') then
      raise exception 'Choose roles and statuses for every application.' using errcode = '22023';
    end if;
    select coalesce(array_agg(distinct v order by v), '{}') into v_roles from jsonb_array_elements_text(choice->'roles') v;
    select coalesce(array_agg(distinct v order by v), '{}') into v_statuses from jsonb_array_elements_text(choice->'statuses') v;
    if exists (select 1 from unnest(v_roles) r where not exists (select 1 from private.email_audience_members m where m.campaign_id = p_campaign_id and m.product_id = source.product_id and m.role = r))
      or exists (select 1 from unnest(v_statuses) st where not exists (select 1 from private.email_audience_members m where m.campaign_id = p_campaign_id and m.product_id = source.product_id and m.status = st)) then
      raise exception 'Choose roles and statuses from the loaded directory.' using errcode = '22023';
    end if;
    update private.email_campaign_sources set roles = v_roles, statuses = v_statuses where campaign_id = p_campaign_id and product_id = source.product_id;
  end loop;
  update private.email_campaigns set subject = btrim(p_subject), body = p_body, version = version + 1, updated_at = clock_timestamp() where id = p_campaign_id;
  return private.email_campaign_json(p_campaign_id);
end;
$$;

-- Confirms the send. The administrator states the recipient count they
-- reviewed; a different count means the selection changed and nothing is sent.
create function hub.queue_email_campaign(p_campaign_id uuid, p_expected_version integer, p_expected_recipients integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare actor jsonb := hub.authorize_app_command(); campaign private.email_campaigns; v_count integer;
begin
  campaign := private.require_email_campaign(p_campaign_id, array['ready']);
  if campaign.version is distinct from p_expected_version then
    raise exception 'This email changed in another window. Refresh and review it before sending.' using errcode = 'P0001';
  end if;
  if btrim(campaign.subject) = '' or btrim(campaign.body) = '' then
    raise exception 'Write a subject and a message before sending.' using errcode = '22023';
  end if;
  -- One recipient per address; each gets its own unsubscribe token. Any check
  -- below that fails rolls these rows back.
  insert into private.email_recipients(campaign_id, email_hash, email, unsubscribe_token, unsubscribe_hash, applications)
    select p_campaign_id, r.email_hash, r.email, r.token, encode(extensions.digest(r.token, 'sha256'), 'hex'), r.applications
    from (
      select private.email_hash(m.email) as email_hash, min(m.email) as email, string_agg(distinct p.name, ', ' order by p.name) as applications,
        encode(extensions.gen_random_bytes(32), 'hex') as token
      from private.email_audience_members m
      join private.email_campaign_sources s on s.campaign_id = m.campaign_id and s.product_id = m.product_id
      join hub.products p on p.id = m.product_id
      where m.campaign_id = p_campaign_id and m.email is not null and m.role = any(s.roles) and m.status = any(s.statuses)
      group by 1
    ) r where not exists (select 1 from private.email_suppressions x where x.email_hash = r.email_hash);
  get diagnostics v_count = row_count;
  if v_count = 0 then raise exception 'No one with an email address matches the selected roles and statuses.' using errcode = 'P0001'; end if;
  if v_count is distinct from p_expected_recipients then
    raise exception 'The audience is now % recipients. Review it again before sending.', v_count using errcode = 'P0001';
  end if;
  if v_count > 25000 then raise exception 'Send to at most 25,000 recipients at a time.' using errcode = 'P0001'; end if;
  -- The audience copy is no longer needed once recipients exist.
  delete from private.email_audience_members where campaign_id = p_campaign_id;
  update private.email_campaigns set status = 'sending', recipient_count = v_count, queued_at = clock_timestamp(),
    queued_by = (actor->>'user_id')::uuid, version = version + 1, updated_at = clock_timestamp() where id = p_campaign_id;
  insert into private.audit_events(actor_id, action, entity_type, entity_id, metadata)
    values ((actor->>'user_id')::uuid, 'email_campaign.queue', 'email_campaign', p_campaign_id,
      jsonb_build_object('recipients', v_count, 'applications', (select count(*) from private.email_campaign_sources where campaign_id = p_campaign_id)));
  return private.email_campaign_json(p_campaign_id);
end;
$$;

-- Stops an email. A draft's audience is deleted; while sending, every message
-- not yet handed to SendGrid is cancelled. Messages already in flight finish.
create function hub.cancel_email_campaign(p_campaign_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare actor jsonb := hub.authorize_app_admin(); campaign private.email_campaigns; v_cancelled integer;
begin
  campaign := private.require_email_campaign(p_campaign_id, array['loading', 'ready', 'sending']);
  delete from private.email_audience_members where campaign_id = p_campaign_id;
  update private.email_recipients set status = 'cancelled', email = null, unsubscribe_token = null, finished_at = clock_timestamp()
    where campaign_id = p_campaign_id and status = 'queued';
  get diagnostics v_cancelled = row_count;
  update private.email_campaigns set status = 'cancelled', completed_at = clock_timestamp(), version = version + 1, updated_at = clock_timestamp()
    where id = p_campaign_id;
  insert into private.audit_events(actor_id, action, entity_type, entity_id, metadata)
    values ((actor->>'user_id')::uuid, 'email_campaign.cancel', 'email_campaign', p_campaign_id,
      jsonb_build_object('from_status', campaign.status, 'cancelled_recipients', v_cancelled));
  return private.email_campaign_json(p_campaign_id);
end;
$$;

-- A test copy goes only to the address the administrator types. It needs the
-- command session, is audited without the address, and records no recipient.
create function hub.authorize_email_test(p_campaign_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare actor jsonb := hub.authorize_app_command(); campaign private.email_campaigns;
begin
  campaign := private.require_email_campaign(p_campaign_id, array['ready']);
  if btrim(campaign.subject) = '' or btrim(campaign.body) = '' then
    raise exception 'Save a subject and a message before sending a test.' using errcode = '22023';
  end if;
  insert into private.audit_events(actor_id, action, entity_type, entity_id, metadata)
    values ((actor->>'user_id')::uuid, 'email_campaign.test', 'email_campaign', p_campaign_id, jsonb_build_object('version', campaign.version));
  return jsonb_build_object('subject', campaign.subject, 'body', campaign.body,
    'applications', (select string_agg(p.name, ', ' order by p.name) from private.email_campaign_sources s join hub.products p on p.id = s.product_id where s.campaign_id = p_campaign_id));
end;
$$;

-- Server only, every minute whether or not email is configured: a claim older
-- than ten minutes is recorded as unknown (never resent), drafts untouched for
-- a day are cancelled and their audience deleted, and campaigns with nothing
-- outstanding are marked sent.
create function private.email_housekeeping() returns void
language plpgsql security definer set search_path = '' as $$
begin
  if session_user <> 'hub_app_server' then raise exception 'Application server required.' using errcode = '42501'; end if;
  update private.email_recipients set status = 'unknown', email = null, unsubscribe_token = null, finished_at = clock_timestamp()
    where status = 'sending' and claimed_at < now() - interval '10 minutes';
  with stale as (
    update private.email_campaigns set status = 'cancelled', completed_at = clock_timestamp(), updated_at = clock_timestamp()
      where status in ('loading', 'ready') and updated_at < now() - interval '1 day' returning id
  ) delete from private.email_audience_members m using stale where m.campaign_id = stale.id;
  update private.email_campaigns c set status = 'sent', completed_at = clock_timestamp(), updated_at = clock_timestamp()
    where c.status = 'sending' and not exists (select 1 from private.email_recipients r where r.campaign_id = c.id and r.status in ('queued', 'sending'));
end;
$$;

-- Server only: claims up to p_limit queued messages to send.
create function private.claim_email_batch(p_limit integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare result jsonb;
begin
  if session_user <> 'hub_app_server' then raise exception 'Application server required.' using errcode = '42501'; end if;
  if p_limit is null or p_limit not between 1 and 100 then raise exception 'Invalid batch size.' using errcode = '22023'; end if;
  with claimed as (
    update private.email_recipients r set status = 'sending', claimed_at = clock_timestamp()
    where r.id in (
      select r2.id from private.email_recipients r2 join private.email_campaigns c on c.id = r2.campaign_id
      where r2.status = 'queued' and c.status = 'sending' order by c.queued_at, r2.id limit p_limit for update of r2 skip locked)
    returning r.id, r.campaign_id, r.email, r.unsubscribe_token, r.applications
  ) select coalesce(jsonb_agg(jsonb_build_object('id', claimed.id, 'to', claimed.email, 'token', claimed.unsubscribe_token,
      'applications', claimed.applications, 'subject', c.subject, 'body', c.body)), '[]'::jsonb) into result
    from claimed join private.email_campaigns c on c.id = claimed.campaign_id;
  return result;
end;
$$;

-- Server only: records SendGrid's answer for one claimed message, then clears
-- the address and token.
create function private.finish_email_delivery(p_recipient_id uuid, p_delivery text, p_provider_message_id text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_campaign uuid;
begin
  if session_user <> 'hub_app_server' then raise exception 'Application server required.' using errcode = '42501'; end if;
  if p_delivery is null or p_delivery not in ('sent', 'failed', 'unknown') or char_length(p_provider_message_id) > 200 then
    raise exception 'Invalid delivery outcome.' using errcode = '22023';
  end if;
  update private.email_recipients set status = p_delivery, provider_message_id = p_provider_message_id, email = null, unsubscribe_token = null,
    finished_at = clock_timestamp() where id = p_recipient_id and status = 'sending' returning campaign_id into v_campaign;
  if v_campaign is null then return false; end if;
  -- Concurrent finishes take turns here, so the last one sees every other
  -- message finished and marks the campaign sent.
  perform 1 from private.email_campaigns where id = v_campaign for update;
  update private.email_campaigns c set status = 'sent', completed_at = clock_timestamp(), updated_at = clock_timestamp()
    where c.id = v_campaign and c.status = 'sending'
      and not exists (select 1 from private.email_recipients r where r.campaign_id = c.id and r.status in ('queued', 'sending'));
  return true;
end;
$$;

-- Server only: the unsubscribe page. Looking a link up changes nothing; only
-- confirming it suppresses the address for every future bulk email.
create function private.email_unsubscribe(p_token_hash text, p_confirm boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare recipient private.email_recipients; v_added integer;
begin
  if session_user <> 'hub_app_server' then raise exception 'Application server required.' using errcode = '42501'; end if;
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then return jsonb_build_object('valid', false); end if;
  select * into recipient from private.email_recipients where unsubscribe_hash = p_token_hash;
  if not found then return jsonb_build_object('valid', false); end if;
  if p_confirm then
    insert into private.email_suppressions(email_hash, campaign_id) values (recipient.email_hash, recipient.campaign_id) on conflict do nothing;
    get diagnostics v_added = row_count;
    if v_added > 0 then
      insert into private.audit_events(actor_id, action, entity_type, entity_id, metadata)
        values (null, 'email_campaign.unsubscribe', 'email_campaign', recipient.campaign_id, '{}'::jsonb);
    end if;
  end if;
  return jsonb_build_object('valid', true, 'unsubscribed', exists (select 1 from private.email_suppressions where email_hash = recipient.email_hash));
end;
$$;

revoke all on function private.email_hash(text), private.email_inactive_status(text), private.require_email_campaign(uuid, text[]),
  private.email_campaign_json(uuid), private.email_housekeeping(), private.claim_email_batch(integer), private.finish_email_delivery(uuid, text, text),
  private.email_unsubscribe(text, boolean) from public, anon, authenticated, service_role, hub_app_server;
grant execute on function private.email_housekeeping(), private.claim_email_batch(integer), private.finish_email_delivery(uuid, text, text),
  private.email_unsubscribe(text, boolean) to hub_app_server;

revoke all on function hub.create_email_campaign(uuid[]), hub.next_email_audience_page(uuid), hub.add_email_audience_page(uuid, uuid, integer, integer, jsonb),
  hub.get_email_campaign(uuid), hub.list_email_campaigns(), hub.save_email_campaign(uuid, text, text, jsonb, integer),
  hub.queue_email_campaign(uuid, integer, integer), hub.cancel_email_campaign(uuid), hub.authorize_email_test(uuid) from public, anon;
grant execute on function hub.create_email_campaign(uuid[]), hub.next_email_audience_page(uuid), hub.add_email_audience_page(uuid, uuid, integer, integer, jsonb),
  hub.get_email_campaign(uuid), hub.list_email_campaigns(), hub.save_email_campaign(uuid, text, text, jsonb, integer),
  hub.queue_email_campaign(uuid, integer, integer), hub.cancel_email_campaign(uuid), hub.authorize_email_test(uuid) to authenticated;
