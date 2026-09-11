-- First-party SMS sessions. Telnyx verifies the code; the Hub owns the session.
-- Supabase Auth rows remain identity references, not the SMS verification service.
do $$ begin
  if not exists(select 1 from pg_roles where rolname='hub_app_server') then
    create role hub_app_server nologin noinherit nosuperuser nocreatedb nocreaterole nobypassrls;
  end if;
end $$;
grant authenticated, anon to hub_app_server;
grant usage on schema private, hub to hub_app_server;

create table private.sms_identities (
  user_id uuid primary key references auth.users(id),
  phone_e164 text not null unique check(phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  identity_version uuid not null default gen_random_uuid(),
  verified_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create table private.sms_challenges (
  id uuid primary key,
  user_id uuid references private.sms_identities(user_id),
  identity_version uuid,
  phone_hash text not null,
  client_hash text not null,
  browser_hash text not null,
  provider_id uuid,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now()+interval '5 minutes',
  attempts integer not null default 0 check(attempts between 0 and 5),
  consumed_at timestamptz
);
create index sms_challenge_phone_time on private.sms_challenges(phone_hash,created_at);
create index sms_challenge_client_time on private.sms_challenges(client_hash,created_at);
create index sms_challenge_user on private.sms_challenges(user_id);
create table private.sms_sessions (
  id uuid primary key,
  token_hash text not null unique,
  user_id uuid not null references private.sms_identities(user_id),
  identity_version uuid not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz
);
create index sms_sessions_user on private.sms_sessions(user_id);
create table private.app_delegations (
  token_hash text primary key,
  session_id uuid not null references private.sms_sessions(id),
  audience text not null check(audience in ('carebase','media')),
  payload jsonb not null,
  expires_at timestamptz not null,
  consumed_at timestamptz
);
create index app_delegations_session on private.app_delegations(session_id);

-- Changing or disabling a registered number invalidates every old challenge and session.
create function private.rotate_sms_identity() returns trigger
language plpgsql set search_path='' as $$
begin
  if new.phone_e164 is distinct from old.phone_e164 or new.revoked_at is distinct from old.revoked_at then
    new.identity_version:=gen_random_uuid(); new.verified_at:=null;
  end if;
  return new;
end;
$$;
revoke all on function private.rotate_sms_identity() from public,anon,authenticated;
create trigger rotate_sms_identity before update on private.sms_identities
for each row execute function private.rotate_sms_identity();

alter table private.sms_identities enable row level security;
alter table private.sms_challenges enable row level security;
alter table private.sms_sessions enable row level security;
alter table private.app_delegations enable row level security;
revoke all on private.sms_identities,private.sms_challenges,private.sms_sessions,private.app_delegations from public,anon,authenticated;
grant select on private.sms_identities to hub_app_server;
grant update(verified_at) on private.sms_identities to hub_app_server;
grant select,insert,update,delete on private.sms_challenges,private.sms_sessions,private.app_delegations to hub_app_server;
create policy sms_identity_server on private.sms_identities for select to hub_app_server using(true);
create policy sms_identity_verify on private.sms_identities for update to hub_app_server using(true) with check(true);
create policy sms_challenge_server on private.sms_challenges for all to hub_app_server using(true) with check(true);
create policy sms_session_server on private.sms_sessions for all to hub_app_server using(true) with check(true);
create policy app_delegation_server on private.app_delegations for all to hub_app_server using(true) with check(true);

create function private.current_app_session_verified() returns boolean
language sql stable security definer set search_path='' as $$
  select session_user='hub_app_server' and private.current_user_is_usable() and exists (
    select 1 from private.sms_sessions s join private.sms_identities i on i.user_id=s.user_id
    where s.id::text=(select auth.jwt()->>'sms_session_id') and s.user_id=(select auth.uid())
      and s.identity_version=i.identity_version and i.revoked_at is null
      and s.revoked_at is null and s.expires_at>now()
  );
$$;
create function private.current_session_is_verified() returns boolean
language sql stable security definer set search_path='' as $$
  select private.current_app_session_verified() or private.current_session_is_aal2();
$$;
revoke all on function private.current_app_session_verified(),private.current_session_is_verified() from public,anon,authenticated;

-- Preserve existing role/tenant checks while accepting the app-owned verified
-- session at every protected RPC. Legacy AAL2 checks keep their original meaning.
do $$ declare fn record; definition text;
begin
  for fn in
    select p.oid from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname in ('private','hub') and p.prokind='f'
      and p.proname not in ('current_session_is_aal2','current_session_is_verified','authorize_platform_admin')
      and p.prosrc like '%private.current_session_is_aal2()%'
  loop
    definition := replace(pg_get_functiondef(fn.oid),'private.current_session_is_aal2()','private.current_session_is_verified()');
    execute definition;
  end loop;
end $$;

create function hub.authorize_app_admin() returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
  if not private.current_app_session_verified() or not private.has_staff_permission('platform.admin',null) then
    raise exception 'Current administrator session required.' using errcode='28000';
  end if;
  return jsonb_build_object('user_id',auth.uid(),'role','platform_admin','method','sms');
end;
$$;
revoke all on function hub.authorize_app_admin() from public,anon;
grant execute on function hub.authorize_app_admin() to authenticated;

create function hub.authorize_learning_object(p_path text,p_operation text) returns boolean
language sql stable security definer set search_path='' as $$
  select private.current_app_session_verified()
    and p_path ~ '^learning/[0-9a-f-]{36}/(video.mp4|captions.vtt|transcript.txt)$'
    and case when p_operation='upload' then private.can_upload_learning_object(p_path)
      when p_operation in ('download','sign') then private.can_read_learning_object(p_path) else false end;
$$;
revoke all on function hub.authorize_learning_object(text,text) from public,anon;
grant execute on function hub.authorize_learning_object(text,text) to authenticated;

create function private.usable_sms_identity(p_phone text) returns table(user_id uuid,identity_version uuid)
language sql stable security definer set search_path='' as $$
  select i.user_id,i.identity_version from private.sms_identities i
    join auth.users u on u.id=i.user_id join hub.profiles p on p.id=u.id
    where i.phone_e164=p_phone and i.revoked_at is null and u.deleted_at is null
      and (u.banned_until is null or u.banned_until<=now()) and not coalesce(u.is_anonymous,false);
$$;
revoke all on function private.usable_sms_identity(text) from public,anon,authenticated;
grant execute on function private.usable_sms_identity(text) to hub_app_server;

create or replace function hub.get_backend_contract() returns jsonb
language sql stable security invoker set search_path='' as $$ select jsonb_build_object('api_version',3); $$;

-- No login password, telephone number, provider key, or session is provisioned
-- in source. The deployment operator binds an approved number to an existing
-- user and enables the dedicated server role with a generated secret.

-- Intake still needs an active, verified support owner.
create or replace function private.is_case_intake_enabled(
  p_tenant_id uuid,
  p_product_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from private.case_intake_settings setting
    join hub.tenant_products entitlement
      on entitlement.tenant_id = setting.tenant_id
     and entitlement.product_id = setting.product_id
    join hub.tenants tenant on tenant.id = setting.tenant_id
    join hub.products product on product.id = setting.product_id
    where setting.tenant_id = p_tenant_id
      and setting.product_id = p_product_id
      and setting.enabled
      and setting.activated_at is not null
      and setting.activated_by is not null
      and entitlement.status = 'active'
      and tenant.status = 'active'
      and product.status <> 'retired'
      and product.support_enabled
      and exists (
        select 1
        from private.staff_permissions permission
        join auth.users staff_user on staff_user.id = permission.user_id
        where permission.revoked_at is null
          and permission.permission in ('case.write', 'platform.admin')
          and (permission.product_id is null or permission.product_id = p_product_id)
          and staff_user.deleted_at is null
          and (staff_user.banned_until is null or staff_user.banned_until <= now())
          and not coalesce(staff_user.is_anonymous, false)
          and exists (
            select 1
            from hub.profiles staff_profile
            where staff_profile.id = permission.user_id
          )
          and (exists (
            select 1 from auth.mfa_factors factor
            where factor.user_id = permission.user_id
              and factor.factor_type = 'totp'
              and factor.status = 'verified'
          ) or exists (
            select 1 from private.sms_identities sms
            where sms.user_id=permission.user_id and sms.revoked_at is null and sms.verified_at is not null
          ))
      )
  );
$$;
