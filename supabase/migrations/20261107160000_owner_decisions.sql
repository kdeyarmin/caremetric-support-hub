-- The owner's decisions after the November 7 feature review. Each statement replaces a function with the same signature, so
-- grants are kept.
--
-- 1. Quizzes: learners may retake a quiz as many times as they need; hub.submit_learning_unit no longer refuses an attempt past
--    a course's maxAttempts (the player shuffles the questions on each attempt).
-- 2. CareMetric PennSync courses: a course placed on PennSync published, but private.can_access_content_publication hid every
--    publication on a retired application without support, so no learner could see or enroll in it. Course publications on
--    PennSync now reach learners; PennSync's support and billing stay closed, and nothing else on a retired app is published.
-- 3. Customer growth: a proposal nobody decided expired after seven days, but its message stayed "proposed" and held the work,
--    so that business or customer was never drafted again. private.growth_maintenance now withdraws it and the next sweep
--    drafts afresh. A proposal the owner rejected stays final.

CREATE OR REPLACE FUNCTION hub.submit_learning_unit(p_enrollment_id uuid, p_unit_id uuid, p_answers jsonb, p_attested boolean, p_request_key uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
    -- A learner may retake a quiz as many times as they need (the player shuffles its questions each time). A course document's
    -- maxAttempts is kept, so imported courses still match their source, but no longer limits retakes.
    count_questions := jsonb_array_length(unit->'questions');
    if (select count(*) from jsonb_object_keys(p_answers))<>count_questions then
      raise exception 'Answer every quiz question exactly once.' using errcode='22023';
    end if;
    for question in select value from jsonb_array_elements(unit->'questions') loop
      question_points := coalesce((question->>'points')::integer,1);
      total_points := total_points + question_points;
      if question ? 'correctOptionIds' then
        -- Select all that apply: a non-empty set of distinct listed options.
        if jsonb_typeof(p_answers->(question->>'id')) is distinct from 'array'
          or jsonb_array_length(p_answers->(question->>'id')) = 0
          or exists(select 1 from jsonb_array_elements(p_answers->(question->>'id')) a
            where jsonb_typeof(a) is distinct from 'string'
              or not exists(select 1 from jsonb_array_elements(question->'options') o where o->>'id' = a#>>'{}'))
          or (select count(distinct a#>>'{}') from jsonb_array_elements(p_answers->(question->>'id')) a)
            <> jsonb_array_length(p_answers->(question->>'id')) then
          raise exception 'Quiz answer is not a valid option.' using errcode='22023';
        end if;
        if (select array_agg(distinct (a#>>'{}')::uuid order by (a#>>'{}')::uuid) from jsonb_array_elements(p_answers->(question->>'id')) a)
          = (select array_agg(distinct (k#>>'{}')::uuid order by (k#>>'{}')::uuid) from jsonb_array_elements(question->'correctOptionIds') k) then
          correct:=correct+question_points;
        end if;
      else
        if jsonb_typeof(p_answers->(question->>'id')) is distinct from 'string'
          or not exists(select 1 from jsonb_array_elements(question->'options') o
            where o->>'id'=p_answers->>(question->>'id')) then
          raise exception 'Quiz answer is not a valid option.' using errcode='22023';
        end if;
        if p_answers->>(question->>'id')=question->>'correctOptionId' then correct:=correct+question_points; end if;
      end if;
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
$function$;

CREATE OR REPLACE FUNCTION private.can_access_content_publication(p_item_id uuid, p_revision_id uuid, p_product_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
          -- A retired application or one without support publishes nothing, except CareMetric PennSync courses: PennSync keeps its
          -- own support and billing closed, but courses placed on it reach its learners.
          and (
            (publication_product.status <> 'retired' and publication_product.support_enabled)
            or (item.kind = 'course' and publication_product.slug = 'pennsync')
          )
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
$function$;

CREATE OR REPLACE FUNCTION private.growth_maintenance()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$ declare n integer; v_actions uuid[]; v_tasks uuid[]; v_task uuid; begin
 perform private.require_hub_app_server(); perform pg_advisory_xact_lock(hashtextextended('growth.workflow',0));
 update private.growth_messages set status='unknown' where status='sending' and attempted_at<now()-interval '10 minutes'; get diagnostics n=row_count;
 -- Reconcile before the worker reads its snapshot. Cancel only unsent drafts; never repeat an accepted or uncertain send.
 update private.growth_messages m set status='cancelled'
 from private.growth_opportunities o,private.growth_contacts c,private.growth_policies p
 where m.opportunity_id=o.id and m.contact_id=c.id and p.product=o.product and m.status in ('draft','proposed')
 and (m.opportunity_version<>o.version or m.contact_version<>c.version or m.policy_version<>p.version
   or not exists(select 1 from private.customer_success_plans w where w.id=m.work_id and w.status='open'));
 -- A proposal nobody decided in time expires: its message is withdrawn, so the next sweep drafts a fresh one for the same work.
 -- A proposal the owner rejected is left as it is, final while nothing about the opportunity, contact or policy changes.
 update private.growth_messages m set status='cancelled',withdrawn_at=now()
 from private.agent_actions a where m.action_id=a.id and m.status='proposed' and a.status='expired';
 select array_agg(a.id),array_agg(distinct a.task_id) into v_actions,v_tasks
 from private.agent_actions a join private.growth_messages m on m.action_id=a.id
 where m.status='cancelled' and a.status in ('proposed','approved','auto_approved');
 -- Owner decisions and cancellation lock tasks before actions; keep the same order here.
 perform 1 from private.agent_tasks where id=any(v_tasks) order by id for update;
 update private.agent_actions set status='expired',result=jsonb_build_object('reason','growth_draft_changed'),updated_at=now()
 where id=any(v_actions) and status in ('proposed','approved','auto_approved');
 for v_task in select id from private.agent_tasks where id=any(v_tasks) order by id loop
  perform private.agent_close_task_if_settled(v_task);
 end loop;
 delete from private.agent_budget_reservations where day_start<private.agent_day_start()-interval '7 days';
 return n;
end; $function$;
