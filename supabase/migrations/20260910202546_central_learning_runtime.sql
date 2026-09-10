-- The Hub owns new course revisions, delivery, grading, and completion records.
-- Legacy course_links remain provenance; no source learning history is deleted.
create table private.learning_courses (
  item_id uuid primary key references hub.content_items(id),
  draft jsonb not null,
  draft_version integer not null default 1,
  published_version_id uuid,
  updated_by uuid references auth.users(id),
  updated_at timestamptz not null default now()
);
create table private.learning_versions (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references private.learning_courses(item_id),
  revision_id uuid not null references hub.content_revisions(id),
  document jsonb not null,
  published_by uuid references auth.users(id),
  published_at timestamptz not null default now(),
  unique (item_id, id)
);
alter table private.learning_courses add constraint learning_published_version_fk
  foreign key (item_id, published_version_id) references private.learning_versions(item_id, id);
create table private.learning_enrollments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  version_id uuid not null references private.learning_versions(id),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  certificate_id uuid unique,
  certificate_name text,
  unique (user_id, version_id),
  check ((completed_at is null) = (certificate_id is null)),
  check ((completed_at is null) = (certificate_name is null))
);
create table private.learning_unit_progress (
  enrollment_id uuid not null references private.learning_enrollments(id),
  unit_id uuid not null,
  completed_at timestamptz,
  attempt_count integer not null default 0,
  best_score integer check (best_score between 0 and 100),
  primary key (enrollment_id, unit_id)
);
create table private.learning_submissions (
  enrollment_id uuid not null references private.learning_enrollments(id),
  request_key uuid not null,
  request_hash text not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key (enrollment_id, request_key)
);
create index learning_versions_revision_idx on private.learning_versions(revision_id);
create index learning_enrollments_version_idx on private.learning_enrollments(version_id);
create index learning_versions_publisher_idx on private.learning_versions(published_by);
create index learning_courses_editor_idx on private.learning_courses(updated_by);
alter table private.learning_courses enable row level security;
alter table private.learning_versions enable row level security;
alter table private.learning_enrollments enable row level security;
alter table private.learning_unit_progress enable row level security;
alter table private.learning_submissions enable row level security;
revoke all on private.learning_courses, private.learning_versions, private.learning_enrollments,
  private.learning_unit_progress, private.learning_submissions from public, anon, authenticated;

create table private.learning_media (
  id uuid primary key,
  title text not null check (char_length(title) between 2 and 180),
  storage_key text not null unique,
  caption_storage_key text not null unique,
  transcript_storage_key text not null unique,
  sha256 text not null check (sha256 ~ '^[a-f0-9]{64}$'),
  uploaded_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);
create index learning_media_uploader_idx on private.learning_media(uploaded_by);
alter table private.learning_media enable row level security;
revoke all on private.learning_media from public,anon,authenticated;

create function private.require_learning_user() returns uuid
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.current_user_is_usable()
    or (private.current_principal_requires_aal2() and not private.current_session_is_aal2()) then
    raise exception 'Sign in with the required verification to continue.' using errcode = '42501';
  end if;
  return auth.uid();
end;
$$;
create function private.require_learning_editor() returns uuid
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_learning_user();
  -- Shared courses require portfolio-wide content permission. A permission
  -- scoped to one product cannot publish to another product through the Hub.
  if not private.has_staff_permission('content.write', null) then
    raise exception 'Shared-course editor access required.' using errcode = '42501';
  end if;
  return auth.uid();
end;
$$;

create function private.validate_learning_document(p_doc jsonb, p_publishing boolean default false)
returns void language plpgsql security definer set search_path = '' as $$
declare
  unit jsonb; question jsonb; option jsonb; unit_ids uuid[] := '{}'; question_ids uuid[];
  option_ids uuid[]; unit_id uuid; question_id uuid; option_id uuid; product_id uuid;
  products uuid[] := '{}'; unit_type text; media private.learning_media%rowtype;
begin
  if p_doc is null or jsonb_typeof(p_doc) <> 'object' or octet_length(p_doc::text) > 1500000 then
    raise exception 'Course document is invalid or too large.' using errcode = '22023';
  end if;
  if coalesce(char_length(btrim(p_doc->>'title')), 0) not between 2 and 180
    or coalesce(char_length(p_doc->>'summary'), 0) > 500
    or coalesce(char_length(p_doc->>'category'), 0) > 100
    or coalesce(char_length(p_doc->>'overview'),0)>60000
    or coalesce(p_doc->>'accessLevel', '') not in ('public', 'customer', 'staff')
    or coalesce(p_doc->>'durationMinutes', '') !~ '^[0-9]{1,4}$'
    or (p_doc->>'durationMinutes')::integer not between 1 and 1440 then
    raise exception 'Complete the course title, summary, access, and duration.' using errcode = '22023';
  end if;
  if jsonb_typeof(p_doc->'productIds') is distinct from 'array'
    or jsonb_array_length(p_doc->'productIds') not between 1 and 6 then
    raise exception 'Choose at least one registered product.' using errcode = '22023';
  end if;
  for product_id in select value::uuid from jsonb_array_elements_text(p_doc->'productIds') loop
    if product_id = any(products) or not exists (
      select 1 from hub.products p where p.id = product_id and p.status <> 'retired'
        and p.slug in ('carebase','pennsync','breathe','caremetric-emr','caremetric-go','caremetric-intel')
    ) then raise exception 'Course product is invalid or duplicated.' using errcode = '22023'; end if;
    products := array_append(products, product_id);
  end loop;
  if jsonb_typeof(p_doc->'units') is distinct from 'array'
    or jsonb_array_length(p_doc->'units') not between 1 and 150 then
    raise exception 'A course needs between 1 and 150 learning units.' using errcode = '22023';
  end if;
  for unit in select value from jsonb_array_elements(p_doc->'units') loop
    unit_id := (unit->>'id')::uuid;
    unit_type := unit->>'type';
    if unit_id is null or unit_id = any(unit_ids)
      or coalesce(char_length(btrim(unit->>'title')), 0) not between 2 and 180
      or coalesce(unit_type, '') not in ('text','video','quiz','attestation') then
      raise exception 'Learning unit is invalid or duplicated.' using errcode = '22023';
    end if;
    unit_ids := array_append(unit_ids, unit_id);
    if unit_type in ('text','attestation')
      and coalesce(char_length(btrim(unit->>'body')), 0) not between 1 and 60000 then
      raise exception 'A lesson or attestation needs readable content.' using errcode = '22023';
    end if;
    if unit_type = 'video' then
      if coalesce(char_length(btrim(unit->>'body')), 0) not between 1 and 60000 then
        raise exception 'Video lessons require a transcript.' using errcode = '22023';
      end if;
      if p_publishing then
        select * into media from private.learning_media where id = (unit->>'mediaAssetId')::uuid;
        if not found then
          raise exception 'Video requires approved central media, checksum, captions, and transcript.' using errcode = '22023';
        end if;
      end if;
    end if;
    if unit_type = 'quiz' then
      if coalesce(unit->>'passingScore', '') !~ '^[0-9]{1,3}$'
        or (unit->>'passingScore')::integer not between 1 and 100
        or (unit->>'maxAttempts' is not null and
          (unit->>'maxAttempts' !~ '^[0-9]{1,2}$' or (unit->>'maxAttempts')::integer not between 1 and 10))
        or jsonb_typeof(unit->'questions') is distinct from 'array'
        or jsonb_array_length(unit->'questions') not between 1 and 100 then
        raise exception 'Complete quiz questions, passing score, and attempt limit.' using errcode = '22023';
      end if;
      question_ids := '{}';
      for question in select value from jsonb_array_elements(unit->'questions') loop
        question_id := (question->>'id')::uuid;
        if question_id is null or question_id = any(question_ids)
          or coalesce(char_length(btrim(question->>'prompt')), 0) not between 2 and 3000
          or coalesce(question->>'points','1') !~ '^[0-9]{1,3}$'
          or coalesce((question->>'points')::integer,1) not between 1 and 100
          or jsonb_typeof(question->'options') is distinct from 'array'
          or jsonb_array_length(question->'options') not between 2 and 8 then
          raise exception 'Quiz question is incomplete or duplicated.' using errcode = '22023';
        end if;
        question_ids := array_append(question_ids, question_id);
        option_ids := '{}';
        for option in select value from jsonb_array_elements(question->'options') loop
          option_id := (option->>'id')::uuid;
          if option_id is null or option_id = any(option_ids)
            or coalesce(char_length(btrim(option->>'text')), 0) not between 1 and 2000 then
            raise exception 'Quiz answer option is invalid or duplicated.' using errcode = '22023';
          end if;
          option_ids := array_append(option_ids, option_id);
        end loop;
        if not coalesce((question->>'correctOptionId')::uuid = any(option_ids), false) then
          raise exception 'Choose exactly one valid correct answer.' using errcode = '22023';
        end if;
      end loop;
    end if;
  end loop;
end;
$$;

-- Explicit projection, never JSON minus a denylist: future author-only fields
-- must not accidentally become part of the learner API.
create function private.learning_public_document(p_doc jsonb) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    'title', p_doc->>'title', 'summary', p_doc->>'summary', 'category', p_doc->>'category',
    'overview', coalesce(p_doc->>'overview',''), 'durationMinutes', p_doc->'durationMinutes', 'accessLevel', p_doc->>'accessLevel',
    'productIds', p_doc->'productIds',
    'units', (select jsonb_agg(jsonb_build_object(
      'id', u.value->>'id', 'type', u.value->>'type', 'title', u.value->>'title',
      'body', coalesce(u.value->>'body',''),
      'mediaAssetId', case when u.value->>'type' = 'video' then u.value->>'mediaAssetId' else null end,
      'passingScore', u.value->'passingScore', 'maxAttempts', u.value->'maxAttempts',
      'questions', case when u.value->>'type' = 'quiz' then (
        select jsonb_agg(jsonb_build_object('id', q.value->>'id', 'prompt', q.value->>'prompt', 'points', coalesce((q.value->>'points')::integer,1),
          'options', (select jsonb_agg(jsonb_build_object('id', o.value->>'id', 'text', o.value->>'text') order by o.ordinality)
            from jsonb_array_elements(q.value->'options') with ordinality o)
        ) order by q.ordinality) from jsonb_array_elements(u.value->'questions') with ordinality q
      ) else null end
    ) order by u.ordinality) from jsonb_array_elements(p_doc->'units') with ordinality u)
  );
$$;

create function hub.get_learning_editor_access() returns boolean
language sql stable security definer set search_path = '' as $$
  select private.has_staff_permission('content.write', null);
$$;

create function hub.list_learning_drafts() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_learning_editor();
  return coalesce((select jsonb_agg(jsonb_build_object('itemId', c.item_id,
    'title', c.draft->>'title', 'draftVersion', c.draft_version,
    'published', c.published_version_id is not null, 'updatedAt', c.updated_at)
    order by c.updated_at desc) from private.learning_courses c), '[]'::jsonb);
end;
$$;

create function hub.get_learning_draft(p_item_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare course private.learning_courses%rowtype;
begin
  perform private.require_learning_editor();
  select * into course from private.learning_courses where item_id = p_item_id;
  if not found then raise exception 'Course draft unavailable.' using errcode = 'P0002'; end if;
  return jsonb_build_object('itemId', course.item_id, 'draftVersion', course.draft_version,
    'document', course.draft, 'published', course.published_version_id is not null);
end;
$$;

create function hub.save_learning_draft(p_item_id uuid, p_document jsonb, p_expected_version integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare editor uuid; v_item_id uuid; course private.learning_courses%rowtype;
begin
  editor := private.require_learning_editor();
  perform private.validate_learning_document(p_document);
  if p_item_id is null or p_expected_version = 0 then
    if p_expected_version is distinct from 0 then raise exception 'Invalid new-draft version.' using errcode = '22023'; end if;
    v_item_id := coalesce(p_item_id,gen_random_uuid());
    insert into hub.content_items(id,content_key,kind,access_level,created_by)
      values(v_item_id,'hub.course.' || v_item_id::text,'course',(p_document->>'accessLevel')::hub.access_level,editor)
      on conflict(id) do nothing;
    if not exists(select 1 from hub.content_items i where i.id=v_item_id and i.created_by=editor and i.kind='course') then
      raise exception 'Course creation key is unavailable.' using errcode='40001';
    end if;
    insert into private.learning_courses(item_id,draft,updated_by) values(v_item_id,p_document,editor)
      on conflict on constraint learning_courses_pkey do nothing;
    if not exists(select 1 from private.learning_courses c where c.item_id=v_item_id
      and c.draft_version=1 and c.draft=p_document) then
      raise exception 'This course was already saved. Reload it before editing.' using errcode='40001';
    end if;
  else
    select * into course from private.learning_courses c where c.item_id = p_item_id for update;
    if not found then raise exception 'Course draft unavailable.' using errcode = 'P0002'; end if;
    if course.draft_version is distinct from p_expected_version then
      raise exception 'This draft changed. Reload it before saving.' using errcode = '40001';
    end if;
    v_item_id := p_item_id;
    update private.learning_courses c set draft = p_document, draft_version = c.draft_version + 1,
      updated_by = editor, updated_at = now() where c.item_id = p_item_id;
  end if;
  return hub.get_learning_draft(v_item_id);
end;
$$;

create function hub.publish_learning_course(p_item_id uuid, p_expected_version integer, p_reviewed boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  editor uuid; course private.learning_courses%rowtype; v_revision_id uuid := gen_random_uuid();
  v_version_id uuid := gen_random_uuid(); revision_number integer; v_product_id uuid;
begin
  editor := private.require_learning_editor();
  if p_reviewed is distinct from true then
    raise exception 'Review the course for accuracy and confirm it contains no private data before publishing.' using errcode = '22023';
  end if;
  select * into course from private.learning_courses where item_id = p_item_id for update;
  if not found then raise exception 'Course draft unavailable.' using errcode = 'P0002'; end if;
  if course.draft_version is distinct from p_expected_version then
    raise exception 'This draft changed. Reload it before publishing.' using errcode = '40001';
  end if;
  perform private.validate_learning_document(course.draft, true);
  -- A retry of publishing the same reviewed draft returns its existing version.
  if exists (select 1 from private.learning_versions v where v.id = course.published_version_id and v.document = course.draft) then
    return jsonb_build_object('itemId',p_item_id,'versionId',course.published_version_id);
  end if;
  select coalesce(max(revision_no),0) + 1 into revision_number from hub.content_revisions where item_id = p_item_id;
  insert into hub.content_revisions(id,item_id,revision_no,title,summary,variables,review_state,created_by,approved_by,approved_at)
    values(v_revision_id,p_item_id,revision_number,course.draft->>'title',coalesce(course.draft->>'summary',''),
      jsonb_build_object('content_category',course.draft->>'category','course_duration_minutes',course.draft->'durationMinutes'),
      'approved',editor,editor,now());
  insert into private.learning_versions(id,item_id,revision_id,document,published_by)
    values(v_version_id,p_item_id,v_revision_id,course.draft,editor);
  update private.learning_courses set published_version_id = v_version_id where item_id = p_item_id;
  update hub.content_items set status='published', source_system='support_hub',
    access_level=(course.draft->>'accessLevel')::hub.access_level,retired_at=null where id=p_item_id;
  -- Expire removed placements; keep historical publications and revisions.
  update hub.content_publications set expires_at = clock_timestamp() where item_id = p_item_id
    and product_id not in (select value::uuid from jsonb_array_elements_text(course.draft->'productIds'));
  for v_product_id in select value::uuid from jsonb_array_elements_text(course.draft->'productIds') loop
    insert into hub.content_publications(item_id,revision_id,product_id,published_by)
      values(p_item_id,v_revision_id,v_product_id,editor)
      on conflict(item_id,product_id) do update set revision_id=excluded.revision_id,
        published_at=now(),expires_at=null,published_by=excluded.published_by;
  end loop;
  insert into private.audit_events(actor_id,action,entity_type,entity_id,metadata)
    values(editor,'learning.course.published','content_item',p_item_id,
      jsonb_build_object('version_id',v_version_id,'revision_no',revision_number));
  return jsonb_build_object('itemId',p_item_id,'versionId',v_version_id);
end;
$$;

create function hub.list_learning_catalog() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('itemId',c.item_id,'versionId',v.id,
    'title',v.document->>'title','summary',v.document->>'summary','category',v.document->>'category',
    'durationMinutes',v.document->'durationMinutes','productIds',v.document->'productIds',
    'unitCount',jsonb_array_length(v.document->'units')) order by v.document->>'title'), '[]'::jsonb)
  from private.learning_courses c join private.learning_versions v on v.id=c.published_version_id
  join hub.content_items i on i.id=c.item_id
  where i.status='published' and private.can_view_content_item(c.item_id);
$$;

create function hub.enroll_learning_course(p_item_id uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare learner uuid; v_version_id uuid; enrollment_id uuid;
begin
  learner := private.require_learning_user();
  select c.published_version_id into v_version_id from private.learning_courses c
    join hub.content_items i on i.id=c.item_id where c.item_id=p_item_id and i.status='published'
      and private.can_view_content_item(c.item_id);
  if v_version_id is null then raise exception 'Course unavailable.' using errcode='42501'; end if;
  insert into private.learning_enrollments(user_id,version_id) values(learner,v_version_id)
    on conflict(user_id,version_id) do nothing;
  select e.id into enrollment_id from private.learning_enrollments e where e.user_id=learner and e.version_id=v_version_id;
  return enrollment_id;
end;
$$;

create function hub.get_learning_course(p_item_id uuid, p_enrollment_id uuid default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare learner uuid; version private.learning_versions%rowtype; enrollment private.learning_enrollments%rowtype;
begin
  learner := private.require_learning_user();
  if not private.can_view_content_item(p_item_id) or not exists(
    select 1 from hub.content_items where id=p_item_id and status='published'
  ) then raise exception 'Course unavailable.' using errcode='42501'; end if;
  if p_enrollment_id is not null then
    select e.* into enrollment from private.learning_enrollments e join private.learning_versions v on v.id=e.version_id
      where e.id=p_enrollment_id and e.user_id=learner and v.item_id=p_item_id;
    if not found then raise exception 'Enrollment unavailable.' using errcode='42501'; end if;
    select * into version from private.learning_versions where id=enrollment.version_id;
  else
    select v.* into version from private.learning_versions v join private.learning_courses c on c.published_version_id=v.id
      where c.item_id=p_item_id;
    if not found then raise exception 'Course unavailable.' using errcode='42501'; end if;
    select * into enrollment from private.learning_enrollments e where e.user_id=learner and e.version_id=version.id;
  end if;
  return jsonb_build_object('itemId',p_item_id,'versionId',version.id,
    'document',private.learning_public_document(version.document),
    'enrollmentId',enrollment.id,'completedAt',enrollment.completed_at,'certificateId',enrollment.certificate_id,
    'progress',coalesce((select jsonb_agg(jsonb_build_object('unitId',unit_id,'completedAt',completed_at,
      'attemptCount',attempt_count,'bestScore',best_score)) from private.learning_unit_progress where enrollment_id=enrollment.id),'[]'::jsonb));
end;
$$;

create function hub.submit_learning_unit(p_enrollment_id uuid,p_unit_id uuid,p_answers jsonb,p_attested boolean,p_request_key uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  learner uuid; enrollment private.learning_enrollments%rowtype; version private.learning_versions%rowtype;
  progress private.learning_unit_progress%rowtype; prior private.learning_submissions%rowtype;
  unit jsonb; question jsonb; request_hash text; score integer; correct integer:=0; count_questions integer; total_points integer := 0; question_points integer;
  passed boolean; result jsonb; pending integer;
begin
  learner := private.require_learning_user();
  if p_request_key is null or p_unit_id is null or p_answers is null
    or jsonb_typeof(p_answers)<>'object' or octet_length(p_answers::text)>20000 then
    raise exception 'Invalid learning submission.' using errcode='22023';
  end if;
  select * into enrollment from private.learning_enrollments where id=p_enrollment_id and user_id=learner for update;
  if not found then raise exception 'Enrollment unavailable.' using errcode='42501'; end if;
  select * into version from private.learning_versions where id=enrollment.version_id;
  if not private.can_view_content_item(version.item_id) or not exists(
    select 1 from hub.content_items where id=version.item_id and status='published'
  ) then raise exception 'Course access unavailable.' using errcode='42501'; end if;
  request_hash := encode(extensions.digest(jsonb_build_object('unit',p_unit_id,'answers',p_answers,'attested',p_attested)::text,'sha256'),'hex');
  select * into prior from private.learning_submissions where enrollment_id=p_enrollment_id and request_key=p_request_key;
  if found then
    if prior.request_hash<>request_hash then raise exception 'Submission key already used for different content.' using errcode='22023'; end if;
    return prior.result;
  end if;
  select value into unit from jsonb_array_elements(version.document->'units') where value->>'id'=p_unit_id::text;
  if unit is null then raise exception 'Learning unit unavailable.' using errcode='22023'; end if;
  if enrollment.completed_at is not null then raise exception 'Course is already completed.' using errcode='22023'; end if;
  select * into progress from private.learning_unit_progress where enrollment_id=p_enrollment_id and unit_id=p_unit_id;
  if progress.completed_at is not null then raise exception 'Learning unit is already completed.' using errcode='22023'; end if;
  if unit->>'type'='quiz' then
    if coalesce(progress.attempt_count,0)>=(unit->>'maxAttempts')::integer then
      raise exception 'Quiz attempt limit reached. Contact your educator.' using errcode='22023';
    end if;
    count_questions := jsonb_array_length(unit->'questions');
    if (select count(*) from jsonb_object_keys(p_answers))<>count_questions then
      raise exception 'Answer every quiz question exactly once.' using errcode='22023';
    end if;
    for question in select value from jsonb_array_elements(unit->'questions') loop
      if jsonb_typeof(p_answers->(question->>'id')) is distinct from 'string'
        or not exists(select 1 from jsonb_array_elements(question->'options') o
          where o->>'id'=p_answers->>(question->>'id')) then
        raise exception 'Quiz answer is not a valid option.' using errcode='22023';
      end if;
      question_points := coalesce((question->>'points')::integer,1);
      total_points := total_points + question_points;
      if p_answers->>(question->>'id')=question->>'correctOptionId' then correct:=correct+question_points; end if;
    end loop;
    score := floor(100.0*correct/total_points);
    passed := score >= (unit->>'passingScore')::integer;
  else
    if p_attested is distinct from true or p_answers<>'{}'::jsonb then
      raise exception 'Confirm that you completed this lesson.' using errcode='22023';
    end if;
    passed := true;
  end if;
  insert into private.learning_unit_progress(enrollment_id,unit_id,completed_at,attempt_count,best_score)
    values(p_enrollment_id,p_unit_id,case when passed then now() end,1,score)
    on conflict(enrollment_id,unit_id) do update set completed_at=excluded.completed_at,
      attempt_count=private.learning_unit_progress.attempt_count+1,
      best_score=greatest(private.learning_unit_progress.best_score,excluded.best_score);
  select count(*) into pending from jsonb_array_elements(version.document->'units') u
    where not exists(select 1 from private.learning_unit_progress p where p.enrollment_id=p_enrollment_id
      and p.unit_id=(u->>'id')::uuid and p.completed_at is not null);
  if pending=0 then
    update private.learning_enrollments set completed_at=now(),certificate_id=gen_random_uuid(),
      certificate_name=(select display_name from hub.profiles where id=learner)
      where id=p_enrollment_id returning * into enrollment;
    insert into private.audit_events(actor_id,action,entity_type,entity_id,metadata)
      values(learner,'learning.course.completed','learning_enrollment',p_enrollment_id,
        jsonb_build_object('version_id',version.id));
  end if;
  result:=jsonb_build_object('passed',passed,'score',score,'attemptCount',coalesce(progress.attempt_count,0)+1,
    'completedAt',enrollment.completed_at,'certificateId',enrollment.certificate_id);
  insert into private.learning_submissions(enrollment_id,request_key,request_hash,result)
    values(p_enrollment_id,p_request_key,request_hash,result);
  return result;
end;
$$;

create function hub.list_my_learning() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare learner uuid;
begin
  learner := private.require_learning_user();
  return coalesce((select jsonb_agg(jsonb_build_object('enrollmentId',e.id,'itemId',v.item_id,
    'title',v.document->>'title','versionId',v.id,'startedAt',e.started_at,'completedAt',e.completed_at,
    'certificateId',e.certificate_id,'durationMinutes',v.document->'durationMinutes',
    'totalUnits',jsonb_array_length(v.document->'units'),'completedUnits',
    (select count(*) from private.learning_unit_progress p where p.enrollment_id=e.id and p.completed_at is not null))
    order by e.started_at desc) from private.learning_enrollments e join private.learning_versions v on v.id=e.version_id
    where e.user_id=learner),'[]'::jsonb);
end;
$$;

create function hub.get_learning_certificate(p_enrollment_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare learner uuid; result jsonb;
begin
  learner := private.require_learning_user();
  select jsonb_build_object('certificateId',e.certificate_id,'enrollmentId',e.id,
    'learnerName',e.certificate_name,'courseTitle',v.document->>'title','completedAt',e.completed_at,
    'durationMinutes',v.document->'durationMinutes','versionId',v.id)
    into result from private.learning_enrollments e join private.learning_versions v on v.id=e.version_id
    where e.id=p_enrollment_id and e.user_id=learner and e.completed_at is not null;
  if result is null then raise exception 'Certificate unavailable.' using errcode='42501'; end if;
  return result;
end;
$$;

revoke all on function private.require_learning_user(), private.require_learning_editor(),
  private.validate_learning_document(jsonb,boolean),private.learning_public_document(jsonb) from public,anon,authenticated;
revoke all on function hub.get_learning_editor_access(),hub.list_learning_drafts(),hub.get_learning_draft(uuid),
  hub.save_learning_draft(uuid,jsonb,integer),hub.publish_learning_course(uuid,integer,boolean),
  hub.list_learning_catalog(),hub.enroll_learning_course(uuid),hub.get_learning_course(uuid,uuid),
  hub.submit_learning_unit(uuid,uuid,jsonb,boolean,uuid),hub.list_my_learning(),hub.get_learning_certificate(uuid)
  from public,anon,authenticated;
grant execute on function hub.list_learning_catalog() to anon,authenticated;
grant execute on function hub.get_learning_editor_access(),hub.list_learning_drafts(),hub.get_learning_draft(uuid),
  hub.save_learning_draft(uuid,jsonb,integer),hub.publish_learning_course(uuid,integer,boolean),
  hub.enroll_learning_course(uuid),hub.get_learning_course(uuid,uuid),
  hub.submit_learning_unit(uuid,uuid,jsonb,boolean,uuid),hub.list_my_learning(),hub.get_learning_certificate(uuid)
  to authenticated;
-- Media is immutable and private. Products never hold provider credentials.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('hub-learning','hub-learning',false,268435456,array['video/mp4','text/vtt','text/plain']);

create function private.can_upload_learning_object(p_name text) returns boolean
language sql stable security definer set search_path='' as $$
  select private.has_staff_permission('content.write',null)
    and p_name ~ '^learning/[0-9a-f-]{36}/(video.mp4|captions.vtt|transcript.txt)$';
$$;
create function private.can_read_learning_object(p_name text) returns boolean
language sql stable security definer set search_path='' as $$
  select private.current_user_is_usable()
    and (not private.current_principal_requires_aal2() or private.current_session_is_aal2())
    and (private.has_staff_permission('content.write',null) or exists(
      select 1 from private.learning_media m
      join private.learning_versions v on exists(
        select 1 from jsonb_array_elements(v.document->'units') u where u->>'mediaAssetId'=m.id::text and u->>'type'='video')
      join private.learning_enrollments e on e.version_id=v.id and e.user_id=auth.uid()
      join hub.content_items i on i.id=v.item_id and i.status='published'
      where p_name in (m.storage_key,m.caption_storage_key,m.transcript_storage_key)
        and private.can_view_content_item(v.item_id)
    ));
$$;
revoke all on function private.can_upload_learning_object(text),private.can_read_learning_object(text) from public,anon,authenticated;
grant execute on function private.can_upload_learning_object(text),private.can_read_learning_object(text) to authenticated;
create policy learning_media_upload on storage.objects for insert to authenticated
  with check(bucket_id='hub-learning' and private.can_upload_learning_object(name));
create policy learning_media_read on storage.objects for select to authenticated
  using(bucket_id='hub-learning' and private.can_read_learning_object(name));

create function hub.register_learning_media(p_id uuid,p_title text,p_sha256 text,p_reviewed boolean) returns uuid
language plpgsql security definer set search_path='' as $$
declare editor uuid; prefix text;
begin
  editor:=private.require_learning_editor();
  if p_id is null or p_reviewed is distinct from true or coalesce(p_sha256,'') !~ '^[a-f0-9]{64}$'
    or coalesce(char_length(btrim(p_title)),0) not between 2 and 180 then
    raise exception 'Review the video, captions, transcript, and confirm there is no private data.' using errcode='22023';
  end if;
  prefix:='learning/'||p_id::text||'/';
  if (select count(*) from storage.objects where bucket_id='hub-learning'
    and name in (prefix||'video.mp4',prefix||'captions.vtt',prefix||'transcript.txt')
    and (metadata->>'size')::bigint>0)<>3 then
    raise exception 'Upload all three media files before approval.' using errcode='22023';
  end if;
  insert into private.learning_media(id,title,storage_key,caption_storage_key,transcript_storage_key,sha256,uploaded_by)
    values(p_id,p_title,prefix||'video.mp4',prefix||'captions.vtt',prefix||'transcript.txt',p_sha256,editor);
  insert into private.audit_events(actor_id,action,entity_type,entity_id)
    values(editor,'learning.media.approved','learning_media',p_id);
  return p_id;
end;
$$;
create function hub.list_learning_media() returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
  perform private.require_learning_editor();
  return coalesce((select jsonb_agg(jsonb_build_object('id',id,'title',title) order by created_at desc)
    from private.learning_media),'[]'::jsonb);
end;
$$;
create function hub.get_learning_media_paths(p_asset_id uuid,p_enrollment_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare learner uuid; media private.learning_media%rowtype;
begin
  learner:=private.require_learning_user();
  select m.* into media from private.learning_media m where m.id=p_asset_id and exists(
    select 1 from private.learning_enrollments e join private.learning_versions v on v.id=e.version_id
    join hub.content_items i on i.id=v.item_id and i.status='published'
    where e.id=p_enrollment_id and e.user_id=learner and private.can_view_content_item(v.item_id)
      and exists(select 1 from jsonb_array_elements(v.document->'units') u where u->>'mediaAssetId'=p_asset_id::text and u->>'type'='video')
  );
  if not found then raise exception 'Video unavailable.' using errcode='42501'; end if;
  return jsonb_build_object('video',media.storage_key,'captions',media.caption_storage_key);
end;
$$;
revoke all on function hub.register_learning_media(uuid,text,text,boolean),hub.list_learning_media(),hub.get_learning_media_paths(uuid,uuid) from public,anon,authenticated;
grant execute on function hub.register_learning_media(uuid,text,text,boolean),hub.list_learning_media(),hub.get_learning_media_paths(uuid,uuid) to authenticated;


create table private.learning_imports (
  source_course_id uuid primary key,
  source_version_id uuid not null,
  document_sha256 text not null,
  item_id uuid not null unique references private.learning_courses(item_id),
  imported_at timestamptz not null default now()
);
alter table private.learning_imports enable row level security;
revoke all on private.learning_imports from public,anon,authenticated;

-- Import existing catalog items as drafts without changing live catalog links.
-- Repeated snapshots cannot overwrite either reviewed work or another source revision.
create function hub.import_learning_draft(p_source_course_id uuid,p_source_version_id uuid,p_document jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare editor uuid; v_item_id uuid; v_hash text; prior private.learning_imports%rowtype;
begin
  editor:=private.require_learning_editor();
  if p_source_course_id is null or p_source_version_id is null then
    raise exception 'Source course and revision are required.' using errcode='22023';
  end if;
  perform private.validate_learning_document(p_document);
  select l.content_item_id into v_item_id from hub.course_links l
    join hub.content_items i on i.id=l.content_item_id
    where l.penntrain_course_id=p_source_course_id::text and i.kind='course'
    for update of i;
  if not found then raise exception 'Source course is not registered in the central catalog.' using errcode='22023'; end if;
  v_hash:=encode(extensions.digest(p_document::text,'sha256'),'hex');
  select * into prior from private.learning_imports where source_course_id=p_source_course_id;
  if found then
    if prior.source_version_id<>p_source_version_id or prior.document_sha256<>v_hash then
      raise exception 'This course was already imported. Review revisions in the course editor.' using errcode='40001';
    end if;
    return hub.get_learning_draft(prior.item_id);
  end if;
  insert into private.learning_courses(item_id,draft,updated_by) values(v_item_id,p_document,editor);
  insert into private.learning_imports(source_course_id,source_version_id,document_sha256,item_id)
    values(p_source_course_id,p_source_version_id,v_hash,v_item_id);
  insert into private.audit_events(actor_id,action,entity_type,entity_id,metadata)
    values(editor,'learning.course.imported','content_item',v_item_id,jsonb_build_object('source_version_id',p_source_version_id));
  return hub.get_learning_draft(v_item_id);
end;
$$;
revoke all on function hub.import_learning_draft(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function hub.import_learning_draft(uuid,uuid,jsonb) to authenticated;
