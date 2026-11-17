-- Reach outside cold email (AI workforce review 2026-11-17, team review, stage 6; docs/AI_WORKFORCE_REVIEW_2026-11-17_TEAM.md).
--
-- 1. private.social_interest: a comment or message the Social Media Manager read as interest or a pricing question (platform, the item's
--    id, its link, the product and the reading). Nothing the person wrote is kept. The owner is told with the link, and the weekly report
--    counts them. A comment carries no email address, so it cannot be a lead on the lead desk (private.leads needs one); the reply the
--    team drafts offers the free market report or the trial.
-- 2. private.social_post_leads: website leads that came from a social post, by the post's own utm_content (each post now carries its
--    own), with the post's platform, product, pillar and first line (CareMetric's words), for the weekly plan.
-- 3. private.ads_month_campaigns (same signature) also says whether a campaign was created with no ad running (a launch that fell back
--    to paused with no ads): such a campaign no longer takes the month's flight, so the next day's plan can try one that can run.
-- 4. private.creative_expiring_warnings: images waiting for the owner with a compliance warning (never approved on their own) whose
--    proposal expires soon, so the owner is told before they lapse unseen.
-- 5. private.content_roster_counties: the counties with the most open roster agencies, for the Content Marketer's county topics.
-- 6. Two switches, both off: Settings → Social media → "Read and answer comments on ads" and Settings → AI team → "Write articles about
--    the roster's counties".
--
-- 20261117250100_reach_contract.sql declares platform.agents.reach.v1; the Hub uses all of this only then.
set local lock_timeout = '10s';

insert into private.hub_settings (key, kind) values
  ('social.ad_comments', 'flag'),
  ('agents.content_county_topics', 'flag')
on conflict (key) do nothing;

-- 1. Interest read in a comment or message. ---------------------------------------------------------------------------------------------
create table if not exists private.social_interest (
  id uuid primary key default gen_random_uuid(),
  platform text not null check (platform in ('facebook', 'instagram', 'messenger', 'linkedin')),
  item_id text not null check (char_length(item_id) between 1 and 150),
  url text check (url is null or (url ~ '^https://[^[:space:]"<>]+$' and char_length(url) <= 500)),
  product text check (product is null or product in ('carebase', 'caremetric-intel')),
  intent text not null check (intent in ('interested', 'pricing')),
  ad boolean not null default false,
  created_at timestamptz not null default now(),
  unique (platform, item_id)
);
create index if not exists social_interest_created on private.social_interest (created_at);
alter table private.social_interest enable row level security;
revoke all on private.social_interest from public, anon, authenticated, service_role, hub_app_server;

-- Server: records one interested or pricing comment or message, once. True when it is new.
create or replace function private.social_interest_record(p_platform text, p_item text, p_url text, p_product text, p_intent text, p_ad boolean)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  perform private.require_hub_app_server();
  if p_platform not in ('facebook', 'instagram', 'messenger', 'linkedin') or coalesce(char_length(p_item), 0) not between 1 and 150
     or p_intent not in ('interested', 'pricing') or (p_product is not null and p_product not in ('carebase', 'caremetric-intel'))
     or (p_url is not null and (p_url !~ '^https://[^[:space:]"<>]+$' or char_length(p_url) > 500)) then
    raise exception 'Name the platform, the item and the reading.' using errcode = '22023';
  end if;
  insert into private.social_interest (platform, item_id, url, product, intent, ad)
  values (p_platform, p_item, p_url, p_product, p_intent, coalesce(p_ad, false))
  on conflict (platform, item_id) do nothing returning id into v_id;
  return v_id is not null;
end; $$;

-- 2. Leads from each social post, and what the team knows about the post. ------------------------------------------------------------
-- Server: since p_since, website leads (never a test) that arrived from an organic social post, grouped by the post's utm_content, with
-- the post the content names (its platform, product, pillar and first 160 characters, all CareMetric's own) and interested comments.
create or replace function private.social_post_leads(p_since timestamptz) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_hub_app_server();
  if p_since is null or p_since < now() - interval '120 days' then raise exception 'At most 120 days back' using errcode = '22023'; end if;
  return jsonb_build_object(
    'posts', coalesce((select jsonb_agg(row_to_json(x)::jsonb order by x.leads desc, x.content) from (
      select l.utm_content as content, count(*)::integer as leads,
        max(a.input ->> 'platform') as platform, max(a.input ->> 'product') as product, max(a.input ->> 'pillar') as pillar,
        max(left(split_part(a.input ->> 'message', E'\n', 1), 160)) as "firstLine", max(a.input ->> 'creativeAssetId') as "creativeAssetId"
      from private.leads l
      left join private.agent_actions a on a.kind = 'social.post' and a.input ->> 'utmContent' = l.utm_content
      where not l.test and l.received_at >= p_since and l.utm_medium = 'social' and l.utm_content is not null and l.utm_content <> 'reply'
      group by l.utm_content
      limit 40) x), '[]'::jsonb),
    'interested', (select count(*)::integer from private.social_interest where created_at >= p_since),
    'interestedOnAds', (select count(*)::integer from private.social_interest where created_at >= p_since and ad));
end; $$;

-- 3. The month's campaigns, and which one was created with nothing running. --------------------------------------------------------
create or replace function private.ads_month_campaigns(p_month text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$ begin
  perform private.require_hub_app_server();
  if p_month is null or p_month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then raise exception 'Invalid month' using errcode = '22023'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('kind', kind, 'targetId', target_id, 'status', status, 'flight', input ? 'flightDays',
      -- Reach (20261117250000_reach.sql): a LinkedIn or Meta launch that fell back to a paused campaign with no ad (no approved creative
      -- fit, or its first ad was refused), so nothing of the month is spent. Not one held back by the month's number or its end: the
      -- month is spent or over, and another campaign would only fall back the same way.
      'empty', kind = 'social.campaign_create' and status = 'executed' and result ->> 'launched' = 'false' and coalesce(result ->> 'adId', '') = ''
        and coalesce(result ->> 'reason', '') not in ('', 'monthly_budget_used', 'no_monthly_budget', 'not_reserved', 'month_ending', 'month_over'))
      order by created_at, id)
    from private.agent_actions where kind in ('social.campaign_create', 'social.google_campaign') and split_part(target_id, ':', 3) = p_month), '[]'::jsonb);
end; $$;
revoke all on function private.ads_month_campaigns(text) from public, anon, authenticated, service_role;
grant execute on function private.ads_month_campaigns(text) to hub_app_server;

-- 4. Images with a warning that are about to lapse. -----------------------------------------------------------------------------------
create or replace function private.creative_expiring_warnings(p_hours integer) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_hub_app_server();
  if p_hours is null or p_hours not between 1 and 168 then raise exception 'Between 1 and 168 hours' using errcode = '22023'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('assetId', x.id, 'product', x.product, 'placement', x.placement, 'headline', left(x.headline, 120),
      'expiresAt', x.expires_at) order by x.expires_at, x.id)
    from (select s.id, s.product, s.placement, s.headline, a.expires_at
            from private.creative_assets s
            join private.agent_actions a on a.id = s.action_id
           where s.status = 'proposed' and s.compliance ->> 'verdict' = 'warn' and a.status = 'proposed'
             and a.expires_at > now() and a.expires_at <= now() + make_interval(hours => p_hours)
           order by a.expires_at, s.id limit 20) x), '[]'::jsonb);
end; $$;

-- 5. The roster's counties with the most agencies. ------------------------------------------------------------------------------------
create or replace function private.content_roster_counties(p_limit integer) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_hub_app_server();
  if p_limit is null or p_limit not between 1 and 100 then raise exception 'Between 1 and 100 counties' using errcode = '22023'; end if;
  return coalesce((select jsonb_agg(row_to_json(x)::jsonb order by x.agencies desc, x."countyFips") from (
      select county_fips as "countyFips", state, count(*)::integer as agencies
        from private.growth_roster_targets
       where county_fips is not null and status <> 'excluded'
       group by county_fips, state
       order by count(*) desc, county_fips
       limit p_limit) x), '[]'::jsonb);
end; $$;

revoke all on function private.social_interest_record(text, text, text, text, text, boolean), private.social_post_leads(timestamptz),
  private.creative_expiring_warnings(integer), private.content_roster_counties(integer)
  from public, anon, authenticated, service_role;
grant execute on function private.social_interest_record(text, text, text, text, text, boolean), private.social_post_leads(timestamptz),
  private.creative_expiring_warnings(integer), private.content_roster_counties(integer)
  to hub_app_server;
