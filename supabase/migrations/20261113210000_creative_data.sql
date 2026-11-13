-- Data-driven creative and timely posts (AI workforce review 2026-11-12, P2/P3):
--
-- - County snapshots: the Creative Director opens up to "County snapshots a week" (Settings → Creative) briefs, each about one public
--   figure for a county where the Medicare roster's prospects are (Intel's county_figures). The brief carries the figure (`facts`):
--   code prints the number, its label and its source on the image; the model writes only the words around it.
-- - Event posts: with Settings → Social media → "Post about new CMS data and observances" on, the weekly plan may write a post about a
--   release Intel just loaded or a healthcare observance starting soon.
-- - Articles: the weekly plan may link a post to an article the team published in the last 45 days.
set local lock_timeout = '10s';

insert into private.hub_settings (key, kind) values
  ('creative.county_snapshots_per_week', 'number'),
  ('social.event_posts', 'flag'),
  -- Settings → AI team → Tasks at once: how many agent tasks may run side by side (server/agents/scheduler.mjs).
  ('agents.concurrent_tasks', 'number')
on conflict (key) do nothing;

alter table private.creative_briefs drop constraint if exists creative_briefs_source_check;
alter table private.creative_briefs add constraint creative_briefs_source_check
  check (source in ('social.plan', 'growth.plan', 'sweep', 'owner', 'refresh', 'revision', 'data.county', 'data.release', 'observance'));
alter table private.creative_briefs add column if not exists facts jsonb not null default '{}'
  check (jsonb_typeof(facts) = 'object' and pg_column_size(facts) <= 4000);

create or replace function private.creative_brief_json(p_brief private.creative_briefs) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('id', p_brief.id, 'product', p_brief.product, 'goal', p_brief.goal, 'audience', p_brief.audience, 'offerCode', p_brief.offer_code,
    'platforms', to_jsonb(p_brief.platforms), 'formats', to_jsonb(p_brief.formats), 'videoLengths', to_jsonb(p_brief.video_lengths), 'angle', p_brief.angle,
    'source', p_brief.source, 'status', p_brief.status, 'planRef', p_brief.plan_ref, 'parentAssetId', p_brief.parent_asset_id,
    'revisionNote', p_brief.revision_note, 'result', p_brief.result, 'facts', p_brief.facts, 'createdAt', p_brief.created_at, 'updatedAt', p_brief.updated_at);
$$;

-- A brief may carry the public figure it is about; only the data sources take one.
create or replace function private.creative_brief_create(p_brief jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
  v_status text;
  v_facts jsonb := coalesce(p_brief -> 'facts', '{}'::jsonb);
begin
  perform private.require_hub_app_server();
  if jsonb_typeof(p_brief) <> 'object' or jsonb_typeof(v_facts) <> 'object'
    or (v_facts <> '{}'::jsonb and coalesce(p_brief ->> 'source', '') not in ('data.county', 'data.release', 'observance')) then
    raise exception 'Invalid brief.' using errcode = '22023';
  end if;
  insert into private.creative_briefs (product, goal, audience, offer_code, platforms, formats, video_lengths, angle, source, plan_ref, request_key,
    parent_asset_id, revision_note, facts)
  values (p_brief ->> 'product', p_brief ->> 'goal', p_brief ->> 'audience', nullif(p_brief ->> 'offerCode', ''),
    array(select jsonb_array_elements_text(coalesce(p_brief -> 'platforms', '[]'))),
    coalesce(nullif(array(select jsonb_array_elements_text(coalesce(p_brief -> 'formats', '[]'))), array[]::text[]), array['static']),
    array(select jsonb_array_elements_text(coalesce(p_brief -> 'videoLengths', '[]'))),
    coalesce(p_brief ->> 'angle', ''), p_brief ->> 'source', nullif(p_brief ->> 'planRef', ''), p_brief ->> 'requestKey',
    nullif(p_brief ->> 'parentAssetId', '')::uuid, coalesce(p_brief ->> 'revisionNote', ''), v_facts)
  on conflict (request_key) do nothing
  returning id, status into v_id, v_status;
  if v_id is null then
    select id, status into v_id, v_status from private.creative_briefs where request_key = p_brief ->> 'requestKey';
    return jsonb_build_object('id', v_id, 'created', false, 'status', v_status);
  end if;
  return jsonb_build_object('id', v_id, 'created', true, 'status', v_status);
end;
$$;

-- Server: the counties to picture this week, where the roster's agencies are, most first, none pictured in the last eight weeks, and no
-- more than the week's number less the county briefs already opened since the week began.
create function private.creative_data_counties(p_per_week integer, p_week_start timestamptz) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_room integer; begin
  perform private.require_hub_app_server();
  if p_per_week is null or p_per_week < 0 or p_per_week > 7 or p_week_start is null then raise exception 'Invalid request' using errcode = '22023'; end if;
  v_room := p_per_week - (select count(*) from private.creative_briefs where source = 'data.county' and created_at >= p_week_start);
  if v_room <= 0 then return '[]'::jsonb; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('countyFips', county_fips, 'state', state, 'agencies', agencies) order by agencies desc, county_fips)
    from (select t.county_fips, min(t.state) as state, count(*) as agencies from private.growth_roster_targets t
          where t.county_fips is not null and t.status <> 'excluded'
            and not exists (select 1 from private.creative_briefs b where b.source = 'data.county' and b.facts ->> 'countyFips' = t.county_fips
              and b.created_at >= now() - interval '56 days')
          group by t.county_fips order by count(*) desc, t.county_fips limit v_room) c), '[]'::jsonb);
end; $$;

-- Server: articles the team published in the last p_days days (the content writer's approved, executed publications still live).
create function private.social_recent_articles(p_days integer) returns jsonb
language plpgsql stable security definer set search_path = '' as $$ begin
  perform private.require_hub_app_server();
  if p_days is null or p_days < 1 or p_days > 120 then raise exception 'Invalid window' using errcode = '22023'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('slug', x.slug, 'product', x.product, 'title', x.title) order by x.at desc)
    from (select distinct on (a.input ->> 'slug') a.input ->> 'slug' as slug, a.input ->> 'product' as product, left(a.input ->> 'title', 200) as title, a.executed_at as at
          from private.agent_actions a join hub.content_items i on i.content_key = a.input ->> 'slug'
          where a.kind = 'content.publish' and a.status = 'executed' and a.executed_at >= now() - make_interval(days => p_days)
            and i.status = 'published' and i.retired_at is null and a.input ->> 'slug' ~ '^[a-z0-9-]{1,120}$'
            and a.input ->> 'product' in ('carebase', 'caremetric-intel') and nullif(btrim(a.input ->> 'title'), '') is not null
          order by a.input ->> 'slug', a.executed_at desc limit 20) x), '[]'::jsonb);
end; $$;

revoke all on function private.creative_data_counties(integer, timestamptz), private.social_recent_articles(integer) from public, anon, authenticated, service_role;
grant execute on function private.creative_data_counties(integer, timestamptz), private.social_recent_articles(integer) to hub_app_server;
