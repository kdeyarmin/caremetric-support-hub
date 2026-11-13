-- Paid ads build-out (owner decision 2026-11-13: LinkedIn, Meta and Google search). Everything here starts off or paused:
--
-- - New campaigns: `social.campaign_create` (a LinkedIn or Meta campaign and its ad set, created paused) and `social.google_campaign`
--   (a Google search campaign, created paused, or emailed as an import file until the API is set up). Each is one owner approval, never
--   automatic, under Settings → Paid ads → "Most to spend on new campaigns a month" and the existing daily ad-set cap.
-- - Click IDs: leads keep the ad click ID (fbclid, li_fat_id, gclid) their first touch carried, so a lead from a paid click can be
--   reported back. With Settings → Paid ads → "Report leads to the ad platforms" on, the Social Media Manager sends Meta and LinkedIn a
--   hashed email for a county report or trial lead (and nothing else), once per lead and platform.
-- - The LinkedIn company list: the roster's agencies as LinkedIn's company-list file, for the owner to upload as a Matched Audience.
set local lock_timeout = '10s';

insert into private.hub_settings (key, kind) values
  ('ads.monthly_budget_cents', 'number'), ('ads.server_conversions', 'flag'), ('ads.meta_audience_id', 'text'), ('ads.meta_pixel_id', 'text'),
  ('ads.linkedin_conversion_id', 'text'), ('ads.google_competitor_keywords', 'flag'), ('ads.google_customer_id', 'text'),
  ('ads.google_login_customer_id', 'text'), ('ads.google_client_id', 'text'), ('ads.google_api_version', 'text')
on conflict (key) do nothing;

-- ---- Click IDs on leads --------------------------------------------------------------------------------------------------------------
alter table private.leads add column if not exists click_ids jsonb not null default '{}'
  check (jsonb_typeof(click_ids) = 'object' and pg_column_size(click_ids) <= 2000);

create function private.lead_click_ids(p_attribution jsonb) returns jsonb
language sql immutable set search_path = '' as $$
  select coalesce(jsonb_object_agg(k, p_attribution ->> k), '{}'::jsonb)
  from unnest(array['fbclid', 'liFatId', 'gclid']) k
  where jsonb_typeof(p_attribution -> k) = 'string' and (p_attribution ->> k) ~ '^[A-Za-z0-9_.-]+$' and char_length(p_attribution ->> k) <= 500;
$$;
revoke all on function private.lead_click_ids(jsonb) from public, anon, authenticated, service_role;

-- The intake accepts the three click IDs beside the first-touch fields and keeps them (every other check is unchanged).
do $$
declare d text := pg_get_functiondef('private.lead_record(text,jsonb)'::regprocedure);
begin
  if position($q$where k not in ('utmSource','utmMedium','utmCampaign','utmTerm','utmContent','referrerHost','landingPath','firstSeenAt')$q$ in d) = 0
    or position($q$  on conflict (source, external_id) do nothing
  returning id into v_id;$q$ in d) = 0 then
    raise exception 'The lead intake changed; update this migration' using errcode = '55000';
  end if;
  d := replace(d, $q$where k not in ('utmSource','utmMedium','utmCampaign','utmTerm','utmContent','referrerHost','landingPath','firstSeenAt')$q$,
    $q$where k not in ('utmSource','utmMedium','utmCampaign','utmTerm','utmContent','referrerHost','landingPath','firstSeenAt','fbclid','liFatId','gclid')$q$);
  d := replace(d, $q$  on conflict (source, external_id) do nothing
  returning id into v_id;$q$, $q$  on conflict (source, external_id) do nothing
  returning id into v_id;
  if v_id is not null and private.lead_click_ids(v_attribution) <> '{}'::jsonb then
    update private.leads set click_ids = private.lead_click_ids(v_attribution) where id = v_id;
  end if;$q$);
  execute d;
end $$;

-- ---- Server conversions --------------------------------------------------------------------------------------------------------------
create table private.ads_conversions (
  lead_id uuid not null references private.leads(id) on delete cascade,
  platform text not null check (platform in ('meta', 'linkedin')),
  status text not null check (status in ('sent', 'failed', 'skipped')),
  code text check (code ~ '^[a-z][a-z_]{0,59}$'),
  recorded_at timestamptz not null default now(),
  primary key (lead_id, platform)
);
alter table private.ads_conversions enable row level security;
revoke all on private.ads_conversions from public, anon, authenticated, service_role, hub_app_server;

-- Server: county report and trial leads of the last seven days not yet reported to `p_platform`, with what a report needs. The email
-- leaves only as a hash (server/agents/social/conversions.mjs); test and probe leads never.
create function private.ads_conversion_candidates(p_platform text, p_limit integer) returns jsonb
language plpgsql stable security definer set search_path = '' as $$ begin
  perform private.require_hub_app_server();
  if p_platform not in ('meta', 'linkedin') or p_limit is null or p_limit < 1 or p_limit > 100 then raise exception 'Invalid request' using errcode = '22023'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'kind', l.kind, 'email', l.contact_email, 'occurredAt', l.occurred_at, 'clickIds', l.click_ids,
      'landingPath', l.landing_path, 'firstSeenAt', l.first_seen_at) order by l.occurred_at)
    from (select * from private.leads l where l.kind in ('county_report', 'trial_signup') and not l.test and l.contact_email is not null
            and l.occurred_at >= now() - interval '7 days'
            and not exists (select 1 from private.ads_conversions c where c.lead_id = l.id and c.platform = p_platform)
          order by l.occurred_at limit p_limit) l), '[]'::jsonb);
end; $$;

create function private.ads_conversion_record(p_lead uuid, p_platform text, p_status text, p_code text) returns boolean
language plpgsql security definer set search_path = '' as $$ begin
  perform private.require_hub_app_server();
  insert into private.ads_conversions(lead_id, platform, status, code) values (p_lead, p_platform, p_status, p_code)
  on conflict (lead_id, platform) do nothing;
  return found;
end; $$;

-- ---- Campaign proposals --------------------------------------------------------------------------------------------------------------
do $$
declare v_kinds text[];
begin
  select coalesce(array_agg(distinct m[1]), array[]::text[]) into v_kinds
  from pg_constraint c cross join lateral regexp_matches(pg_get_constraintdef(c.oid), '''([^'']+)''', 'g') m
  where c.conrelid = 'private.agent_actions'::regclass and c.conname = 'agent_actions_kind_check';
  if not v_kinds @> array['social.post', 'social.ad_create', 'social.founder_post']
    or exists (select 1 from unnest(v_kinds) value where value !~ '^[a-z][a-z0-9_.]{1,60}$') then
    raise exception 'The agent action kinds could not be read' using errcode = '55000';
  end if;
  execute format('alter table private.agent_actions drop constraint agent_actions_kind_check, add constraint agent_actions_kind_check check (kind in (%s))',
    (select string_agg(quote_literal(k), ', ' order by k) from (select distinct unnest(v_kinds || array['social.campaign_create', 'social.google_campaign']) as k) x));
end $$;

-- A new campaign is the Social Media Manager's, one per platform, product and month, and never approved automatically.
alter table private.agent_actions add constraint agent_actions_campaign_check check (
  kind not in ('social.campaign_create', 'social.google_campaign') or coalesce(agent_key = 'social_manager' and target_kind = 'social_item'
    and target_id ~ '^(meta|linkedin|google):(carebase|caremetric-intel):[0-9]{4}-[0-9]{2}$' and status <> 'auto_approved', false)) not valid;
alter table private.agent_actions validate constraint agent_actions_campaign_check;

-- Server: whether a campaign was already proposed for this platform, product and month, whatever became of it.
create function private.social_campaign_proposed(p_kind text, p_target text) returns boolean
language plpgsql stable security definer set search_path = '' as $$ begin
  perform private.require_hub_app_server();
  return exists (select 1 from private.agent_actions where kind = p_kind and target_id = p_target and kind in ('social.campaign_create', 'social.google_campaign'));
end; $$;

-- ---- The LinkedIn company list -------------------------------------------------------------------------------------------------------
-- Owner: the roster's agencies (never an excluded one) as rows for LinkedIn's company-list template, with the website the team
-- confirmed when it has one.
create function hub.growth_roster_companies() returns jsonb
language plpgsql stable security definer set search_path = '' as $$ begin
  perform hub.authorize_app_admin();
  return coalesce((select jsonb_agg(jsonb_build_object('name', t.name, 'domain', o.domain, 'city', t.city, 'state', t.state, 'zip', t.zip) order by t.rank desc, t.ccn)
    from private.growth_roster_targets t left join private.growth_organizations o on o.id = t.organization_id
    where t.status <> 'excluded'), '[]'::jsonb);
end; $$;

revoke all on function private.ads_conversion_candidates(text, integer), private.ads_conversion_record(uuid, text, text, text),
  private.social_campaign_proposed(text, text) from public, anon, authenticated, service_role;
grant execute on function private.ads_conversion_candidates(text, integer), private.ads_conversion_record(uuid, text, text, text),
  private.social_campaign_proposed(text, text) to hub_app_server;
revoke all on function hub.growth_roster_companies() from public, anon, service_role;
grant execute on function hub.growth_roster_companies() to authenticated;

-- Conversions every quarter hour; the paid ads plan (new campaigns) each morning, done on Mondays.
insert into private.agent_schedules (agent_key, task_kind, cadence, every_seconds, at_local, timezone, requires_session, next_run_at) values
  ('social_manager', 'ads.conversions', 'interval', 900, null, 'America/New_York', false, now()),
  ('social_manager', 'ads.plan', 'daily', null, '09:20', 'America/New_York', false, private.agent_schedule_next('daily', null, '09:20', 'America/New_York', now(), null))
on conflict (agent_key, task_kind) do nothing;
