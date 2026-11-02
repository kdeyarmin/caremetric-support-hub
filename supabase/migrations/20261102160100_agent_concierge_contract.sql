-- Additive deployment gate for the Support Concierge. Declaring the feature changes no behavior: it states that the
-- Concierge's three server-only operations exist and stay security definers with a pinned empty search path,
-- executable by the Hub server role alone, and that the agent and its sweep schedule exist. The gate refuses to
-- declare the feature if any of that has drifted. The tables and operations it builds on are the control plane's and
-- the unified communications', each already guarded by its own gate.
do $$
declare
  contract jsonb := hub.get_backend_contract();
  signature text;
begin
  if (contract @> '{"api_version":4,"features":["platform.agents.v1","support.communications.v1"]}'::jsonb) is not true then
    raise exception 'Apply the AI team control plane and the unified communications foundation first' using errcode = '55000';
  end if;

  foreach signature in array array[
    'private.agent_concierge_pending(integer,integer,integer,text[])',
    'private.agent_communication_snapshot(uuid,uuid,integer,integer)',
    'private.agent_notification_count(text,text,timestamptz)'
  ] loop
    if to_regprocedure(signature) is null
      or not coalesce((select p.prosecdef and p.proconfig @> array['search_path=""'] from pg_proc p where p.oid = to_regprocedure(signature)), false)
      or has_function_privilege('anon', signature, 'EXECUTE') or has_function_privilege('authenticated', signature, 'EXECUTE')
      or has_function_privilege('service_role', signature, 'EXECUTE')
      or not has_function_privilege('hub_app_server', signature, 'EXECUTE') then
      raise exception 'The Concierge operations must be security definers executable by the Hub server only' using errcode = '55000';
    end if;
  end loop;

  if not exists (select 1 from private.agents where key = 'support_concierge') then
    raise exception 'The Support Concierge agent must exist' using errcode = '55000';
  end if;
  if not exists (select 1 from private.agent_schedules where agent_key = 'support_concierge' and task_kind = 'concierge.sweep' and cadence = 'interval') then
    raise exception 'The Support Concierge sweep schedule must exist' using errcode = '55000';
  end if;

  if not (contract -> 'features' @> '["platform.agents.concierge.v1"]'::jsonb) then
    contract := jsonb_set(contract, '{features}', (contract -> 'features') || '["platform.agents.concierge.v1"]'::jsonb);
  end if;
  execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L',
    'select ' || quote_literal(contract::text) || '::jsonb');
end $$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon, authenticated;
