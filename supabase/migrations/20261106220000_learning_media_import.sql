-- Bulk transfer of approved lesson videos into private Hub media (docs/MEDIA_IMPORT.md).
-- The Hub server fetches each MP4 from an allowlisted host, stores it with its captions and
-- transcript under learning/<media id>/, and stages it here. Approval still goes through
-- hub.register_learning_media, and attaching goes through hub.save_learning_draft, so the
-- existing editor, review, storage and audit checks stay authoritative. Nothing publishes.
create table private.learning_media_imports (
  item_key text primary key,
  product text not null check (product in ('pennsync','carebase')),
  course_title text not null check (char_length(btrim(course_title)) between 1 and 500),
  lesson_title text not null check (char_length(btrim(lesson_title)) between 2 and 180),
  source_record text not null check (source_record ~ '^([a-f0-9]{24}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'),
  heygen_video_id text not null check (heygen_video_id ~ '^[A-Za-z0-9_-]{6,128}$'),
  duration_seconds numeric(9,3) not null check (duration_seconds > 0 and duration_seconds <= 14400),
  mp4_url text not null check (char_length(mp4_url) <= 2048 and mp4_url ~ '^https://[^/@:?#\s]+\.[^/@:?#\s]+(/|$|\?)'),
  poster_url text check (poster_url is null or (char_length(poster_url) <= 2048 and poster_url ~ '^https://[^/@:?#\s]+\.[^/@:?#\s]+(/|$|\?)')),
  captions_file text not null check (char_length(captions_file) between 5 and 240 and lower(captions_file) like '%.vtt'),
  transcript_file text not null check (char_length(transcript_file) between 5 and 240 and lower(transcript_file) like '%.txt'),
  captions_sha256 text not null check (captions_sha256 ~ '^[a-f0-9]{64}$'),
  captions_bytes integer not null check (captions_bytes between 1 and 2000000),
  transcript_sha256 text not null check (transcript_sha256 ~ '^[a-f0-9]{64}$'),
  transcript_bytes integer not null check (transcript_bytes between 1 and 1000000),
  manifest_sha256 text not null check (manifest_sha256 ~ '^[a-f0-9]{64}$'),
  state text not null check (state in ('fetching','staged','failed','registered')),
  attempts integer not null default 1 check (attempts between 1 and 1000),
  lease_id uuid,
  lease_expires_at timestamptz,
  media_id uuid unique,
  source_sha256 text check (source_sha256 ~ '^[a-f0-9]{64}$'),
  byte_size bigint check (byte_size between 1 and 268435456),
  failure_code text check (failure_code in ('host_not_allowed','redirect_not_allowed','source_unavailable','invalid_type',
    'too_large','size_mismatch','hash_mismatch','invalid_captions','invalid_transcript','storage_unavailable','timeout')),
  created_by uuid not null references auth.users(id),
  updated_by uuid not null references auth.users(id),
  registered_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  registered_at timestamptz,
  check (item_key = product || ':' || source_record || ':' || heygen_video_id),
  check (source_record ~ '^[0-9a-f]{8}-' or product = 'pennsync'),
  check ((state = 'fetching') = (lease_id is not null and lease_expires_at is not null)),
  check ((state = 'failed') = (failure_code is not null)),
  check (state not in ('staged','registered') or (media_id is not null and source_sha256 is not null and byte_size is not null)),
  check ((state = 'registered') = (registered_at is not null and registered_by is not null))
);
create index learning_media_imports_creator_idx on private.learning_media_imports(created_by);
create index learning_media_imports_editor_idx on private.learning_media_imports(updated_by);
create index learning_media_imports_registrar_idx on private.learning_media_imports(registered_by);
alter table private.learning_media_imports enable row level security;
revoke all on private.learning_media_imports from public,anon,authenticated,service_role,hub_app_server;

-- Deterministic UUID v8, byte for byte the formula in src/imports/pennsyncCourseImport.ts.
create function private.learning_media_import_uuid(p_seed text) returns uuid
language sql immutable set search_path='' as $$
  select (substr(h,1,8)||'-'||substr(h,9,4)||'-8'||substr(h,14,3)||'-'
    ||substr('89ab89ab89ab89ab',strpos('0123456789abcdef',substr(h,17,1)),1)||substr(h,18,3)||'-'||substr(h,21,12))::uuid
  from (select encode(extensions.digest(p_seed,'sha256'),'hex') as h) digest;
$$;

-- Where a staged video belongs. A PennSync TrainingModule id names the draft lesson whose id the
-- PennSync conversion derives from it; a Hub draft item id names the draft, and the manifest
-- lesson title picks its one video lesson. Anything else is reported, never guessed.
create function private.learning_media_import_target(p_item private.learning_media_imports) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare
  v_unit_id text; v_title text; matches integer; course private.learning_courses%rowtype; unit jsonb;
  result jsonb := jsonb_build_object('itemId',null,'draftTitle',null,'unitId',null,'unitTitle',null);
begin
  if p_item.source_record ~ '^[a-f0-9]{24}$' then
    v_unit_id := private.learning_media_import_uuid('caremetric.pennsync.learning.v2:lesson:'||p_item.source_record)::text;
    select count(*) into matches from private.learning_courses c
      where exists (select 1 from jsonb_array_elements(c.draft->'units') u where u->>'id' = v_unit_id);
    if matches = 0 then return result || '{"state":"missing_draft"}'; end if;
    if matches > 1 then return result || '{"state":"ambiguous"}'; end if;
    select c.* into course from private.learning_courses c
      where exists (select 1 from jsonb_array_elements(c.draft->'units') u where u->>'id' = v_unit_id);
    select u into unit from jsonb_array_elements(course.draft->'units') u where u->>'id' = v_unit_id;
  else
    select c.* into course from private.learning_courses c where c.item_id = p_item.source_record::uuid;
    if not found then return result || '{"state":"missing_draft"}'; end if;
    v_title := lower(regexp_replace(btrim(p_item.lesson_title),'\s+',' ','g'));
    select count(*) into matches from jsonb_array_elements(course.draft->'units') u
      where u->>'type' = 'video' and lower(regexp_replace(btrim(u->>'title'),'\s+',' ','g')) = v_title;
    if matches > 1 then
      return result || jsonb_build_object('state','ambiguous','itemId',course.item_id,'draftTitle',course.draft->>'title');
    elsif matches = 1 then
      select u into unit from jsonb_array_elements(course.draft->'units') u
        where u->>'type' = 'video' and lower(regexp_replace(btrim(u->>'title'),'\s+',' ','g')) = v_title;
    else
      select count(*) into matches from jsonb_array_elements(course.draft->'units') u
        where lower(regexp_replace(btrim(u->>'title'),'\s+',' ','g')) = v_title;
      return result || jsonb_build_object('state',case when matches > 0 then 'not_video' else 'missing_lesson' end,
        'itemId',course.item_id,'draftTitle',course.draft->>'title');
    end if;
  end if;
  result := jsonb_build_object('itemId',course.item_id,'draftTitle',course.draft->>'title','unitId',unit->>'id','unitTitle',unit->>'title');
  if unit->>'type' is distinct from 'video' then return result || '{"state":"not_video"}'; end if;
  if unit->>'mediaAssetId' is null then return result || '{"state":"ready"}'; end if;
  if unit->>'mediaAssetId' = p_item.media_id::text then return result || '{"state":"attached"}'; end if;
  return result || '{"state":"occupied"}';
end;
$$;

create function private.learning_media_import_view(p_item private.learning_media_imports) returns jsonb
language sql stable security definer set search_path='' as $$
  select jsonb_build_object('itemKey',p_item.item_key,'product',p_item.product,'courseTitle',p_item.course_title,
    'lessonTitle',p_item.lesson_title,'sourceRecord',p_item.source_record,'heygenVideoId',p_item.heygen_video_id,
    'durationSeconds',p_item.duration_seconds,'mp4Url',p_item.mp4_url,'captionsFile',p_item.captions_file,
    'transcriptFile',p_item.transcript_file,'state',p_item.state,'failureCode',p_item.failure_code,'mediaId',p_item.media_id,
    'sourceSha256',p_item.source_sha256,'byteSize',p_item.byte_size,'attempts',p_item.attempts,'updatedAt',p_item.updated_at,
    'target',private.learning_media_import_target(p_item));
$$;

-- Every server entry point: the dedicated server connection, a current verified Hub SMS session, and
-- portfolio-wide shared-course editor authority: the same authority as the single-file uploader.
create function private.learning_media_import_actor() returns uuid
language plpgsql stable security definer set search_path='' as $$
begin
  perform private.require_hub_app_server();
  if not private.current_app_session_verified() then
    raise exception 'Sign in with an SMS code to continue.' using errcode='28000';
  end if;
  return private.require_learning_editor();
end;
$$;

create function private.learning_media_import_begin(p_row jsonb,p_captions_sha256 text,p_captions_bytes integer,
  p_transcript_sha256 text,p_transcript_bytes integer,p_manifest_sha256 text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid; v_key text; item private.learning_media_imports%rowtype; same boolean;
begin
  actor := private.learning_media_import_actor();
  if p_row is null or jsonb_typeof(p_row) <> 'object'
    or (select array_agg(k order by k) from jsonb_object_keys(p_row) k) is distinct from array['captionsFile','courseTitle',
      'durationSeconds','heygenVideoId','lessonTitle','mp4Url','posterUrl','product','sourceRecord','transcriptFile']
    or jsonb_typeof(p_row->'durationSeconds') <> 'number'
    or (p_row->'posterUrl' <> 'null'::jsonb and jsonb_typeof(p_row->'posterUrl') <> 'string') then
    raise exception 'Invalid media import row.' using errcode='22023';
  end if;
  v_key := (p_row->>'product')||':'||(p_row->>'sourceRecord')||':'||(p_row->>'heygenVideoId');
  insert into private.learning_media_imports(item_key,product,course_title,lesson_title,source_record,heygen_video_id,
      duration_seconds,mp4_url,poster_url,captions_file,transcript_file,captions_sha256,captions_bytes,transcript_sha256,
      transcript_bytes,manifest_sha256,state,lease_id,lease_expires_at,created_by,updated_by)
    values(v_key,p_row->>'product',btrim(p_row->>'courseTitle'),btrim(p_row->>'lessonTitle'),p_row->>'sourceRecord',
      p_row->>'heygenVideoId',(p_row->>'durationSeconds')::numeric,p_row->>'mp4Url',p_row->>'posterUrl',p_row->>'captionsFile',
      p_row->>'transcriptFile',p_captions_sha256,p_captions_bytes,p_transcript_sha256,p_transcript_bytes,p_manifest_sha256,
      'fetching',gen_random_uuid(),now()+interval '15 minutes',actor,actor)
    on conflict (item_key) do nothing
    returning * into item;
  if found then return jsonb_build_object('action','fetch','lease',item.lease_id); end if;
  select * into item from private.learning_media_imports where item_key = v_key for update;
  same := item.mp4_url = p_row->>'mp4Url' and item.captions_sha256 = p_captions_sha256
    and item.transcript_sha256 = p_transcript_sha256 and item.lesson_title = btrim(p_row->>'lessonTitle');
  -- A retry of identical content never fetches or stores twice. Approved media is immutable.
  if item.state = 'registered' then
    if not same then
      raise exception 'This video is already approved with different content. Approved media cannot be replaced.' using errcode='40001';
    end if;
    return jsonb_build_object('action','done','item',private.learning_media_import_view(item));
  end if;
  if item.state = 'staged' and same then
    return jsonb_build_object('action','done','item',private.learning_media_import_view(item));
  end if;
  if item.state = 'fetching' and item.lease_expires_at > now() then
    raise exception 'This video is already transferring. Wait for it to finish, then retry.' using errcode='40001';
  end if;
  update private.learning_media_imports set course_title=btrim(p_row->>'courseTitle'),lesson_title=btrim(p_row->>'lessonTitle'),
      duration_seconds=(p_row->>'durationSeconds')::numeric,mp4_url=p_row->>'mp4Url',poster_url=p_row->>'posterUrl',
      captions_file=p_row->>'captionsFile',transcript_file=p_row->>'transcriptFile',captions_sha256=p_captions_sha256,
      captions_bytes=p_captions_bytes,transcript_sha256=p_transcript_sha256,transcript_bytes=p_transcript_bytes,
      manifest_sha256=p_manifest_sha256,state='fetching',lease_id=gen_random_uuid(),lease_expires_at=now()+interval '15 minutes',
      attempts=attempts+1,failure_code=null,media_id=null,source_sha256=null,byte_size=null,updated_by=actor,updated_at=now()
    where item_key = v_key returning * into item;
  return jsonb_build_object('action','fetch','lease',item.lease_id);
end;
$$;

-- The media id follows the exact bytes: identical retries reuse one storage prefix, and changed
-- content gets a new prefix instead of overwriting an object (the bucket never upserts).
create function private.learning_media_import_prepare(p_item_key text,p_lease uuid,p_source_sha256 text,p_byte_size bigint) returns uuid
language plpgsql security definer set search_path='' as $$
declare item private.learning_media_imports%rowtype; v_media_id uuid;
begin
  perform private.learning_media_import_actor();
  if coalesce(p_source_sha256,'') !~ '^[a-f0-9]{64}$' or p_byte_size is null or p_byte_size not between 1 and 268435456 then
    raise exception 'Invalid source checksum.' using errcode='22023';
  end if;
  select * into item from private.learning_media_imports where item_key = p_item_key for update;
  if not found or item.state <> 'fetching' or item.lease_id is distinct from p_lease or item.lease_expires_at <= now() then
    raise exception 'This transfer is no longer current. Retry the row.' using errcode='40001';
  end if;
  v_media_id := private.learning_media_import_uuid('caremetric.hub-media-import.v1:'||item.item_key||':'||p_source_sha256
    ||':'||item.captions_sha256||':'||item.transcript_sha256);
  if exists (select 1 from private.learning_media m where m.id = v_media_id) then
    raise exception 'This media is already approved.' using errcode='40001';
  end if;
  update private.learning_media_imports set media_id=v_media_id,source_sha256=p_source_sha256,byte_size=p_byte_size,updated_at=now()
    where item_key = p_item_key;
  return v_media_id;
end;
$$;

create function private.learning_media_import_finish(p_item_key text,p_lease uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid; item private.learning_media_imports%rowtype; prefix text;
begin
  actor := private.learning_media_import_actor();
  select * into item from private.learning_media_imports where item_key = p_item_key for update;
  if not found or item.state <> 'fetching' or item.lease_id is distinct from p_lease or item.lease_expires_at <= now()
    or item.media_id is null then
    raise exception 'This transfer is no longer current. Retry the row.' using errcode='40001';
  end if;
  -- The stored objects, not the server's report, must have exactly the verified sizes.
  prefix := 'learning/'||item.media_id::text||'/';
  if (select count(*) from storage.objects o where o.bucket_id = 'hub-learning' and (
      (o.name = prefix||'video.mp4' and (o.metadata->>'size')::bigint = item.byte_size)
      or (o.name = prefix||'captions.vtt' and (o.metadata->>'size')::bigint = item.captions_bytes)
      or (o.name = prefix||'transcript.txt' and (o.metadata->>'size')::bigint = item.transcript_bytes))) <> 3 then
    raise exception 'Stored media does not match the verified files.' using errcode='22023';
  end if;
  update private.learning_media_imports set state='staged',lease_id=null,lease_expires_at=null,updated_by=actor,updated_at=now()
    where item_key = p_item_key returning * into item;
  insert into private.audit_events(actor_id,action,entity_type,entity_id,metadata)
    values(actor,'learning.media.import.staged','learning_media',item.media_id,jsonb_build_object('item_key',item.item_key,
      'source_sha256',item.source_sha256,'byte_size',item.byte_size,'manifest_sha256',item.manifest_sha256));
  return private.learning_media_import_view(item);
end;
$$;

create function private.learning_media_import_fail(p_item_key text,p_lease uuid,p_code text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid; item private.learning_media_imports%rowtype;
begin
  actor := private.learning_media_import_actor();
  select * into item from private.learning_media_imports where item_key = p_item_key for update;
  if not found then raise exception 'Import row unavailable.' using errcode='P0002'; end if;
  -- A stale attempt cannot overwrite a newer one's outcome.
  if item.state = 'fetching' and item.lease_id = p_lease then
    update private.learning_media_imports set state='failed',failure_code=p_code,lease_id=null,lease_expires_at=null,
        updated_by=actor,updated_at=now()
      where item_key = p_item_key returning * into item;
    insert into private.audit_events(actor_id,action,entity_type,entity_id,reason_code,metadata)
      values(actor,'learning.media.import.failed','learning_media',item.media_id,p_code,jsonb_build_object('item_key',item.item_key));
  end if;
  return private.learning_media_import_view(item);
end;
$$;

create function private.learning_media_import_list() returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
  perform private.learning_media_import_actor();
  return jsonb_build_object('items',coalesce((select jsonb_agg(private.learning_media_import_view(i)
    order by i.product,i.course_title,i.lesson_title,i.item_key) from private.learning_media_imports i
    where i.item_key in (select r.item_key from private.learning_media_imports r order by r.updated_at desc limit 2000)),'[]'::jsonb));
end;
$$;

-- Attaching edits only the draft's mediaAssetId, through the normal draft save: editor
-- permission, document validation, revision conflict detection. Publishing stays separate.
create function private.learning_media_import_attach_item(p_item private.learning_media_imports,p_actor uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare target jsonb; course private.learning_courses%rowtype; v_index integer;
begin
  target := private.learning_media_import_target(p_item);
  if target->>'state' <> 'ready' then return target; end if;
  -- Hold the draft, then decide from the locked row: a save that landed after the lookup above is never
  -- overwritten, and the version passed to the save is the one this decision read.
  select * into course from private.learning_courses where item_id = (target->>'itemId')::uuid for update;
  select u.idx - 1 into v_index from jsonb_array_elements(course.draft->'units') with ordinality as u(value,idx)
    where u.value->>'id' = target->>'unitId' and u.value->>'type' = 'video' and u.value->>'mediaAssetId' is null;
  if v_index is null then return private.learning_media_import_target(p_item); end if;
  perform hub.save_learning_draft(course.item_id,
    jsonb_set(course.draft,array['units',v_index::text,'mediaAssetId'],to_jsonb(p_item.media_id::text)),course.draft_version);
  insert into private.audit_events(actor_id,action,entity_type,entity_id,metadata)
    values(p_actor,'learning.media.import.attached','content_item',course.item_id,
      jsonb_build_object('media_id',p_item.media_id,'unit_id',target->>'unitId','item_key',p_item.item_key));
  return private.learning_media_import_target(p_item);
end;
$$;

create function private.learning_media_import_register(p_media_id uuid,p_reviewed boolean) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid; item private.learning_media_imports%rowtype;
begin
  actor := private.learning_media_import_actor();
  select * into item from private.learning_media_imports where media_id = p_media_id for update;
  if not found then raise exception 'Staged video unavailable.' using errcode='P0002'; end if;
  if item.state = 'registered' then
    return jsonb_build_object('item',private.learning_media_import_view(item),'replayed',true);
  end if;
  if item.state <> 'staged' then
    raise exception 'Only a staged video can be approved.' using errcode='40001';
  end if;
  -- The existing approval: reviewed flag, all three stored objects, the editor, and its audit event.
  -- The checksum is the one the server verified against the stored copy, not a browser value.
  perform hub.register_learning_media(item.media_id,item.lesson_title,item.source_sha256,p_reviewed);
  update private.learning_media_imports set state='registered',registered_by=actor,registered_at=now(),updated_by=actor,updated_at=now()
    where item_key = item.item_key returning * into item;
  insert into private.audit_events(actor_id,action,entity_type,entity_id,metadata)
    values(actor,'learning.media.import.registered','learning_media',item.media_id,jsonb_build_object('item_key',item.item_key,
      'heygen_video_id',item.heygen_video_id,'source_record',item.source_record));
  begin
    perform private.learning_media_import_attach_item(item,actor);
  exception when sqlstate '40001' or sqlstate '22023' or sqlstate 'P0002' then
    -- Approval stands; the draft changed or rejected the edit, so attach again from the list.
    null;
  end;
  return jsonb_build_object('item',private.learning_media_import_view(item),'replayed',false);
end;
$$;

create function private.learning_media_import_attach(p_media_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid; item private.learning_media_imports%rowtype; before text;
begin
  actor := private.learning_media_import_actor();
  select * into item from private.learning_media_imports where media_id = p_media_id for update;
  if not found or item.state <> 'registered' then
    raise exception 'Approve the video before attaching it.' using errcode='40001';
  end if;
  before := private.learning_media_import_target(item)->>'state';
  perform private.learning_media_import_attach_item(item,actor);
  return jsonb_build_object('item',private.learning_media_import_view(item),'replayed',before = 'attached');
end;
$$;

revoke all on function private.learning_media_import_uuid(text),
  private.learning_media_import_target(private.learning_media_imports),
  private.learning_media_import_view(private.learning_media_imports),
  private.learning_media_import_actor(),
  private.learning_media_import_attach_item(private.learning_media_imports,uuid),
  private.learning_media_import_begin(jsonb,text,integer,text,integer,text),
  private.learning_media_import_prepare(text,uuid,text,bigint),
  private.learning_media_import_finish(text,uuid),
  private.learning_media_import_fail(text,uuid,text),
  private.learning_media_import_list(),
  private.learning_media_import_register(uuid,boolean),
  private.learning_media_import_attach(uuid)
  from public,anon,authenticated,service_role,hub_app_server;
grant execute on function private.learning_media_import_begin(jsonb,text,integer,text,integer,text),
  private.learning_media_import_prepare(text,uuid,text,bigint),
  private.learning_media_import_finish(text,uuid),
  private.learning_media_import_fail(text,uuid,text),
  private.learning_media_import_list(),
  private.learning_media_import_register(uuid,boolean),
  private.learning_media_import_attach(uuid)
  to hub_app_server;
