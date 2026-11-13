-- The owner's own finished videos in the creative library (2026-11-13). A video the owner uploads on the Creative screen becomes approved
-- creative for each placement it fits, one per platform: the owner choosing to upload it is the approval, and the owner attests that it
-- shows no patient, resident or personal information. The Social Media Manager then uses it as it uses any approved video (a post, once per
-- placement, each post still waiting for the owner's approval). Nothing is published by the upload itself.
--
-- - creative_assets.provider gains 'owner' and creative_briefs.source gains 'upload': an upload is one brief with one asset per placement.
-- - private.creative_upload_placement: the video placements an upload may use, with their sizes and lengths (server/agents/creative/specs.mjs),
--   including the 16:9 placements for the Facebook Page and LinkedIn.
-- - private.creative_video_store: checks and stores an upload (the same request key stores once). Executable by no role.
-- - hub.add_creative_video: the owner's operation; it authorizes the owner's session itself, then stores.
set local lock_timeout = '10s';

alter table private.creative_assets drop constraint if exists creative_assets_provider_check;
alter table private.creative_assets add constraint creative_assets_provider_check check (provider in ('internal', 'heygen', 'owner'));
alter table private.creative_briefs drop constraint if exists creative_briefs_source_check;
alter table private.creative_briefs add constraint creative_briefs_source_check
  check (source in ('social.plan', 'growth.plan', 'sweep', 'owner', 'refresh', 'revision', 'data.county', 'data.release', 'observance', 'upload'));

-- Sizes in pixels and lengths in seconds, as in specs.mjs. Meta's Reels placement takes at most a minute; a stored asset at most two.
create function private.creative_upload_placement(p_placement text) returns jsonb
language sql immutable set search_path = '' as $$
  select (case p_placement
    when 'meta.video_square' then '{"platform": "meta", "width": 1080, "height": 1080, "min": 1, "max": 120}'
    when 'meta.video_portrait' then '{"platform": "meta", "width": 1080, "height": 1350, "min": 1, "max": 120}'
    when 'meta.video_vertical' then '{"platform": "meta", "width": 1080, "height": 1920, "min": 1, "max": 60}'
    when 'meta.video_landscape' then '{"platform": "meta", "width": 1920, "height": 1080, "min": 1, "max": 120}'
    when 'linkedin.video_square' then '{"platform": "linkedin", "width": 1080, "height": 1080, "min": 3, "max": 120}'
    when 'linkedin.video_portrait' then '{"platform": "linkedin", "width": 1080, "height": 1350, "min": 3, "max": 120}'
    when 'linkedin.video_vertical' then '{"platform": "linkedin", "width": 1080, "height": 1920, "min": 3, "max": 120}'
    when 'linkedin.video_landscape' then '{"platform": "linkedin", "width": 1920, "height": 1080, "min": 3, "max": 120}'
  end)::jsonb;
$$;

create function private.creative_video_store(p_actor uuid, p_product text, p_placements text[], p_label text, p_bytes bytea, p_duration numeric,
  p_width integer, p_height integer, p_attested boolean, p_request_key uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_key text;
  v_label text := btrim(coalesce(p_label, ''));
  v_brief private.creative_briefs%rowtype;
  v_placement text;
  v_spec jsonb;
  v_platforms text[];
  v_asset uuid;
  v_assets jsonb := '[]'::jsonb;
begin
  if p_product is null or p_product not in ('carebase', 'caremetric-intel') then
    raise exception 'Unknown product.' using errcode = '22023';
  end if;
  if p_request_key is null then
    raise exception 'Invalid request key.' using errcode = '22023';
  end if;
  v_key := 'upload:' || p_request_key::text;
  if p_attested is not true then
    raise exception 'Confirm that the video shows no patient, resident or personal information.' using errcode = '22023';
  end if;
  if char_length(v_label) not between 1 and 120 or v_label ~ '[[:cntrl:]]' then
    raise exception 'Name the video in at most 120 characters.' using errcode = '22023';
  end if;
  if p_bytes is null or octet_length(p_bytes) < 1024 or octet_length(p_bytes) > 62914560 or substring(p_bytes from 5 for 4) <> '\x66747970'::bytea then
    raise exception 'The video must be an MP4 file of at most 60 MB.' using errcode = '22023';
  end if;
  if p_duration is null or p_duration < 0.5 or p_duration > 120 then
    raise exception 'The video must be at most two minutes long.' using errcode = '22023';
  end if;
  if p_placements is null or cardinality(p_placements) not between 1 and 4
    or (select count(distinct item) from unnest(p_placements) item) <> cardinality(p_placements) then
    raise exception 'Choose where the video may be used.' using errcode = '22023';
  end if;
  foreach v_placement in array p_placements loop
    v_spec := private.creative_upload_placement(v_placement);
    if v_spec is null or (v_spec ->> 'width')::integer is distinct from p_width or (v_spec ->> 'height')::integer is distinct from p_height
      or p_duration < (v_spec ->> 'min')::numeric or p_duration > (v_spec ->> 'max')::numeric then
      raise exception 'The video does not fit %.', v_placement using errcode = '22023';
    end if;
  end loop;
  select array_agg(distinct private.creative_upload_placement(item) ->> 'platform') into v_platforms from unnest(p_placements) item;
  if cardinality(v_platforms) <> cardinality(p_placements) then
    raise exception 'Choose one placement per platform.' using errcode = '22023';
  end if;

  -- The same upload, sent twice, is stored once.
  select * into v_brief from private.creative_briefs where request_key = v_key;
  if found then
    return jsonb_build_object('briefId', v_brief.id, 'already', true, 'assets', coalesce((select jsonb_agg(jsonb_build_object('id', a.id,
      'platform', a.platform, 'placement', a.placement) order by a.placement) from private.creative_assets a where a.brief_id = v_brief.id), '[]'::jsonb));
  end if;

  insert into private.creative_briefs (product, goal, audience, platforms, formats, video_lengths, angle, source, status, request_key, result, created_by)
  values (p_product, v_label, 'The owner''s own finished video', v_platforms, array['video'], array[]::text[], '', 'upload', 'done', v_key,
    jsonb_build_object('uploaded', cardinality(p_placements)), p_actor)
  returning * into v_brief;
  foreach v_placement in array p_placements loop
    v_spec := private.creative_upload_placement(v_placement);
    insert into private.creative_assets (brief_id, product, platform, placement, kind, layout, width, height, duration_seconds, variant_label, hook_type,
      concept, headline, alt_text, provider, status, compliance, public_token, content_type, file_bytes, rendered_at, proposed_at, approved_at)
    values (v_brief.id, p_product, v_spec ->> 'platform', v_placement, 'video', 'screenshot', p_width, p_height, round(p_duration, 2), left(v_label, 40), 'demo',
      'The owner''s own finished video.', v_label, v_label, 'owner', 'approved',
      jsonb_build_object('verdict', 'pass', 'source', 'owner_upload', 'attested', true), private.creative_token(), 'video/mp4', octet_length(p_bytes),
      now(), now(), now())
    returning id into v_asset;
    insert into private.creative_files (product, kind, asset_id, content_type, bytes, sha256, label, phi_free_attested, created_by)
    values (p_product, 'asset', v_asset, 'video/mp4', p_bytes, encode(sha256(p_bytes), 'hex'), left(v_label, 120), true, p_actor);
    v_assets := v_assets || jsonb_build_object('id', v_asset, 'platform', v_spec ->> 'platform', 'placement', v_placement);
  end loop;
  insert into private.audit_events (actor_id, action, entity_type, metadata)
  values (p_actor, 'creative.video_upload', 'agent', jsonb_build_object('product', p_product, 'placements', to_jsonb(p_placements),
    'bytes', octet_length(p_bytes), 'seconds', round(p_duration, 1), 'attested', true));
  return jsonb_build_object('briefId', v_brief.id, 'already', false, 'assets', v_assets);
end;
$$;

-- The owner's operation: the Creative screen's "Add a finished video".
create function hub.add_creative_video(p_product text, p_placements text[], p_label text, p_bytes bytea, p_duration numeric, p_width integer,
  p_height integer, p_attested boolean, p_request_key uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_actor jsonb;
begin
  v_actor := hub.authorize_app_command();
  return private.creative_video_store((v_actor ->> 'user_id')::uuid, p_product, p_placements, p_label, p_bytes, p_duration, p_width, p_height,
    p_attested, p_request_key);
end;
$$;

revoke all on function private.creative_upload_placement(text),
  private.creative_video_store(uuid, text, text[], text, bytea, numeric, integer, integer, boolean, uuid)
  from public, anon, authenticated, service_role, hub_app_server;
revoke all on function hub.add_creative_video(text, text[], text, bytea, numeric, integer, integer, boolean, uuid) from public, anon, service_role;
grant execute on function hub.add_creative_video(text, text[], text, bytea, numeric, integer, integer, boolean, uuid) to authenticated;
