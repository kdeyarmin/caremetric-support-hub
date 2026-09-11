-- Invited first-use SMS registration creates no app access. The current native
-- relationship must be reviewed again through customer onboarding before linking.
create table private.support_registration_reviews (
  id uuid primary key default gen_random_uuid(),actor_id uuid not null references auth.users(id),
  session_id uuid not null references private.sms_sessions(id),identity jsonb not null,
  phone_e164 text not null check(phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  display_name text not null check(length(display_name) between 1 and 120),tenant_name text not null check(length(tenant_name) between 2 and 180),
  proof_digest text not null,created_at timestamptz not null default now(),expires_at timestamptz not null default now()+interval '60 seconds'
);
create index support_registration_review_session_idx on private.support_registration_reviews(session_id,created_at);
create table private.support_registration_invitations (
  id uuid primary key,review_id uuid not null unique references private.support_registration_reviews(id),
  actor_id uuid not null references auth.users(id),session_id uuid not null references private.sms_sessions(id),
  identity jsonb not null,phone_e164 text not null check(phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  display_name text not null,tenant_name text not null,token_hash text not null unique check(token_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),expires_at timestamptz not null default now()+interval '15 minutes',
  revoked_at timestamptz,claimed_at timestamptz,claimed_user_id uuid references auth.users(id),
  check((claimed_at is null)=(claimed_user_id is null))
);
create unique index support_registration_native_unique on private.support_registration_invitations((identity->>'product'),(identity->>'sourceUserId')) where revoked_at is null;
create unique index support_registration_phone_unique on private.support_registration_invitations(phone_e164) where revoked_at is null;
alter table private.sms_challenges add column registration_invitation_id uuid references private.support_registration_invitations(id);
create index sms_challenge_registration_idx on private.sms_challenges(registration_invitation_id);
alter table private.support_registration_reviews enable row level security;
alter table private.support_registration_invitations enable row level security;
revoke all on private.support_registration_reviews,private.support_registration_invitations from public,anon,authenticated,service_role,hub_app_server;

create function private.validate_registration_identity(p_identity jsonb) returns void
language plpgsql immutable set search_path='' as $$
declare pattern text:='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
begin
  if p_identity->>'product' is distinct from 'carebase' then perform private.validate_support_identity(p_identity);return;end if;
  if jsonb_typeof(p_identity)<>'object' or (select array_agg(key order by key) from jsonb_object_keys(p_identity) key)
    is distinct from array['accountKind','product','relationship','revision','sourceAccountId','sourceUserId']::text[]
    or p_identity->>'accountKind' is distinct from 'organization' or p_identity->>'relationship' is distinct from 'organization_member'
    or coalesce(p_identity->>'sourceUserId','') !~ pattern or coalesce(p_identity->>'sourceAccountId','') !~ pattern
    or coalesce(p_identity->>'revision','') !~ '^[0-9a-f]{64}$' then raise exception 'Verified CareBase relationship required.' using errcode='22023';end if;
end; $$;

create function private.registration_available(p_identity jsonb,p_phone text) returns void
language plpgsql stable security definer set search_path='' as $$
begin
  perform private.validate_registration_identity(p_identity);
  if p_phone is null or p_phone !~ '^\+[1-9][0-9]{7,14}$' then raise exception 'Invalid phone.' using errcode='22023'; end if;
  if exists(select 1 from private.sms_identities where phone_e164=p_phone)
    or exists(select 1 from private.federated_principals p join private.federation_issuers i on i.id=p.issuer_id
      where i.issuer='urn:caremetric:support:'||(p_identity->>'product') and p.external_subject_hash=private.support_identity_hash(p_identity->>'sourceUserId')) then
    raise exception 'Use the existing Hub identity.' using errcode='40001'; end if;
  if p_identity->>'product'='carebase' then
    if exists(select 1 from private.federated_principals p join private.federation_issuers i on i.id=p.issuer_id
      where i.issuer='https://xsqobvvreaovwibxwyvv.supabase.co/auth/v1'
        and p.external_subject_hash=private.carebase_external_identity_hash((p_identity->>'sourceUserId')::uuid)) then
      raise exception 'Use the existing Hub identity.' using errcode='40001';end if;
  end if;
  if not exists(select 1 from hub.products where slug=case p_identity->>'product' when 'intel' then 'caremetric-intel' else p_identity->>'product' end
    and status<>'retired' and support_enabled) then raise exception 'Product unavailable.' using errcode='42501'; end if;
end; $$;

-- The invitation carries no user-supplied administrator identity. Claims use the
-- issuing session captured by the reviewed operation and recheck its live authority.
create function private.registration_issuer_current(i private.support_registration_invitations) returns boolean
language plpgsql security definer set search_path='' as $$
declare prior text:=current_setting('request.jwt.claims',true);allowed boolean:=false;
begin
  if session_user<>'hub_app_server' then return false; end if;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',i.actor_id,'role','authenticated','sms_session_id',i.session_id)::text,true);
  begin
    perform private.require_support_onboarding_actor(i.actor_id,i.session_id);allowed:=true;
  exception when sqlstate '28000' or sqlstate '42501' then allowed:=false;
  end;
  perform set_config('request.jwt.claims',coalesce(prior,''),true);
  return allowed;
end; $$;

create function private.start_registration_challenge(p_invitation_hash text,p_phone text,p_client_hash text,p_browser_hash text,p_challenge_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare i private.support_registration_invitations%rowtype;counts record;v_phone_hash text;
begin
  if session_user<>'hub_app_server' then raise exception 'Server required.' using errcode='42501'; end if;
  if p_invitation_hash is null or p_invitation_hash !~ '^[0-9a-f]{64}$' or p_browser_hash is null or p_browser_hash !~ '^[0-9a-f]{64}$'
    or p_client_hash is null or p_client_hash !~ '^[0-9a-f]{64}$' or p_phone is null or p_phone !~ '^\+[1-9][0-9]{7,14}$' then
    raise exception 'Invalid registration challenge.' using errcode='22023'; end if;
  v_phone_hash:=private.support_identity_hash(p_phone);
  perform pg_advisory_xact_lock(hashtextextended('hub_sms_start',0));
  select count(*) as total,count(*) filter(where c.phone_hash=v_phone_hash) as phone_count,
    count(*) filter(where c.client_hash=p_client_hash) as client_count,
    count(*) filter(where c.phone_hash=v_phone_hash and c.created_at>now()-interval '60 seconds') as recent
    into counts from private.sms_challenges c where c.created_at>now()-interval '15 minutes';
  if counts.total>=100 or counts.phone_count>=5 or counts.client_count>=30 or counts.recent>0 then raise exception 'Wait before requesting another code.' using errcode='P0429'; end if;
  select * into i from private.support_registration_invitations where token_hash=p_invitation_hash and phone_e164=p_phone
    and claimed_at is null and revoked_at is null and expires_at>now() for update;
  if i.id is not null and (not private.registration_issuer_current(i) or exists(select 1 from private.sms_identities where phone_e164=p_phone)) then i:=null; end if;
  -- Failed attempts consume the same persisted quota but do not reveal an invitation or send a message.
  update private.sms_challenges set consumed_at=now() where private.sms_challenges.phone_hash=v_phone_hash and consumed_at is null;
  insert into private.sms_challenges(id,phone_hash,client_hash,browser_hash,registration_invitation_id)
    values(p_challenge_id,v_phone_hash,p_client_hash,p_browser_hash,i.id);
  return jsonb_build_object('phone',case when i.id is not null then p_phone else null end);
end; $$;

create function private.inspect_registration_challenge(p_challenge_id uuid,p_browser_hash text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare c private.sms_challenges%rowtype;i private.support_registration_invitations%rowtype;
begin
  if session_user<>'hub_app_server' then raise exception 'Server required.' using errcode='42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('hub_sms_start',0));
  select * into c from private.sms_challenges where id=p_challenge_id and browser_hash=p_browser_hash
    and consumed_at is null and expires_at>now() and attempts<5 and registration_invitation_id is not null for update;
  if c.id is null then return null; end if;
  update private.sms_challenges set attempts=attempts+1 where id=c.id;
  select * into i from private.support_registration_invitations where id=c.registration_invitation_id and claimed_at is null and revoked_at is null and expires_at>now() for update;
  if i.id is null or not private.registration_issuer_current(i) then return null; end if;
  return jsonb_build_object('phone',i.phone_e164,'providerId',c.provider_id);
end; $$;

-- Called only after the application server receives an accepted Telnyx response
-- for the exact challenge and phone. It is not exposed as a browser RPC.
create function private.complete_support_registration(p_challenge_id uuid,p_browser_hash text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare c private.sms_challenges%rowtype;i private.support_registration_invitations%rowtype;uid uuid:=gen_random_uuid();version uuid;
begin
  if session_user<>'hub_app_server' then raise exception 'Server required.' using errcode='42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('hub_sms_start',0));
  select * into c from private.sms_challenges where id=p_challenge_id and browser_hash=p_browser_hash and consumed_at is null
    and expires_at>now() and attempts between 1 and 5 and provider_id is not null and registration_invitation_id is not null for update;
  if c.id is null then raise exception 'Challenge unavailable.' using errcode='28000'; end if;
  select * into i from private.support_registration_invitations where id=c.registration_invitation_id and claimed_at is null and revoked_at is null and expires_at>now() for update;
  if i.id is null or not private.registration_issuer_current(i) then raise exception 'Invitation unavailable.' using errcode='28000'; end if;
  perform private.registration_available(i.identity,i.phone_e164);
  -- No password, email credential, Supabase verification, tenant membership or
  -- staff permission is created. The Auth row is only a durable foreign-key identity.
  insert into auth.users(id,aud,role,raw_user_meta_data,raw_app_meta_data,created_at,updated_at,is_anonymous)
    values(uid,'authenticated','authenticated',jsonb_build_object('display_name',i.display_name),jsonb_build_object('provider','caremetric_sms','providers','[]'::jsonb),now(),now(),false);
  insert into private.sms_identities(user_id,phone_e164,verified_at) values(uid,i.phone_e164,now()) returning identity_version into version;
  update private.support_registration_invitations set claimed_at=now(),claimed_user_id=uid where id=i.id;
  update private.sms_challenges set consumed_at=now() where id=c.id;
  insert into private.audit_events(actor_id,action,entity_type,entity_id,metadata) values(uid,'support.registration.claim','support_registration_invitation',i.id,
    jsonb_build_object('issuingActorId',i.actor_id,'accessGranted',false));
  return jsonb_build_object('userId',uid,'identityVersion',version);
end; $$;

create function private.registration_review_view(r private.support_registration_reviews) returns jsonb
language sql stable set search_path='' as $$ select jsonb_build_object('reviewId',r.id,'proofDigest',r.proof_digest,'expiresAt',r.expires_at,
  'identity',r.identity,'phone',r.phone_e164,'displayName',r.display_name,'tenantName',r.tenant_name); $$;
create function private.registration_invitation_view(i private.support_registration_invitations) returns jsonb
language sql stable set search_path='' as $$ select jsonb_build_object('invitationId',i.id,'identity',i.identity,'displayName',i.display_name,
  'tenantName',i.tenant_name,'phoneEnding',right(i.phone_e164,4),'expiresAt',i.expires_at,'hubUserId',i.claimed_user_id,
  'state',case when i.claimed_at is not null then 'claimed' when i.revoked_at is not null then 'revoked' when i.expires_at<=now() then 'expired' else 'pending' end); $$;

create function hub.prepare_support_registration(p_actor_id uuid,p_session_id uuid,p_identity jsonb,p_phone text,p_display_name text,p_tenant_name text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r private.support_registration_reviews%rowtype;
begin
  perform private.require_support_onboarding_actor(p_actor_id,p_session_id);
  perform private.registration_available(p_identity,p_phone);
  if length(btrim(p_display_name)) not between 1 and 120 or length(btrim(p_tenant_name)) not between 2 and 180
    or p_display_name is null or p_tenant_name is null then raise exception 'Invalid account name.' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('support_registration_review:'||p_session_id,0));
  if (select count(*) from private.support_registration_reviews where session_id=p_session_id and created_at>now()-interval '15 minutes')>=30 then
    raise exception 'Too many registration reviews.' using errcode='42501'; end if;
  insert into private.support_registration_reviews(actor_id,session_id,identity,phone_e164,display_name,tenant_name,proof_digest)
    values(p_actor_id,p_session_id,p_identity,p_phone,btrim(p_display_name),btrim(p_tenant_name),encode(extensions.gen_random_bytes(32),'hex')) returning * into r;
  return private.registration_review_view(r);
end; $$;

create function hub.inspect_support_registration(p_actor_id uuid,p_session_id uuid,p_review_id uuid,p_proof_digest text) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare r private.support_registration_reviews%rowtype;
begin
  perform private.require_support_onboarding_actor(p_actor_id,p_session_id);
  select * into r from private.support_registration_reviews where id=p_review_id and actor_id=p_actor_id and session_id=p_session_id
    and proof_digest=p_proof_digest and expires_at>now();
  if r.id is null then raise exception 'Registration review expired.' using errcode='40001'; end if;
  return private.registration_review_view(r);
end; $$;

create function hub.issue_support_registration(p_actor_id uuid,p_session_id uuid,p_review_id uuid,p_proof_digest text,p_request_id uuid,p_token_hash text,p_identity jsonb,p_reviewed boolean) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r private.support_registration_reviews%rowtype;i private.support_registration_invitations%rowtype;
begin
  perform private.require_support_onboarding_actor(p_actor_id,p_session_id);
  if p_reviewed is distinct from true or p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' or p_request_id is null then raise exception 'Explicit review required.' using errcode='22023'; end if;
  select * into r from private.support_registration_reviews where id=p_review_id and actor_id=p_actor_id and session_id=p_session_id
    and proof_digest=p_proof_digest for update;
  if r.id is null or r.identity is distinct from p_identity then raise exception 'Review changed.' using errcode='40001'; end if;
  select * into i from private.support_registration_invitations where id=p_request_id;
  if i.id is not null then
    if i.review_id<>r.id or i.token_hash<>p_token_hash or i.revoked_at is not null or i.expires_at<=now() then raise exception 'Invitation changed.' using errcode='40001'; end if;
    return private.registration_invitation_view(i);
  end if;
  if r.expires_at<=now() then raise exception 'Review expired.' using errcode='40001'; end if;
  perform pg_advisory_xact_lock(hashtextextended('hub_sms_start',0));
  perform private.registration_available(p_identity,r.phone_e164);
  -- Expired, unclaimed invitations may be replaced. A claimed identity can never be replaced here.
  update private.support_registration_invitations set revoked_at=now() where revoked_at is null and claimed_at is null and expires_at<=now()
    and (phone_e164=r.phone_e164 or (identity->>'product'=p_identity->>'product' and identity->>'sourceUserId'=p_identity->>'sourceUserId'));
  insert into private.support_registration_invitations(id,review_id,actor_id,session_id,identity,phone_e164,display_name,tenant_name,token_hash)
    values(p_request_id,r.id,p_actor_id,p_session_id,p_identity,r.phone_e164,r.display_name,r.tenant_name,p_token_hash) returning * into i;
  insert into private.audit_events(actor_id,action,entity_type,entity_id,metadata) values(p_actor_id,'support.registration.invite','support_registration_invitation',i.id,
    jsonb_build_object('product',p_identity->>'product','reviewId',r.id,'accessGranted',false));
  return private.registration_invitation_view(i);
end; $$;

create function hub.list_support_registrations(p_actor_id uuid,p_session_id uuid,p_offset integer) returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
  perform private.require_support_onboarding_actor(p_actor_id,p_session_id);
  if p_offset is null or p_offset<0 or p_offset>10000 then raise exception 'Invalid offset.' using errcode='22023'; end if;
  return jsonb_build_object('rows',coalesce((select jsonb_agg(page.result) from
    (select private.registration_invitation_view(i) as result from private.support_registration_invitations i order by created_at desc,id limit 20 offset p_offset)page),'[]'::jsonb),
    'offset',p_offset,'total',(select count(*) from private.support_registration_invitations));
end; $$;
create function hub.revoke_support_registration(p_actor_id uuid,p_session_id uuid,p_invitation_id uuid,p_reviewed boolean) returns jsonb
language plpgsql security definer set search_path='' as $$
declare i private.support_registration_invitations%rowtype;
begin
  perform private.require_support_onboarding_actor(p_actor_id,p_session_id);
  if p_reviewed is distinct from true then raise exception 'Explicit review required.' using errcode='22023'; end if;
  select * into i from private.support_registration_invitations where id=p_invitation_id for update;
  if i.id is null or i.claimed_at is not null then raise exception 'Invitation unavailable.' using errcode='40001'; end if;
  update private.support_registration_invitations set revoked_at=coalesce(revoked_at,now()) where id=i.id returning * into i;
  insert into private.audit_events(actor_id,action,entity_type,entity_id,metadata) values(p_actor_id,'support.registration.revoke','support_registration_invitation',i.id,'{}');
  return private.registration_invitation_view(i);
end; $$;

revoke all on function private.validate_registration_identity(jsonb),private.registration_available(jsonb,text),private.registration_issuer_current(private.support_registration_invitations),
  private.registration_review_view(private.support_registration_reviews),private.registration_invitation_view(private.support_registration_invitations),
  private.start_registration_challenge(text,text,text,text,uuid),private.inspect_registration_challenge(uuid,text),private.complete_support_registration(uuid,text),
  hub.prepare_support_registration(uuid,uuid,jsonb,text,text,text),hub.inspect_support_registration(uuid,uuid,uuid,text),
  hub.issue_support_registration(uuid,uuid,uuid,text,uuid,text,jsonb,boolean),hub.list_support_registrations(uuid,uuid,integer),
  hub.revoke_support_registration(uuid,uuid,uuid,boolean) from public,anon,authenticated,service_role,hub_app_server;
grant execute on function private.start_registration_challenge(text,text,text,text,uuid),private.inspect_registration_challenge(uuid,text),private.complete_support_registration(uuid,text),
  hub.prepare_support_registration(uuid,uuid,jsonb,text,text,text),hub.inspect_support_registration(uuid,uuid,uuid,text),
  hub.issue_support_registration(uuid,uuid,uuid,text,uuid,text,jsonb,boolean),hub.list_support_registrations(uuid,uuid,integer),
  hub.revoke_support_registration(uuid,uuid,uuid,boolean) to hub_app_server;
