-- Additive deployment gate for the AI team hardening. Declaring the feature changes no behavior: it states
-- that the fenced and filtered operations exist, that every AI team operation (old signatures and new) is a
-- security definer with a pinned empty search path executable by the Hub server role alone, that the owner
-- operations still authorize the administrator command session themselves, and that the AI team tables are
-- still closed to every browser, service and server role. Every test here fails closed: a function whose
-- search_path setting is missing (ALTER FUNCTION ... RESET search_path leaves it null) is refused, where the
-- earlier gates' negated tests let a null through. The gate refuses to declare the feature if any of it has drifted.
do $$
declare
  contract jsonb := hub.get_backend_contract();
  relation text;
  signature text;
  role_name text;
begin
  if (contract @> '{"api_version":4,"features":["platform.agents.v1","platform.agents.probes.v1","platform.agents.brief.v1"]}'::jsonb) is not true then
    raise exception 'Apply the AI team control plane, health probes and morning brief first' using errcode = '55000';
  end if;

  foreach relation in array array[
    'private.agents', 'private.agent_schedules', 'private.agent_tasks', 'private.agent_runs',
    'private.agent_actions', 'private.owner_notifications', 'private.agent_probe_state'
  ] loop
    if to_regclass(relation) is null or not coalesce((select relrowsecurity from pg_class where oid = to_regclass(relation)), false) then
      raise exception 'The AI team tables must exist with row level security' using errcode = '55000';
    end if;
    foreach role_name in array array['anon', 'authenticated', 'service_role', 'hub_app_server'] loop
      if has_table_privilege(role_name, relation, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
        or has_any_column_privilege(role_name, relation, 'SELECT,INSERT,UPDATE') then
        raise exception 'The AI team tables must remain closed to every browser, service and server role' using errcode = '55000';
      end if;
    end loop;
  end loop;

  if not exists (select 1 from pg_attribute where attrelid = to_regclass('private.owner_notifications') and attname = 'attempted_at' and not attisdropped)
    or not exists (select 1 from pg_attribute where attrelid = to_regclass('private.agent_actions') and attname = 'executions' and not attisdropped) then
    raise exception 'The AI team hardening columns must exist' using errcode = '55000';
  end if;

  -- Every operation the Hub server calls: the signatures that existed before this change (now thin wrappers) and the new ones.
  foreach signature in array array[
    'private.agent_budget(text)',
    'private.agent_schedule_fire(integer,text[])',
    'private.agent_maintenance()',
    'private.agent_task_enqueue(text,text,text,jsonb,integer,timestamp with time zone,text,text,boolean)',
    'private.agent_task_claim(integer,integer)',
    'private.agent_task_heartbeat(uuid,integer)',
    'private.agent_task_heartbeat(uuid,integer,integer)',
    'private.agent_task_finish(uuid,text,jsonb,text,timestamp with time zone)',
    'private.agent_task_finish(uuid,text,jsonb,text,timestamp with time zone,integer)',
    'private.agent_session_tasks(integer)',
    'private.agent_session_task_claim(uuid,integer)',
    'private.agent_run_start(uuid,text,text)',
    'private.agent_run_finish(uuid,text,jsonb,text,text)',
    'private.agent_action_propose(uuid,uuid,text,text,text,text,jsonb)',
    'private.agent_actions_ready(integer)',
    'private.agent_actions_ready(integer,text[],text[])',
    'private.agent_action_execution(uuid)',
    'private.agent_action_executed(uuid,boolean,jsonb)',
    'private.agent_action_executed(uuid,boolean,jsonb,integer)',
    'private.agent_action_release(uuid,integer)',
    'private.agent_notify_begin(text,text,text,text,text,text,uuid)',
    'private.agent_notify_finish(uuid,text,text)',
    'private.owner_contact()',
    'private.agent_probe_record(text,boolean,integer,integer,text,integer,text)',
    'private.agent_brief_facts()'
  ] loop
    if to_regprocedure(signature) is null
      or not coalesce((select p.prosecdef and coalesce(p.proconfig @> array['search_path=""'], false) from pg_proc p where p.oid = to_regprocedure(signature)), false)
      or has_function_privilege('anon', signature, 'EXECUTE') or has_function_privilege('authenticated', signature, 'EXECUTE')
      or has_function_privilege('service_role', signature, 'EXECUTE')
      or not has_function_privilege('hub_app_server', signature, 'EXECUTE') then
      raise exception 'AI team operations must be security definer with a pinned search path, executable by the Hub server only' using errcode = '55000';
    end if;
  end loop;

  -- The helpers those operations call: no role may run them directly, and each pins its search path.
  foreach signature in array array[
    'private.agent_day_start()', 'private.agent_spent_today_cents(text)', 'private.agent_budget_json(text)',
    'private.agent_schedule_next(text,integer,time without time zone,text,timestamp with time zone,timestamp with time zone)',
    'private.agent_task_json(uuid)', 'private.agent_summary_json(text)', 'private.agent_close_task_if_settled(uuid)'
  ] loop
    if to_regprocedure(signature) is null
      or not coalesce((select coalesce(p.proconfig @> array['search_path=""'], false) from pg_proc p where p.oid = to_regprocedure(signature)), false) then
      raise exception 'AI team helpers must exist with a pinned search path' using errcode = '55000';
    end if;
    foreach role_name in array array['anon', 'authenticated', 'service_role', 'hub_app_server'] loop
      if has_function_privilege(role_name, signature, 'EXECUTE') then
        raise exception 'AI team helpers must stay internal to the operations' using errcode = '55000';
      end if;
    end loop;
  end loop;

  -- The owner's operations: signed-in sessions may call them, and each authorizes the administrator session itself.
  foreach signature in array array[
    'hub.get_agent_team()', 'hub.list_agent_activity(text,text,integer,integer)', 'hub.list_audit_events(text,integer,integer)'
  ] loop
    if to_regprocedure(signature) is null or has_function_privilege('anon', signature, 'EXECUTE')
      or not has_function_privilege('authenticated', signature, 'EXECUTE')
      or not coalesce((select p.prosecdef and coalesce(p.proconfig @> array['search_path=""'], false) from pg_proc p where p.oid = to_regprocedure(signature)), false)
      or position('hub.authorize_app_admin()' in pg_get_functiondef(to_regprocedure(signature))) = 0 then
      raise exception 'AI team reads require the current administrator session' using errcode = '55000';
    end if;
  end loop;

  foreach signature in array array[
    'hub.set_agent_status(text,text,timestamp with time zone)',
    'hub.set_agent_autonomy(text,text,timestamp with time zone)',
    'hub.set_agent_budget(text,integer,timestamp with time zone)',
    'hub.decide_agent_action(uuid,text,text)',
    'hub.request_agent_task(text,text)',
    'hub.cancel_agent_task(uuid)'
  ] loop
    if to_regprocedure(signature) is null or has_function_privilege('anon', signature, 'EXECUTE')
      or not has_function_privilege('authenticated', signature, 'EXECUTE')
      or not coalesce((select p.prosecdef and coalesce(p.proconfig @> array['search_path=""'], false) from pg_proc p where p.oid = to_regprocedure(signature)), false)
      or position('hub.authorize_app_command()' in pg_get_functiondef(to_regprocedure(signature))) = 0 then
      raise exception 'AI team changes require the current administrator command session' using errcode = '55000';
    end if;
  end loop;

  if not (contract -> 'features' @> '["platform.agents.hardening.v1"]'::jsonb) then
    contract := jsonb_set(contract, '{features}', (contract -> 'features') || '["platform.agents.hardening.v1"]'::jsonb);
  end if;
  execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L',
    'select ' || quote_literal(contract::text) || '::jsonb');
end $$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon, authenticated;
