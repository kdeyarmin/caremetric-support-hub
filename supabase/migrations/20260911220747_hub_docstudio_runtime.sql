-- Hub-owned replacement for the removed EMR DocStudio feature. No historical
-- drafts, approvals, credentials, render results or native identities are seeded.
create table private.docstudio_projects (
 id uuid primary key, content_key text not null unique,
 revision integer not null check(revision between 1 and 100),
 status text not null check(status in ('draft','in_review','approved')),
 created_by uuid not null references auth.users(id),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index docstudio_projects_creator_idx on private.docstudio_projects(created_by);
create index docstudio_projects_page_idx on private.docstudio_projects(updated_at desc,id desc);
create table private.docstudio_revisions (
 project_id uuid not null references private.docstudio_projects(id), revision integer not null,
 body jsonb not null check(jsonb_typeof(body)='object' and octet_length(body::text)<=1000000),
 body_hash text not null check(body_hash ~ '^[0-9a-f]{64}$'),
 author_id uuid not null references auth.users(id), created_at timestamptz not null default now(),
 primary key(project_id,revision)
);
create index docstudio_revision_author_idx on private.docstudio_revisions(author_id);
create table private.docstudio_approvals (
 project_id uuid not null, revision integer not null, reviewer_id uuid not null references auth.users(id),
 body_hash text not null, approved_at timestamptz not null default now(),
 primary key(project_id,revision), foreign key(project_id,revision) references private.docstudio_revisions(project_id,revision)
);
create index docstudio_approval_reviewer_idx on private.docstudio_approvals(reviewer_id);
create table private.docstudio_intents (
 id uuid primary key, actor_id uuid not null references auth.users(id), request_id uuid not null,
 command jsonb not null, expires_at timestamptz not null default now()+interval '10 minutes',
 receipt jsonb, created_at timestamptz not null default now(), unique(actor_id,request_id)
);
create table private.docstudio_assets (
 id uuid primary key, project_id uuid not null references private.docstudio_projects(id),
 sha256 text not null check(sha256 ~ '^[0-9a-f]{64}$'), byte_length integer not null check(byte_length between 1 and 33554432),
 media_type text not null check(media_type in ('image/png','image/jpeg','audio/mpeg','audio/wav')),
 created_at timestamptz not null default now(), verified_at timestamptz, cleanup_at timestamptz
);
create index docstudio_assets_project_idx on private.docstudio_assets(project_id);
create index docstudio_assets_cleanup_idx on private.docstudio_assets(created_at) where cleanup_at is null;
create table private.docstudio_workers (
 id uuid primary key, source_revision text not null check(source_revision ~ '^[0-9a-f]{40}$'), seen_at timestamptz not null default now()
);
create table private.docstudio_jobs (
 id uuid primary key, project_id uuid not null, revision integer not null,
 actor_id uuid not null references auth.users(id), session_id uuid not null references private.sms_sessions(id),
 status text not null check(status in ('queued','running','completed','failed','cancelled')),
 manifest jsonb not null, attempts integer not null default 0 check(attempts between 0 and 3),
 progress integer not null default 0 check(progress between 0 and 100),
 worker_id uuid references private.docstudio_workers(id), lease_hash text, lease_expires_at timestamptz,
 media_info jsonb, created_at timestamptz not null default now(), finished_at timestamptz,
 foreign key(project_id,revision) references private.docstudio_revisions(project_id,revision)
);
create index docstudio_jobs_project_idx on private.docstudio_jobs(project_id,created_at);
create index docstudio_jobs_actor_idx on private.docstudio_jobs(actor_id);
create index docstudio_jobs_session_idx on private.docstudio_jobs(session_id);
create index docstudio_jobs_worker_idx on private.docstudio_jobs(worker_id);
create index docstudio_jobs_queue_idx on private.docstudio_jobs(created_at,id);
create unique index docstudio_jobs_active_idx on private.docstudio_jobs(project_id) where status in ('queued','running');
create table private.docstudio_outputs (
 job_id uuid not null references private.docstudio_jobs(id), attempt integer not null check(attempt between 1 and 3),
 part text not null check(part in ('primary','captions','transcript')),
 sha256 text not null check(sha256 ~ '^[0-9a-f]{64}$'), byte_length integer not null check(byte_length between 1 and 268435456),
 media_type text not null check(media_type in ('video/mp4','text/vtt','text/plain')), verified_at timestamptz, cleanup_at timestamptz,
 primary key(job_id,attempt,part)
);
create table private.docstudio_cleanup_queue (
 id uuid primary key, resource jsonb not null, path text not null unique,
 created_at timestamptz not null default now(), completed_at timestamptz
);
create table private.docstudio_media_tokens (
 token_hash text primary key check(token_hash ~ '^[0-9a-f]{64}$'),
 session_id uuid references private.sms_sessions(id), job_id uuid references private.docstudio_jobs(id),
 lease_hash text, cleanup_id uuid references private.docstudio_cleanup_queue(id), descriptor jsonb not null, expires_at timestamptz not null default now()+interval '30 seconds'
);
create index docstudio_media_session_idx on private.docstudio_media_tokens(session_id);
create index docstudio_media_job_idx on private.docstudio_media_tokens(job_id);
create index docstudio_media_expiry_idx on private.docstudio_media_tokens(expires_at);
create index docstudio_media_cleanup_idx on private.docstudio_media_tokens(cleanup_id);

do $$ declare t text; begin
 foreach t in array array['projects','revisions','approvals','intents','assets','workers','jobs','outputs','media_tokens','cleanup_queue'] loop
  execute format('alter table private.%I enable row level security','docstudio_'||t);
  execute format('revoke all on private.%I from public,anon,authenticated,service_role,hub_app_server','docstudio_'||t);
 end loop;
end $$;
create function private.docstudio_immutable() returns trigger language plpgsql set search_path='' as $$
begin raise exception 'DocStudio revisions and approvals are immutable' using errcode='P4090'; end $$;
create trigger docstudio_revision_immutable before update or delete on private.docstudio_revisions for each row execute function private.docstudio_immutable();
create trigger docstudio_approval_immutable before update or delete on private.docstudio_approvals for each row execute function private.docstudio_immutable();

create function private.docstudio_scope(p_body jsonb,p_key text) returns uuid
language sql stable security definer set search_path='' as $$
 select private.require_publication_scope(jsonb_build_object('placements',coalesce((select jsonb_agg(jsonb_build_object('product_slug',value)) from jsonb_array_elements_text(p_body->'products')),'[]'::jsonb)),p_key)
$$;
create function private.docstudio_validate(p_body jsonb) returns void
language plpgsql stable security definer set search_path='' as $$
declare s jsonb; a jsonb; n integer:=0; duration integer:=0; total bigint:=0;
begin
 if jsonb_typeof(p_body) is distinct from 'object' or octet_length(p_body::text)>1000000
  or coalesce(p_body->>'kind','') not in ('article','video') or coalesce(p_body->>'accessLevel','') not in ('public','customer','staff')
  or coalesce(p_body->>'locale','')<>'en-US' or length(coalesce(p_body->>'title','')) not between 2 and 180
  or length(coalesce(p_body->>'summary','')) not between 1 and 500
  or jsonb_typeof(p_body->'products') is distinct from 'array' or jsonb_array_length(p_body->'products') not between 1 and 6
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
  for s in select value from jsonb_array_elements(p_body->'scenes') loop
   n:=n+1;
   if (s->>'order')::integer<>n or coalesce(s->>'type','') not in ('intro','step','outro') or (s->>'durationSeconds')::integer not between 3 and 120
    or length(coalesce(s->>'title','')) not between 1 and 180 or length(coalesce(s->>'narration','')) not between 1 and 4000
    or length(coalesce(s->>'captionText','')) not between 1 and 2000
    or exists(select 1 from jsonb_object_keys(s) k where k not in ('order','type','durationSeconds','title','narration','captionText','screenshotAssetId')) then raise exception 'Invalid scene' using errcode='22023'; end if;
   duration:=duration+(s->>'durationSeconds')::integer;
   if s ? 'screenshotAssetId' and not exists(select 1 from jsonb_array_elements(p_body->'assets') x where x->>'id'=s->>'screenshotAssetId' and x->>'mediaType' in ('image/png','image/jpeg')) then raise exception 'Invalid image reference' using errcode='22023'; end if;
  end loop;
  if duration>3600 then raise exception 'Video too long' using errcode='22023'; end if;
  if p_body ? 'narrationAssetId' and not exists(select 1 from jsonb_array_elements(p_body->'assets') x where x->>'id'=p_body->>'narrationAssetId' and x->>'mediaType' in ('audio/mpeg','audio/wav')) then raise exception 'Invalid narration reference' using errcode='22023'; end if;
  if (select count(distinct value->>'id') from jsonb_array_elements(p_body->'assets'))<>jsonb_array_length(p_body->'assets') then raise exception 'Duplicate asset' using errcode='22023'; end if;
  for a in select value from jsonb_array_elements(p_body->'assets') loop
   if coalesce(a->>'sha256','') !~ '^[0-9a-f]{64}$' or coalesce(a->>'mediaType','') not in ('image/png','image/jpeg','audio/mpeg','audio/wav')
    or (a->>'byteLength')::integer not between 1 and 33554432 or (a->>'id')::uuid is null
    or exists(select 1 from jsonb_object_keys(a) k where k not in ('id','sha256','byteLength','mediaType'))
    or (not exists(select 1 from jsonb_array_elements(p_body->'scenes') s where s->>'screenshotAssetId'=a->>'id') and (p_body->>'narrationAssetId') is distinct from (a->>'id')) then raise exception 'Invalid source asset' using errcode='22023'; end if;
   total:=total+(a->>'byteLength')::integer;
  end loop;
  if total>33554432 then raise exception 'Assets too large' using errcode='P4130'; end if;
 end if;
end $$;

create function private.docstudio_project(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare p private.docstudio_projects; r private.docstudio_revisions;
begin
 select * into p from private.docstudio_projects where id=p_id;
 if p.id is null then raise exception 'Draft unavailable' using errcode='P4040'; end if;
 select * into r from private.docstudio_revisions where project_id=p_id and revision=p.revision;
 perform private.docstudio_scope(r.body,p.content_key);
 return jsonb_build_object('id',p.id,'contentKey',p.content_key,'revision',p.revision,'status',p.status,'updatedAt',p.updated_at,'kind',r.body->>'kind','title',r.body->>'title','draft',r.body,
  'approvedAt',(select approved_at from private.docstudio_approvals where project_id=p_id and revision=p.revision and p.status='approved'),
  'jobs',coalesce((select jsonb_agg(x.body order by x.created_at desc) from (select j.created_at,jsonb_build_object('id',j.id,'revision',j.revision,'status',j.status,'progress',j.progress,'attempts',j.attempts,'createdAt',j.created_at,'outputCount',(select count(*) from private.docstudio_outputs o where o.job_id=j.id and o.attempt=j.attempts and verified_at is not null)) body from private.docstudio_jobs j where j.project_id=p_id order by j.created_at desc limit 30) x),'[]'::jsonb),
  'assets',coalesce((select jsonb_agg(jsonb_build_object('id',id,'sha256',sha256,'byteLength',byte_length,'mediaType',media_type) order by created_at) from private.docstudio_assets where project_id=p_id and verified_at is not null),'[]'::jsonb));
end $$;
create function private.docstudio_can_read(p_body jsonb,p_key text) returns boolean
language plpgsql stable security definer set search_path='' as $$
begin perform private.docstudio_scope(p_body,p_key);return true;
exception when insufficient_privilege then return false;end $$;
create function private.docstudio_read(p_cursor jsonb default null) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare p record; list jsonb:='[]'; last_id uuid; last_time timestamptz; more boolean:=false;
begin
 perform private.publication_import_access();
 for p in select p.id,p.updated_at from private.docstudio_projects p join private.docstudio_revisions r on r.project_id=p.id and r.revision=p.revision
  where private.docstudio_can_read(r.body,p.content_key)
   and (p_cursor is null or (p.updated_at,p.id)<((p_cursor->>'updatedAt')::timestamptz,(p_cursor->>'id')::uuid))
  order by p.updated_at desc,p.id desc limit 101 loop
  if jsonb_array_length(list)=100 then more:=true;exit;end if;
  list:=list||jsonb_build_array(private.docstudio_project(p.id)-'draft'-'assets'-'jobs'-'approvedAt'-'contentKey');
  last_id:=p.id;last_time:=p.updated_at;
 end loop;
 return jsonb_build_object('projects',list,'nextCursor',case when more then jsonb_build_object('updatedAt',last_time,'id',last_id) else null end,'products',coalesce((select jsonb_agg(jsonb_build_object('slug',slug,'name',name) order by name) from hub.products where status<>'retired' and support_enabled and private.has_staff_permission('content.write',id)),'[]'::jsonb),
  'workerReady',exists(select 1 from private.docstudio_workers where seen_at>now()-interval '30 seconds'),
  'maxVideoBytes',least(268435456,(select max_video_bytes from private.publication_import_settings where singleton)));
end $$;

create function private.docstudio_preview(p_id uuid,p_command jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid; p private.docstudio_projects; body jsonb; old private.docstudio_intents; op text:=p_command->>'operation';
begin
 actor:=private.docstudio_scope('{"products":[]}'::jsonb,'');
 if op not in ('create','edit','submit','approve','render','cancel') or (p_command->>'requestId')::uuid is null or (p_command->>'projectId')::uuid is null then raise exception 'Invalid command' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended('docstudio-command:'||actor::text||':'||(p_command->>'requestId'),0));
 select * into old from private.docstudio_intents where actor_id=actor and request_id=(p_command->>'requestId')::uuid;
 if old.id is not null and old.command<>p_command then raise exception 'Request already used' using errcode='P4090'; end if;
 select * into p from private.docstudio_projects where id=(p_command->>'projectId')::uuid;
 if p.id is not null then
  select r.body into body from private.docstudio_revisions r where project_id=p.id and revision=p.revision;
  perform private.docstudio_scope(body,p.content_key);
 end if;
 if old.receipt is null then
  if op='create' then
   if p.id is not null or (p_command->>'expectedRevision')::integer<>0 then raise exception 'Draft already exists' using errcode='P4090'; end if;
  elsif p.id is null then raise exception 'Draft unavailable' using errcode='P4040';
  elsif p.revision<>(p_command->>'expectedRevision')::integer then raise exception 'Draft changed; review again' using errcode='P4090'; end if;
 end if;
 if op in ('create','edit') then body:=p_command->'draft'; perform private.docstudio_validate(body); perform private.docstudio_scope(body,coalesce(p.content_key,'')); end if;
 if old.id is null then
  perform pg_advisory_xact_lock(hashtextextended('docstudio-capacity',0));
  if (select count(*) from private.docstudio_intents where actor_id=actor and created_at>now()-interval '1 hour')>=300 then raise exception 'Draft operation limit reached' using errcode='P4290'; end if;
  insert into private.docstudio_intents(id,actor_id,request_id,command) values(p_id,actor,(p_command->>'requestId')::uuid,p_command) returning * into old;
 elsif old.receipt is null then update private.docstudio_intents set expires_at=now()+interval '10 minutes' where id=old.id returning * into old;
 end if;
 return jsonb_build_object('id',old.id,'requestId',old.request_id,'operation',op,'projectId',p_command->'projectId','expectedRevision',p_command->'expectedRevision','title',body->>'title','products',body->'products','expiresAt',old.expires_at);
end $$;

create function private.docstudio_apply(p_id uuid,p_request uuid,p_review boolean,p_phi boolean) returns jsonb
language plpgsql security definer set search_path='' as $$
declare i private.docstudio_intents; p private.docstudio_projects; body jsonb; next_body jsonb; actor uuid; op text; project uuid; rev integer; job uuid; manifest jsonb; v_receipt jsonb;
begin
 actor:=private.docstudio_scope('{"products":[]}'::jsonb,'');
 select * into i from private.docstudio_intents where id=p_id and actor_id=actor for update;
 if i.id is null or i.request_id<>p_request or p_review is distinct from true then raise exception 'Review required' using errcode='22023'; end if;
 op:=i.command->>'operation'; project:=(i.command->>'projectId')::uuid;
 perform pg_advisory_xact_lock(hashtextextended('docstudio-project:'||project::text,0));
 select * into p from private.docstudio_projects where id=project for update;
 if p.id is not null then select r.body into body from private.docstudio_revisions r where project_id=project and revision=p.revision; perform private.docstudio_scope(body,p.content_key); end if;
 if op in ('create','edit') then next_body:=i.command->'draft'; perform private.docstudio_scope(next_body,coalesce(p.content_key,'')); end if;
 if op='approve' and p_phi is distinct from true then raise exception 'Source safety review required' using errcode='22023'; end if;
 if i.receipt is not null then return i.receipt; end if;
 if i.expires_at<=now() then raise exception 'Review expired' using errcode='P4090'; end if;
 if op='create' then
  if p.id is not null or (i.command->>'expectedRevision')::integer<>0 then raise exception 'Draft already exists' using errcode='P4090'; end if;
  perform pg_advisory_xact_lock(hashtextextended('docstudio-project-capacity',0));
  if (select count(*) from private.docstudio_projects)>=10000 or (select count(*) from private.docstudio_projects where created_by=actor and created_at>now()-interval '1 day')>=100 then raise exception 'Draft capacity reached' using errcode='P4290'; end if;
  rev:=1;
  insert into private.docstudio_projects(id,content_key,revision,status,created_by) values(project,'hub-guide.'||replace(project::text,'-',''),rev,'draft',actor) returning * into p;
 else
  if p.id is null or p.revision<>(i.command->>'expectedRevision')::integer then raise exception 'Draft changed; review again' using errcode='P4090'; end if;
  rev:=p.revision;
 end if;
 if op in ('create','edit') then
  perform private.docstudio_validate(next_body);
  if op='edit' then
   if rev>=100 or next_body->>'kind'<>body->>'kind' then raise exception 'Draft revision or kind conflict' using errcode='P4090'; end if;
   rev:=rev+1;
  end if;
  if exists(select 1 from jsonb_array_elements(next_body->'assets') a where not exists(select 1 from private.docstudio_assets x where x.id=(a->>'id')::uuid and x.project_id=project and x.verified_at is not null and x.cleanup_at is null and x.sha256=a->>'sha256' and x.byte_length=(a->>'byteLength')::integer and x.media_type=a->>'mediaType')) then raise exception 'Asset bytes not verified' using errcode='P4090'; end if;
  insert into private.docstudio_revisions(project_id,revision,body,body_hash,author_id) values(project,rev,next_body,encode(extensions.digest(next_body::text,'sha256'),'hex'),actor);
  update private.docstudio_projects set revision=rev,status='draft',updated_at=now() where id=project;
  update private.docstudio_jobs set status='cancelled',finished_at=now(),lease_hash=null where project_id=project and status in ('queued','running');
 elsif op='submit' then
  if p.status<>'draft' then raise exception 'Draft is not awaiting submission' using errcode='P4090'; end if;
  update private.docstudio_projects set status='in_review',updated_at=now() where id=project;
 elsif op='approve' then
  if p.status<>'in_review' then raise exception 'Submit this draft for review first' using errcode='P4090'; end if;
  insert into private.docstudio_approvals(project_id,revision,reviewer_id,body_hash) select project,rev,actor,body_hash from private.docstudio_revisions where project_id=project and revision=rev;
  update private.docstudio_projects set status='approved',updated_at=now() where id=project;
 elsif op='cancel' then
  update private.docstudio_jobs set status='cancelled',finished_at=now(),lease_hash=null where project_id=project and status in ('queued','running');
  if not found then raise exception 'No active render' using errcode='P4090'; end if;
 elsif op='render' then
  if p.status<>'approved' or body->>'kind'<>'video' then raise exception 'Approve the video first' using errcode='P4090'; end if;
  if not exists(select 1 from private.docstudio_workers where seen_at>now()-interval '30 seconds') then raise exception 'Render worker unavailable' using errcode='P5030'; end if;
  if exists(select 1 from private.docstudio_jobs where project_id=project and revision=rev and status in ('queued','running','completed')) then raise exception 'This revision already has a render' using errcode='P4090'; end if;
  perform pg_advisory_xact_lock(hashtextextended('docstudio-render-capacity',0));
  if (select count(*) from private.docstudio_jobs where status in ('queued','running'))>=10 or (select count(*) from private.docstudio_jobs where created_at>now()-interval '1 day')>=100 then raise exception 'Render capacity reached' using errcode='P4290'; end if;
  job:=gen_random_uuid();
  manifest:=jsonb_build_object('protocol','caremetric.docstudio.render.v1','jobId',job,'projectId',project,'revision',rev,'engine','remotion','title',body->>'title','description',body->>'summary','scenes',body->'scenes','assets',body->'assets');
  if body ? 'narrationAssetId' then manifest:=manifest||jsonb_build_object('narrationAssetId',body->'narrationAssetId'); end if;
  insert into private.docstudio_jobs(id,project_id,revision,actor_id,session_id,status,manifest) values(job,project,rev,actor,(auth.jwt()->>'sms_session_id')::uuid,'queued',manifest);
 end if;
 v_receipt:=jsonb_build_object('intentId',i.id,'requestId',p_request,'projectId',project,'revision',rev,'operation',op,'jobId',job,'appliedAt',now());
 update private.docstudio_intents set receipt=v_receipt where id=i.id;
 return v_receipt;
end $$;

create function private.docstudio_stage_asset(p_project uuid,p_asset jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare a private.docstudio_assets;
begin
 perform private.docstudio_project(p_project);
 perform pg_advisory_xact_lock(hashtextextended('docstudio-assets:'||p_project::text,0));
 select * into a from private.docstudio_assets where id=(p_asset->>'id')::uuid;
 if a.id is not null then
  if a.cleanup_at is not null or a.project_id<>p_project or a.sha256<>p_asset->>'sha256' or a.byte_length<>(p_asset->>'byteLength')::integer or a.media_type<>p_asset->>'mediaType' then raise exception 'Asset identity already used' using errcode='P4090'; end if;
 else
  if (select count(*) from private.docstudio_assets where project_id=p_project)>=100 or coalesce((select sum(byte_length) from private.docstudio_assets where project_id=p_project),0)+(p_asset->>'byteLength')::integer>134217728 then raise exception 'Draft asset capacity reached' using errcode='P4290'; end if;
  insert into private.docstudio_assets(id,project_id,sha256,byte_length,media_type) values((p_asset->>'id')::uuid,p_project,p_asset->>'sha256',(p_asset->>'byteLength')::integer,p_asset->>'mediaType');
 end if;
 return p_asset;
end $$;

create function private.docstudio_prepare_output(p_job uuid,p_lease text,p_part text,p_sha text,p_bytes integer,p_type text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare j private.docstudio_jobs; o private.docstudio_outputs; maximum integer;
begin
 j:=private.docstudio_lease(p_job,p_lease);
 maximum:=case when p_part='primary' then least(268435456,(select max_video_bytes from private.publication_import_settings where singleton)) else 1048576 end;
 if p_bytes not between 1 and maximum or p_type is distinct from (case p_part when 'primary' then 'video/mp4' when 'captions' then 'text/vtt' when 'transcript' then 'text/plain' end) or p_sha !~ '^[0-9a-f]{64}$' then raise exception 'Invalid output declaration' using errcode='22023'; end if;
 select * into o from private.docstudio_outputs where job_id=p_job and attempt=j.attempts and part=p_part;
 if o.job_id is not null then
  if o.sha256<>p_sha or o.byte_length<>p_bytes or o.media_type<>p_type then raise exception 'Immutable output conflict' using errcode='P4090'; end if;
 else insert into private.docstudio_outputs(job_id,attempt,part,sha256,byte_length,media_type) values(p_job,j.attempts,p_part,p_sha,p_bytes,p_type);
 end if;
 return jsonb_build_object('verified',o.verified_at is not null);
end $$;

create function private.docstudio_media_descriptor(p_resource jsonb,p_operation text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare j private.docstudio_jobs; a private.docstudio_assets; o private.docstudio_outputs; p jsonb; path text; media text; sha text; bytes integer;
begin
 if p_operation not in ('upload','download') then raise exception 'Invalid media operation' using errcode='22023'; end if;
 if p_resource ? 'leaseHash' then
  j:=private.docstudio_lease((p_resource->>'jobId')::uuid,p_resource->>'leaseHash');
 elsif p_resource ? 'jobId' then
  select * into j from private.docstudio_jobs where id=(p_resource->>'jobId')::uuid;
  p:=private.docstudio_project(j.project_id);
  if p_operation<>'download' or j.status<>'completed' or j.revision<>(p->>'revision')::integer or p->>'status'<>'approved' then raise exception 'Output is not available for this revision' using errcode='P4090'; end if;
 else p:=private.docstudio_project((p_resource->>'projectId')::uuid);
 end if;
 if p_resource ? 'assetId' then
  select * into a from private.docstudio_assets where id=(p_resource->>'assetId')::uuid;
  if a.id is null or a.cleanup_at is not null or a.project_id<>coalesce(j.project_id,(p->>'id')::uuid) or (p_operation='download' and a.verified_at is null) then raise exception 'Asset unavailable' using errcode='P4040'; end if;
  if j.id is not null and (p_operation<>'download' or not exists(select 1 from jsonb_array_elements(j.manifest->'assets') x where x->>'id'=a.id::text and x->>'sha256'=a.sha256 and (x->>'byteLength')::integer=a.byte_length and x->>'mediaType'=a.media_type)) then raise exception 'Asset is not in the leased revision' using errcode='42501'; end if;
  path:='assets/'||a.project_id::text||'/'||a.id::text; media:=a.media_type; sha:=a.sha256; bytes:=a.byte_length;
 else
  select * into o from private.docstudio_outputs where job_id=j.id and attempt=j.attempts and part=p_resource->>'part';
  if o.job_id is null or o.cleanup_at is not null or (p_operation='download' and o.verified_at is null) then raise exception 'Output unavailable' using errcode='P4040'; end if;
  path:='renders/'||j.id::text||'/'||j.attempts::text||'/'||o.part; media:=o.media_type; sha:=o.sha256; bytes:=o.byte_length;
 end if;
 return jsonb_build_object('path',path,'operation',p_operation,'contentType',media,'sha256',sha,'byteLength',bytes,'maxBytes',bytes,'range',null);
end $$;
create function private.docstudio_issue_media(p_hash text,p_resource jsonb,p_operation text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare descriptor jsonb; sid uuid;
begin
 descriptor:=private.docstudio_media_descriptor(p_resource,p_operation);
 if not (p_resource ? 'leaseHash') then sid:=(auth.jwt()->>'sms_session_id')::uuid; end if;
 delete from private.docstudio_media_tokens where expires_at<=now();
 insert into private.docstudio_media_tokens(token_hash,session_id,job_id,lease_hash,descriptor) values(p_hash,sid,(p_resource->>'jobId')::uuid,p_resource->>'leaseHash',jsonb_build_object('resource',p_resource,'operation',p_operation));
 return descriptor;
end $$;
create function private.docstudio_consume_media(p_hash text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare t private.docstudio_media_tokens; actor uuid; q private.docstudio_cleanup_queue;
begin
 delete from private.docstudio_media_tokens where token_hash=p_hash and expires_at>now() returning * into t;
 if t.token_hash is null then raise exception 'Media authorization expired' using errcode='28000'; end if;
 if t.cleanup_id is not null then
  select * into q from private.docstudio_cleanup_queue where id=t.cleanup_id and completed_at is null;
  if q.id is null then raise exception 'Cleanup already completed' using errcode='P4090'; end if;
  return jsonb_build_object('operation','cleanup','paths',jsonb_build_array(q.path));
 end if;
 if t.session_id is not null then
  select user_id into actor from private.sms_sessions where id=t.session_id;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',actor,'role','authenticated','sms_session_id',t.session_id)::text,true);
 end if;
 return private.docstudio_media_descriptor(t.descriptor->'resource',t.descriptor->>'operation');
end $$;
create function private.docstudio_verify_media(p_resource jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare descriptor jsonb; j private.docstudio_jobs;
begin
 descriptor:=private.docstudio_media_descriptor(p_resource,'upload');
 if p_resource ? 'assetId' then update private.docstudio_assets set verified_at=coalesce(verified_at,now()) where id=(p_resource->>'assetId')::uuid;
 else
  j:=private.docstudio_lease((p_resource->>'jobId')::uuid,p_resource->>'leaseHash');
  update private.docstudio_outputs set verified_at=coalesce(verified_at,now()) where job_id=j.id and attempt=j.attempts and part=p_resource->>'part';
 end if;
 return jsonb_build_object('verified',true,'sha256',descriptor->>'sha256','byteLength',descriptor->'byteLength');
end $$;

create function private.docstudio_export_context(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare p jsonb; body jsonb; artifact jsonb; job private.docstudio_jobs; approved timestamptz; manifest jsonb;
begin
 p:=private.docstudio_project(p_id); body:=p->'draft';
 if p->>'status'<>'approved' then raise exception 'Approve this revision first' using errcode='P4090'; end if;
 select approved_at into approved from private.docstudio_approvals where project_id=p_id and revision=(p->>'revision')::integer;
 if approved is null then raise exception 'Saved approval missing' using errcode='P4090'; end if;
 if body->>'kind'='article' then artifact:=jsonb_build_object('sha256',encode(extensions.digest(convert_to(body->>'markdown','UTF8'),'sha256'),'hex'),'media_type','text/markdown','byte_length',octet_length(body->>'markdown'));
 else
  select * into job from private.docstudio_jobs where project_id=p_id and revision=(p->>'revision')::integer and status='completed' order by finished_at desc limit 1;
  if job.id is null or (select count(*) from private.docstudio_outputs where job_id=job.id and attempt=job.attempts and verified_at is not null)<>3 then raise exception 'Complete the real render first' using errcode='P4090'; end if;
  select jsonb_build_object('sha256',sha256,'media_type',media_type,'byte_length',byte_length,'duration_ms',job.media_info->'durationMs') into artifact from private.docstudio_outputs where job_id=job.id and attempt=job.attempts and part='primary';
  artifact:=artifact||jsonb_build_object('captions_sha256',(select sha256 from private.docstudio_outputs where job_id=job.id and attempt=job.attempts and part='captions'),'transcript_sha256',(select sha256 from private.docstudio_outputs where job_id=job.id and attempt=job.attempts and part='transcript'));
 end if;
 manifest:=jsonb_build_object('schema_version','caremetric.support-hub.publication.v1','source_system','docstudio',
  'source',jsonb_build_object('content_key',p->>'contentKey','version','docstudio-v'||(p->>'revision')),
  'content',jsonb_build_object('kind',body->>'kind','title',body->>'title','summary',body->>'summary','locale',body->>'locale','access_level',body->>'accessLevel'),
  'artifact',artifact,'governance',jsonb_build_object('review_state','approved','phi_review','passed','approved_at',approved,'policy_version','docstudio-phi-free-v1'),
  'placements',(select jsonb_agg(jsonb_build_object('product_slug',value,'audience',jsonb_build_array('all'),'route_pattern',null)) from jsonb_array_elements_text(body->'products')));
 return jsonb_build_object('projectId',p_id,'revision',p->'revision','manifest',manifest,'jobId',job.id,'markdown',case when body->>'kind'='article' then body->>'markdown' else null end);
end $$;

create table private.docstudio_exports (
 import_id uuid primary key references private.publication_imports(id), project_id uuid not null, revision integer not null,
 actor_id uuid not null references auth.users(id), request_id uuid, unique(actor_id,request_id),
 foreign key(project_id,revision) references private.docstudio_revisions(project_id,revision)
);
create index docstudio_exports_project_idx on private.docstudio_exports(project_id,revision);
alter table private.docstudio_exports enable row level security;
revoke all on private.docstudio_exports from public,anon,authenticated,service_role,hub_app_server;
create function private.docstudio_publication_guard() returns trigger
language plpgsql security definer set search_path='' as $$
declare p private.docstudio_projects; context jsonb;
begin
 -- Serialize a pending publication against edits to the same saved draft.
 select * into p from private.docstudio_projects where content_key=new.content_key for update;
 if p.id is null then return new; end if;
 if tg_op='INSERT' or (old.receipt is null and (new.plan is not null or new.receipt is not null)) then
  context:=private.docstudio_export_context(p.id);
  if new.manifest is distinct from context->'manifest' then raise exception 'DocStudio revision changed or export bytes do not match' using errcode='P4090'; end if;
 end if;
 if tg_op='INSERT' then insert into private.docstudio_exports(import_id,project_id,revision,actor_id) values(new.id,p.id,p.revision,new.actor_id); end if;
 return new;
end $$;
create trigger docstudio_publication_guard after insert or update on private.publication_imports for each row execute function private.docstudio_publication_guard();
create function private.docstudio_stage_export(p_project uuid,p_revision integer,p_request uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare context jsonb; e private.docstudio_exports; import uuid; actor uuid;
begin
 context:=private.docstudio_export_context(p_project); actor:=auth.uid();
 if (context->>'revision')::integer<>p_revision or p_request is null then raise exception 'Export revision changed' using errcode='P4090'; end if;
 perform pg_advisory_xact_lock(hashtextextended('docstudio-export:'||actor::text||':'||p_request::text,0));
 select * into e from private.docstudio_exports where actor_id=actor and request_id=p_request;
 if e.import_id is not null then
  if e.project_id<>p_project or e.revision<>p_revision then raise exception 'Export request already used' using errcode='P4090'; end if;
  import:=e.import_id;
 else
  import:=gen_random_uuid(); perform private.stage_publication_import(import,context->'manifest');
  update private.docstudio_exports set request_id=p_request where import_id=import;
 end if;
 return context||jsonb_build_object('importId',import);
end $$;

-- Worker authority is the dedicated server credential and current durable lease.
-- The original issuer's live SMS identity and product scopes are rechecked too.
create function private.docstudio_job_current(p_id uuid) returns boolean
language plpgsql security definer set search_path='' as $$
declare j private.docstudio_jobs; p private.docstudio_projects; r private.docstudio_revisions; claims text:=current_setting('request.jwt.claims',true); allowed boolean:=false;
begin
 select * into j from private.docstudio_jobs where id=p_id;
 select * into p from private.docstudio_projects where id=j.project_id;
 if j.id is null or p.revision<>j.revision or p.status<>'approved' then return false; end if;
 select * into r from private.docstudio_revisions where project_id=p.id and revision=p.revision;
 if not exists(select 1 from private.docstudio_approvals a where a.project_id=p.id and a.revision=p.revision and a.body_hash=r.body_hash) then return false; end if;
 perform set_config('request.jwt.claims',jsonb_build_object('sub',j.actor_id,'role','authenticated','sms_session_id',j.session_id)::text,true);
 begin perform private.docstudio_scope(r.body,p.content_key); allowed:=true;
 exception when insufficient_privilege or invalid_authorization_specification then allowed:=false; end;
 perform set_config('request.jwt.claims',coalesce(claims,''),true);
 return allowed;
end $$;
create function private.docstudio_lease(p_id uuid,p_hash text) returns private.docstudio_jobs
language plpgsql security definer set search_path='' as $$
declare j private.docstudio_jobs;
begin
 select * into j from private.docstudio_jobs where id=p_id for update;
 if j.status is distinct from 'running' or j.lease_hash is distinct from p_hash or j.lease_expires_at<=now() or not private.docstudio_job_current(p_id) then raise exception 'Render lease unavailable' using errcode='P4090'; end if;
 return j;
end $$;
create function private.docstudio_worker(p_operation text,p_worker uuid,p_source text,p_body jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare j private.docstudio_jobs; candidate record; matches integer;
begin
 if session_user<>'hub_app_server' or p_source !~ '^[0-9a-f]{40}$' or p_worker is null or p_operation not in ('heartbeat','claim','renew','fail','complete') then raise exception 'Invalid worker operation' using errcode='42501'; end if;
 insert into private.docstudio_workers(id,source_revision) values(p_worker,p_source) on conflict(id) do update set seen_at=now(),source_revision=excluded.source_revision;
 if p_operation='heartbeat' then return jsonb_build_object('ready',true); end if;
 if p_operation='claim' then
  if coalesce(p_body->>'leaseHash','') !~ '^[0-9a-f]{64}$' then raise exception 'Invalid lease' using errcode='22023'; end if;
  for candidate in select id from private.docstudio_jobs where status='queued' or (status='running' and lease_expires_at<=now()) order by created_at for update skip locked limit 20 loop
   if not private.docstudio_job_current(candidate.id) then
    update private.docstudio_jobs set status='cancelled',finished_at=now(),lease_hash=null where id=candidate.id;
   elsif (select attempts from private.docstudio_jobs where id=candidate.id)>=3 then
    update private.docstudio_jobs set status='failed',finished_at=now(),lease_hash=null where id=candidate.id;
   else
    update private.docstudio_jobs set status='running',worker_id=p_worker,attempts=attempts+1,progress=0,lease_hash=p_body->>'leaseHash',lease_expires_at=now()+interval '45 seconds' where id=candidate.id returning * into j;
    return jsonb_build_object('job',jsonb_build_object('manifest',j.manifest,'leaseExpiresAt',j.lease_expires_at));
   end if;
  end loop;
  return jsonb_build_object('job',null);
 end if;
 if p_operation='complete' then
  select * into j from private.docstudio_jobs where id=(p_body->>'jobId')::uuid for update;
  if j.status='completed' and j.worker_id=p_worker and j.lease_hash=p_body->>'leaseHash' and j.media_info=p_body-'jobId'-'leaseHash' and private.docstudio_job_current(j.id) then return jsonb_build_object('completed',true); end if;
 end if;
 j:=private.docstudio_lease((p_body->>'jobId')::uuid,p_body->>'leaseHash');
 if j.worker_id<>p_worker then raise exception 'Wrong worker lease' using errcode='P4090'; end if;
 if p_operation='renew' then
  if (p_body->>'progress')::integer not between 0 and 98 then raise exception 'Invalid render progress' using errcode='22023'; end if;
  update private.docstudio_jobs set lease_expires_at=now()+interval '45 seconds',progress=greatest(progress,(p_body->>'progress')::integer) where id=j.id;
  return jsonb_build_object('active',true);
 elsif p_operation='fail' then
  update private.docstudio_jobs set status='failed',finished_at=now(),lease_hash=null where id=j.id;
  return jsonb_build_object('failed',true);
 end if;
 if (p_body->>'width')::integer<>1920 or (p_body->>'height')::integer<>1080 or (p_body->>'fps')::integer<>30
  or (p_body->>'durationMs')::integer<>(select sum((value->>'durationSeconds')::integer)*1000 from jsonb_array_elements(j.manifest->'scenes'))
  or (p_body->>'hasAudio')::boolean is distinct from (j.manifest ? 'narrationAssetId') or jsonb_array_length(p_body->'artifacts')<>3 then raise exception 'Invalid encoded result' using errcode='22023'; end if;
 select count(*) into matches from private.docstudio_outputs o where o.job_id=j.id and o.attempt=j.attempts and o.verified_at is not null
  and exists(select 1 from jsonb_array_elements(p_body->'artifacts') a where a->>'kind'=o.part and a->>'sha256'=o.sha256 and (a->>'byteLength')::integer=o.byte_length and a->>'mediaType'=o.media_type);
 if matches<>3 then raise exception 'All exact output bytes must be verified first' using errcode='P4090'; end if;
 update private.docstudio_jobs set status='completed',progress=100,finished_at=now(),media_info=p_body-'jobId'-'leaseHash' where id=j.id;
 return jsonb_build_object('completed',true);
end $$;

-- New private object namespace; immutable writes go through one-use server
create function private.docstudio_issue_cleanup(p_hash text) returns uuid
language plpgsql security definer set search_path='' as $$
declare q private.docstudio_cleanup_queue; a private.docstudio_assets; output_row private.docstudio_outputs; resource jsonb; path text;
begin
 perform pg_advisory_xact_lock(hashtextextended('docstudio-cleanup',0));
 select * into q from private.docstudio_cleanup_queue where completed_at is null order by created_at limit 1;
 if q.id is null then
  select * into a from private.docstudio_assets x where x.created_at<now()-interval '1 day' and x.cleanup_at is null
   and not exists(select 1 from private.docstudio_revisions r where r.project_id=x.project_id and r.body->'assets' @> jsonb_build_array(jsonb_build_object('id',x.id))) order by x.created_at limit 1;
  if a.id is not null then
   -- Use the same project lock as draft writes. Once marked, an upload or edit
   -- cannot attach these bytes while external Storage deletion is in flight.
   if not pg_try_advisory_xact_lock(hashtextextended('docstudio-project:'||a.project_id::text,0)) then return null;end if;
   if exists(select 1 from private.docstudio_revisions r where r.project_id=a.project_id and r.body->'assets' @> jsonb_build_array(jsonb_build_object('id',a.id))) then return null;end if;
   update private.docstudio_assets set cleanup_at=now() where id=a.id;
   resource:=jsonb_build_object('assetId',a.id,'projectId',a.project_id);path:='assets/'||a.project_id::text||'/'||a.id::text;
  else
   select o.* into output_row from private.docstudio_outputs o join private.docstudio_jobs j on j.id=o.job_id where j.created_at<now()-interval '7 days' and o.cleanup_at is null
    and (j.status in ('failed','cancelled') or o.attempt<j.attempts) order by j.created_at,o.job_id,o.attempt,o.part limit 1;
   if output_row.job_id is null then return null;end if;
   update private.docstudio_outputs set cleanup_at=now() where job_id=output_row.job_id and attempt=output_row.attempt and part=output_row.part;
   resource:=jsonb_build_object('jobId',output_row.job_id,'attempt',output_row.attempt,'part',output_row.part);path:='renders/'||output_row.job_id::text||'/'||output_row.attempt::text||'/'||output_row.part;
  end if;
  insert into private.docstudio_cleanup_queue(id,resource,path) values(gen_random_uuid(),resource,path) returning * into q;
 end if;
 delete from private.docstudio_media_tokens where expires_at<=now();
 insert into private.docstudio_media_tokens(token_hash,cleanup_id,descriptor) values(p_hash,q.id,'{}'::jsonb);
 return q.id;
end $$;
create function private.docstudio_finish_cleanup(p_id uuid) returns void
language plpgsql security definer set search_path='' as $$
declare q private.docstudio_cleanup_queue;
begin
 select * into q from private.docstudio_cleanup_queue where id=p_id and completed_at is null for update;
 if q.id is null then return;end if;
 if q.resource ? 'assetId' then delete from private.docstudio_assets where id=(q.resource->>'assetId')::uuid and cleanup_at is not null;
 else delete from private.docstudio_outputs where job_id=(q.resource->>'jobId')::uuid and attempt=(q.resource->>'attempt')::integer and part=q.resource->>'part' and cleanup_at is not null;end if;
 update private.docstudio_cleanup_queue set completed_at=now() where id=q.id;
end $$;
-- New private object namespace; immutable writes go through one-use server
create function private.docstudio_worker_manifest(p_id uuid,p_lease text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare j private.docstudio_jobs;
begin j:=private.docstudio_lease(p_id,p_lease); return j.manifest; end $$;
-- New private object namespace; immutable writes go through one-use server
-- capabilities. Browsers and workers never receive service-role credentials.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values('hub-docstudio','hub-docstudio',false,268435456,array['image/png','image/jpeg','audio/mpeg','audio/wav','video/mp4','text/vtt','text/plain']);
do $$ declare fn record; begin
 for fn in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='private' and p.proname like 'docstudio_%' loop
  execute format('revoke all on function %s from public,anon,authenticated,service_role,hub_app_server',fn.signature);
 end loop;
end $$;
grant execute on function private.docstudio_read(jsonb),private.docstudio_project(uuid),private.docstudio_preview(uuid,jsonb),private.docstudio_apply(uuid,uuid,boolean,boolean),
 private.docstudio_worker(text,uuid,text,jsonb),private.docstudio_stage_asset(uuid,jsonb),private.docstudio_prepare_output(uuid,text,text,text,integer,text),
 private.docstudio_issue_media(text,jsonb,text),private.docstudio_consume_media(text),private.docstudio_verify_media(jsonb),private.docstudio_export_context(uuid),private.docstudio_stage_export(uuid,integer,uuid),private.docstudio_worker_manifest(uuid,text) to hub_app_server;
grant execute on function private.docstudio_issue_cleanup(text),private.docstudio_finish_cleanup(uuid) to hub_app_server;
