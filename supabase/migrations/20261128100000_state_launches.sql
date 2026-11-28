-- State launches: the owner picks the next state and the AI team builds its cold email in Instantly (owner, 2026-11-28: "can all of this
-- be automated to my ai workforce so that I don't have to do this for the next states ... I'd prefer this to be fully automated so that I
-- can just choose the next state and all of this is automatically done").
--
-- Why. Pennsylvania's cold email (home health and hospice agencies, nursing home administrators, the owner's local nursing homes, chains
-- and regional groups) was built by hand in Instantly on 2026-11-27 and 28: the facility lists, the decision-makers and their checked
-- addresses, the segments, five draft campaigns with the owner's copy, and a county report for every "yes". The owner chose (2026-11-28):
-- Instantly sends every new state; the Hub builds the lists and campaigns; replies and opt-outs feed the Hub's do-not-contact list;
-- Pennsylvania is Instantly's too, so the owner's weekly batches stop; and nothing is sent until the owner clicks Launch.
--
-- 1. Settings (Settings → Customer growth): "Build state launches in Instantly" (off until the owner turns it on), the Instantly mailboxes
--    that send, the most emails each sends a day, the states Instantly sends to (Pennsylvania), the owner's local counties (their nursing
--    homes get the local email) and the most Hunter searches one state may use.
-- 2. private.state_launches: one row per state the owner chose, from queued through building and ready to launching and launched.
--    private.state_launch_targets: every facility of the state, its segment, why it was left out, and the person found for it.
-- 3. The owner's commands (hub.*): list, detail, request a state, launch a ready one, find more contacts for a ready one, cancel.
-- 4. The Hub server's functions (private.*, hub_app_server only): claim the next launch to work on, save its progress, add and read its
--    facilities, record a person, check every lead against the do-not-contact list, and record what Instantly reports (a reply, an
--    opt-out, a bounce): an opt-out or a complaint puts the address, its business's own domain and the facility on the do-not-contact list.
-- 5. The Marketing Manager's task outreach.launch, every five minutes.
--
-- Nothing is sent by this migration. 20261128100100_state_launches_contract.sql declares platform.agents.state-launches.v1.
set local lock_timeout = '10s';

insert into private.hub_settings (key, kind) values
  ('outreach.instantly', 'flag'), ('outreach.instantly_senders', 'list'), ('outreach.instantly_daily_limit', 'number'),
  ('outreach.instantly_states', 'list'), ('outreach.local_counties', 'list'), ('outreach.hunter_per_launch', 'number')
on conflict (key) do nothing;

create table if not exists private.state_launches (
  id uuid primary key default gen_random_uuid(),
  state text not null check (state ~ '^[A-Z]{2}$'),
  status text not null default 'queued' check (status in ('queued', 'building', 'ready', 'launching', 'launched', 'failed', 'cancelled')),
  stage text not null default 'gather' check (stage in ('gather', 'contacts', 'campaigns', 'done')),
  progress jsonb not null default '{}'::jsonb check (jsonb_typeof(progress) = 'object'),
  summary jsonb not null default '{}'::jsonb check (jsonb_typeof(summary) = 'object'),
  -- Segment → { id, name, leads }: the Instantly campaigns this launch created.
  campaigns jsonb not null default '{}'::jsonb check (jsonb_typeof(campaigns) = 'object'),
  error text check (char_length(error) <= 500),
  requested_by uuid,
  approved_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  ready_at timestamptz,
  launched_at timestamptz,
  cancelled_at timestamptz
);
-- One state at a time (owner, 2026-11-28: "Finish PA before going to the next state. I want to just be able to do 1 state at a
-- time"): at most one launch is open (queued, building, ready to launch or starting) until it is launched or cancelled.
create unique index if not exists state_launches_one_open_idx on private.state_launches ((true))
  where status in ('queued', 'building', 'ready', 'launching');
create index if not exists state_launches_work_idx on private.state_launches (created_at) where status in ('queued', 'building', 'launching');

create table if not exists private.state_launch_targets (
  id uuid primary key default gen_random_uuid(),
  launch_id uuid not null references private.state_launches(id) on delete cascade,
  ccn text not null check (ccn ~ '^[0-9A-Z]{6,10}$'),
  setting text not null check (setting in ('home_health', 'hospice', 'nursing_home')),
  name text not null check (char_length(name) between 1 and 300),
  city text check (char_length(city) <= 200),
  zip text check (zip ~ '^\d{5}$'),
  county text check (char_length(county) <= 200),
  county_fips text check (county_fips ~ '^\d{5}$'),
  ownership text check (char_length(ownership) <= 200),
  size numeric check (size >= 0),
  chain_id text check (char_length(chain_id) <= 40),
  chain_name text check (char_length(chain_name) <= 300),
  chain_size integer check (chain_size >= 0),
  segment text not null check (segment in ('agency', 'snf', 'local', 'chain', 'regional')),
  status text not null default 'pending'
    check (status in ('pending', 'held', 'found', 'not_found', 'added', 'skipped', 'replied', 'opted_out', 'bounced')),
  note text check (note ~ '^[a-z_]{1,40}$'),
  domain text check (domain ~ '^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$'),
  person_name text check (char_length(person_name) <= 200),
  first_name text check (char_length(first_name) <= 60),
  last_name text check (char_length(last_name) <= 100),
  title text check (char_length(title) <= 200),
  email text check (email = lower(email) and char_length(email) <= 320 and email ~ '^[^@\s]+@[^@\s]+\.[a-z]{2,}$'),
  email_source text check (email_source in ('hunter_domain', 'hunter_finder')),
  campaign_id text check (campaign_id ~ '^[0-9a-f-]{36}$'),
  searches integer not null default 0 check (searches between 0 and 10),
  looked_up_at timestamptz,
  report_sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (launch_id, ccn)
);
create index if not exists state_launch_targets_pending_idx on private.state_launch_targets (launch_id, status);
create index if not exists state_launch_targets_email_idx on private.state_launch_targets (email) where email is not null;

alter table private.state_launches enable row level security;
alter table private.state_launch_targets enable row level security;
revoke all on private.state_launches, private.state_launch_targets from public, anon, authenticated, service_role, hub_app_server;

-- ---------------------------------------------------------------------------------------
-- The Hub server's functions.
-- ---------------------------------------------------------------------------------------

-- The launch to work on next, oldest first, while "Build state launches in Instantly" is on: a queued one becomes building. A launch the
-- owner approved (launching) is picked as well. Null when there is none.
create or replace function private.state_launch_next() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare l private.state_launches%rowtype;
begin
  perform private.require_hub_app_server();
  if not coalesce((select s.value = 'true'::jsonb from private.hub_settings s where s.key = 'outreach.instantly'), false) then return null; end if;
  select * into l from private.state_launches where status in ('queued', 'building', 'launching')
    order by (status = 'launching') desc, created_at limit 1 for update skip locked;
  if not found then return null; end if;
  if l.status = 'queued' then
    update private.state_launches set status = 'building', stage = 'gather', updated_at = now() where id = l.id returning * into l;
  end if;
  return jsonb_build_object('id', l.id, 'state', l.state, 'status', l.status, 'stage', l.stage, 'progress', l.progress,
    'campaigns', l.campaigns, 'createdAt', l.created_at);
end; $$;

-- Saves what a run did: its stage, its progress, the campaigns it created, and, when it is done, ready (or launched) with its summary, or
-- failed with the reason. A launch the owner cancelled meanwhile stays cancelled.
create or replace function private.state_launch_save(p_id uuid, p_patch jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_status text := p_patch ->> 'status'; v_stage text := p_patch ->> 'stage';
begin
  perform private.require_hub_app_server();
  if jsonb_typeof(p_patch) <> 'object' then raise exception 'Invalid patch' using errcode = '22023'; end if;
  if v_status is not null and v_status not in ('building', 'ready', 'launched', 'failed') then raise exception 'Invalid status' using errcode = '22023'; end if;
  if v_stage is not null and v_stage not in ('gather', 'contacts', 'campaigns', 'done') then raise exception 'Invalid stage' using errcode = '22023'; end if;
  update private.state_launches set
    status = coalesce(v_status, status),
    stage = coalesce(v_stage, stage),
    progress = case when jsonb_typeof(p_patch -> 'progress') = 'object' then p_patch -> 'progress' else progress end,
    summary = case when jsonb_typeof(p_patch -> 'summary') = 'object' then p_patch -> 'summary' else summary end,
    campaigns = case when jsonb_typeof(p_patch -> 'campaigns') = 'object' then p_patch -> 'campaigns' else campaigns end,
    error = case when v_status = 'failed' then left(coalesce(p_patch ->> 'error', 'failed'), 500) when v_status is not null then null else error end,
    ready_at = case when v_status = 'ready' then now() else ready_at end,
    launched_at = case when v_status = 'launched' then now() else launched_at end,
    updated_at = now()
  where id = p_id and status in ('building', 'launching')
    and (v_status is null or v_status = 'failed' or (status = 'building' and v_status in ('building', 'ready')) or (status = 'launching' and v_status = 'launched'));
  return found;
end; $$;

-- Adds a launch's facilities as the build gathered and segmented them; one row per CCN, never twice. Answers how many were new.
create or replace function private.state_launch_add_targets(p_id uuid, p_rows jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare v_count integer;
begin
  perform private.require_hub_app_server();
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 1000 then raise exception 'Invalid rows' using errcode = '22023'; end if;
  if not exists (select 1 from private.state_launches where id = p_id and status = 'building') then return 0; end if;
  insert into private.state_launch_targets (launch_id, ccn, setting, name, city, zip, county, county_fips, ownership, size, chain_id, chain_name,
    chain_size, segment, status, note)
  select p_id, r ->> 'ccn', r ->> 'setting', left(r ->> 'name', 300), left(nullif(r ->> 'city', ''), 200), nullif(r ->> 'zip', ''),
    left(nullif(r ->> 'county', ''), 200), nullif(r ->> 'countyFips', ''), left(nullif(r ->> 'ownership', ''), 200),
    case when jsonb_typeof(r -> 'size') = 'number' and (r ->> 'size')::numeric >= 0 then (r ->> 'size')::numeric end,
    left(nullif(r ->> 'chainId', ''), 40), left(nullif(r ->> 'chainName', ''), 300),
    case when jsonb_typeof(r -> 'chainSize') = 'number' and (r ->> 'chainSize')::numeric >= 0 then (r ->> 'chainSize')::integer end,
    r ->> 'segment', case when r ->> 'hold' is not null then 'held' else 'pending' end, nullif(r ->> 'hold', '')
  from jsonb_array_elements(p_rows) r
  on conflict (launch_id, ccn) do nothing;
  get diagnostics v_count = row_count;
  update private.state_launches set updated_at = now() where id = p_id;
  return v_count;
end; $$;

-- The facilities still to look a person up for: chains and regional groups first, then the owner's local nursing homes, then the rest,
-- smaller ones first.
create or replace function private.state_launch_pending(p_id uuid, p_limit integer) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_hub_app_server();
  if p_limit is null or p_limit not between 1 and 200 then raise exception 'Invalid limit' using errcode = '22023'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'ccn', t.ccn, 'setting', t.setting, 'name', t.name, 'city', t.city, 'zip', t.zip,
      'county', t.county, 'countyFips', t.county_fips, 'segment', t.segment, 'chainName', t.chain_name, 'chainSize', t.chain_size, 'size', t.size)
      order by case t.segment when 'chain' then 0 when 'regional' then 1 when 'local' then 2 else 3 end, t.size nulls last, t.name), '[]'::jsonb)
    from (select * from private.state_launch_targets x where x.launch_id = p_id and x.status = 'pending'
      order by case x.segment when 'chain' then 0 when 'regional' then 1 when 'local' then 2 else 3 end, x.size nulls last, x.name limit p_limit) t);
end; $$;

-- Records what the person search answered for one facility: found (a person and a checked address on its own domain) or not found.
create or replace function private.state_launch_target_save(p_target uuid, p_patch jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_status text := p_patch ->> 'status';
begin
  perform private.require_hub_app_server();
  if jsonb_typeof(p_patch) <> 'object' or v_status not in ('found', 'not_found') then raise exception 'Invalid result' using errcode = '22023'; end if;
  if v_status = 'found' and (coalesce(p_patch ->> 'email', '') = '' or coalesce(p_patch ->> 'domain', '') = '') then
    raise exception 'A person found needs an address and a domain' using errcode = '22023';
  end if;
  update private.state_launch_targets t set status = v_status,
    note = case when v_status = 'not_found' then nullif(p_patch ->> 'note', '') end,
    domain = nullif(lower(p_patch ->> 'domain'), ''),
    person_name = left(nullif(p_patch ->> 'personName', ''), 200), first_name = left(nullif(p_patch ->> 'firstName', ''), 60),
    last_name = left(nullif(p_patch ->> 'lastName', ''), 100), title = left(nullif(p_patch ->> 'title', ''), 200),
    email = case when v_status = 'found' then lower(btrim(p_patch ->> 'email')) end,
    email_source = case when v_status = 'found' then p_patch ->> 'source' end,
    searches = least(10, t.searches + coalesce(case when jsonb_typeof(p_patch -> 'searches') = 'number' then (p_patch ->> 'searches')::integer end, 0)),
    looked_up_at = now(), updated_at = now()
  from private.state_launches l
  where t.id = p_target and l.id = t.launch_id and l.status = 'building' and t.status = 'pending';
  return found;
end; $$;

-- Every person found for a launch and not yet in a campaign, with why one may not be emailed: on the do-not-contact or suppression list,
-- in an approved owner sequence, emailed by the Marketing Manager in the last 90 days (the owner sequences' own check), or an address the
-- Marketing Manager's people step recorded as opted out.
create or replace function private.state_launch_leads(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_hub_app_server();
  return (select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'ccn', t.ccn, 'setting', t.setting, 'name', t.name, 'city', t.city,
      'county', t.county, 'countyFips', t.county_fips, 'segment', t.segment, 'chainName', t.chain_name, 'domain', t.domain,
      'personName', t.person_name, 'firstName', t.first_name, 'lastName', t.last_name, 'title', t.title, 'email', t.email,
      'blocked', coalesce(
        private.owner_sequence_check_people(jsonb_build_array(jsonb_build_object('ref', t.id::text, 'email', t.email, 'domain', t.domain,
          'ccn', case when t.ccn ~ '^[0-9A-Z]{6}$' then t.ccn end))) ->> t.id::text,
        case when exists (select 1 from private.growth_contacts c where c.email = t.email and c.eligibility = 'opted_out') then 'do_not_contact' end))
      order by case t.segment when 'chain' then 0 when 'regional' then 1 when 'local' then 2 else 3 end, t.size nulls last, t.name), '[]'::jsonb)
    from private.state_launch_targets t where t.launch_id = p_id and t.status = 'found');
end; $$;

-- Marks facilities as put into an Instantly campaign (added) or left out of every campaign (skipped, with the reason).
create or replace function private.state_launch_mark(p_ids jsonb, p_status text, p_note text, p_campaign text) returns integer
language plpgsql security definer set search_path = '' as $$
declare v_count integer;
begin
  perform private.require_hub_app_server();
  if jsonb_typeof(p_ids) <> 'array' or jsonb_array_length(p_ids) > 1000 or p_status not in ('added', 'skipped') then
    raise exception 'Invalid mark' using errcode = '22023';
  end if;
  if p_status = 'added' and (p_campaign is null or p_campaign !~ '^[0-9a-f-]{36}$') then raise exception 'Invalid campaign' using errcode = '22023'; end if;
  update private.state_launch_targets set status = p_status, note = case when p_status = 'skipped' then p_note end,
    campaign_id = case when p_status = 'added' then p_campaign end, updated_at = now()
  where status = 'found' and id in (select (x #>> '{}')::uuid from jsonb_array_elements(p_ids) x);
  get diagnostics v_count = row_count;
  return v_count;
end; $$;

-- What Instantly reported about an address (server/outreach/webhook.mjs): a reply, an opt-out ("not interested", an unsubscribe), a spam
-- complaint or a bounce. An opt-out or a complaint puts the address, its business's own domain (never a free mail service's) and the
-- facility on the do-not-contact list and suppresses the address, whichever campaign it came from, the ones built by hand included.
-- Answers the facility the address belongs to in a launch's campaign, if any, for the county report and the owner's alert.
create or replace function private.state_launch_event(p_campaign text, p_email text, p_kind text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_email text := lower(btrim(p_email)); v_domain text; t private.state_launch_targets%rowtype; v_reason text;
begin
  perform private.require_hub_app_server();
  if p_kind not in ('replied', 'opted_out', 'complaint', 'bounced') then raise exception 'Invalid kind' using errcode = '22023'; end if;
  if v_email is null or v_email !~ '^[^@\s]+@[^@\s]+\.[a-z]{2,}$' or char_length(v_email) > 320 then raise exception 'Invalid address' using errcode = '22023'; end if;
  select * into t from private.state_launch_targets x where x.email = v_email
    order by (x.campaign_id = p_campaign) desc nulls last, x.updated_at desc limit 1;
  if p_kind in ('opted_out', 'complaint') then
    v_reason := case when p_kind = 'complaint' then 'complaint' else 'opted_out' end;
    v_domain := split_part(v_email, '@', 2);
    insert into private.outreach_do_not_contact(kind, value, reason, source) values ('email_hash', private.email_hash(v_email), v_reason, 'instantly')
      on conflict do nothing;
    if not private.growth_free_mail(v_domain) and v_domain ~ '^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$' then
      insert into private.outreach_do_not_contact(kind, value, reason, source) values ('domain', v_domain, v_reason, 'instantly') on conflict do nothing;
    end if;
    if t.id is not null and t.ccn ~ '^[0-9A-Z]{6}$' then
      insert into private.outreach_do_not_contact(kind, value, reason, source) values ('ccn', t.ccn, v_reason, 'instantly') on conflict do nothing;
    end if;
    insert into private.email_suppressions(email_hash) values (private.email_hash(v_email)) on conflict do nothing;
  end if;
  if t.id is null then return jsonb_build_object('target', null); end if;
  update private.state_launch_targets set status = case
      when p_kind in ('opted_out', 'complaint') then 'opted_out' when p_kind = 'bounced' then 'bounced'
      when status in ('opted_out', 'bounced') then status else 'replied' end, updated_at = now()
  where id = t.id;
  return jsonb_build_object('target', jsonb_build_object('id', t.id, 'ccn', t.ccn, 'name', t.name, 'setting', t.setting, 'segment', t.segment,
    'county', t.county, 'countyFips', t.county_fips, 'personName', t.person_name, 'reportSent', t.report_sent_at is not null,
    'state', (select l.state from private.state_launches l where l.id = t.launch_id)));
end; $$;

-- Claims the one county report a facility's person gets for a "yes": true the first time only.
create or replace function private.state_launch_report_claim(p_target uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_hub_app_server();
  update private.state_launch_targets set report_sent_at = now(), updated_at = now() where id = p_target and report_sent_at is null;
  return found;
end; $$;

revoke all on function private.state_launch_next(), private.state_launch_save(uuid, jsonb), private.state_launch_add_targets(uuid, jsonb),
  private.state_launch_pending(uuid, integer), private.state_launch_target_save(uuid, jsonb), private.state_launch_leads(uuid),
  private.state_launch_mark(jsonb, text, text, text), private.state_launch_event(text, text, text), private.state_launch_report_claim(uuid)
  from public, anon, authenticated, service_role;
grant execute on function private.state_launch_next(), private.state_launch_save(uuid, jsonb), private.state_launch_add_targets(uuid, jsonb),
  private.state_launch_pending(uuid, integer), private.state_launch_target_save(uuid, jsonb), private.state_launch_leads(uuid),
  private.state_launch_mark(jsonb, text, text, text), private.state_launch_event(text, text, text), private.state_launch_report_claim(uuid)
  to hub_app_server;

-- ---------------------------------------------------------------------------------------
-- The owner's commands.
-- ---------------------------------------------------------------------------------------

-- Owner: every launch, newest first, with its facilities counted by segment and status.
create or replace function hub.state_launches() returns jsonb
language plpgsql stable security definer set search_path = '' as $$ begin
  perform hub.authorize_app_admin();
  return jsonb_build_object(
    'enabled', coalesce((select s.value = 'true'::jsonb from private.hub_settings s where s.key = 'outreach.instantly'), false),
    'launches', (select coalesce(jsonb_agg(x order by x."createdAt" desc), '[]'::jsonb) from (
      select l.id, l.state, l.status, l.stage, l.progress, l.summary, l.campaigns, l.error, l.created_at as "createdAt", l.ready_at as "readyAt",
        l.launched_at as "launchedAt",
        (select coalesce(jsonb_object_agg(c.key, c.n), '{}'::jsonb) from (select t.status as key, count(*) as n from private.state_launch_targets t
          where t.launch_id = l.id group by t.status) c) as counts
      from private.state_launches l order by l.created_at desc limit 60) x));
end; $$;

-- Owner: one launch's facilities (at most 3,000), people found first.
create or replace function hub.state_launch_detail(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$ begin
  perform hub.authorize_app_admin();
  if not exists (select 1 from private.state_launches where id = p_id) then raise exception 'Unknown launch' using errcode = 'P0002'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'ccn', t.ccn, 'setting', t.setting, 'name', t.name, 'city', t.city, 'county', t.county,
      'segment', t.segment, 'status', t.status, 'note', t.note, 'chainName', t.chain_name, 'personName', t.person_name, 'title', t.title,
      'email', t.email, 'domain', t.domain) order by t.rank, t.segment, t.name), '[]'::jsonb)
    from (select x.*, case x.status when 'added' then 0 when 'found' then 1 when 'replied' then 2 when 'skipped' then 3 when 'not_found' then 4
      when 'pending' then 5 else 6 end as rank from private.state_launch_targets x where x.launch_id = p_id
      order by rank, x.segment, x.name limit 3000) t);
end; $$;

-- Owner: queue the next state. Refused while that state has a launch open.
create or replace function hub.state_launch_request(p_state text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_actor uuid; v_state text := upper(btrim(p_state)); v_id uuid;
begin
  v_actor := (hub.authorize_app_command() ->> 'user_id')::uuid;
  if v_state is null or v_state <> all (array['AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME',
    'MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA',
    'WV','WI','WY']) then
    raise exception 'Choose a state by its two-letter code' using errcode = '22023';
  end if;
  -- One state at a time: the open one is launched (or cancelled) before the next is chosen.
  if exists (select 1 from private.state_launches where status in ('queued', 'building', 'ready', 'launching')) then
    raise exception 'Finish the state already open (%) first: launch it or cancel it',
      (select l.state from private.state_launches l where l.status in ('queued', 'building', 'ready', 'launching') limit 1)
      using errcode = '22023';
  end if;
  insert into private.state_launches (state, requested_by) values (v_state, v_actor) returning id into v_id;
  insert into private.audit_events(actor_id, action, entity_type, entity_id, metadata)
  values (v_actor, 'growth.state_launch_requested', 'state_launch', v_id, jsonb_build_object('state', v_state));
  return jsonb_build_object('id', v_id);
end; $$;

-- Owner: start sending a ready launch. The Marketing Manager activates its Instantly campaigns on its next run.
create or replace function hub.state_launch_approve(p_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_actor uuid; l private.state_launches%rowtype;
begin
  v_actor := (hub.authorize_app_command() ->> 'user_id')::uuid;
  select * into l from private.state_launches where id = p_id for update;
  if not found then raise exception 'Unknown launch' using errcode = 'P0002'; end if;
  if l.status <> 'ready' then raise exception 'Only a ready launch can be launched; refresh it' using errcode = '40001'; end if;
  if l.campaigns = '{}'::jsonb then raise exception 'This launch has no campaign to start' using errcode = '22023'; end if;
  update private.state_launches set status = 'launching', approved_by = v_actor, updated_at = now() where id = l.id;
  insert into private.audit_events(actor_id, action, entity_type, entity_id, metadata)
  values (v_actor, 'growth.state_launch_approved', 'state_launch', l.id, jsonb_build_object('state', l.state));
  return jsonb_build_object('id', l.id, 'status', 'launching');
end; $$;

-- Owner: look for more people in a ready launch (after Hunter's searches are topped up): it builds again from the facilities still to
-- look up, and adds the people it finds to the same campaigns.
create or replace function hub.state_launch_more(p_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_actor uuid; l private.state_launches%rowtype;
begin
  v_actor := (hub.authorize_app_command() ->> 'user_id')::uuid;
  select * into l from private.state_launches where id = p_id for update;
  if not found then raise exception 'Unknown launch' using errcode = 'P0002'; end if;
  if l.status <> 'ready' then raise exception 'Only a ready launch can look for more people; refresh it' using errcode = '40001'; end if;
  if not exists (select 1 from private.state_launch_targets t where t.launch_id = l.id and t.status = 'pending') then
    raise exception 'Every facility of this launch was already looked up' using errcode = '22023';
  end if;
  update private.state_launches set status = 'building', stage = 'contacts', progress = progress || jsonb_build_object('passSearches', 0),
    updated_at = now() where id = l.id;
  insert into private.audit_events(actor_id, action, entity_type, entity_id, metadata)
  values (v_actor, 'growth.state_launch_more', 'state_launch', l.id, jsonb_build_object('state', l.state));
  return jsonb_build_object('id', l.id, 'status', 'building');
end; $$;

-- Owner: cancel a launch that has not started sending. Campaigns it already created stay in Instantly as drafts.
create or replace function hub.state_launch_cancel(p_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_actor uuid; l private.state_launches%rowtype;
begin
  v_actor := (hub.authorize_app_command() ->> 'user_id')::uuid;
  select * into l from private.state_launches where id = p_id for update;
  if not found then raise exception 'Unknown launch' using errcode = 'P0002'; end if;
  if l.status not in ('queued', 'building', 'ready', 'failed') then raise exception 'This launch can no longer be cancelled' using errcode = '40001'; end if;
  update private.state_launches set status = 'cancelled', cancelled_at = now(), updated_at = now() where id = l.id;
  insert into private.audit_events(actor_id, action, entity_type, entity_id, metadata)
  values (v_actor, 'growth.state_launch_cancelled', 'state_launch', l.id, jsonb_build_object('state', l.state));
  return jsonb_build_object('id', l.id, 'status', 'cancelled');
end; $$;

revoke all on function hub.state_launches(), hub.state_launch_detail(uuid), hub.state_launch_request(text), hub.state_launch_approve(uuid),
  hub.state_launch_more(uuid), hub.state_launch_cancel(uuid) from public, anon, authenticated, service_role;
grant execute on function hub.state_launches(), hub.state_launch_detail(uuid), hub.state_launch_request(text), hub.state_launch_approve(uuid),
  hub.state_launch_more(uuid), hub.state_launch_cancel(uuid) to authenticated, hub_app_server;

-- Pennsylvania, built by hand on 2026-11-27 and 28, is the first launch: ready, with its five draft Instantly campaigns, so it is
-- launched from Growth → State launches like any other and the next state waits for it. The campaign with the same-company extras
-- and batch 1's agencies ("HOLD – PA same-company extras (do not launch)") is never part of it.
insert into private.state_launches (state, status, stage, campaigns, summary, ready_at)
select 'PA', 'ready', 'done',
  '{"agency": {"id": "f00275f1-631f-4b7f-94e2-c121f78014a8", "name": "PA home health & hospice – owners, wave 1 (draft)", "leads": 268},
    "snf": {"id": "d1dead79-7e80-44dd-850c-6c06fdb4732a", "name": "PA skilled nursing – administrators (draft)", "leads": 217},
    "local": {"id": "57f2418a-c125-4fdb-b26d-a3fd04ff4f38", "name": "PA skilled nursing – local referral sources near Cambria (draft)", "leads": 53},
    "chain": {"id": "f1808c1a-a5c4-4370-b30a-5664c6745233", "name": "PA nursing home chains – corporate (draft)", "leads": 20},
    "regional": {"id": "3843a1e4-ef18-4b57-bdfe-b29b4f1a5e27", "name": "PA nursing home regional groups – leadership (draft)", "leads": 18}}'::jsonb,
  '{"leads": 576, "builtByHand": true, "pendingLeft": false}'::jsonb, now()
where not exists (select 1 from private.state_launches where state = 'PA');

insert into private.agent_schedules (agent_key, task_kind, cadence, every_seconds, at_local, timezone, requires_session, next_run_at)
values ('marketing_manager', 'outreach.launch', 'interval', 300, null, 'America/New_York', false, now())
on conflict (agent_key, task_kind) do nothing;
