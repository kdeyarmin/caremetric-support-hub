-- Password sign-in uses the existing first-party session boundary. The legacy
-- sms_sessions name and claim stay stable for native-app capabilities.
create table private.password_credentials (
  user_id uuid primary key references private.sms_identities(user_id),
  identity_version uuid not null,
  username text not null unique check (username ~ '^[a-z0-9][a-z0-9._-]{2,63}$'),
  password_hash text not null check (password_hash ~ '^scrypt\$32768\$8\$3\$[a-f0-9]{32}\$[a-f0-9]{64}$'),
  credential_version uuid not null default gen_random_uuid(),
  updated_at timestamptz not null default now()
);
create table private.password_attempts (
  id uuid primary key default gen_random_uuid(),
  username_hash text not null,
  client_hash text not null,
  created_at timestamptz not null default now()
);
create index password_attempts_created on private.password_attempts(created_at);
create index password_attempts_username_time on private.password_attempts(username_hash,created_at);
create index password_attempts_client_time on private.password_attempts(client_hash,created_at);
alter table private.password_credentials enable row level security;
alter table private.password_attempts enable row level security;
revoke all on private.password_credentials,private.password_attempts from public,anon,authenticated,service_role;
grant select,insert,update,delete on private.password_credentials,private.password_attempts to hub_app_server;
create policy password_credentials_server on private.password_credentials for all to hub_app_server using(true) with check(true);
create policy password_attempts_server on private.password_attempts for all to hub_app_server using(true) with check(true);

alter table private.sms_sessions add column auth_method text not null default 'sms' check(auth_method in ('sms','password'));
alter table private.sms_sessions add column credential_version uuid;
alter table private.sms_sessions add constraint password_session_version check(auth_method <> 'password' or credential_version is not null);

-- Internal pre-login lookup: no browser JWT can call this function. It checks
-- relational owner permission and current identity, not editable user metadata.
create function private.password_owner_is_usable(p_user uuid,p_identity uuid) returns boolean
language sql stable security definer set search_path='' as $$
  select session_user='hub_app_server' and exists (
    select 1 from private.sms_identities i
    join auth.users u on u.id=i.user_id join hub.profiles p on p.id=u.id
    where i.user_id=p_user and i.identity_version=p_identity and i.revoked_at is null
      and u.deleted_at is null and (u.banned_until is null or u.banned_until<=now())
      and not coalesce(u.is_anonymous,false)
      and exists(select 1 from private.staff_permissions sp where sp.user_id=u.id
        and sp.permission='platform.admin' and sp.product_id is null and sp.revoked_at is null)
  );
$$;
revoke all on function private.password_owner_is_usable(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function private.password_owner_is_usable(uuid,uuid) to hub_app_server;

create function private.rotate_password_credential() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  new.credential_version:=gen_random_uuid(); new.updated_at:=now();
  return new;
end;
$$;
revoke all on function private.rotate_password_credential() from public,anon,authenticated,service_role;
create trigger rotate_password_credential before insert or update on private.password_credentials
for each row execute function private.rotate_password_credential();

create function private.password_credential_changed() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  update private.sms_sessions set revoked_at=now() where user_id=new.user_id and revoked_at is null;
  insert into private.audit_events(actor_id,action,entity_type,entity_id)
    values(new.user_id,case when tg_op='INSERT' then 'auth.password.created' else 'auth.password.changed' end,'password_credential',new.user_id);
  return new;
end;
$$;
revoke all on function private.password_credential_changed() from public,anon,authenticated,service_role;
create trigger password_credential_changed after insert or update on private.password_credentials
for each row execute function private.password_credential_changed();

create or replace function private.current_app_session_verified() returns boolean
language sql stable security definer set search_path='' as $$
  select session_user='hub_app_server' and private.current_user_is_usable() and exists (
    select 1 from private.sms_sessions s join private.sms_identities i on i.user_id=s.user_id
    where s.id::text=(select auth.jwt()->>'sms_session_id') and s.user_id=(select auth.uid())
      and s.identity_version=i.identity_version and i.revoked_at is null
      and s.revoked_at is null and s.expires_at>now()
      and (s.auth_method='sms' or exists(select 1 from private.password_credentials c
        where c.user_id=s.user_id and c.identity_version=s.identity_version and c.credential_version=s.credential_version))
  );
$$;
create or replace function hub.authorize_app_admin() returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
  if not private.current_app_session_verified() or not private.has_staff_permission('platform.admin',null) then
    raise exception 'Current administrator session required.' using errcode='28000';
  end if;
  return jsonb_build_object('user_id',auth.uid(),'role','platform_admin','method',
    (select s.auth_method from private.sms_sessions s where s.id::text=(select auth.jwt()->>'sms_session_id') and s.user_id=auth.uid()));
end;
$$;
revoke all on function private.current_app_session_verified() from public,anon,authenticated,service_role;
revoke all on function hub.authorize_app_admin() from public,anon;
grant execute on function hub.authorize_app_admin() to authenticated;

-- Keep command scopes, owner checks and session freshness identical for both
-- first-party authentication methods. Legacy JWT commands still require AAL2.
create or replace function private.require_receipt_command_actor(p_actor_id uuid,p_session_id uuid) returns void
language plpgsql stable security definer set search_path='' as $$
declare actor jsonb;
begin
  if p_actor_id=(select auth.uid()) and p_session_id::text=(select auth.jwt()->>'sms_session_id')
    and private.current_app_session_verified() then
    actor:=hub.authorize_app_command();
    if actor->>'method' in ('sms','password') and actor->>'user_id'=p_actor_id::text
      and actor->>'session_id'=p_session_id::text then return; end if;
  end if;
  perform private.require_receipt_totp_actor(p_actor_id,p_session_id);
end;
$$;
create or replace function private.require_support_onboarding_actor(p_actor_id uuid,p_session_id uuid) returns void
language plpgsql stable security definer set search_path='' as $$
declare actor jsonb;
begin
  actor:=hub.authorize_app_command();
  if coalesce(actor->>'method','') not in ('sms','password') or actor->>'user_id' is distinct from p_actor_id::text
    or actor->>'session_id' is distinct from p_session_id::text then
    raise exception 'Current administrator session required.' using errcode='28000'; end if;
end;
$$;
revoke all on function private.require_receipt_command_actor(uuid,uuid),private.require_support_onboarding_actor(uuid,uuid)
  from public,anon,authenticated,service_role,hub_app_server;
