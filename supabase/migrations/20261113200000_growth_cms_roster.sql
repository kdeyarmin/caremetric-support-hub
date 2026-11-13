-- A second discovery source: the CMS roster (review 2026-11-12, finding P1 "One discovery source").
--
-- Every Medicare-certified home health agency and hospice is in CMS's Provider of Services file, which Intel serves to the Hub
-- (Intel's POST /api/hub/marketing-feed, action roster). Each daily discovery run now reads the agencies in Intel's market states that
-- CMS shows as newly certified or under new owners in the last 18 months, and spends at most ten searches an Eastern day looking for
-- their own websites (server/growth/roster-discovery.mjs). An agency matched to its site is recorded through
-- private.growth_discover, unchanged, as a CareMetric Intel prospect.
--
-- This migration adds:
--
-- - the setting growth.cms_roster ("Find prospects in the CMS roster" under Settings -> Customer growth), a switch, on by default:
--   nothing is read until the shared secret is also set on both services;
-- - private.growth_roster_searches: one row per CMS certification number (CCN) searched, when, and whether a website was matched.
--   Public CMS identifiers only, at most ten new rows a day. A matched agency is never searched again; one with no site found is
--   searched again after 180 days, since a new agency often has no website yet;
-- - private.growth_roster_due(ccns, at): which of the CCNs may be searched at that moment, in the order given, and how many CCNs were
--   searched since that Eastern day began (so a second run on the same day keeps to the day's ten). No role may execute it;
-- - private.growth_roster_pending(ccns) and private.growth_roster_searched(ccn, matched): the Hub server's two calls, for the
--   hub_app_server role only.
--
-- No existing table, function, grant or declared feature changes. Until this is applied the server's roster step finds no function,
-- reports database_not_ready in the discovery run's result and searches nothing; the rest of the run is unaffected.
set local lock_timeout = '10s';

insert into private.hub_settings (key, kind) values
  ('growth.cms_roster', 'flag')
on conflict (key) do nothing;

create table if not exists private.growth_roster_searches (
  ccn text primary key check (ccn ~ '^[0-9A-Z]{6}$'),
  searched_at timestamptz not null default now(),
  matched boolean not null
);
alter table private.growth_roster_searches enable row level security;
revoke all on private.growth_roster_searches from public, anon, authenticated, service_role, hub_app_server;

create or replace function private.growth_roster_due(p_ccns text[], p_at timestamptz) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'due', coalesce((
      select jsonb_agg(c.ccn order by c.first)
      from (select u.ccn, min(u.position) as first from unnest(p_ccns) with ordinality as u(ccn, position)
            where u.ccn ~ '^[0-9A-Z]{6}$' group by u.ccn) c
      where not exists (select 1 from private.growth_roster_searches s
                        where s.ccn = c.ccn and (s.matched or s.searched_at > p_at - interval '180 days'))), '[]'::jsonb),
    'searchedToday', (select count(*)::integer from private.growth_roster_searches s
      where s.searched_at >= (date_trunc('day', p_at at time zone 'America/New_York') at time zone 'America/New_York')
        and s.searched_at <= p_at));
$$;
revoke all on function private.growth_roster_due(text[], timestamptz) from public, anon, authenticated, service_role, hub_app_server;

create or replace function private.growth_roster_pending(p_ccns text[]) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_hub_app_server();
  if p_ccns is null or cardinality(p_ccns) > 5000 then raise exception 'Invalid roster list' using errcode = '22023'; end if;
  return private.growth_roster_due(p_ccns, now());
end; $$;

create or replace function private.growth_roster_searched(p_ccn text, p_matched boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_hub_app_server();
  if p_ccn is null or p_ccn !~ '^[0-9A-Z]{6}$' or p_matched is null then raise exception 'Invalid roster search' using errcode = '22023'; end if;
  insert into private.growth_roster_searches as s (ccn, searched_at, matched) values (p_ccn, now(), p_matched)
  on conflict (ccn) do update set searched_at = excluded.searched_at, matched = s.matched or excluded.matched;
end; $$;

revoke all on function private.growth_roster_pending(text[]), private.growth_roster_searched(text, boolean)
  from public, anon, authenticated, service_role;
grant execute on function private.growth_roster_pending(text[]), private.growth_roster_searched(text, boolean) to hub_app_server;

do $$
declare r text;
begin
  if not exists (select 1 from private.hub_settings where key = 'growth.cms_roster' and kind = 'flag') then
    raise exception 'The CMS roster setting is missing' using errcode = '55000';
  end if;
  if not exists (select 1 from pg_class where oid = 'private.growth_roster_searches'::regclass and relrowsecurity) then
    raise exception 'The CMS roster memory is not protected' using errcode = '55000';
  end if;
  foreach r in array array['private.growth_roster_pending(text[])', 'private.growth_roster_searched(text,boolean)'] loop
    if not exists (select 1 from pg_proc where oid = r::regprocedure and prosecdef and proconfig @> array['search_path=""']
                     and prosrc like '%require_hub_app_server%')
       or not has_function_privilege('hub_app_server', r, 'execute') then
      raise exception '% is not a server-only function', r using errcode = '55000';
    end if;
  end loop;
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if has_function_privilege(r, 'private.growth_roster_pending(text[])', 'execute')
       or has_function_privilege(r, 'private.growth_roster_searched(text,boolean)', 'execute')
       or has_function_privilege(r, 'private.growth_roster_due(text[],timestamptz)', 'execute')
       or has_table_privilege(r, 'private.growth_roster_searches', 'select') then
      raise exception 'The CMS roster memory is exposed to %', r using errcode = '55000';
    end if;
  end loop;
  if has_function_privilege('hub_app_server', 'private.growth_roster_due(text[],timestamptz)', 'execute')
     or has_table_privilege('hub_app_server', 'private.growth_roster_searches', 'select') then
    raise exception 'The CMS roster memory is readable outside its two server calls' using errcode = '55000';
  end if;
end $$;
