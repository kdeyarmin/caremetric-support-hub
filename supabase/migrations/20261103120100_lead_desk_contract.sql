-- Additive deployment gate for the lead desk. Declaring the feature changes no behavior: it states that the leads
-- table exists with row level security and is closed to every browser, service and server role, that conversations
-- can come from the CareBase and Intel websites, that lead intake is a security definer with a pinned empty search
-- path executable by the Hub server role alone (and refusing every other session user), that its helpers are
-- executable by no role, and that the owner's operations authorize the administrator session (reads) or command
-- session (status changes) themselves. Every test fails closed: a function whose search_path setting was reset (which
-- leaves it null) is refused. The Hub server answers POST /api/leads only when the feature is declared; the feature
-- is declared ahead of any build that requires it, and src/lib/backendContract.ts does not require it.
do $$
declare
  contract jsonb := hub.get_backend_contract();
  signature text;
  role_name text;
begin
  if (contract @> '{"api_version":4,"features":["support.communications.v1"]}'::jsonb) is not true then
    raise exception 'Apply unified communications first' using errcode = '55000';
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

  if not exists (
    select 1 from pg_constraint c
    where c.conrelid = 'private.communications'::regclass and c.contype = 'c' and c.convalidated
      and position('source_system' in pg_get_constraintdef(c.oid)) > 0
      and position('''carebase.web''' in pg_get_constraintdef(c.oid)) > 0
      and position('''intel.web''' in pg_get_constraintdef(c.oid)) > 0
      and position('''advisors.web''' in pg_get_constraintdef(c.oid)) > 0) then
    raise exception 'Conversations must accept the CareBase, Intel and Advisors websites as sources' using errcode = '55000';
  end if;

  -- The Hub server's operation.
  signature := 'private.lead_intake(text,jsonb)';
  if to_regprocedure(signature) is null
    or not coalesce((select p.prosecdef and coalesce(p.proconfig @> array['search_path=""'], false) from pg_proc p where p.oid = to_regprocedure(signature)), false)
    or has_function_privilege('anon', signature, 'EXECUTE') or has_function_privilege('authenticated', signature, 'EXECUTE')
    or has_function_privilege('service_role', signature, 'EXECUTE')
    or not has_function_privilege('hub_app_server', signature, 'EXECUTE')
    or position('private.require_hub_app_server()' in pg_get_functiondef(to_regprocedure(signature))) = 0 then
    raise exception 'Lead intake must be a security definer with a pinned search path, executable by the Hub server only' using errcode = '55000';
  end if;

  -- The helpers it and the owner's operations call: no role may run them directly, and each pins its search path.
  foreach signature in array array[
    'private.lead_text(jsonb,integer)', 'private.lead_instant(jsonb)', 'private.lead_json(uuid)', 'private.lead_record(text,jsonb)'
  ] loop
    if to_regprocedure(signature) is null
      or not coalesce((select coalesce(p.proconfig @> array['search_path=""'], false) from pg_proc p where p.oid = to_regprocedure(signature)), false) then
      raise exception 'Lead helpers must exist with a pinned search path' using errcode = '55000';
    end if;
    foreach role_name in array array['anon', 'authenticated', 'service_role', 'hub_app_server'] loop
      if has_function_privilege(role_name, signature, 'EXECUTE') then
        raise exception 'Lead helpers must stay internal to the operations' using errcode = '55000';
      end if;
    end loop;
  end loop;

  -- The owner's operations: signed-in sessions may call them, and each authorizes the administrator session itself.
  signature := 'hub.list_leads(text,text,boolean,integer,integer)';
  if to_regprocedure(signature) is null or has_function_privilege('anon', signature, 'EXECUTE')
    or has_function_privilege('service_role', signature, 'EXECUTE')
    or not has_function_privilege('authenticated', signature, 'EXECUTE')
    or not coalesce((select p.prosecdef and coalesce(p.proconfig @> array['search_path=""'], false) from pg_proc p where p.oid = to_regprocedure(signature)), false)
    or position('hub.authorize_app_admin()' in pg_get_functiondef(to_regprocedure(signature))) = 0 then
    raise exception 'Lead reads require the current administrator session' using errcode = '55000';
  end if;
  signature := 'hub.update_lead_status(uuid,text,timestamp with time zone)';
  if to_regprocedure(signature) is null or has_function_privilege('anon', signature, 'EXECUTE')
    or has_function_privilege('service_role', signature, 'EXECUTE')
    or not has_function_privilege('authenticated', signature, 'EXECUTE')
    or not coalesce((select p.prosecdef and coalesce(p.proconfig @> array['search_path=""'], false) from pg_proc p where p.oid = to_regprocedure(signature)), false)
    or position('hub.authorize_app_command()' in pg_get_functiondef(to_regprocedure(signature))) = 0 then
    raise exception 'Lead changes require the current administrator command session' using errcode = '55000';
  end if;

  if not (contract -> 'features' @> '["support.leads.v1"]'::jsonb) then
    contract := jsonb_set(contract, '{features}', (contract -> 'features') || '["support.leads.v1"]'::jsonb);
  end if;
  execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L',
    'select ' || quote_literal(contract::text) || '::jsonb');
end $$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon, authenticated;
