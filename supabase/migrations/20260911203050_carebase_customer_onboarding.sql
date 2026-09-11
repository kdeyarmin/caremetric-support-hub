-- Extend the reviewed customer pairing path to nonemployee CareBase accounts.
-- Reuse CareBase's canonical issuer, native UUID hashes and tenant lock namespace.
-- This performs no provisioning at migration time and writes no learning evidence.
create function private.support_native_issuer(p_product text) returns text
language sql immutable strict set search_path='' as $$
  select case when p_product='carebase' then 'https://xsqobvvreaovwibxwyvv.supabase.co/auth/v1'
    else 'urn:caremetric:support:'||p_product end;
$$;
revoke all on function private.support_native_issuer(text) from public,anon,authenticated,service_role,hub_app_server;

create or replace function private.validate_support_identity(p_identity jsonb) returns text
language plpgsql immutable set search_path='' as $$
declare product text:=p_identity->>'product'; uid text:=p_identity->>'sourceUserId'; aid text:=p_identity->>'sourceAccountId';
  kind text; relation text; pattern text;
begin
  if p_identity is null or jsonb_typeof(p_identity)<>'object' or
    (select array_agg(key order by key) from jsonb_object_keys(p_identity) key)
      is distinct from array['accountKind','product','relationship','revision','sourceAccountId','sourceUserId']::text[]
    or product not in ('carebase','breathe','caremetric-emr','caremetric-go','pennsync','intel') or product is null
    or p_identity->>'revision' is null or (p_identity->>'revision') !~ '^[0-9a-f]{64}$' then
    raise exception 'Verified native identity required.' using errcode='22023'; end if;
  kind:=case product when 'intel' then 'individual' when 'pennsync' then 'agency' else 'organization' end;
  relation:=case product when 'intel' then 'individual_owner' when 'pennsync' then 'agency_member' else 'organization_member' end;
  pattern:=case when product in ('intel','pennsync') then '^[0-9a-f]{24}$' else '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' end;
  if p_identity->>'accountKind' is distinct from kind or p_identity->>'relationship' is distinct from relation
    or aid is null or aid !~ pattern or uid is null
    or (product='breathe' and uid !~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$')
    or (product<>'breathe' and uid !~ pattern) or (product='intel' and uid<>aid) then
    raise exception 'Verified native account relationship required.' using errcode='22023'; end if;
  return product;
end; $$;

create or replace function private.support_onboarding_state(p_identity jsonb,p_hub_user uuid,p_hub_tenant uuid) returns text
language sql stable security definer set search_path='' as $$
  select private.support_identity_hash(jsonb_build_object(
    'hubIdentity',(select jsonb_build_object('version',i.identity_version,'verifiedAt',i.verified_at,'revokedAt',i.revoked_at) from private.sms_identities i where i.user_id=p_hub_user),
    'hubProfile',(select to_jsonb(p) from hub.profiles p where p.id=p_hub_user),
    'issuer',(select to_jsonb(f) from private.federation_issuers f where f.issuer=private.support_native_issuer(p_identity->>'product')),
    'principal',(select to_jsonb(p) from private.federated_principals p join private.federation_issuers f on f.id=p.issuer_id
      where f.issuer=private.support_native_issuer(p_identity->>'product') and p.external_subject_hash=private.support_identity_hash(p_identity->>'sourceUserId')),
    'binding',(select to_jsonb(t) from private.federated_tenants t join private.federation_issuers f on f.id=t.issuer_id
      where f.issuer=private.support_native_issuer(p_identity->>'product') and t.external_tenant_hash=private.support_identity_hash(p_identity->>'sourceAccountId')),
    'tenant',(select to_jsonb(t) from hub.tenants t where t.id=p_hub_tenant),
    'product',(select to_jsonb(p) from hub.products p where p.slug=case p_identity->>'product' when 'intel' then 'caremetric-intel' else p_identity->>'product' end),
    'access',(select to_jsonb(t) from hub.tenant_products t join hub.products p on p.id=t.product_id where t.tenant_id=p_hub_tenant and p.slug=case p_identity->>'product' when 'intel' then 'caremetric-intel' else p_identity->>'product' end),
    'member',(select to_jsonb(m) from hub.tenant_product_memberships m join hub.products p on p.id=m.product_id where m.tenant_id=p_hub_tenant and m.user_id=p_hub_user and p.slug=case p_identity->>'product' when 'intel' then 'caremetric-intel' else p_identity->>'product' end),
    'intake',(select to_jsonb(s) from private.case_intake_settings s join hub.products p on p.id=s.product_id where s.tenant_id=p_hub_tenant and p.slug=case p_identity->>'product' when 'intel' then 'caremetric-intel' else p_identity->>'product' end)
  )::text);
$$;

create or replace function hub.prepare_support_onboarding(p_actor_id uuid,p_session_id uuid,p_identity jsonb,p_hub_user_id uuid,p_tenant_name text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare product text; pid uuid; tenant uuid; display_name text; intent private.support_onboarding_intents%rowtype;
begin
  perform private.require_support_onboarding_actor(p_actor_id,p_session_id);
  product:=private.validate_support_identity(p_identity);
  display_name:=private.support_onboarding_user(p_hub_user_id);
  if p_tenant_name is null or char_length(btrim(p_tenant_name)) not between 2 and 180 then
    raise exception 'Review the customer account name.' using errcode='22023'; end if;
  select id into pid from hub.products where slug=case product when 'intel' then 'caremetric-intel' else product end and status<>'retired' and support_enabled;
  if pid is null then raise exception 'Eligible support product required.' using errcode='42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('support-preview:'||p_session_id::text,0));
  if (select count(*) from private.support_onboarding_intents where session_id=p_session_id and created_at>now()-interval '15 minutes')>=30 then
    raise exception 'Too many account previews. Try later.' using errcode='42501'; end if;
  select t.hub_tenant_id into tenant from private.federated_tenants t join private.federation_issuers f on f.id=t.issuer_id
    where f.issuer=private.support_native_issuer(product) and t.external_tenant_hash=private.support_identity_hash(p_identity->>'sourceAccountId');
  tenant:=coalesce(tenant,gen_random_uuid());
  if exists(select 1 from private.case_intake_settings where tenant_id=tenant and product_id=pid and enabled) then
    raise exception 'Disable and review existing intake before linking another customer.' using errcode='42501'; end if;
  -- Display the canonical name for an existing account; never rename it implicitly.
  select coalesce((select name from hub.tenants where id=tenant),btrim(p_tenant_name)) into p_tenant_name;
  insert into private.support_onboarding_intents(actor_id,session_id,product_id,identity,hub_user_id,hub_tenant_id,tenant_name,hub_display_name,state_digest,proof_digest)
    values(p_actor_id,p_session_id,pid,p_identity,p_hub_user_id,tenant,p_tenant_name,display_name,
      private.support_onboarding_state(p_identity,p_hub_user_id,tenant),private.support_identity_hash(gen_random_uuid()::text)) returning * into intent;
  return private.support_onboarding_view(intent);
end; $$;

create or replace function hub.apply_support_onboarding(p_actor_id uuid,p_session_id uuid,p_intent_id uuid,p_proof_digest text,p_request_id uuid,p_identity jsonb,p_reviewed boolean) returns jsonb
language plpgsql security definer set search_path='' as $$
declare intent private.support_onboarding_intents%rowtype; product text; fid uuid; principal private.federated_principals%rowtype;
  prior_tenant uuid; member hub.tenant_product_memberships%rowtype; v_result jsonb;
begin
  perform hub.inspect_support_onboarding(p_actor_id,p_session_id,p_intent_id,p_proof_digest,p_request_id);
  if p_reviewed is distinct from true then raise exception 'Review the exact account pairing.' using errcode='22023'; end if;
  product:=private.validate_support_identity(p_identity);
  select * into intent from private.support_onboarding_intents where id=p_intent_id for update;
  if intent.identity is distinct from p_identity then raise exception 'Native account relationship changed.' using errcode='40001'; end if;
  -- Serialize both mappings, including concurrent previews by different admins.
  perform pg_advisory_xact_lock(hashtextextended('support-issuer:'||product,0));
  perform pg_advisory_xact_lock(hashtextextended('support-request:'||p_request_id::text,0));
  if exists(select 1 from private.support_onboarding_intents where request_id=p_request_id and id<>p_intent_id)
    or (intent.request_id is not null and intent.request_id<>p_request_id)
    or (intent.applied_at is null and intent.expires_at<=now()) then raise exception 'Preview changed or expired.' using errcode='40001'; end if;
  -- Serialize with the existing receipt setup before taking tenant/product row
  -- locks. Customer pairing never creates an employee binding or learning receipt.
  if product='carebase' then
    perform pg_advisory_xact_lock(hashtextextended('carebase-tenant:'||(p_identity->>'sourceAccountId'),0));
    perform pg_advisory_xact_lock(hashtextextended('carebase-principal:'||(p_identity->>'sourceUserId'),0));
  end if;
  -- Lock existing mutable rows as well as serializing this provisioning path.
  perform 1 from auth.users where id=intent.hub_user_id for share;
  perform 1 from hub.profiles where id=intent.hub_user_id for share;
  perform 1 from private.sms_identities where user_id=intent.hub_user_id for share;
  perform 1 from hub.products where id=intent.product_id and status<>'retired' and support_enabled for update;
  if not found then raise exception 'Eligible support product required.' using errcode='42501'; end if;
  perform 1 from hub.tenants where id=intent.hub_tenant_id for update;
  perform 1 from hub.tenant_products where tenant_id=intent.hub_tenant_id and product_id=intent.product_id for update;
  perform 1 from hub.tenant_product_memberships where tenant_id=intent.hub_tenant_id and product_id=intent.product_id and user_id=intent.hub_user_id for update;
  perform 1 from private.case_intake_settings where tenant_id=intent.hub_tenant_id and product_id=intent.product_id for update;
  if intent.applied_at is null and intent.state_digest<>private.support_onboarding_state(p_identity,intent.hub_user_id,intent.hub_tenant_id) then
    raise exception 'Customer access changed. Preview again.' using errcode='40001'; end if;
  if exists(select 1 from private.case_intake_settings where tenant_id=intent.hub_tenant_id and product_id=intent.product_id and enabled) then
    raise exception 'Existing intake requires separate review.' using errcode='42501'; end if;
  if product='carebase' then
    if intent.applied_at is null then
      insert into private.federation_issuers(product_id,issuer,audience,jwks_url,enabled,verification_method)
        values(intent.product_id,private.support_native_issuer(product),'authenticated',
          'https://xsqobvvreaovwibxwyvv.supabase.co/auth/v1/.well-known/jwks.json',false,'oidc') on conflict(issuer) do nothing;
    end if;
    select id into fid from private.federation_issuers where issuer=private.support_native_issuer(product) and product_id=intent.product_id
      and audience='authenticated' and verification_method='oidc'
      and jwks_url='https://xsqobvvreaovwibxwyvv.supabase.co/auth/v1/.well-known/jwks.json' for update;
  else
  if intent.applied_at is null then
    insert into private.federation_issuers(product_id,issuer,audience,jwks_url,enabled,verification_method)
      values(intent.product_id,private.support_native_issuer(product),'support.operator_review',null,false,'operator_review') on conflict(issuer) do nothing;
  end if;
  select id into fid from private.federation_issuers where issuer=private.support_native_issuer(product) and product_id=intent.product_id
    and audience='support.operator_review' and verification_method='operator_review' and not enabled and jwks_url is null for update;
  end if;
  if fid is null then raise exception 'Review the existing source configuration.' using errcode='40001'; end if;
  select * into principal from private.federated_principals where issuer_id=fid and external_subject_hash=private.support_identity_hash(p_identity->>'sourceUserId') for update;
  if found and (principal.hub_user_id<>intent.hub_user_id or principal.revoked_at is not null) then
    raise exception 'Existing principal cannot be repointed or restored.' using errcode='40001'; end if;
  select hub_tenant_id into prior_tenant from private.federated_tenants where issuer_id=fid and external_tenant_hash=private.support_identity_hash(p_identity->>'sourceAccountId') for update;
  if prior_tenant is not null and prior_tenant<>intent.hub_tenant_id then raise exception 'Existing account cannot be repointed.' using errcode='40001'; end if;
  if intent.applied_at is not null and (principal.hub_user_id is null or prior_tenant is null) then
    raise exception 'Existing identity binding requires review.' using errcode='40001'; end if;
  if intent.applied_at is null then
    if prior_tenant is null then
      insert into hub.tenants(id,slug,name) values(intent.hub_tenant_id,case when product='carebase' then 'carebase-'||(p_identity->>'sourceAccountId') else 'support-'||intent.hub_tenant_id::text end,intent.tenant_name);
      insert into private.federated_tenants(issuer_id,external_tenant_hash,hub_tenant_id) values(fid,private.support_identity_hash(p_identity->>'sourceAccountId'),intent.hub_tenant_id);
      insert into hub.tenant_products(tenant_id,product_id) values(intent.hub_tenant_id,intent.product_id);
    end if;
    insert into private.federated_principals(issuer_id,external_subject_hash,hub_user_id) values(fid,private.support_identity_hash(p_identity->>'sourceUserId'),intent.hub_user_id) on conflict do nothing;
    insert into hub.tenant_product_memberships(tenant_id,product_id,user_id,role,case_scope,can_manage_members)
      values(intent.hub_tenant_id,intent.product_id,intent.hub_user_id,'customer','own',false) on conflict do nothing;
    insert into private.case_intake_settings(tenant_id,product_id,enabled) values(intent.hub_tenant_id,intent.product_id,false) on conflict do nothing;
  end if;
  select * into member from hub.tenant_product_memberships where tenant_id=intent.hub_tenant_id and product_id=intent.product_id and user_id=intent.hub_user_id;
  if member.user_id is null or member.status<>'active' or member.revoked_at is not null or member.role<>'customer' or member.case_scope<>'own' or member.can_manage_members
    or not exists(select 1 from hub.tenants t join hub.tenant_products p on p.tenant_id=t.id where t.id=intent.hub_tenant_id and p.product_id=intent.product_id and t.status='active' and p.status='active') then
    raise exception 'Existing access requires separate review.' using errcode='42501'; end if;
  perform private.support_onboarding_user(intent.hub_user_id);
  perform private.require_support_onboarding_actor(p_actor_id,p_session_id);
  if intent.applied_at is not null then return intent.result||jsonb_build_object('replayed',true); end if;
  v_result:=jsonb_build_object('intentId',intent.id,'hubTenantId',intent.hub_tenant_id,'hubUserId',intent.hub_user_id,'product',product,
    'replayed',false,'access','customer','caseScope','own','intakeEnabled',false);
  update private.support_onboarding_intents set applied_at=now(),request_id=p_request_id,result=v_result where id=intent.id;
  insert into private.audit_events(actor_id,action,entity_type,entity_id,tenant_id,product_id,metadata)
    values(p_actor_id,'support.customer.link','tenant',intent.hub_tenant_id,intent.hub_tenant_id,intent.product_id,
      jsonb_build_object('intentId',intent.id,'requestId',p_request_id,'hubUserId',intent.hub_user_id,'reviewed',true,'intakeEnabled',false));
  return v_result;
end; $$;

