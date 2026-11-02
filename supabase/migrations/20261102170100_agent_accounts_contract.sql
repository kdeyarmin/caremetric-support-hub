-- Additive deployment gate for the Account Manager. Declaring the feature changes no behavior: it states that the account
-- snapshot operation exists and stays a security definer with a pinned empty search path, executable by the Hub server role alone,
-- that its two internal helpers are executable by no role at all, and that the agent and its weekly schedule exist. The gate
-- refuses to declare the feature if any of that has drifted. The tables and operations it builds on are the control plane's and the
-- platform billing mirror's, each already guarded by its own gate.
do $$
declare
  contract jsonb := hub.get_backend_contract();
  signature text;
begin
  if (contract @> '{"api_version":4,"features":["platform.agents.v1","billing.platform.v1"]}'::jsonb) is not true then
    raise exception 'Apply the AI team control plane and the platform billing mirror first' using errcode = '55000';
  end if;

  -- The one operation the Hub server calls.
  signature := 'private.agent_accounts_snapshot(integer)';
  if to_regprocedure(signature) is null
    or not coalesce((select p.prosecdef and p.proconfig @> array['search_path=""'] from pg_proc p where p.oid = to_regprocedure(signature)), false)
    or has_function_privilege('anon', signature, 'EXECUTE') or has_function_privilege('authenticated', signature, 'EXECUTE')
    or has_function_privilege('service_role', signature, 'EXECUTE')
    or not has_function_privilege('hub_app_server', signature, 'EXECUTE') then
    raise exception 'The account snapshot must be a security definer executable by the Hub server only' using errcode = '55000';
  end if;

  -- The helpers it calls: pinned search path, and no role may run them directly.
  foreach signature in array array['private.agent_accounts_json(integer)', 'private.agent_subscription_facts(private.billing_subscriptions)'] loop
    if to_regprocedure(signature) is null
      or not coalesce((select p.proconfig @> array['search_path=""'] from pg_proc p where p.oid = to_regprocedure(signature)), false)
      or has_function_privilege('anon', signature, 'EXECUTE') or has_function_privilege('authenticated', signature, 'EXECUTE')
      or has_function_privilege('service_role', signature, 'EXECUTE') or has_function_privilege('hub_app_server', signature, 'EXECUTE') then
      raise exception 'The account snapshot helpers must not be executable by any application role' using errcode = '55000';
    end if;
  end loop;

  if not exists (select 1 from private.agents where key = 'account_manager') then
    raise exception 'The Account Manager agent must exist' using errcode = '55000';
  end if;
  if not exists (select 1 from private.agent_schedules where agent_key = 'account_manager' and task_kind = 'accounts.weekly' and cadence = 'daily') then
    raise exception 'The Account Manager weekly schedule must exist' using errcode = '55000';
  end if;

  if not (contract -> 'features' @> '["platform.agents.accounts.v1"]'::jsonb) then
    contract := jsonb_set(contract, '{features}', (contract -> 'features') || '["platform.agents.accounts.v1"]'::jsonb);
  end if;
  execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L',
    'select ' || quote_literal(contract::text) || '::jsonb');
end $$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon, authenticated;
