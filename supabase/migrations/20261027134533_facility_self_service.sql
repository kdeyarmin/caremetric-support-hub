-- Customer authority is independent of the owner's administration capabilities.
-- Native apps issue short-lived connection proofs only after checking their own session.
set local lock_timeout='10s';
create table private.self_service_handoffs (
 token_hash text primary key check(token_hash ~ '^[0-9a-f]{64}$'),
 product_id uuid not null references hub.products(id), proof jsonb not null check(jsonb_typeof(proof)='object'),
 expires_at timestamptz not null default now()+interval '5 minutes', consumed_at timestamptz,
 created_at timestamptz not null default now()
);
create table private.self_service_connections (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id),
 tenant_id uuid not null references hub.tenants(id), product_id uuid not null references hub.products(id),
 source_account text not null, source_user text not null,
 role text not null check(role in ('member','facility_admin','organization_admin')),
 facilities jsonb not null default '[]'::jsonb check(jsonb_typeof(facilities)='array'),
 capabilities jsonb not null default '[]'::jsonb check(jsonb_typeof(capabilities)='array'),
 connected_at timestamptz not null default now(), scope_checked_at timestamptz not null default now(), revoked_at timestamptz,
 unique(product_id,source_account,source_user)
);
create index self_service_connections_user on private.self_service_connections(user_id) where revoked_at is null;
create table private.self_service_operations (
 id uuid primary key default gen_random_uuid(), connection_id uuid not null references private.self_service_connections(id),
 user_id uuid not null references auth.users(id), session_id uuid not null references private.sms_sessions(id),
 operation jsonb not null check(jsonb_typeof(operation)='object'), confirmed boolean not null default false,
 result_state text check(result_state in ('succeeded','refused','unavailable')),
 token_hash text unique check(token_hash ~ '^[0-9a-f]{64}$'),
 expires_at timestamptz not null default now()+interval '5 minutes', consumed_at timestamptz,
 created_at timestamptz not null default now()
);
alter table private.self_service_handoffs enable row level security;
alter table private.self_service_connections enable row level security;
alter table private.self_service_operations enable row level security;
revoke all on private.self_service_handoffs,private.self_service_connections,private.self_service_operations from public,anon,authenticated,service_role,hub_app_server;

create function private.issue_self_service_connection(p_product uuid,p_proof jsonb,p_hash text) returns void
language plpgsql security definer set search_path='' as $$
begin
 perform private.require_hub_app_server();
 if p_hash !~ '^[0-9a-f]{64}$' or p_proof->>'account' !~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'
  or p_proof->>'user' !~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$' or p_proof->>'role' not in ('member','facility_admin','organization_admin')
  or jsonb_typeof(p_proof->'facilities') is distinct from 'array' or jsonb_array_length(p_proof->'facilities')>1000
  or jsonb_typeof(p_proof->'capabilities') is distinct from 'array' then raise exception 'Invalid native proof' using errcode='22023';end if;
 insert into private.self_service_handoffs(product_id,proof,token_hash) values(p_product,p_proof,p_hash);
 -- Expired proof text is not retained as a second identity directory.
 delete from private.self_service_handoffs where expires_at<now()-interval '1 day';
end;$$;

create function hub.accept_self_service_connection(p_token_hash text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare proof private.self_service_handoffs; tenant uuid; issuer uuid; prior uuid; connection uuid;
begin
 perform private.require_hub_app_server();
 if not private.current_app_session_verified() then raise exception 'Sign in with an SMS code to link your account' using errcode='28000';end if;
 select * into proof from private.self_service_handoffs where token_hash=p_token_hash and consumed_at is null and expires_at>now() for update;
 if not found then raise exception 'The connection has expired. Open self-service from your application again.' using errcode='42501';end if;
 issuer:=private.billing_issuer(proof.product_id);
 -- One source identity cannot be silently reassigned to a different Hub user.
 select hub_user_id into prior from private.federated_principals where issuer_id=issuer and external_subject_hash=private.support_identity_hash(proof.proof->>'user') for update;
 if prior is not null and prior<>auth.uid() then raise exception 'This application identity is already linked to another Hub account' using errcode='42501';end if;
 tenant:=private.billing_app_tenant(proof.product_id,proof.proof->>'account',proof.proof->>'account_name');
 insert into private.federated_principals(issuer_id,external_subject_hash,hub_user_id)
  values(issuer,private.support_identity_hash(proof.proof->>'user'),auth.uid()) on conflict(issuer_id,external_subject_hash) do update set revoked_at=null,verified_at=now();
 insert into hub.tenant_product_memberships(tenant_id,product_id,user_id,role,case_scope,can_manage_members)
  values(tenant,proof.product_id,auth.uid(),case when proof.proof->>'role'='organization_admin' then 'tenant_admin'::hub.membership_role else 'customer'::hub.membership_role end,'own',false)
  on conflict(tenant_id,product_id,user_id) do update set status='active',revoked_at=null,
   role=excluded.role;
 insert into private.self_service_connections(user_id,tenant_id,product_id,source_account,source_user,role,facilities,capabilities)
  values(auth.uid(),tenant,proof.product_id,proof.proof->>'account',proof.proof->>'user',proof.proof->>'role',proof.proof->'facilities',proof.proof->'capabilities')
  on conflict(product_id,source_account,source_user) do update set role=excluded.role,facilities=excluded.facilities,
   capabilities=excluded.capabilities,connected_at=now(),revoked_at=null
   where private.self_service_connections.user_id=auth.uid() returning id into connection;
 if connection is null then raise exception 'This account is linked elsewhere' using errcode='42501';end if;
 -- Verified native customers can open their first support request without an
 -- operator onboarding step. An explicit existing intake closure is preserved.
 insert into private.case_intake_settings(tenant_id,product_id,enabled,activated_at,activated_by)
  values(tenant,proof.product_id,true,now(),auth.uid()) on conflict(tenant_id,product_id) do nothing;
 update private.self_service_handoffs set consumed_at=now() where token_hash=p_token_hash;
 perform private.billing_audit(auth.uid(),'billing.selfservice.link',tenant,proof.product_id,jsonb_build_object('connection',connection));
 return jsonb_build_object('connection_id',connection);
end;$$;

create function hub.self_service_workspace() returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
 if not private.current_app_session_verified() then raise exception 'Sign in to continue' using errcode='28000';end if;
 return jsonb_build_object('connections',coalesce((select jsonb_agg(jsonb_build_object('id',c.id,'tenant_id',c.tenant_id,'app',p.slug,'name',p.name,'role',c.role,
  'facilities',c.facilities,'capabilities',c.capabilities,'connected_at',c.connected_at) order by p.name,c.id)
  from private.self_service_connections c join hub.products p on p.id=c.product_id
  where c.user_id=auth.uid() and c.revoked_at is null and private.is_active_member(c.tenant_id,c.product_id)),'[]'::jsonb),'loaded_at',now());
end;$$;

create function hub.prepare_self_service_operation(p_connection uuid,p_operation jsonb,p_confirmed boolean default false) returns uuid
language plpgsql security definer set search_path='' as $$
declare c private.self_service_connections; session uuid; op uuid;
begin
 perform private.require_hub_app_server();
 if not private.current_app_session_verified() then raise exception 'Sign in to continue' using errcode='28000';end if;
 select * into c from private.self_service_connections where id=p_connection and user_id=auth.uid() and revoked_at is null;
 if not found or not private.is_active_member(c.tenant_id,c.product_id) then raise exception 'Application access denied' using errcode='42501';end if;
 if p_operation->>'action' not in ('scope.read','profile.read','employees.list','diagnostics.read','recovery.execute','billing.authorize') then raise exception 'Unsupported operation' using errcode='22023';end if;
 if p_operation->>'action' in ('employees.list','recovery.execute','billing.authorize') and c.role='member' then raise exception 'Administrator access required' using errcode='42501';end if;
 session:=(auth.jwt()->>'sms_session_id')::uuid;
 insert into private.self_service_operations(connection_id,user_id,session_id,operation,confirmed)
  values(c.id,auth.uid(),session,p_operation,p_confirmed) returning id into op;
 return op;
end;$$;

create function hub.issue_self_service_operation(p_id uuid,p_hash text,p_confirm boolean default false) returns jsonb
language plpgsql security definer set search_path='' as $$
declare op private.self_service_operations; c private.self_service_connections; result jsonb;
begin
 perform private.require_hub_app_server();
 select * into op from private.self_service_operations where id=p_id and user_id=auth.uid()
  and session_id=(auth.jwt()->>'sms_session_id')::uuid and expires_at>now() and consumed_at is null for update;
 if not found or not private.current_app_session_verified() then raise exception 'Confirmation expired. Review the action again.' using errcode='42501';end if;
 select * into c from private.self_service_connections where id=op.connection_id and user_id=auth.uid() and revoked_at is null;
 if not found or not private.is_active_member(c.tenant_id,c.product_id) then raise exception 'Application access denied' using errcode='42501';end if;
 if op.operation->>'action'='recovery.execute' and not p_confirm then raise exception 'Confirm account recovery first' using errcode='42501';end if;
 if p_hash !~ '^[0-9a-f]{64}$' then raise exception 'Invalid capability' using errcode='22023';end if;
 update private.self_service_operations set token_hash=p_hash,confirmed=true,expires_at=now()+interval '30 seconds' where id=p_id;
 result:=jsonb_build_object('id',op.id,'connection_id',c.id,'app',(select slug from hub.products where id=c.product_id),'operation',op.operation,
  'account',c.source_account,'user',c.source_user,'role',c.role,'facilities',c.facilities);
 perform private.billing_audit(auth.uid(),'billing.selfservice.issue',c.tenant_id,c.product_id,jsonb_build_object('operation',op.id,'action',op.operation->>'action'));
 return result;
end;$$;

create function private.consume_self_service_operation(p_hash text,p_app text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare op private.self_service_operations; c private.self_service_connections;
begin
 perform private.require_hub_app_server();
 select o.* into op from private.self_service_operations o join private.self_service_connections n on n.id=o.connection_id
  join hub.products p on p.id=n.product_id join private.sms_sessions s on s.id=o.session_id
  join private.sms_identities i on i.user_id=s.user_id and i.identity_version=s.identity_version
  join auth.users u on u.id=s.user_id
  where u.deleted_at is null and not u.is_anonymous and (u.banned_until is null or u.banned_until<=now()) and o.token_hash=p_hash and p.slug=p_app and o.confirmed and o.consumed_at is null and o.expires_at>now()
   and s.revoked_at is null and s.expires_at>now() and i.revoked_at is null and n.revoked_at is null
  for update of o;
 if not found then raise exception 'Capability is unavailable' using errcode='42501';end if;
 select * into c from private.self_service_connections where id=op.connection_id;
 if not exists(select 1 from hub.tenant_product_memberships m join hub.tenants t on t.id=m.tenant_id
  where m.user_id=op.user_id and m.tenant_id=c.tenant_id and m.product_id=c.product_id
   and m.status='active' and m.revoked_at is null and t.status='active') then raise exception 'Membership revoked' using errcode='42501';end if;
 update private.self_service_operations set consumed_at=now() where id=op.id;
 return jsonb_build_object('contract_version',1,'app',p_app,'account',c.source_account,'user',c.source_user,'operation',op.operation);
end;$$;

revoke all on function private.issue_self_service_connection(uuid,jsonb,text),private.consume_self_service_operation(text,text) from public,anon,authenticated,service_role;
grant execute on function private.issue_self_service_connection(uuid,jsonb,text),private.consume_self_service_operation(text,text) to hub_app_server;
revoke all on function hub.self_service_workspace(),hub.accept_self_service_connection(text),hub.prepare_self_service_operation(uuid,jsonb,boolean),hub.issue_self_service_operation(uuid,text,boolean) from public,anon,authenticated,service_role;
grant execute on function hub.self_service_workspace(),hub.accept_self_service_connection(text),hub.prepare_self_service_operation(uuid,jsonb,boolean),hub.issue_self_service_operation(uuid,text,boolean) to authenticated;

-- A native account proof plus a verified mobile number provisions customer access without owner work.
alter table private.sms_challenges add column self_service_token_hash text references private.self_service_handoffs(token_hash);
alter table private.sms_challenges add column self_service_phone text;
create function private.start_self_service_challenge(p_hash text,p_phone text,p_client_hash text,p_browser_hash text,p_id uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
 perform private.require_hub_app_server();
 perform pg_advisory_xact_lock(hashtextextended('selfservice-start:'||p_hash,0));
 if p_phone !~ '^\+[1-9][0-9]{7,14}$' or not exists(select 1 from private.self_service_handoffs where token_hash=p_hash and consumed_at is null and expires_at>now())
 then raise exception 'Connection unavailable' using errcode='42501';end if;
 if exists(select 1 from private.sms_challenges where phone_hash=private.support_identity_hash(p_phone) and created_at>now()-interval '30 seconds')
  or (select count(*) from private.sms_challenges where client_hash=p_client_hash and created_at>now()-interval '15 minutes')>=12
  or (select count(*) from private.sms_challenges where self_service_token_hash=p_hash)>=5
 then raise exception 'Please wait before requesting another code' using errcode='42501';end if;
 update private.sms_challenges set consumed_at=now() where self_service_token_hash=p_hash and consumed_at is null;
 insert into private.sms_challenges(id,phone_hash,client_hash,browser_hash,self_service_token_hash,self_service_phone)
  values(p_id,private.support_identity_hash(p_phone),p_client_hash,p_browser_hash,p_hash,p_phone);
end;$$;
create function private.inspect_self_service_challenge(p_id uuid,p_browser_hash text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare c private.sms_challenges;
begin
 perform private.require_hub_app_server();
 select * into c from private.sms_challenges where id=p_id and browser_hash=p_browser_hash and consumed_at is null and expires_at>now()
  and attempts<5 and self_service_token_hash is not null for update;
 if not found then return null;end if;
 update private.sms_challenges set attempts=attempts+1 where id=p_id;
 return jsonb_build_object('provider_id',c.provider_id,'phone',c.self_service_phone);
end;$$;
create function private.complete_self_service_challenge(p_id uuid,p_browser_hash text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare c private.sms_challenges; h private.self_service_handoffs; uid uuid; version uuid;
begin
 perform private.require_hub_app_server();
 select * into c from private.sms_challenges where id=p_id and browser_hash=p_browser_hash and consumed_at is null and expires_at>now()
  and attempts between 1 and 5 and provider_id is not null and self_service_token_hash is not null for update;
 if not found then raise exception 'Challenge unavailable' using errcode='42501';end if;
 select * into h from private.self_service_handoffs where token_hash=c.self_service_token_hash and consumed_at is null and expires_at>now() for update;
 if not found then raise exception 'Connection expired' using errcode='42501';end if;
 perform pg_advisory_xact_lock(hashtextextended('selfservice-phone:'||c.self_service_phone,0));
 select i.user_id,i.identity_version into uid,version from private.usable_sms_identity(c.self_service_phone) i;
 if uid is null then
  if exists(select 1 from private.sms_identities where phone_e164=c.self_service_phone) then raise exception 'Identity unavailable' using errcode='42501';end if;
  uid:=gen_random_uuid();
  insert into auth.users(id,aud,role,raw_user_meta_data,raw_app_meta_data,created_at,updated_at,is_anonymous)
   values(uid,'authenticated','authenticated',jsonb_build_object('display_name',h.proof->>'display_name'),jsonb_build_object('provider','caremetric_sms','providers','[]'::jsonb),now(),now(),false);
  insert into private.sms_identities(user_id,phone_e164,verified_at) values(uid,c.self_service_phone,now()) returning identity_version into version;
 end if;
 update private.sms_challenges set consumed_at=now(),self_service_phone=null where id=p_id;
 return jsonb_build_object('user_id',uid,'identity_version',version,'token_hash',h.token_hash);
end;$$;
revoke all on function private.start_self_service_challenge(text,text,text,text,uuid),private.inspect_self_service_challenge(uuid,text),private.complete_self_service_challenge(uuid,text) from public,anon,authenticated,service_role;
grant execute on function private.start_self_service_challenge(text,text,text,text,uuid),private.inspect_self_service_challenge(uuid,text),private.complete_self_service_challenge(uuid,text) to hub_app_server;

-- Existing private tickets remain private. Only explicitly shared facility cases gain facility visibility.
alter table hub.support_cases add column facility_id text;
alter table hub.support_cases add column facility_name text check(char_length(facility_name)<=180);
alter table hub.support_cases add column facility_shared boolean not null default false;
alter table hub.support_cases add constraint shared_case_needs_facility check(not facility_shared or facility_id is not null);
create index support_cases_facility on hub.support_cases(tenant_id,product_id,facility_id) where facility_shared;
create table private.self_service_case_requests (
 actor_id uuid not null references auth.users(id), request_key uuid not null, facility_id text not null,
 shared boolean not null, case_id uuid references hub.support_cases(id), primary key(actor_id,request_key)
);
alter table private.self_service_case_requests enable row level security;
revoke all on private.self_service_case_requests from public,anon,authenticated,service_role,hub_app_server;

create or replace function private.can_view_case(p_case_id uuid,p_tenant_id uuid,p_product_id uuid,p_requester_id uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select auth.uid() is not null and (
  private.has_staff_permission('case.read',p_product_id) or private.has_staff_permission('case.write',p_product_id)
  or (private.is_active_member(p_tenant_id,p_product_id) and (
   p_requester_id=auth.uid()
   or exists(select 1 from hub.case_participants p where p.case_id=p_case_id and p.user_id=auth.uid() and p.revoked_at is null)
   or exists(select 1 from hub.tenant_product_memberships m where m.user_id=auth.uid() and m.tenant_id=p_tenant_id
    and m.product_id=p_product_id and m.status='active' and m.revoked_at is null and m.case_scope='tenant')
   or exists(select 1 from hub.support_cases s join private.self_service_connections c on c.tenant_id=s.tenant_id and c.product_id=s.product_id
    where s.id=p_case_id and s.facility_shared and c.user_id=auth.uid() and c.revoked_at is null and c.scope_checked_at>now()-interval '1 minute'
     and (c.role='organization_admin' or (c.role='facility_admin' and exists(select 1 from jsonb_array_elements(c.facilities) f
      where f->>'id'=s.facility_id and f->'permissions' ? 'support.manage'))))
  )));
$$;

do $$ declare definition text; begin
 definition:=rtrim(pg_get_viewdef('hub.support_case_queue'::regclass,true),E';\n ');
 execute 'create or replace view hub.support_case_queue with (security_invoker=true) as select q.*,c.facility_id,c.facility_shared,c.facility_name from ('||definition||') q join hub.support_cases c on c.id=q.id';
end;$$;

create function hub.create_facility_support_case(p_tenant_id uuid,p_product_id uuid,p_subject text,p_category hub.case_category,p_priority hub.case_priority,
 p_body text,p_app_version text,p_route text,p_contains_phi boolean,p_request_key uuid,p_facility_id text,p_shared boolean default false)
returns hub.support_case_queue language plpgsql security definer set search_path='' as $$
declare saved private.self_service_case_requests; created hub.support_case_queue; core_key uuid;
begin
 if not private.current_app_session_verified() or p_facility_id is null or p_shared is null
  or not exists(select 1 from private.self_service_connections c,jsonb_array_elements(c.facilities) f
   where c.user_id=auth.uid() and c.tenant_id=p_tenant_id and c.product_id=p_product_id and c.revoked_at is null and c.scope_checked_at>now()-interval '1 minute' and f->>'id'=p_facility_id)
 then raise exception 'This facility is not available for support' using errcode='42501';end if;
 perform pg_advisory_xact_lock(hashtextextended('facility-case:'||auth.uid()||':'||p_request_key,0));
 select * into saved from private.self_service_case_requests where actor_id=auth.uid() and request_key=p_request_key;
 if found and (saved.facility_id<>p_facility_id or saved.shared<>p_shared) then raise exception 'Ticket request scope changed' using errcode='22023';end if;
 core_key:=md5('facility-case:'||p_request_key::text)::uuid;
 select * into created from hub.create_support_case(p_tenant_id,p_product_id,p_subject,p_category,p_priority,p_body,p_app_version,p_route,p_contains_phi,core_key);
 if saved.case_id is null then
  update hub.support_cases set facility_id=p_facility_id,facility_shared=p_shared,facility_name=(
   select f->>'name' from private.self_service_connections c,jsonb_array_elements(c.facilities) f
   where c.user_id=auth.uid() and c.tenant_id=p_tenant_id and c.product_id=p_product_id and c.revoked_at is null and f->>'id'=p_facility_id limit 1)
   where id=created.id and requester_id=auth.uid();
  insert into private.self_service_case_requests(actor_id,request_key,facility_id,shared,case_id) values(auth.uid(),p_request_key,p_facility_id,p_shared,created.id);
 end if;
 select * into created from hub.support_case_queue where id=created.id;
 return created;
end;$$;
revoke all on function hub.create_facility_support_case(uuid,uuid,text,hub.case_category,hub.case_priority,text,text,text,boolean,uuid,text,boolean) from public,anon;
grant execute on function hub.create_facility_support_case(uuid,uuid,text,hub.case_category,hub.case_priority,text,text,text,boolean,uuid,text,boolean) to authenticated;

-- One Stripe subscription per organization/application cadence; allocations explain which
-- facilities selected each item. Prices and all monetary facts remain in the Stripe mirror.
create table private.facility_billing_configuration (
 tenant_id uuid not null references hub.tenants(id), product_id uuid not null references hub.products(id),
 mode text not null default 'legacy' check(mode in ('legacy','facility')), version integer not null default 1,
 primary key(tenant_id,product_id)
);
create table private.facility_billing_allocations (
 tenant_id uuid not null references hub.tenants(id), product_id uuid not null references hub.products(id),
 facility_id text not null, facility_name text not null, plan_price text,
 addon_prices text[] not null default array[]::text[], version integer not null default 1,
 pending_plan text, pending_addons text[], pending_at timestamptz,
 primary key(tenant_id,product_id,facility_id),
 check(plan_price is not null or cardinality(addon_prices)=0)
);
create table private.customer_billing_quotes (
 id uuid primary key, actor_id uuid not null references auth.users(id), session_id uuid not null references private.sms_sessions(id),
 connection_id uuid not null references private.self_service_connections(id), tenant_id uuid not null references hub.tenants(id),
 product_id uuid not null references hub.products(id), facility_id text, request_key uuid not null,
 quote jsonb not null, execution jsonb not null, baseline_version integer not null,
 stripe_subscription_id text, stripe_schedule_id text, stripe_checkout_id text, payment_invoice_id text,
 state text not null default 'preview' check(state in ('preview','confirming','pending_payment','scheduled','applied','failed','superseded')),
 expires_at timestamptz not null default now()+interval '5 minutes', created_at timestamptz not null default now(),
 confirmed_at timestamptz, payment_request_started_at timestamptz, applied_at timestamptz,
 unique(actor_id,request_key)
);
create table private.customer_billing_revisions (
 tenant_id uuid not null references hub.tenants(id) on delete cascade,
 product_id uuid not null references hub.products(id), version integer not null default 0,
 primary key(tenant_id,product_id)
);
alter table private.customer_billing_revisions enable row level security;
revoke all on private.customer_billing_revisions from public,anon,authenticated,service_role,hub_app_server;
alter table private.facility_billing_allocations add column pending_quote_id uuid references private.customer_billing_quotes(id);
create index facility_billing_allocations_pending_quote on private.facility_billing_allocations(pending_quote_id) where pending_quote_id is not null;

create unique index one_customer_billing_change_in_flight on private.customer_billing_quotes(tenant_id,product_id)
 where state in ('confirming','pending_payment');
create index customer_billing_quotes_subscription on private.customer_billing_quotes(stripe_subscription_id,state);
create index customer_billing_quotes_schedule on private.customer_billing_quotes(stripe_schedule_id) where state='scheduled';
alter table private.facility_billing_configuration enable row level security;
alter table private.facility_billing_allocations enable row level security;
alter table private.customer_billing_quotes enable row level security;
revoke all on private.facility_billing_configuration,private.facility_billing_allocations,private.customer_billing_quotes from public,anon,authenticated,service_role,hub_app_server;

create function private.customer_billing_context(p_connection uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare c private.self_service_connections; s private.billing_subscriptions; sub_count integer; config private.facility_billing_configuration; live boolean;
begin
 perform private.require_hub_app_server();
 if not private.current_app_session_verified() then raise exception 'Sign in to continue' using errcode='28000';end if;
 select * into c from private.self_service_connections where id=p_connection and user_id=auth.uid() and revoked_at is null;
 if not found or c.role='member' or not private.is_active_member(c.tenant_id,c.product_id) then raise exception 'Billing access denied' using errcode='42501';end if;
 select livemode into live from private.billing_settings;
 select count(*) into sub_count from private.billing_subscriptions where tenant_id=c.tenant_id and product_id=c.product_id
  and status not in ('canceled','incomplete_expired') and (live is null or livemode=live);
 if sub_count>1 then raise exception 'Multiple subscriptions need reconciliation before changing this account' using errcode='22023';end if;
 select * into s from private.billing_subscriptions where tenant_id=c.tenant_id and product_id=c.product_id
  and status not in ('canceled','incomplete_expired') and (live is null or livemode=live) limit 1;
 select * into config from private.facility_billing_configuration where tenant_id=c.tenant_id and product_id=c.product_id;
 return jsonb_build_object('connection_id',c.id,'tenant_id',c.tenant_id,'app',(select slug from hub.products where id=c.product_id),
  'role',c.role,'mode',coalesce(config.mode,'legacy'),'configuration_version',coalesce(config.version,0),
  'billing_revision',coalesce((select version from private.customer_billing_revisions r where r.tenant_id=c.tenant_id and r.product_id=c.product_id),0),
  'can_activate',c.role='organization_admin' and c.capabilities ? 'facility.entitlements.v1',
  'facilities',c.facilities,'customer',(select stripe_customer_id from private.billing_customers where tenant_id=c.tenant_id and not deleted),
  'subscription',case when s.stripe_subscription_id is null then null else jsonb_build_object('id',s.stripe_subscription_id,'version',s.version,'status',s.status,'current_period_end',s.current_period_end,
    'interval',(select recurring_interval from private.billing_subscription_items where stripe_subscription_id=s.stripe_subscription_id and recurring_interval is not null order by stripe_item_id limit 1),
    'currency',(select currency from private.billing_subscription_items where stripe_subscription_id=s.stripe_subscription_id order by stripe_item_id limit 1),
    'items',coalesce((select jsonb_agg(jsonb_build_object('id',i.stripe_item_id,'price',i.stripe_price_id,'quantity',i.quantity) order by i.stripe_item_id)
     from private.billing_subscription_items i where i.stripe_subscription_id=s.stripe_subscription_id),'[]'::jsonb)) end,
  'allocations',case when config.mode='facility' then coalesce((select jsonb_agg(jsonb_build_object('facility_id',a.facility_id,'facility_name',a.facility_name,'plan',a.plan_price,'addons',to_jsonb(a.addon_prices),
     'version',a.version,'pending_plan',a.pending_plan,'pending_addons',to_jsonb(a.pending_addons),'pending_at',a.pending_at) order by a.facility_id)
    from private.facility_billing_allocations a where a.tenant_id=c.tenant_id and a.product_id=c.product_id),'[]'::jsonb)
   else coalesce((select jsonb_agg(jsonb_build_object('facility_id',f->>'id','facility_name',f->>'name',
    'plan',(select i.stripe_price_id from private.billing_subscription_items i join private.billing_products p on p.stripe_product_id=i.stripe_product_id
      where i.stripe_subscription_id=s.stripe_subscription_id and p.kind='plan' limit 1),
    'addons',coalesce((select jsonb_agg(i.stripe_price_id order by i.stripe_price_id) from private.billing_subscription_items i join private.billing_products p on p.stripe_product_id=i.stripe_product_id
      where i.stripe_subscription_id=s.stripe_subscription_id and p.kind='addon'),'[]'::jsonb),'version',0) order by f->>'id') from jsonb_array_elements(c.facilities) f),'[]'::jsonb) end,
  'catalog',coalesce((select jsonb_agg(jsonb_build_object('id',r.stripe_price_id,'product',p.stripe_product_id,'name',p.name,'description',p.description,
    'kind',p.kind,'key',p.entitlement_key,'features',case when jsonb_typeof(p.metadata->'features')='array' then p.metadata->'features' else '[]'::jsonb end,
    'allows_addons',p.entitlement_key='core' or p.metadata->>'allows_addons'='true','active',r.active and p.active,
    'amount',r.unit_amount,'currency',r.currency,'interval',r.recurring_interval,'interval_count',r.interval_count,'model',r.pricing_model,'unit_label',p.unit_label)
    order by p.kind,p.name,r.recurring_interval,r.stripe_price_id)
   from private.billing_prices r join private.billing_products p on p.stripe_product_id=r.stripe_product_id
   where p.product_id=c.product_id and p.kind in ('plan','addon') and r.type='recurring' and r.recurring_interval in ('month','year')
    and r.interval_count=1 and r.unit_amount is not null and r.pricing_model in ('flat','per_unit')
    and (r.tenant_id is null or r.tenant_id=c.tenant_id) and (live is null or r.livemode=live)
    and (r.active and p.active or exists(select 1 from private.billing_subscription_items i where i.stripe_subscription_id=s.stripe_subscription_id and i.stripe_price_id=r.stripe_price_id))),'[]'::jsonb),
  'loaded_at',now());
end;$$;

-- A source outage removes cached delegated authority while preserving the user's own historical cases.
create function private.refresh_self_service_scope(p_connection uuid,p_proof jsonb) returns void
language plpgsql security definer set search_path='' as $$
declare c private.self_service_connections; refreshed_role text;
begin
 perform private.require_hub_app_server();
 if not private.current_app_session_verified() then raise exception 'Sign in to continue' using errcode='28000';end if;
 select * into c from private.self_service_connections where id=p_connection and user_id=auth.uid() and revoked_at is null for update;
 if not found then raise exception 'Connection unavailable' using errcode='42501';end if;
 if p_proof is not null and (p_proof->>'user' is distinct from c.source_user or p_proof->>'account' is distinct from c.source_account
   or p_proof->>'role' not in ('member','facility_admin','organization_admin') or jsonb_typeof(p_proof->'facilities')<>'array')
 then raise exception 'Native identity changed. Reconnect from the application.' using errcode='42501';end if;
 refreshed_role:=coalesce(p_proof->>'role','member');
 update private.self_service_connections set role=refreshed_role,facilities=coalesce(p_proof->'facilities','[]'::jsonb),
  capabilities=coalesce(p_proof->'capabilities',capabilities),scope_checked_at=now() where id=c.id;
 update hub.tenant_product_memberships set role=case when refreshed_role='organization_admin' then 'tenant_admin'::hub.membership_role else 'customer'::hub.membership_role end
  where tenant_id=c.tenant_id and product_id=c.product_id and user_id=c.user_id and status='active' and revoked_at is null;
end;$$;
revoke all on function private.refresh_self_service_scope(uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function private.refresh_self_service_scope(uuid,jsonb) to hub_app_server;

create function private.record_self_service_result(p_operation uuid,p_state text) returns void
language plpgsql security definer set search_path='' as $$
declare op private.self_service_operations; c private.self_service_connections;
begin
 perform private.require_hub_app_server();
 if p_state not in ('succeeded','refused','unavailable') then raise exception 'Invalid action result' using errcode='22023';end if;
 select * into op from private.self_service_operations where id=p_operation and token_hash is not null for update;
 if not found or op.result_state is not null then return;end if;
 select * into c from private.self_service_connections where id=op.connection_id;
 update private.self_service_operations set result_state=p_state where id=op.id;
 perform private.billing_audit(op.user_id,'billing.selfservice.'||p_state,c.tenant_id,c.product_id,jsonb_build_object('operation',op.id,'action',op.operation->>'action'));
end;$$;
revoke all on function private.record_self_service_result(uuid,text) from public,anon,authenticated,service_role;
grant execute on function private.record_self_service_result(uuid,text) to hub_app_server;

create function private.activate_facility_billing(p_connection uuid,p_expected_version integer,p_allocations jsonb) returns void
language plpgsql security definer set search_path='' as $$
declare c private.self_service_connections; config private.facility_billing_configuration; a jsonb;
begin
 perform private.require_hub_app_server();
 if not private.current_app_session_verified() then raise exception 'Sign in to continue' using errcode='28000';end if;
 select * into c from private.self_service_connections where id=p_connection and user_id=auth.uid() and revoked_at is null;
 if not found or c.role<>'organization_admin' or not c.capabilities ? 'facility.entitlements.v1' or not private.is_active_member(c.tenant_id,c.product_id)
 then raise exception 'A verified facility entitlement integration is required' using errcode='42501';end if;
 perform pg_advisory_xact_lock(hashtextextended('facility-billing:'||c.tenant_id||':'||c.product_id,0));
 select * into config from private.facility_billing_configuration where tenant_id=c.tenant_id and product_id=c.product_id for update;
 if coalesce(config.version,0)<>p_expected_version or coalesce(config.mode,'legacy')<>'legacy' then raise exception 'Billing changed. Refresh first.' using errcode='40001';end if;
 if jsonb_typeof(p_allocations)<>'array' or jsonb_array_length(p_allocations)<>jsonb_array_length(c.facilities) then raise exception 'Complete facility allocation required' using errcode='22023';end if;
 for a in select * from jsonb_array_elements(p_allocations) loop
  if not exists(select 1 from jsonb_array_elements(c.facilities) f where f->>'id'=a->>'facility_id') then raise exception 'Unknown facility' using errcode='42501';end if;
  insert into private.facility_billing_allocations(tenant_id,product_id,facility_id,facility_name,plan_price,addon_prices)
   values(c.tenant_id,c.product_id,a->>'facility_id',a->>'facility_name',a->>'plan',array(select jsonb_array_elements_text(a->'addons')));
 end loop;
 insert into private.facility_billing_configuration(tenant_id,product_id,mode) values(c.tenant_id,c.product_id,'facility')
 on conflict(tenant_id,product_id) do update set mode='facility',version=private.facility_billing_configuration.version+1;
 perform private.billing_audit(auth.uid(),'billing.facility.activate',c.tenant_id,c.product_id,jsonb_build_object('facilities',jsonb_array_length(p_allocations)));
end;$$;

create function private.save_customer_billing_quote(p_id uuid,p_connection uuid,p_facility text,p_request_key uuid,p_quote jsonb,p_execution jsonb,p_version integer,p_subscription text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare c private.self_service_connections; q private.customer_billing_quotes;
begin
 perform private.require_hub_app_server();
 if not private.current_app_session_verified() then raise exception 'Sign in to continue' using errcode='28000';end if;
 select * into c from private.self_service_connections where id=p_connection and user_id=auth.uid() and revoked_at is null;
 if not found or not private.is_active_member(c.tenant_id,c.product_id) or not(c.role='organization_admin' or exists(select 1 from jsonb_array_elements(c.facilities) f where f->>'id'=p_facility and f->'permissions' ? 'billing.manage'))
 then raise exception 'Facility purchasing is not authorized' using errcode='42501';end if;
 select * into q from private.customer_billing_quotes where actor_id=auth.uid() and request_key=p_request_key;
 if found then
  if q.connection_id<>p_connection or q.facility_id is distinct from p_facility or q.execution->'intent' is distinct from p_execution->'intent' then raise exception 'Quote request changed' using errcode='22023';end if;
  return q.quote;
 end if;
 insert into private.customer_billing_quotes(id,actor_id,session_id,connection_id,tenant_id,product_id,facility_id,request_key,quote,execution,baseline_version,stripe_subscription_id)
 values(p_id,auth.uid(),(auth.jwt()->>'sms_session_id')::uuid,p_connection,c.tenant_id,c.product_id,p_facility,p_request_key,p_quote,p_execution,p_version,p_subscription);
 return p_quote;
end;$$;

create function private.claim_customer_billing_quote(p_id uuid,p_claim boolean default true) returns jsonb
language plpgsql security definer set search_path='' as $$
declare q private.customer_billing_quotes; c private.self_service_connections; v integer;
begin
 perform private.require_hub_app_server();
 if not private.current_app_session_verified() then raise exception 'Sign in to continue' using errcode='28000';end if;
 select * into q from private.customer_billing_quotes where id=p_id and actor_id=auth.uid() and session_id=(auth.jwt()->>'sms_session_id')::uuid for update;
 if not found then raise exception 'Quote unavailable' using errcode='42501';end if;
 select * into c from private.self_service_connections where id=q.connection_id and user_id=auth.uid() and revoked_at is null;
 if not found or not private.is_active_member(c.tenant_id,c.product_id) or not(c.role='organization_admin' or exists(select 1 from jsonb_array_elements(c.facilities) f where f->>'id'=q.facility_id and f->'permissions' ? 'billing.manage'))
 then raise exception 'Facility purchasing is no longer authorized' using errcode='42501';end if;
 if q.state<>'preview' then return jsonb_build_object('id',q.id,'state',q.state,'execution',q.execution,'subscription',q.stripe_subscription_id,'schedule',q.stripe_schedule_id,'payment_invoice',q.payment_invoice_id,'payment_request_started_at',q.payment_request_started_at,'confirmed_at',q.confirmed_at,'tenant_id',q.tenant_id,'product_id',q.product_id,'connection_id',q.connection_id);end if;
 if q.expires_at<=now() then raise exception 'Quote expired. Review a new price preview.' using errcode='40001';end if;
 if q.stripe_subscription_id is not null then
  select version into v from private.billing_subscriptions where stripe_subscription_id=q.stripe_subscription_id;
  if v is distinct from q.baseline_version then raise exception 'Subscription changed. Review a new preview.' using errcode='40001';end if;
 end if;
 if p_claim then
  insert into private.customer_billing_revisions(tenant_id,product_id) values(q.tenant_id,q.product_id) on conflict do nothing;
  select version into v from private.customer_billing_revisions where tenant_id=q.tenant_id and product_id=q.product_id for update;
  if v is distinct from coalesce((q.execution->>'billing_revision')::integer,0) then raise exception 'Another purchase changed this account. Review a new preview.' using errcode='40001';end if;
  update private.customer_billing_revisions set version=version+1 where tenant_id=q.tenant_id and product_id=q.product_id;
  update private.customer_billing_quotes set state='confirming',confirmed_at=now() where id=q.id;
 end if;
 return jsonb_build_object('id',q.id,'state','confirming','execution',q.execution,'subscription',q.stripe_subscription_id,'schedule',q.stripe_schedule_id,'payment_invoice',q.payment_invoice_id,'payment_request_started_at',q.payment_request_started_at,'confirmed_at',coalesce(q.confirmed_at,now()),'tenant_id',q.tenant_id,'product_id',q.product_id,'connection_id',q.connection_id);
end;$$;

create function private.mark_customer_purchase_started(p_id uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
 perform private.require_hub_app_server();
 update private.customer_billing_quotes set payment_request_started_at=coalesce(payment_request_started_at,now())
  where id=p_id and state in ('confirming','pending_payment');
 if not found then raise exception 'Purchase not pending' using errcode='42501';end if;
end;$$;
revoke all on function private.mark_customer_purchase_started(uuid) from public,anon,authenticated,service_role;
grant execute on function private.mark_customer_purchase_started(uuid) to hub_app_server;

-- Bind payment to the invoice returned by this immutable, idempotent purchase.
-- A later unrelated paid invoice cannot activate a pending purchase.
create function private.record_customer_payment_invoice(p_id uuid,p_invoice text) returns void
language plpgsql security definer set search_path='' as $$
declare q private.customer_billing_quotes;
begin
 perform private.require_hub_app_server();
 if p_invoice is null or p_invoice !~ '^in_[A-Za-z0-9]{1,250}$' then raise exception 'Invalid payment receipt' using errcode='22023';end if;
 select * into q from private.customer_billing_quotes where id=p_id for update;
 if not found or q.state not in ('confirming','pending_payment') then raise exception 'Purchase not pending' using errcode='42501';end if;
 if q.payment_invoice_id is not null and q.payment_invoice_id<>p_invoice then raise exception 'Payment receipt changed' using errcode='40001';end if;
 update private.customer_billing_quotes set payment_invoice_id=p_invoice where id=p_id;
end;$$;
revoke all on function private.record_customer_payment_invoice(uuid,text) from public,anon,authenticated,service_role;
grant execute on function private.record_customer_payment_invoice(uuid,text) to hub_app_server;

-- Provider receipts, rather than the browser success page, commit purchased facility access.
create function private.settle_customer_billing_quote(p_id uuid,p_state text,p_subscription text default null,p_schedule text default null,p_checkout text default null) returns void
language plpgsql security definer set search_path='' as $$
declare q private.customer_billing_quotes; a jsonb; prior_id uuid;
begin
 perform private.require_hub_app_server();
 if p_state not in ('pending_payment','scheduled','applied','failed','superseded') then raise exception 'Invalid quote outcome' using errcode='22023';end if;
 select * into q from private.customer_billing_quotes where id=p_id for update;
 if not found or q.state in ('applied','failed','superseded') then return;end if;
 if q.state=p_state and (p_schedule is null or q.stripe_schedule_id=p_schedule) then return;end if;
 if q.state='preview' then raise exception 'Quote has not been confirmed' using errcode='42501';end if;
 if p_state='scheduled' or p_state='applied' and coalesce((q.execution->>'cancelSchedule')::boolean,false) then
  for prior_id in update private.customer_billing_quotes set state='superseded'
   where tenant_id=q.tenant_id and product_id=q.product_id and id<>q.id and state='scheduled' returning id loop
   perform private.billing_audit(q.actor_id,'billing.customer.superseded',q.tenant_id,q.product_id,jsonb_build_object('quote',prior_id,'replacement',q.id));
  end loop;
  update private.facility_billing_allocations set pending_plan=null,pending_addons=null,pending_at=null,pending_quote_id=null where tenant_id=q.tenant_id and product_id=q.product_id;
 elsif p_state in ('failed','superseded') then
  update private.facility_billing_allocations set pending_plan=null,pending_addons=null,pending_at=null,pending_quote_id=null where pending_quote_id=q.id;
 end if;
 if p_state in ('applied','scheduled') and q.execution->>'mode'='facility' then
  for a in select * from jsonb_array_elements(case when p_state='applied' then q.execution->'next' else q.execution->'immediate' end) loop
   insert into private.facility_billing_allocations(tenant_id,product_id,facility_id,facility_name,plan_price,addon_prices)
    values(q.tenant_id,q.product_id,a->>'facility_id',a->>'facility_name',a->>'plan',array(select jsonb_array_elements_text(a->'addons')))
    on conflict(tenant_id,product_id,facility_id) do update set plan_price=excluded.plan_price,addon_prices=excluded.addon_prices,version=private.facility_billing_allocations.version+1;
  end loop;
  if p_state='scheduled' then
   for a in select * from jsonb_array_elements(q.execution->'next') loop
    update private.facility_billing_allocations set pending_plan=a->>'plan',pending_addons=array(select jsonb_array_elements_text(a->'addons')),pending_at=(q.execution->>'renewal')::timestamptz,pending_quote_id=q.id
     where tenant_id=q.tenant_id and product_id=q.product_id and facility_id=a->>'facility_id';
   end loop;
  else update private.facility_billing_allocations set pending_plan=null,pending_addons=null,pending_at=null,pending_quote_id=null where pending_quote_id=q.id;end if;
 end if;
 update private.customer_billing_quotes set state=p_state,stripe_subscription_id=coalesce(p_subscription,stripe_subscription_id),
  stripe_schedule_id=coalesce(p_schedule,stripe_schedule_id),stripe_checkout_id=coalesce(p_checkout,stripe_checkout_id),applied_at=case when p_state='applied' then now() else null end where id=p_id;
 perform private.billing_audit(q.actor_id,'billing.customer.'||p_state,q.tenant_id,q.product_id,jsonb_build_object('quote',q.id));
end;$$;

create function private.customer_quotes_for_subscription(p_subscription text) returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
 perform private.require_hub_app_server();
 return coalesce((select jsonb_agg(jsonb_build_object('id',q.id,'state',q.state,'execution',q.execution,'schedule',q.stripe_schedule_id,'payment_invoice',q.payment_invoice_id,'payment_request_started_at',q.payment_request_started_at,'confirmed_at',q.confirmed_at) order by q.created_at)
  from private.customer_billing_quotes q where q.stripe_subscription_id=p_subscription and q.state in ('confirming','pending_payment','scheduled')),'[]'::jsonb);
end;$$;

revoke all on function private.customer_billing_context(uuid),private.activate_facility_billing(uuid,integer,jsonb),private.save_customer_billing_quote(uuid,uuid,text,uuid,jsonb,jsonb,integer,text),private.claim_customer_billing_quote(uuid,boolean),private.settle_customer_billing_quote(uuid,text,text,text,text),private.customer_quotes_for_subscription(text) from public,anon,authenticated,service_role;
grant execute on function private.customer_billing_context(uuid),private.activate_facility_billing(uuid,integer,jsonb),private.save_customer_billing_quote(uuid,uuid,text,uuid,jsonb,jsonb,integer,text),private.claim_customer_billing_quote(uuid,boolean),private.settle_customer_billing_quote(uuid,text,text,text,text),private.customer_quotes_for_subscription(text) to hub_app_server;

-- Contract publication is last: older clients remain compatible while new clients require these objects.
do $$ declare contract jsonb; signature text; relation_name text; begin
 select hub.get_backend_contract() into contract;
 foreach relation_name in array array['private.self_service_handoffs','private.self_service_connections','private.self_service_operations','private.facility_billing_allocations','private.customer_billing_quotes'] loop
  if not exists(select 1 from pg_class where oid=to_regclass(relation_name) and relrowsecurity)
   or has_table_privilege('authenticated',relation_name,'SELECT,INSERT,UPDATE,DELETE') or has_table_privilege('anon',relation_name,'SELECT,INSERT,UPDATE,DELETE')
  then raise exception 'Self-service state must remain private' using errcode='55000';end if;
 end loop;
 foreach signature in array array['private.consume_self_service_operation(text,text)','private.claim_customer_billing_quote(uuid,boolean)','private.mark_customer_purchase_started(uuid)','private.record_customer_payment_invoice(uuid,text)','private.settle_customer_billing_quote(uuid,text,text,text,text)'] loop
  if to_regprocedure(signature) is null or has_function_privilege('authenticated',signature,'EXECUTE') or has_function_privilege('anon',signature,'EXECUTE')
  then raise exception 'Self-service service functions must remain closed' using errcode='55000';end if;
 end loop;
 if not (contract->'features' @> '["customer.self-service.v1"]'::jsonb) then contract:=jsonb_set(contract,'{features}',(contract->'features')||'["customer.self-service.v1"]'::jsonb);end if;
 execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L','select '||quote_literal(contract::text)||'::jsonb');
end $$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon,authenticated;
