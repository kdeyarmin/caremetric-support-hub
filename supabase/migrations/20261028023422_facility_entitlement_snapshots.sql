-- Native applications consume one application/account-bound, consistent facility snapshot.
-- Legacy organizations retain their existing contract and entitlement behavior.
create table private.facility_entitlement_revisions (
 tenant_id uuid not null references hub.tenants(id) on delete cascade,
 product_id uuid not null references hub.products(id),
 revision bigint not null default 1 check(revision>0),
 primary key(tenant_id,product_id)
);
alter table private.facility_entitlement_revisions enable row level security;
revoke all on private.facility_entitlement_revisions from public,anon,authenticated,service_role,hub_app_server;

create function private.bump_facility_entitlement_revision() returns trigger
language plpgsql security definer set search_path='' as $$
declare tenant uuid; product uuid;
begin
 if tg_op='DELETE' then tenant:=old.tenant_id;product:=old.product_id;else tenant:=new.tenant_id;product:=new.product_id;end if;
 if product is not null and exists(select 1 from hub.tenants where id=tenant)
  and exists(select 1 from hub.products where id=product and slug in ('carebase','breathe','pennsync','caremetric-emr','caremetric-intel')) then
  insert into private.facility_entitlement_revisions(tenant_id,product_id) values(tenant,product)
   on conflict(tenant_id,product_id) do update set revision=private.facility_entitlement_revisions.revision+1;
 end if;
 if tg_op='DELETE' then return old;else return new;end if;
end;$$;
revoke all on function private.bump_facility_entitlement_revision() from public,anon,authenticated,service_role,hub_app_server;
create trigger facility_entitlement_configuration_revision after insert or update or delete on private.facility_billing_configuration
 for each row execute function private.bump_facility_entitlement_revision();
create trigger facility_entitlement_allocation_revision after insert or update or delete on private.facility_billing_allocations
 for each row execute function private.bump_facility_entitlement_revision();
-- Every supported mirror write updates the subscription before replacing its items in one transaction.
create trigger facility_entitlement_subscription_revision after insert or update or delete on private.billing_subscriptions
 for each row execute function private.bump_facility_entitlement_revision();

create function private.scoped_app_billing_entitlements(p_product uuid,p_account text) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare tenant uuid; answer jsonb; mode text; revision bigint;
begin
 perform private.require_hub_app_server();
 answer:=private.billing_app_entitlements(p_product,p_account);
 if (select slug from hub.products where id=p_product)='caremetric-go' then return answer;end if;
 tenant:=private.billing_resolve_account(p_product,p_account);
 select c.mode into mode from private.facility_billing_configuration c where c.tenant_id=tenant and c.product_id=p_product;
 select r.revision into revision from private.facility_entitlement_revisions r where r.tenant_id=tenant and r.product_id=p_product;
 if mode='facility' then answer:=answer||jsonb_build_object('organization_status',answer->>'status','status','incomplete','entitled',false,'products','[]'::jsonb);end if;
 return answer||jsonb_build_object('account',p_account,'billing_mode',coalesce(mode,'legacy'),'billing_revision',coalesce(revision,0),'checked_at',now());
end;$$;

create function private.facility_billing_products(p_tenant uuid,p_product uuid,p_facility text,p_base jsonb) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare allocation private.facility_billing_allocations; selected text[]; result jsonb;
begin
 select * into allocation from private.facility_billing_allocations where tenant_id=p_tenant and product_id=p_product and facility_id=p_facility;
 if not found or allocation.plan_price is null or not coalesce((p_base->>'entitled')::boolean,false) then return '[]'::jsonb;end if;
 selected:=array_prepend(allocation.plan_price,allocation.addon_prices);
 if cardinality(selected)<>(select count(distinct id) from unnest(selected) id) then return '[]'::jsonb;end if;
 -- A facility allocation cannot lend its paid quantity to another facility or application.
 with items as (
  select i.stripe_price_id,p.entitlement_key,p.kind,p.unit_label,p.metadata,r.pricing_model,sum(i.quantity) as quantity
  from private.billing_subscription_items i join private.billing_products p on p.stripe_product_id=i.stripe_product_id
  join private.billing_prices r on r.stripe_price_id=i.stripe_price_id
  where i.stripe_price_id=any(selected) and p.product_id=p_product
   and i.stripe_subscription_id in(select product->>'subscription' from jsonb_array_elements(p_base->'products') product)
  group by i.stripe_price_id,p.entitlement_key,p.kind,p.unit_label,p.metadata,r.pricing_model
 ), valid as (
  select i.* from items i
  where (i.stripe_price_id=allocation.plan_price and i.kind='plan' or i.stripe_price_id<>allocation.plan_price and i.kind='addon')
   and i.pricing_model in ('flat','per_unit') and (i.pricing_model='flat' or i.unit_label in ('facility','facilities'))
   and i.quantity>=case when i.pricing_model='flat' then 1 else
    (select count(*) from private.facility_billing_allocations a where a.tenant_id=p_tenant and a.product_id=p_product
      and (a.plan_price=i.stripe_price_id or i.stripe_price_id=any(a.addon_prices))) end
 ) select case when count(*)=cardinality(selected) then jsonb_agg(jsonb_build_object('key',entitlement_key,'kind',kind,'quantity',1,
    'unit_label',unit_label,'package_id',coalesce(metadata->>'package_id','')) order by kind,stripe_price_id) else '[]'::jsonb end
 into result from valid;
 return coalesce(result,'[]'::jsonb);
end;$$;
revoke all on function private.facility_billing_products(uuid,uuid,text,jsonb) from public,anon,authenticated,service_role,hub_app_server;

create function private.app_facility_entitlement_snapshot(p_product uuid,p_account text,p_facilities jsonb) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare tenant uuid; base jsonb; mode text; revision bigint; result jsonb; app text;
begin
 perform private.require_hub_app_server();
 select slug into app from hub.products where id=p_product;
 if app not in ('carebase','breathe','pennsync','caremetric-emr','caremetric-intel') then raise exception 'Facility billing is unavailable for this application' using errcode='42501';end if;
 if p_account is null or p_account !~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$' or jsonb_typeof(p_facilities) is distinct from 'array' then raise exception 'Invalid facility scope' using errcode='22023';end if;
 if jsonb_array_length(p_facilities)>1000
  or exists(select 1 from jsonb_array_elements(p_facilities) id where jsonb_typeof(id)<>'string' or id#>>'{}' !~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$')
  or jsonb_array_length(p_facilities)<>(select count(distinct id) from jsonb_array_elements_text(p_facilities) id) then raise exception 'Invalid facility scope' using errcode='22023';end if;
 tenant:=private.billing_resolve_account(p_product,p_account);
 base:=private.billing_app_entitlements(p_product,p_account);
 select c.mode into mode from private.facility_billing_configuration c where c.tenant_id=tenant and c.product_id=p_product;
 select r.revision into revision from private.facility_entitlement_revisions r where r.tenant_id=tenant and r.product_id=p_product;
 select coalesce(jsonb_agg(jsonb_build_object('id',id,'entitled',coalesce((base->>'entitled')::boolean,false) and jsonb_array_length(products)>0,
  'status',case when not coalesce((base->>'entitled')::boolean,false) then base->>'status' when jsonb_array_length(products)=0 then 'none' else base->>'status' end,
  'products',products) order by id),'[]'::jsonb) into result
 from (select id,case when mode='facility' then private.facility_billing_products(tenant,p_product,id,base)
  else coalesce((select jsonb_agg(jsonb_build_object('key',product->>'key','kind',product->>'kind','quantity',1,
    'unit_label',coalesce(product->>'unit_label',''),'package_id',coalesce(product->>'package_id','')))
    from jsonb_array_elements(base->'products') product where product->>'kind' in ('plan','addon')),'[]'::jsonb) end as products
  from jsonb_array_elements_text(p_facilities) id) scoped;
 return jsonb_build_object('contract','caremetric.facility-entitlements.v1','app',app,'account',p_account,'billing_mode',coalesce(mode,'legacy'),
  'revision',coalesce(revision,0),'checked_at',now(),'cache_ttl_seconds',300,'facilities',result);
end;$$;

revoke all on function private.scoped_app_billing_entitlements(uuid,text),private.app_facility_entitlement_snapshot(uuid,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function private.scoped_app_billing_entitlements(uuid,text),private.app_facility_entitlement_snapshot(uuid,text,jsonb) to hub_app_server;

-- Native quantity reports must not rewrite a facility's independently selected plan.
alter table private.billing_usage_reports drop constraint billing_usage_reports_outcome_check;
alter table private.billing_usage_reports add constraint billing_usage_reports_outcome_check
 check(outcome in ('updated','unchanged','no_subscription','failed','facility_managed'));
create table private.billing_usage_reservations (
 product_id uuid not null references hub.products(id), request_key uuid not null,
 tenant_id uuid not null references hub.tenants(id) on delete cascade,
 metric text not null, quantity integer not null check(quantity between 0 and 1000000),
 targets jsonb not null, state text not null default 'pending' check(state in ('pending','completed')),
 created_at timestamptz not null default now(),
 primary key(product_id,request_key)
);
create unique index one_pending_billing_usage on private.billing_usage_reservations(tenant_id,product_id) where state='pending';
alter table private.billing_usage_reservations enable row level security;
revoke all on private.billing_usage_reservations from public,anon,authenticated,service_role,hub_app_server;

create function private.prepare_scoped_billing_usage(p_product uuid,p_account text,p_metric text,p_quantity integer,p_request uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare tenant uuid; prior private.billing_usage_reports; reservation private.billing_usage_reservations; targets jsonb; outcome text;
begin
 perform private.require_hub_app_server();
 if p_quantity is null or p_quantity not between 0 and 1000000 or p_request is null then raise exception 'Invalid usage report' using errcode='22023';end if;
 targets:=private.billing_usage_targets(p_product,p_account,p_metric);
 tenant:=(targets->>'tenant_id')::uuid;
 if tenant is null then return jsonb_build_object('outcome','not_linked','items_updated',0,'quantity',p_quantity);end if;
 perform pg_advisory_xact_lock(hashtextextended('facility-billing:'||tenant||':'||p_product,0));
 select * into prior from private.billing_usage_reports where product_id=p_product and request_key=p_request;
 if found then
  if prior.tenant_id<>tenant or prior.metric<>p_metric or prior.quantity<>p_quantity then raise exception 'Usage request changed' using errcode='22023';end if;
  return private.billing_usage_seen(p_product,p_request)||jsonb_build_object('duplicate',true);
 end if;
 select * into reservation from private.billing_usage_reservations where product_id=p_product and request_key=p_request for update;
 if found and (reservation.tenant_id<>tenant or reservation.metric<>p_metric or reservation.quantity<>p_quantity) then raise exception 'Usage request changed' using errcode='22023';end if;
 if exists(select 1 from private.facility_billing_configuration where tenant_id=tenant and product_id=p_product and mode='facility') then
  update private.billing_usage_reservations set state='completed' where product_id=p_product and request_key=p_request;
  perform private.billing_record_usage(p_product,tenant,p_metric,p_quantity,p_request,'facility_managed',0);
  return jsonb_build_object('outcome','facility_managed','items_updated',0,'quantity',p_quantity);
 end if;
 if reservation.request_key is not null then return jsonb_build_object('tenant_id',tenant,'targets',reservation.targets);end if;
 if exists(select 1 from private.billing_usage_reservations where tenant_id=tenant and product_id=p_product and state='pending')
  or exists(select 1 from private.customer_billing_quotes where tenant_id=tenant and product_id=p_product and state in ('confirming','pending_payment','scheduled')) then
  raise exception 'A billing change needs reconciliation before reporting another quantity' using errcode='40001';end if;
 -- Re-read after the scope lock; quantities or prices may have changed while waiting.
 targets:=private.billing_usage_targets(p_product,p_account,p_metric);
 targets:=jsonb_set(targets,'{items}',coalesce((select jsonb_agg(item||jsonb_build_object('price',i.stripe_price_id) order by item->>'item')
  from jsonb_array_elements(targets->'items') item join private.billing_subscription_items i on i.stripe_item_id=item->>'item'),'[]'::jsonb));
 if not exists(select 1 from jsonb_array_elements(targets->'items') item where (item->>'quantity')::integer<>p_quantity) then
  outcome:=case when jsonb_array_length(targets->'items')=0 then 'no_subscription' else 'unchanged' end;
  perform private.billing_record_usage(p_product,tenant,p_metric,p_quantity,p_request,outcome,0);
  return jsonb_build_object('outcome',outcome,'items_updated',0,'quantity',p_quantity);
 end if;
 insert into private.billing_usage_reservations(product_id,request_key,tenant_id,metric,quantity,targets)
  values(p_product,p_request,tenant,p_metric,p_quantity,targets);
 insert into private.customer_billing_revisions(tenant_id,product_id,version) values(tenant,p_product,1)
  on conflict(tenant_id,product_id) do update set version=private.customer_billing_revisions.version+1;
 return jsonb_build_object('tenant_id',tenant,'targets',targets);
end;$$;

create function private.lock_scoped_billing_usage(p_product uuid,p_request uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r private.billing_usage_reservations;
begin
 perform private.require_hub_app_server();
 select * into r from private.billing_usage_reservations where product_id=p_product and request_key=p_request;
 if not found then raise exception 'Usage reservation unavailable' using errcode='42501';end if;
 perform pg_advisory_xact_lock(hashtextextended('facility-billing:'||r.tenant_id||':'||r.product_id,0));
 select * into r from private.billing_usage_reservations where product_id=p_product and request_key=p_request for update;
 if r.state='completed' then return private.billing_usage_seen(p_product,p_request)||jsonb_build_object('duplicate',true);end if;
 if exists(select 1 from private.facility_billing_configuration where tenant_id=r.tenant_id and product_id=r.product_id and mode='facility') then
  raise exception 'Facility quantities are managed by their allocations' using errcode='40001';end if;
 return jsonb_build_object('tenant_id',r.tenant_id,'targets',r.targets);
end;$$;

create function private.complete_scoped_billing_usage(p_product uuid,p_request uuid,p_items integer) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r private.billing_usage_reservations;
begin
 perform private.require_hub_app_server();
 select * into r from private.billing_usage_reservations where product_id=p_product and request_key=p_request for update;
 if not found then raise exception 'Usage reservation unavailable' using errcode='42501';end if;
 if r.state='completed' then return private.billing_usage_seen(p_product,p_request)||jsonb_build_object('duplicate',true);end if;
 if p_items is null or p_items<>(select count(*) from jsonb_array_elements(r.targets->'items') item where (item->>'quantity')::integer<>r.quantity) then
  raise exception 'Usage receipt does not match its reservation' using errcode='22023';end if;
 if exists(select 1 from jsonb_array_elements(r.targets->'items') item
  where not exists(select 1 from private.billing_subscription_items i join private.billing_subscriptions s using(stripe_subscription_id)
   where i.stripe_item_id=item->>'item' and i.stripe_subscription_id=item->>'subscription' and i.quantity=r.quantity
    and s.tenant_id=r.tenant_id and s.product_id=r.product_id)) then raise exception 'Reported quantities need reconciliation' using errcode='40001';end if;
 perform private.billing_record_usage(p_product,r.tenant_id,r.metric,r.quantity,p_request,'updated',p_items);
 update private.billing_usage_reservations set state='completed' where product_id=p_product and request_key=p_request;
 return private.billing_usage_seen(p_product,p_request);
end;$$;
revoke all on function private.prepare_scoped_billing_usage(uuid,text,text,integer,uuid),private.lock_scoped_billing_usage(uuid,uuid),private.complete_scoped_billing_usage(uuid,uuid,integer) from public,anon,authenticated,service_role;
grant execute on function private.prepare_scoped_billing_usage(uuid,text,text,integer,uuid),private.lock_scoped_billing_usage(uuid,uuid),private.complete_scoped_billing_usage(uuid,uuid,integer) to hub_app_server;

-- Publish only after the scoped snapshots and quantity reservations are installed.
do $$ declare contract jsonb;signature text;relation text;begin
 select hub.get_backend_contract() into contract;
 foreach relation in array array['private.facility_entitlement_revisions','private.billing_usage_reservations'] loop
  if not exists(select 1 from pg_class where oid=to_regclass(relation) and relrowsecurity)
   or has_table_privilege('authenticated',relation,'SELECT,INSERT,UPDATE,DELETE')
   or has_table_privilege('hub_app_server',relation,'SELECT,INSERT,UPDATE,DELETE') then
   raise exception 'Facility entitlement state must remain private' using errcode='55000';end if;
 end loop;
 foreach signature in array array['private.scoped_app_billing_entitlements(uuid,text)','private.app_facility_entitlement_snapshot(uuid,text,jsonb)',
  'private.prepare_scoped_billing_usage(uuid,text,text,integer,uuid)','private.lock_scoped_billing_usage(uuid,uuid)','private.complete_scoped_billing_usage(uuid,uuid,integer)'] loop
  if to_regprocedure(signature) is null or not has_function_privilege('hub_app_server',signature,'EXECUTE')
   or has_function_privilege('authenticated',signature,'EXECUTE') or has_function_privilege('anon',signature,'EXECUTE') then
   raise exception 'Facility entitlement operations must remain server-only' using errcode='55000';end if;
 end loop;
 if not(contract->'features' ? 'billing.facility-entitlements.v1') then contract:=jsonb_set(contract,'{features}',(contract->'features')||'["billing.facility-entitlements.v1"]'::jsonb);end if;
 execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L',format('select %L::jsonb',contract::text));
end;$$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon,authenticated;
