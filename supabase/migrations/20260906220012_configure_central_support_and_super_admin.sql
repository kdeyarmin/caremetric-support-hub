create or replace function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into hub.profiles (id, display_name)
  values (
    new.id,
    left(coalesce(nullif(new.raw_user_meta_data ->> 'display_name', ''), split_part(coalesce(new.email, 'CareMetric user'), '@', 1)), 120)
  )
  on conflict (id) do nothing;

  if lower(coalesce(new.email, '')) = 'kdeyarmin@comcast.net'
     and new.email_confirmed_at is not null then
    insert into private.staff_permissions (user_id, product_id, permission, granted_by)
    values (new.id, null, 'platform.admin', new.id)
    on conflict (user_id, product_id, permission)
    do update set
      revoked_at = null,
      granted_by = excluded.granted_by,
      granted_at = now();
  end if;

  return new;
end;
$$;

revoke all on function private.handle_new_user() from public, anon, authenticated;

drop trigger if exists on_auth_user_confirmed on auth.users;
create trigger on_auth_user_confirmed
after update of email_confirmed_at on auth.users
for each row
when (old.email_confirmed_at is distinct from new.email_confirmed_at and new.email_confirmed_at is not null)
execute function private.handle_new_user();

insert into hub.support_contacts (id, channel, label, value, hours, priority_order, is_active, verified_at)
values
  ('10000000-0000-4000-8000-000000000002', 'phone', 'Central support phone', '+18775212890', null, 2, true, now()),
  ('10000000-0000-4000-8000-000000000003', 'email', 'Central support email', 'support@caremetric.ai', null, 3, true, now())
on conflict (id) do update set
  product_id = null,
  tenant_id = null,
  label = excluded.label,
  value = excluded.value,
  hours = excluded.hours,
  priority_order = excluded.priority_order,
  is_active = true,
  verified_at = excluded.verified_at,
  updated_at = now();
