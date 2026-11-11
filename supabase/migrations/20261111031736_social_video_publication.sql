-- Durable provider state for already approved social video posts. No new agent, schedule or autonomy is enabled.
create table private.social_video_publications (
  action_id uuid primary key references private.agent_actions(id) on delete cascade,
  phase text not null check (phase in ('uploading', 'processing', 'publishing', 'published')),
  provider_id text check (char_length(provider_id) between 1 and 200),
  published_id text check (char_length(published_id) between 1 and 200),
  mutation_execution integer not null check (mutation_execution > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table private.social_video_publications enable row level security;
revoke all on private.social_video_publications from public, anon, authenticated, service_role, hub_app_server;

create function private.social_video_stage(p_action uuid, p_execution integer, p_phase text, p_provider_id text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  a private.agent_actions%rowtype;
  asset private.creative_assets%rowtype;
  v private.social_video_publications%rowtype;
begin
  perform private.require_hub_app_server();
  if p_execution is null or p_execution < 1 or p_phase is null or p_phase not in ('read','uploading','processing','publishing','published') then
    raise exception 'Invalid video transition' using errcode = '22023';
  end if;
  select * into a from private.agent_actions where id = p_action for update;
  if not found or a.kind <> 'social.post' or a.agent_key <> 'social_manager' or a.status <> 'executing' or a.executions <> p_execution then
    raise exception 'Video execution changed' using errcode = '55000';
  end if;
  if coalesce(a.input ->> 'platform','') not in ('facebook','instagram','linkedin') or coalesce(a.input ->> 'creativeAssetId','') !~ '^[0-9a-f-]{36}$' then
    raise exception 'Video asset missing' using errcode = '22023';
  end if;
  select * into asset from private.creative_assets where id = (a.input ->> 'creativeAssetId')::uuid for share;
  if not found or asset.kind <> 'video' or asset.content_type is distinct from 'video/mp4' or asset.status not in ('approved','live')
    or asset.product is distinct from a.input ->> 'product' or asset.public_token is null
    or asset.platform is distinct from (case when a.input ->> 'platform' = 'linkedin' then 'linkedin' else 'meta' end)
    or right(coalesce(a.input ->> 'videoUrl',''), 84) <> '/api/creative/a/' || asset.public_token || '.mp4' then
    raise exception 'Video asset changed' using errcode = '55000';
  end if;
  select * into v from private.social_video_publications where action_id = p_action for update;
  if p_phase = 'read' then
    if not found then return jsonb_build_object('phase','new'); end if;
  elsif p_phase = 'uploading' then
    if found then raise exception 'Upload already attempted' using errcode = '55000'; end if;
    insert into private.social_video_publications(action_id,phase,mutation_execution) values(p_action,'uploading',p_execution) returning * into v;
  elsif p_phase = 'processing' then
    if not found or v.phase <> 'uploading' or v.mutation_execution <> p_execution
      or p_provider_id is null or char_length(p_provider_id) not between 1 and 200 then
      raise exception 'Upload cannot be recorded' using errcode = '55000';
    end if;
    update private.social_video_publications set phase = 'processing', provider_id = p_provider_id, updated_at = now() where action_id = p_action returning * into v;
  elsif p_phase = 'publishing' then
    if not found or v.phase <> 'processing' then raise exception 'Publish already attempted' using errcode = '55000'; end if;
    update private.social_video_publications set phase = 'publishing', mutation_execution = p_execution, updated_at = now() where action_id = p_action returning * into v;
  elsif p_phase = 'published' then
    if not found or v.phase <> 'publishing' or v.mutation_execution <> p_execution
      or p_provider_id is null or char_length(p_provider_id) not between 1 and 200 then
      raise exception 'Publish cannot be recorded' using errcode = '55000';
    end if;
    update private.social_video_publications set phase = 'published', published_id = p_provider_id, updated_at = now() where action_id = p_action returning * into v;
  end if;
  return jsonb_build_object('phase',v.phase,'providerId',v.provider_id,'publishedId',v.published_id,'createdAt',v.created_at);
end;
$$;
revoke all on function private.social_video_stage(uuid,integer,text,text) from public, anon, authenticated, service_role;
grant execute on function private.social_video_stage(uuid,integer,text,text) to hub_app_server;
