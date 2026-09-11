do $$ declare contract jsonb:=hub.get_backend_contract(); signature text; role_name text; begin
 if not (contract @> '{"api_version":4,"features":["learning.sources.v1","app.sms.v1"]}'::jsonb) then
  raise exception 'Apply source and SMS foundations first' using errcode='55000'; end if;
 if not exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='private' and c.relname='pennsync_learning_snapshots' and c.relrowsecurity) then
  raise exception 'Private PennSync source storage required' using errcode='55000';end if;
 foreach role_name in array array['anon','authenticated','service_role','hub_app_server'] loop
  if has_table_privilege(role_name,'private.pennsync_learning_snapshots','select,insert,update,delete') then raise exception 'PennSync source boundary invalid' using errcode='55000';end if;
 end loop;
 foreach signature in array array['private.pennsync_learning_head()','private.pennsync_learning_preserve(text,text,text,jsonb)'] loop
  if to_regprocedure(signature) is null or not has_function_privilege('hub_app_server',signature,'execute') then raise exception 'Missing PennSync source operation' using errcode='55000';end if;
  foreach role_name in array array['anon','authenticated','service_role'] loop
   if has_function_privilege(role_name,signature,'execute') then raise exception 'PennSync source operation exposed' using errcode='55000';end if;
  end loop;
 end loop;
 if not (contract->'features' @> '["learning.pennsync-source.v1"]'::jsonb) then contract:=jsonb_set(contract,'{features}',(contract->'features')||'["learning.pennsync-source.v1"]'::jsonb);end if;
 execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L','select '||quote_literal(contract::text)||'::jsonb');
end $$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon,authenticated;
