-- Knowledge articles for every connected application, including Healthcare
-- Advisors. DocStudio drafts and publication imports previously allowed at most
-- six product placements, matching the six products registered at the time.
-- Only those two limits change (six to seven); every other check is unchanged
-- and per-product content.write is still required for each placement.
CREATE OR REPLACE FUNCTION private.stage_publication_import(p_id uuid, p_manifest jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare actor uuid; key text:=p_manifest#>>'{source,content_key}'; snapshot jsonb; maximum integer; part text;
begin
  if octet_length(p_manifest::text)>70000 or p_manifest->>'schema_version'<>'caremetric.support-hub.publication.v1'
    or p_manifest->>'source_system'<>'docstudio' or coalesce(p_manifest#>>'{source,version}','') !~ '^docstudio-v[1-9][0-9]{0,14}$'
    or coalesce(p_manifest#>>'{content,kind}','') not in ('article','video') or coalesce(p_manifest#>>'{content,access_level}','') not in ('public','customer','staff')
    or jsonb_typeof(p_manifest->'placements') is distinct from 'array' or jsonb_array_length(p_manifest->'placements')>7
    or coalesce(p_manifest#>>'{artifact,byte_length}','') !~ '^[1-9][0-9]{0,8}$'
    or coalesce(p_manifest#>>'{artifact,sha256}','') !~ '^[0-9a-f]{64}$'
    or coalesce(p_manifest#>>'{governance,review_state}','')<>'approved' or coalesce(p_manifest#>>'{governance,phi_review}','')<>'passed' then
    raise exception 'Invalid publication manifest.' using errcode='22023';
  end if;
  actor:=private.require_publication_scope(p_manifest,key);
  perform pg_advisory_xact_lock(hashtextextended('publication_import_limits',0));
  if (select count(*) from private.publication_imports where receipt is null and expires_at>now())>=12
    or (select count(*) from private.publication_imports where actor_id=actor and receipt is null and expires_at>now())>=3
    or (select count(*) from private.publication_imports where created_at>now()-interval '1 hour')>=100 then
    raise exception 'Publication import limit reached.' using errcode='P4290';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('publication:'||key,0));
  snapshot:=private.publication_snapshot(key,p_manifest#>>'{source,version}');
  if snapshot is null and jsonb_array_length(p_manifest->'placements')=0 then raise exception 'New content requires a product.' using errcode='22023'; end if;
  if exists(select 1 from hub.content_items where content_key=key and (kind::text<>p_manifest#>>'{content,kind}' or default_locale<>p_manifest#>>'{content,locale}')) then
    raise exception 'A stable content key cannot change kind or locale.' using errcode='P4090';
  end if;
  maximum:=case when p_manifest#>>'{content,kind}'='video' then (select max_video_bytes from private.publication_import_settings where singleton) else 2097152 end;
  if (p_manifest#>>'{artifact,byte_length}')::integer>maximum then raise exception 'Publication exceeds storage limit.' using errcode='P4130'; end if;
  if p_manifest#>>'{content,kind}'='video' and ((p_manifest#>>'{artifact,duration_ms}')::numeric>2147483647) then raise exception 'Video duration exceeds catalog limit.' using errcode='22023'; end if;
  insert into private.publication_imports(id,actor_id,content_key,manifest,base_snapshot,base_fingerprint) values(p_id,actor,key,p_manifest,snapshot,private.publication_catalog_fingerprint(key));
  insert into private.publication_import_assets(import_id,part,expected_sha256,expected_bytes,max_bytes,content_type)
    values(p_id,'primary',p_manifest#>>'{artifact,sha256}',(p_manifest#>>'{artifact,byte_length}')::integer,maximum,p_manifest#>>'{artifact,media_type}');
  foreach part in array array['captions','transcript'] loop
    if p_manifest->'artifact' ? (part||'_sha256') then
      insert into private.publication_import_assets(import_id,part,expected_sha256,max_bytes,content_type)
        values(p_id,part,p_manifest->'artifact'->>(part||'_sha256'),10485760,case when part='captions' then 'text/vtt' else 'text/plain' end);
    end if;
  end loop;
end;
$function$;

CREATE OR REPLACE FUNCTION private.docstudio_validate(p_body jsonb)
 RETURNS void
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_scene jsonb; v_asset jsonb; n integer:=0; duration integer:=0; total bigint:=0;
begin
 if jsonb_typeof(p_body) is distinct from 'object' or octet_length(p_body::text)>1000000
  or coalesce(p_body->>'kind','') not in ('article','video') or coalesce(p_body->>'accessLevel','') not in ('public','customer','staff')
  or coalesce(p_body->>'locale','')<>'en-US' or length(coalesce(p_body->>'title','')) not between 2 and 180
  or length(coalesce(p_body->>'summary','')) not between 1 and 500
  or jsonb_typeof(p_body->'products') is distinct from 'array' or jsonb_array_length(p_body->'products') not between 1 and 7
  or jsonb_typeof(p_body->'assets') is distinct from 'array' or jsonb_array_length(p_body->'assets')>40
  or jsonb_typeof(p_body->'scenes') is distinct from 'array' or jsonb_array_length(p_body->'scenes')>120
  or jsonb_typeof(p_body->'markdown') is distinct from 'string' or length(p_body->>'markdown')>120000
  or exists(select 1 from jsonb_object_keys(p_body) k where k not in ('kind','title','summary','locale','accessLevel','products','markdown','scenes','assets','narrationAssetId')) then
  raise exception 'Invalid DocStudio draft' using errcode='22023'; end if;
 if (select count(distinct value) from jsonb_array_elements_text(p_body->'products'))<>jsonb_array_length(p_body->'products') then raise exception 'Duplicate products' using errcode='22023'; end if;
 if p_body->>'kind'='article' then
  if length(trim(p_body->>'markdown'))=0 or jsonb_array_length(p_body->'scenes')<>0 or jsonb_array_length(p_body->'assets')<>0 or p_body ? 'narrationAssetId' then raise exception 'Invalid article' using errcode='22023'; end if;
 else
  if p_body->>'markdown'<>'' or jsonb_array_length(p_body->'scenes')=0 then raise exception 'Invalid video' using errcode='22023'; end if;
  for v_scene in select value from jsonb_array_elements(p_body->'scenes') loop
   n:=n+1;
   if (v_scene->>'order')::integer<>n or coalesce(v_scene->>'type','') not in ('intro','step','outro') or (v_scene->>'durationSeconds')::integer not between 3 and 120
    or length(coalesce(v_scene->>'title','')) not between 1 and 180 or length(coalesce(v_scene->>'narration','')) not between 1 and 4000
    or length(coalesce(v_scene->>'captionText','')) not between 1 and 2000
    or exists(select 1 from jsonb_object_keys(v_scene) k where k not in ('order','type','durationSeconds','title','narration','captionText','screenshotAssetId')) then raise exception 'Invalid scene' using errcode='22023'; end if;
   duration:=duration+(v_scene->>'durationSeconds')::integer;
   if v_scene ? 'screenshotAssetId' and not exists(select 1 from jsonb_array_elements(p_body->'assets') x where x->>'id'=v_scene->>'screenshotAssetId' and x->>'mediaType' in ('image/png','image/jpeg')) then raise exception 'Invalid image reference' using errcode='22023'; end if;
  end loop;
  if duration>3600 then raise exception 'Video too long' using errcode='22023'; end if;
  if p_body ? 'narrationAssetId' and not exists(select 1 from jsonb_array_elements(p_body->'assets') x where x->>'id'=p_body->>'narrationAssetId' and x->>'mediaType' in ('audio/mpeg','audio/wav')) then raise exception 'Invalid narration reference' using errcode='22023'; end if;
  if (select count(distinct value->>'id') from jsonb_array_elements(p_body->'assets'))<>jsonb_array_length(p_body->'assets') then raise exception 'Duplicate asset' using errcode='22023'; end if;
  for v_asset in select value from jsonb_array_elements(p_body->'assets') loop
   if coalesce(v_asset->>'sha256','') !~ '^[0-9a-f]{64}$' or coalesce(v_asset->>'mediaType','') not in ('image/png','image/jpeg','audio/mpeg','audio/wav')
    or (v_asset->>'byteLength')::integer not between 1 and 33554432 or (v_asset->>'id')::uuid is null
    or exists(select 1 from jsonb_object_keys(v_asset) k where k not in ('id','sha256','byteLength','mediaType'))
    or (not exists(select 1 from jsonb_array_elements(p_body->'scenes') scene_ref where scene_ref->>'screenshotAssetId'=v_asset->>'id') and (p_body->>'narrationAssetId') is distinct from (v_asset->>'id')) then raise exception 'Invalid source asset' using errcode='22023'; end if;
   total:=total+(v_asset->>'byteLength')::integer;
  end loop;
  if total>33554432 then raise exception 'Assets too large' using errcode='P4130'; end if;
 end if;
end $function$;
