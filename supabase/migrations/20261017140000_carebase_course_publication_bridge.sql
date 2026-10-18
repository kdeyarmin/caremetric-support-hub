-- CareBase course publication bridge: an imported CareBase course may publish
-- in the Hub once publication can prove the draft still carries the imported
-- course unchanged. This replaces the blanket draft-only rejection in
-- hub.publish_learning_course with a per-course preservation gate.
--
-- The import already proves what it carried: the converter preserves lesson
-- bodies, quiz points, passing scores, attempt limits, and exactly one correct
-- answer per question, and it fails loudly instead of dropping content it
-- cannot represent, so an unrepresentable course never becomes a draft. What
-- was missing is (a) a stored copy of the imported document to check later
-- edits against — private.learning_imports held only its SHA-256 — and
-- (b) permission to publish when that check passes. The stored hash already
-- pins which document was imported, so a hash-matching re-import backfills
-- the copy for drafts imported before this migration.
--
-- The gate compares only carried data: unit order, ids, types, titles, and
-- bodies; quiz passing score, attempt limit, and per-question id, prompt,
-- points, options, and correct answer; and durationMinutes, the credit the
-- completion certificate reports. The one permitted difference is a video
-- unit gaining a registered central media asset where the import had none —
-- the reviewed media transfer step. Presentation fields (course title,
-- summary, overview, category, access level, product placements) stay
-- editor-reviewed, exactly as for Hub-authored courses. The existing
-- publishing validation still runs afterwards, so a course whose videos have
-- not transferred, or whose lessons do not end with a graded post-test, stays
-- a draft with that visible reason.
--
-- No new RPC and no new backend feature: both replaced functions keep their
-- signatures and grants, and the helper is private, so the backend contract,
-- its feature list, and the server replay chains are unchanged.

alter table private.learning_imports add column source_document jsonb;

create function private.learning_import_preservation_error(p_item_id uuid, p_draft jsonb)
returns text language plpgsql stable security definer set search_path = '' as $$
declare
  import_row private.learning_imports%rowtype;
  source_doc jsonb; source_unit jsonb; draft_unit jsonb; source_question jsonb; draft_question jsonb;
  unit_position integer; question_position integer;
begin
  select * into import_row from private.learning_imports where item_id = p_item_id;
  if not found or import_row.source_document is null then return 'source'; end if;
  source_doc := import_row.source_document;
  -- Credit is the imported duration; the Hub reports it on every certificate.
  if p_draft->'durationMinutes' is distinct from source_doc->'durationMinutes' then return 'credit'; end if;
  if jsonb_array_length(p_draft->'units') <> jsonb_array_length(source_doc->'units') then return 'lessons'; end if;
  for unit_position in 0 .. jsonb_array_length(source_doc->'units') - 1 loop
    source_unit := source_doc->'units'->unit_position;
    draft_unit := p_draft->'units'->unit_position;
    if draft_unit->>'id' is distinct from source_unit->>'id'
      or draft_unit->>'type' is distinct from source_unit->>'type'
      or draft_unit->>'title' is distinct from source_unit->>'title'
      or coalesce(draft_unit->>'body', '') is distinct from coalesce(source_unit->>'body', '') then
      return 'lessons';
    end if;
    if source_unit->>'type' = 'quiz' then
      if draft_unit->'passingScore' is distinct from source_unit->'passingScore'
        or draft_unit->'maxAttempts' is distinct from source_unit->'maxAttempts'
        or jsonb_array_length(draft_unit->'questions') <> jsonb_array_length(source_unit->'questions') then
        return 'quiz';
      end if;
      for question_position in 0 .. jsonb_array_length(source_unit->'questions') - 1 loop
        source_question := source_unit->'questions'->question_position;
        draft_question := draft_unit->'questions'->question_position;
        if draft_question->>'id' is distinct from source_question->>'id'
          or draft_question->>'prompt' is distinct from source_question->>'prompt'
          or draft_question->'points' is distinct from source_question->'points'
          or draft_question->>'correctOptionId' is distinct from source_question->>'correctOptionId'
          or draft_question->'options' is distinct from source_question->'options' then
          return 'quiz';
        end if;
      end loop;
    end if;
  end loop;
  return null;
end;
$$;
revoke all on function private.learning_import_preservation_error(uuid,jsonb) from public,anon,authenticated;

-- Record the imported document with its provenance. A retry with the same
-- source revision and document hash backfills the copy for earlier imports;
-- the hash check above it proves the presented document is the imported one.
create or replace function hub.import_learning_draft(p_source_course_id uuid,p_source_version_id uuid,p_document jsonb) returns jsonb
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
    if prior.source_document is null then
      update private.learning_imports set source_document=p_document where source_course_id=p_source_course_id;
    end if;
    return hub.get_learning_draft(prior.item_id);
  end if;
  insert into private.learning_courses(item_id,draft,updated_by) values(v_item_id,p_document,editor);
  insert into private.learning_imports(source_course_id,source_version_id,document_sha256,item_id,source_document)
    values(p_source_course_id,p_source_version_id,v_hash,v_item_id,p_document);
  insert into private.audit_events(actor_id,action,entity_type,entity_id,metadata)
    values(editor,'learning.course.imported','content_item',v_item_id,jsonb_build_object('source_version_id',p_source_version_id));
  return hub.get_learning_draft(v_item_id);
end;
$$;
revoke all on function hub.import_learning_draft(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function hub.import_learning_draft(uuid,uuid,jsonb) to authenticated;

create or replace function hub.publish_learning_course(p_item_id uuid, p_expected_version integer, p_reviewed boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  editor uuid; course private.learning_courses%rowtype; v_revision_id uuid := gen_random_uuid();
  v_version_id uuid := gen_random_uuid(); revision_number integer; v_product_id uuid;
  v_preservation_error text; v_source_course_id uuid; v_source_version_id uuid;
begin
  editor := private.require_learning_editor();
  if p_reviewed is distinct from true then
    raise exception 'Review the course for accuracy and confirm it contains no private data before publishing.' using errcode = '22023';
  end if;
  select * into course from private.learning_courses where item_id = p_item_id for update;
  if not found then raise exception 'Course draft unavailable.' using errcode = 'P0002'; end if;
  -- An import preserves the source catalog identity in hub.course_links, and
  -- publishing that identity is the cutover: learners launch the Hub revision
  -- and the Hub records their completions. It is allowed only while the
  -- draft still carries the imported lessons, quiz behavior, and credit
  -- unchanged. Draft edits to carried content do not authorize cutover; the
  -- course keeps its CareBase runtime until the imported content is restored.
  if exists (select 1 from hub.course_links where content_item_id = p_item_id) then
    v_preservation_error := private.learning_import_preservation_error(p_item_id, course.draft);
    if v_preservation_error = 'source' then
      raise exception 'This imported CareBase course cannot publish yet: the imported content was not preserved for verification. Re-import the same course export, then publish the unchanged draft.' using errcode = '55000';
    elsif v_preservation_error = 'lessons' then
      raise exception 'This imported CareBase course cannot publish: a lesson was added, removed, reordered, or rewritten after import. Restore the imported lessons to publish it here, or keep delivering it from CareBase.' using errcode = '55000';
    elsif v_preservation_error = 'quiz' then
      raise exception 'This imported CareBase course cannot publish: quiz questions, answers, points, passing score, or attempt limits differ from the imported source. Restore the imported quiz to publish it here, or keep delivering it from CareBase.' using errcode = '55000';
    elsif v_preservation_error = 'credit' then
      raise exception 'This imported CareBase course cannot publish: its credited duration differs from the imported source. Restore the imported duration to publish it here, or keep delivering it from CareBase.' using errcode = '55000';
    end if;
    select source_course_id, source_version_id into v_source_course_id, v_source_version_id
      from private.learning_imports where item_id = p_item_id;
  end if;
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
      jsonb_build_object('version_id',v_version_id,'revision_no',revision_number)
      || case when v_source_course_id is not null
        then jsonb_build_object('source_course_id',v_source_course_id,'source_version_id',v_source_version_id)
        else '{}'::jsonb end);
  return jsonb_build_object('itemId',p_item_id,'versionId',v_version_id);
end;
$$;
revoke all on function hub.publish_learning_course(uuid,integer,boolean) from public,anon,authenticated;
grant execute on function hub.publish_learning_course(uuid,integer,boolean) to authenticated;
