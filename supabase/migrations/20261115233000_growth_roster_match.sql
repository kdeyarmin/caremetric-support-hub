-- Each web-found prospect's own market report (owner decision 2026-11-15).
--
-- Every agency the Marketing Manager emails gets a link to its own market report on Intel, which the Hub signs by the agency's CMS
-- certification number (server/growth/report-link.mjs). A roster prospect carries its CCN in its public record
-- (20261113170500_growth_roster.sql). A prospect found by web search (growth.discovery) does not, and those are most of the pipeline.
-- This migration lets the Marketing Manager find their CCN through Intel's marketing feed (action agency_match: by a telephone number
-- the agency publishes on its own website, or by its name and place, and none when in doubt) and attach the agency's public CMS
-- record exactly as the roster does:
--
-- - private.growth_roster_matches: one row per organization tried: matching, matched or unmatched, why, how it matched, and when it
--   may be tried again. No telephone number, name or page text is stored;
-- - private.growth_roster_match_next: the day's prospects to match, best fit first, within a daily number (Eastern day): CareMetric
--   Intel opportunities the Marketing Manager owns in the open prospecting stages (identified, researched, qualified, contacted), on
--   their own domain, whose organization has no roster record yet. Each comes with the evidence the Hub already holds (search
--   snippets and the home page summary), which may name its place;
-- - private.growth_roster_match_record: what the match found. A match saves the agency as a roster target
--   (private.growth_roster_upsert, so its claim and rank are the roster's) and graduates it to the organization, which writes its
--   public record onto the organization's opportunities as high-confidence evidence (private.growth_roster_evidence). A CCN already
--   tied to another organization, one the roster excludes (closed, or CareMetric's own agency) or one being looked up right now is
--   not attached. No match: tried again in 30 days, then every 90; one the website or the feed could not answer: in an hour;
-- - the Marketing Manager's growth.match task, every hour, and one setting (Settings -> Customer growth): "Most web prospects to
--   match a day" (40). Matching uses Intel's feed, so it runs while "Find prospects from the Medicare roster" is on.
--
-- Nothing here sends anything, changes an agent's autonomy, or loosens a send check.
set local lock_timeout = '10s';

insert into private.hub_settings (key, kind) values
  ('growth.roster_match_daily', 'number')
on conflict (key) do nothing;

create table if not exists private.growth_roster_matches (
  organization_id uuid primary key references private.growth_organizations(id),
  status text not null default 'matching' check (status in ('matching', 'matched', 'unmatched')),
  reason text check (reason ~ '^[a-z_]{1,40}$'),
  ccn text check (ccn ~ '^[0-9A-Z]{6}$'),
  method text check (method in ('phone', 'name_place')),
  attempts integer not null default 0 check (attempts between 0 and 1000),
  started_at timestamptz,
  retry_after timestamptz,
  matched_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status = 'matched') = (ccn is not null and method is not null))
);
create index if not exists growth_roster_matches_started on private.growth_roster_matches (started_at);

alter table private.growth_roster_matches enable row level security;
revoke all on private.growth_roster_matches from public, anon, authenticated, service_role, hub_app_server;

-- Server: the next prospects to match, best fit first, within the daily number (Eastern day). Each is marked as being matched; one
-- left matching for an hour (a restart) is handed out again.
create or replace function private.growth_roster_match_next(p_limit integer, p_daily integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_used integer; v_left integer; v_out jsonb; begin
 perform private.require_hub_app_server(); perform pg_advisory_xact_lock(hashtextextended('growth.workflow', 0));
 if p_limit is null or p_limit < 1 or p_limit > 25 or p_daily is null or p_daily < 0 or p_daily > 200 then
  raise exception 'Invalid match request' using errcode = '22023';
 end if;
 select count(*) into v_used from private.growth_roster_matches where started_at >= private.agent_day_start();
 v_left := least(p_limit, greatest(p_daily - v_used, 0));
 if v_left = 0 then return '[]'::jsonb; end if;
 with picked as (
   select g.id, max(o.fit) as fit
     from private.growth_organizations g
     join private.growth_opportunities o on o.organization_id = g.id
     left join private.growth_roster_matches m on m.organization_id = g.id
    where not g.internal and g.tenant_id is null and g.domain !~ '\.invalid$'
      and o.product = 'caremetric-intel' and o.owner_agent = 'marketing_manager'
      and o.stage in ('identified', 'researched', 'qualified', 'contacted')
      and not exists (select 1 from private.growth_roster_targets t where t.organization_id = g.id)
      and not exists (select 1 from private.growth_evidence e where e.opportunity_id = o.id
                        and e.source_url = private.growth_roster_source_url() and e.claim like 'CMS Provider of Services file%')
      and (m.organization_id is null
           or (m.status = 'unmatched' and m.retry_after <= now())
           or (m.status = 'matching' and m.started_at < now() - interval '1 hour'))
    group by g.id
    order by max(o.fit) desc nulls last, g.id
    limit v_left),
 marked as (
   insert into private.growth_roster_matches as x (organization_id, status, attempts, started_at, updated_at)
   select id, 'matching', 1, now(), now() from picked
   on conflict (organization_id) do update set status = 'matching', attempts = x.attempts + 1, reason = null, started_at = now(), updated_at = now()
   returning x.organization_id)
 select coalesce(jsonb_agg(jsonb_build_object('organizationId', g.id, 'name', g.name, 'domain', g.domain,
     'evidence', coalesce((select jsonb_agg(left(e.claim, 1500) order by e.observed_at desc) from (
        select y.claim, y.observed_at from private.growth_evidence y join private.growth_opportunities z on z.id = y.opportunity_id
         where z.organization_id = g.id and z.product = 'caremetric-intel' and y.source_url <> private.growth_roster_source_url()
         order by y.observed_at desc limit 8) e), '[]'::jsonb))
   order by p.fit desc nulls last, g.id), '[]'::jsonb)
   into v_out
   from marked k join picked p on p.id = k.organization_id join private.growth_organizations g on g.id = k.organization_id;
 return v_out;
end; $$;

-- Server: what matching one prospect found.
--   {"outcome":"matched","method":"phone"|"name_place","period":"2026Q3","row":{...the roster row for the CCN (roster.mjs rosterRow)}}
--   {"outcome":"unmatched","reason":"ambiguous"}   tried again in 30 days, then every 90; "retry": in an hour
create or replace function private.growth_roster_match_record(p_org uuid, p_data jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare m private.growth_roster_matches%rowtype; t private.growth_roster_targets%rowtype; g private.growth_organizations%rowtype;
 v_outcome text := p_data ->> 'outcome'; v_reason text := coalesce(nullif(p_data ->> 'reason', ''), 'not_found');
 v_method text := p_data ->> 'method'; v_period text := p_data ->> 'period'; v_row jsonb := p_data -> 'row'; v_ccn text;
begin
 perform private.require_hub_app_server(); perform pg_advisory_xact_lock(hashtextextended('growth.workflow', 0));
 if p_data is null or jsonb_typeof(p_data) <> 'object' or coalesce(v_outcome, '') not in ('matched', 'unmatched') then
  raise exception 'Invalid match outcome' using errcode = '22023';
 end if;
 select * into m from private.growth_roster_matches where organization_id = p_org for update;
 if not found or m.status <> 'matching' then raise exception 'Not a prospect being matched' using errcode = '22023'; end if;
 if v_reason !~ '^[a-z_]{1,40}$' then v_reason := 'not_found'; end if;
 if v_outcome = 'matched' then
  if coalesce(v_method, '') not in ('phone', 'name_place') or jsonb_typeof(v_row) is distinct from 'object'
    or coalesce(v_period, '') !~ '^[0-9]{4}Q[1-4]$' or coalesce(v_row ->> 'ccn', '') !~ '^[0-9A-Z]{6}$' then
   raise exception 'Invalid match outcome' using errcode = '22023';
  end if;
  v_ccn := v_row ->> 'ccn';
  select * into g from private.growth_organizations where id = p_org;
  if g.internal or g.tenant_id is not null then
   v_reason := 'not_prospect';
  elsif exists (select 1 from private.growth_roster_targets where organization_id = p_org) then
   v_reason := 'already_linked';
  else
   -- The agency's public record, saved as the roster saves it: a graduated or excluded target keeps its state.
   perform private.growth_roster_upsert(v_period, jsonb_build_array(v_row));
   select * into t from private.growth_roster_targets where ccn = v_ccn for update;
   if t.status = 'graduated' then v_reason := 'other_organization';
   elsif t.status = 'excluded' then v_reason := 'excluded';
   elsif t.status = 'resolving' then v_reason := 'retry';
   else
    update private.growth_roster_targets set status = 'graduated', organization_id = p_org,
      confirmation = case when v_method = 'phone' then 'phone' else 'name' end, reason = null, resolved_at = now(), resolve_after = null,
      updated_at = now()
     where ccn = v_ccn;
    perform private.growth_roster_evidence(v_ccn);
    update private.growth_roster_matches set status = 'matched', ccn = v_ccn, method = v_method, reason = null, matched_at = now(),
      retry_after = null, updated_at = now()
     where organization_id = p_org;
    insert into private.audit_events(actor_id, action, entity_type, entity_id, metadata)
    values (null, 'growth.roster_matched', 'growth', p_org, jsonb_build_object('ccn', v_ccn, 'method', v_method));
    return jsonb_build_object('matched', true, 'ccn', v_ccn);
   end if;
  end if;
 end if;
 update private.growth_roster_matches set status = 'unmatched', reason = v_reason, ccn = null, method = null, updated_at = now(),
   retry_after = now() + case when v_reason = 'retry' then interval '1 hour' when m.attempts <= 1 then interval '30 days' else interval '90 days' end
  where organization_id = p_org;
 return jsonb_build_object('matched', false, 'reason', v_reason);
end; $$;

revoke all on function private.growth_roster_match_next(integer, integer), private.growth_roster_match_record(uuid, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function private.growth_roster_match_next(integer, integer), private.growth_roster_match_record(uuid, jsonb) to hub_app_server;

-- Every hour the Marketing Manager matches a few web-found prospects (server/growth/agency-match.mjs).
insert into private.agent_schedules (agent_key, task_kind, cadence, every_seconds, at_local, timezone, requires_session, next_run_at)
values ('marketing_manager', 'growth.match', 'interval', 3600, null, 'America/New_York', false, now())
on conflict (agent_key, task_kind) do nothing;
