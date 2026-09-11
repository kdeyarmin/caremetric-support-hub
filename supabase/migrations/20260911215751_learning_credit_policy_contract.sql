-- Declaration proves the reviewed Hub boundary, not native provider readiness.
do $$
declare signature text; definition text;
begin
  if (hub.get_backend_contract() @> '{"api_version":4,"features":["learning.runtime.v1","platform.admin.read.v1","app.sms.v1","learning.sources.v1","platform.admin.command.v1","learning.receipts.v1","learning.authoring.v1","knowledge.publications.v1","support.readiness.v1","platform.admin.intel.v1","learning.draft-editing.v1","billing.portal.v1","support.customer-onboarding.v1","learning.structure.v1","support.customer-registration.v1","billing.checkout.v1","learning.course-creation.v1"]}'::jsonb) is not true
    or to_regclass('private.learning_authoring_intents') is null or to_regclass('private.learning_source_snapshots') is null then
    raise exception 'Apply the reviewed creation, source and checkout foundation before credit policy' using errcode='55000';
  end if;
  foreach signature in array array['private.learning_authoring_actions()','private.require_learning_editor()',
    'hub.authorize_app_command()','hub.remember_learning_authoring_preview(uuid,jsonb)',
    'hub.get_learning_authoring_intent(uuid,text)','hub.record_learning_authoring_result(uuid,text,jsonb)',
    'private.validate_governed_learning_source(text,text)'] loop
    if to_regprocedure(signature) is null then raise exception 'Missing reviewed credit policy function: %',signature using errcode='55000'; end if;
  end loop;
  if private.learning_authoring_actions() is distinct from array['learning.cloneVersion','learning.publishVersion','learning.patchDraft','learning.reviewDraft','learning.editStructure','learning.editCreditPolicy']::text[] then
    raise exception 'Apply the closed credit policy action contract first' using errcode='55000';
  end if;
  definition:=pg_catalog.pg_get_functiondef('hub.remember_learning_authoring_preview(uuid,jsonb)'::regprocedure);
  if position('private.learning_authoring_actions()' in definition)=0 or position('private.require_learning_editor()' in definition)=0
    or position('prior.session_id' in definition)=0 or position('source.source_revision' in definition)=0 then
    raise exception 'Apply the source-bound credit policy preview guard first' using errcode='55000';
  end if;
  definition:=pg_catalog.pg_get_functiondef('hub.record_learning_authoring_result(uuid,text,jsonb)'::regprocedure);
  if position('''learning.editCreditPolicy''' in definition)=0 or position('''sourceRevision''' in definition)=0
    or position('hub.get_learning_authoring_intent(p_command_id,p_expected_digest)' in definition)=0
    or position('hub.authorize_app_command()' in definition)=0 or position('for update' in definition)=0 then
    raise exception 'Apply the credit policy result digest and current-authority guard first' using errcode='55000';
  end if;
end;
$$;
do $declaration$
declare contract jsonb:=hub.get_backend_contract(); features jsonb;
begin
  features:=contract->'features';
  if jsonb_typeof(features) is distinct from 'array' or jsonb_array_length(features)>99
    or exists(select 1 from jsonb_array_elements(features) value where jsonb_typeof(value)<>'string')
    or (select count(*)<>count(distinct value) from jsonb_array_elements(features) value) then
    raise exception 'Invalid prior credit policy feature declaration' using errcode='55000';
  end if;
  if not(features ? 'learning.credit-policy.v1') then features:=features||'["learning.credit-policy.v1"]'::jsonb; end if;
  contract:=jsonb_build_object('api_version',4,'features',features);
  execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L',
    format('select %L::jsonb',contract::text));
end;
$declaration$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon,authenticated;
