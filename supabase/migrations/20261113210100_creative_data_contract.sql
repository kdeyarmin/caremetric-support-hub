-- Declares platform.agents.creative-data.v1 once briefs carry their figure, only the Hub server picks counties and reads published
-- articles, and the settings exist.
do $$
declare
  contract jsonb := hub.get_backend_contract();
  feature constant text := 'platform.agents.creative-data.v1';
begin
  if (contract @> '{"api_version":4,"features":["platform.settings.v1","platform.agents.creative.v1","platform.agents.social.v1","platform.agents.growth-roster.v1"]}'::jsonb) is not true then
    raise exception 'Apply the Hub settings, Creative Director, Social Media Manager and roster migrations first' using errcode = '55000';
  end if;
  if (select count(*) from private.hub_settings where (key, kind) in (('creative.county_snapshots_per_week', 'number'), ('social.event_posts', 'flag'))) <> 2 then
    raise exception 'The data creative settings are missing' using errcode = '55000';
  end if;
  if not exists (select 1 from pg_attribute where attrelid = 'private.creative_briefs'::regclass and attname = 'facts' and not attisdropped)
    or position('''data.county''' in coalesce((select pg_get_constraintdef(oid) from pg_constraint where conrelid = 'private.creative_briefs'::regclass
      and conname = 'creative_briefs_source_check'), '')) = 0
    or position('facts' in pg_get_functiondef('private.creative_brief_create(jsonb)'::regprocedure)) = 0
    or position('facts' in pg_get_functiondef('private.creative_brief_json(private.creative_briefs)'::regprocedure)) = 0 then
    raise exception 'Briefs must carry the figure they are about' using errcode = '55000';
  end if;
  if exists (select 1 from unnest(array['private.creative_data_counties(integer,timestamptz)', 'private.social_recent_articles(integer)']) f
      where not has_function_privilege('hub_app_server', f, 'execute')
        or exists (select 1 from unnest(array['anon', 'authenticated', 'service_role']) r where has_function_privilege(r, f, 'execute'))) then
    raise exception 'Only the Hub server may pick counties and read published articles' using errcode = '55000';
  end if;
  if not (contract -> 'features' @> to_jsonb(array[feature])) then
    contract := jsonb_set(contract, '{features}', (contract -> 'features') || to_jsonb(array[feature]));
  end if;
  execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L',
    'select ' || quote_literal(contract::text) || '::jsonb');
end $$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon, authenticated;
