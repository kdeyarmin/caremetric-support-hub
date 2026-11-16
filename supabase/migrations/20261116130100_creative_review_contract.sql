-- Declares platform.agents.creative-review.v1 once the vision review's settings exist, only the Hub server may pick counties from a list,
-- and the county choice keeps a county out for eight weeks after it was pictured and reports the setting it was pictured with.
do $$
declare
  contract jsonb := hub.get_backend_contract();
  feature constant text := 'platform.agents.creative-review.v1';
  fn constant text := 'private.creative_data_counties(integer,timestamptz,jsonb)';
begin
  if (contract @> '{"api_version":4,"features":["platform.settings.v1","platform.agents.creative.v1","platform.agents.creative-data.v1","platform.agents.growth-roster.v1"]}'::jsonb) is not true then
    raise exception 'Apply the Hub settings, Creative Director, data creative and roster migrations first' using errcode = '55000';
  end if;
  if (select count(*) from private.hub_settings where (key, kind) in (('creative.vision_review', 'flag'), ('creative.vision_min_score', 'number'))) <> 2 then
    raise exception 'The vision review settings are missing' using errcode = '55000';
  end if;
  if to_regprocedure(fn) is null or not has_function_privilege('hub_app_server', fn, 'execute')
    or exists (select 1 from unnest(array['anon', 'authenticated', 'service_role']) r where has_function_privilege(r, fn, 'execute'))
    or position('private.require_hub_app_server()' in pg_get_functiondef(fn::regprocedure)) = 0 then
    raise exception 'Only the Hub server may pick the counties to picture' using errcode = '55000';
  end if;
  if position('interval ''56 days''' in pg_get_functiondef(fn::regprocedure)) = 0
    or position('''lastSetting''' in pg_get_functiondef(fn::regprocedure)) = 0 then
    raise exception 'A county must rest eight weeks after it is pictured, and the choice must say which setting it last showed' using errcode = '55000';
  end if;
  if not (contract -> 'features' @> to_jsonb(array[feature])) then
    contract := jsonb_set(contract, '{features}', (contract -> 'features') || to_jsonb(array[feature]));
  end if;
  execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L',
    'select ' || quote_literal(contract::text) || '::jsonb');
end $$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon, authenticated;
