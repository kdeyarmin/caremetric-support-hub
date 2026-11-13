-- Declares platform.agents.ads.v1 once leads keep their click IDs, conversions are reported only by the Hub server once per lead and
-- platform, new campaigns are proposals that are never approved automatically, the company list is the owner's, and the settings exist.
do $$
declare
  contract jsonb := hub.get_backend_contract();
  feature constant text := 'platform.agents.ads.v1';
  campaign_def text;
begin
  if (contract @> '{"api_version":4,"features":["platform.settings.v1","platform.agents.social.v1","platform.agents.growth-roster.v1"]}'::jsonb) is not true then
    raise exception 'Apply the Hub settings, Social Media Manager and roster migrations first' using errcode = '55000';
  end if;
  if (select count(*) from private.hub_settings where key in ('ads.monthly_budget_cents', 'ads.server_conversions', 'ads.meta_audience_id', 'ads.meta_pixel_id',
      'ads.linkedin_conversion_id', 'ads.google_competitor_keywords', 'ads.google_customer_id', 'ads.google_login_customer_id', 'ads.google_client_id',
      'ads.google_api_version')) <> 10 then
    raise exception 'The paid ads settings are missing' using errcode = '55000';
  end if;
  if not exists (select 1 from pg_attribute where attrelid = 'private.leads'::regclass and attname = 'click_ids' and not attisdropped)
    or position('liFatId' in pg_get_functiondef('private.lead_record(text,jsonb)'::regprocedure)) = 0 then
    raise exception 'Leads must keep their ad click IDs' using errcode = '55000';
  end if;
  if exists (select 1 from unnest(array['private.ads_conversion_candidates(text,integer)', 'private.ads_conversion_record(uuid,text,text,text)',
      'private.social_campaign_proposed(text,text)']) f
      where not has_function_privilege('hub_app_server', f, 'execute')
        or exists (select 1 from unnest(array['anon', 'authenticated', 'service_role']) r where has_function_privilege(r, f, 'execute')))
    or exists (select 1 from unnest(array['anon', 'authenticated', 'service_role', 'hub_app_server']) r where has_table_privilege(r, 'private.ads_conversions', 'select'))
    or not (select relrowsecurity from pg_class where oid = 'private.ads_conversions'::regclass) then
    raise exception 'Only the Hub server may report conversions' using errcode = '55000';
  end if;
  campaign_def := coalesce((select pg_get_constraintdef(oid) from pg_constraint where conrelid = 'private.agent_actions'::regclass
    and conname = 'agent_actions_campaign_check' and convalidated), '');
  if position('auto_approved' in campaign_def) = 0 or position('social.google_campaign' in campaign_def) = 0 then
    raise exception 'A new campaign must never be approved automatically' using errcode = '55000';
  end if;
  if position('authorize_app_admin' in pg_get_functiondef('hub.growth_roster_companies()'::regprocedure)) = 0 then
    raise exception 'Only the owner may read the company list' using errcode = '55000';
  end if;
  if not (contract -> 'features' @> to_jsonb(array[feature])) then
    contract := jsonb_set(contract, '{features}', (contract -> 'features') || to_jsonb(array[feature]));
  end if;
  execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L',
    'select ' || quote_literal(contract::text) || '::jsonb');
end $$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon, authenticated;
