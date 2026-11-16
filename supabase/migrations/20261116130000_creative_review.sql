-- Ads and creative upgrades (AI workforce review 2026-11-16, owner decision 2026-11-16):
--
-- - The vision review: with Settings → Creative → "Have a model look at each image before you see it" on, a model looks at each finished
--   image that passed every coded check before the owner is asked about it (server/agents/creative/vision.mjs). A defect a reader would
--   see blocks it; a softer one or a score below "Least score from the image review" (1 to 5, default 3) is a warning, which the database
--   already never approves on its own. Its answer is kept in the asset's compliance result (`review`); no table changes.
-- - County snapshots picture every county of the roster's states, not only counties with a roster agency located in them: the server
--   passes the state's counties (Intel's counties action) and the database picks the least recently pictured first, never one pictured in
--   the last eight weeks, with how many of the roster's home health agencies and hospices are located in each and the setting it was
--   pictured with last, so each snapshot can keep to one care setting (server/agents/creative/data.mjs). The older two-argument
--   function stays, for a server that does not pass the list.
set local lock_timeout = '10s';

insert into private.hub_settings (key, kind) values
  ('creative.vision_review', 'flag'),
  ('creative.vision_min_score', 'number')
on conflict (key) do nothing;

-- Server: up to the week's room of counties to picture, from the roster's own counties and `p_counties` ([{ countyFips, state }], every
-- county of the roster's states, or null), the least recently pictured first, then those with the most roster agencies.
create or replace function private.creative_data_counties(p_per_week integer, p_week_start timestamptz, p_counties jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_room integer; begin
  perform private.require_hub_app_server();
  if p_per_week is null or p_per_week < 0 or p_per_week > 7 or p_week_start is null
    or (p_counties is not null and (jsonb_typeof(p_counties) <> 'array' or jsonb_array_length(p_counties) > 5000)) then
    raise exception 'Invalid request' using errcode = '22023';
  end if;
  v_room := p_per_week - (select count(*) from private.creative_briefs where source = 'data.county' and created_at >= p_week_start);
  if v_room <= 0 then return '[]'::jsonb; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('countyFips', c.fips, 'state', c.state, 'agencies', c.agencies, 'homeHealth', c.home_health,
      'hospice', c.hospice, 'lastSetting', c.last_setting) order by c.last_at nulls first, c.agencies desc, c.fips)
    from (
      select k.fips, k.state,
             count(t.ccn)::int as agencies,
             count(t.ccn) filter (where t.setting = 'home_health')::int as home_health,
             count(t.ccn) filter (where t.setting = 'hospice')::int as hospice,
             (select max(b.created_at) from private.creative_briefs b where b.source = 'data.county' and b.facts ->> 'countyFips' = k.fips) as last_at,
             (select b.facts ->> 'setting' from private.creative_briefs b where b.source = 'data.county' and b.facts ->> 'countyFips' = k.fips
               order by b.created_at desc limit 1) as last_setting
        from (select distinct on (x.fips) x.fips, x.state from (
                select t.county_fips as fips, t.state from private.growth_roster_targets t where t.county_fips is not null and t.status <> 'excluded'
                union all
                select e ->> 'countyFips', e ->> 'state' from jsonb_array_elements(coalesce(p_counties, '[]'::jsonb)) e
                 where jsonb_typeof(e) = 'object' and (e ->> 'countyFips') ~ '^[0-9]{5}$' and (e ->> 'state') ~ '^[A-Z]{2}$') x
              order by x.fips, x.state) k
        left join private.growth_roster_targets t on t.county_fips = k.fips and t.status <> 'excluded'
       where not exists (select 1 from private.creative_briefs b where b.source = 'data.county' and b.facts ->> 'countyFips' = k.fips
                           and b.created_at >= now() - interval '56 days')
       group by k.fips, k.state
       order by last_at nulls first, agencies desc, k.fips
       limit v_room) c), '[]'::jsonb);
end; $$;

revoke all on function private.creative_data_counties(integer, timestamptz, jsonb) from public, anon, authenticated, service_role;
grant execute on function private.creative_data_counties(integer, timestamptz, jsonb) to hub_app_server;
