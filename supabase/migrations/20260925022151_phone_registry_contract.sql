-- Additive deployment gate for the private phone inventory.
do $$ declare contract jsonb:=hub.get_backend_contract(); signature text; begin
  if (contract @> '{"api_version":4,"features":["app.sms.v1","platform.admin.read.v1"]}'::jsonb) is not true then
    raise exception 'Apply the Hub SMS and administrator foundations first' using errcode='55000';
  end if;
  if to_regclass('private.phone_numbers') is null or to_regprocedure('hub.list_phone_numbers()') is null
    or to_regprocedure('hub.save_phone_number(uuid,jsonb,integer)') is null
    or to_regprocedure('hub.authorize_app_admin()') is null then
    raise exception 'Apply the phone registry and administrator authorization first' using errcode='55000';
  end if;
  if not (select relrowsecurity from pg_class where oid='private.phone_numbers'::regclass)
    or has_table_privilege('authenticated','private.phone_numbers','SELECT,INSERT,UPDATE,DELETE')
    or has_table_privilege('anon','private.phone_numbers','SELECT,INSERT,UPDATE,DELETE')
    or has_table_privilege('hub_app_server','private.phone_numbers','SELECT,INSERT,UPDATE,DELETE') then
    raise exception 'Private phone registry access must remain closed' using errcode='55000';
  end if;
  foreach signature in array array['hub.list_phone_numbers()','hub.save_phone_number(uuid,jsonb,integer)'] loop
    if has_function_privilege('anon',signature,'EXECUTE')
      or not has_function_privilege('authenticated',signature,'EXECUTE')
      or position('hub.authorize_app_admin()' in pg_get_functiondef(signature::regprocedure))=0 then
      raise exception 'Phone registry RPCs require current administrator authorization' using errcode='55000';
    end if;
  end loop;
  if not (contract->'features' @> '["phone.registry.v1"]'::jsonb) then
    contract:=jsonb_set(contract,'{features}',(contract->'features')||'["phone.registry.v1"]'::jsonb);
  end if;
  execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L','select '||quote_literal(contract::text)||'::jsonb');
end $$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon,authenticated;
