-- Additive deployment gate for the Account Manager's customer emails. Declaring the feature changes no behavior: it states that
-- the send ledger exists with row level security and is closed to every browser, service and server role; that the three new
-- operations, and the two this change replaced (the proposal operation, which now carries the per-template rule, and the one
-- unsubscribe operation), are security definers with a pinned empty search path executable by the Hub server role alone; that the
-- facts helper is executable by no role; that the action kind, its shape check and its once-per-period index exist; and that the
-- agent, its daily schedule and its auto_send_templates setting exist. Every test fails closed, as in the hardening gate: a function
-- whose search_path setting was reset (which leaves it null) is refused. The gate refuses to declare the feature if any of it has
-- drifted.
do $$
declare
  contract jsonb := hub.get_backend_contract();
  signature text;
  role_name text;
begin
  if (contract @> '{"api_version":4,"features":["platform.agents.accounts.v1","platform.agents.hardening.v1","support.bulk-email.v1"]}'::jsonb) is not true then
    raise exception 'Apply the Account Manager, the AI team hardening and bulk email first' using errcode = '55000';
  end if;

  if to_regclass('private.agent_lifecycle_emails') is null
    or not coalesce((select relrowsecurity from pg_class where oid = to_regclass('private.agent_lifecycle_emails')), false) then
    raise exception 'The customer email ledger must exist with row level security' using errcode = '55000';
  end if;
  foreach role_name in array array['anon', 'authenticated', 'service_role', 'hub_app_server'] loop
    if has_table_privilege(role_name, 'private.agent_lifecycle_emails', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
      or has_any_column_privilege(role_name, 'private.agent_lifecycle_emails', 'SELECT,INSERT,UPDATE') then
      raise exception 'The customer email ledger must remain closed to every browser, service and server role' using errcode = '55000';
    end if;
  end loop;

  if not exists (select 1 from pg_constraint where conrelid = 'private.agent_actions'::regclass and conname = 'agent_actions_email_send_check')
    or not coalesce((select position('''email.send''' in pg_get_constraintdef(oid)) > 0 from pg_constraint
                     where conrelid = 'private.agent_actions'::regclass and conname = 'agent_actions_kind_check'), false)
    or not coalesce((select position('''billing_account''' in pg_get_constraintdef(oid)) > 0 from pg_constraint
                     where conrelid = 'private.agent_actions'::regclass and conname = 'agent_actions_target_kind_check'), false)
    or not exists (select 1 from pg_index i where i.indexrelid = to_regclass('private.agent_actions_email_send_once') and i.indisunique) then
    raise exception 'Customer emails must be a checked action kind, proposed once per period' using errcode = '55000';
  end if;

  -- The operations the Hub server calls: the three new ones and the two this change replaced.
  foreach signature in array array[
    'private.agent_lifecycle_snapshot(integer,text,text)',
    'private.agent_lifecycle_begin_send(uuid,integer,text)',
    'private.agent_lifecycle_finish_send(uuid,text,text)',
    'private.agent_action_propose(uuid,uuid,text,text,text,text,jsonb)',
    'private.email_unsubscribe(text,boolean)'
  ] loop
    if to_regprocedure(signature) is null
      or not coalesce((select p.prosecdef and coalesce(p.proconfig @> array['search_path=""'], false) from pg_proc p where p.oid = to_regprocedure(signature)), false)
      or has_function_privilege('anon', signature, 'EXECUTE') or has_function_privilege('authenticated', signature, 'EXECUTE')
      or has_function_privilege('service_role', signature, 'EXECUTE')
      or not has_function_privilege('hub_app_server', signature, 'EXECUTE')
      or (position('hub_app_server' in pg_get_functiondef(to_regprocedure(signature))) = 0
        and position('private.require_hub_app_server()' in pg_get_functiondef(to_regprocedure(signature))) = 0) then
      raise exception 'Customer email operations must be security definer with a pinned search path, executable by the Hub server only' using errcode = '55000';
    end if;
  end loop;
  if position('auto_send_templates' in pg_get_functiondef(to_regprocedure('private.agent_action_propose(uuid,uuid,text,text,text,text,jsonb)'))) = 0 then
    raise exception 'Customer emails must be approved on their own only template by template' using errcode = '55000';
  end if;

  -- The helper the facts operation calls: a pinned search path, and no role may run it directly.
  signature := 'private.agent_lifecycle_json(integer,text,text)';
  if to_regprocedure(signature) is null
    or not coalesce((select coalesce(p.proconfig @> array['search_path=""'], false) from pg_proc p where p.oid = to_regprocedure(signature)), false) then
    raise exception 'The customer email helper must exist with a pinned search path' using errcode = '55000';
  end if;
  foreach role_name in array array['anon', 'authenticated', 'service_role', 'hub_app_server'] loop
    if has_function_privilege(role_name, signature, 'EXECUTE') then
      raise exception 'The customer email helper must stay internal to its operation' using errcode = '55000';
    end if;
  end loop;

  if not exists (select 1 from private.agents where key = 'account_manager' and jsonb_typeof(config -> 'auto_send_templates') = 'array') then
    raise exception 'The Account Manager must exist with its auto_send_templates setting' using errcode = '55000';
  end if;
  if not exists (select 1 from private.agent_schedules where agent_key = 'account_manager' and task_kind = 'accounts.lifecycle' and cadence = 'daily') then
    raise exception 'The Account Manager customer email schedule must exist' using errcode = '55000';
  end if;

  if not (contract -> 'features' @> '["platform.agents.lifecycle.v1"]'::jsonb) then
    contract := jsonb_set(contract, '{features}', (contract -> 'features') || '["platform.agents.lifecycle.v1"]'::jsonb);
  end if;
  execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L',
    'select ' || quote_literal(contract::text) || '::jsonb');
end $$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon, authenticated;
