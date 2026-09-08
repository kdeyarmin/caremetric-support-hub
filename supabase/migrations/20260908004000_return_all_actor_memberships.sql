-- Return every active tenant/product membership as an indivisible entitlement
-- pair. The legacy tenant fields remain as the first deterministic membership
-- for older clients, but new clients must submit one returned pair verbatim.
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
  v_memberships jsonb := '[]'::jsonb;
  v_primary_membership jsonb;
  v_has_tenant_admin boolean := false;
  v_role text;
  v_is_staff boolean;
  v_requires_aal2 boolean;
begin
  if v_user_id is null or not private.current_user_is_usable() then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  select * into v_profile from hub.profiles where id = v_user_id;
  if v_profile.id is null then raise exception 'Support profile is not provisioned' using errcode = 'P0001'; end if;

  v_is_staff := private.is_staff_principal();
  v_requires_aal2 := private.current_principal_requires_aal2();

  if not v_requires_aal2 or private.current_session_is_aal2() then
    select
      coalesce(
        jsonb_agg(
          jsonb_build_object(
            'tenant_id', membership.tenant_id,
            'tenant_name', tenant.name,
            'product_id', membership.product_id,
            'role', membership.role,
            'intake_enabled', private.is_case_intake_enabled(
              membership.tenant_id,
              membership.product_id
            )
          )
          order by membership.joined_at, membership.tenant_id, membership.product_id
        ),
        '[]'::jsonb
      ),
      coalesce(bool_or(membership.role = 'tenant_admin'), false)
    into v_memberships, v_has_tenant_admin
    from hub.tenant_product_memberships membership
    join hub.tenant_products entitlement
      on entitlement.tenant_id = membership.tenant_id
     and entitlement.product_id = membership.product_id
    join hub.tenants tenant on tenant.id = membership.tenant_id
    join hub.products product on product.id = membership.product_id
    where membership.user_id = v_user_id
      and membership.status = 'active'
      and membership.revoked_at is null
      and entitlement.status = 'active'
      and tenant.status = 'active'
      and product.status <> 'retired'
      and product.support_enabled;
  end if;

  if v_is_staff then
    v_role := private.actor_role_label(v_user_id, null);
  elsif v_has_tenant_admin then
    v_role := 'tenant_admin';
  else
    v_role := 'customer';
  end if;
  v_primary_membership := v_memberships -> 0;
  return jsonb_build_object(
    'id', v_user_id,
    'name', v_profile.display_name,
    'role', v_role,
    'tenant_id', v_primary_membership ->> 'tenant_id',
    'tenant_name', v_primary_membership ->> 'tenant_name',
    'memberships', v_memberships
  );
end;
$$;

revoke all on function hub.get_support_actor_context() from public, anon;
grant execute on function hub.get_support_actor_context() to authenticated;
