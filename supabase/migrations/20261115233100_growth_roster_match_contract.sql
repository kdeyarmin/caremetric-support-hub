-- Declares platform.agents.growth-roster-match.v1 once the match table is closed to every role, only the Hub server may hand out
-- and record matches, the daily setting exists and the Marketing Manager's hourly growth.match task is scheduled.
do $$
declare
  contract jsonb := hub.get_backend_contract();
  feature constant text := 'platform.agents.growth-roster-match.v1';
  server_fns constant text[] := array['private.growth_roster_match_next(integer,integer)', 'private.growth_roster_match_record(uuid,jsonb)'];
  fn text;
begin
  if (contract @> '{"api_version":4,"features":["platform.settings.v1","platform.agents.growth-autonomy.v1","platform.agents.growth-roster.v1"]}'::jsonb) is not true then
    raise exception 'Apply the Hub settings, growth autonomy and Medicare roster migrations first' using errcode = '55000';
  end if;
  if not exists (select 1 from private.hub_settings where key = 'growth.roster_match_daily' and kind = 'number') then
    raise exception 'The match setting is missing' using errcode = '55000';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'private.growth_roster_matches'::regclass)
    or exists (select 1 from unnest(array['anon', 'authenticated', 'service_role', 'hub_app_server']) r
               where has_table_privilege(r, 'private.growth_roster_matches', 'select') or has_table_privilege(r, 'private.growth_roster_matches', 'insert')
                  or has_table_privilege(r, 'private.growth_roster_matches', 'update') or has_table_privilege(r, 'private.growth_roster_matches', 'delete')) then
    raise exception 'The match table must be closed to every role' using errcode = '55000';
  end if;
  foreach fn in array server_fns loop
    if not has_function_privilege('hub_app_server', fn, 'execute')
      or exists (select 1 from unnest(array['anon', 'authenticated', 'service_role']) r where has_function_privilege(r, fn, 'execute'))
      or position('private.require_hub_app_server()' in pg_get_functiondef(fn::regprocedure)) = 0 then
      raise exception 'Only the Hub server may run %', fn using errcode = '55000';
    end if;
  end loop;
  -- A match is recorded through the roster's own save and evidence writer, never beside them.
  if position('private.growth_roster_upsert(' in pg_get_functiondef('private.growth_roster_match_record(uuid,jsonb)'::regprocedure)) = 0
    or position('private.growth_roster_evidence(' in pg_get_functiondef('private.growth_roster_match_record(uuid,jsonb)'::regprocedure)) = 0 then
    raise exception 'A match must be saved as a roster record' using errcode = '55000';
  end if;
  if not exists (select 1 from private.agent_schedules where agent_key = 'marketing_manager' and task_kind = 'growth.match') then
    raise exception 'The Marketing Manager''s match task is not scheduled' using errcode = '55000';
  end if;
  if not (contract -> 'features' @> to_jsonb(array[feature])) then
    contract := jsonb_set(contract, '{features}', (contract -> 'features') || to_jsonb(array[feature]));
  end if;
  execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L',
    'select ' || quote_literal(contract::text) || '::jsonb');
end $$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon, authenticated;
