-- Additive deployment gate for the central catalog commands. Declaring the feature changes no
-- behavior: unpublish and published-lesson corrections still go through the source-bound
-- preview ledger, which pins the preserved head, and every result is recorded under the
-- current administrator command session.
do $$ declare contract jsonb:=hub.get_backend_contract(); signature text; definition text; begin
  if (contract @> '{"api_version":4,"features":["platform.admin.command.v1","learning.authoring.v1","learning.credit-policy.v1"]}'::jsonb) is not true
    or to_regclass('private.learning_authoring_intents') is null or to_regclass('private.learning_source_snapshots') is null then
    raise exception 'Apply the reviewed authoring, source and credit policy foundation first' using errcode='55000';
  end if;
  foreach signature in array array['private.learning_authoring_actions()','hub.remember_learning_authoring_preview(uuid,jsonb)',
    'hub.get_learning_authoring_intent(uuid,text)','hub.record_learning_authoring_result(uuid,text,jsonb)'] loop
    if to_regprocedure(signature) is null then raise exception 'Missing reviewed catalog authoring function: %',signature using errcode='55000'; end if;
  end loop;
  if (private.learning_authoring_actions() @> array['learning.unpublishCourse','learning.correctPublishedBlock']::text[]) is not true then
    raise exception 'Apply the catalog authoring actions first' using errcode='55000';
  end if;
  definition:=pg_catalog.pg_get_functiondef('hub.remember_learning_authoring_preview(uuid,jsonb)'::regprocedure);
  if position('private.learning_authoring_actions()' in definition)=0 or position('source.source_revision' in definition)=0
    or position('head_id is distinct from p_snapshot_id' in definition)=0 then
    raise exception 'Catalog previews must stay bound to the preserved source head' using errcode='55000';
  end if;
  definition:=pg_catalog.pg_get_functiondef('hub.record_learning_authoring_result(uuid,text,jsonb)'::regprocedure);
  if position('''learning.correctPublishedBlock''' in definition)=0 or position('''learning.unpublishCourse''' in definition)=0
    or position('hub.authorize_app_command()' in definition)=0 or position('for update' in definition)=0 then
    raise exception 'Catalog results must carry their source digest under the current command session' using errcode='55000';
  end if;
  if not (contract->'features' @> '["learning.catalog-authoring.v1"]'::jsonb) then
    contract:=jsonb_set(contract,'{features}',(contract->'features')||'["learning.catalog-authoring.v1"]'::jsonb);
  end if;
  execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L','select '||quote_literal(contract::text)||'::jsonb');
end $$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon,authenticated;
