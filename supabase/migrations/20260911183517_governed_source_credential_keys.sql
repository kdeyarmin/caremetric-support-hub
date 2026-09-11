-- Preserve the deployed validator and its ACL; tighten recognized credential
-- field spellings in authored JSON without rewriting source evidence.
create or replace function private.validate_governed_learning_source(p_payload text, p_revision text) returns jsonb
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
  if document::text ~* '([?&](token|access_token|signature|sig|key|policy|jwt|auth|h|hdnts|hdnea|key-pair-id|api_key|apikey|x-amz-[a-z-]+|x-goog-[a-z-]+)=|"(access_?token|refresh_?token|service_?role_?key|authorization|password|client_?secret|storage_?(path|bucket)|video_?url|playback_?(url|token)|signed_?url|api_?key|token|secret|secret_?key|signing_?secret)"[[:space:]]*:)' then
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
