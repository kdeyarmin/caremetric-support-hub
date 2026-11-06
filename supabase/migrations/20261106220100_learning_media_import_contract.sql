-- Additive deployment gate for bulk lesson-media import. Declaring the feature changes no learner
-- behavior: it states that staged imports are closed to every browser and service role, that only the
-- dedicated Hub server can enter the import functions (each rechecking the verified SMS session and
-- shared-course editor authority), and that approval and attachment reuse register_learning_media and
-- save_learning_draft. Every test fails closed.
do $$
declare
  contract jsonb := hub.get_backend_contract();
  feature constant text := 'learning.media-import.v1';
  signature text;
  role_name text;
begin
  if (contract @> '{"api_version":4,"features":["learning.runtime.v1","learning.media.v1","app.sms.v1"]}'::jsonb) is not true then
    raise exception 'Apply the central learning runtime, media and app SMS sessions first' using errcode = '55000';
  end if;
  if not coalesce((select relrowsecurity from pg_class where oid = to_regclass('private.learning_media_imports')), false) then
    raise exception 'Staged media imports must exist with row level security' using errcode = '55000';
  end if;
  foreach role_name in array array['anon', 'authenticated', 'service_role', 'hub_app_server'] loop
    if has_table_privilege(role_name, 'private.learning_media_imports', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
      or has_any_column_privilege(role_name, 'private.learning_media_imports', 'SELECT,INSERT,UPDATE,REFERENCES') then
      raise exception 'Staged media imports must remain closed to every browser, service and server role' using errcode = '55000';
    end if;
  end loop;
  foreach signature in array array['private.learning_media_import_begin(jsonb,text,integer,text,integer,text)',
    'private.learning_media_import_prepare(text,uuid,text,bigint)', 'private.learning_media_import_finish(text,uuid)',
    'private.learning_media_import_fail(text,uuid,text)', 'private.learning_media_import_list()',
    'private.learning_media_import_register(uuid,boolean)', 'private.learning_media_import_attach(uuid)'] loop
    if to_regprocedure(signature) is null
      or not coalesce((select p.prosecdef and coalesce(p.proconfig @> array['search_path=""'], false) from pg_proc p where p.oid = to_regprocedure(signature)), false)
      or has_function_privilege('anon', signature, 'EXECUTE') or has_function_privilege('authenticated', signature, 'EXECUTE')
      or has_function_privilege('service_role', signature, 'EXECUTE')
      or not has_function_privilege('hub_app_server', signature, 'EXECUTE')
      or position('private.learning_media_import_actor()' in pg_get_functiondef(to_regprocedure(signature))) = 0 then
      raise exception 'Media import server boundary invalid: %', signature using errcode = '55000';
    end if;
  end loop;
  if position('private.require_hub_app_server()' in pg_get_functiondef('private.learning_media_import_actor()'::regprocedure)) = 0
    or position('private.current_app_session_verified()' in pg_get_functiondef('private.learning_media_import_actor()'::regprocedure)) = 0
    or position('private.require_learning_editor()' in pg_get_functiondef('private.learning_media_import_actor()'::regprocedure)) = 0 then
    raise exception 'Media import must require the Hub server, a verified SMS session and editor authority' using errcode = '55000';
  end if;
  if position('hub.register_learning_media(' in pg_get_functiondef('private.learning_media_import_register(uuid,boolean)'::regprocedure)) = 0
    or position('hub.save_learning_draft(' in pg_get_functiondef('private.learning_media_import_attach_item(private.learning_media_imports,uuid)'::regprocedure)) = 0 then
    raise exception 'Media import must approve and attach through the existing learning functions' using errcode = '55000';
  end if;
  foreach signature in array array['private.learning_media_import_uuid(text)', 'private.learning_media_import_actor()',
    'private.learning_media_import_target(private.learning_media_imports)', 'private.learning_media_import_view(private.learning_media_imports)',
    'private.learning_media_import_attach_item(private.learning_media_imports,uuid)'] loop
    foreach role_name in array array['anon', 'authenticated', 'service_role', 'hub_app_server'] loop
      if has_function_privilege(role_name, signature, 'EXECUTE') then
        raise exception 'Media import helper must stay internal: %', signature using errcode = '55000';
      end if;
    end loop;
  end loop;
  -- Parity with learningSourceId('lesson', ...) in src/imports/pennsyncCourseImport.ts.
  if private.learning_media_import_uuid('caremetric.pennsync.learning.v2:lesson:65f1a2b3c4d5e6f708192a3b')
    <> 'f185124e-304d-8d4a-8a4e-2607fe5877ed'::uuid then
    raise exception 'PennSync lesson identity does not match the conversion' using errcode = '55000';
  end if;

  if not (contract -> 'features' @> jsonb_build_array(feature)) then
    contract := jsonb_set(contract, '{features}', (contract -> 'features') || jsonb_build_array(feature));
  end if;
  execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L',
    'select ' || quote_literal(contract::text) || '::jsonb');
end $$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon, authenticated;
