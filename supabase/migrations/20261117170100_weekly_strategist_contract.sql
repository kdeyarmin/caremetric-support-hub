-- Declares platform.agents.strategist.v1 once the settings, Monday scorecard, address check and account brief features are declared, the
-- agents.strategist setting exists as a flag, the notes table has row level security and is closed to every role, the funnel helper is
-- closed to every role, the facts read and the note save and read are security definers with a pinned empty search path that only the
-- Hub server may run, the facts count only hard bounces and never internal organizations, and the Chief of Staff's strategy.weekly task
-- is scheduled before the scorecard.
do $$
declare
  contract jsonb := hub.get_backend_contract();
  feature constant text := 'platform.agents.strategist.v1';
  server_fns constant text[] := array['private.growth_strategy_facts(timestamptz,timestamptz)', 'private.agent_strategy_save(date,jsonb)',
    'private.agent_strategy_note(date)'];
  fn text;
  r text;
  facts text;
begin
  if (contract @> '{"api_version":4,"features":["platform.settings.v1","platform.agents.scorecard.v1","platform.agents.growth-address-check.v1","platform.agents.growth-brief.v1"]}'::jsonb) is not true then
    raise exception 'Apply the settings, scorecard, address check and account brief migrations first' using errcode = '55000';
  end if;
  if not exists (select 1 from private.hub_settings where key = 'agents.strategist' and kind = 'flag') then
    raise exception 'The strategist''s setting is missing' using errcode = '55000';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'private.agent_strategy_notes'::regclass) then
    raise exception 'The notes table needs row level security' using errcode = '55000';
  end if;
  foreach r in array array['anon', 'authenticated', 'service_role', 'hub_app_server'] loop
    if has_table_privilege(r, 'private.agent_strategy_notes', 'select') or has_table_privilege(r, 'private.agent_strategy_notes', 'insert')
      or has_table_privilege(r, 'private.agent_strategy_notes', 'update') or has_table_privilege(r, 'private.agent_strategy_notes', 'delete')
      or has_function_privilege(r, 'private.growth_strategy_facts_json(timestamptz,timestamptz)', 'execute') then
      raise exception 'The notes table and the funnel helper must be closed to every role' using errcode = '55000';
    end if;
  end loop;
  foreach fn in array server_fns loop
    if not has_function_privilege('hub_app_server', fn, 'execute')
      or exists (select 1 from unnest(array['anon', 'authenticated', 'service_role']) x where has_function_privilege(x, fn, 'execute'))
      or position('private.require_hub_app_server()' in pg_get_functiondef(fn::regprocedure)) = 0
      or not coalesce((select p.prosecdef and p.proconfig @> array['search_path=""'] from pg_proc p where p.oid = fn::regprocedure), false) then
      raise exception 'Only the Hub server may run %', fn using errcode = '55000';
    end if;
  end loop;
  -- The funnel is Intel's alone, never an internal organization's, and a bounce counts only once the Hub suppressed the address.
  facts := pg_get_functiondef('private.growth_strategy_facts_json(timestamptz,timestamptz)'::regprocedure);
  if position('not g.internal' in facts) = 0 or position('email_suppressions' in facts) = 0 or position('''caremetric-intel''' in facts) = 0 then
    raise exception 'The funnel must count Intel''s outside organizations and only hard bounces' using errcode = '55000';
  end if;
  if not exists (select 1 from private.agent_schedules where agent_key = 'chief_of_staff' and task_kind = 'strategy.weekly' and cadence = 'daily'
                 and at_local < (select at_local from private.agent_schedules where agent_key = 'chief_of_staff' and task_kind = 'scorecard.weekly')) then
    raise exception 'The strategist must be scheduled before the Monday scorecard' using errcode = '55000';
  end if;
  if not (contract -> 'features' @> to_jsonb(array[feature])) then
    contract := jsonb_set(contract, '{features}', (contract -> 'features') || to_jsonb(array[feature]));
  end if;
  execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L',
    'select ' || quote_literal(contract::text) || '::jsonb');
end $$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon, authenticated;
