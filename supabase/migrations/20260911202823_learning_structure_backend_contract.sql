-- The structure editor needs atomic native intents and readable incomplete drafts.
do $$
declare signature text;
begin
  if (hub.get_backend_contract() @> '{"api_version":4,"features":["learning.runtime.v1","platform.admin.read.v1","app.sms.v1","learning.sources.v1","platform.admin.command.v1","learning.receipts.v1","learning.authoring.v1","knowledge.publications.v1","support.readiness.v1","platform.admin.intel.v1","learning.draft-editing.v1","billing.portal.v1"]}'::jsonb) is not true then
    raise exception 'Apply the complete portal and editing foundation before structure declaration' using errcode='55000';
  end if;
  foreach signature in array array['private.learning_authoring_actions()', 'hub.remember_learning_authoring_preview(uuid,jsonb)',
    'hub.get_learning_authoring_intent(uuid,text)', 'hub.record_learning_authoring_result(uuid,text,jsonb)',
    'private.validate_governed_learning_source(text,text)'] loop
    if to_regprocedure(signature) is null then
      raise exception 'Missing reviewed structure boundary: %', signature using errcode='55000';
    end if;
  end loop;
  if private.learning_authoring_actions() is distinct from array['learning.cloneVersion','learning.publishVersion','learning.patchDraft','learning.reviewDraft','learning.editStructure']::text[]
    or position('private.learning_authoring_actions()' in pg_catalog.pg_get_functiondef('hub.remember_learning_authoring_preview(uuid,jsonb)'::regprocedure))=0
    or position('''learning.editStructure''' in pg_catalog.pg_get_functiondef('hub.record_learning_authoring_result(uuid,text,jsonb)'::regprocedure))=0
    or position('''sourceVersionState''' in pg_catalog.pg_get_functiondef('private.validate_governed_learning_source(text,text)'::regprocedure))=0 then
    raise exception 'Apply the closed structure intentions and incomplete draft reader first' using errcode='55000';
  end if;
end;
$$;
create or replace function hub.get_backend_contract() returns jsonb
language sql stable security invoker set search_path='' as $$
  select jsonb_build_object('api_version',4,'features',jsonb_build_array(
    'learning.runtime.v1','platform.admin.read.v1','app.sms.v1','learning.sources.v1',
    'platform.admin.command.v1','learning.receipts.v1','learning.authoring.v1',
    'knowledge.publications.v1','support.readiness.v1','platform.admin.intel.v1',
    'learning.draft-editing.v1','billing.portal.v1','learning.structure.v1'));
$$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon,authenticated;
