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

revoke all on function private.can_read_membership_row(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function private.can_read_membership_row(uuid, uuid, uuid)
  to authenticated;

drop policy if exists memberships_self_or_admin_read
  on hub.tenant_product_memberships;

create policy memberships_self_or_admin_read
on hub.tenant_product_memberships
for select
to authenticated
using (
  private.can_read_membership_row(tenant_id, product_id, user_id)
);
