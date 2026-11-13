-- Declares platform.agents.watchdog.v1 once graduation asks for evidence, only the Hub server reads the watchdog facts and the setting exists.
do $$
declare
  contract jsonb := hub.get_backend_contract();
  feature constant text := 'platform.agents.watchdog.v1';
begin
  if (contract @> '{"api_version":4,"features":["platform.settings.v1"]}'::jsonb) is not true then
    raise exception 'Apply the Hub settings migration first' using errcode = '55000';
  end if;
  if not exists (select 1 from private.hub_settings where key = 'agents.watchdog_idle_days' and kind = 'number') then
    raise exception 'The watchdog setting is missing' using errcode = '55000';
  end if;
  if position('agent_autonomy_evidence' in pg_get_functiondef('private.agent_autonomy_graduate(text)'::regprocedure)) = 0
    or position('too_many_rejections' in pg_get_functiondef('private.agent_autonomy_graduate(text)'::regprocedure)) = 0 then
    raise exception 'Hand-over must ask for evidence' using errcode = '55000';
  end if;
  if not has_function_privilege('hub_app_server', 'private.agent_watchdog_facts()', 'execute')
    or exists (select 1 from unnest(array['anon', 'authenticated', 'service_role']) r where has_function_privilege(r, 'private.agent_watchdog_facts()', 'execute')) then
    raise exception 'Only the Hub server may read the watchdog facts' using errcode = '55000';
  end if;
  if not (contract -> 'features' @> to_jsonb(array[feature])) then
    contract := jsonb_set(contract, '{features}', (contract -> 'features') || to_jsonb(array[feature]));
  end if;
  execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L',
    'select ' || quote_literal(contract::text) || '::jsonb');
end $$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon, authenticated;
