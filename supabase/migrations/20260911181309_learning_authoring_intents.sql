-- The Hub pins reviewed source evidence; CareBase remains the only native
-- version/publication writer. No learner, credit or certificate rows are copied.
create table private.learning_authoring_intents (
  command_id uuid primary key,
  actor_id uuid not null references hub.profiles(id),
  session_id uuid not null references private.sms_sessions(id),
  snapshot_id uuid not null references private.learning_source_snapshots(id),
  preview_digest text not null check(preview_digest ~ '^[0-9a-f]{64}$'),
  preview jsonb not null check(octet_length(preview::text)<=32000),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  result jsonb check(octet_length(result::text)<=8000),
  completed_at timestamptz,
  check((result is null)=(completed_at is null))
);
create index learning_authoring_intents_actor_idx on private.learning_authoring_intents(actor_id);
create index learning_authoring_intents_session_idx on private.learning_authoring_intents(session_id);
create index learning_authoring_intents_snapshot_idx on private.learning_authoring_intents(snapshot_id);
alter table private.learning_authoring_intents enable row level security;
revoke all on private.learning_authoring_intents from public,anon,authenticated;

create function hub.remember_learning_authoring_preview(p_snapshot_id uuid,p_preview jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor jsonb; source private.learning_source_snapshots%rowtype; prior private.learning_authoring_intents%rowtype;
  v_command_id uuid; expires timestamptz; head_id uuid;
begin
  actor:=hub.authorize_app_command();
  perform private.require_learning_editor();
  if p_preview is null or jsonb_typeof(p_preview)<>'object' or octet_length(p_preview::text)>32000
    or not(p_preview ?& array['commandId','courseId','action','reason','previewDigest','expiresAt','before','after'])
    or p_preview-array['commandId','courseId','action','reason','previewDigest','expiresAt','before','after']<>'{}'::jsonb
    or coalesce(p_preview->>'action','') not in ('learning.cloneVersion','learning.publishVersion')
    or coalesce(p_preview->>'previewDigest','') !~ '^[0-9a-f]{64}$'
    or jsonb_typeof(p_preview->'before')<>'object' or jsonb_typeof(p_preview->'after')<>'object'
    or coalesce(length(p_preview->>'reason'),0) not between 10 and 500 then
    raise exception 'Invalid course preview.' using errcode='22023';
  end if;
  begin v_command_id:=(p_preview->>'commandId')::uuid; expires:=(p_preview->>'expiresAt')::timestamptz;
  exception when others then raise exception 'Invalid course preview identity.' using errcode='22023'; end;
  if v_command_id is null or expires is null or not isfinite(expires) or expires>clock_timestamp()+interval '5 minutes 5 seconds' then
    raise exception 'Invalid course preview lifetime.' using errcode='22023';
  end if;
  select * into source from private.learning_source_snapshots where id=p_snapshot_id;
  if not found or (p_preview->>'courseId')::uuid is distinct from source.source_course_id
    or (p_preview->'before'->>'courseId')::uuid is distinct from source.source_course_id
    or (p_preview->'before'->>'versionId')::uuid is distinct from source.source_version_id
    or p_preview->'before'->>'sourceRevision' is distinct from source.source_revision then
    raise exception 'The preview does not match the reviewed source.' using errcode='40001';
  end if;
  -- Serialize against source staging. A first preview must pin the current head.
  perform 1 from hub.content_items where id=source.item_id for update;
  select id into head_id from private.learning_source_snapshots where source_course_id=source.source_course_id order by sequence desc limit 1;
  select * into prior from private.learning_authoring_intents where learning_authoring_intents.command_id=v_command_id;
  if found then
    if prior.actor_id is distinct from (actor->>'user_id')::uuid or prior.session_id is distinct from (actor->>'session_id')::uuid
      or prior.snapshot_id is distinct from p_snapshot_id or prior.preview is distinct from p_preview then
      raise exception 'This command belongs to a different preview.' using errcode='40001';
    end if;
    return prior.preview;
  end if;
  if head_id is distinct from p_snapshot_id or expires<=clock_timestamp() then
    raise exception 'The preview or reviewed source changed. Refresh it.' using errcode='40001';
  end if;
  insert into private.learning_authoring_intents(command_id,actor_id,session_id,snapshot_id,preview_digest,preview,expires_at)
    values(v_command_id,(actor->>'user_id')::uuid,(actor->>'session_id')::uuid,p_snapshot_id,p_preview->>'previewDigest',p_preview,expires);
  insert into private.audit_events(actor_id,action,entity_type,entity_id,metadata)
    values((actor->>'user_id')::uuid,'learning.authoring.preview','content_item',source.item_id,
      jsonb_build_object('command_id',v_command_id,'snapshot_id',source.id,'source_revision',source.source_revision));
  return p_preview;
end;
$$;

create function hub.get_learning_authoring_intent(p_command_id uuid,p_expected_digest text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor jsonb; intent private.learning_authoring_intents%rowtype;
begin
  actor:=hub.authorize_app_command();
  perform private.require_learning_editor();
  select * into intent from private.learning_authoring_intents where command_id=p_command_id;
  if not found or intent.actor_id is distinct from (actor->>'user_id')::uuid or intent.session_id is distinct from (actor->>'session_id')::uuid then
    raise exception 'This course preview is unavailable.' using errcode='42501';
  end if;
  if p_expected_digest is distinct from intent.preview_digest then
    raise exception 'The course preview changed.' using errcode='40001';
  end if;
  -- Immutable source snapshots cannot be overwritten. Native CAS checks the
  -- current source before the first write; native replay checks current authority.
  return jsonb_build_object('preview',intent.preview,'result',intent.result);
end;
$$;

create function hub.record_learning_authoring_result(p_command_id uuid,p_expected_digest text,p_result jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare intent private.learning_authoring_intents%rowtype; actor jsonb; source_item uuid;
begin
  actor:=hub.authorize_app_command();
  perform hub.get_learning_authoring_intent(p_command_id,p_expected_digest);
  select * into intent from private.learning_authoring_intents where command_id=p_command_id for update;
  if p_result is null or jsonb_typeof(p_result)<>'object' or octet_length(p_result::text)>8000
    or not(p_result ?& array['commandId','courseId','action','versionId','versionNumber','status','appliedAt','replayed'])
    or p_result-array['commandId','courseId','action','versionId','versionNumber','status','appliedAt','replayed']<>'{}'::jsonb
    or p_result->>'commandId' is distinct from intent.preview->>'commandId'
    or p_result->>'courseId' is distinct from intent.preview->>'courseId'
    or p_result->>'action' is distinct from intent.preview->>'action'
    or p_result->>'status' is distinct from intent.preview->'after'->>'status'
    or p_result->'versionNumber' is distinct from intent.preview->'after'->'versionNumber'
    or coalesce(p_result->>'versionId','') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    or jsonb_typeof(p_result->'replayed') is distinct from 'boolean'
    or (p_result->>'action'='learning.publishVersion' and p_result->>'versionId' is distinct from intent.preview->'before'->>'versionId') then
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
