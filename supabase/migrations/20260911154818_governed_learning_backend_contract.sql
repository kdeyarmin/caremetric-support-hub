-- Release 3 may expose governed import UI only after its full staging API exists.
do $$
begin
  if to_regprocedure('hub.get_learning_editor_access()') is null
    or to_regprocedure('hub.authorize_platform_admin()') is null
    or to_regprocedure('hub.stage_learning_source(text,text,text)') is null
    or to_regprocedure('hub.list_learning_source_heads()') is null
    or to_regprocedure('hub.get_learning_source_snapshot(uuid)') is null
    or to_regprocedure('extensions.jsonb_matches_schema(json,jsonb)') is null
    or to_regclass('private.learning_source_snapshots') is null then
    raise exception 'Apply governed learning preservation and administrator authorization first';
  end if;
end;
$$;
create or replace function hub.get_backend_contract()
returns jsonb language sql stable security invoker set search_path=''
as $$ select jsonb_build_object('api_version',3); $$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon,authenticated;
