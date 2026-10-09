-- Relias-style course delivery for Hub-authored courses: lessons open in order,
-- a published course ends with a graded post-test, and the completion
-- certificate reports the post-test score. Replacements keep existing grants.
-- No Hub course is published yet, so no enrollment is pinned to an older rule.

create or replace function private.validate_learning_document(p_doc jsonb, p_publishing boolean default false)
returns void language plpgsql security definer set search_path = '' as $$
declare
  unit jsonb; question jsonb; option jsonb; unit_ids uuid[] := '{}'; question_ids uuid[];
  option_ids uuid[]; unit_id uuid; question_id uuid; option_id uuid; product_id uuid;
  products uuid[] := '{}'; unit_type text; media private.learning_media%rowtype;
  last_quiz bigint; last_lesson bigint;
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
  -- Learners read or watch every lesson, pass a graded post-test, then receive
  -- the certificate. Drafts may be incomplete; a publication may not.
  if p_publishing then
    select max(u.position) filter (where u.value->>'type' = 'quiz'),
      max(u.position) filter (where u.value->>'type' in ('text','video'))
      into last_quiz, last_lesson
      from jsonb_array_elements(p_doc->'units') with ordinality u(value, position);
    if last_quiz is null or last_lesson > last_quiz then
      raise exception 'End the course with a graded post-test after the last lesson.' using errcode = '22023';
    end if;
  end if;
end;
$$;

create or replace function hub.submit_learning_unit(p_enrollment_id uuid,p_unit_id uuid,p_answers jsonb,p_attested boolean,p_request_key uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  learner uuid; enrollment private.learning_enrollments%rowtype; version private.learning_versions%rowtype;
  progress private.learning_unit_progress%rowtype; prior private.learning_submissions%rowtype;
  unit jsonb; question jsonb; request_hash text; score integer; correct integer:=0; count_questions integer; total_points integer := 0; question_points integer;
  passed boolean; result jsonb; pending integer; unit_position bigint;
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
  -- Units open in course order, so the post-test follows every lesson.
  select u.position into unit_position from jsonb_array_elements(version.document->'units') with ordinality u(value,position)
    where u.value->>'id'=p_unit_id::text;
  if exists(select 1 from jsonb_array_elements(version.document->'units') with ordinality u(value,position)
    where u.position<unit_position and not exists(select 1 from private.learning_unit_progress p
      where p.enrollment_id=p_enrollment_id and p.unit_id=(u.value->>'id')::uuid and p.completed_at is not null)) then
    raise exception 'Complete the earlier lessons in order before continuing.' using errcode='22023';
  end if;
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

create or replace function hub.get_learning_certificate(p_enrollment_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare learner uuid; result jsonb;
begin
  learner := private.require_learning_user();
  select jsonb_build_object('certificateId',e.certificate_id,'enrollmentId',e.id,
    'learnerName',e.certificate_name,'courseTitle',v.document->>'title','completedAt',e.completed_at,
    'durationMinutes',v.document->'durationMinutes','versionId',v.id,
    'finalScore',post_test.best_score,'passingScore',(post_test.unit->>'passingScore')::integer)
    into result from private.learning_enrollments e join private.learning_versions v on v.id=e.version_id
    -- The certificate reports the best score on the course's final post-test.
    left join lateral (select u.value as unit,p.best_score from jsonb_array_elements(v.document->'units') with ordinality u(value,position)
      left join private.learning_unit_progress p on p.enrollment_id=e.id and p.unit_id=(u.value->>'id')::uuid
      where u.value->>'type'='quiz' order by u.position desc limit 1) post_test on true
    where e.id=p_enrollment_id and e.user_id=learner and e.completed_at is not null;
  if result is null then raise exception 'Certificate unavailable.' using errcode='42501'; end if;
  return result;
end;
$$;
