-- Additive deployment gate for the Chief of Staff's Monday scorecard. Declaring platform.agents.scorecard.v1 is what makes the Hub
-- register `scorecard.weekly` and hold the five weekly reports' scheduled emails while the owner's "Send the individual weekly
-- reports" is off; until it is declared, every weekly report emails as before and there is no scorecard. It states that the
-- setting exists, closed to every role; that the two server reads are security definers with a pinned empty search path, executable
-- by the Hub server alone and refusing every other session user; that their helpers are executable by no role; that the owner
-- operations authorize the owner's session themselves and are closed to anonymous callers; and that the Chief of Staff has its
-- daily schedule. Every test fails closed.
do $$
declare
  contract jsonb := hub.get_backend_contract();
  feature constant text := 'platform.agents.scorecard.v1';
  signature text;
begin
  if (contract @> '{"api_version":4,"features":["platform.agents.v1","platform.agents.hardening.v1","platform.agents.brief.v1","platform.agents.accounts.v1","platform.agents.growth.v1","platform.agents.customer-growth.v1"]}'::jsonb) is not true then
    raise exception 'Apply the AI team control plane, its hardening, the brief, the Account Manager, the Growth Manager and customer growth first' using errcode = '55000';
  end if;

  if to_regclass('private.agent_scorecard_settings') is null
    or not (select relrowsecurity from pg_class where oid = 'private.agent_scorecard_settings'::regclass)
    or (select count(*) from private.agent_scorecard_settings) <> 1
    or exists (select 1 from unnest(array['anon', 'authenticated', 'service_role', 'hub_app_server']) role_name
               where has_table_privilege(role_name, 'private.agent_scorecard_settings', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')) then
    raise exception 'The scorecard setting must exist once and be closed to every role' using errcode = '55000';
  end if;

  foreach signature in array array['private.agent_individual_reports()', 'private.agent_scorecard_facts(timestamptz,timestamptz)'] loop
    if to_regprocedure(signature) is null
      or not coalesce((select p.prosecdef and coalesce(p.proconfig @> array['search_path=""'], false) from pg_proc p where p.oid = to_regprocedure(signature)), false)
      or has_function_privilege('anon', signature, 'EXECUTE') or has_function_privilege('authenticated', signature, 'EXECUTE')
      or has_function_privilege('service_role', signature, 'EXECUTE')
      or not has_function_privilege('hub_app_server', signature, 'EXECUTE')
      or position('private.require_hub_app_server()' in pg_get_functiondef(to_regprocedure(signature))) = 0 then
      raise exception 'The scorecard''s server read % must be a security definer executable by the Hub server only', signature using errcode = '55000';
    end if;
  end loop;

  foreach signature in array array['private.agent_scorecard_settings_json(private.agent_scorecard_settings)', 'private.agent_scorecard_facts_json(timestamptz,timestamptz)'] loop
    if to_regprocedure(signature) is null
      or not coalesce((select coalesce(p.proconfig @> array['search_path=""'], false) from pg_proc p where p.oid = to_regprocedure(signature)), false)
      or exists (select 1 from unnest(array['anon', 'authenticated', 'service_role', 'hub_app_server']) role_name
                 where has_function_privilege(role_name, signature, 'EXECUTE')) then
      raise exception 'The scorecard helper % must pin its search path and be executable by no role', signature using errcode = '55000';
    end if;
  end loop;

  if to_regprocedure('hub.get_scorecard_settings()') is null or to_regprocedure('hub.set_individual_reports(boolean,timestamptz)') is null
    or has_function_privilege('anon', 'hub.get_scorecard_settings()', 'EXECUTE')
    or has_function_privilege('anon', 'hub.set_individual_reports(boolean,timestamptz)', 'EXECUTE')
    or not coalesce((select bool_and(p.prosecdef and coalesce(p.proconfig @> array['search_path=""'], false)) from pg_proc p
                     where p.oid in ('hub.get_scorecard_settings()'::regprocedure, 'hub.set_individual_reports(boolean,timestamptz)'::regprocedure)), false)
    or position('hub.authorize_app_admin()' in pg_get_functiondef('hub.get_scorecard_settings()'::regprocedure)) = 0
    or position('hub.authorize_app_command()' in pg_get_functiondef('hub.set_individual_reports(boolean,timestamptz)'::regprocedure)) = 0 then
    raise exception 'The owner''s scorecard setting must authorize the owner''s session and be closed to anonymous callers' using errcode = '55000';
  end if;

  if not exists (select 1 from private.agent_schedules where agent_key = 'chief_of_staff' and task_kind = 'scorecard.weekly'
                 and cadence = 'daily' and at_local = '07:50'::time and timezone = 'America/New_York' and not requires_session) then
    raise exception 'The Chief of Staff must have its daily scorecard schedule' using errcode = '55000';
  end if;

  if not (contract -> 'features' @> to_jsonb(array[feature])) then
    contract := jsonb_set(contract, '{features}', (contract -> 'features') || to_jsonb(array[feature]));
  end if;
  execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L',
    'select ' || quote_literal(contract::text) || '::jsonb');
end $$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon, authenticated;
