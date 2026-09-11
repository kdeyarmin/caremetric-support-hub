-- Declare only the installed private DocStudio runtime; preserve independent
-- course, billing and operational features across coordinated releases.
do $$ declare contract jsonb:=hub.get_backend_contract(); signature text; table_name text; begin
 if not (contract @> '{"api_version":4,"features":["knowledge.publications.v1","app.sms.v1"]}'::jsonb) then raise exception 'Apply the reviewed publication and SMS foundation first' using errcode='55000'; end if;
 foreach table_name in array array['projects','revisions','approvals','intents','assets','workers','jobs','outputs','media_tokens','exports','cleanup_queue'] loop
  if not exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='private' and c.relname='docstudio_'||table_name and c.relrowsecurity)
   or has_table_privilege('anon','private.docstudio_'||table_name,'select,insert,update,delete')
   or has_table_privilege('authenticated','private.docstudio_'||table_name,'select,insert,update,delete')
   or has_table_privilege('service_role','private.docstudio_'||table_name,'select,insert,update,delete')
   or has_table_privilege('hub_app_server','private.docstudio_'||table_name,'select,insert,update,delete') then raise exception 'DocStudio private table boundary missing' using errcode='55000';end if;
 end loop;
 foreach signature in array array['private.docstudio_read(jsonb)','private.docstudio_project(uuid)','private.docstudio_preview(uuid,jsonb)','private.docstudio_apply(uuid,uuid,boolean,boolean)',
  'private.docstudio_worker(text,uuid,text,jsonb)','private.docstudio_worker_manifest(uuid,text)','private.docstudio_stage_asset(uuid,jsonb)','private.docstudio_prepare_output(uuid,text,text,text,integer,text)',
  'private.docstudio_issue_media(text,jsonb,text)','private.docstudio_consume_media(text)','private.docstudio_verify_media(jsonb)','private.docstudio_stage_export(uuid,integer,uuid)',
  'private.docstudio_issue_cleanup(text)','private.docstudio_finish_cleanup(uuid)'] loop
  if to_regprocedure(signature) is null then raise exception 'Missing DocStudio operation' using errcode='55000';end if;
  if not has_function_privilege('hub_app_server',signature,'execute') or has_function_privilege('anon',signature,'execute') or has_function_privilege('authenticated',signature,'execute') or has_function_privilege('service_role',signature,'execute') then raise exception 'DocStudio operation permission boundary missing' using errcode='55000';end if;
 end loop;
 if not exists(select 1 from storage.buckets where id='hub-docstudio' and public=false) then raise exception 'Private DocStudio bucket required' using errcode='55000';end if;
 if not (contract->'features' @> '["knowledge.docstudio.v1"]'::jsonb) then contract:=jsonb_set(contract,'{features}',(contract->'features')||'["knowledge.docstudio.v1"]'::jsonb);end if;
 execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L','select '||quote_literal(contract::text)||'::jsonb');
end $$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon,authenticated;
