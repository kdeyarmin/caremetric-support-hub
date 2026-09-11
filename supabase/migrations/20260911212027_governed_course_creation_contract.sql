-- Add only after the private creation coordinator and governed source reader exist.
do $migration$
declare contract jsonb; features jsonb; signature text;
begin
  if to_regprocedure('hub.get_backend_contract()') is null then raise exception 'Apply the Hub foundation first' using errcode='55000'; end if;
  contract:=hub.get_backend_contract();features:=contract->'features';
  if (contract @> '{"api_version":4,"features":["learning.runtime.v1","platform.admin.read.v1","app.sms.v1","learning.sources.v1","platform.admin.command.v1","learning.receipts.v1","learning.authoring.v1","knowledge.publications.v1","support.readiness.v1","platform.admin.intel.v1","learning.draft-editing.v1","billing.portal.v1","support.customer-onboarding.v1","learning.structure.v1"]}'::jsonb) is not true
    or to_regclass('private.course_creation_intents') is null then raise exception 'Apply reviewed course creation and existing Hub features first' using errcode='55000'; end if;
  foreach signature in array array['private.course_creation_actor()','private.get_course_creation(uuid)','private.list_course_creations(integer)',
    'private.reserve_course_creation(jsonb)','private.remember_course_creation(uuid,jsonb)','private.dispatch_course_creation(uuid,text)',
    'private.register_course_creation(uuid,jsonb,text,text)','private.discard_course_creation(uuid)','hub.stage_learning_source(text,text,text)'] loop
    if to_regprocedure(signature) is null then raise exception 'Missing reviewed course creation function %',signature using errcode='55000'; end if;
  end loop;
  if has_table_privilege('authenticated','private.course_creation_intents','SELECT') or has_table_privilege('hub_app_server','private.course_creation_intents','INSERT')
    or has_function_privilege('authenticated','private.register_course_creation(uuid,jsonb,text,text)','EXECUTE')
    or not has_function_privilege('hub_app_server','private.register_course_creation(uuid,jsonb,text,text)','EXECUTE')
    or position('session_user' in pg_get_functiondef('private.course_creation_actor()'::regprocedure))=0
    or position('learning.createCourse' in pg_get_functiondef('private.remember_course_creation(uuid,jsonb)'::regprocedure))=0 then
    raise exception 'Apply private course creation authority boundaries first' using errcode='55000'; end if;
  if jsonb_typeof(features) is distinct from 'array' or jsonb_array_length(features)>99
    or exists(select 1 from jsonb_array_elements(features) f where jsonb_typeof(f)<>'string')
    or (select count(*) from jsonb_array_elements(features))<>(select count(distinct value) from jsonb_array_elements(features)) then
    raise exception 'Invalid course creation feature union' using errcode='55000'; end if;
  if not(features @> '["learning.course-creation.v1"]'::jsonb) then features:=features||'["learning.course-creation.v1"]'::jsonb; end if;
  contract:=jsonb_set(contract,'{features}',features);
  execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L',
    'select '||quote_literal(contract::text)||'::jsonb');
end; $migration$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon,authenticated;
