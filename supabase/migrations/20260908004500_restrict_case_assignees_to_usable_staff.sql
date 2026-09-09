-- A permission row alone must not make a deleted, banned, anonymous, or
-- unprovisioned Auth principal assignable to a support case.
create or replace function hub.update_support_case(
  p_case_id uuid,
  p_status hub.case_status default null,
  p_priority hub.case_priority default null,
  p_assigned_to uuid default null,
  p_change_assignment boolean default false
)
returns hub.support_case_queue
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_case hub.support_cases%rowtype;
  v_assignee_name text;
  v_changed text[] := array[]::text[];
  v_result hub.support_case_queue%rowtype;
begin
  if v_user_id is null then raise exception 'Authentication required' using errcode = '28000'; end if;
  select * into v_case from hub.support_cases where id = p_case_id;
  if v_case.id is null or not private.has_staff_permission('case.write', v_case.product_id) then
    raise exception 'Support case not found.' using errcode = '42501';
  end if;

  if p_change_assignment and p_assigned_to is not null then
    if not exists (
      select 1
      from private.staff_permissions permission
      join auth.users assignee on assignee.id = permission.user_id
      join hub.profiles assignee_profile on assignee_profile.id = permission.user_id
      where permission.user_id = p_assigned_to
        and permission.revoked_at is null
        and permission.permission in ('case.read', 'case.write', 'platform.admin')
        and (permission.product_id is null or permission.product_id = v_case.product_id)
        and assignee.deleted_at is null
        and (assignee.banned_until is null or assignee.banned_until <= now())
        and not coalesce(assignee.is_anonymous, false)
    ) then raise exception 'Assignee is not authorized for this product.' using errcode = '42501'; end if;
    select display_name into v_assignee_name from hub.profiles where id = p_assigned_to;
  end if;

  if p_status is not null then v_changed := array_append(v_changed, 'status'); end if;
  if p_priority is not null then v_changed := array_append(v_changed, 'priority'); end if;
  if p_change_assignment then v_changed := array_append(v_changed, 'assigned_to'); end if;

  update hub.support_cases
  set status = coalesce(p_status, status),
      priority = coalesce(p_priority, priority),
      assigned_to = case when p_change_assignment then p_assigned_to else assigned_to end,
      assigned_to_display_name = case when p_change_assignment then v_assignee_name else assigned_to_display_name end,
      resolved_at = case
        when p_status in ('resolved', 'closed') then coalesce(resolved_at, now())
        when p_status is not null then null
        else resolved_at
      end
  where id = p_case_id;

  insert into private.audit_events (actor_id, action, entity_type, entity_id, tenant_id, product_id, case_id, changed_columns)
  values (v_user_id, 'case.updated', 'support_case', p_case_id, v_case.tenant_id, v_case.product_id, p_case_id, v_changed);

  select * into v_result from hub.support_case_queue where id = p_case_id;
  return v_result;
end;
$$;

revoke all on function hub.update_support_case(uuid, hub.case_status, hub.case_priority, uuid, boolean) from public, anon;
grant execute on function hub.update_support_case(uuid, hub.case_status, hub.case_priority, uuid, boolean) to authenticated;
