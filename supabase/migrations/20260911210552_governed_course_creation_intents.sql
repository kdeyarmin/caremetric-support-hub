-- CareBase owns the atomic course/version writer. Hub stores reviewed requests
-- and a private catalog identity; this never publishes or grants learning access.
create table private.course_creation_intents (
  request_id uuid primary key, actor_id uuid not null references hub.profiles(id),
  session_id uuid not null references private.sms_sessions(id), course_id uuid not null, version_id uuid not null,
  request jsonb not null check(octet_length(request::text)<=32768), created_at timestamptz not null default now(),
  command_id uuid unique, preview jsonb check(octet_length(preview::text)<=8192), preview_digest text,
  dispatched_at timestamptz, discarded_at timestamptz, result jsonb check(octet_length(result::text)<=8192),
  registration jsonb, check((preview is null)=(command_id is null)), check((preview is null)=(preview_digest is null)),
  check((result is null)=(registration is null)), check(discarded_at is null or dispatched_at is null)
);
create index course_creation_actor_idx on private.course_creation_intents(actor_id,created_at desc);
create index course_creation_session_idx on private.course_creation_intents(session_id);
create index course_creation_course_idx on private.course_creation_intents(course_id);
create index course_creation_version_idx on private.course_creation_intents(version_id);
alter table private.course_creation_intents enable row level security;
revoke all on private.course_creation_intents from public,anon,authenticated,service_role,hub_app_server;

create function private.course_creation_actor() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare actor jsonb;
begin
  if session_user<>'hub_app_server' then raise exception 'Application server required.' using errcode='42501'; end if;
  actor:=hub.authorize_app_command(); perform private.require_learning_editor(); return actor;
end; $$;
create function private.course_creation_view(p_intent private.course_creation_intents) returns jsonb
language sql stable set search_path='' as $$
  select jsonb_build_object('request',p_intent.request,'preview',p_intent.preview,'result',p_intent.result,
    'registration',p_intent.registration,'createdAt',p_intent.created_at,'dispatchedAt',p_intent.dispatched_at);
$$;
create function private.require_course_creation(p_request_id uuid) returns private.course_creation_intents
language plpgsql security definer set search_path='' as $$
declare actor jsonb; intent private.course_creation_intents%rowtype;
begin
  actor:=private.course_creation_actor();
  select * into intent from private.course_creation_intents where request_id=p_request_id for update;
  if not found or intent.actor_id is distinct from (actor->>'user_id')::uuid or intent.discarded_at is not null then
    raise exception 'Course creation request unavailable.' using errcode='42501'; end if;
  return intent;
end; $$;
create function private.get_course_creation(p_request_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
begin return private.course_creation_view(private.require_course_creation(p_request_id)); end; $$;
create function private.list_course_creations(p_offset integer) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor jsonb; rows jsonb; more boolean;
begin
  actor:=private.course_creation_actor();
  if p_offset is null or p_offset not between 0 and 10000 then raise exception 'Invalid saved request page.' using errcode='22023'; end if;
  select coalesce(jsonb_agg(i.value order by i.completed,i.created_at desc,i.request_id),'[]'::jsonb) into rows
    from (select private.course_creation_view(t) as value,t.result is not null as completed,t.created_at,t.request_id from private.course_creation_intents t
      where actor_id=(actor->>'user_id')::uuid and discarded_at is null order by (result is not null),created_at desc,request_id limit 20 offset p_offset) i;
  select exists(select 1 from private.course_creation_intents where actor_id=(actor->>'user_id')::uuid and discarded_at is null offset p_offset+20) into more;
  return jsonb_build_object('rows',rows,'nextOffset',case when more and p_offset+20<=10000 then p_offset+20 else null end);
end; $$;
create function private.reserve_course_creation(p_request jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor jsonb; intent private.course_creation_intents%rowtype; rid uuid; cid uuid; vid uuid;
begin
  actor:=private.course_creation_actor();
  if p_request is null or jsonb_typeof(p_request)<>'object' or octet_length(p_request::text)>32768
    or not(p_request ?& array['operation','requestId','action','courseId','parameters','reason'])
    or p_request-array['operation','requestId','action','courseId','parameters','reason']<>'{}'::jsonb
    or p_request->>'operation' is distinct from 'preview' or p_request->>'action' is distinct from 'learning.createCourse'
    or jsonb_typeof(p_request->'parameters') is distinct from 'object'
    or not(p_request->'parameters' ?& array['versionId','course','version'])
    or (p_request->'parameters')-array['versionId','course','version']<>'{}'::jsonb
    or jsonb_typeof(p_request->'parameters'->'course') is distinct from 'object'
    or jsonb_typeof(p_request->'parameters'->'version') is distinct from 'object'
    or jsonb_typeof(p_request->'reason') is distinct from 'string' or length(p_request->>'reason') not between 10 and 500 then
    raise exception 'Invalid course creation request.' using errcode='22023'; end if;
  rid:=(p_request->>'requestId')::uuid; cid:=(p_request->>'courseId')::uuid; vid:=(p_request->'parameters'->>'versionId')::uuid;
  if rid is null or cid is null or vid is null or cid=vid then raise exception 'Distinct course and version identities required.' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('hub-course-create-request:'||rid::text,0));
  select * into intent from private.course_creation_intents where request_id=rid for update;
  if found then
    if intent.request is distinct from p_request or intent.actor_id is distinct from (actor->>'user_id')::uuid
      or intent.session_id is distinct from (actor->>'session_id')::uuid or intent.discarded_at is not null then
      raise exception 'Original course creation request required.' using errcode='40001'; end if;
    return private.course_creation_view(intent);
  end if;
  perform pg_advisory_xact_lock(hashtextextended('hub-course-create:'||cid::text,0));
  if exists(select 1 from private.course_creation_intents where (course_id=cid or version_id=vid) and actor_id<>(actor->>'user_id')::uuid)
    or exists(select 1 from hub.course_links where lower(penntrain_course_id)=cid::text) then
    raise exception 'Course identity is already registered.' using errcode='40001'; end if;
  perform pg_advisory_xact_lock(hashtextextended('hub-course-create-actor:'||(actor->>'user_id'),0));
  if (select count(*) from private.course_creation_intents where actor_id=(actor->>'user_id')::uuid and created_at>now()-interval '15 minutes')>=20 then
    raise exception 'Too many new course reviews. Resume a saved request.' using errcode='42501'; end if;
  insert into private.course_creation_intents(request_id,actor_id,session_id,course_id,version_id,request)
    values(rid,(actor->>'user_id')::uuid,(actor->>'session_id')::uuid,cid,vid,p_request) returning * into intent;
  return private.course_creation_view(intent);
end; $$;
create function private.remember_course_creation(p_request_id uuid,p_preview jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare intent private.course_creation_intents%rowtype; actor jsonb; expiry timestamptz; cid uuid;
begin
  intent:=private.require_course_creation(p_request_id); actor:=private.course_creation_actor();
  if intent.session_id is distinct from (actor->>'session_id')::uuid then raise exception 'Original preview session required.' using errcode='42501'; end if;
  if p_preview is null or jsonb_typeof(p_preview)<>'object' or octet_length(p_preview::text)>8192
    or not(p_preview ?& array['commandId','courseId','action','reason','previewDigest','expiresAt','before','after'])
    or p_preview-array['commandId','courseId','action','reason','previewDigest','expiresAt','before','after']<>'{}'::jsonb
    or p_preview->>'action' is distinct from 'learning.createCourse' or (p_preview->>'courseId')::uuid is distinct from intent.course_id
    or p_preview->>'reason' is distinct from intent.request->>'reason'
    or coalesce(p_preview->>'previewDigest','') !~ '^[0-9a-f]{64}$'
    or p_preview->'before' is distinct from jsonb_build_object('courseId',intent.course_id,'versionId',intent.version_id,'exists',false)
    or p_preview->'after' is distinct from jsonb_build_object('courseId',intent.course_id,'versionId',intent.version_id,
      'courseStatus','draft','status','draft','versionNumber',1,'title',intent.request->'parameters'->'version'->>'title',
      'currentVersionId',null,'aiReviewRequired',false,'contentStandard','comprehensive') then
    raise exception 'Native course preview mismatch.' using errcode='22023'; end if;
  expiry:=(p_preview->>'expiresAt')::timestamptz;cid:=(p_preview->>'commandId')::uuid;
  if cid is null or expiry is null or not isfinite(expiry) or expiry>clock_timestamp()+interval '305 seconds' then
    raise exception 'Invalid creation preview lifetime.' using errcode='22023'; end if;
  if intent.preview is not null then
    if intent.preview is distinct from p_preview then raise exception 'Creation preview changed.' using errcode='40001'; end if;
    return private.course_creation_view(intent);
  end if;
  if expiry<=clock_timestamp() then raise exception 'Creation preview expired.' using errcode='40001'; end if;
  update private.course_creation_intents set preview=p_preview,command_id=cid,preview_digest=p_preview->>'previewDigest'
    where request_id=p_request_id returning * into intent;
  insert into private.audit_events(actor_id,action,entity_type,entity_id,metadata)
    values(intent.actor_id,'learning.creation.preview','native_course',intent.course_id,jsonb_build_object('request_id',p_request_id,'command_id',cid));
  return private.course_creation_view(intent);
end; $$;
create function private.dispatch_course_creation(p_command_id uuid,p_expected_digest text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare rid uuid; intent private.course_creation_intents%rowtype; actor jsonb;
begin
  actor:=private.course_creation_actor();
  select request_id into rid from private.course_creation_intents where command_id=p_command_id;
  intent:=private.require_course_creation(rid);
  if intent.session_id is distinct from (actor->>'session_id')::uuid then raise exception 'Recover this request in the new session.' using errcode='42501'; end if;
  if intent.preview_digest is distinct from p_expected_digest then raise exception 'Creation preview changed.' using errcode='40001'; end if;
  if intent.dispatched_at is null and (intent.preview->>'expiresAt')::timestamptz<=clock_timestamp() then
    raise exception 'Creation preview expired.' using errcode='40001'; end if;
  update private.course_creation_intents set dispatched_at=coalesce(dispatched_at,now()) where request_id=rid returning * into intent;
  return private.course_creation_view(intent);
end; $$;
create function private.register_course_creation(p_request_id uuid,p_result jsonb,p_payload text,p_source_revision text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare intent private.course_creation_intents%rowtype; item uuid; doc jsonb; snapshot jsonb; v_registration jsonb; applied timestamptz;
begin
  intent:=private.require_course_creation(p_request_id);
  if intent.preview is null or p_result is null or jsonb_typeof(p_result)<>'object' or octet_length(p_result::text)>8192
    or not(p_result ?& array['commandId','courseId','action','versionId','versionNumber','status','appliedAt','replayed','courseStatus','currentVersionId','contentStandard','sourceRevision'])
    or p_result-array['commandId','courseId','action','versionId','versionNumber','status','appliedAt','replayed','courseStatus','currentVersionId','contentStandard','sourceRevision']<>'{}'::jsonb
    or (p_result->>'commandId')::uuid is distinct from intent.command_id or (p_result->>'courseId')::uuid is distinct from intent.course_id
    or (p_result->>'versionId')::uuid is distinct from intent.version_id or p_result->>'action' is distinct from 'learning.createCourse'
    or p_result->'versionNumber' is distinct from '1'::jsonb or p_result->>'status' is distinct from 'draft'
    or p_result->>'courseStatus' is distinct from 'draft' or p_result->'currentVersionId' is distinct from 'null'::jsonb
    or p_result->>'contentStandard' is distinct from 'comprehensive' or jsonb_typeof(p_result->'replayed') is distinct from 'boolean'
    or coalesce(p_result->>'sourceRevision','') !~ '^[0-9a-f]{64}$' then
    raise exception 'Native creation receipt mismatch.' using errcode='22023'; end if;
  applied:=(p_result->>'appliedAt')::timestamptz;
  if applied is null or not isfinite(applied) then raise exception 'Invalid creation receipt time.' using errcode='22023'; end if;
  if intent.result is not null then
    if intent.result-'replayed' is distinct from p_result-'replayed' then raise exception 'Native creation receipt changed.' using errcode='40001'; end if;
    return private.course_creation_view(intent);
  end if;
  doc:=private.validate_governed_learning_source(p_payload,p_source_revision);
  if (doc->>'sourceCourseId')::uuid is distinct from intent.course_id or (doc->>'sourceVersionId')::uuid is distinct from intent.version_id then
    raise exception 'Native creation source identity changed.' using errcode='40001'; end if;
  perform pg_advisory_xact_lock(hashtextextended('hub-course-create:'||intent.course_id::text,0));
  item:=md5('penntrain-course-item:'||intent.course_id::text)::uuid;
  if exists(select 1 from hub.course_links where lower(penntrain_course_id)=intent.course_id::text)
    or exists(select 1 from hub.content_items where id=item or content_key='carebase-course.'||intent.course_id::text) then
    raise exception 'Review the existing catalog mapping; it cannot be overwritten.' using errcode='40001'; end if;
  insert into hub.content_items(id,content_key,kind,status,access_level,source_system,owner_product_id,owner_team,created_by)
    values(item,'carebase-course.'||intent.course_id::text,'course','draft','staff','penntrain',
      (select id from hub.products where slug='carebase'),'CareMetric Learning',intent.actor_id);
  insert into hub.course_links(content_item_id,penntrain_course_id,source_version,launch_path,duration_minutes)
    values(item,intent.course_id::text,intent.version_id::text,'/app/courses/'||intent.course_id::text,
      (intent.request->'parameters'->'course'->>'estimatedDurationMinutes')::integer);
  if p_source_revision=p_result->>'sourceRevision' then
    -- Only the exact new draft is preserved automatically. Current edits need a
    -- separate review through the existing source-preservation interface.
    if doc->>'publicationState'<>'draft' or doc->>'sourceVersionState'<>'draft' or doc->'sourceVersionNumber'<>'1'::jsonb
      or doc->'blocks'<>'[]'::jsonb or doc->'credits'<>'[]'::jsonb or doc->'packages'<>'[]'::jsonb or doc->'provider'<>'null'::jsonb
      or doc->'version'->>'contentStandard'<>'comprehensive' then
      raise exception 'Unexpected initial course material.' using errcode='40001'; end if;
    snapshot:=hub.stage_learning_source(p_payload,p_source_revision,null);
  end if;
  v_registration:=jsonb_build_object('itemId',item,'snapshotId',snapshot->'snapshotId','sourceRevision',snapshot->'sourceRevision');
  update private.course_creation_intents set result=p_result,registration=v_registration where request_id=p_request_id returning * into intent;
  insert into private.audit_events(actor_id,action,entity_type,entity_id,metadata)
    values(intent.actor_id,'learning.creation.registered','content_item',item,
      jsonb_build_object('request_id',p_request_id,'command_id',intent.command_id,'course_id',intent.course_id,'version_id',intent.version_id,'initial_snapshot',snapshot is not null));
  return private.course_creation_view(intent);
end; $$;
create function private.discard_course_creation(p_request_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare intent private.course_creation_intents%rowtype;
begin
  intent:=private.require_course_creation(p_request_id);
  if intent.dispatched_at is not null or intent.result is not null then raise exception 'Recover a dispatched creation request.' using errcode='40001'; end if;
  update private.course_creation_intents set discarded_at=now() where request_id=p_request_id;
  return jsonb_build_object('discarded',true);
end; $$;
revoke all on function private.course_creation_actor(),private.course_creation_view(private.course_creation_intents),private.require_course_creation(uuid),
  private.get_course_creation(uuid),private.list_course_creations(integer),private.reserve_course_creation(jsonb),private.remember_course_creation(uuid,jsonb),
  private.dispatch_course_creation(uuid,text),private.register_course_creation(uuid,jsonb,text,text),private.discard_course_creation(uuid)
  from public,anon,authenticated,service_role,hub_app_server;
grant execute on function private.get_course_creation(uuid),private.list_course_creations(integer),private.reserve_course_creation(jsonb),private.remember_course_creation(uuid,jsonb),
  private.dispatch_course_creation(uuid,text),private.register_course_creation(uuid,jsonb,text,text),private.discard_course_creation(uuid) to hub_app_server;
