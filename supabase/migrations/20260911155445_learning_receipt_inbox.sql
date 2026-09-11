-- The inbox is a reporting projection of native completion evidence. It never
-- enrolls learners, issues certificates, grants credits, or rewrites history.
create function private.learning_receipt_schema() returns json
language sql immutable set search_path='' as $$ select $schema${"$schema":"http://json-schema.org/draft-07/schema#","type":"object","properties":{"contract":{"type":"string","const":"caremetric.learning-receipt.v1"},"source":{"type":"string","const":"carebase"},"eventId":{"type":"string","pattern":"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"},"kind":{"type":"string","enum":["completed","retracted"]},"sequence":{"type":"integer","minimum":1,"maximum":2147483647},"mappingId":{"type":"string","pattern":"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"},"assignmentId":{"type":"string","pattern":"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"},"sourceCourseId":{"type":"string","pattern":"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"},"sourceVersionId":{"type":"string","pattern":"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"},"mappingRevision":{"type":"string","pattern":"^[0-9a-f]{64}$"},"assignmentRevision":{"type":"string","pattern":"^[0-9a-f]{64}$"},"completionRevision":{"type":"string","pattern":"^[0-9a-f]{64}$"},"hubTenantId":{"type":"string","pattern":"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"},"hubUserId":{"type":"string","pattern":"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"},"completedAt":{"type":"string","maxLength":40,"pattern":"^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{1,6})?(Z|[+-]\\d{2}:\\d{2})$"},"evidenceSha256":{"type":"string","pattern":"^[0-9a-f]{64}$"},"finalExamScore":{"anyOf":[{"type":"number","minimum":0,"maximum":100},{"type":"null"}]},"certificate":{"type":"object","properties":{"id":{"type":"string","pattern":"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"},"issuedAt":{"type":"string","maxLength":40,"pattern":"^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{1,6})?(Z|[+-]\\d{2}:\\d{2})$"},"expiresAt":{"anyOf":[{"type":"string","maxLength":40,"pattern":"^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{1,6})?(Z|[+-]\\d{2}:\\d{2})$"},{"type":"null"}]},"providerEvidenceSha256":{"type":"string","pattern":"^[0-9a-f]{64}$"}},"required":["id","issuedAt","expiresAt","providerEvidenceSha256"],"additionalProperties":false},"credits":{"maxItems":100,"type":"array","items":{"type":"object","properties":{"id":{"type":"string","pattern":"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"},"trainingTypeId":{"type":"string","pattern":"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"},"topicCode":{"type":"string","maxLength":200},"hours":{"type":"string","pattern":"^\\d{1,4}(\\.\\d{1,2})?$"},"year":{"type":"integer","minimum":2000,"maximum":2200},"creditedAt":{"type":"string","maxLength":40,"pattern":"^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{1,6})?(Z|[+-]\\d{2}:\\d{2})$"}},"required":["id","trainingTypeId","topicCode","hours","year","creditedAt"],"additionalProperties":false}},"attestations":{"maxItems":500,"type":"array","items":{"type":"object","properties":{"blockId":{"type":"string","pattern":"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"},"version":{"type":"string","maxLength":500},"statementSha256":{"type":"string","pattern":"^[0-9a-f]{64}$"},"attestedAt":{"type":"string","maxLength":40,"pattern":"^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{1,6})?(Z|[+-]\\d{2}:\\d{2})$"}},"required":["blockId","version","statementSha256","attestedAt"],"additionalProperties":false}},"quizEvidenceSha256":{"type":"string","pattern":"^[0-9a-f]{64}$"},"renewalEvidenceSha256":{"type":"string","pattern":"^[0-9a-f]{64}$"}},"required":["contract","source","eventId","kind","sequence","mappingId","assignmentId","sourceCourseId","sourceVersionId","mappingRevision","assignmentRevision","completionRevision","hubTenantId","hubUserId","completedAt","evidenceSha256","finalExamScore","certificate","credits","attestations","quizEvidenceSha256","renewalEvidenceSha256"],"additionalProperties":false}$schema$::json; $$;

create function private.require_receipt_command_actor(p_actor_id uuid,p_session_id uuid) returns void
language plpgsql stable security definer set search_path='' as $$
begin
  if not exists(select 1 from auth.users u join hub.profiles p on p.id=u.id
    join auth.sessions s on s.user_id=u.id join auth.mfa_factors f on f.id=s.factor_id and f.user_id=s.user_id
    where u.id=p_actor_id and u.deleted_at is null and not coalesce(u.is_anonymous,false)
      and (u.banned_until is null or u.banned_until<=now()) and s.id=p_session_id and s.aal='aal2'
      and s.oauth_client_id is null and (s.not_after is null or s.not_after>now())
      and s.created_at>now()-interval '480 minutes' and s.created_at<=now()
      and f.factor_type='totp' and f.status='verified'
      and exists(select 1 from private.staff_permissions sp where sp.user_id=u.id and sp.permission='platform.admin'
        and sp.product_id is null and sp.revoked_at is null)) then
    raise exception 'Current administrator command session required.' using errcode='42501';
  end if;
end;
$$;

create table private.learning_receipt_mappings (
  id uuid primary key,
  source_snapshot_id uuid not null references private.learning_source_snapshots(id),
  native_organization_id uuid not null,
  native_employee_id uuid not null,
  hub_tenant_id uuid not null,
  hub_user_id uuid not null,
  product_id uuid not null references hub.products(id),
  state text not null check(state in ('pending','active','revoked')),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  activated_at timestamptz,
  revoked_at timestamptz
);
create table private.learning_receipt_inbox (
  event_id uuid primary key,
  mapping_id uuid not null references private.learning_receipt_mappings(id),
  assignment_id uuid not null,
  sequence integer not null check(sequence>0),
  kind text not null check(kind in ('completed','retracted')),
  source_digest text not null check(source_digest ~ '^[0-9a-f]{64}$'),
  payload text not null check(octet_length(payload)<=100000),
  accepted_by uuid not null,
  accepted_at timestamptz not null default now(),
  unique(assignment_id,sequence)
);
create index learning_receipt_mappings_source on private.learning_receipt_mappings(source_snapshot_id);
create index learning_receipt_mappings_tenant on private.learning_receipt_mappings(hub_tenant_id);
create index learning_receipt_mappings_user on private.learning_receipt_mappings(hub_user_id);
create index learning_receipt_mappings_product on private.learning_receipt_mappings(product_id);
create index learning_receipt_mappings_actor on private.learning_receipt_mappings(created_by);
create index learning_receipt_inbox_mapping on private.learning_receipt_inbox(mapping_id);
create index learning_receipt_inbox_actor on private.learning_receipt_inbox(accepted_by);
alter table private.learning_receipt_mappings enable row level security;
alter table private.learning_receipt_inbox enable row level security;
revoke all on private.learning_receipt_mappings,private.learning_receipt_inbox from public,anon,authenticated,service_role;

create function private.receipt_membership_is_active(p_tenant uuid,p_user uuid,p_product uuid) returns boolean
language sql stable security definer set search_path='' as $$
select exists(select 1 from hub.tenant_product_memberships m join hub.tenant_products tp on tp.tenant_id=m.tenant_id and tp.product_id=m.product_id
  join hub.tenants t on t.id=m.tenant_id join auth.users u on u.id=m.user_id where m.tenant_id=p_tenant and m.user_id=p_user and m.product_id=p_product
    and m.status='active' and tp.status='active' and t.status='active' and u.deleted_at is null and not coalesce(u.is_anonymous,false)
    and (u.banned_until is null or u.banned_until<=now()));
$$;

-- Version 1: lowerhex SHA256 of canonical lowercase UUID UTF8, issuer-scoped.
create function private.carebase_external_identity_hash(p_id uuid) returns text
language sql immutable strict set search_path='' as $$ select encode(extensions.digest(p_id::text,'sha256'),'hex'); $$;

-- Learning-specific employee/profile relationship; canonical user and tenant
-- ownership lives exclusively in the existing federation tables.
create table private.learning_employee_bindings (
  native_employee_id uuid primary key, native_profile_id uuid not null unique, native_organization_id uuid not null,
  issuer_id uuid not null, external_subject_hash text not null, external_tenant_hash text not null,
  created_by uuid not null, created_at timestamptz not null default now(),
  foreign key(issuer_id,external_subject_hash) references private.federated_principals(issuer_id,external_subject_hash) on delete cascade,
  foreign key(issuer_id,external_tenant_hash) references private.federated_tenants(issuer_id,external_tenant_hash) on delete cascade
);
create index learning_employee_principal on private.learning_employee_bindings(issuer_id,external_subject_hash);
create index learning_employee_tenant on private.learning_employee_bindings(issuer_id,external_tenant_hash);
alter table private.learning_employee_bindings enable row level security;
revoke all on private.learning_employee_bindings from public,anon,authenticated,service_role;
create function private.learning_receipt_identity_active(p_organization uuid,p_employee uuid,p_tenant uuid,p_user uuid) returns boolean
language sql stable security definer set search_path='' as $$
  select exists(select 1 from private.learning_employee_bindings e
    join private.federated_principals p on p.issuer_id=e.issuer_id and p.external_subject_hash=e.external_subject_hash
    join private.federated_tenants t on t.issuer_id=e.issuer_id and t.external_tenant_hash=e.external_tenant_hash
    where e.native_organization_id=p_organization and e.native_employee_id=p_employee and p.revoked_at is null
      and p.hub_user_id=p_user and t.hub_tenant_id=p_tenant
      and e.external_subject_hash=private.carebase_external_identity_hash(e.native_profile_id)
      and e.external_tenant_hash=private.carebase_external_identity_hash(e.native_organization_id));
$$;

-- The coordinator verifies native IDs before each call. Explicit choice of an
-- EXISTING Hub account; no names/email matching, no invitation, no auto-merge.
create function hub.provision_learning_receipt_access(p_actor_id uuid,p_session_id uuid,p_native_organization_id uuid,
  p_native_employee_id uuid,p_native_profile_id uuid,p_hub_tenant_id uuid,p_tenant_name text,p_hub_user_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare product uuid; prior_tenant uuid; v_issuer_id uuid; subject_hash text; tenant_hash text;
  principal private.federated_principals%rowtype; employee private.learning_employee_bindings%rowtype;
begin
  perform private.require_receipt_command_actor(p_actor_id,p_session_id);
  if p_native_organization_id is null or p_native_employee_id is null or p_native_profile_id is null or p_hub_tenant_id is null
    or p_tenant_name is null or char_length(btrim(p_tenant_name)) not between 2 and 180 then
    raise exception 'Explicit verified native identifiers and canonical tenant required.' using errcode='22023'; end if;
  select id into product from hub.products where slug='penntrain' and status<>'retired';
  if product is null or not exists(select 1 from auth.users u join hub.profiles p on p.id=u.id where u.id=p_hub_user_id
    and u.deleted_at is null and not coalesce(u.is_anonymous,false) and (u.banned_until is null or u.banned_until<=now())) then
    raise exception 'Existing active Hub account and product required.' using errcode='22023'; end if;
  -- Verified public OIDC discovery and JWKS, 2026-09-11. Metadata does not enable
  -- JWT federation. Authenticated learning pull uses its own reviewed authority.
  insert into private.federation_issuers(product_id,issuer,audience,jwks_url,enabled)
    values(product,'https://xsqobvvreaovwibxwyvv.supabase.co/auth/v1','authenticated',
      'https://xsqobvvreaovwibxwyvv.supabase.co/auth/v1/.well-known/jwks.json',false) on conflict(issuer) do nothing;
  select id into v_issuer_id from private.federation_issuers f where f.issuer='https://xsqobvvreaovwibxwyvv.supabase.co/auth/v1'
    and f.product_id=product and f.audience='authenticated' and f.jwks_url='https://xsqobvvreaovwibxwyvv.supabase.co/auth/v1/.well-known/jwks.json';
  if v_issuer_id is null then raise exception 'Review the existing CareBase issuer configuration.' using errcode='40001'; end if;
  subject_hash:=private.carebase_external_identity_hash(p_native_profile_id);
  tenant_hash:=private.carebase_external_identity_hash(p_native_organization_id);
  perform pg_advisory_xact_lock(hashtextextended('carebase-tenant:'||p_native_organization_id::text,0));
  select hub_tenant_id into prior_tenant from private.federated_tenants t where t.issuer_id=v_issuer_id and t.external_tenant_hash=tenant_hash;
  if prior_tenant is null then
    insert into hub.tenants(id,slug,name) values(p_hub_tenant_id,'carebase-'||p_native_organization_id::text,btrim(p_tenant_name));
    insert into private.federated_tenants(issuer_id,external_tenant_hash,hub_tenant_id) values(v_issuer_id,tenant_hash,p_hub_tenant_id);
    insert into hub.tenant_products(tenant_id,product_id) values(p_hub_tenant_id,product);
    insert into private.case_intake_settings(tenant_id,product_id,enabled) values(p_hub_tenant_id,product,false) on conflict do nothing;
  else
    -- Reuse the already reviewed exact native-ID mapping; never repoint it.
    p_hub_tenant_id:=prior_tenant;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('carebase-principal:'||p_native_profile_id::text,0));
  select * into principal from private.federated_principals p where p.issuer_id=v_issuer_id and p.external_subject_hash=subject_hash for update;
  if found then
    if principal.hub_user_id<>p_hub_user_id then raise exception 'Native principal cannot be repointed.' using errcode='40001'; end if;
    if principal.revoked_at is not null then raise exception 'Existing revoked or suspended access requires separate review.' using errcode='42501'; end if;
  else
    insert into private.federated_principals(issuer_id,external_subject_hash,hub_user_id) values(v_issuer_id,subject_hash,p_hub_user_id);
  end if;
  select * into employee from private.learning_employee_bindings where native_employee_id=p_native_employee_id for update;
  if found then
    if employee.native_profile_id<>p_native_profile_id or employee.native_organization_id<>p_native_organization_id or employee.issuer_id<>v_issuer_id then
      raise exception 'Native employee binding cannot be repointed.' using errcode='40001'; end if;
  else
    insert into private.learning_employee_bindings(native_employee_id,native_profile_id,native_organization_id,issuer_id,external_subject_hash,external_tenant_hash,created_by)
      values(p_native_employee_id,p_native_profile_id,p_native_organization_id,v_issuer_id,subject_hash,tenant_hash,p_actor_id);
  end if;
  insert into hub.tenant_product_memberships(tenant_id,product_id,user_id,role,case_scope,can_manage_members)
    values(p_hub_tenant_id,product,p_hub_user_id,'customer','own',false) on conflict do nothing;
  if not private.receipt_membership_is_active(p_hub_tenant_id,p_hub_user_id,product) then
    raise exception 'Existing revoked or suspended access requires separate review.' using errcode='42501'; end if;
  insert into private.audit_events(actor_id,action,entity_type,entity_id,metadata)
    values(p_actor_id,'learning.receipt_access.provision','tenant',p_hub_tenant_id,jsonb_build_object('source','carebase'));
  return jsonb_build_object('hubTenantId',p_hub_tenant_id,'hubUserId',p_hub_user_id,'nativeOrganizationId',p_native_organization_id,
    'nativeEmployeeId',p_native_employee_id,'nativeProfileId',p_native_profile_id);
end;
$$;
revoke all on function private.carebase_external_identity_hash(uuid),private.learning_receipt_identity_active(uuid,uuid,uuid,uuid) from public,anon,authenticated,service_role;

create function hub.prepare_learning_receipt_mapping(p_actor_id uuid,p_session_id uuid,p_mapping_id uuid,p_source_snapshot_id uuid,
  p_native_organization_id uuid,p_native_employee_id uuid,p_hub_tenant_id uuid,p_hub_user_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare snapshot private.learning_source_snapshots%rowtype; mapping private.learning_receipt_mappings%rowtype; product uuid;
begin
  perform private.require_receipt_command_actor(p_actor_id,p_session_id);
  if p_mapping_id is null or p_native_organization_id is null or p_native_employee_id is null then
    raise exception 'Explicit source mapping identifiers required.' using errcode='22023'; end if;
  if not private.learning_receipt_identity_active(p_native_organization_id,p_native_employee_id,p_hub_tenant_id,p_hub_user_id) then
    raise exception 'Provision and review native tenant and principal access first.' using errcode='42501'; end if;
  select * into snapshot from private.learning_source_snapshots where id=p_source_snapshot_id;
  select id into product from hub.products where slug='penntrain' and status<>'retired';
  if snapshot.id is null or snapshot.publication_state<>'published' or product is null
    or not private.receipt_membership_is_active(p_hub_tenant_id,p_hub_user_id,product) then
    raise exception 'Reviewed published source and active Hub learner membership required.' using errcode='42501';
  end if;
  select * into mapping from private.learning_receipt_mappings where id=p_mapping_id for update;
  if found then
    if mapping.state='revoked' or mapping.source_snapshot_id<>p_source_snapshot_id or mapping.native_organization_id<>p_native_organization_id
      or mapping.native_employee_id<>p_native_employee_id or mapping.hub_tenant_id<>p_hub_tenant_id or mapping.hub_user_id<>p_hub_user_id then
      raise exception 'A receipt mapping cannot be repointed or reactivated.' using errcode='40001'; end if;
  else
    insert into private.learning_receipt_mappings(id,source_snapshot_id,native_organization_id,native_employee_id,hub_tenant_id,hub_user_id,product_id,state,created_by)
      values(p_mapping_id,p_source_snapshot_id,p_native_organization_id,p_native_employee_id,p_hub_tenant_id,p_hub_user_id,product,'pending',p_actor_id);
    insert into private.audit_events(actor_id,action,entity_type,entity_id,metadata)
      values(p_actor_id,'learning.receipt.mapping.prepared','learning_mapping',p_mapping_id,jsonb_build_object('source_revision',snapshot.source_revision));
  end if;
  return jsonb_build_object('mappingId',p_mapping_id,'organizationId',p_native_organization_id,'employeeId',p_native_employee_id,
    'hubTenantId',p_hub_tenant_id,'hubUserId',p_hub_user_id,'courseId',snapshot.source_course_id,'versionId',snapshot.source_version_id,'sourceRevision',snapshot.source_revision);
end;
$$;

create function hub.set_learning_receipt_mapping_state(p_actor_id uuid,p_session_id uuid,p_mapping_id uuid,p_state text) returns void
language plpgsql security definer set search_path='' as $$
begin
  perform private.require_receipt_command_actor(p_actor_id,p_session_id);
  if p_state not in ('active','revoked') then raise exception 'Invalid mapping state.' using errcode='22023'; end if;
  update private.learning_receipt_mappings m set state=p_state,
    activated_at=case when p_state='active' then coalesce(m.activated_at,now()) else m.activated_at end,
    revoked_at=case when p_state='revoked' then coalesce(m.revoked_at,now()) else null end
    where m.id=p_mapping_id and (p_state='revoked' or m.state<>'revoked')
      and (p_state='revoked' or private.receipt_membership_is_active(m.hub_tenant_id,m.hub_user_id,m.product_id));
  if not found then raise exception 'Mapping unavailable or revoked.' using errcode='40001'; end if;
  insert into private.audit_events(actor_id,action,entity_type,entity_id,metadata)
    values(p_actor_id,'learning.receipt.mapping.'||p_state,'learning_mapping',p_mapping_id,'{}'::jsonb);
end;
$$;

create function hub.ingest_learning_receipt(p_actor_id uuid,p_session_id uuid,p_payload text,p_source_digest text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare receipt jsonb; mapping private.learning_receipt_mappings%rowtype; snapshot private.learning_source_snapshots%rowtype;
  prior private.learning_receipt_inbox%rowtype; head private.learning_receipt_inbox%rowtype; v_event_id uuid; v_assignment_id uuid;
begin
  perform private.require_receipt_command_actor(p_actor_id,p_session_id);
  if p_payload is null or octet_length(p_payload)>100000 or p_source_digest is null
    or p_source_digest !~ '^[0-9a-f]{64}$' or p_source_digest<>encode(extensions.digest(p_payload,'sha256'),'hex') then
    raise exception 'Receipt checksum or size is invalid.' using errcode='22023'; end if;
  begin receipt:=p_payload::jsonb; exception when invalid_text_representation then
    raise exception 'Receipt JSON is invalid.' using errcode='22023'; end;
  if not extensions.jsonb_matches_schema(private.learning_receipt_schema(),receipt) then
    raise exception 'Receipt does not match the source contract.' using errcode='22023'; end if;
  select * into mapping from private.learning_receipt_mappings where id=(receipt->>'mappingId')::uuid for update;
  select * into snapshot from private.learning_source_snapshots where id=mapping.source_snapshot_id;
  if mapping.id is null or snapshot.id is null
    or (receipt->>'kind'='completed' and (mapping.state<>'active'
      or not private.receipt_membership_is_active(mapping.hub_tenant_id,mapping.hub_user_id,mapping.product_id)
      or not private.learning_receipt_identity_active(mapping.native_organization_id,mapping.native_employee_id,mapping.hub_tenant_id,mapping.hub_user_id)))
    or mapping.hub_tenant_id<>(receipt->>'hubTenantId')::uuid or mapping.hub_user_id<>(receipt->>'hubUserId')::uuid
    or snapshot.source_course_id<>(receipt->>'sourceCourseId')::uuid or snapshot.source_version_id<>(receipt->>'sourceVersionId')::uuid
    or snapshot.source_revision<>receipt->>'mappingRevision' then
    raise exception 'Active explicit receipt mapping required.' using errcode='42501'; end if;
  -- No claim that a current source snapshot describes a historical/different policy.
  if snapshot.source_revision<>receipt->>'assignmentRevision' or snapshot.source_revision<>receipt->>'completionRevision' then
    raise exception 'Receipt policy drift requires separate review.' using errcode='40001'; end if;
  v_event_id:=(receipt->>'eventId')::uuid; v_assignment_id:=(receipt->>'assignmentId')::uuid;
  select * into prior from private.learning_receipt_inbox where learning_receipt_inbox.event_id=v_event_id;
  if found then
    if prior.source_digest<>p_source_digest then raise exception 'Receipt event ID was reused.' using errcode='40001'; end if;
    return jsonb_build_object('eventId',v_event_id,'accepted',true,'replayed',true);
  end if;
  -- Serialize different mapping attempts for the same native assignment as well.
  perform pg_advisory_xact_lock(hashtextextended('carebase.assignment.'||v_assignment_id::text,0));
  select * into head from private.learning_receipt_inbox where learning_receipt_inbox.assignment_id=v_assignment_id order by sequence desc limit 1;
  if head.event_id is null then
    -- A trusted withdrawal may arrive before its completion was acknowledged.
    -- Persist its tombstone; an older completion can never resurrect this head.
    if not ((receipt->>'kind'='completed' and (receipt->>'sequence')::integer=1)
      or (receipt->>'kind'='retracted' and (receipt->>'sequence')::integer=2)) then
      raise exception 'Invalid initial receipt sequence.' using errcode='40001'; end if;
  elsif head.mapping_id<>mapping.id or head.kind='retracted' or receipt->>'kind'<>'retracted'
    or (receipt->>'sequence')::integer<>head.sequence+1
    or (head.payload::jsonb - 'eventId' - 'kind' - 'sequence')<>(receipt - 'eventId' - 'kind' - 'sequence') then
    raise exception 'Receipt event is stale or changes immutable completion evidence.' using errcode='40001';
  end if;
  insert into private.learning_receipt_inbox(event_id,mapping_id,assignment_id,sequence,kind,source_digest,payload,accepted_by)
    values(v_event_id,mapping.id,v_assignment_id,(receipt->>'sequence')::integer,receipt->>'kind',p_source_digest,p_payload,p_actor_id);
  insert into private.audit_events(actor_id,action,entity_type,entity_id,metadata)
    values(p_actor_id,'learning.receipt.accepted','learning_receipt',v_event_id,jsonb_build_object('digest',p_source_digest,'kind',receipt->>'kind'));
  return jsonb_build_object('eventId',v_event_id,'accepted',true,'replayed',false);
end;
$$;

create function hub.get_learning_receipt_status(p_actor_id uuid,p_session_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
  perform private.require_receipt_command_actor(p_actor_id,p_session_id);
  return jsonb_build_object('mappings',coalesce((select jsonb_agg(jsonb_build_object('mappingId',m.id,'state',m.state,
    'hubTenantId',m.hub_tenant_id,'hubUserId',m.hub_user_id,'sourceSnapshotId',m.source_snapshot_id) order by m.created_at)
    from (select * from private.learning_receipt_mappings order by created_at desc limit 100) m),'[]'::jsonb),
    'receipts',coalesce((select jsonb_agg(jsonb_build_object('assignmentId',r.assignment_id,'kind',r.kind,'sequence',r.sequence,
      'eventId',r.event_id,'mappingId',r.mapping_id,'completedAt',r.payload::jsonb->>'completedAt') order by r.accepted_at desc)
      from (select * from (select distinct on(assignment_id) * from private.learning_receipt_inbox order by assignment_id,sequence desc) latest
        order by accepted_at desc limit 100) r),'[]'::jsonb),
    'tenants',coalesce((select jsonb_agg(jsonb_build_object('nativeOrganizationId',r.native_organization_id,'hubTenantId',t.hub_tenant_id,'name',h.name))
      from (select distinct native_organization_id,issuer_id,external_tenant_hash from private.learning_employee_bindings order by native_organization_id limit 100) r
      join private.federated_tenants t on t.issuer_id=r.issuer_id and t.external_tenant_hash=r.external_tenant_hash join hub.tenants h on h.id=t.hub_tenant_id),'[]'::jsonb),
    'users',coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'displayName',p.display_name)) from
      (select p.* from hub.profiles p join auth.users u on u.id=p.id where u.deleted_at is null and not coalesce(u.is_anonymous,false)
        and (u.banned_until is null or u.banned_until<=now()) order by p.created_at desc limit 100) p),'[]'::jsonb),
    'snapshots',coalesce((select jsonb_agg(jsonb_build_object('id',s.id,'sourceCourseId',s.source_course_id,'sourceVersionId',s.source_version_id,
      'sourceRevision',s.source_revision,'title',s.source_payload::jsonb->'course'->>'title')) from
      (select distinct on(source_course_id) * from private.learning_source_snapshots where publication_state='published'
        order by source_course_id,sequence desc limit 100) s),'[]'::jsonb),
    'mappingTotal',(select count(*) from private.learning_receipt_mappings),
    'receiptTotal',(select count(distinct assignment_id) from private.learning_receipt_inbox));
end;
$$;
revoke all on function private.learning_receipt_schema(),private.require_receipt_command_actor(uuid,uuid),private.receipt_membership_is_active(uuid,uuid,uuid) from public,anon,authenticated,service_role;
revoke all on function hub.prepare_learning_receipt_mapping(uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid),hub.set_learning_receipt_mapping_state(uuid,uuid,uuid,text),
  hub.provision_learning_receipt_access(uuid,uuid,uuid,uuid,uuid,uuid,text,uuid),
  hub.ingest_learning_receipt(uuid,uuid,text,text),hub.get_learning_receipt_status(uuid,uuid) from public,anon,authenticated;
grant execute on function hub.prepare_learning_receipt_mapping(uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid),hub.set_learning_receipt_mapping_state(uuid,uuid,uuid,text),
  hub.provision_learning_receipt_access(uuid,uuid,uuid,uuid,uuid,uuid,text,uuid),
  hub.ingest_learning_receipt(uuid,uuid,text,text),hub.get_learning_receipt_status(uuid,uuid) to service_role;
