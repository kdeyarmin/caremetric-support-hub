-- Declares platform.agents.growth-reach.v1 once the growth priority, roster and learning features are declared; the website search's
-- picker and recorder and the live writing evaluation's state, record and latest result are executable by the Hub server alone and
-- require its connection; the evaluation's cases table has row level security and is closed to every role; the four stage 3 settings have
-- rows; the Growth screen's roster carries the suggestions; a confirmed site goes through the lookups' own private.growth_roster_resolved;
-- and both schedules exist (2026-11-17 review, stage 3).
do $$
declare
  contract jsonb := hub.get_backend_contract();
  feature constant text := 'platform.agents.growth-reach.v1';
  server_fns constant text[] := array['private.growth_roster_site_next(integer,integer)', 'private.growth_roster_site_record(text,jsonb)',
    'private.growth_live_eval_state(text)', 'private.growth_live_eval_record(text,text,jsonb)', 'private.growth_live_evaluation_latest(timestamptz)'];
  fn text;
begin
  if (contract @> '{"api_version":4,"features":["platform.settings.v1","platform.agents.growth-priority.v1","platform.agents.growth-roster.v1","platform.agents.growth-learning.v1"]}'::jsonb) is not true then
    raise exception 'Apply the growth priority, roster and learning migrations first' using errcode = '55000';
  end if;
  foreach fn in array server_fns loop
    if to_regprocedure(fn) is null or not has_function_privilege('hub_app_server', fn, 'execute')
      or exists (select 1 from unnest(array['anon', 'authenticated', 'service_role']) r where has_function_privilege(r, fn, 'execute'))
      or position('private.require_hub_app_server()' in pg_get_functiondef(fn::regprocedure)) = 0 then
      raise exception 'Only the Hub server may run %', fn using errcode = '55000';
    end if;
  end loop;
  if to_regclass('private.growth_live_eval_cases') is null
    or not (select relrowsecurity from pg_class where oid = 'private.growth_live_eval_cases'::regclass)
    or exists (select 1 from unnest(array['anon', 'authenticated', 'service_role', 'hub_app_server']) r
                where has_table_privilege(r, 'private.growth_live_eval_cases', 'select,insert,update,delete')) then
    raise exception 'The live evaluation''s cases must be closed to every role' using errcode = '55000';
  end if;
  if (select count(*) from private.hub_settings where key in ('growth.roster_site_research', 'growth.roster_site_research_per_day',
      'growth.roster_site_research_cents', 'growth.live_evaluation')) <> 4 then
    raise exception 'The four stage 3 settings must have rows' using errcode = '55000';
  end if;
  if position('private.growth_roster_resolved' in pg_get_functiondef('private.growth_roster_site_record(text,jsonb)'::regprocedure)) = 0 then
    raise exception 'A site the web search found must graduate through the lookups'' own path' using errcode = '55000';
  end if;
  if position('''suggested''' in pg_get_functiondef('hub.growth_roster(integer)'::regprocedure)) = 0 then
    raise exception 'The Growth screen''s roster must show the web search''s suggestions' using errcode = '55000';
  end if;
  if not exists (select 1 from private.agent_schedules where agent_key = 'marketing_manager' and task_kind = 'growth.sites')
    or not exists (select 1 from private.agent_schedules where agent_key = 'marketing_manager' and task_kind = 'growth.evaluate_live') then
    raise exception 'The website search and the live evaluation must be scheduled' using errcode = '55000';
  end if;
  if not (contract -> 'features' @> to_jsonb(array[feature])) then
    contract := jsonb_set(contract, '{features}', (contract -> 'features') || to_jsonb(array[feature]));
  end if;
  execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L',
    'select ' || quote_literal(contract::text) || '::jsonb');
end $$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon, authenticated;
