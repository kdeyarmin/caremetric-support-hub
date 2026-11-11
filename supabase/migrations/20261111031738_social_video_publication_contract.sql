-- Only advertise video publication after the durable state and server-only fencing are installed.
do $$
declare
  contract jsonb := hub.get_backend_contract();
  feature constant text := 'platform.agents.social-video.v1';
  operation constant text := 'private.social_video_stage(uuid,integer,text,text)';
  actor text;
begin
  if not (contract -> 'features' @> '["platform.agents.social.v1","platform.agents.creative.v1","platform.agents.hardening.v1"]'::jsonb) then
    raise exception 'Apply social, creative and hardening features first' using errcode = '55000';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'private.social_video_publications'::regclass)
    or exists(select 1 from pg_policies where schemaname = 'private' and tablename = 'social_video_publications') then
    raise exception 'Video state must be private' using errcode = '55000';
  end if;
  foreach actor in array array['anon','authenticated','service_role','hub_app_server'] loop
    if has_table_privilege(actor,'private.social_video_publications','select,insert,update,delete') then
      raise exception 'Video state must not be directly accessible' using errcode = '55000';
    end if;
  end loop;
  if not (select prosecdef and coalesce(proconfig @> array['search_path=""'],false) from pg_proc where oid = operation::regprocedure)
    or has_function_privilege('anon',operation,'execute') or has_function_privilege('authenticated',operation,'execute')
    or has_function_privilege('service_role',operation,'execute') or not has_function_privilege('hub_app_server',operation,'execute')
    or position('private.require_hub_app_server()' in pg_get_functiondef(operation::regprocedure)) = 0 then
    raise exception 'Video operation must be fenced and server-only' using errcode = '55000';
  end if;
  if not (contract -> 'features' @> to_jsonb(array[feature])) then contract := jsonb_set(contract,'{features}',(contract -> 'features') || to_jsonb(array[feature])); end if;
  execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L','select ' || quote_literal(contract::text) || '::jsonb');
end $$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon, authenticated;
