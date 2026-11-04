-- Additive deployment gate for autonomy steps. Declaring the feature changes no behavior: it states that the steps table exists with
-- row level security and is closed to every browser, service and server role; that the two server operations are security definers
-- with a pinned empty search path executable by the Hub server role alone (three, with the one that records the owner was told); that the two owner operations authorize the owner's
-- session themselves and are executable by signed-in sessions only; that the internal helpers are executable by no role; and that
-- the steps and the Chief of Staff's hourly schedule exist. Every test fails closed, as in the hardening gate.
do $$
declare
  contract jsonb := hub.get_backend_contract();
  signature text;
  role_name text;
begin
  if (contract @> '{"api_version":4,"features":["platform.agents.v1","platform.agents.hardening.v1","platform.agents.lifecycle.v1"]}'::jsonb) is not true then
    raise exception 'Apply the AI team control plane, its hardening and the customer emails first' using errcode = '55000';
  end if;

  if to_regclass('private.agent_autonomy_steps') is null
    or not coalesce((select relrowsecurity from pg_class where oid = to_regclass('private.agent_autonomy_steps')), false) then
    raise exception 'The autonomy steps table must exist with row level security' using errcode = '55000';
  end if;
  foreach role_name in array array['anon', 'authenticated', 'service_role', 'hub_app_server'] loop
    if has_table_privilege(role_name, 'private.agent_autonomy_steps', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
      or has_any_column_privilege(role_name, 'private.agent_autonomy_steps', 'SELECT,INSERT,UPDATE,REFERENCES') then
      raise exception 'The autonomy steps table must remain closed to every browser, service and server role' using errcode = '55000';
    end if;
  end loop;

  foreach signature in array array['private.agent_autonomy_due()', 'private.agent_autonomy_graduate(text)', 'private.agent_autonomy_announced(text,timestamp with time zone)'] loop
    if to_regprocedure(signature) is null
      or not coalesce((select p.prosecdef and coalesce(p.proconfig @> array['search_path=""'], false) from pg_proc p where p.oid = to_regprocedure(signature)), false)
      or has_function_privilege('anon', signature, 'EXECUTE') or has_function_privilege('authenticated', signature, 'EXECUTE')
      or has_function_privilege('service_role', signature, 'EXECUTE')
      or not has_function_privilege('hub_app_server', signature, 'EXECUTE')
      or position('private.require_hub_app_server()' in pg_get_functiondef(to_regprocedure(signature))) = 0 then
      raise exception 'Autonomy server operations must be security definer with a pinned search path, executable by the Hub server only' using errcode = '55000';
    end if;
  end loop;

  foreach signature in array array['hub.get_agent_autonomy()', 'hub.set_agent_autonomy_step(text,text,timestamp with time zone)'] loop
    if to_regprocedure(signature) is null
      or not coalesce((select p.prosecdef and coalesce(p.proconfig @> array['search_path=""'], false) from pg_proc p where p.oid = to_regprocedure(signature)), false)
      or has_function_privilege('anon', signature, 'EXECUTE') or has_function_privilege('service_role', signature, 'EXECUTE')
      or not has_function_privilege('authenticated', signature, 'EXECUTE')
      or (position('hub.authorize_app_admin()' in pg_get_functiondef(to_regprocedure(signature))) = 0
        and position('hub.authorize_app_command()' in pg_get_functiondef(to_regprocedure(signature))) = 0) then
      raise exception 'Autonomy owner operations must authorize the owner''s session and be executable by signed-in sessions only' using errcode = '55000';
    end if;
  end loop;
  if position('hub.authorize_app_command()' in pg_get_functiondef(to_regprocedure('hub.set_agent_autonomy_step(text,text,timestamp with time zone)'))) = 0 then
    raise exception 'Changing an autonomy step must need a current administrator session' using errcode = '55000';
  end if;

  foreach signature in array array[
    'private.agent_autonomy_step_json(private.agent_autonomy_steps)',
    'private.agent_autonomy_change(text,jsonb,boolean)',
    'private.agent_autonomy_apply(text,text,uuid,text)'
  ] loop
    if to_regprocedure(signature) is null
      or not coalesce((select coalesce(p.proconfig @> array['search_path=""'], false) from pg_proc p where p.oid = to_regprocedure(signature)), false) then
      raise exception 'The autonomy helpers must exist with a pinned search path' using errcode = '55000';
    end if;
    foreach role_name in array array['anon', 'authenticated', 'service_role', 'hub_app_server'] loop
      if has_function_privilege(role_name, signature, 'EXECUTE') then
        raise exception 'The autonomy helpers must stay internal to their operations' using errcode = '55000';
      end if;
    end loop;
  end loop;

  if (select count(*) from private.agent_autonomy_steps where category in ('account_emails', 'support_answers', 'articles', 'offers')) <> 4 then
    raise exception 'The autonomy steps must exist' using errcode = '55000';
  end if;
  if not exists (select 1 from private.agent_schedules where agent_key = 'chief_of_staff' and task_kind = 'autonomy.graduate' and cadence = 'interval' and every_seconds = 3600 and not requires_session) then
    raise exception 'The hourly autonomy schedule must exist' using errcode = '55000';
  end if;

  if not (contract -> 'features' @> '["platform.agents.autonomy.v1"]'::jsonb) then
    contract := jsonb_set(contract, '{features}', (contract -> 'features') || '["platform.agents.autonomy.v1"]'::jsonb);
  end if;
  execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L',
    'select ' || quote_literal(contract::text) || '::jsonb');
end $$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon, authenticated;
