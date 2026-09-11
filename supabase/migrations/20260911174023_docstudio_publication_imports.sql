-- DocStudio knowledge publications use the existing catalog and access policy.
-- Only the application server can attest checked bytes or execute a commit.
create table private.publication_import_settings (
  singleton boolean primary key default true check(singleton),
  max_video_bytes integer not null default 26214400 check(max_video_bytes between 1048576 and 536870912)
);
insert into private.publication_import_settings(singleton) values(true);
create table private.publication_imports (
  id uuid primary key,
  actor_id uuid not null references auth.users(id),
  content_key text not null check(length(content_key) between 3 and 120 and content_key ~ '^[a-z0-9]+([.-][a-z0-9]+)*$'),
  manifest jsonb not null check(jsonb_typeof(manifest)='object' and octet_length(manifest::text)<=70000),
  base_snapshot jsonb,
  base_fingerprint text not null check(base_fingerprint ~ '^[0-9a-f]{64}$'),
  plan jsonb check(plan is null or (jsonb_typeof(plan)='object' and octet_length(plan::text)<=50000)),
  idempotency_key uuid unique,
  commit_request jsonb,
  receipt jsonb,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now()+interval '30 minutes',
  check(expires_at>created_at and expires_at<=created_at+interval '1 hour'),
  check((receipt is null and idempotency_key is null and commit_request is null) or (receipt is not null and idempotency_key is not null and commit_request is not null))
);
create index publication_import_actor_idx on private.publication_imports(actor_id,created_at);
create index publication_import_expiry_idx on private.publication_imports(expires_at) where receipt is null;
create table private.publication_import_assets (
  import_id uuid not null references private.publication_imports(id) on delete cascade,
  part text not null check(part in ('primary','captions','transcript')),
  expected_sha256 text not null check(expected_sha256 ~ '^[0-9a-f]{64}$'),
  expected_bytes integer check(expected_bytes>0),
  max_bytes integer not null check(max_bytes between 1 and 536870912),
  content_type text not null check(content_type in ('text/markdown','video/mp4','text/vtt','text/plain')),
  byte_length integer,
  verified_at timestamptz,
  revision_id uuid references hub.content_revisions(id) on delete restrict,
  body_text text check(body_text is null or octet_length(body_text)<=2097152),
  primary key(import_id,part),
  check((verified_at is null and byte_length is null and revision_id is null and body_text is null) or (verified_at is not null and byte_length>0 and byte_length<=max_bytes)),
  check(expected_bytes is null or byte_length is null or expected_bytes=byte_length),
  check(body_text is null or (part='primary' and content_type='text/markdown'))
);
create index publication_import_asset_revision_idx on private.publication_import_assets(revision_id) where revision_id is not null;
create table private.publication_revision_provenance (
  revision_id uuid primary key references hub.content_revisions(id) on delete restrict,
  item_id uuid not null references hub.content_items(id) on delete restrict,
  revision_no integer not null check(revision_no between 1 and 100),
  source_version text not null check(source_version ~ '^docstudio-v[1-9][0-9]{0,14}$'),
  revision_identity text not null check(revision_identity ~ '^sha256:[0-9a-f]{64}$'),
  artifact_identity text not null check(artifact_identity ~ '^sha256:[0-9a-f]{64}$'),
  manifest jsonb not null,
  import_id uuid not null references private.publication_imports(id) on delete restrict,
  unique(item_id,revision_no), unique(item_id,source_version)
);
create index publication_revision_import_idx on private.publication_revision_provenance(import_id);
create table private.publication_cleanup_tokens (
  token_hash text primary key check(token_hash ~ '^[0-9a-f]{64}$'),
  import_id uuid not null references private.publication_imports(id) on delete cascade,
  expires_at timestamptz not null,
  consumed_at timestamptz
);
create index publication_cleanup_import_idx on private.publication_cleanup_tokens(import_id);
alter table private.publication_import_settings enable row level security;
alter table private.publication_imports enable row level security;
alter table private.publication_import_assets enable row level security;
alter table private.publication_revision_provenance enable row level security;
alter table private.publication_cleanup_tokens enable row level security;
revoke all on private.publication_import_settings,private.publication_imports,private.publication_import_assets,private.publication_revision_provenance,private.publication_cleanup_tokens from public,anon,authenticated,hub_app_server;

create function private.require_publication_scope(p_manifest jsonb,p_key text) returns uuid
language plpgsql stable security definer set search_path='' as $$
declare v_slug text; product uuid;
begin
  if not private.current_app_session_verified() then raise exception 'Current application session required.' using errcode='28000'; end if;
  if not exists(select 1 from private.staff_permissions where user_id=auth.uid() and revoked_at is null and permission in ('content.write','platform.admin')) then
    raise exception 'Content editor permission required.' using errcode='42501';
  end if;
  for v_slug in select distinct value->>'product_slug' from jsonb_array_elements(p_manifest->'placements') loop
    select id into product from hub.products where products.slug=v_slug and status<>'retired' and support_enabled;
    if product is null or not private.has_staff_permission('content.write',product) then raise exception 'Product editor permission required.' using errcode='42501'; end if;
  end loop;
  -- Removed and replaced products must also remain within the editor's scope.
  for product in select p.product_id from hub.content_publications p join hub.content_items i on i.id=p.item_id where i.content_key=p_key loop
    if not private.has_staff_permission('content.write',product) then raise exception 'Existing product editor permission required.' using errcode='42501'; end if;
  end loop;
  return auth.uid();
end;
$$;

create function private.publication_snapshot(p_key text,p_version text) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare item hub.content_items%rowtype; latest text; revisions jsonb;
begin
  select * into item from hub.content_items where content_key=p_key;
  if item.id is null then return null; end if;
  if item.source_system<>'docstudio' or not exists(select 1 from private.publication_revision_provenance where item_id=item.id)
    or exists(select 1 from hub.content_revisions r where r.item_id=item.id and not exists(select 1 from private.publication_revision_provenance p where p.revision_id=r.id)) then
    raise exception 'This catalog key is owned by another workflow.' using errcode='P4090';
  end if;
  select source_version into latest from private.publication_revision_provenance where item_id=item.id order by revision_no desc limit 1;
  if p_version<>latest and substring(p_version from 12)::bigint<=substring(latest from 12)::bigint then
    raise exception 'Approve a higher source version.' using errcode='P4090';
  end if;
  select jsonb_agg(jsonb_build_object(
    'revision',p.revision_no,'sourceVersion',p.source_version,'revisionIdentity',p.revision_identity,'artifactIdentity',p.artifact_identity,
    'state',case when item.status='published' and exists(select 1 from hub.content_publications a where a.revision_id=p.revision_id and (a.expires_at is null or a.expires_at>now())) then 'published' else 'retired' end,
    'placements',coalesce((select jsonb_agg(jsonb_build_object('product_slug',prod.slug,'audience',cp.audience,'route_pattern',cp.route_pattern,
      'state',case when cp.expires_at is null or cp.expires_at>now() then 'active' else 'retired' end) order by prod.slug)
      from hub.content_publications cp join hub.products prod on prod.id=cp.product_id where cp.revision_id=p.revision_id),'[]'::jsonb)
  ) order by p.revision_no) into revisions from private.publication_revision_provenance p where p.item_id=item.id;
  return jsonb_build_object('contentKey',p_key,'approvedNextSourceVersion',case when p_version=latest then null else p_version end,'revisions',revisions);
end;
$$;

create function private.publication_import_access() returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
  perform private.require_publication_scope('{"placements":[]}'::jsonb,'');
  return jsonb_build_object('canImport',true,'maxVideoBytes',(select max_video_bytes from private.publication_import_settings where singleton));
end;
$$;
create function private.publication_catalog_fingerprint(p_key text) returns text
language sql stable security definer set search_path='' as $$
  select encode(extensions.digest(jsonb_build_object(
    'item',(select to_jsonb(i) from hub.content_items i where i.content_key=p_key),
    'revisions',(select jsonb_agg(encode(extensions.digest(to_jsonb(r)::text,'sha256'),'hex') order by r.id) from hub.content_revisions r join hub.content_items i on i.id=r.item_id where i.content_key=p_key),
    'publications',(select jsonb_agg(to_jsonb(p) order by p.id) from hub.content_publications p join hub.content_items i on i.id=p.item_id where i.content_key=p_key),
    'media',(select jsonb_agg(to_jsonb(m) order by m.id) from hub.media_assets m join hub.content_items i on i.id=m.content_item_id where i.content_key=p_key)
  )::text,'sha256'),'hex');
$$;
create function private.stage_publication_import(p_id uuid,p_manifest jsonb) returns void
language plpgsql security definer set search_path='' as $$
declare actor uuid; key text:=p_manifest#>>'{source,content_key}'; snapshot jsonb; maximum integer; part text;
begin
  if octet_length(p_manifest::text)>70000 or p_manifest->>'schema_version'<>'caremetric.support-hub.publication.v1'
    or p_manifest->>'source_system'<>'docstudio' or coalesce(p_manifest#>>'{source,version}','') !~ '^docstudio-v[1-9][0-9]{0,14}$'
    or coalesce(p_manifest#>>'{content,kind}','') not in ('article','video') or coalesce(p_manifest#>>'{content,access_level}','') not in ('public','customer','staff')
    or jsonb_typeof(p_manifest->'placements') is distinct from 'array' or jsonb_array_length(p_manifest->'placements')>6
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
$$;

create function private.require_publication_import(p_id uuid,p_allow_committed boolean default false) returns private.publication_imports
language plpgsql stable security definer set search_path='' as $$
declare intent private.publication_imports;
begin
  select * into intent from private.publication_imports where id=p_id;
  if intent.id is null or intent.actor_id is distinct from auth.uid() or (intent.receipt is null and intent.expires_at<=now()) then raise exception 'Import unavailable.' using errcode='P4040'; end if;
  perform private.require_publication_scope(intent.manifest,intent.content_key);
  if intent.receipt is not null and not p_allow_committed then raise exception 'Import already committed.' using errcode='P4090'; end if;
  return intent;
end;
$$;
create function private.get_publication_import(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare intent private.publication_imports;
begin
  intent:=private.require_publication_import(p_id);
  return jsonb_build_object('id',intent.id,'expiresAt',intent.expires_at,'manifest',intent.manifest,'plan',intent.plan,
    'uploadedParts',coalesce((select jsonb_agg(part order by part) from private.publication_import_assets where import_id=p_id and verified_at is not null),'[]'::jsonb));
end;
$$;
create function private.get_publication_import_context(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare intent private.publication_imports;
begin
  intent:=private.require_publication_import(p_id);
  if private.publication_catalog_fingerprint(intent.content_key)<>intent.base_fingerprint or private.publication_snapshot(intent.content_key,intent.manifest#>>'{source,version}') is distinct from intent.base_snapshot then raise exception 'Stale publication preview.' using errcode='P4090'; end if;
  return jsonb_build_object('manifest',intent.manifest,'existing',intent.base_snapshot,'assets',
    (select jsonb_agg(jsonb_build_object('part',part,'sha256',expected_sha256,'byteLength',byte_length,'verified',verified_at is not null) order by part) from private.publication_import_assets where import_id=p_id));
end;
$$;
create function private.verify_publication_asset(p_id uuid,p_part text,p_sha256 text,p_bytes integer,p_text text) returns void
language plpgsql security definer set search_path='' as $$
declare asset private.publication_import_assets;
begin
  perform 1 from private.publication_imports where id=p_id for update;
  perform private.require_publication_import(p_id);
  select * into asset from private.publication_import_assets where import_id=p_id and part=p_part for update;
  if asset.part is null or asset.expected_sha256<>p_sha256 or p_bytes<=0 or p_bytes>asset.max_bytes
    or (asset.expected_bytes is not null and asset.expected_bytes<>p_bytes)
    or ((asset.content_type='text/markdown') is distinct from (p_text is not null))
    or (p_text is not null and (octet_length(p_text)<>p_bytes or encode(extensions.digest(convert_to(p_text,'UTF8'),'sha256'),'hex')<>p_sha256)) then
    raise exception 'Asset verification failed.' using errcode='22023';
  end if;
  if asset.verified_at is not null then
    if asset.byte_length<>p_bytes or asset.body_text is distinct from p_text then raise exception 'Verified asset is immutable.' using errcode='P4090'; end if;
    return;
  end if;
  update private.publication_import_assets set byte_length=p_bytes,verified_at=clock_timestamp(),body_text=p_text where import_id=p_id and part=p_part;
end;
$$;
create function private.store_publication_preview(p_id uuid,p_plan jsonb) returns void
language plpgsql security definer set search_path='' as $$
declare intent private.publication_imports;
begin
  perform 1 from private.publication_imports where id=p_id for update;
  intent:=private.require_publication_import(p_id);
  if private.publication_catalog_fingerprint(intent.content_key)<>intent.base_fingerprint or private.publication_snapshot(intent.content_key,intent.manifest#>>'{source,version}') is distinct from intent.base_snapshot then raise exception 'Stale publication preview.' using errcode='P4090'; end if;
  if exists(select 1 from private.publication_import_assets where import_id=p_id and verified_at is null)
    or p_plan->>'contentKey'<>intent.content_key or p_plan->>'mode'<>'preview'
    or p_plan->>'schemaVersion'<>'caremetric.support-hub.import-plan.v1'
    or coalesce(p_plan->>'planIdentity','') !~ '^sha256:[0-9a-f]{64}$'
    or coalesce(p_plan->>'revisionIdentity','') !~ '^sha256:[0-9a-f]{64}$'
    or p_plan->>'artifactIdentity'<>'sha256:'||(intent.manifest#>>'{artifact,sha256}') then raise exception 'Invalid verified plan.' using errcode='22023'; end if;
  if intent.plan is not null and intent.plan<>p_plan then raise exception 'Preview is immutable.' using errcode='P4090'; end if;
  update private.publication_imports set plan=p_plan where id=p_id;
end;
$$;

create function private.commit_publication_import(p_id uuid,p_request jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare intent private.publication_imports; key uuid; expected jsonb; supplied jsonb; item uuid; revision uuid; v_revision_no integer;
  previous_no integer; place jsonb; product uuid; primary_asset private.publication_import_assets; outcome text; v_receipt jsonb;
begin
  -- Current identity/scope is checked even for an idempotent replay.
  intent:=private.require_publication_import(p_id,true);
  if (select array_agg(k order by k) from jsonb_object_keys(p_request) k) is distinct from array['confirmedActions','idempotencyKey','planIdentity','reviewConfirmed']::text[] then raise exception 'Invalid commit fields.' using errcode='22023'; end if;
  key:=(p_request->>'idempotencyKey')::uuid;
  perform pg_advisory_xact_lock(hashtextextended('publication_commit:'||key::text,0));
  perform pg_advisory_xact_lock(hashtextextended('publication:'||intent.content_key,0));
  select * into intent from private.publication_imports where id=p_id for update;
  perform private.require_publication_import(p_id,true);
  if intent.receipt is not null then
    if intent.idempotency_key=key and intent.commit_request=p_request then return intent.receipt; end if;
    raise exception 'Idempotency key or request changed.' using errcode='P4090';
  end if;
  if exists(select 1 from private.publication_imports where idempotency_key=key) then raise exception 'Idempotency key was already used.' using errcode='P4090'; end if;
  if intent.plan is null or p_request->>'planIdentity' is distinct from intent.plan->>'planIdentity' or p_request->'reviewConfirmed' is distinct from 'true'::jsonb
    or jsonb_typeof(p_request->'confirmedActions') is distinct from 'array' then raise exception 'Exact reviewed plan required.' using errcode='22023'; end if;
  select coalesce(jsonb_agg((position-1)::text||':'||(action->>'type') order by (position-1)::text||':'||(action->>'type')),'[]'::jsonb) into expected
    from jsonb_array_elements(intent.plan->'actions') with ordinality actions(action,position) where action->'requiresExplicitApproval'='true'::jsonb;
  select coalesce(jsonb_agg(value order by value),'[]'::jsonb) into supplied from jsonb_array_elements_text(p_request->'confirmedActions');
  if expected<>supplied then raise exception 'Every replacement and retirement requires confirmation.' using errcode='22023'; end if;
  if private.publication_catalog_fingerprint(intent.content_key)<>intent.base_fingerprint or private.publication_snapshot(intent.content_key,intent.manifest#>>'{source,version}') is distinct from intent.base_snapshot then raise exception 'Stale publication preview.' using errcode='P4090'; end if;
  if exists(select 1 from private.publication_import_assets where import_id=p_id and verified_at is null) then raise exception 'Verify every asset before publishing.' using errcode='22023'; end if;
  select id into item from hub.content_items where content_key=intent.content_key;
  select coalesce(max(p.revision_no),0) into previous_no from private.publication_revision_provenance p where p.item_id=item;
  v_revision_no:=(intent.plan->>'targetRevision')::integer;
  if v_revision_no not between 1 and 100 or v_revision_no not in (previous_no,previous_no+1) then raise exception 'Invalid next revision.' using errcode='22023'; end if;
  if item is null then
    insert into hub.content_items(content_key,kind,status,access_level,default_locale,source_system,created_by)
      values(intent.content_key,(intent.manifest#>>'{content,kind}')::hub.content_kind,'draft',(intent.manifest#>>'{content,access_level}')::hub.access_level,intent.manifest#>>'{content,locale}','docstudio',auth.uid()) returning id into item;
  end if;
  if v_revision_no=previous_no then
    select p.revision_id into revision from private.publication_revision_provenance p where p.item_id=item and p.revision_no=v_revision_no and p.revision_identity=intent.plan->>'revisionIdentity';
    if revision is null then raise exception 'Existing revision is immutable.' using errcode='P4090'; end if;
  else
    select * into primary_asset from private.publication_import_assets where import_id=p_id and part='primary';
    insert into hub.content_revisions(item_id,revision_no,locale,title,summary,body_markdown,body_text,source_hash,source_version,review_state,created_by,approved_by,approved_at)
      values(item,v_revision_no,intent.manifest#>>'{content,locale}',intent.manifest#>>'{content,title}',intent.manifest#>>'{content,summary}',primary_asset.body_text,primary_asset.body_text,
        intent.plan->>'revisionIdentity',intent.manifest#>>'{source,version}','approved',auth.uid(),auth.uid(),clock_timestamp()) returning id into revision;
    insert into private.publication_revision_provenance(revision_id,item_id,revision_no,source_version,revision_identity,artifact_identity,manifest,import_id)
      values(revision,item,v_revision_no,intent.manifest#>>'{source,version}',intent.plan->>'revisionIdentity',intent.plan->>'artifactIdentity',intent.manifest,p_id);
    update private.publication_import_assets set revision_id=revision where import_id=p_id;
    if intent.manifest#>>'{content,kind}'='video' then
      insert into hub.media_assets(content_item_id,revision_id,renderer,storage_provider,storage_key,mime_type,sha256,duration_ms,caption_storage_key,transcript_storage_key,render_status,data_classification,access_level,input_hash,published_at)
        values(item,revision,'docstudio','supabase','publications/'||p_id||'/primary','video/mp4',primary_asset.expected_sha256,(intent.manifest#>>'{artifact,duration_ms}')::integer,
          case when intent.manifest->'artifact' ? 'captions_sha256' then 'publications/'||p_id||'/captions' end,
          case when intent.manifest->'artifact' ? 'transcript_sha256' then 'publications/'||p_id||'/transcript' end,
          'ready','none',(intent.manifest#>>'{content,access_level}')::hub.access_level,intent.plan->>'revisionIdentity',clock_timestamp());
    end if;
  end if;
  outcome:=case when intent.plan->'actions' @> '[{"type":"no_op"}]'::jsonb then 'unchanged' when jsonb_array_length(intent.manifest->'placements')=0 then 'retired' else 'published' end;
  if outcome<>'unchanged' then
    update hub.content_publications cp set expires_at=clock_timestamp() where cp.item_id=item and (cp.expires_at is null or cp.expires_at>now())
      and not exists(select 1 from jsonb_array_elements(intent.manifest->'placements') a join hub.products p on p.slug=a->>'product_slug' where p.id=cp.product_id);
    for place in select value from jsonb_array_elements(intent.manifest->'placements') loop
      select id into product from hub.products where slug=place->>'product_slug';
      insert into hub.content_publications(item_id,revision_id,product_id,audience,route_pattern,published_by,published_at)
        values(item,revision,product,array(select jsonb_array_elements_text(place->'audience')),place->>'route_pattern',auth.uid(),clock_timestamp())
        on conflict(item_id,product_id) do update set revision_id=excluded.revision_id,audience=excluded.audience,route_pattern=excluded.route_pattern,published_by=excluded.published_by,published_at=excluded.published_at,expires_at=null;
    end loop;
    update hub.content_items set status=case when outcome='retired' then 'retired'::hub.content_status else 'published'::hub.content_status end,
      access_level=(intent.manifest#>>'{content,access_level}')::hub.access_level,retired_at=case when outcome='retired' then clock_timestamp() end,updated_at=clock_timestamp() where id=item;
  end if;
  v_receipt:=jsonb_build_object('importId',p_id,'itemId',item,'revisionId',revision,'revision',v_revision_no,'planIdentity',intent.plan->>'planIdentity','committedAt',clock_timestamp(),'outcome',outcome);
  update private.publication_imports set idempotency_key=key,commit_request=p_request,receipt=v_receipt where id=p_id;
  insert into private.audit_events(actor_id,action,entity_type,entity_id,changed_columns,metadata)
    values(auth.uid(),'publication.import_committed','content_revision',revision,array['content','placements'],jsonb_build_object('import_id',p_id,'revision',v_revision_no,'outcome',outcome,'plan_identity',intent.plan->>'planIdentity'));
  return v_receipt;
end;
$$;

create function private.publication_object(p_id uuid,p_part text,p_operation text) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare asset private.publication_import_assets; intent private.publication_imports;
begin
  if not private.current_app_session_verified() then raise exception 'Current application session required.' using errcode='28000'; end if;
  if p_operation='upload' then
    intent:=private.require_publication_import(p_id);
    select * into asset from private.publication_import_assets where import_id=p_id and part=p_part and verified_at is null;
  elsif p_operation='download' then
    select * into asset from private.publication_import_assets where revision_id=p_id and part=p_part and verified_at is not null;
    if asset.import_id is not null and not exists(select 1 from hub.content_publications p
      where p.revision_id=p_id and p.published_at<=now() and (p.expires_at is null or p.expires_at>now())
        and private.can_access_content_publication(p.item_id,p.revision_id,p.product_id)) then
      raise exception 'Publication access denied.' using errcode='42501';
    end if;
  else raise exception 'Unsupported publication operation.' using errcode='22023'; end if;
  if asset.import_id is null then raise exception 'Publication asset unavailable.' using errcode='P4040'; end if;
  return jsonb_build_object('path','publications/'||asset.import_id||'/'||asset.part,'operation',p_operation,'contentType',asset.content_type,
    'sha256',asset.expected_sha256,'byteLength',case when p_operation='download' then asset.byte_length else asset.expected_bytes end,'maxBytes',asset.max_bytes);
end;
$$;

create function private.publication_media_info(p_revision uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare asset jsonb;
begin
  asset:=private.publication_object(p_revision,'primary','download');
  return jsonb_build_object('contentType',asset->>'contentType',
    'hasCaptions',exists(select 1 from private.publication_import_assets where revision_id=p_revision and part='captions'),
    'hasTranscript',exists(select 1 from private.publication_import_assets where revision_id=p_revision and part='transcript'));
end;
$$;

-- Cleanup authority comes only from a short-lived one-use server maintenance
-- ticket naming an expired intent whose objects are not attached to a revision.
create function private.issue_publication_cleanup(p_hash text) returns uuid
language plpgsql security definer set search_path='' as $$
declare intent uuid;
begin
  if session_user<>'hub_app_server' then raise exception 'Server maintenance required.' using errcode='42501'; end if;
  delete from private.publication_cleanup_tokens where expires_at<=now();
  select i.id into intent from private.publication_imports i where i.expires_at<now()
    and not exists(select 1 from private.publication_import_assets a where a.import_id=i.id and a.revision_id is not null)
    and not exists(select 1 from private.publication_cleanup_tokens t where t.import_id=i.id and t.expires_at>now())
    and exists(select 1 from private.publication_import_assets a where a.import_id=i.id)
    order by i.expires_at limit 1 for update skip locked;
  if intent is null then return null; end if;
  insert into private.publication_cleanup_tokens(token_hash,import_id,expires_at) values(p_hash,intent,now()+interval '5 minutes');
  return intent;
end;
$$;
create function private.consume_publication_cleanup(p_hash text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare intent uuid; paths jsonb;
begin
  if session_user<>'hub_app_server' then raise exception 'Server maintenance required.' using errcode='42501'; end if;
  update private.publication_cleanup_tokens t set consumed_at=now() where t.token_hash=p_hash and t.expires_at>now() and t.consumed_at is null
    and exists(select 1 from private.publication_imports i where i.id=t.import_id and i.expires_at<now())
    and not exists(select 1 from private.publication_import_assets a where a.import_id=t.import_id and a.revision_id is not null)
    returning import_id into intent;
  if intent is null then raise exception 'Cleanup ticket unavailable.' using errcode='28000'; end if;
  select jsonb_agg('publications/'||intent||'/'||part order by part) into paths from private.publication_import_assets where import_id=intent;
  return jsonb_build_object('operation','cleanup','paths',paths);
end;
$$;
create function private.finish_publication_cleanup(p_id uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
  if session_user<>'hub_app_server' then raise exception 'Server maintenance required.' using errcode='42501'; end if;
  if not exists(select 1 from private.publication_cleanup_tokens where import_id=p_id and consumed_at is not null and expires_at>now()) then raise exception 'Cleanup ticket required.' using errcode='42501'; end if;
  delete from private.publication_import_assets where import_id=p_id and revision_id is null;
  -- Keep commit receipts permanently, even when an unchanged import used no bytes.
  delete from private.publication_imports where id=p_id and receipt is null and expires_at<now()
    and not exists(select 1 from private.publication_import_assets where import_id=p_id);
end;
$$;

create function private.protect_publication_revision() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if tg_table_schema='private' then
    raise exception 'Published DocStudio revision is immutable.' using errcode='42501';
  end if;
  if exists(select 1 from private.publication_revision_provenance where revision_id=old.id) then
    raise exception 'Published DocStudio revision is immutable.' using errcode='42501';
  end if;
  return case when tg_op='DELETE' then old else new end;
end;
$$;
create trigger publication_provenance_immutable before update or delete on private.publication_revision_provenance for each row execute function private.protect_publication_revision();
create trigger publication_revision_immutable before update or delete on hub.content_revisions for each row execute function private.protect_publication_revision();

create function private.protect_publication_asset() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if tg_op='DELETE' then
    if old.revision_id is not null then raise exception 'Published asset is immutable.' using errcode='42501'; end if;
    return old;
  end if;
  if old.verified_at is not null and (new.import_id<>old.import_id or new.part<>old.part or new.expected_sha256<>old.expected_sha256
    or new.expected_bytes is distinct from old.expected_bytes or new.max_bytes<>old.max_bytes or new.content_type<>old.content_type
    or new.byte_length is distinct from old.byte_length or new.body_text is distinct from old.body_text or new.verified_at is distinct from old.verified_at
    or (old.revision_id is not null and new.revision_id is distinct from old.revision_id)) then
    raise exception 'Verified asset is immutable.' using errcode='42501';
  end if;
  return new;
end;
$$;
create trigger publication_asset_immutable before update or delete on private.publication_import_assets for each row execute function private.protect_publication_asset();
create function private.lock_publication_change() returns trigger
language plpgsql security definer set search_path='' as $$
declare item uuid; content_key text;
begin
  item:=case when tg_op='DELETE' then old.item_id else new.item_id end;
  select i.content_key into content_key from hub.content_items i where i.id=item;
  if exists(select 1 from private.publication_revision_provenance where item_id=item) then
    perform pg_advisory_xact_lock(hashtextextended('publication:'||content_key,0));
  end if;
  return case when tg_op='DELETE' then old else new end;
end;
$$;
create trigger publication_change_lock before insert or update or delete on hub.content_publications for each row execute function private.lock_publication_change();

-- Storage remains private. No browser INSERT/UPDATE/DELETE policy is granted;
-- the fixed Edge transport uses its own credential after consuming a capability.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
  values('hub-publications','hub-publications',false,536870912,array['text/markdown','video/mp4','text/vtt','text/plain'])
  on conflict(id) do nothing;
alter table private.app_delegations drop constraint app_delegations_audience_check;
alter table private.app_delegations add constraint app_delegations_audience_check check(audience in ('carebase','media','breathe','caremetric-emr','pennsync','carebase.command','carebase.learning','publication'));

-- Helpers are not generic RPCs. The connection role invokes them only after
-- installing the current app session's claims; each function rechecks authority.
revoke all on function private.require_publication_scope(jsonb,text),private.publication_snapshot(text,text),private.publication_import_access(),private.stage_publication_import(uuid,jsonb),
  private.require_publication_import(uuid,boolean),private.get_publication_import(uuid),private.get_publication_import_context(uuid),private.verify_publication_asset(uuid,text,text,integer,text),
  private.store_publication_preview(uuid,jsonb),private.commit_publication_import(uuid,jsonb),private.publication_object(uuid,text,text),private.publication_media_info(uuid),private.issue_publication_cleanup(text),
  private.consume_publication_cleanup(text),private.finish_publication_cleanup(uuid),private.protect_publication_revision(),private.protect_publication_asset(),private.lock_publication_change(),private.publication_catalog_fingerprint(text) from public,anon,authenticated;
grant execute on function private.publication_import_access(),private.stage_publication_import(uuid,jsonb),private.get_publication_import(uuid),private.get_publication_import_context(uuid),
  private.verify_publication_asset(uuid,text,text,integer,text),private.store_publication_preview(uuid,jsonb),private.commit_publication_import(uuid,jsonb),private.publication_object(uuid,text,text),private.publication_media_info(uuid),
  private.issue_publication_cleanup(text),private.consume_publication_cleanup(text),private.finish_publication_cleanup(uuid) to hub_app_server;
