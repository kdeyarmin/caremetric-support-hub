-- Customers change their plan and add-ons inside their own application, never the Hub: the Hub is private to its
-- owner (owner decision 2026-10-31). An application, authenticated by its application key, asks for one of its own
-- linked accounts on behalf of that organization's administrator, whom it has just verified, and the Hub runs the
-- customer center's own quote, confirmation and Checkout flow. This adds that requester beside the Hub customer
-- session, sharing one workspace builder and one confirmation reservation with it.
set local lock_timeout='10s';

-- 1. A quote from an application has no Hub user, SMS session or native connection; it belongs to the application's
-- administrator for that organization instead. Every existing quote keeps its Hub customer identity.
alter table private.customer_billing_quotes
 alter column actor_id drop not null, alter column session_id drop not null, alter column connection_id drop not null,
 add column app_actor text,
 add constraint customer_billing_quotes_requester check(
  (app_actor is null and actor_id is not null and session_id is not null and connection_id is not null)
  or (app_actor is not null and app_actor ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$' and actor_id is null and session_id is null and connection_id is null));
create unique index customer_billing_quotes_app_request on private.customer_billing_quotes(product_id,tenant_id,app_actor,request_key)
 where app_actor is not null;

-- 2. One workspace for both requesters. This is the installed customer_billing_context body after its connection
-- checks, unchanged apart from taking the resolved organization, role and facilities as arguments.
create function private.customer_billing_workspace(p_tenant uuid,p_product uuid,p_connection uuid,p_role text,p_facilities jsonb,p_can_activate boolean) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare s private.billing_subscriptions; sub_count integer; config private.facility_billing_configuration; live boolean;
begin
 perform private.require_hub_app_server();
 if exists(select 1 from hub.products p where p.id=p_product and p.slug='pennsync') then
  raise exception 'PennSync does not accept payments' using errcode='42501';
 end if;
 if not private.hub_application_enabled(p_product) then raise exception 'Application disconnected' using errcode='42501';end if;
 select livemode into live from private.billing_settings;
 select count(*) into sub_count from private.billing_subscriptions where tenant_id=p_tenant and product_id=p_product
  and status not in ('canceled','incomplete_expired') and (live is null or livemode=live);
 if sub_count>1 then raise exception 'Multiple subscriptions need reconciliation before changing this account' using errcode='22023';end if;
 select * into s from private.billing_subscriptions where tenant_id=p_tenant and product_id=p_product
  and status not in ('canceled','incomplete_expired') and (live is null or livemode=live) limit 1;
 select * into config from private.facility_billing_configuration where tenant_id=p_tenant and product_id=p_product;
 return jsonb_build_object('connection_id',p_connection,'tenant_id',p_tenant,'app',(select slug from hub.products where id=p_product),
  'role',p_role,'mode',coalesce(config.mode,'legacy'),'configuration_version',coalesce(config.version,0),
  'billing_revision',coalesce((select version from private.customer_billing_revisions r where r.tenant_id=p_tenant and r.product_id=p_product),0),
  'account_name',(select name from hub.tenants where id=p_tenant),
  'pending_checkout',(select jsonb_build_object('id',q.id,'state',q.state,'due_now',q.quote->'due_now','currency',q.quote->'currency')
    from private.customer_billing_quotes q where q.tenant_id=p_tenant and q.product_id=p_product and q.execution->>'kind'='checkout' and q.state in ('confirming','pending_payment') limit 1),
  'can_activate',p_can_activate,
  'facilities',p_facilities,'customer',(select stripe_customer_id from private.billing_customers where tenant_id=p_tenant and not deleted),
  'subscription',case when s.stripe_subscription_id is null then null else jsonb_build_object('id',s.stripe_subscription_id,'version',s.version,'status',s.status,'current_period_end',s.current_period_end,
    'interval',(select recurring_interval from private.billing_subscription_items where stripe_subscription_id=s.stripe_subscription_id and recurring_interval is not null order by stripe_item_id limit 1),
    'currency',(select currency from private.billing_subscription_items where stripe_subscription_id=s.stripe_subscription_id order by stripe_item_id limit 1),
    'items',coalesce((select jsonb_agg(jsonb_build_object('id',i.stripe_item_id,'price',i.stripe_price_id,'quantity',i.quantity) order by i.stripe_item_id)
     from private.billing_subscription_items i where i.stripe_subscription_id=s.stripe_subscription_id),'[]'::jsonb)) end,
  'allocations',case when config.mode='facility' then coalesce((select jsonb_agg(jsonb_build_object('facility_id',a.facility_id,'facility_name',a.facility_name,'plan',a.plan_price,'addons',to_jsonb(a.addon_prices),
     'version',a.version,'pending_plan',a.pending_plan,'pending_addons',coalesce(to_jsonb(a.pending_addons),'[]'::jsonb),'pending_at',a.pending_at) order by a.facility_id)
    from private.facility_billing_allocations a where a.tenant_id=p_tenant and a.product_id=p_product),'[]'::jsonb)
   else coalesce((select jsonb_agg(jsonb_build_object('facility_id',f->>'id','facility_name',f->>'name',
    'plan',(select i.stripe_price_id from private.billing_subscription_items i join private.billing_products p on p.stripe_product_id=i.stripe_product_id
      where i.stripe_subscription_id=s.stripe_subscription_id and p.kind='plan' limit 1),
    'addons',coalesce((select jsonb_agg(i.stripe_price_id order by i.stripe_price_id) from private.billing_subscription_items i join private.billing_products p on p.stripe_product_id=i.stripe_product_id
      where i.stripe_subscription_id=s.stripe_subscription_id and p.kind='addon'),'[]'::jsonb),'version',0) order by f->>'id') from jsonb_array_elements(p_facilities) f),'[]'::jsonb) end,
  'catalog',coalesce((select jsonb_agg(jsonb_build_object('id',r.stripe_price_id,'product',p.stripe_product_id,'name',p.name,'description',p.description,
    'kind',p.kind,'key',p.entitlement_key,'features',case when jsonb_typeof(p.metadata->'features')='array' then p.metadata->'features' else '[]'::jsonb end,
    'allows_addons',p.entitlement_key='core' or coalesce(p.metadata->>'allows_addons'='true',false),'active',r.active and p.active,
    'amount',r.unit_amount,'currency',r.currency,'interval',r.recurring_interval,'interval_count',r.interval_count,'model',r.pricing_model,'unit_label',p.unit_label)
    order by p.kind,p.name,r.recurring_interval,r.stripe_price_id)
   from private.billing_prices r join private.billing_products p on p.stripe_product_id=r.stripe_product_id
   where p.product_id=p_product and p.kind in ('plan','addon') and r.type='recurring' and r.recurring_interval in ('month','year')
    and r.interval_count=1 and r.unit_amount is not null and r.pricing_model in ('flat','per_unit')
    and (r.tenant_id is null or r.tenant_id=p_tenant) and (live is null or r.livemode=live)
    and (r.active and p.active or exists(select 1 from private.billing_subscription_items i where i.stripe_subscription_id=s.stripe_subscription_id and i.stripe_price_id=r.stripe_price_id))),'[]'::jsonb),
  'loaded_at',now());
end;$$;
revoke all on function private.customer_billing_workspace(uuid,uuid,uuid,text,jsonb,boolean) from public,anon,authenticated,service_role,hub_app_server;

create or replace function private.customer_billing_context(p_connection uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare c private.self_service_connections;
begin
 perform private.require_hub_app_server();
 if not private.current_app_session_verified() then raise exception 'Sign in to continue' using errcode='28000';end if;
 select * into c from private.self_service_connections where id=p_connection and user_id=auth.uid() and revoked_at is null;
 if not found or c.role='member' or not private.is_active_member(c.tenant_id,c.product_id) then raise exception 'Billing access denied' using errcode='42501';end if;
 return private.customer_billing_workspace(c.tenant_id,c.product_id,c.id,c.role,c.facilities,c.role='organization_admin' and c.capabilities ? 'facility.entitlements.v1');
end;$$;

-- 3. One confirmation reservation for both requesters: everything the installed claim does after it has found the
-- requester's quote, locked it and checked the requester may still buy.
create function private.claim_customer_billing_quote_for(q private.customer_billing_quotes,p_organization_admin boolean,p_claim boolean) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v integer;
begin
 perform private.require_hub_app_server();
 if q.state<>'preview' then return jsonb_build_object('id',q.id,'state',q.state,'execution',q.execution,'subscription',q.stripe_subscription_id,'checkout',q.stripe_checkout_id,'schedule',q.stripe_schedule_id,'payment_invoice',q.payment_invoice_id,'payment_request_started_at',q.payment_request_started_at,'confirmed_at',q.confirmed_at,'tenant_id',q.tenant_id,'product_id',q.product_id,'connection_id',q.connection_id);end if;
 if q.expires_at<=now() then raise exception 'Quote expired. Review a new price preview.' using errcode='40001';end if;
 if q.stripe_subscription_id is not null then
  select version into v from private.billing_subscriptions where stripe_subscription_id=q.stripe_subscription_id;
  if v is distinct from q.baseline_version then raise exception 'Subscription changed. Review a new preview.' using errcode='40001';end if;
 end if;
 if p_claim then
  perform pg_advisory_xact_lock(hashtextextended('facility-billing:'||q.tenant_id||':'||q.product_id,0));
  if exists(select 1 from private.billing_usage_reservations where tenant_id=q.tenant_id and product_id=q.product_id and state='pending') then
   raise exception 'A quantity report needs reconciliation before confirming this purchase' using errcode='40001';end if;
  if q.execution->>'kind'='checkout' then
   if not p_organization_admin or q.facility_id is not null then raise exception 'Organization purchasing is required' using errcode='42501';end if;
   perform private.lock_customer_subscription_start(q.tenant_id,q.product_id);
   if exists(select 1 from private.billing_subscriptions where tenant_id=q.tenant_id and product_id=q.product_id and status not in ('canceled','incomplete_expired')) then
    raise exception 'An existing subscription must be resolved first' using errcode='40001';end if;
  end if;
  insert into private.customer_billing_revisions(tenant_id,product_id) values(q.tenant_id,q.product_id) on conflict do nothing;
  select version into v from private.customer_billing_revisions where tenant_id=q.tenant_id and product_id=q.product_id for update;
  if v is distinct from coalesce((q.execution->>'billing_revision')::integer,0) then raise exception 'Another purchase changed this account. Review a new preview.' using errcode='40001';end if;
  update private.customer_billing_revisions set version=version+1 where tenant_id=q.tenant_id and product_id=q.product_id;
  update private.customer_billing_quotes set state='confirming',confirmed_at=now() where id=q.id;
 end if;
 return jsonb_build_object('id',q.id,'state','confirming','execution',q.execution,'subscription',q.stripe_subscription_id,'schedule',q.stripe_schedule_id,'payment_invoice',q.payment_invoice_id,'payment_request_started_at',q.payment_request_started_at,'confirmed_at',coalesce(q.confirmed_at,now()),'tenant_id',q.tenant_id,'product_id',q.product_id,'connection_id',q.connection_id);
end;$$;
revoke all on function private.claim_customer_billing_quote_for(private.customer_billing_quotes,boolean,boolean) from public,anon,authenticated,service_role,hub_app_server;

create or replace function private.claim_customer_billing_quote(p_id uuid,p_claim boolean default true) returns jsonb
language plpgsql security definer set search_path='' as $$
declare q private.customer_billing_quotes; c private.self_service_connections;
begin
 perform private.require_hub_app_server();
 if not private.current_app_session_verified() then raise exception 'Sign in to continue' using errcode='28000';end if;
 select * into q from private.customer_billing_quotes where id=p_id and actor_id=auth.uid() and session_id=(auth.jwt()->>'sms_session_id')::uuid for update;
 if not found then raise exception 'Quote unavailable' using errcode='42501';end if;
 select * into c from private.self_service_connections where id=q.connection_id and user_id=auth.uid() and revoked_at is null;
 if not found or not private.is_active_member(c.tenant_id,c.product_id) or not(c.role='organization_admin' or exists(select 1 from jsonb_array_elements(c.facilities) f where f->>'id'=q.facility_id and f->'permissions' ? 'billing.manage'))
 then raise exception 'Facility purchasing is no longer authorized' using errcode='42501';end if;
 return private.claim_customer_billing_quote_for(q,c.role='organization_admin',p_claim);
end;$$;

-- 4. The application's own linked account, resolved exactly as entitlements and the billing portal resolve it, so a
-- key reaches only its own application's customers. A suspended or closed organization cannot buy.
create function private.app_customer_billing_tenant(p_product uuid,p_account text) returns uuid
language plpgsql stable security definer set search_path='' as $$
declare tenant uuid;
begin
 perform private.require_hub_app_server();
 tenant:=private.billing_resolve_account(p_product,p_account);
 if tenant is null then raise exception 'This account has no CareMetric billing yet.' using errcode='P0002';end if;
 if not exists(select 1 from hub.tenants t where t.id=tenant and t.status='active')
  or exists(select 1 from hub.tenant_products tp where tp.tenant_id=tenant and tp.product_id=p_product and tp.status<>'active')
 then raise exception 'This organization''s CareMetric billing is not active' using errcode='42501';end if;
 return tenant;
end;$$;

-- The facilities the application bills, as it reports them for its organization administrator: unique ids and a name.
create function private.app_customer_billing_context(p_product uuid,p_account text,p_facilities jsonb) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare tenant uuid;
begin
 perform private.require_hub_app_server();
 if jsonb_typeof(p_facilities) is distinct from 'array' or jsonb_array_length(p_facilities)>1000
  or exists(select 1 from jsonb_array_elements(p_facilities) f where jsonb_typeof(f)<>'object'
   or (select array_agg(k order by k) from jsonb_object_keys(f) k) is distinct from array['id','name']
   or jsonb_typeof(f->'id')<>'string' or f->>'id' !~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'
   or jsonb_typeof(f->'name')<>'string' or length(btrim(f->>'name')) not between 1 and 180)
  or jsonb_array_length(p_facilities)<>(select count(distinct f->>'id') from jsonb_array_elements(p_facilities) f)
 then raise exception 'Invalid facility scope' using errcode='22023';end if;
 tenant:=private.app_customer_billing_tenant(p_product,p_account);
 return private.customer_billing_workspace(tenant,p_product,null,'organization_admin',
  coalesce((select jsonb_agg(jsonb_build_object('id',f->>'id','name',btrim(f->>'name'),'permissions','["billing.manage"]'::jsonb) order by n)
   from jsonb_array_elements(p_facilities) with ordinality as site(f,n)),'[]'::jsonb),false);
end;$$;

create function private.app_save_customer_billing_quote(p_product uuid,p_account text,p_actor text,p_id uuid,p_facility text,p_request_key uuid,p_quote jsonb,p_execution jsonb,p_version integer,p_subscription text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare tenant uuid; q private.customer_billing_quotes;
begin
 perform private.require_hub_app_server();
 if p_actor is null or p_actor !~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$' then raise exception 'Invalid administrator' using errcode='22023';end if;
 tenant:=private.app_customer_billing_tenant(p_product,p_account);
 select * into q from private.customer_billing_quotes where product_id=p_product and tenant_id=tenant and app_actor=p_actor and request_key=p_request_key;
 if found then
  if q.facility_id is distinct from p_facility or q.execution->'intent' is distinct from p_execution->'intent' then raise exception 'Quote request changed' using errcode='22023';end if;
  return q.quote;
 end if;
 insert into private.customer_billing_quotes(id,app_actor,tenant_id,product_id,facility_id,request_key,quote,execution,baseline_version,stripe_subscription_id)
 values(p_id,p_actor,tenant,p_product,p_facility,p_request_key,p_quote,p_execution,p_version,p_subscription);
 return p_quote;
end;$$;

-- Only the administrator who reviewed a quote can confirm it, as only the Hub customer who reviewed one can.
create function private.app_claim_customer_billing_quote(p_product uuid,p_account text,p_actor text,p_id uuid,p_claim boolean) returns jsonb
language plpgsql security definer set search_path='' as $$
declare tenant uuid; q private.customer_billing_quotes;
begin
 perform private.require_hub_app_server();
 tenant:=private.app_customer_billing_tenant(p_product,p_account);
 select * into q from private.customer_billing_quotes where id=p_id and tenant_id=tenant and product_id=p_product and app_actor=p_actor for update;
 if not found then raise exception 'Quote unavailable' using errcode='42501';end if;
 return private.claim_customer_billing_quote_for(q,true,p_claim);
end;$$;

-- A pending Checkout belongs to the organization: any of its current administrators can check or cancel it.
create function private.app_customer_checkout_status(p_product uuid,p_account text,p_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare tenant uuid; q private.customer_billing_quotes;
begin
 perform private.require_hub_app_server();
 tenant:=private.app_customer_billing_tenant(p_product,p_account);
 select * into q from private.customer_billing_quotes where id=p_id and tenant_id=tenant and product_id=p_product and execution->>'kind'='checkout' and state<>'preview';
 if not found then raise exception 'Checkout unavailable' using errcode='42501';end if;
 return private.customer_checkout_record(q);
end;$$;

revoke all on function private.app_customer_billing_tenant(uuid,text),private.app_customer_billing_context(uuid,text,jsonb),
 private.app_save_customer_billing_quote(uuid,text,text,uuid,text,uuid,jsonb,jsonb,integer,text),private.app_claim_customer_billing_quote(uuid,text,text,uuid,boolean),
 private.app_customer_checkout_status(uuid,text,uuid) from public,anon,authenticated,service_role,hub_app_server;
grant execute on function private.app_customer_billing_tenant(uuid,text),private.app_customer_billing_context(uuid,text,jsonb),
 private.app_save_customer_billing_quote(uuid,text,text,uuid,text,uuid,jsonb,jsonb,integer,text),private.app_claim_customer_billing_quote(uuid,text,text,uuid,boolean),
 private.app_customer_checkout_status(uuid,text,uuid) to hub_app_server;
