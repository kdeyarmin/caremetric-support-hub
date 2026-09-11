-- Extend the existing source-bound native authoring ledger to training credit policy.
-- Course credit writes remain native; this change only validates reviewed outcomes.
create or replace function private.learning_authoring_actions() returns text[]
language sql immutable security invoker set search_path='' as $$
  select array['learning.cloneVersion','learning.publishVersion','learning.patchDraft','learning.reviewDraft','learning.editStructure','learning.editCreditPolicy']::text[];
$$;
revoke all on function private.learning_authoring_actions() from public,anon,authenticated,hub_app_server;

create or replace function hub.record_learning_authoring_result(p_command_id uuid,p_expected_digest text,p_result jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare intent private.learning_authoring_intents%rowtype; actor jsonb; source_item uuid;
begin
  actor:=hub.authorize_app_command();
  perform hub.get_learning_authoring_intent(p_command_id,p_expected_digest);
  select * into intent from private.learning_authoring_intents where command_id=p_command_id for update;
  if p_result is null or jsonb_typeof(p_result)<>'object' or octet_length(p_result::text)>8000
    or not(p_result ?& array['commandId','courseId','action','versionId','versionNumber','status','appliedAt','replayed'])
    or p_result-array['commandId','courseId','action','versionId','versionNumber','status','appliedAt','replayed','sourceRevision']<>'{}'::jsonb
    or ((p_result->>'action' in ('learning.patchDraft','learning.reviewDraft','learning.editStructure','learning.editCreditPolicy')) is distinct from (p_result ? 'sourceRevision'))
    or (p_result ? 'sourceRevision' and coalesce(p_result->>'sourceRevision','') !~ '^[0-9a-f]{64}$')
    or p_result->>'commandId' is distinct from intent.preview->>'commandId'
    or p_result->>'courseId' is distinct from intent.preview->>'courseId'
    or p_result->>'action' is distinct from intent.preview->>'action'
    or p_result->>'status' is distinct from intent.preview->'after'->>'status'
    or p_result->'versionNumber' is distinct from intent.preview->'after'->'versionNumber'
    or coalesce(p_result->>'versionId','') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    or jsonb_typeof(p_result->'replayed') is distinct from 'boolean'
    or (p_result->>'action'<>'learning.cloneVersion' and p_result->>'versionId' is distinct from intent.preview->'before'->>'versionId')
    or (p_result->>'action'='learning.cloneVersion' and p_result->>'versionId' is not distinct from intent.preview->'before'->>'versionId') then
    raise exception 'The native outcome does not match the preview.' using errcode='22023';
  end if;
  if intent.result is not null then
    if intent.result-'replayed' is distinct from p_result-'replayed' then
      raise exception 'The native result changed.' using errcode='40001';
    end if;
    return intent.result||jsonb_build_object('replayed',true);
  end if;
  update private.learning_authoring_intents set result=p_result,completed_at=now() where command_id=p_command_id;
  select item_id into source_item from private.learning_source_snapshots where id=intent.snapshot_id;
  insert into private.audit_events(actor_id,action,entity_type,entity_id,metadata)
    values((actor->>'user_id')::uuid,'learning.authoring.applied','content_item',source_item,
      jsonb_build_object('command_id',p_command_id,'action',p_result->>'action','version_id',p_result->>'versionId'));
  return p_result;
end;
$$;
revoke all on function hub.remember_learning_authoring_preview(uuid,jsonb),hub.get_learning_authoring_intent(uuid,text),hub.record_learning_authoring_result(uuid,text,jsonb) from public,anon,authenticated;
grant execute on function hub.remember_learning_authoring_preview(uuid,jsonb),hub.get_learning_authoring_intent(uuid,text),hub.record_learning_authoring_result(uuid,text,jsonb) to authenticated;
