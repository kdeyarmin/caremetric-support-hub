-- Declares platform.agents.growth-research.v1 once the Marketing Manager's allowlist names the web tools, only the Hub server hands out
-- prospects to research, the log is closed to every role and the settings exist.
do $$
declare
  contract jsonb := hub.get_backend_contract();
  feature constant text := 'platform.agents.growth-research.v1';
begin
  if (contract @> '{"api_version":4,"features":["platform.settings.v1","platform.agents.growth-autonomy.v1"]}'::jsonb) is not true then
    raise exception 'Apply the Hub settings and growth autonomy migrations first' using errcode = '55000';
  end if;
  if (select count(*) from private.hub_settings where (key, kind) in (('growth.deep_research', 'flag'), ('growth.deep_research_per_day', 'number'),
      ('growth.deep_research_cents', 'number'))) <> 3 then
    raise exception 'The research settings are missing' using errcode = '55000';
  end if;
  if not exists (select 1 from private.agents where key = 'marketing_manager' and tool_allowlist @> array['web_search', 'web_fetch']) then
    raise exception 'The Marketing Manager''s allowlist must name the web tools' using errcode = '55000';
  end if;
  if not has_function_privilege('hub_app_server', 'private.growth_research_next(integer)', 'execute')
    or exists (select 1 from unnest(array['anon', 'authenticated', 'service_role']) r where has_function_privilege(r, 'private.growth_research_next(integer)', 'execute'))
    or exists (select 1 from unnest(array['anon', 'authenticated', 'service_role', 'hub_app_server']) r where has_table_privilege(r, 'private.growth_research_log', 'select'))
    or not (select relrowsecurity from pg_class where oid = 'private.growth_research_log'::regclass) then
    raise exception 'Only the Hub server may hand out prospects to research' using errcode = '55000';
  end if;
  if not (contract -> 'features' @> to_jsonb(array[feature])) then
    contract := jsonb_set(contract, '{features}', (contract -> 'features') || to_jsonb(array[feature]));
  end if;
  execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L',
    'select ' || quote_literal(contract::text) || '::jsonb');
end $$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon, authenticated;
