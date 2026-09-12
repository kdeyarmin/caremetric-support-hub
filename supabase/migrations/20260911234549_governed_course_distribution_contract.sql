-- Hub catalog distribution only. Native runtime and observer configuration are
-- independently checked at use; schema presence never declares them connected.
do $$
declare v_contract jsonb:=hub.get_backend_contract();v_table text;v_signature text;v_definition text;
begin
  if v_contract is null or not(v_contract @> '{"api_version":4,"features":["app.sms.v1","learning.sources.v1","learning.course-creation.v1"]}'::jsonb) then
    raise exception 'Reviewed course and session foundation required.' using errcode='55000';end if;
  if jsonb_array_length(v_contract->'features')>100 or exists(select 1 from jsonb_array_elements(v_contract->'features') j where jsonb_typeof(j.value)<>'string')
    or (select count(*)<>count(distinct value) from jsonb_array_elements(v_contract->'features')) then raise exception 'Invalid prior feature declaration.' using errcode='55000';end if;
  foreach v_table in array array['learning_distribution_observations','learning_distribution_intents','learning_distribution_revisions'] loop
    if to_regclass('private.'||v_table) is null then raise exception 'Distribution state missing.' using errcode='55000';end if;
    if not exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='private' and c.relname=v_table and c.relrowsecurity)
      or has_table_privilege('anon','private.'||v_table,'select,insert,update,delete') or has_table_privilege('authenticated','private.'||v_table,'select,insert,update,delete')
      or has_table_privilege('service_role','private.'||v_table,'select,insert,update,delete') or has_table_privilege('hub_app_server','private.'||v_table,'select,insert,update,delete') then
      raise exception 'Distribution private state boundary missing.' using errcode='55000';end if;
  end loop;
  foreach v_signature in array array['private.get_course_distribution_context(uuid)','private.get_course_distribution_intent(uuid)',
    'private.claim_course_distribution_observation(uuid)','private.record_course_distribution_observation(uuid,uuid,timestamptz,jsonb,boolean)',
    'private.preview_course_distribution(uuid,jsonb,text,uuid,boolean)','private.commit_course_distribution(uuid,text,uuid,boolean)',
    'private.claim_distribution_status_batch()','private.record_distribution_status_batch(uuid,timestamptz,jsonb)','private.release_distribution_status_batch(uuid)'] loop
    if to_regprocedure(v_signature) is null then raise exception 'Distribution operation missing.' using errcode='55000';end if;
    if not has_function_privilege('hub_app_server',v_signature,'execute') or has_function_privilege('anon',v_signature,'execute')
      or has_function_privilege('authenticated',v_signature,'execute') or has_function_privilege('service_role',v_signature,'execute') then
      raise exception 'Distribution function boundary missing.' using errcode='55000';end if;
  end loop;
  if to_regprocedure('private.course_distribution_available(uuid,uuid)') is null or to_regprocedure('private.validate_course_distribution_plan(jsonb,uuid,boolean)') is null
    or to_regprocedure('private.protect_course_distribution()') is null then raise exception 'Distribution policy missing.' using errcode='55000';end if;
  select pg_get_functiondef('private.commit_course_distribution(uuid,text,uuid,boolean)'::regprocedure) into v_definition;
  if position('require_course_distribution_intent' in v_definition)=0 or position('observer_verified_at' in v_definition)=0
    or position('distribution_catalog_digest' in v_definition)=0 or position('observation_id' in v_definition)=0
    or position('validate_course_distribution_plan' in v_definition)=0 or position('learning_distribution_revisions' in v_definition)=0 then
    raise exception 'Distribution commit guards missing.' using errcode='55000';end if;
  if position('course_distribution_available' in pg_get_functiondef('private.can_access_content_publication(uuid,uuid,uuid)'::regprocedure))=0
    or position('15 minutes' in pg_get_functiondef('private.course_distribution_available(uuid,uuid)'::regprocedure))=0
    or position('distributed_revision_id' in pg_get_functiondef('private.course_distribution_available(uuid,uuid)'::regprocedure))=0 then
    raise exception 'Distribution availability policy missing.' using errcode='55000';end if;
  if (select count(*) from pg_trigger where tgname in ('learning_distribution_intent_immutable','learning_distribution_provenance_immutable','learning_distribution_revision_immutable')
    and tgenabled in ('O','A') and tgfoid='private.protect_course_distribution()'::regprocedure)<>3 then
    raise exception 'Distribution immutability guards missing.' using errcode='55000';end if;
  if not(v_contract->'features' @> '["learning.distribution.v1"]'::jsonb) then
    v_contract:=jsonb_set(v_contract,'{features}',(v_contract->'features')||'["learning.distribution.v1"]'::jsonb);end if;
  execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L','select '||quote_literal(v_contract::text)||'::jsonb');
end $$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon,authenticated;
