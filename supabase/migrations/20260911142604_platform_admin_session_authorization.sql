-- Delegated app reads require a current Hub session and portfolio-wide authority.
-- No email, role claim, or application-supplied tenant identifier grants access.
create or replace function hub.authorize_platform_admin()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_session_text text := (select auth.jwt() ->> 'session_id');
begin
  if v_user_id is null or not private.current_user_is_usable()
    or v_session_text is null
    or v_session_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'Current administrator session required.' using errcode = '28000';
  end if;

  if not private.current_session_is_aal2() or not exists (
    select 1 from auth.sessions session
    join auth.mfa_factors factor
      on factor.id = session.factor_id and factor.user_id = session.user_id
    where session.id = v_session_text::uuid and session.user_id = v_user_id
      and session.aal = 'aal2' and session.oauth_client_id is null
      and (session.not_after is null or session.not_after > now())
      and factor.factor_type = 'totp' and factor.status = 'verified'
  ) then
    raise exception 'Current administrator session required.' using errcode = '28000';
  end if;

  if not exists (select 1 from hub.profiles where id = v_user_id)
    or not exists (
      select 1 from private.staff_permissions permission
      where permission.user_id = v_user_id and permission.permission = 'platform.admin'
        and permission.product_id is null and permission.revoked_at is null
    ) then
    raise exception 'Portfolio administrator permission required.' using errcode = '42501';
  end if;

  return jsonb_build_object('user_id', v_user_id, 'role', 'platform_admin', 'aal', 'aal2');
end;
$$;

revoke all on function hub.authorize_platform_admin() from public, anon;
grant execute on function hub.authorize_platform_admin() to authenticated;

-- The frontend now requires both the central learning runtime and delegated auth.
do $$
begin
  if to_regprocedure('hub.get_learning_editor_access()') is null
    or to_regprocedure('hub.list_learning_catalog()') is null
    or to_regprocedure('hub.authorize_platform_admin()') is null then
    raise exception 'Apply central learning and administrator authorization first';
  end if;
end;
$$;

create or replace function hub.get_backend_contract()
returns jsonb language sql stable security invoker set search_path = ''
as $$ select jsonb_build_object('api_version', 2); $$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon, authenticated;
