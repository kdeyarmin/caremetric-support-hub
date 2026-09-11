do $$ begin
  if to_regprocedure('hub.authorize_platform_command()') is null
    or to_regprocedure('hub.stage_learning_source(text,text,text)') is null
    or (hub.get_backend_contract()->>'api_version')::integer < 3 then
    raise exception 'Apply governed learning and command authorization before contract 4';
  end if;
end $$;
create or replace function hub.get_backend_contract()
returns jsonb language sql stable security invoker set search_path='' as $$
  select jsonb_build_object('api_version',4);
$$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon,authenticated;
