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
    left(
      coalesce(
        nullif(new.raw_user_meta_data ->> 'display_name', ''),
        split_part(coalesce(new.email, 'CareMetric user'), '@', 1)
      ),
      120
    )
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

revoke all on function private.handle_new_user()
  from public, anon, authenticated;

drop trigger if exists on_auth_user_confirmed on auth.users;
