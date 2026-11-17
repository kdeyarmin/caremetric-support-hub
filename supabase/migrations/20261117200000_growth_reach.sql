-- Growth reach (AI workforce review 2026-11-17, stage 3; docs/AI_WORKFORCE_REVIEW_2026-11-17.md). The owner's decisions of 2026-11-17:
-- reach agencies under pressure first, use only a website the code confirms, and run a live writing evaluation each Monday.
--
-- 1. Settings (Settings -> Customer growth): "Search the web for roster agencies not found" (growth.roster_site_research, off), "Most
--    agencies to search the web for a day" (growth.roster_site_research_per_day, 10), "Most to spend on one website search"
--    (growth.roster_site_research_cents, 10) and "Run a live writing evaluation each Monday" (growth.live_evaluation, off).
-- 2. Websites: for a roster agency the name and phone searches did not find, a web search proposes up to two sites; one is used only when
--    the usual code checks confirm it (the CMS phone number on the site, or its name and place), through the same
--    private.growth_roster_resolved as a lookup. An unconfirmed suggestion is only shown on Growth (site_suggestions). The picker
--    (private.growth_roster_site_next), the recorder (private.growth_roster_site_record) and an hourly growth.sites schedule.
-- 3. The Monday live writing evaluation: twelve made-up Intel agencies written to on the real writer and scored by the reader; each grade is
--    kept as it is written (private.growth_live_eval_cases, closed to every role, 120 days), the result is recorded as growth.live.1 (never
--    growth.1, so it never holds up sending) and read back for the scorecard. A daily 06:50 Eastern growth.evaluate_live schedule; the
--    server runs it on Mondays.
-- 4. Ranking under pressure needs no SQL: the roster read keeps the new figures in each target's facts and ranks with them.
--
-- Nothing is sent by this migration. 20261117200100_growth_reach_contract.sql declares platform.agents.growth-reach.v1.
set local lock_timeout = '10s';

insert into private.hub_settings (key, kind) values
  ('growth.roster_site_research', 'flag'), ('growth.roster_site_research_per_day', 'number'), ('growth.roster_site_research_cents', 'number'),
  ('growth.live_evaluation', 'flag')
on conflict (key) do nothing;

-- ---- A web search for roster agencies not found -------------------------------------------------------------------------------------

-- The roster agencies the name and phone searches did not find (66 on 2026-11-16) get a web search by the Marketing Manager
-- (`growth.sites`, server/growth/site-search.mjs; Settings → Customer growth → "Search the web for roster agencies not found", "Most
-- agencies to search the web for a day", "Most to spend on one website search"). Only a site the code confirms (the CMS telephone number
-- on its pages, or the agency's name and place on its home page) is used, through private.growth_roster_resolved as for a lookup; an
-- unconfirmed candidate is kept only as a suggestion the Growth screen shows (owner decision 2026-11-16). Nothing is sent to it.
alter table private.growth_roster_targets add column if not exists site_search_started_at timestamptz;
alter table private.growth_roster_targets add column if not exists site_searched_at timestamptz;
alter table private.growth_roster_targets add column if not exists site_suggestions text[] not null default '{}';
do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'private.growth_roster_targets'::regclass and conname = 'growth_roster_targets_site_suggestions_check') then
    alter table private.growth_roster_targets add constraint growth_roster_targets_site_suggestions_check
      check (cardinality(site_suggestions) <= 2);
  end if;
end $$;

-- Server: up to `p_limit` agencies to search the web for, within the day's number (counted by when each search was handed out, the
-- Eastern day): unresolved for no site or an unconfirmed one, in the roster's current read, not searched in 30 days and not handed out in
-- the last hour (a search that failed lapses), the never-searched first, then by rank. Each is handed out once.
create or replace function private.growth_roster_site_next(p_limit integer, p_daily integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s private.growth_roster_sync%rowtype; v_used integer; v_left integer; v_out jsonb; begin
 perform private.require_hub_app_server(); perform pg_advisory_xact_lock(hashtextextended('growth.workflow', 0));
 if p_limit is null or p_limit < 1 or p_limit > 10 or p_daily is null or p_daily < 0 or p_daily > 50 then
  raise exception 'Invalid website search request' using errcode = '22023';
 end if;
 select * into s from private.growth_roster_sync;
 select count(*) into v_used from private.growth_roster_targets where site_search_started_at >= private.agent_day_start();
 v_left := least(p_limit, greatest(p_daily - v_used, 0));
 if v_left = 0 or s.period is null or cardinality(s.states) = 0 then return '[]'::jsonb; end if;
 with picked as (
   select ccn from private.growth_roster_targets
    where period = s.period and state = any(s.states) and status = 'unresolved' and reason in ('no_site', 'not_confirmed')
      and (site_searched_at is null or site_searched_at < now() - interval '30 days')
      and (site_search_started_at is null or site_search_started_at < now() - interval '1 hour')
    order by site_searched_at nulls first, rank desc, ccn limit v_left for update skip locked),
 marked as (
   update private.growth_roster_targets t set site_search_started_at = now(), updated_at = now()
     from picked where t.ccn = picked.ccn returning t.*)
 select coalesce(jsonb_agg(jsonb_build_object('ccn', m.ccn, 'name', m.name, 'setting', m.setting, 'city', m.city, 'state', m.state,
   'zip', m.zip, 'facts', m.facts, 'rank', m.rank, 'reason', m.reason) order by m.site_searched_at nulls first, m.rank desc, m.ccn), '[]'::jsonb)
   into v_out from marked m;
 return v_out;
end; $$;
revoke all on function private.growth_roster_site_next(integer, integer) from public, anon, authenticated, service_role;
grant execute on function private.growth_roster_site_next(integer, integer) to hub_app_server;

-- Server: what one agency's web search found. 'graduated' (a site the code confirmed: domain, confirmation phone or name, at most three
-- pieces of evidence from its own pages) goes through private.growth_roster_resolved exactly as a lookup's, only while the agency is still
-- unresolved (a lookup that took it meanwhile wins: 'changed'). 'unresolved' keeps at most two suggested domains for the Growth screen.
-- Either way the agency is not searched again for 30 days.
create or replace function private.growth_roster_site_record(p_ccn text, p_data jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare t private.growth_roster_targets%rowtype; v_outcome text := p_data ->> 'outcome'; v_out jsonb; v_suggestions text[] := '{}'; v text; begin
 perform private.require_hub_app_server(); perform pg_advisory_xact_lock(hashtextextended('growth.workflow', 0));
 if p_data is null or jsonb_typeof(p_data) <> 'object' or v_outcome not in ('graduated', 'unresolved') then
  raise exception 'Invalid website search outcome' using errcode = '22023';
 end if;
 select * into t from private.growth_roster_targets where ccn = p_ccn for update;
 if not found or t.site_search_started_at is null then raise exception 'Not an agency being searched' using errcode = '22023'; end if;
 if v_outcome = 'graduated' then
  if t.status <> 'unresolved' then
   update private.growth_roster_targets set site_searched_at = now(), updated_at = now() where ccn = t.ccn;
   return jsonb_build_object('graduated', false, 'reason', 'changed');
  end if;
  update private.growth_roster_targets set status = 'resolving', updated_at = now() where ccn = t.ccn;
  v_out := private.growth_roster_resolved(t.ccn, (p_data - 'suggestions') || jsonb_build_object('outcome', 'graduated'));
  update private.growth_roster_targets set site_searched_at = now(), site_suggestions = '{}', updated_at = now() where ccn = t.ccn;
  insert into private.audit_events(actor_id, action, entity_type, metadata)
  values (null, 'growth.roster_site_searched', 'growth', jsonb_build_object('ccn', t.ccn, 'graduated', coalesce((v_out ->> 'graduated')::boolean, false)));
  return v_out;
 end if;
 if jsonb_typeof(coalesce(p_data -> 'suggestions', '[]')) <> 'array' or jsonb_array_length(coalesce(p_data -> 'suggestions', '[]')) > 2 then
  raise exception 'Invalid website search outcome' using errcode = '22023';
 end if;
 for v in select lower(btrim(value)) from jsonb_array_elements_text(coalesce(p_data -> 'suggestions', '[]')) loop
  if v !~ '^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$' or char_length(v) > 253 then raise exception 'Invalid suggested website' using errcode = '22023'; end if;
  if not (v = any(v_suggestions)) then v_suggestions := v_suggestions || v; end if;
 end loop;
 update private.growth_roster_targets set site_searched_at = now(), site_suggestions = v_suggestions, updated_at = now() where ccn = t.ccn;
 insert into private.audit_events(actor_id, action, entity_type, metadata)
 values (null, 'growth.roster_site_searched', 'growth', jsonb_build_object('ccn', t.ccn, 'graduated', false, 'suggested', cardinality(v_suggestions)));
 return jsonb_build_object('graduated', false, 'reason', 'not_confirmed', 'suggested', cardinality(v_suggestions));
end; $$;
revoke all on function private.growth_roster_site_record(text, jsonb) from public, anon, authenticated, service_role;
grant execute on function private.growth_roster_site_record(text, jsonb) to hub_app_server;

-- The Growth screen shows when an agency was last searched for on the web and the sites suggested but not confirmed.
do $$
declare d text := pg_get_functiondef('hub.growth_roster(integer)'::regprocedure);
begin
  if position('''suggested''' in d) > 0 then return; end if;
  if position($q$'confirmation', x.confirmation, 'domain', o.domain, 'organizationId', x.organization_id)$q$ in d) = 0 then
    raise exception 'The roster read changed; update this migration' using errcode = '55000';
  end if;
  execute replace(d, $q$'confirmation', x.confirmation, 'domain', o.domain, 'organizationId', x.organization_id)$q$,
    $q$'confirmation', x.confirmation, 'domain', o.domain, 'organizationId', x.organization_id,
      'siteSearchedAt', x.site_searched_at, 'suggested', to_jsonb(x.site_suggestions))$q$);
end $$;

-- Every hour, so the day's number is spread over the day; each run searches at most two agencies.
insert into private.agent_schedules (agent_key, task_kind, cadence, every_seconds, at_local, timezone, requires_session, next_run_at)
values ('marketing_manager', 'growth.sites', 'interval', 3600, null, 'America/New_York', false, now())
on conflict (agent_key, task_kind) do nothing;

-- ---- The live writing evaluation (Settings → Customer growth → Run a live writing evaluation each Monday) ------------------------------

-- Each Monday twelve made-up CareMetric Intel agencies are written to on the real writer and read by the reader (server/growth/
-- live-evaluation.mjs). One task cannot write all twelve inside the scheduler's four minutes, so each case's grade is kept here as it is
-- written, by the run it belongs to ('week:<Monday>' for the scheduled run, 'run:<task id>' for Run now), and the task comes back for
-- the rest. Grades only: the kind of case, whether the draft passed the checks, the reader's would-reply score and weakness code, never
-- an email's words. The finished run is recorded as private.agent_evaluations version 'growth.live.1', which the send claim never reads
-- (it reads 'growth.1'), so a weak week never holds up sending. Kept 120 days.
create table if not exists private.growth_live_eval_cases (
  run_key text not null check (run_key ~ '^(week:[0-9]{4}-[0-9]{2}-[0-9]{2}|run:[0-9a-f-]{36})$'),
  case_key text not null check (case_key ~ '^[a-z_.]{1,60}$'),
  result jsonb not null check (jsonb_typeof(result) = 'object' and pg_column_size(result) <= 2000),
  created_at timestamptz not null default now(),
  primary key (run_key, case_key)
);
alter table private.growth_live_eval_cases enable row level security;
revoke all on private.growth_live_eval_cases from public, anon, authenticated, service_role, hub_app_server;

-- Server: what one run has already graded, and the Intel policy the cases are written under (its approved claim, touches and
-- experiments), so the live evaluation writes exactly as the sweep would.
create or replace function private.growth_live_eval_state(p_run text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$ begin
 perform private.require_hub_app_server();
 if p_run is null or p_run !~ '^(week:[0-9]{4}-[0-9]{2}-[0-9]{2}|run:[0-9a-f-]{36})$' then raise exception 'Invalid run' using errcode = '22023'; end if;
 return jsonb_build_object(
   'cases', coalesce((select jsonb_agg(jsonb_build_object('key', c.case_key, 'result', c.result) order by c.created_at, c.case_key)
     from private.growth_live_eval_cases c where c.run_key = p_run), '[]'::jsonb),
   'policy', (select jsonb_build_object('enabled', p.enabled, 'approvedClaim', p.approved_claim, 'maxTouches', p.max_touches,
       'experiment', p.experiment_enabled, 'version', p.version)
     from private.growth_policies p where p.product = 'caremetric-intel'));
end; $$;
revoke all on function private.growth_live_eval_state(text) from public, anon, authenticated, service_role;
grant execute on function private.growth_live_eval_state(text) to hub_app_server;

-- Server: one case's grade, once (a case already graded for the run keeps its first grade). Returns whether it was recorded.
create or replace function private.growth_live_eval_record(p_run text, p_case text, p_result jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$ begin
 perform private.require_hub_app_server();
 if p_run is null or p_run !~ '^(week:[0-9]{4}-[0-9]{2}-[0-9]{2}|run:[0-9a-f-]{36})$' or p_case is null or p_case !~ '^[a-z_.]{1,60}$'
   or jsonb_typeof(p_result) is distinct from 'object' or pg_column_size(p_result) > 2000 then
  raise exception 'Invalid case' using errcode = '22023';
 end if;
 delete from private.growth_live_eval_cases where created_at < now() - interval '120 days';
 insert into private.growth_live_eval_cases (run_key, case_key, result) values (p_run, p_case, p_result) on conflict (run_key, case_key) do nothing;
 return found;
end; $$;
revoke all on function private.growth_live_eval_record(text, text, jsonb) from public, anon, authenticated, service_role;
grant execute on function private.growth_live_eval_record(text, text, jsonb) to hub_app_server;

-- Server, for the Monday scorecard: the latest live evaluation of CareMetric Intel recorded since `p_since`, or null.
create or replace function private.growth_live_evaluation_latest(p_since timestamptz) returns jsonb
language plpgsql stable security definer set search_path = '' as $$ begin
 perform private.require_hub_app_server();
 if p_since is null then raise exception 'Invalid time' using errcode = '22023'; end if;
 return (select jsonb_build_object('passed', e.passed, 'at', e.created_at, 'results', e.results)
   from private.agent_evaluations e
  where e.product = 'caremetric-intel' and e.version = 'growth.live.1' and e.created_at >= p_since
  order by e.created_at desc limit 1);
end; $$;
revoke all on function private.growth_live_evaluation_latest(timestamptz) from public, anon, authenticated, service_role;
grant execute on function private.growth_live_evaluation_latest(timestamptz) to hub_app_server;

-- Every morning at 06:50 Eastern; the task does its work on Mondays (or when the owner presses Run now), before the weekly strategist
-- (07:35) and the scorecard (07:50) that report it.
insert into private.agent_schedules (agent_key, task_kind, cadence, every_seconds, at_local, timezone, requires_session, next_run_at)
values ('marketing_manager', 'growth.evaluate_live', 'daily', null, '06:50', 'America/New_York', false,
  private.agent_schedule_next('daily', null, '06:50', 'America/New_York', now(), null))
on conflict (agent_key, task_kind) do nothing;
