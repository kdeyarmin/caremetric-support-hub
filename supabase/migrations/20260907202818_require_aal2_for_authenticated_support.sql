-- Require a verified second factor before a staff principal can exercise any
-- staff or tenant-member path. Ordinary customers continue to use their
-- authenticated membership at AAL1; users who opt into MFA are challenged by
-- the application. Public help and owner-approved contacts remain anonymous.

create or replace function private.current_session_is_aal2()
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce((select auth.jwt() ->> 'aal'), 'aal1') = 'aal2';
$$;

create or replace function private.is_staff_principal()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null
    and exists (
      select 1
      from private.staff_permissions permission
      where permission.user_id = (select auth.uid())
        and permission.revoked_at is null
    );
$$;

create or replace function private.current_principal_requires_aal2()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.is_staff_principal()
    or exists (
      select 1
      from auth.mfa_factors factor
      where factor.user_id = (select auth.uid())
        and factor.factor_type = 'totp'
        and factor.status = 'verified'
    );
$$;

revoke all on function private.current_session_is_aal2() from public, anon, authenticated;
revoke all on function private.is_staff_principal() from public, anon, authenticated;
revoke all on function private.current_principal_requires_aal2() from public, anon, authenticated;

create or replace function private.has_staff_permission(
  p_permission private.staff_permission,
  p_product_id uuid default null
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.current_session_is_aal2()
    and (select auth.uid()) is not null
    and exists (
      select 1
      from private.staff_permissions sp
      where sp.user_id = (select auth.uid())
        and sp.revoked_at is null
        and (sp.permission = p_permission or sp.permission = 'platform.admin')
        and (sp.product_id is null or sp.product_id = p_product_id)
    );
$$;

create or replace function private.is_support_staff()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.current_session_is_aal2()
    and (select auth.uid()) is not null
    and exists (
      select 1
      from private.staff_permissions permission
      where permission.user_id = (select auth.uid())
        and permission.revoked_at is null
        and permission.permission in (
          'case.read',
          'case.write',
          'content.read',
          'content.write',
          'sla.manage',
          'tenant.manage',
          'audit.read',
          'platform.admin'
        )
    );
$$;

create or replace function private.is_active_member(
  p_tenant_id uuid,
  p_product_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null
    and (not private.current_principal_requires_aal2() or private.current_session_is_aal2())
    and exists (
      select 1
      from hub.tenant_product_memberships membership
      join hub.tenant_products entitlement
        on entitlement.tenant_id = membership.tenant_id
       and entitlement.product_id = membership.product_id
      join hub.tenants tenant on tenant.id = membership.tenant_id
      join hub.products product on product.id = membership.product_id
      where membership.user_id = (select auth.uid())
        and membership.tenant_id = p_tenant_id
        and membership.product_id = p_product_id
        and membership.status = 'active'
        and membership.revoked_at is null
        and entitlement.status = 'active'
        and tenant.status = 'active'
        and product.status <> 'retired'
        and product.support_enabled
    );
$$;

create or replace function private.can_read_membership_row(
  p_tenant_id uuid,
  p_product_id uuid,
  p_target_user_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null
    and (not private.current_principal_requires_aal2() or private.current_session_is_aal2())
    and (
      p_target_user_id = (select auth.uid())
      or (
        private.is_active_member(p_tenant_id, p_product_id)
        and exists (
          select 1
          from hub.tenant_product_memberships self_membership
          where self_membership.tenant_id = p_tenant_id
            and self_membership.product_id = p_product_id
            and self_membership.user_id = (select auth.uid())
            and self_membership.role = 'tenant_admin'
            and self_membership.can_manage_members
            and self_membership.status = 'active'
            and self_membership.revoked_at is null
        )
      )
      or private.has_staff_permission('tenant.manage', p_product_id)
    );
$$;

create or replace function private.actor_role_label(
  p_user_id uuid,
  p_product_id uuid default null
)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when exists (
      select 1 from private.staff_permissions sp
      where sp.user_id = p_user_id
        and sp.permission = 'platform.admin'
        and sp.revoked_at is null
    ) then 'platform_admin'
    when exists (
      select 1 from private.staff_permissions sp
      where sp.user_id = p_user_id
        and sp.permission in ('content.write', 'sla.manage', 'tenant.manage')
        and sp.revoked_at is null
        and (p_product_id is null or sp.product_id is null or sp.product_id = p_product_id)
    ) then 'support_manager'
    when exists (
      select 1 from private.staff_permissions sp
      where sp.user_id = p_user_id
        and sp.permission in ('case.read', 'case.write', 'content.read', 'audit.read')
        and sp.revoked_at is null
        and (p_product_id is null or sp.product_id is null or sp.product_id = p_product_id)
    ) then 'support_agent'
    when exists (
      select 1 from hub.tenant_product_memberships membership
      where membership.user_id = p_user_id
        and membership.product_id = p_product_id
        and membership.role = 'tenant_admin'
        and membership.status = 'active'
        and membership.revoked_at is null
    ) then 'tenant_admin'
    else 'customer'
end;
$$;

-- Keep the role bootstrap callable at AAL1 so staff can reach enrollment, but
-- do not disclose a dual-role staff member's customer organization until the
-- second factor has been verified. Ordinary customers still receive their
-- active tenant context at AAL1.
create or replace function hub.get_support_actor_context()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_profile hub.profiles%rowtype;
  v_membership hub.tenant_product_memberships%rowtype;
  v_tenant_name text;
  v_role text;
  v_is_staff boolean;
  v_requires_aal2 boolean;
begin
  if v_user_id is null then raise exception 'Authentication required' using errcode = '28000'; end if;
  select * into v_profile from hub.profiles where id = v_user_id;
  if v_profile.id is null then raise exception 'Support profile is not provisioned' using errcode = 'P0001'; end if;

  v_is_staff := private.is_staff_principal();
  v_requires_aal2 := private.current_principal_requires_aal2();

  if not v_requires_aal2 or private.current_session_is_aal2() then
    select * into v_membership
    from hub.tenant_product_memberships
    where user_id = v_user_id and status = 'active' and revoked_at is null
    order by joined_at
    limit 1;

    if v_membership.tenant_id is not null then
      select name into v_tenant_name from hub.tenants where id = v_membership.tenant_id;
    end if;
  end if;

  if v_is_staff then
    v_role := private.actor_role_label(v_user_id, null);
  else
    v_role := private.actor_role_label(v_user_id, v_membership.product_id);
  end if;
  return jsonb_build_object(
    'id', v_user_id,
    'name', v_profile.display_name,
    'role', v_role,
    'tenant_id', v_membership.tenant_id,
    'tenant_name', v_tenant_name
  );
end;
$$;

create or replace function private.has_active_content_audience(
  p_product_id uuid,
  p_audience text[]
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null
    and (not private.current_principal_requires_aal2() or private.current_session_is_aal2())
    and exists (
      select 1
      from hub.tenant_product_memberships membership
      join hub.tenant_products entitlement
        on entitlement.tenant_id = membership.tenant_id
       and entitlement.product_id = membership.product_id
      join hub.tenants tenant on tenant.id = membership.tenant_id
      join hub.products product on product.id = membership.product_id
      where membership.user_id = (select auth.uid())
        and membership.product_id = p_product_id
        and membership.status = 'active'
        and membership.revoked_at is null
        and entitlement.status = 'active'
        and tenant.status = 'active'
        and product.status <> 'retired'
        and product.support_enabled
        and (
          'all' = any(coalesce(p_audience, array[]::text[]))
          or (
            membership.role = 'tenant_admin'
            and coalesce(p_audience, array[]::text[]) && array['customer-admin', 'manager']::text[]
          )
          or (
            membership.role = 'customer'
            and 'customer' = any(coalesce(p_audience, array[]::text[]))
          )
        )
    );
$$;

notify pgrst, 'reload schema';
