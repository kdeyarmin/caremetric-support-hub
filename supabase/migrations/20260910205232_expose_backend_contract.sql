-- Install this contract only after the frontend's required RPC fixes exist.
-- The endpoint is public release metadata; it does not read application data.
do $$
begin
  if position('''memberships''' in pg_get_functiondef('hub.get_support_actor_context()'::regprocedure)) = 0
    or position('assignee.deleted_at' in pg_get_functiondef('hub.update_support_case(uuid,hub.case_status,hub.case_priority,uuid,boolean)'::regprocedure)) = 0 then
    raise exception 'Apply actor-membership and safe-assignee migrations first';
  end if;
end;
$$;

create or replace function hub.get_backend_contract()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object('api_version', 1);
$$;

revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon, authenticated;
