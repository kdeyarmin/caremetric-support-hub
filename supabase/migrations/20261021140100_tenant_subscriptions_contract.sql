-- Additive deployment gate for manual tenant setup and subscription pricing.
-- Declaring the feature changes no behavior: pricing stays private, reads stay
-- behind the current administrator session and writes behind the command session.
do $$ declare contract jsonb:=hub.get_backend_contract(); signature text; begin
  if (contract @> '{"api_version":4,"features":["app.sms.v1","platform.admin.read.v1","platform.admin.command.v1"]}'::jsonb) is not true then
    raise exception 'Apply the Hub SMS and administrator foundations first' using errcode='55000';
  end if;
  if to_regclass('private.tenant_subscriptions') is null
    or not (select relrowsecurity from pg_class where oid=to_regclass('private.tenant_subscriptions'))
    or has_table_privilege('anon','private.tenant_subscriptions','SELECT,INSERT,UPDATE,DELETE')
    or has_table_privilege('authenticated','private.tenant_subscriptions','SELECT,INSERT,UPDATE,DELETE')
    or has_table_privilege('service_role','private.tenant_subscriptions','SELECT,INSERT,UPDATE,DELETE')
    or has_table_privilege('hub_app_server','private.tenant_subscriptions','SELECT,INSERT,UPDATE,DELETE') then
    raise exception 'Tenant subscription pricing must exist and remain closed' using errcode='55000';
  end if;
  foreach signature in array array['private.validate_tenant_subscription(jsonb)','private.tenant_account(uuid)','private.write_tenant_subscription(uuid,uuid,jsonb,integer)'] loop
    if to_regprocedure(signature) is null or has_function_privilege('anon',signature,'EXECUTE')
      or has_function_privilege('authenticated',signature,'EXECUTE') or has_function_privilege('hub_app_server',signature,'EXECUTE') then
      raise exception 'Tenant subscription helpers must remain private' using errcode='55000';
    end if;
  end loop;
  signature:='hub.list_tenant_accounts()';
  if to_regprocedure(signature) is null or has_function_privilege('anon',signature,'EXECUTE')
    or not has_function_privilege('authenticated',signature,'EXECUTE')
    or position('hub.authorize_app_admin()' in pg_get_functiondef(signature::regprocedure))=0 then
    raise exception 'Tenant accounts require the current administrator session' using errcode='55000';
  end if;
  foreach signature in array array['hub.create_tenant(jsonb)','hub.save_tenant(uuid,jsonb,timestamptz)','hub.save_tenant_subscription(uuid,uuid,jsonb,integer)'] loop
    if to_regprocedure(signature) is null or has_function_privilege('anon',signature,'EXECUTE')
      or not has_function_privilege('authenticated',signature,'EXECUTE')
      or position('hub.authorize_app_command()' in pg_get_functiondef(signature::regprocedure))=0 then
      raise exception 'Tenant changes require the current administrator command session' using errcode='55000';
    end if;
  end loop;
  if not (contract->'features' @> '["platform.admin.tenants.v1"]'::jsonb) then
    contract:=jsonb_set(contract,'{features}',(contract->'features')||'["platform.admin.tenants.v1"]'::jsonb);
  end if;
  execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L','select '||quote_literal(contract::text)||'::jsonb');
end $$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon,authenticated;
