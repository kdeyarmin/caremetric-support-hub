-- CareBase remains the course/learner authority. These records govern only
-- reviewed catalog metadata, product placements and observed availability.
create table private.learning_distribution_observations (
  course_id uuid primary key, item_id uuid not null unique references hub.content_items(id),
  managed boolean not null default false, observation_id uuid not null default gen_random_uuid(),
  attempted_at timestamptz, observed_at timestamptz, observer_verified_at timestamptz,
  native_generated_at timestamptz, publication_state text, current_version_id uuid, current_version_state text, source_revision text,
  observer_source_revision text, observer_version_id uuid, distributed_revision_id uuid references hub.content_revisions(id),
  lease_id uuid, lease_until timestamptz,
  check(publication_state is null or publication_state in ('draft','published','archived','missing')),
  check(current_version_state is null or current_version_state in ('draft','published','archived')),
  check(source_revision is null or source_revision ~ '^[0-9a-f]{64}$'),check(observer_source_revision is null or observer_source_revision ~ '^[0-9a-f]{64}$'),
  check(not managed or distributed_revision_id is not null),
  check((lease_id is null)=(lease_until is null)),check((current_version_id is null)=(current_version_state is null))
);
create index learning_distribution_observation_revision_idx on private.learning_distribution_observations(distributed_revision_id);
create table private.learning_distribution_intents (
  request_id uuid primary key, actor_id uuid not null references hub.profiles(id), session_id uuid not null references private.sms_sessions(id),
  course_id uuid not null, item_id uuid not null references hub.content_items(id), plan jsonb not null,
  source_payload text not null check(octet_length(source_payload)<=2000000), source_revision text not null check(source_revision ~ '^[0-9a-f]{64}$'),
  preview_digest text not null check(preview_digest ~ '^[0-9a-f]{64}$'), preview jsonb not null,
  created_at timestamptz not null default now(), expires_at timestamptz not null default now()+interval '5 minutes',
  result jsonb, check(expires_at>created_at),check(octet_length(plan::text)<=32768),check(octet_length(preview::text)<=65536)
);
create index learning_distribution_actor_idx on private.learning_distribution_intents(actor_id,session_id,created_at desc);
create index learning_distribution_course_idx on private.learning_distribution_intents(course_id);
create index learning_distribution_item_idx on private.learning_distribution_intents(item_id);
create index learning_distribution_session_idx on private.learning_distribution_intents(session_id);
create table private.learning_distribution_revisions (
  revision_id uuid primary key references hub.content_revisions(id), item_id uuid not null references hub.content_items(id),
  request_id uuid not null unique references private.learning_distribution_intents(request_id),
  course_id uuid not null, version_id uuid not null, source_revision text not null check(source_revision ~ '^[0-9a-f]{64}$'),
  before_catalog jsonb not null, plan jsonb not null,
  actor_id uuid not null references hub.profiles(id), session_id uuid not null references private.sms_sessions(id), published_at timestamptz not null default now()
);
create index learning_distribution_revision_item_idx on private.learning_distribution_revisions(item_id);
create index learning_distribution_revision_actor_idx on private.learning_distribution_revisions(actor_id);
create index learning_distribution_revision_session_idx on private.learning_distribution_revisions(session_id);
alter table private.learning_distribution_observations enable row level security;
alter table private.learning_distribution_intents enable row level security;
alter table private.learning_distribution_revisions enable row level security;
revoke all on private.learning_distribution_observations,private.learning_distribution_intents,private.learning_distribution_revisions from public,anon,authenticated,service_role,hub_app_server;

create function private.current_distribution_actor() returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_actor jsonb;
begin
  v_actor:=private.course_creation_actor();
  -- Existing shared authorization uses transaction time. A queued publication
  -- must also honor wall-clock session and original eight-hour assurance expiry.
  if (v_actor->>'assurance_expires_at')::timestamptz is null
    or (v_actor->>'assurance_expires_at')::timestamptz<=clock_timestamp()
    or not exists(select 1 from private.sms_sessions s where s.id=(v_actor->>'session_id')::uuid and s.user_id=(v_actor->>'user_id')::uuid
      and s.revoked_at is null and s.expires_at>clock_timestamp() and s.created_at+interval '480 minutes'>clock_timestamp()) then
    raise exception 'Current distribution session expired.' using errcode='28000';end if;
  return v_actor;
end; $$;

create function private.distribution_catalog_state(p_course_id uuid) returns jsonb
language sql stable security definer set search_path='' as $$
  select jsonb_build_object('item',to_jsonb(i),'link',to_jsonb(l),
    'revisions',coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'revisionNumber',r.revision_no,'rowHash',encode(extensions.digest(to_jsonb(r)::text,'sha256'),'hex')) order by r.revision_no,r.id) from hub.content_revisions r where r.item_id=i.id),'[]'::jsonb),
    'publications',coalesce((select jsonb_agg(to_jsonb(p) order by p.product_id,p.id) from hub.content_publications p where p.item_id=i.id),'[]'::jsonb))
  from hub.content_items i join hub.course_links l on l.content_item_id=i.id
  where lower(l.penntrain_course_id)=p_course_id::text and i.kind='course' and i.source_system='penntrain';
$$;
create function private.distribution_catalog_digest(p_course_id uuid) returns text
language sql stable security definer set search_path='' as $$
  select encode(extensions.digest(private.distribution_catalog_state(p_course_id)::text,'sha256'),'hex');
$$;
create function private.course_distribution_available(p_item_id uuid,p_revision_id uuid) returns boolean
language sql stable security definer set search_path='' as $$
  -- Opt-in only: untouched legacy catalog entries retain their existing policy.
  select not exists(select 1 from private.learning_distribution_observations where item_id=p_item_id and managed)
    or exists(select 1 from private.learning_distribution_observations o join private.learning_distribution_revisions r on r.item_id=o.item_id
      where o.item_id=p_item_id and r.revision_id=p_revision_id and o.distributed_revision_id=p_revision_id and o.managed and o.observed_at>now()-interval '15 minutes'
        and o.publication_state='published' and o.current_version_state='published'
        and o.current_version_id=r.version_id and o.source_revision=r.source_revision);
$$;
create function private.claim_course_distribution_observation(p_course_id uuid) returns uuid
language plpgsql security definer set search_path='' as $$
declare v_actor jsonb; v_item uuid; v_observation uuid:=gen_random_uuid();
begin
  v_actor:=private.current_distribution_actor();
  select i.id into v_item from hub.content_items i join hub.course_links l on l.content_item_id=i.id
    where lower(l.penntrain_course_id)=p_course_id::text and i.kind='course' and i.source_system='penntrain';
  if v_item is null then raise exception 'Registered CareBase course required.' using errcode='22023'; end if;
  insert into private.learning_distribution_observations(course_id,item_id,observation_id,attempted_at)
    values(p_course_id,v_item,v_observation,clock_timestamp()) on conflict(course_id) do update
    set observation_id=excluded.observation_id,attempted_at=excluded.attempted_at,lease_id=null,lease_until=null;
  return v_observation;
end; $$;
create function private.validate_distribution_status(p_status jsonb) returns void
language plpgsql immutable set search_path='' as $$
declare v_state text; v_version uuid; v_version_state text; v_hash text;
begin
  if p_status is null or jsonb_typeof(p_status)<>'object' or not(p_status ?& array['courseId','publicationState','currentVersionId','currentVersionState','sourceRevision'])
    or p_status-array['courseId','publicationState','currentVersionId','currentVersionState','sourceRevision']<>'{}'::jsonb
    or jsonb_typeof(p_status->'courseId')<>'string' or jsonb_typeof(p_status->'publicationState')<>'string'
    or jsonb_typeof(p_status->'currentVersionId') not in ('string','null') or jsonb_typeof(p_status->'currentVersionState') not in ('string','null')
    or jsonb_typeof(p_status->'sourceRevision') not in ('string','null')
    or (p_status->>'courseId')::uuid is null then raise exception 'Invalid source observation.' using errcode='22023'; end if;
  v_state:=p_status->>'publicationState';v_version:=(p_status->>'currentVersionId')::uuid;v_version_state:=p_status->>'currentVersionState';v_hash:=p_status->>'sourceRevision';
  if v_state is null or v_state not in ('draft','published','archived','missing') or (v_version is null)<>(v_version_state is null)
    or (v_version_state is not null and v_version_state not in ('draft','published','archived'))
    or (v_state='missing' and v_version is not null)
    or (v_hash is not null and v_hash !~ '^[0-9a-f]{64}$')
    or (v_hash is not null)<>(v_state='published' and v_version is not null and v_version_state='published') then
    raise exception 'Inconsistent source observation.' using errcode='22023'; end if;
end; $$;
create function private.record_course_distribution_observation(p_course_id uuid,p_observation_id uuid,p_generated_at timestamptz,p_status jsonb,p_machine boolean) returns void
language plpgsql security definer set search_path='' as $$
declare v_actor jsonb; v_row private.learning_distribution_observations%rowtype;
begin
  v_actor:=private.current_distribution_actor();perform private.validate_distribution_status(p_status);
  if (p_status->>'courseId')::uuid is distinct from p_course_id or p_machine is null or p_generated_at is null or not isfinite(p_generated_at)
    or p_generated_at<clock_timestamp()-interval '2 minutes' or p_generated_at>clock_timestamp()+interval '30 seconds' then
    raise exception 'Invalid current source observation.' using errcode='22023'; end if;
  select * into v_row from private.learning_distribution_observations where course_id=p_course_id for update;
  perform private.current_distribution_actor();
  if v_row.course_id is null or v_row.observation_id<>p_observation_id then raise exception 'Source observation was superseded.' using errcode='40001'; end if;
  update private.learning_distribution_observations set observed_at=clock_timestamp(),native_generated_at=p_generated_at,
    observer_verified_at=case when p_machine then clock_timestamp() else observer_verified_at end,
    observer_source_revision=case when p_machine then p_status->>'sourceRevision' else observer_source_revision end,
    observer_version_id=case when p_machine then (p_status->>'currentVersionId')::uuid else observer_version_id end,
    publication_state=p_status->>'publicationState',current_version_id=(p_status->>'currentVersionId')::uuid,current_version_state=p_status->>'currentVersionState',source_revision=p_status->>'sourceRevision'
    where course_id=p_course_id;
end; $$;
create function private.distribution_intent_view(p_intent private.learning_distribution_intents) returns jsonb
language sql stable set search_path='' as $$
  select p_intent.preview||jsonb_build_object('result',p_intent.result,'canCommitThisSession',
    p_intent.result is null and p_intent.expires_at>clock_timestamp() and p_intent.session_id=(private.current_distribution_actor()->>'session_id')::uuid);
$$;
create function private.distribution_availability(p_course_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare v_row private.learning_distribution_observations%rowtype; v_state text;
begin
  select * into v_row from private.learning_distribution_observations where course_id=p_course_id;
  v_state:=case when not found or not v_row.managed then 'legacy'
    when v_row.observed_at is null then 'unverified'
    when v_row.observed_at<=now()-interval '15 minutes' then 'stale'
    when v_row.publication_state='missing' then 'missing'
    when v_row.publication_state<>'published' or v_row.current_version_state is distinct from 'published' then 'unpublished'
    when exists(select 1 from private.learning_distribution_revisions r join hub.content_publications p on p.revision_id=r.revision_id
      where r.item_id=v_row.item_id and r.revision_id=v_row.distributed_revision_id and r.version_id=v_row.current_version_id and r.source_revision=v_row.source_revision
        and p.published_at<=now() and (p.expires_at is null or p.expires_at>now())) then 'published' else 'changed' end;
  return jsonb_build_object('managed',coalesce(v_row.managed,false),'state',v_state,'observedAt',v_row.observed_at,
    'validUntil',case when v_row.observed_at is null then null else v_row.observed_at+interval '15 minutes' end);
end; $$;
create function private.get_course_distribution_context(p_course_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare v_actor jsonb; v_item hub.content_items%rowtype; v_revision hub.content_revisions%rowtype; v_products jsonb; v_ids jsonb; v_requests jsonb; v_legacy boolean;
begin
  v_actor:=private.current_distribution_actor();
  select i.* into v_item from hub.content_items i join hub.course_links l on l.content_item_id=i.id
    where lower(l.penntrain_course_id)=p_course_id::text and i.kind='course' and i.source_system='penntrain';
  if not found then raise exception 'Registered CareBase course required.' using errcode='22023'; end if;
  select * into v_revision from hub.content_revisions where item_id=v_item.id order by revision_no desc,id desc limit 1;
  select coalesce(jsonb_agg(product_id order by product_id),'[]'::jsonb) into v_ids from hub.content_publications where item_id=v_item.id
    and (expires_at is null or expires_at>now());
  select coalesce(jsonb_agg(jsonb_build_object('id',id,'slug',slug,'name',name,'eligible',status<>'retired' and support_enabled and private.has_staff_permission('content.write',id)) order by name),'[]'::jsonb)
    into v_products from hub.products where slug in ('carebase','pennsync','breathe','caremetric-emr','caremetric-go','caremetric-intel');
  select coalesce(jsonb_agg(private.distribution_intent_view(t) order by t.created_at desc,t.request_id),'[]'::jsonb) into v_requests
    from (select * from private.learning_distribution_intents where course_id=p_course_id and actor_id=(v_actor->>'user_id')::uuid
      order by created_at desc,request_id limit 20) t;
  v_legacy:=not exists(select 1 from private.course_creation_intents where registration->>'itemId'=v_item.id::text and result is not null);
  return jsonb_build_object('catalog',jsonb_build_object('itemId',v_item.id,'status',v_item.status,'accessLevel',v_item.access_level,
    'catalogDigest',private.distribution_catalog_digest(p_course_id),'metadata',case when v_revision.id is null then null else jsonb_build_object('title',v_revision.title,'summary',v_revision.summary,
      'category',nullif(btrim(v_revision.variables->>'category'),''),'durationMinutes',(select duration_minutes from hub.course_links where content_item_id=v_item.id)) end,
    'productIds',v_ids,'legacy',v_legacy,'availability',private.distribution_availability(p_course_id)),
    'products',v_products,'requests',v_requests);
end; $$;
create function private.require_course_distribution_intent(p_request_id uuid) returns private.learning_distribution_intents
language plpgsql security definer set search_path='' as $$
declare v_actor jsonb; v_intent private.learning_distribution_intents%rowtype;
begin
  v_actor:=private.current_distribution_actor();select * into v_intent from private.learning_distribution_intents where request_id=p_request_id for update;
  perform private.current_distribution_actor();
  if v_intent.request_id is null or v_intent.actor_id is distinct from (v_actor->>'user_id')::uuid then
    raise exception 'Distribution owner required.' using errcode='42501'; end if;
  return v_intent;
end; $$;
create function private.get_course_distribution_intent(p_request_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
begin return private.distribution_intent_view(private.require_course_distribution_intent(p_request_id)); end; $$;
create function private.claim_distribution_status_batch() returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_lease uuid:=gen_random_uuid(); v_rows jsonb;
begin
  if session_user<>'hub_app_server' then raise exception 'Application observer required.' using errcode='42501'; end if;
  with selected as (select course_id from private.learning_distribution_observations where managed
    and (attempted_at is null or attempted_at<now()-interval '5 minutes') and (lease_until is null or lease_until<now())
    order by attempted_at nulls first,course_id for update skip locked limit 10),
  claimed as (update private.learning_distribution_observations o set observation_id=gen_random_uuid(),lease_id=v_lease,
    lease_until=clock_timestamp()+interval '90 seconds',attempted_at=clock_timestamp() from selected s where o.course_id=s.course_id returning o.course_id)
  select coalesce(jsonb_agg(course_id order by course_id),'[]'::jsonb) into v_rows from claimed;
  return jsonb_build_object('leaseId',v_lease,'courseIds',v_rows);
end; $$;
create function private.record_distribution_status_batch(p_lease_id uuid,p_generated_at timestamptz,p_items jsonb) returns integer
language plpgsql security definer set search_path='' as $$
declare v_status jsonb; v_count integer:=0; v_requested integer;
begin
  if session_user<>'hub_app_server' then raise exception 'Application observer required.' using errcode='42501'; end if;
  if p_generated_at is null or not isfinite(p_generated_at) or p_generated_at<clock_timestamp()-interval '2 minutes' or p_generated_at>clock_timestamp()+interval '30 seconds'
    or p_items is null or jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items) not between 1 and 10
    or (select count(distinct (value->>'courseId')::uuid) from jsonb_array_elements(p_items))<>jsonb_array_length(p_items) then
    raise exception 'Invalid observer batch.' using errcode='22023'; end if;
  -- Lock the whole exact lease before changing any member; superseded batches
  -- cannot partially overwrite a more recent human or worker observation.
  perform 1 from private.learning_distribution_observations where lease_id=p_lease_id order by course_id for update;
  select count(*) into v_requested from private.learning_distribution_observations where lease_id=p_lease_id and lease_until>clock_timestamp();
  if v_requested<>jsonb_array_length(p_items) or exists(select 1 from jsonb_array_elements(p_items) j where not exists(
    select 1 from private.learning_distribution_observations o where o.lease_id=p_lease_id and o.course_id=(j.value->>'courseId')::uuid)) then
    raise exception 'Observer batch was superseded.' using errcode='40001'; end if;
  for v_status in select value from jsonb_array_elements(p_items) loop
    perform private.validate_distribution_status(v_status);
    update private.learning_distribution_observations set observed_at=clock_timestamp(),observer_verified_at=clock_timestamp(),native_generated_at=p_generated_at,
      observer_source_revision=v_status->>'sourceRevision',observer_version_id=(v_status->>'currentVersionId')::uuid,
      publication_state=v_status->>'publicationState',current_version_id=(v_status->>'currentVersionId')::uuid,current_version_state=v_status->>'currentVersionState',source_revision=v_status->>'sourceRevision',lease_id=null,lease_until=null
      where course_id=(v_status->>'courseId')::uuid and lease_id=p_lease_id;
    v_count:=v_count+1;
  end loop;
  return v_count;
end; $$;

create function private.validate_course_distribution_plan(p_plan jsonb,p_item_id uuid,p_allow_legacy boolean) returns void
language plpgsql stable security definer set search_path='' as $$
declare v_metadata jsonb; v_id uuid; v_selected uuid[]; v_removed uuid[]; v_actual_removed uuid[]; v_key text; v_text text;
begin
  perform private.current_distribution_actor();
  if p_plan is null or jsonb_typeof(p_plan)<>'object' or octet_length(p_plan::text)>32768
    or not(p_plan ?& array['courseId','versionId','sourceRevision','expectedCatalogDigest','metadata','productIds','removedProductIds','accessLevel','reason','reviewed','confirmReplacement','confirmRetirements'])
    or p_plan-array['courseId','versionId','sourceRevision','expectedCatalogDigest','metadata','productIds','removedProductIds','accessLevel','reason','reviewed','confirmReplacement','confirmRetirements']<>'{}'::jsonb
    or p_plan->'reviewed' is distinct from 'true'::jsonb or jsonb_typeof(p_plan->'confirmReplacement')<>'boolean' or jsonb_typeof(p_plan->'confirmRetirements')<>'boolean'
    or jsonb_typeof(p_plan->'sourceRevision')<>'string' or jsonb_typeof(p_plan->'expectedCatalogDigest')<>'string'
    or coalesce(p_plan->>'sourceRevision','') !~ '^[0-9a-f]{64}$' or coalesce(p_plan->>'expectedCatalogDigest','') !~ '^[0-9a-f]{64}$'
    or p_plan->>'accessLevel' not in ('public','customer','staff') or jsonb_typeof(p_plan->'accessLevel')<>'string'
    or jsonb_typeof(p_plan->'reason')<>'string' or length(p_plan->>'reason') not between 10 and 500
    or p_plan->>'reason'<>btrim(p_plan->>'reason') or p_plan->>'reason' ~ '[[:cntrl:]]'
    or jsonb_typeof(p_plan->'courseId')<>'string' or jsonb_typeof(p_plan->'versionId')<>'string'
    or coalesce(p_plan->>'courseId','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or coalesce(p_plan->>'versionId','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or jsonb_typeof(p_plan->'productIds')<>'array' or jsonb_typeof(p_plan->'removedProductIds')<>'array' then
    raise exception 'Invalid reviewed distribution plan.' using errcode='22023'; end if;
  if jsonb_array_length(p_plan->'productIds') not between 1 and 6 or jsonb_array_length(p_plan->'removedProductIds')>6
    or exists(select 1 from jsonb_array_elements((p_plan->'productIds')||(p_plan->'removedProductIds')) j
      where jsonb_typeof(j.value)<>'string' or j.value#>>'{}' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
    raise exception 'Invalid product selection.' using errcode='22023'; end if;
  select array_agg(value::uuid order by value::uuid) into v_selected from jsonb_array_elements_text(p_plan->'productIds');
  select coalesce(array_agg(value::uuid order by value::uuid),array[]::uuid[]) into v_removed from jsonb_array_elements_text(p_plan->'removedProductIds');
  if cardinality(v_selected)<>(select count(distinct x) from unnest(v_selected) x)
    or cardinality(v_removed)<>(select count(distinct x) from unnest(v_removed) x) or v_selected&&v_removed
    or (cardinality(v_removed)>0 and p_plan->'confirmRetirements'<>'true'::jsonb) then
    raise exception 'Explicit distinct placement changes required.' using errcode='22023'; end if;
  v_metadata:=p_plan->'metadata';
  if jsonb_typeof(v_metadata)<>'object' or not(v_metadata ?& array['title','summary','category','durationMinutes'])
    or v_metadata-array['title','summary','category','durationMinutes']<>'{}'::jsonb then
    raise exception 'Invalid catalog metadata.' using errcode='22023'; end if;
  foreach v_key in array array['title','summary','category'] loop
    v_text:=v_metadata->>v_key;
    if (v_key<>'category' or v_text is not null) and (jsonb_typeof(v_metadata->v_key)<>'string' or v_text<>btrim(v_text) or v_text ~ '[[:cntrl:]]'
      or length(v_text)>case v_key when 'title' then 180 when 'summary' then 500 else 200 end
      or length(v_text)<case v_key when 'title' then 2 when 'summary' then 0 else 1 end) then
      raise exception 'Invalid display text.' using errcode='22023'; end if;
  end loop;
  if v_metadata->'durationMinutes'<>'null'::jsonb and (jsonb_typeof(v_metadata->'durationMinutes')<>'number'
    or v_metadata->>'durationMinutes' !~ '^[0-9]+$' or (v_metadata->>'durationMinutes')::numeric>2147483647) then
    raise exception 'Invalid display duration.' using errcode='22023'; end if;
  if not exists(select 1 from hub.course_links l join hub.content_items i on i.id=l.content_item_id where i.id=p_item_id
    and lower(l.penntrain_course_id)=p_plan->>'courseId' and i.kind='course' and i.source_system='penntrain') then
    raise exception 'Registered source identity changed.' using errcode='40001'; end if;
  if not coalesce(p_allow_legacy,false) and not exists(select 1 from private.course_creation_intents where registration->>'itemId'=p_item_id::text and result is not null)
    and not exists(select 1 from private.learning_distribution_observations where item_id=p_item_id and managed) then
    raise exception 'Legacy distribution rollout is not enabled.' using errcode='42501'; end if;
  foreach v_id in array v_selected loop
    if not exists(select 1 from hub.products where id=v_id and slug in ('carebase','pennsync','breathe','caremetric-emr','caremetric-go','caremetric-intel')
      and status<>'retired' and support_enabled and private.has_staff_permission('content.write',id)) then
      raise exception 'Current product publication permission required.' using errcode='42501'; end if;
  end loop;
  -- Scheduled placements also need explicit retirement; a future publication must
  -- not silently survive the reviewed selection.
  select coalesce(array_agg(product_id order by product_id),array[]::uuid[]) into v_actual_removed from hub.content_publications
    where item_id=p_item_id and (expires_at is null or expires_at>now()) and not(product_id=any(v_selected));
  if v_removed is distinct from v_actual_removed then raise exception 'Review every removed placement.' using errcode='40001'; end if;
  foreach v_id in array v_removed loop
    if not private.has_staff_permission('content.write',v_id) then raise exception 'Current retirement permission required.' using errcode='42501'; end if;
  end loop;
  if exists(select 1 from hub.content_publications where item_id=p_item_id and (expires_at is null or expires_at>now()))
    and p_plan->'confirmReplacement'<>'true'::jsonb then raise exception 'Confirm replacement of published placements.' using errcode='22023'; end if;
end; $$;
create function private.preview_course_distribution(p_request_id uuid,p_plan jsonb,p_payload text,p_observation_id uuid,p_allow_legacy boolean) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_actor jsonb; v_item uuid; v_intent private.learning_distribution_intents%rowtype; v_doc jsonb;
  v_observation private.learning_distribution_observations%rowtype; v_digest text; v_created timestamptz:=clock_timestamp(); v_preview jsonb;
begin
  v_actor:=private.current_distribution_actor();
  if p_request_id is null then raise exception 'Request identity required.' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('hub-distribution-request:'||p_request_id::text,0));
  select * into v_intent from private.learning_distribution_intents where request_id=p_request_id for update;
  if found then
    if v_intent.actor_id is distinct from (v_actor->>'user_id')::uuid or v_intent.session_id is distinct from (v_actor->>'session_id')::uuid
      or v_intent.plan is distinct from p_plan or v_intent.source_payload is distinct from p_payload then
      raise exception 'Original distribution request required.' using errcode='40001'; end if;
    return private.distribution_intent_view(v_intent);
  end if;
  select i.id into v_item from hub.content_items i join hub.course_links l on l.content_item_id=i.id
    where lower(l.penntrain_course_id)=p_plan->>'courseId' and i.kind='course' and i.source_system='penntrain' for update of i;
  if v_item is null then raise exception 'Registered course required.' using errcode='22023'; end if;
  perform private.validate_course_distribution_plan(p_plan,v_item,p_allow_legacy);
  if private.distribution_catalog_digest((p_plan->>'courseId')::uuid) is distinct from p_plan->>'expectedCatalogDigest' then
    raise exception 'Catalog changed after review.' using errcode='40001'; end if;
  v_doc:=private.validate_governed_learning_source(p_payload,p_plan->>'sourceRevision');
  if v_doc->>'sourceCourseId' is distinct from p_plan->>'courseId' or v_doc->>'sourceVersionId' is distinct from p_plan->>'versionId'
    or v_doc->>'publicationState'<>'published' or v_doc->>'sourceVersionState'<>'published' then
    raise exception 'Current published source required.' using errcode='40001'; end if;
  select * into v_observation from private.learning_distribution_observations where course_id=(p_plan->>'courseId')::uuid for update;
  if not found or v_observation.observation_id is distinct from p_observation_id or v_observation.observed_at<clock_timestamp()-interval '2 minutes'
    or v_observation.source_revision is distinct from p_plan->>'sourceRevision' or v_observation.current_version_id is distinct from (p_plan->>'versionId')::uuid
    or v_observation.publication_state is distinct from 'published' or v_observation.current_version_state is distinct from 'published' then
    raise exception 'Published observation changed.' using errcode='40001'; end if;
  perform pg_advisory_xact_lock(hashtextextended('hub-distribution-actor:'||(v_actor->>'user_id'),0));
  if (select count(*) from private.learning_distribution_intents where actor_id=(v_actor->>'user_id')::uuid and created_at>now()-interval '15 minutes')>=20 then
    raise exception 'Resume a saved distribution review.' using errcode='42501'; end if;
  v_digest:=encode(extensions.digest(jsonb_build_object('requestId',p_request_id,'actor',v_actor->>'user_id','session',v_actor->>'session_id','plan',p_plan)::text,'sha256'),'hex');
  v_preview:=jsonb_build_object('requestId',p_request_id,'plan',p_plan,'previewDigest',v_digest,'createdAt',v_created,'expiresAt',v_created+interval '5 minutes',
    'replacesPublished',exists(select 1 from hub.content_publications where item_id=v_item and (expires_at is null or expires_at>now())),'result',null);
  perform private.current_distribution_actor();
  insert into private.learning_distribution_intents(request_id,actor_id,session_id,course_id,item_id,plan,source_payload,source_revision,preview_digest,preview,created_at,expires_at)
    values(p_request_id,(v_actor->>'user_id')::uuid,(v_actor->>'session_id')::uuid,(p_plan->>'courseId')::uuid,v_item,p_plan,p_payload,p_plan->>'sourceRevision',v_digest,v_preview,v_created,v_created+interval '5 minutes') returning * into v_intent;
  insert into private.audit_events(actor_id,action,entity_type,entity_id,metadata) values(v_intent.actor_id,'learning.distribution.preview','content_item',v_item,
    jsonb_build_object('request_id',p_request_id,'source_revision',v_intent.source_revision));
  return private.distribution_intent_view(v_intent);
end; $$;
create function private.commit_course_distribution(p_request_id uuid,p_expected_digest text,p_observation_id uuid,p_allow_legacy boolean) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_intent private.learning_distribution_intents%rowtype; v_observation private.learning_distribution_observations%rowtype;
  v_plan jsonb; v_before jsonb; v_revision uuid:=gen_random_uuid(); v_number integer; v_now timestamptz; v_result jsonb;
begin
  v_intent:=private.require_course_distribution_intent(p_request_id);v_plan:=v_intent.plan;
  if v_intent.session_id is distinct from (hub.authorize_app_command()->>'session_id')::uuid then
    raise exception 'Original distribution session required.' using errcode='42501';end if;
  if v_intent.preview_digest is distinct from p_expected_digest then raise exception 'Review digest changed.' using errcode='40001'; end if;
  -- A recovered receipt is evidence of the original commit, never a new approval.
  if v_intent.result is not null then return private.distribution_intent_view(v_intent); end if;
  if v_intent.expires_at<=clock_timestamp() then raise exception 'Distribution preview expired.' using errcode='40001'; end if;
  perform 1 from hub.content_items where id=v_intent.item_id for update;
  perform private.validate_course_distribution_plan(v_plan,v_intent.item_id,p_allow_legacy);
  if private.distribution_catalog_digest(v_intent.course_id) is distinct from v_plan->>'expectedCatalogDigest' then
    raise exception 'Catalog changed after review.' using errcode='40001'; end if;
  select * into v_observation from private.learning_distribution_observations where course_id=v_intent.course_id for update;
  if not found or v_observation.observation_id is distinct from p_observation_id or v_observation.observed_at is null
    or v_observation.observed_at<clock_timestamp()-interval '2 minutes' or v_observation.observer_verified_at is null
    or v_observation.observer_verified_at<clock_timestamp()-interval '2 minutes'
    or v_observation.source_revision is distinct from v_intent.source_revision or v_observation.observer_source_revision is distinct from v_intent.source_revision
    or v_observation.current_version_id is distinct from (v_plan->>'versionId')::uuid or v_observation.observer_version_id is distinct from (v_plan->>'versionId')::uuid
    or v_observation.publication_state is distinct from 'published' or v_observation.current_version_state is distinct from 'published' then
    raise exception 'A current matching observer and published source are required.' using errcode='40001'; end if;
  -- Locks may have waited past expiry. Recheck current actor/product scope after
  -- those waits, then record actual publication time immediately before writing.
  perform private.current_distribution_actor();perform private.validate_course_distribution_plan(v_plan,v_intent.item_id,p_allow_legacy);
  if v_intent.expires_at<=clock_timestamp() then raise exception 'Distribution preview expired.' using errcode='40001';end if;
  v_now:=clock_timestamp();
  v_before:=private.distribution_catalog_state(v_intent.course_id);
  select coalesce(max(revision_no),0)+1 into v_number from hub.content_revisions where item_id=v_intent.item_id;
  insert into hub.content_revisions(id,item_id,revision_no,title,summary,body_text,variables,source_hash,source_version,review_state,created_by,approved_by,approved_at)
    values(v_revision,v_intent.item_id,v_number,v_plan->'metadata'->>'title',v_plan->'metadata'->>'summary',
      'Course material and completion are maintained in CareBase.',jsonb_build_object('category',v_plan->'metadata'->'category','distribution_source','carebase'),
      v_intent.source_revision,v_plan->>'versionId','approved',v_intent.actor_id,v_intent.actor_id,v_now);
  insert into private.learning_distribution_revisions(revision_id,item_id,request_id,course_id,version_id,source_revision,before_catalog,plan,actor_id,session_id,published_at)
    values(v_revision,v_intent.item_id,p_request_id,v_intent.course_id,(v_plan->>'versionId')::uuid,v_intent.source_revision,v_before,v_plan,v_intent.actor_id,v_intent.session_id,v_now);
  update hub.content_items set status='published',access_level=(v_plan->>'accessLevel')::hub.access_level,retired_at=null,updated_at=v_now where id=v_intent.item_id;
  update hub.course_links set source_version=v_plan->>'versionId',duration_minutes=(v_plan->'metadata'->>'durationMinutes')::integer,source_updated_at=v_observation.native_generated_at,updated_at=v_now where content_item_id=v_intent.item_id;
  -- The immutable provenance retains the original rows, and the availability
  -- policy immediately excludes every previous revision, including schedules.
  update hub.content_publications set expires_at=greatest(v_now,published_at+interval '1 microsecond')
    where item_id=v_intent.item_id and product_id in(select value::uuid from jsonb_array_elements_text(v_plan->'removedProductIds'));
  insert into hub.content_publications(item_id,revision_id,product_id,audience,route_pattern,app_version_min,app_version_max,published_at,expires_at,published_by)
    select v_intent.item_id,v_revision,value::uuid,array['all']::text[],null,null,null,v_now,null,v_intent.actor_id from jsonb_array_elements_text(v_plan->'productIds')
    on conflict(item_id,product_id) do update set revision_id=excluded.revision_id,audience=excluded.audience,route_pattern=null,app_version_min=null,app_version_max=null,published_at=excluded.published_at,expires_at=null,published_by=excluded.published_by;
  update private.learning_distribution_observations set managed=true,distributed_revision_id=v_revision where course_id=v_intent.course_id;
  v_result:=jsonb_build_object('requestId',p_request_id,'itemId',v_intent.item_id,'revisionId',v_revision,'revisionNumber',v_number,'courseId',v_intent.course_id,
    'versionId',(v_plan->>'versionId')::uuid,'sourceRevision',v_intent.source_revision,'productIds',v_plan->'productIds','accessLevel',v_plan->>'accessLevel','publishedAt',v_now);
  update private.learning_distribution_intents set result=v_result where request_id=p_request_id returning * into v_intent;
  insert into private.audit_events(actor_id,action,entity_type,entity_id,metadata) values(v_intent.actor_id,'learning.distribution.committed','content_item',v_intent.item_id,
    jsonb_build_object('request_id',p_request_id,'revision_id',v_revision,'source_revision',v_intent.source_revision,'product_ids',v_plan->'productIds'));
  return private.distribution_intent_view(v_intent);
end; $$;
create function private.protect_course_distribution() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if tg_table_schema='private' and tg_table_name='learning_distribution_intents' then
    if tg_op='UPDATE' and row(new.request_id,new.actor_id,new.session_id,new.course_id,new.item_id,new.plan,new.source_payload,new.source_revision,new.preview_digest,new.preview,new.created_at,new.expires_at) is not distinct from row(old.request_id,old.actor_id,old.session_id,old.course_id,old.item_id,old.plan,old.source_payload,old.source_revision,old.preview_digest,old.preview,old.created_at,old.expires_at) and old.result is null and new.result is not null then return new; end if;
    raise exception 'Distribution request and receipt are immutable.' using errcode='42501';
  end if;
  if tg_table_schema='private' then raise exception 'Distribution provenance is immutable.' using errcode='42501'; end if;
  if exists(select 1 from private.learning_distribution_revisions where revision_id=old.id)
    or exists(select 1 from private.learning_distribution_observations where item_id=old.item_id and managed) then
    raise exception 'Distributed revision is immutable.' using errcode='42501'; end if;
  if tg_op='DELETE' then return old; end if; return new;
end; $$;
create trigger learning_distribution_intent_immutable before update or delete on private.learning_distribution_intents for each row execute function private.protect_course_distribution();
create trigger learning_distribution_provenance_immutable before update or delete on private.learning_distribution_revisions for each row execute function private.protect_course_distribution();
create trigger learning_distribution_revision_immutable before update or delete on hub.content_revisions for each row execute function private.protect_course_distribution();

create or replace function private.can_access_content_publication(
  p_item_id uuid,
  p_revision_id uuid,
  p_product_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from hub.content_publications publication
    join hub.content_items item
      on item.id = publication.item_id
    join hub.content_revisions revision
      on revision.id = publication.revision_id
     and revision.item_id = publication.item_id
    join hub.products publication_product
      on publication_product.id = publication.product_id
    where publication.item_id = p_item_id
      and publication.revision_id = p_revision_id
      and publication.product_id = p_product_id
      and (item.kind<>'course' or item.source_system<>'penntrain' or private.course_distribution_available(item.id,revision.id))
      and (revision.product_overlay_id is null or revision.product_overlay_id = publication.product_id)
      and (
        private.has_staff_permission('content.read', publication.product_id)
        or private.has_staff_permission('content.write', publication.product_id)
        or (
          item.status = 'published'
          and revision.review_state = 'approved'
          and publication_product.status <> 'retired'
          and publication_product.support_enabled
          and publication.published_at <= now()
          and (publication.expires_at is null or publication.expires_at > now())
          and (
            (
              item.access_level = 'public'
              and 'all' = any(coalesce(publication.audience, array[]::text[]))
            )
            or (
              item.access_level = 'customer'
              and private.has_active_content_audience(publication.product_id, publication.audience)
            )
          )
        )
      )
  );
$$;


create function private.release_distribution_status_batch(p_lease_id uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
  if session_user<>'hub_app_server' then raise exception 'Application observer required.' using errcode='42501'; end if;
  -- attempted_at remains the retry backoff. Failures never invent fresh evidence.
  update private.learning_distribution_observations set lease_id=null,lease_until=null where lease_id=p_lease_id;
end; $$;
revoke all on function private.current_distribution_actor(),private.distribution_catalog_state(uuid),private.distribution_catalog_digest(uuid),private.course_distribution_available(uuid,uuid),
  private.claim_course_distribution_observation(uuid),private.validate_distribution_status(jsonb),private.record_course_distribution_observation(uuid,uuid,timestamptz,jsonb,boolean),
  private.distribution_intent_view(private.learning_distribution_intents),private.distribution_availability(uuid),private.get_course_distribution_context(uuid),
  private.require_course_distribution_intent(uuid),private.get_course_distribution_intent(uuid),private.claim_distribution_status_batch(),private.record_distribution_status_batch(uuid,timestamptz,jsonb),
  private.release_distribution_status_batch(uuid),private.validate_course_distribution_plan(jsonb,uuid,boolean),private.preview_course_distribution(uuid,jsonb,text,uuid,boolean),
  private.commit_course_distribution(uuid,text,uuid,boolean),private.protect_course_distribution()
  from public,anon,authenticated,service_role,hub_app_server;
grant execute on function private.claim_course_distribution_observation(uuid),private.record_course_distribution_observation(uuid,uuid,timestamptz,jsonb,boolean),
  private.get_course_distribution_context(uuid),private.get_course_distribution_intent(uuid),private.preview_course_distribution(uuid,jsonb,text,uuid,boolean),
  private.commit_course_distribution(uuid,text,uuid,boolean),private.claim_distribution_status_batch(),private.record_distribution_status_batch(uuid,timestamptz,jsonb),
  private.release_distribution_status_batch(uuid) to hub_app_server;
