-- The lead desk: every public form in CareBase, Intel and Healthcare Advisors forwards each lead, server to server,
-- to the Hub (docs/LEAD_INTAKE.md, "CareMetric lead intake, version 1"). The Hub keeps one row per lead, opens a
-- conversation in Communications when the person asked to be contacted, and the owner works the leads on the Leads
-- screen. A later change lets the AI team alert the owner and report from the same table.
--
-- Boundary (the closed shape of the AI team control plane and unified communications):
--   * private.leads has row level security and no privilege for any browser, service or server role;
--   * the Hub server (hub_app_server) records a lead only through private.lead_intake, which refuses every other
--     session user. The work itself is private.lead_record, which no role may execute directly; it is separate
--     so the database tests can exercise it without the Hub server's login;
--   * the owner reads and changes leads through hub.* operations that authorize the current SMS administrator
--     session themselves (authorize_app_admin to read, authorize_app_command to change a status);
--   * the visitor's free-text message may contain PHI. It is stored only as the conversation's inbound message,
--     never on the lead, in audit metadata or in an error. Lead rows hold contact details and short facts only;
--   * retention: a lead is deleted twelve months after the Hub received it, and a website conversation twelve months
--     after its last message, by private.lead_retention (the Hub server role only, from its periodic cleanup).
--     Conversations from every other channel are never touched by it.

set local lock_timeout = '10s';

-- 1. CareBase and Intel website conversations. Healthcare Advisors keeps advisors.web, the key its manual import
-- already uses, so a consultation that arrives both ways is one conversation. The chat check is not touched.
alter table private.communications
  drop constraint communications_source_system_check,
  add constraint communications_source_system_check
    check (source_system in ('hub.sms','hub.email','hub.chat','breathe.phone','advisors.web','carebase.web','intel.web'));

-- 2. One row per lead, keyed by the product's own id.
create table private.leads (
  id uuid primary key default gen_random_uuid(),
  source text not null check (source in ('carebase','intel','advisors')),
  kind text not null check (kind in ('demo_request','consultation','contact','trial_signup','newsletter','savings_model','county_report')),
  external_id text not null check (external_id ~ '^[A-Za-z0-9._:-]{1,100}$'),
  -- A probe from the AI team's end-to-end form check. Test leads never open a conversation, alert or count.
  test boolean not null default false,
  occurred_at timestamptz not null,
  received_at timestamptz not null default now(),
  contact_name text check (char_length(contact_name) between 1 and 200 and contact_name !~ '[[:cntrl:]]'),
  contact_email text not null check (char_length(contact_email) between 3 and 320 and contact_email = lower(contact_email)
    and contact_email ~ '^[^[:space:][:cntrl:]@]+@[^[:space:][:cntrl:]@]+\.[^[:space:][:cntrl:]@]+$'),
  contact_phone text check (char_length(contact_phone) between 1 and 40 and contact_phone !~ '[[:cntrl:]]'),
  organization text check (char_length(organization) between 1 and 200 and organization !~ '[[:cntrl:]]'),
  role text check (char_length(role) between 1 and 100 and role !~ '[[:cntrl:]]'),
  -- Facts only (facility count, plan, state, county, service, beds): at most 12 flat entries, checked on intake.
  details jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object' and pg_column_size(details) <= 16384),
  utm_source text check (char_length(utm_source) between 1 and 200 and utm_source !~ '[[:cntrl:]]'),
  utm_medium text check (char_length(utm_medium) between 1 and 200 and utm_medium !~ '[[:cntrl:]]'),
  utm_campaign text check (char_length(utm_campaign) between 1 and 200 and utm_campaign !~ '[[:cntrl:]]'),
  utm_term text check (char_length(utm_term) between 1 and 200 and utm_term !~ '[[:cntrl:]]'),
  utm_content text check (char_length(utm_content) between 1 and 200 and utm_content !~ '[[:cntrl:]]'),
  referrer_host text check (char_length(referrer_host) between 1 and 200 and referrer_host ~ '^[a-z0-9._-]+$'),
  landing_path text check (char_length(landing_path) between 1 and 300 and landing_path ~ '^/[^?#[:space:][:cntrl:]]*$'),
  first_seen_at timestamptz,
  product_id uuid references hub.products(id) on delete restrict,
  communication_id uuid references private.communications(id) on delete set null,
  status text not null default 'new' check (status in ('new','contacted','qualified','won','lost','spam')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source, external_id),
  -- Advisors forwards its inquiry reference, the key its manual import uses; its probes use probe-<timestamp>.
  check (source <> 'advisors' or test or external_id ~ '^CM-[A-F0-9]{12}$')
);
create index leads_recent on private.leads (received_at desc, id);
create index leads_kind on private.leads (kind, received_at desc);
create index leads_communication on private.leads (communication_id) where communication_id is not null;

alter table private.leads enable row level security;
revoke all on private.leads from public, anon, authenticated, service_role, hub_app_server;
comment on table private.leads is
  'One row per website lead from CareBase, Intel or Healthcare Advisors. Contact details and short facts only; the visitor''s message lives only in the linked conversation. Reached only through reviewed functions.';

-- ---------------------------------------------------------------------------------------
-- Internal helpers. No role executes these directly; the operations below call them.
-- ---------------------------------------------------------------------------------------

-- An optional single-line field: absent or JSON null is null; a string within the limit is trimmed, with control
-- characters turned into spaces; anything else is an invalid lead.
create function private.lead_text(p_value jsonb, p_max integer) returns text
language plpgsql immutable set search_path = '' as $$
begin
  if p_value is null or jsonb_typeof(p_value) = 'null' then
    return null;
  end if;
  if jsonb_typeof(p_value) <> 'string' or char_length(p_value #>> '{}') > p_max then
    raise exception 'Invalid lead.' using errcode = '22023';
  end if;
  return private.communication_line(p_value #>> '{}', p_max);
end;
$$;

-- An ISO 8601 instant with its offset (2026-11-03T12:00:00.000Z), or null for anything else.
create function private.lead_instant(p_value jsonb) returns timestamptz
language plpgsql stable set search_path = '' as $$
begin
  if p_value is null or jsonb_typeof(p_value) <> 'string' or char_length(p_value #>> '{}') > 40
    or (p_value #>> '{}') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[Tt][0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]{1,9})?)?([Zz]|[+-][0-9]{2}(:?[0-9]{2})?)$' then
    return null;
  end if;
  return (p_value #>> '{}')::timestamptz;
exception when data_exception then
  -- A shape the pattern accepts but the calendar does not (2026-02-30, hour 25).
  return null;
end;
$$;

-- The owner's view of one lead.
create function private.lead_json(p_id uuid) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', l.id, 'source', l.source, 'kind', l.kind, 'externalId', l.external_id, 'test', l.test,
    'occurredAt', l.occurred_at, 'receivedAt', l.received_at,
    'contact', jsonb_build_object('name', l.contact_name, 'email', l.contact_email, 'phone', l.contact_phone,
      'organization', l.organization, 'role', l.role),
    'details', l.details,
    'attribution', jsonb_build_object('utmSource', l.utm_source, 'utmMedium', l.utm_medium, 'utmCampaign', l.utm_campaign,
      'utmTerm', l.utm_term, 'utmContent', l.utm_content, 'referrerHost', l.referrer_host, 'landingPath', l.landing_path,
      'firstSeenAt', l.first_seen_at),
    'productId', l.product_id,
    'conversation', (select jsonb_build_object('id', c.id, 'reference', 'CM-' || c.reference, 'status', c.status)
      from private.communications c where c.id = l.communication_id),
    'status', l.status, 'createdAt', l.created_at, 'updatedAt', l.updated_at)
  from private.leads l where l.id = p_id;
$$;

-- Validates one lead exactly as the contract states, records it once per (source, externalId), opens the
-- conversation for a person who asked to be contacted, and writes the audit event. Any failure of the contract is
-- 22023 "Invalid lead." with no detail. Called only by private.lead_intake.
create function private.lead_record(p_source text, p_lead jsonb) returns jsonb
language plpgsql set search_path = '' as $$
declare
  v_kind text;
  v_external text;
  v_test boolean;
  v_occurred timestamptz;
  v_contact jsonb;
  v_email text;
  v_name text;
  v_phone text;
  v_organization text;
  v_role text;
  v_details jsonb;
  v_message text;
  v_attribution jsonb;
  v_utm_source text;
  v_utm_medium text;
  v_utm_campaign text;
  v_utm_term text;
  v_utm_content text;
  v_referrer text;
  v_landing text;
  v_first_seen timestamptz;
  v_product uuid;
  v_id uuid;
  v_conversation uuid;
  v_reference bigint;
  v_system text;
  v_at timestamptz;
  v_lines text;
  v_body text;
begin
  -- The envelope: known keys only, the required ones present, each of the right type.
  if p_source is null or p_source not in ('carebase','intel','advisors')
    or p_lead is null or jsonb_typeof(p_lead) <> 'object'
    or exists (select 1 from jsonb_object_keys(p_lead) k
      where k not in ('version','source','kind','externalId','occurredAt','test','contact','details','message','attribution'))
    or not (p_lead ?& array['version','source','kind','externalId','occurredAt','contact'])
    or (p_lead -> 'version') is distinct from '1'::jsonb
    or (p_lead -> 'source') is distinct from to_jsonb(p_source)
    or jsonb_typeof(p_lead -> 'kind') is distinct from 'string'
    or (p_lead ->> 'kind') not in ('demo_request','consultation','contact','trial_signup','newsletter','savings_model','county_report')
    or jsonb_typeof(p_lead -> 'externalId') is distinct from 'string'
    or (p_lead ->> 'externalId') !~ '^[A-Za-z0-9._:-]{1,100}$'
    or coalesce(jsonb_typeof(p_lead -> 'test'), 'null') not in ('boolean','null')
    or jsonb_typeof(p_lead -> 'contact') is distinct from 'object'
    or coalesce(jsonb_typeof(p_lead -> 'details'), 'null') not in ('object','null')
    or coalesce(jsonb_typeof(p_lead -> 'message'), 'null') not in ('string','null')
    or coalesce(jsonb_typeof(p_lead -> 'attribution'), 'null') not in ('object','null') then
    raise exception 'Invalid lead.' using errcode = '22023';
  end if;
  v_kind := p_lead ->> 'kind';
  v_external := p_lead ->> 'externalId';
  v_test := coalesce(jsonb_typeof(p_lead -> 'test') = 'boolean' and (p_lead -> 'test') = 'true'::jsonb, false);
  v_occurred := private.lead_instant(p_lead -> 'occurredAt');
  if v_occurred is null or v_occurred > now() + interval '5 minutes'
    -- Advisors forwards its inquiry reference; only a probe (a test lead) uses another id.
    or (p_source = 'advisors' and not v_test and v_external !~ '^CM-[A-F0-9]{12}$') then
    raise exception 'Invalid lead.' using errcode = '22023';
  end if;

  -- The contact: an address is required, every other field is an optional short string.
  v_contact := p_lead -> 'contact';
  if exists (select 1 from jsonb_object_keys(v_contact) k where k not in ('name','email','phone','organization','role'))
    or jsonb_typeof(v_contact -> 'email') is distinct from 'string'
    or char_length(v_contact ->> 'email') > 320 then
    raise exception 'Invalid lead.' using errcode = '22023';
  end if;
  v_email := lower(btrim(v_contact ->> 'email'));
  if char_length(v_email) < 3 or v_email !~ '^[^[:space:][:cntrl:]@]+@[^[:space:][:cntrl:]@]+\.[^[:space:][:cntrl:]@]+$' then
    raise exception 'Invalid lead.' using errcode = '22023';
  end if;
  v_name := private.lead_text(v_contact -> 'name', 200);
  v_phone := private.lead_text(v_contact -> 'phone', 40);
  v_organization := private.lead_text(v_contact -> 'organization', 200);
  v_role := private.lead_text(v_contact -> 'role', 100);

  -- Details: at most 12 flat facts. A string is kept on one line; an empty one is dropped.
  v_details := coalesce(nullif(p_lead -> 'details', 'null'::jsonb), '{}'::jsonb);
  if (select count(*) from jsonb_object_keys(v_details)) > 12
    or exists (select 1 from jsonb_each(v_details) e
      where e.key !~ '^[a-zA-Z][a-zA-Z0-9]{0,39}$'
        or jsonb_typeof(e.value) not in ('string','number','boolean')
        or (jsonb_typeof(e.value) = 'string' and char_length(e.value #>> '{}') > 200)) then
    raise exception 'Invalid lead.' using errcode = '22023';
  end if;
  select coalesce(jsonb_object_agg(f.key, f.value), '{}'::jsonb) into v_details
  from (
    select e.key, case when jsonb_typeof(e.value) = 'string' then to_jsonb(private.communication_line(e.value #>> '{}', 200)) else e.value end as value
    from jsonb_each(v_details) e
  ) f
  where f.value is not null;

  -- The message: possibly PHI. It goes only into the conversation below and is never stored on the lead.
  if jsonb_typeof(p_lead -> 'message') = 'string' then
    if char_length(p_lead ->> 'message') > 4000 then
      raise exception 'Invalid lead.' using errcode = '22023';
    end if;
    v_message := private.communication_body(p_lead ->> 'message');
  end if;

  -- First-touch attribution: every field optional; a host name only and a path only.
  v_attribution := coalesce(nullif(p_lead -> 'attribution', 'null'::jsonb), '{}'::jsonb);
  if exists (select 1 from jsonb_object_keys(v_attribution) k
    where k not in ('utmSource','utmMedium','utmCampaign','utmTerm','utmContent','referrerHost','landingPath','firstSeenAt')) then
    raise exception 'Invalid lead.' using errcode = '22023';
  end if;
  v_utm_source := private.lead_text(v_attribution -> 'utmSource', 200);
  v_utm_medium := private.lead_text(v_attribution -> 'utmMedium', 200);
  v_utm_campaign := private.lead_text(v_attribution -> 'utmCampaign', 200);
  v_utm_term := private.lead_text(v_attribution -> 'utmTerm', 200);
  v_utm_content := private.lead_text(v_attribution -> 'utmContent', 200);
  v_referrer := lower(private.lead_text(v_attribution -> 'referrerHost', 200));
  v_landing := private.lead_text(v_attribution -> 'landingPath', 300);
  if coalesce(jsonb_typeof(v_attribution -> 'firstSeenAt'), 'null') <> 'null' then
    v_first_seen := private.lead_instant(v_attribution -> 'firstSeenAt');
    if v_first_seen is null then
      raise exception 'Invalid lead.' using errcode = '22023';
    end if;
  end if;
  if v_referrer !~ '^[a-z0-9._-]+$' or v_landing !~ '^/[^?#[:space:][:cntrl:]]*$' then
    raise exception 'Invalid lead.' using errcode = '22023';
  end if;

  -- Recorded once per (source, externalId). A repeat changes nothing and is answered as a duplicate.
  v_product := private.communication_product(p_source);
  insert into private.leads (source, kind, external_id, test, occurred_at, contact_name, contact_email, contact_phone, organization, role,
    details, utm_source, utm_medium, utm_campaign, utm_term, utm_content, referrer_host, landing_path, first_seen_at, product_id)
  values (p_source, v_kind, v_external, v_test, v_occurred, v_name, v_email, v_phone, v_organization, v_role,
    v_details, v_utm_source, v_utm_medium, v_utm_campaign, v_utm_term, v_utm_content, v_referrer, v_landing, v_first_seen, v_product)
  on conflict (source, external_id) do nothing
  returning id into v_id;
  if v_id is null then
    select l.id, c.reference into v_id, v_reference
    from private.leads l left join private.communications c on c.id = l.communication_id
    where l.source = p_source and l.external_id = v_external;
    if v_id is null then
      -- The row the conflict named is gone again: let the product retry.
      raise exception 'Lead intake conflicted. Try again.' using errcode = '40001';
    end if;
    return jsonb_build_object('id', v_id, 'duplicate', true, 'conversation', case when v_reference is null then null else 'CM-' || v_reference end);
  end if;

  -- A person who asked to be contacted gets a conversation in Communications. A probe never does.
  if not v_test and v_kind in ('demo_request','consultation','contact') then
    v_system := p_source || '.web';
    v_at := least(v_occurred, now());
    v_lines := concat_ws(E'\n',
      case when v_role is not null then 'Role: ' || v_role end,
      (select string_agg(upper(left(x.label, 1)) || substr(x.label, 2) || ': ' ||
          case jsonb_typeof(e.value) when 'boolean' then case when e.value = 'true'::jsonb then 'Yes' else 'No' end else e.value #>> '{}' end,
          E'\n' order by e.key)
        from jsonb_each(v_details) e
        cross join lateral (select lower(regexp_replace(e.key, '([a-z0-9])([A-Z])', '\1 \2', 'g')) as label) x));
    v_body := coalesce(private.communication_body(concat_ws(E'\n\n', v_message, nullif(v_lines, ''))),
      'No message was included with this request.');
    -- Advisors: a consultation the owner already imported with "Import Advisors requests" is linked, not copied.
    insert into private.communications (channel, source_system, source_key, status, product_id, inquiry_type, subject,
      contact_name, contact_email, contact_phone, organization, created_at, updated_at, last_message_at)
    values ('web_form', v_system, v_external, 'new', v_product, case when v_kind = 'consultation' then 'advisors' else 'sales' end,
      private.communication_line(case v_kind when 'demo_request' then 'Demo request: ' when 'consultation' then 'Consultation request: '
        else 'Contact request: ' end || coalesce(v_organization, v_name, v_email), 200),
      private.communication_line(v_name, 160), v_email, v_phone, v_organization, v_at, now(), v_at)
    on conflict (source_system, source_key) do nothing
    returning id, reference into v_conversation, v_reference;
    if v_conversation is null then
      select c.id, c.reference into v_conversation, v_reference
      from private.communications c where c.source_system = v_system and c.source_key = v_external;
    else
      insert into private.communication_messages (communication_id, direction, body, delivery, provider_message_id, created_at)
      values (v_conversation, 'inbound', v_body, 'received', v_system || ':' || v_external, v_at);
    end if;
    update private.leads set communication_id = v_conversation where id = v_id;
  end if;

  -- Metadata only: never the contact or what the visitor wrote.
  insert into private.audit_events (actor_id, action, entity_type, entity_id, product_id, metadata)
  values (null, 'lead.received', 'lead', v_id, v_product, jsonb_build_object('source', p_source, 'kind', v_kind, 'test', v_test));
  return jsonb_build_object('id', v_id, 'duplicate', false, 'conversation', case when v_reference is null then null else 'CM-' || v_reference end);
end;
$$;

-- ---------------------------------------------------------------------------------------
-- The Hub server's operation: POST /api/leads calls it after the request's signature checked out.
-- ---------------------------------------------------------------------------------------
create function private.lead_intake(p_source text, p_lead jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_hub_app_server();
  return private.lead_record(p_source, p_lead);
end;
$$;

-- ---------------------------------------------------------------------------------------
-- The owner's operations. Each authorizes the current SMS administrator session itself, so a signed-out, lapsed
-- or non-administrator session fails closed with 28000. Reading needs the administrator session; changing a
-- status needs the command session (under eight hours old), the bar every other Hub change uses.
-- ---------------------------------------------------------------------------------------

-- One page of leads, newest first. Test leads (probes) are left out unless asked for.
create function hub.list_leads(
  p_kind text default null, p_source text default null, p_include_test boolean default false,
  p_offset integer default 0, p_limit integer default 25
) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_items jsonb;
  v_total bigint;
begin
  perform hub.authorize_app_admin();
  if (p_kind is not null and p_kind not in ('demo_request','consultation','contact','trial_signup','newsletter','savings_model','county_report'))
    or (p_source is not null and p_source not in ('carebase','intel','advisors'))
    or p_offset is null or p_offset < 0 or p_offset > 10000 or p_limit is null or p_limit < 1 or p_limit > 50 then
    raise exception 'Choose a valid filter and page.' using errcode = '22023';
  end if;
  select count(*) into v_total from private.leads l
  where (p_kind is null or l.kind = p_kind) and (p_source is null or l.source = p_source) and (coalesce(p_include_test, false) or not l.test);
  select coalesce(jsonb_agg(private.lead_json(x.id) order by x.received_at desc, x.id), '[]'::jsonb) into v_items
  from (
    select l.id, l.received_at from private.leads l
    where (p_kind is null or l.kind = p_kind) and (p_source is null or l.source = p_source) and (coalesce(p_include_test, false) or not l.test)
    order by l.received_at desc, l.id offset p_offset limit p_limit
  ) x;
  return jsonb_build_object('items', v_items, 'total', v_total, 'offset', p_offset, 'limit', p_limit);
end;
$$;

-- Moves a lead along (new, contacted, qualified, won, lost, spam). A change made elsewhere since the owner's page
-- loaded is refused with 40001, so one edit never silently overwrites another.
create function hub.update_lead_status(p_id uuid, p_status text, p_expected_updated_at timestamptz) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_actor jsonb;
  v_lead private.leads%rowtype;
begin
  v_actor := hub.authorize_app_command();
  if p_id is null or p_status is null or p_status not in ('new','contacted','qualified','won','lost','spam') or p_expected_updated_at is null then
    raise exception 'Choose a lead and a valid status.' using errcode = '22023';
  end if;
  select * into v_lead from private.leads where id = p_id for update;
  if not found then
    raise exception 'Lead not found.' using errcode = 'P0002';
  end if;
  if v_lead.updated_at is distinct from p_expected_updated_at then
    raise exception 'This lead changed. Refresh and try again.' using errcode = '40001';
  end if;
  if v_lead.status <> p_status then
    update private.leads set status = p_status, updated_at = clock_timestamp() where id = p_id;
    insert into private.audit_events (actor_id, action, entity_type, entity_id, product_id, changed_columns, metadata)
    values ((v_actor ->> 'user_id')::uuid, 'lead.status', 'lead', p_id, v_lead.product_id, array['status'],
      jsonb_build_object('from', v_lead.status, 'to', p_status));
  end if;
  return private.lead_json(p_id);
end;
$$;

-- ---------------------------------------------------------------------------------------
-- Retention (docs/LEAD_INTAKE.md, "Retention"). A lead is deleted twelve months after the Hub received it. A website
-- conversation (advisors.web, carebase.web or intel.web, including requests brought in by the manual Advisors import)
-- is deleted twelve months after its last message, with its messages. Conversations from any other channel are never
-- touched. The Hub server runs this from its periodic cleanup.
-- ---------------------------------------------------------------------------------------

-- Website conversations by last message, so a batch reads only what is due however much else the inbox keeps.
-- Leads are read oldest first through leads_recent (received_at).
create index communications_website_retention on private.communications (last_message_at, id)
  where source_system in ('advisors.web', 'carebase.web', 'intel.web');

-- One bounded batch, oldest first: at most p_limit leads received more than twelve months ago, then at most p_limit
-- website conversations whose last message is more than twelve months old. A deleted conversation's messages go with
-- it, and a lead that named it keeps no link. A row another transaction holds is left for a later batch, and a
-- conversation is deleted only while it is still idle. `more` says whether anything due is left. A batch that deleted
-- something writes one audit event with the two counts only: never a name, an address or the id of a deleted row.
-- Called only by private.lead_retention; separate so the database tests can exercise it without the Hub server's login.
create function private.lead_retention_batch(p_limit integer) returns jsonb
language plpgsql set search_path = '' as $$
declare
  v_cutoff constant timestamptz := now() - interval '12 months';
  v_leads integer;
  v_conversations integer;
  v_more boolean;
begin
  if p_limit is null or p_limit < 1 or p_limit > 5000 then
    raise exception 'Choose a batch of 1 to 5,000 rows.' using errcode = '22023';
  end if;

  delete from private.leads l
  where l.id = any(array(
    select d.id from private.leads d
    where d.received_at < v_cutoff
    order by d.received_at, d.id
    limit p_limit
    for update skip locked));
  get diagnostics v_leads = row_count;

  delete from private.communications c
  where c.id = any(array(
      select d.id from private.communications d
      where d.source_system in ('advisors.web', 'carebase.web', 'intel.web') and d.last_message_at < v_cutoff
      order by d.last_message_at, d.id
      limit p_limit
      for update skip locked))
    and c.source_system in ('advisors.web', 'carebase.web', 'intel.web') and c.last_message_at < v_cutoff;
  get diagnostics v_conversations = row_count;

  v_more := exists (select 1 from private.leads l where l.received_at < v_cutoff)
    or exists (select 1 from private.communications c
      where c.source_system in ('advisors.web', 'carebase.web', 'intel.web') and c.last_message_at < v_cutoff);

  if v_leads > 0 or v_conversations > 0 then
    insert into private.audit_events (actor_id, action, entity_type, entity_id, metadata)
    values (null, 'lead.retention', 'lead', null, jsonb_build_object('leads', v_leads, 'conversations', v_conversations));
  end if;
  return jsonb_build_object('leads', v_leads, 'conversations', v_conversations, 'more', v_more);
end;
$$;

-- The Hub server's operation: its fifteen-minute cleanup runs it at most once every six hours (server/lead-retention.mjs).
create function private.lead_retention(p_limit integer default 500) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_hub_app_server();
  return private.lead_retention_batch(p_limit);
end;
$$;

-- ---------------------------------------------------------------------------------------
-- Grants. Helpers: nobody. Intake and retention: the Hub server role only. Owner operations: signed-in sessions (they
-- authorize the administrator session themselves).
-- ---------------------------------------------------------------------------------------
revoke all on function
  private.lead_text(jsonb, integer),
  private.lead_instant(jsonb),
  private.lead_json(uuid),
  private.lead_record(text, jsonb),
  private.lead_intake(text, jsonb),
  private.lead_retention_batch(integer),
  private.lead_retention(integer)
from public, anon, authenticated, service_role, hub_app_server;
grant execute on function private.lead_intake(text, jsonb) to hub_app_server;
grant execute on function private.lead_retention(integer) to hub_app_server;

revoke all on function
  hub.list_leads(text, text, boolean, integer, integer),
  hub.update_lead_status(uuid, text, timestamp with time zone)
from public, anon, service_role;
grant execute on function
  hub.list_leads(text, text, boolean, integer, integer),
  hub.update_lead_status(uuid, text, timestamp with time zone)
to authenticated;
