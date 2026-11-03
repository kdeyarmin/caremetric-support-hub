-- Additive deployment gate for the Growth Manager. Declaring the feature changes no behavior: it states that the lead table still
-- has row level security and grants nothing to any browser, service or server role, and has the column the agent marks leads with;
-- that each Growth Manager operation (and the conversation snapshot it extends) is a security definer with a pinned empty search
-- path, executable by the Hub server role alone and refusing every other session user; that their helpers pin an empty search path
-- and are executable by no role at all; and that the agent, its three schedules and the Platform Engineer's lead form check exist.
-- Every test fails closed: a function whose search_path setting was reset (which leaves it null) is refused. The Hub server
-- registers the Growth Manager's handlers only when the feature is declared (read at boot), and src/lib/backendContract.ts does not
-- require it, so the migrations can be applied before or after the build that uses them.
do $$
declare
  contract jsonb := hub.get_backend_contract();
  signature text;
  role_name text;
begin
  if (contract @> '{"api_version":4,"features":["platform.agents.v1","platform.agents.probes.v1","support.leads.v1"]}'::jsonb) is not true then
    raise exception 'Apply the AI team control plane, the health probes and the lead desk first' using errcode = '55000';
  end if;

  if to_regclass('private.leads') is null or not coalesce((select relrowsecurity from pg_class where oid = to_regclass('private.leads')), false) then
    raise exception 'The leads table must exist with row level security' using errcode = '55000';
  end if;
  foreach role_name in array array['anon', 'authenticated', 'service_role', 'hub_app_server'] loop
    if has_table_privilege(role_name, 'private.leads', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      or has_any_column_privilege(role_name, 'private.leads', 'SELECT,INSERT,UPDATE,REFERENCES') then
      raise exception 'The leads table must remain closed to every browser, service and server role' using errcode = '55000';
    end if;
  end loop;
  if not exists (select 1 from pg_attribute where attrelid = to_regclass('private.leads') and attname = 'growth_seen_at' and not attisdropped) then
    raise exception 'The leads table must record which leads the Growth Manager has seen' using errcode = '55000';
  end if;

  -- Every operation the Hub server calls for the Growth Manager, and the snapshot it extends.
  foreach signature in array array[
    'private.agent_growth_pending(integer,integer)',
    'private.agent_growth_lead(uuid)',
    'private.agent_growth_mark_seen(uuid[])',
    'private.agent_growth_unanswered(integer,integer)',
    'private.agent_growth_facts(timestamp with time zone,timestamp with time zone)',
    'private.agent_lead_probe_seen(text,timestamp with time zone)',
    'private.agent_communication_snapshot(uuid,uuid,integer,integer)'
  ] loop
    if to_regprocedure(signature) is null
      or not coalesce((select p.prosecdef and coalesce(p.proconfig @> array['search_path=""'], false) from pg_proc p where p.oid = to_regprocedure(signature)), false)
      or has_function_privilege('anon', signature, 'EXECUTE') or has_function_privilege('authenticated', signature, 'EXECUTE')
      or has_function_privilege('service_role', signature, 'EXECUTE')
      or not has_function_privilege('hub_app_server', signature, 'EXECUTE')
      or position('private.require_hub_app_server()' in pg_get_functiondef(to_regprocedure(signature))) = 0 then
      raise exception 'Growth Manager operations must be security definer with a pinned search path, executable by the Hub server only' using errcode = '55000';
    end if;
  end loop;

  -- The helpers those operations call: no role may run them directly, and each pins its search path.
  foreach signature in array array[
    'private.agent_growth_product(text)',
    'private.agent_growth_waiting()',
    'private.agent_growth_pending_json(integer,integer)',
    'private.agent_growth_lead_json(uuid)',
    'private.agent_growth_mark_seen_rows(uuid[])',
    'private.agent_growth_unanswered_json(integer,integer)',
    'private.agent_growth_facts_json(timestamp with time zone,timestamp with time zone)',
    'private.agent_growth_probe_seen(text,timestamp with time zone)'
  ] loop
    if to_regprocedure(signature) is null
      or not coalesce((select coalesce(p.proconfig @> array['search_path=""'], false) from pg_proc p where p.oid = to_regprocedure(signature)), false) then
      raise exception 'Growth Manager helpers must exist with a pinned search path' using errcode = '55000';
    end if;
    foreach role_name in array array['anon', 'authenticated', 'service_role', 'hub_app_server'] loop
      if has_function_privilege(role_name, signature, 'EXECUTE') then
        raise exception 'Growth Manager helpers must stay internal to the operations' using errcode = '55000';
      end if;
    end loop;
  end loop;

  if not exists (select 1 from private.agents where key = 'growth_manager') then
    raise exception 'The Growth Manager agent must exist' using errcode = '55000';
  end if;
  if (select count(*) from private.agent_schedules
      where agent_key = 'growth_manager'
        and ((task_kind = 'growth.leads' and cadence = 'interval') or (task_kind = 'growth.followup' and cadence = 'interval')
             or (task_kind = 'growth.weekly' and cadence = 'daily'))) <> 3 then
    raise exception 'The Growth Manager schedules must exist' using errcode = '55000';
  end if;
  if not exists (select 1 from private.agent_schedules where agent_key = 'platform_engineer' and task_kind = 'probe.forms' and cadence = 'interval') then
    raise exception 'The lead form check schedule must exist' using errcode = '55000';
  end if;

  if not (contract -> 'features' @> '["platform.agents.growth.v1"]'::jsonb) then
    contract := jsonb_set(contract, '{features}', (contract -> 'features') || '["platform.agents.growth.v1"]'::jsonb);
  end if;
  execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L',
    'select ' || quote_literal(contract::text) || '::jsonb');
end $$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon, authenticated;
