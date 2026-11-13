-- Declares platform.agents.creative-uploads.v1 once an upload can be stored as owner creative, the owner's operation authorizes the session
-- itself and is open to signed-in sessions only, and the storing helpers are executable by no role.
do $$
declare
  contract jsonb := hub.get_backend_contract();
  feature constant text := 'platform.agents.creative-uploads.v1';
  owner_op constant text := 'hub.add_creative_video(text,text[],text,bytea,numeric,integer,integer,boolean,uuid)';
  store_op constant text := 'private.creative_video_store(uuid,text,text[],text,bytea,numeric,integer,integer,boolean,uuid)';
begin
  if (contract @> '{"api_version":4,"features":["platform.agents.creative.v1","platform.agents.social-video.v1","platform.agents.creative-data.v1"]}'::jsonb) is not true then
    raise exception 'Apply the Creative Director, social video and creative data migrations first' using errcode = '55000';
  end if;
  if position('''owner''' in coalesce((select pg_get_constraintdef(oid) from pg_constraint where conrelid = 'private.creative_assets'::regclass
      and conname = 'creative_assets_provider_check'), '')) = 0
    or position('''upload''' in coalesce((select pg_get_constraintdef(oid) from pg_constraint where conrelid = 'private.creative_briefs'::regclass
      and conname = 'creative_briefs_source_check'), '')) = 0
    or position('''data.county''' in coalesce((select pg_get_constraintdef(oid) from pg_constraint where conrelid = 'private.creative_briefs'::regclass
      and conname = 'creative_briefs_source_check'), '')) = 0 then
    raise exception 'An upload must be storable as the owner''s creative' using errcode = '55000';
  end if;
  if not (select p.prosecdef and coalesce(p.proconfig @> array['search_path=""'], false) from pg_proc p where p.oid = owner_op::regprocedure)
    or position('hub.authorize_app_command()' in pg_get_functiondef(owner_op::regprocedure)) = 0
    or not has_function_privilege('authenticated', owner_op, 'execute') or has_function_privilege('anon', owner_op, 'execute') then
    raise exception 'Uploading must authorize the owner''s session itself' using errcode = '55000';
  end if;
  if exists (select 1 from unnest(array[store_op, 'private.creative_upload_placement(text)']) f
      cross join unnest(array['anon', 'authenticated', 'service_role', 'hub_app_server']) r where has_function_privilege(r, f, 'execute')) then
    raise exception 'The storing helpers must be executable by no role' using errcode = '55000';
  end if;
  if not (contract -> 'features' @> to_jsonb(array[feature])) then
    contract := jsonb_set(contract, '{features}', (contract -> 'features') || to_jsonb(array[feature]));
  end if;
  execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L',
    'select ' || quote_literal(contract::text) || '::jsonb');
end $$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon, authenticated;
