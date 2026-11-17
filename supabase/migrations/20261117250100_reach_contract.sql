-- Declares platform.agents.reach.v1 once reach outside cold email is in place (20261117250000_reach.sql, team review 2026-11-17, stage
-- 6): the interest table has row level security and is closed to every role; recording interest, the leads per post, the images about to
-- lapse and the roster's counties are executable by the Hub server alone and require its connection; the month's campaigns say which
-- was created with nothing running; and both switches have rows.
do $$
declare
  contract jsonb := hub.get_backend_contract();
  feature constant text := 'platform.agents.reach.v1';
  server_fns constant text[] := array['private.social_interest_record(text,text,text,text,text,boolean)', 'private.social_post_leads(timestamp with time zone)',
    'private.creative_expiring_warnings(integer)', 'private.content_roster_counties(integer)', 'private.ads_month_campaigns(text)'];
  fn text;
begin
  if (contract @> '{"api_version":4,"features":["platform.settings.v1","platform.agents.social.v1","platform.agents.ads.v1","platform.agents.creative.v1","platform.agents.growth-roster.v1"]}'::jsonb) is not true then
    raise exception 'Apply the social, ads, creative and roster migrations first' using errcode = '55000';
  end if;
  if to_regclass('private.social_interest') is null
     or not (select relrowsecurity from pg_class where oid = 'private.social_interest'::regclass)
     or exists (select 1 from unnest(array['anon', 'authenticated', 'service_role', 'hub_app_server']) r
                 where has_table_privilege(r, 'private.social_interest', 'select,insert,update,delete')) then
    raise exception 'Social interest must be closed to every role' using errcode = '55000';
  end if;
  foreach fn in array server_fns loop
    if to_regprocedure(fn) is null or not has_function_privilege('hub_app_server', fn, 'execute')
       or exists (select 1 from unnest(array['anon', 'authenticated', 'service_role']) r where has_function_privilege(r, fn, 'execute'))
       or position('private.require_hub_app_server()' in pg_get_functiondef(fn::regprocedure)) = 0 then
      raise exception 'Only the Hub server may run %', fn using errcode = '55000';
    end if;
  end loop;
  if position('''empty''' in pg_get_functiondef('private.ads_month_campaigns(text)'::regprocedure)) = 0 then
    raise exception 'The month''s campaigns must say which was created with nothing running' using errcode = '55000';
  end if;
  if (select count(*) from private.hub_settings where key in ('social.ad_comments', 'agents.content_county_topics')) <> 2 then
    raise exception 'Both stage 6 switches must have rows' using errcode = '55000';
  end if;
  if not (contract -> 'features' @> to_jsonb(array[feature])) then
    contract := jsonb_set(contract, '{features}', (contract -> 'features') || to_jsonb(array[feature]));
  end if;
  execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L',
    'select ' || quote_literal(contract::text) || '::jsonb');
end $$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon, authenticated;
