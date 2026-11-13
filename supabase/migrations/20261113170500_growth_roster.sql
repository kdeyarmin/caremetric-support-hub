-- Prospects from the Medicare roster (owner plan 2026-11-13).
--
-- Intel publishes every Medicare-certified home health agency and hospice from CMS's newest Provider of Services quarter through its
-- signed marketing feed (Intel docs/HUB_MARKETING_FEED.md). Until now the Marketing Manager found prospects only through web search,
-- which in its first four days found 23 organizations, a third of them directories. This migration lets it work from the roster:
--
-- - private.growth_roster_targets: one row per CCN from the feed, with its public record (name, setting, place, CMS dates and
--   signals), a dated claim stating that record, an optional research-only claim (size and market position, never quoted to the
--   agency), a deterministic rank and a resolution state. It is a staging table, not growth_organizations, because an organization
--   needs its own website domain, chains share one site across many CCNs, and the pipeline sweep reads every opportunity;
-- - private.growth_roster_sync: where the weekly read of the feed is (quarter, states, cursor), so a read resumes across runs;
-- - server functions to save a page of the roster, hand out the day's best targets to look up (capped per Eastern day by the
--   owner's setting), and record what a lookup found. A target whose own website is confirmed (its CMS telephone number on the site,
--   or its name and place) graduates: its organization is found or created by domain and stamped as discovered, so the existing
--   contact finder, fit assessment, qualification rule, drafting, approval and send caps all apply to it unchanged;
-- - the public record becomes high-confidence evidence on the opportunity, observed again on every weekly read of the roster, so a
--   qualified prospect's evidence stays inside the 30-day window the qualification rule and the send claim require;
-- - a host that already serves three graduated agencies graduates another only on a telephone match, so an aggregator that slipped
--   past the directory filter cannot collect agencies by name alone;
-- - hub.growth_roster: the owner's read for the Growth screen;
-- - three settings (Settings -> Customer growth): "Find prospects from the Medicare roster" (off), "States to prospect in" (none) and
--   "Most roster agencies to look up a day" (25).
--
-- Nothing here sends anything, changes an agent's autonomy, or loosens a send check.
set local lock_timeout = '10s';

insert into private.hub_settings (key, kind) values
  ('growth.roster', 'flag'),
  ('growth.roster_states', 'list'),
  ('growth.roster_daily_resolutions', 'number')
on conflict (key) do nothing;

create table private.growth_roster_targets (
  ccn text primary key check (ccn ~ '^[0-9A-Z]{6,10}$'),
  product text not null default 'caremetric-intel' check (product = 'caremetric-intel'),
  name text not null check (char_length(name) between 1 and 200),
  setting text not null check (setting in ('home_health', 'hospice')),
  city text check (char_length(city) <= 100),
  state text not null check (state ~ '^[A-Z]{2}$'),
  zip text check (zip ~ '^[0-9]{5}$'),
  county_fips text check (county_fips ~ '^[0-9]{5}$'),
  period text not null check (period ~ '^[0-9]{4}Q[1-4]$'),
  facts jsonb not null default '{}' check (jsonb_typeof(facts) = 'object' and pg_column_size(facts) <= 4000),
  -- The public record, as dated evidence the Marketing Manager may cite.
  claim text not null check (char_length(claim) between 1 and 1000),
  -- Size and market position, for fit and ranking only: drafts never see it (server/growth/draft.mjs).
  research text check (char_length(research) between 1 and 1000),
  rank integer not null default 0 check (rank between 0 and 100),
  rank_reasons text[] not null default '{}' check (cardinality(rank_reasons) <= 12),
  status text not null default 'new' check (status in ('new', 'resolving', 'unresolved', 'excluded', 'graduated')),
  reason text check (reason ~ '^[a-z_]{1,40}$'),
  resolve_attempts integer not null default 0 check (resolve_attempts between 0 and 1000),
  resolve_started_at timestamptz,
  resolve_after timestamptz,
  organization_id uuid references private.growth_organizations(id),
  confirmation text check (confirmation in ('phone', 'name')),
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status = 'graduated') = (organization_id is not null))
);
create index growth_roster_targets_next on private.growth_roster_targets (rank desc, ccn) where status in ('new', 'unresolved', 'resolving');
create index growth_roster_targets_org on private.growth_roster_targets (organization_id) where organization_id is not null;

create table private.growth_roster_sync (
  id boolean primary key default true check (id),
  period text check (period ~ '^[0-9]{4}Q[1-4]$'),
  states text[] not null default '{}' check (cardinality(states) <= 60),
  cursor text check (cursor ~ '^[0-9A-Z]{6,10}$'),
  complete boolean not null default false,
  started_at timestamptz,
  synced_at timestamptz,
  pages integer not null default 0 check (pages >= 0),
  rows integer not null default 0 check (rows >= 0)
);
insert into private.growth_roster_sync default values;

alter table private.growth_roster_targets enable row level security;
alter table private.growth_roster_sync enable row level security;
revoke all on private.growth_roster_targets, private.growth_roster_sync from public, anon, authenticated, service_role, hub_app_server;

-- Where a CMS fact is cited: Intel's public data-sources page. The claim names the dataset, quarter and CCN; Intel's own source
-- line says its figures are derived from public CMS data, not CMS publications, so a CMS page would overstate it.
create function private.growth_roster_source_url() returns text
language sql immutable set search_path = '' as $$ select 'https://www.caremetricintel.com/data-use'::text $$;

-- The target's public record (and research-only line) as evidence on each opportunity of its organization, observed now.
create function private.growth_roster_evidence(p_ccn text) returns void
language plpgsql security definer set search_path = '' as $$
declare t private.growth_roster_targets%rowtype; v_opp uuid; begin
 select * into t from private.growth_roster_targets where ccn = p_ccn;
 if not found or t.organization_id is null then return; end if;
 for v_opp in select id from private.growth_opportunities where organization_id = t.organization_id and product = t.product loop
  insert into private.growth_evidence(opportunity_id, source_url, claim, confidence, observed_at)
  values (v_opp, private.growth_roster_source_url(), t.claim, 'high', now())
  on conflict (opportunity_id, source_url, claim) do update set observed_at = excluded.observed_at;
  if t.research is not null then
   insert into private.growth_evidence(opportunity_id, source_url, claim, confidence, observed_at)
   values (v_opp, private.growth_roster_source_url(), t.research, 'high', now())
   on conflict (opportunity_id, source_url, claim) do update set observed_at = excluded.observed_at;
  end if;
 end loop;
end; $$;

-- Server: where the roster read is.
create function private.growth_roster_sync_state() returns jsonb
language plpgsql stable security definer set search_path = '' as $$ begin
 perform private.require_hub_app_server();
 return (select jsonb_build_object('period', s.period, 'states', to_jsonb(s.states), 'cursor', s.cursor, 'complete', s.complete,
   'startedAt', s.started_at, 'syncedAt', s.synced_at, 'pages', s.pages, 'rows', s.rows) from private.growth_roster_sync s);
end; $$;

-- Server: saves where the read is. A new quarter or a new set of states starts the read again from the first page.
create function private.growth_roster_sync_save(p_data jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_states text[]; begin
 perform private.require_hub_app_server();
 if p_data is null or jsonb_typeof(p_data) <> 'object' or jsonb_typeof(coalesce(p_data -> 'states', '[]')) <> 'array' then
  raise exception 'Invalid roster state' using errcode = '22023';
 end if;
 v_states := array(select jsonb_array_elements_text(coalesce(p_data -> 'states', '[]')) order by 1);
 if exists (select 1 from unnest(v_states) s where s !~ '^[A-Z]{2}$') or cardinality(v_states) > 60
   or (p_data ->> 'period') !~ '^[0-9]{4}Q[1-4]$' or coalesce(p_data ->> 'cursor', '') !~ '^([0-9A-Z]{6,10})?$' then
  raise exception 'Invalid roster state' using errcode = '22023';
 end if;
 update private.growth_roster_sync set
   period = p_data ->> 'period', states = v_states, cursor = nullif(p_data ->> 'cursor', ''),
   complete = coalesce((p_data ->> 'complete')::boolean, false),
   started_at = case when coalesce((p_data ->> 'restart')::boolean, false) then now() else coalesce(started_at, now()) end,
   synced_at = case when coalesce((p_data ->> 'complete')::boolean, false) then now() else synced_at end,
   pages = case when coalesce((p_data ->> 'restart')::boolean, false) then 0 else pages end + coalesce((p_data ->> 'pages')::integer, 0),
   rows = case when coalesce((p_data ->> 'restart')::boolean, false) then 0 else rows end + coalesce((p_data ->> 'rows')::integer, 0);
 return private.growth_roster_sync_state();
end; $$;

-- Server: one page of the roster (at most 500 agencies), ranked by the server (server/growth/roster.mjs). A graduated agency stays
-- graduated and its evidence is observed again; an excluded one (closed) stays out until the roster lists it as open again.
create function private.growth_roster_upsert(p_period text, p_rows jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare r jsonb; t private.growth_roster_targets%rowtype; v_n integer := 0; begin
 perform private.require_hub_app_server(); perform pg_advisory_xact_lock(hashtextextended('growth.workflow', 0));
 if p_period is null or p_period !~ '^[0-9]{4}Q[1-4]$' or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 500 then
  raise exception 'Invalid roster page' using errcode = '22023';
 end if;
 for r in select value from jsonb_array_elements(p_rows) loop
  if jsonb_typeof(r) <> 'object' or jsonb_typeof(coalesce(r -> 'reasons', '[]')) <> 'array' then
   raise exception 'Invalid roster row' using errcode = '22023';
  end if;
  insert into private.growth_roster_targets as x (ccn, name, setting, city, state, zip, county_fips, period, facts, claim, research,
    rank, rank_reasons, status, reason)
  values (r ->> 'ccn', left(r ->> 'name', 200), r ->> 'setting', left(nullif(r ->> 'city', ''), 100), r ->> 'state', nullif(r ->> 'zip', ''),
    nullif(r ->> 'county_fips', ''), p_period, coalesce(r -> 'facts', '{}'), left(r ->> 'claim', 1000), left(nullif(r ->> 'research', ''), 1000),
    least(greatest(coalesce((r ->> 'rank')::integer, 0), 0), 100), array(select left(value, 80) from jsonb_array_elements_text(coalesce(r -> 'reasons', '[]')) limit 12),
    case when coalesce((r ->> 'excluded')::boolean, false) then 'excluded' else 'new' end,
    case when coalesce((r ->> 'excluded')::boolean, false) then 'closed' end)
  on conflict (ccn) do update set
    name = excluded.name, setting = excluded.setting, city = excluded.city, state = excluded.state, zip = excluded.zip,
    county_fips = excluded.county_fips, period = excluded.period, facts = excluded.facts, claim = excluded.claim, research = excluded.research,
    rank = excluded.rank, rank_reasons = excluded.rank_reasons,
    status = case when x.status = 'graduated' then 'graduated' when excluded.status = 'excluded' then 'excluded'
                  when x.status = 'excluded' then 'new' else x.status end,
    reason = case when x.status = 'graduated' then x.reason when excluded.status = 'excluded' then 'closed'
                  when x.status = 'excluded' then null else x.reason end,
    updated_at = now()
  returning * into t;
  if t.status = 'graduated' then perform private.growth_roster_evidence(t.ccn); end if;
  v_n := v_n + 1;
 end loop;
 return v_n;
end; $$;

-- Server: the next agencies to look up, best rank first, within the owner's daily number (Eastern day). Each is marked as being
-- resolved; one left resolving for an hour (a restart) is handed out again.
create function private.growth_roster_next(p_limit integer, p_daily integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s private.growth_roster_sync%rowtype; v_used integer; v_left integer; v_out jsonb; begin
 perform private.require_hub_app_server(); perform pg_advisory_xact_lock(hashtextextended('growth.workflow', 0));
 if p_limit is null or p_limit < 1 or p_limit > 20 or p_daily is null or p_daily < 0 or p_daily > 200 then
  raise exception 'Invalid roster request' using errcode = '22023';
 end if;
 select * into s from private.growth_roster_sync;
 select count(*) into v_used from private.growth_roster_targets where resolve_started_at >= private.agent_day_start();
 v_left := least(p_limit, greatest(p_daily - v_used, 0));
 if v_left = 0 or s.period is null or cardinality(s.states) = 0 then return '[]'::jsonb; end if;
 with picked as (
   select ccn from private.growth_roster_targets
    where period = s.period and state = any(s.states)
      and ((status in ('new', 'unresolved') and (resolve_after is null or resolve_after <= now()))
           or (status = 'resolving' and resolve_started_at < now() - interval '1 hour'))
    order by rank desc, ccn limit v_left for update skip locked),
 marked as (
   update private.growth_roster_targets t set status = 'resolving', resolve_attempts = t.resolve_attempts + 1, resolve_started_at = now(), updated_at = now()
     from picked where t.ccn = picked.ccn returning t.*)
 select coalesce(jsonb_agg(jsonb_build_object('ccn', m.ccn, 'name', m.name, 'setting', m.setting, 'city', m.city, 'state', m.state,
   'zip', m.zip, 'countyFips', m.county_fips, 'facts', m.facts, 'rank', m.rank, 'attempts', m.resolve_attempts) order by m.rank desc, m.ccn), '[]'::jsonb)
   into v_out from marked m;
 return v_out;
end; $$;

-- Server: what looking an agency up found.
--   {"outcome":"graduated","domain":"…","confirmation":"phone"|"name","evidence":[{"url":"https://<domain>/…","claim":"…"}]}
--   {"outcome":"unresolved","reason":"no_site"}  tried again in 7, then 30, then 90 days
--   {"outcome":"excluded","reason":"…"}          never tried again until the roster changes it
create function private.growth_roster_resolved(p_ccn text, p_data jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare t private.growth_roster_targets%rowtype; g private.growth_organizations%rowtype; v_domain text := lower(btrim(p_data ->> 'domain'));
 v_outcome text := p_data ->> 'outcome'; v_reason text := coalesce(nullif(p_data ->> 'reason', ''), 'no_site'); v_shared integer; v_opp uuid; e jsonb; v_host text;
begin
 perform private.require_hub_app_server(); perform pg_advisory_xact_lock(hashtextextended('growth.workflow', 0));
 if p_data is null or jsonb_typeof(p_data) <> 'object' or v_outcome not in ('graduated', 'unresolved', 'excluded') then
  raise exception 'Invalid roster outcome' using errcode = '22023';
 end if;
 select * into t from private.growth_roster_targets where ccn = p_ccn for update;
 if not found or t.status <> 'resolving' then raise exception 'Not an agency being looked up' using errcode = '22023'; end if;
 if v_reason !~ '^[a-z_]{1,40}$' then v_reason := 'no_site'; end if;
 if v_outcome = 'graduated' then
  if v_domain is null or v_domain !~ '^[a-z0-9][a-z0-9.-]+\.[a-z]{2,}$' or char_length(v_domain) > 253
    or coalesce(p_data ->> 'confirmation', '') not in ('phone', 'name')
    or jsonb_typeof(coalesce(p_data -> 'evidence', '[]')) <> 'array' or jsonb_array_length(coalesce(p_data -> 'evidence', '[]')) > 3 then
   raise exception 'Invalid roster outcome' using errcode = '22023';
  end if;
  select count(*) into v_shared from private.growth_roster_targets x join private.growth_organizations o on o.id = x.organization_id
   where o.domain = v_domain and x.status = 'graduated' and x.ccn <> t.ccn;
  if v_shared >= 3 and p_data ->> 'confirmation' <> 'phone' then
   v_outcome := 'unresolved'; v_reason := 'shared_host';
  else
   insert into private.growth_organizations(name, domain, discovered_at) values (left(t.name, 200), v_domain, now()) on conflict (domain) do nothing;
   select * into g from private.growth_organizations where domain = v_domain for update;
   if g.discovered_at is null then update private.growth_organizations set discovered_at = now() where id = g.id; end if;
   insert into private.growth_opportunities(organization_id, product) values (g.id, t.product) on conflict do nothing;
   select id into v_opp from private.growth_opportunities where organization_id = g.id and product = t.product;
   update private.growth_roster_targets set status = 'graduated', organization_id = g.id, confirmation = p_data ->> 'confirmation',
     reason = null, resolved_at = now(), resolve_after = null, updated_at = now() where ccn = t.ccn;
   perform private.growth_roster_evidence(t.ccn);
   -- What the agency's own website says it is, from the page the contact finder read (its own domain only).
   for e in select value from jsonb_array_elements(coalesce(p_data -> 'evidence', '[]')) loop
    v_host := lower(split_part(split_part(coalesce(e ->> 'url', ''), '://', 2), '/', 1));
    if coalesce(e ->> 'url', '') !~ '^https://' or char_length(e ->> 'url') > 2000 or v_host not in (v_domain, 'www.' || v_domain)
      or char_length(coalesce(e ->> 'claim', '')) not between 1 and 4000 then
     raise exception 'Website evidence must come from the agency''s own site' using errcode = '22023';
    end if;
    insert into private.growth_evidence(opportunity_id, source_url, claim, confidence, observed_at)
    values (v_opp, e ->> 'url', e ->> 'claim', 'medium', now())
    on conflict (opportunity_id, source_url, claim) do update set observed_at = excluded.observed_at;
   end loop;
   insert into private.audit_events(actor_id, action, entity_type, entity_id, metadata)
   values (null, 'growth.roster_resolved', 'growth', g.id, jsonb_build_object('ccn', t.ccn, 'confirmation', p_data ->> 'confirmation'));
   return jsonb_build_object('graduated', true, 'organizationId', g.id, 'opportunityId', v_opp,
     'contactReady', g.tenant_id is null and not g.internal);
  end if;
 end if;
 if v_outcome = 'excluded' then
  update private.growth_roster_targets set status = 'excluded', reason = v_reason, resolve_after = null, updated_at = now() where ccn = t.ccn;
  return jsonb_build_object('graduated', false, 'reason', v_reason);
 end if;
 -- "retry": the search or the website could not be reached just now, which says nothing about the agency: an hour, not a week.
 update private.growth_roster_targets set status = 'unresolved', reason = v_reason, updated_at = now(),
   resolve_after = now() + case when v_reason = 'retry' then interval '1 hour' when t.resolve_attempts <= 1 then interval '7 days'
     when t.resolve_attempts = 2 then interval '30 days' else interval '90 days' end
  where ccn = t.ccn;
 return jsonb_build_object('graduated', false, 'reason', v_reason);
end; $$;

-- Owner (Growth screen): where the roster read is, how many agencies are in each state of resolution, and a page of them, best first.
create function hub.growth_roster(p_offset integer default 0) returns jsonb
language plpgsql stable security definer set search_path = '' as $$ begin
 perform hub.authorize_app_admin();
 if p_offset is null or p_offset < 0 or p_offset > 100000 then raise exception 'Invalid page' using errcode = '22023'; end if;
 return jsonb_build_object(
  'sync', (select jsonb_build_object('period', s.period, 'states', to_jsonb(s.states), 'complete', s.complete, 'syncedAt', s.synced_at, 'rows', s.rows)
           from private.growth_roster_sync s),
  'counts', (select coalesce(jsonb_object_agg(status, n), '{}'::jsonb) from (select status, count(*) n from private.growth_roster_targets group by status) c),
  'total', (select count(*) from private.growth_roster_targets),
  'items', (select coalesce(jsonb_agg(jsonb_build_object('ccn', x.ccn, 'name', x.name, 'setting', x.setting, 'city', x.city, 'state', x.state,
      'rank', x.rank, 'reasons', to_jsonb(x.rank_reasons), 'status', x.status, 'reason', x.reason, 'attempts', x.resolve_attempts,
      'resolveAfter', x.resolve_after, 'confirmation', x.confirmation, 'domain', o.domain, 'organizationId', x.organization_id)
      order by x.status = 'graduated' desc, x.rank desc, x.ccn), '[]'::jsonb)
    from (select * from private.growth_roster_targets order by status = 'graduated' desc, rank desc, ccn offset p_offset limit 50) x
    left join private.growth_organizations o on o.id = x.organization_id));
end; $$;

revoke all on function private.growth_roster_source_url(), private.growth_roster_evidence(text) from public, anon, authenticated, service_role, hub_app_server;
revoke all on function private.growth_roster_sync_state(), private.growth_roster_sync_save(jsonb), private.growth_roster_upsert(text, jsonb),
  private.growth_roster_next(integer, integer), private.growth_roster_resolved(text, jsonb) from public, anon, authenticated, service_role;
grant execute on function private.growth_roster_sync_state(), private.growth_roster_sync_save(jsonb), private.growth_roster_upsert(text, jsonb),
  private.growth_roster_next(integer, integer), private.growth_roster_resolved(text, jsonb) to hub_app_server;
revoke all on function hub.growth_roster(integer) from public, anon, service_role;
grant execute on function hub.growth_roster(integer) to authenticated;

-- Every half hour the Marketing Manager reads the roster (weekly) and looks up the day's best agencies (server/growth/worker.mjs).
insert into private.agent_schedules (agent_key, task_kind, cadence, every_seconds, at_local, timezone, requires_session, next_run_at)
values ('marketing_manager', 'growth.roster', 'interval', 1800, null, 'America/New_York', false, now())
on conflict (agent_key, task_kind) do nothing;
