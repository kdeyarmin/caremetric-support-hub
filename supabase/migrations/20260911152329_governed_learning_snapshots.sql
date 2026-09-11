-- Source preservation only. No source or Hub course, publication, enrollment,
-- assignment, completion, credit, certificate, or media writer is changed here.
create extension if not exists pg_jsonschema with schema extensions;

-- Generated from governedCourseSchema. The contract test compares this schema to
-- the TypeScript definition so bypassing browser validation cannot relax it.
create function private.governed_learning_schema() returns json
language sql immutable set search_path='' as $$
select $schema${"$schema":"http://json-schema.org/draft-07/schema#","type":"object","properties":{"contract":{"type":"string","const":"carebase.course.v1"},"sourceCourseId":{"type":"string","pattern":"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"},"sourceVersionId":{"type":"string","pattern":"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"},"sourceVersionNumber":{"type":"integer","minimum":-2147483648,"maximum":2147483647},"publicationState":{"type":"string","enum":["draft","published","archived"]},"sourceVersionState":{"type":"string","enum":["draft","published"]},"course":{"type":"object","properties":{"title":{"type":"string","maxLength":250000},"description":{"anyOf":[{"type":"string","maxLength":250000},{"type":"null"}]},"category":{"anyOf":[{"type":"string","maxLength":250000},{"type":"null"}]},"estimatedDurationMinutes":{"anyOf":[{"type":"integer","minimum":0,"maximum":2147483647},{"type":"null"}]},"catalogCode":{"anyOf":[{"type":"string","maxLength":250000},{"type":"null"}]},"recurrenceIntervalDays":{"anyOf":[{"type":"integer","minimum":1,"maximum":2147483647},{"type":"null"}]},"legacyTrainingTypeId":{"anyOf":[{"type":"string","pattern":"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"},{"type":"null"}]},"renewalTrainingTypeId":{"anyOf":[{"type":"string","pattern":"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"},{"type":"null"}]},"creditedDurationCheckExempt":{"type":"boolean"}},"required":["title","description","category","estimatedDurationMinutes","catalogCode","recurrenceIntervalDays","legacyTrainingTypeId","renewalTrainingTypeId","creditedDurationCheckExempt"],"additionalProperties":false},"version":{"type":"object","properties":{"title":{"type":"string","maxLength":250000},"description":{"anyOf":[{"type":"string","maxLength":250000},{"type":"null"}]},"label":{"anyOf":[{"type":"string","maxLength":250000},{"type":"null"}]},"contentStandard":{"type":"string","enum":["legacy","comprehensive"]},"creditedDurationRationale":{"anyOf":[{"type":"string","maxLength":250000},{"type":"null"}]},"aiGenerated":{"type":"boolean"},"aiReviewedAt":{"anyOf":[{"type":"string","maxLength":250000},{"type":"null"}]}},"required":["title","description","label","contentStandard","creditedDurationRationale","aiGenerated","aiReviewedAt"],"additionalProperties":false},"blocks":{"maxItems":500,"type":"array","items":{"type":"object","properties":{"id":{"type":"string","pattern":"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"},"type":{"type":"string","enum":["text","video","pdf","scorm","quiz","attestation"]},"sortOrder":{"type":"integer","minimum":-2147483648,"maximum":2147483647},"title":{"anyOf":[{"type":"string","maxLength":250000},{"type":"null"}]},"body":{"$ref":"#/definitions/__schema0"},"documentId":{"anyOf":[{"type":"string","pattern":"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"},{"type":"null"}]},"videoLocatorSha256":{"anyOf":[{"type":"string","pattern":"^[0-9a-f]{64}$"},{"type":"null"}]},"quiz":{"anyOf":[{"type":"object","properties":{"id":{"type":"string","pattern":"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"},"title":{"type":"string","maxLength":250000},"passingScore":{"type":"integer","minimum":0,"maximum":100},"maxAttempts":{"anyOf":[{"type":"integer","minimum":1,"maximum":2147483647},{"type":"null"}]},"kind":{"type":"string","enum":["assessment","knowledge_check","final_exam"]},"shuffleQuestions":{"type":"boolean"},"shuffleAnswers":{"type":"boolean"},"revealsAnswersAfterAttempt":{"type":"boolean"},"questions":{"maxItems":500,"type":"array","items":{"type":"object","properties":{"id":{"type":"string","pattern":"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"},"sortOrder":{"type":"integer","minimum":-2147483648,"maximum":2147483647},"prompt":{"type":"string","maxLength":250000},"type":{"type":"string","enum":["single_choice","multiple_choice","true_false"]},"points":{"type":"integer","minimum":1,"maximum":2147483647},"topicCode":{"anyOf":[{"type":"string","maxLength":250000},{"type":"null"}]},"topicLabel":{"anyOf":[{"type":"string","maxLength":250000},{"type":"null"}]},"explanation":{"anyOf":[{"type":"string","maxLength":250000},{"type":"null"}]},"options":{"maxItems":100,"type":"array","items":{"type":"object","properties":{"id":{"type":"string","pattern":"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"},"sortOrder":{"type":"integer","minimum":-2147483648,"maximum":2147483647},"text":{"type":"string","maxLength":250000},"correct":{"type":"boolean"}},"required":["id","sortOrder","text","correct"],"additionalProperties":false}}},"required":["id","sortOrder","prompt","type","points","topicCode","topicLabel","explanation","options"],"additionalProperties":false}}},"required":["id","title","passingScore","maxAttempts","kind","shuffleQuestions","shuffleAnswers","revealsAnswersAfterAttempt","questions"],"additionalProperties":false},{"type":"null"}]}},"required":["id","type","sortOrder","title","body","documentId","videoLocatorSha256","quiz"],"additionalProperties":false}},"credits":{"maxItems":100,"type":"array","items":{"type":"object","properties":{"id":{"type":"string","pattern":"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"},"trainingTypeId":{"type":"string","pattern":"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"},"topicCode":{"type":"string","maxLength":250000},"creditHours":{"type":"string","pattern":"^\\d{1,4}(\\.\\d{1,2})?$"},"mode":{"type":"string","enum":["automatic","verified_only"]},"citationNote":{"type":"string","maxLength":250000},"active":{"type":"boolean"}},"required":["id","trainingTypeId","topicCode","creditHours","mode","citationNote","active"],"additionalProperties":false}},"provider":{"anyOf":[{"type":"object","properties":{"id":{"type":"string","pattern":"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"},"fullName":{"type":"string","maxLength":250000},"professionalTitle":{"anyOf":[{"type":"string","maxLength":250000},{"type":"null"}]},"credential":{"anyOf":[{"type":"string","maxLength":250000},{"type":"null"}]},"credentialNumber":{"anyOf":[{"type":"string","maxLength":250000},{"type":"null"}]},"credentialIssuingOrganization":{"anyOf":[{"type":"string","maxLength":250000},{"type":"null"}]},"credentialExpiresOn":{"anyOf":[{"type":"string","maxLength":250000},{"type":"null"}]},"courseAuthor":{"anyOf":[{"type":"string","maxLength":250000},{"type":"null"}]},"signatureName":{"anyOf":[{"type":"string","maxLength":250000},{"type":"null"}]},"signatureRecordedAt":{"anyOf":[{"type":"string","maxLength":250000},{"type":"null"}]},"contentVersion":{"anyOf":[{"type":"string","maxLength":250000},{"type":"null"}]},"lastClinicalReviewDate":{"anyOf":[{"type":"string","maxLength":250000},{"type":"null"}]},"reviewedBy":{"anyOf":[{"type":"string","maxLength":250000},{"type":"null"}]},"nextReviewDue":{"anyOf":[{"type":"string","maxLength":250000},{"type":"null"}]},"regulationReviewDate":{"anyOf":[{"type":"string","maxLength":250000},{"type":"null"}]},"reviewNotes":{"anyOf":[{"type":"string","maxLength":250000},{"type":"null"}]}},"required":["id","fullName","professionalTitle","credential","credentialNumber","credentialIssuingOrganization","credentialExpiresOn","courseAuthor","signatureName","signatureRecordedAt","contentVersion","lastClinicalReviewDate","reviewedBy","nextReviewDue","regulationReviewDate","reviewNotes"],"additionalProperties":false},{"type":"null"}]},"packages":{"maxItems":100,"type":"array","items":{"type":"object","properties":{"id":{"type":"string","pattern":"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"},"standard":{"type":"string","enum":["scorm_1_2","scorm_2004_4th","xapi","lti_1_3"]},"contentSha256":{"type":"string","pattern":"^[0-9a-f]{64}$"},"entryPoint":{"anyOf":[{"type":"string","maxLength":250000},{"type":"null"}]},"manifest":{"$ref":"#/definitions/__schema1"},"capabilities":{"maxItems":100,"type":"array","items":{"type":"string","maxLength":250000}},"connectivityMode":{"type":"string","enum":["online_only","offline_supported"]},"validationStatus":{"type":"string","enum":["pending","validating","accepted","rejected","quarantined"]}},"required":["id","standard","contentSha256","entryPoint","manifest","capabilities","connectivityMode","validationStatus"],"additionalProperties":false}}},"required":["contract","sourceCourseId","sourceVersionId","sourceVersionNumber","publicationState","sourceVersionState","course","version","blocks","credits","provider","packages"],"additionalProperties":false,"definitions":{"__schema0":{"anyOf":[{"type":"string"},{"type":"number"},{"type":"boolean"},{"type":"null"},{"type":"array","items":{"$ref":"#/definitions/__schema0"}},{"type":"object","propertyNames":{"type":"string"},"additionalProperties":{"$ref":"#/definitions/__schema0"}}]},"__schema1":{"anyOf":[{"type":"string"},{"type":"number"},{"type":"boolean"},{"type":"null"},{"type":"array","items":{"$ref":"#/definitions/__schema1"}},{"type":"object","propertyNames":{"type":"string"},"additionalProperties":{"$ref":"#/definitions/__schema1"}}]}}}$schema$::json;
$$;

create function private.validate_governed_learning_source(p_payload text, p_revision text) returns jsonb
language plpgsql set search_path='' as $$
declare document jsonb;
begin
  if p_payload is null or octet_length(p_payload)>2000000 or p_revision is null
    or p_revision !~ '^[0-9a-f]{64}$'
    or encode(extensions.digest(p_payload,'sha256'),'hex')<>p_revision then
    raise exception 'Source revision checksum or size is invalid.' using errcode='22023';
  end if;
  begin document:=p_payload::jsonb;
  exception when invalid_text_representation then
    raise exception 'Source payload is not valid JSON.' using errcode='22023';
  end;
  if not extensions.jsonb_matches_schema(private.governed_learning_schema(),document) then
    raise exception 'Source snapshot does not match carebase.course.v1.' using errcode='22023';
  end if;
  if document::text ~* '([?&](token|access_token|signature|sig|key|policy|jwt|auth|h|hdnts|hdnea|key-pair-id|api_key|apikey|x-amz-[a-z-]+|x-goog-[a-z-]+)=|"(access_token|refresh_token|service_role_key|authorization|accessToken|refreshToken|password|client_secret|storage_path|storage_bucket|video_url|playback_url|signed_url)"[[:space:]]*:)' then
    raise exception 'Remove playback credentials from the source export before staging.' using errcode='22023';
  end if;
  if exists(select 1 from jsonb_array_elements(document->'blocks') b
    where ((b->>'type'='quiz') is distinct from (b->'quiz'<>'null'::jsonb))
      or ((b->'quiz'->>'revealsAnswersAfterAttempt')::boolean and b->'quiz'->>'kind'<>'knowledge_check')) then
    raise exception 'Source quiz configuration is invalid.' using errcode='22023';
  end if;
  if exists(
    with blocks as(select value b from jsonb_array_elements(document->'blocks')),
    questions as(select q from blocks cross join lateral jsonb_array_elements(coalesce(nullif(b->'quiz'->'questions','null'::jsonb),'[]'::jsonb)) q),
    ids as (
      select 'block' kind, lower(b->>'id') id from blocks
      union all select 'quiz',lower(b->'quiz'->>'id') from blocks where b->'quiz'<>'null'::jsonb
      union all select 'question',lower(q->>'id') from questions
      union all select 'answer',lower(a->>'id') from questions cross join lateral jsonb_array_elements(q->'options') a
      union all select 'credit',lower(c->>'id') from jsonb_array_elements(document->'credits') c
      union all select 'package',lower(p->>'id') from jsonb_array_elements(document->'packages') p
    ) select 1 from ids group by kind,id having count(*)>1
  ) then raise exception 'The source snapshot repeats a content identifier.' using errcode='22023'; end if;
  return document;
end;
$$;

create table private.learning_source_snapshots (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references hub.content_items(id),
  source_course_id uuid not null,
  source_version_id uuid not null,
  source_revision text not null check(source_revision ~ '^[0-9a-f]{64}$'),
  sequence integer not null check(sequence>0),
  publication_state text not null check(publication_state in ('draft','published','archived')),
  source_payload text not null check(octet_length(source_payload)<=2000000),
  staged_by uuid not null references hub.profiles(id),
  staged_at timestamptz not null default now(),
  unique(source_course_id,source_revision),
  unique(source_course_id,sequence)
);
create index learning_source_snapshots_item_idx on private.learning_source_snapshots(item_id);
create index learning_source_snapshots_actor_idx on private.learning_source_snapshots(staged_by);
alter table private.learning_source_snapshots enable row level security;
revoke all on private.learning_source_snapshots from public,anon,authenticated;

create function hub.stage_learning_source(p_payload text,p_source_revision text,p_expected_revision text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare editor uuid; doc jsonb; item uuid; source_id uuid; prior private.learning_source_snapshots%rowtype;
  head private.learning_source_snapshots%rowtype; staged private.learning_source_snapshots%rowtype;
begin
  editor:=private.require_learning_editor();
  doc:=private.validate_governed_learning_source(p_payload,p_source_revision);
  source_id:=(doc->>'sourceCourseId')::uuid;
  -- The existing catalog item is the lock boundary for all imports of a source
  -- course. Concurrent first imports serialize without a second mutable head.
  select l.content_item_id into item from hub.course_links l join hub.content_items i on i.id=l.content_item_id
    where lower(l.penntrain_course_id)=source_id::text and i.kind='course' and i.source_system='penntrain'
    for update of i;
  if not found then raise exception 'Source course is not registered in the central catalog.' using errcode='22023'; end if;
  select * into head from private.learning_source_snapshots where source_course_id=source_id order by sequence desc limit 1;
  select * into prior from private.learning_source_snapshots where source_course_id=source_id and source_revision=p_source_revision;
  if found then
    -- Replaying a historical revision acknowledges it but NEVER rewinds the head.
    return jsonb_build_object('snapshotId',prior.id,'sourceRevision',prior.source_revision,
      'headRevision',head.source_revision,'sequence',prior.sequence,'replayed',true);
  end if;
  if p_expected_revision is distinct from head.source_revision then
    raise exception 'A newer source snapshot was staged. Reload the export preview before continuing.' using errcode='40001';
  end if;
  insert into private.learning_source_snapshots(item_id,source_course_id,source_version_id,source_revision,sequence,publication_state,source_payload,staged_by)
    values(item,source_id,(doc->>'sourceVersionId')::uuid,p_source_revision,coalesce(head.sequence,0)+1,doc->>'publicationState',p_payload,editor)
    returning * into staged;
  insert into private.audit_events(actor_id,action,entity_type,entity_id,metadata)
    values(editor,'learning.source.staged','content_item',item,jsonb_build_object('source_revision',p_source_revision,'sequence',staged.sequence));
  return jsonb_build_object('snapshotId',staged.id,'sourceRevision',staged.source_revision,
    'headRevision',staged.source_revision,'sequence',staged.sequence,'replayed',false);
end;
$$;

create function hub.list_learning_source_heads() returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
  perform private.require_learning_editor();
  return coalesce((select jsonb_agg(jsonb_build_object('sourceCourseId',s.source_course_id,'snapshotId',s.id,
    'sourceRevision',s.source_revision,'sequence',s.sequence,'publicationState',s.publication_state) order by s.source_course_id)
    from (select distinct on(source_course_id) * from private.learning_source_snapshots order by source_course_id,sequence desc) s),'[]'::jsonb);
end;
$$;

create function hub.get_learning_source_snapshot(p_snapshot_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
  perform private.require_learning_editor();
  select jsonb_build_object('sourceRevision',source_revision,'payload',source_payload) into result
    from private.learning_source_snapshots where id=p_snapshot_id;
  if result is null then raise exception 'Source snapshot unavailable.' using errcode='22023'; end if;
  return result;
end;
$$;
revoke all on function private.governed_learning_schema(),private.validate_governed_learning_source(text,text) from public,anon,authenticated;
revoke all on function hub.stage_learning_source(text,text,text),hub.list_learning_source_heads(),hub.get_learning_source_snapshot(uuid) from public,anon,authenticated;
grant execute on function hub.stage_learning_source(text,text,text),hub.list_learning_source_heads(),hub.get_learning_source_snapshot(uuid) to authenticated;
