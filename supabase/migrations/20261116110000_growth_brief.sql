-- An account brief for every CareMetric Intel agency before it is written to (owner decision 2026-11-16,
-- docs/AI_WORKFORCE_REVIEW_2026-11-16.md).
--
-- Why. The writer saw about four web snippets per agency, and the research step (growth.research) only ever looked at borderline
-- prospects, never the ones about to be emailed. The Hub can now gather what Intel knows about each agency (its market report as data,
-- through the marketing feed's agency_brief action), the county figures for its own setting, the dated triggers web research finds and
-- the leaders already found, and have the quality model write one brief per agency.
--
-- 1. Settings (Settings -> Customer growth): "Write an account brief before the first email" (growth.account_brief, off), "Most
--    account briefs a day" (growth.brief_per_day, 25 until saved) and "Most to spend on one account brief" (growth.brief_cents, 60).
-- 2. private.growth_briefs: one brief per opportunity, in two parts kept apart. `writer` is what the email writer may read (what the
--    agency is, where, its dated triggers with their evidence ids, its leaders, likely pains, the angle, a cited opening sentence and
--    one county figure for its own setting). `research` is for the owner and the team only (the agency's own share, rank, ratings and
--    the fit the brief judged): an email never states those (the owner's rule), so the writer never sees them.
-- 3. private.growth_brief_next: the day's next agency to brief, within the daily number (Eastern day): CareMetric Intel opportunities
--    the Marketing Manager owns, researched or qualified, never yet emailed, not briefed in 30 days. Qualified agencies with a permitted
--    contact first (they are about to be written to), then the best fit, then agencies the Medicare roster confirmed.
-- 4. private.growth_brief_save writes the brief; private.growth_brief_writer reads its writer part for a draft; hub.growth_brief shows
--    both parts to the owner on Growth.
-- 5. Two more settings for the first email written from the brief (server/growth/draft.mjs): "Write first emails on the top model"
--    (growth.quality_writer, off) and "Have a reader review each first email" (growth.draft_critic, off).
-- 6. The Marketing Manager's daily model budget is raised to $15 (owner decision 2026-11-16: briefs, first emails and the reader's
--    review on the quality tier, about 45 cents an agency). Raised only, never lowered; nothing spends it until the settings are on.
--
-- Nothing is sent by this migration, and nothing here changes a send check. 20261116110100_growth_brief_contract.sql declares
-- platform.agents.growth-brief.v1, and the server writes briefs only once it is declared.
set local lock_timeout = '10s';

insert into private.hub_settings (key, kind) values
  ('growth.account_brief', 'flag'),
  ('growth.brief_per_day', 'number'),
  ('growth.brief_cents', 'number'),
  ('growth.quality_writer', 'flag'),
  ('growth.draft_critic', 'flag')
on conflict (key) do nothing;

update private.agents set daily_budget_cents = 1500, updated_at = now() where key = 'marketing_manager' and daily_budget_cents < 1500;

create table if not exists private.growth_briefs (
  opportunity_id uuid primary key references private.growth_opportunities(id) on delete cascade,
  version integer not null default 1 check (version between 1 and 100000),
  writer jsonb not null check (jsonb_typeof(writer) = 'object' and pg_column_size(writer) <= 12000),
  research jsonb not null default '{}'::jsonb check (jsonb_typeof(research) = 'object' and pg_column_size(research) <= 24000),
  model text not null check (model ~ '^[a-z0-9.-]{1,60}$'),
  prompt_version text not null check (prompt_version ~ '^[a-z0-9.-]{1,40}$'),
  cost_cents numeric not null default 0 check (cost_cents >= 0 and cost_cents <= 10000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table private.growth_briefs enable row level security;
revoke all on private.growth_briefs from public, anon, authenticated, service_role, hub_app_server;

-- Briefs started (claimed) per Eastern day, so the daily number holds across replicas and failed runs.
create table if not exists private.growth_brief_log (
  id uuid primary key default gen_random_uuid(),
  opportunity_id uuid not null references private.growth_opportunities(id) on delete cascade,
  started_at timestamptz not null default now()
);
create index if not exists growth_brief_log_started on private.growth_brief_log(started_at);
alter table private.growth_brief_log enable row level security;
revoke all on private.growth_brief_log from public, anon, authenticated, service_role, hub_app_server;

-- Server: the next agency to brief, with what the Hub already knows about it, or null. Counts against the day's number when handed out.
create or replace function private.growth_brief_next(p_daily integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_used integer; v_pick record; begin
 perform private.require_hub_app_server(); perform pg_advisory_xact_lock(hashtextextended('growth.workflow', 0));
 if p_daily is null or p_daily < 0 or p_daily > 200 then raise exception 'Invalid daily number' using errcode = '22023'; end if;
 select count(*) into v_used from private.growth_brief_log where started_at >= private.agent_day_start();
 if v_used >= p_daily then return null; end if;
 select o.id, o.organization_id, o.product, o.fit, o.stage, g.name, g.domain into v_pick
   from private.growth_opportunities o join private.growth_organizations g on g.id = o.organization_id
  where o.owner_agent = 'marketing_manager' and o.product = 'caremetric-intel' and o.stage in ('researched', 'qualified')
    and not g.internal and g.tenant_id is null and g.domain !~ '\.invalid$'
    and (o.fit is null or o.fit >= 60 or exists (select 1 from private.growth_roster_targets t where t.organization_id = g.id))
    and not exists (select 1 from private.growth_messages m where m.opportunity_id = o.id and m.purpose = 'marketing' and m.attempted_at is not null)
    and not exists (select 1 from private.growth_brief_log l where l.opportunity_id = o.id and l.started_at > now() - interval '30 days')
  order by (o.stage = 'qualified' and exists (select 1 from private.growth_contacts c where c.id = o.contact_id and c.eligibility = 'permitted')) desc,
           o.fit desc nulls last,
           exists (select 1 from private.growth_roster_targets t where t.organization_id = g.id) desc,
           o.updated_at, o.id
  limit 1;
 if not found then return null; end if;
 insert into private.growth_brief_log(opportunity_id) values (v_pick.id);
 return jsonb_build_object('id', v_pick.id, 'organizationId', v_pick.organization_id, 'product', v_pick.product, 'fit', v_pick.fit, 'stage', v_pick.stage,
   'name', v_pick.name, 'domain', v_pick.domain,
   'agencies', coalesce((select jsonb_agg(jsonb_build_object('ccn', t.ccn, 'name', t.name, 'setting', t.setting, 'city', t.city, 'state', t.state,
       'countyFips', t.county_fips) order by t.rank desc nulls last, t.ccn)
     from private.growth_roster_targets t where t.organization_id = v_pick.organization_id), '[]'::jsonb),
   'evidence', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'claim', left(e.claim, 1200), 'sourceUrl', e.source_url, 'observedAt', e.observed_at) order by e.observed_at desc)
     from (select * from private.growth_evidence where opportunity_id = v_pick.id order by observed_at desc limit 16) e), '[]'::jsonb),
   'people', coalesce((select jsonb_agg(jsonb_build_object('name', p.name, 'title', p.title, 'source', p.source) order by p.created_at)
     from (select * from private.growth_people where organization_id = v_pick.organization_id order by created_at limit 12) p), '[]'::jsonb));
end; $$;
revoke all on function private.growth_brief_next(integer) from public, anon, authenticated, service_role;
grant execute on function private.growth_brief_next(integer) to hub_app_server;

-- Server: the brief for one opportunity, replacing an earlier one. Both parts are objects within their size limits.
create or replace function private.growth_brief_save(p_opportunity uuid, p_brief jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_version integer; begin
 perform private.require_hub_app_server(); perform pg_advisory_xact_lock(hashtextextended('growth.workflow', 0));
 if jsonb_typeof(p_brief -> 'writer') is distinct from 'object' or jsonb_typeof(coalesce(p_brief -> 'research', '{}'::jsonb)) is distinct from 'object' then
  raise exception 'Invalid brief' using errcode = '22023';
 end if;
 if not exists (select 1 from private.growth_opportunities where id = p_opportunity) then raise exception 'Unknown opportunity' using errcode = '22023'; end if;
 insert into private.growth_briefs(opportunity_id, writer, research, model, prompt_version, cost_cents)
 values (p_opportunity, p_brief -> 'writer', coalesce(p_brief -> 'research', '{}'::jsonb), p_brief ->> 'model', p_brief ->> 'promptVersion',
         least(greatest(coalesce((p_brief ->> 'costCents')::numeric, 0), 0), 10000))
 on conflict (opportunity_id) do update set version = private.growth_briefs.version + 1, writer = excluded.writer, research = excluded.research,
   model = excluded.model, prompt_version = excluded.prompt_version, cost_cents = excluded.cost_cents, updated_at = now()
 returning version into v_version;
 insert into private.audit_events(actor_id, action, entity_type, entity_id, metadata)
 values (null, 'growth.brief_written', 'growth', (select organization_id from private.growth_opportunities where id = p_opportunity),
   jsonb_build_object('opportunity', p_opportunity, 'version', v_version));
 return jsonb_build_object('version', v_version);
end; $$;
revoke all on function private.growth_brief_save(uuid, jsonb) from public, anon, authenticated, service_role;
grant execute on function private.growth_brief_save(uuid, jsonb) to hub_app_server;

-- Server: the writer part of an opportunity's brief, for a draft, or null. Never the research part.
create or replace function private.growth_brief_writer(p_opportunity uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$ begin
 perform private.require_hub_app_server();
 return (select writer || jsonb_build_object('briefVersion', version) from private.growth_briefs where opportunity_id = p_opportunity);
end; $$;
revoke all on function private.growth_brief_writer(uuid) from public, anon, authenticated, service_role;
grant execute on function private.growth_brief_writer(uuid) to hub_app_server;

-- The owner: an opportunity's brief, both parts.
create or replace function hub.growth_brief(p_opportunity uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$ begin
 perform hub.authorize_app_admin();
 return (select jsonb_build_object('version', version, 'writer', writer, 'research', research, 'model', model, 'promptVersion', prompt_version,
   'costCents', cost_cents, 'updatedAt', updated_at) from private.growth_briefs where opportunity_id = p_opportunity);
end; $$;
revoke all on function hub.growth_brief(uuid) from public, anon, service_role;
grant execute on function hub.growth_brief(uuid) to authenticated;

insert into private.agent_schedules (agent_key, task_kind, cadence, every_seconds, at_local, timezone, requires_session, next_run_at)
values ('marketing_manager', 'growth.brief', 'interval', 1200, null, 'America/New_York', false, now())
on conflict (agent_key, task_kind) do nothing;
