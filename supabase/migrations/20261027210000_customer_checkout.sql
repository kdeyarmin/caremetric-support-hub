-- Initial paid subscriptions remain held until their exact Checkout receipt is verified.
-- Existing subscriptions, prices, trials and contracts keep their current behavior.
alter table private.customer_billing_quotes add column checkout_verified_at timestamptz;
create unique index customer_billing_quote_checkout_identity on private.customer_billing_quotes(stripe_checkout_id) where stripe_checkout_id is not null;
create table private.customer_checkout_holds (
 stripe_subscription_id text primary key references private.billing_subscriptions(stripe_subscription_id) on delete cascade,
 quote_id uuid,
 created_at timestamptz not null default now()
);
alter table private.customer_checkout_holds enable row level security;
revoke all on private.customer_checkout_holds from public,anon,authenticated,service_role,hub_app_server;

-- Preserve a hold even if provider metadata is subsequently removed or malformed.
alter function private.billing_sync(text,jsonb,timestamptz) rename to billing_sync_before_checkout;
revoke all on function private.billing_sync_before_checkout(text,jsonb,timestamptz) from public,anon,authenticated,service_role,hub_app_server;
create function private.billing_sync(p_kind text,p_record jsonb,p_seen timestamptz) returns text
language plpgsql security definer set search_path='' as $$
declare outcome text; required boolean; quote_id uuid;
begin
 perform private.require_hub_app_server();
 if p_kind='subscription' then
  required:=case when p_record ? 'checkout_required' then private.billing_bool(p_record->'checkout_required') else false end;
  if p_record->>'checkout_quote' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then quote_id:=(p_record->>'checkout_quote')::uuid;end if;
  outcome:=private.billing_sync_before_checkout(p_kind,p_record-'checkout_required'-'checkout_quote',p_seen);
  if required and exists(select 1 from private.billing_subscriptions where stripe_subscription_id=p_record->>'id') then
   insert into private.customer_checkout_holds(stripe_subscription_id,quote_id) values(p_record->>'id',quote_id) on conflict do nothing;
  end if;
  return outcome;
 end if;
 return private.billing_sync_before_checkout(p_kind,p_record,p_seen);
end;$$;
revoke all on function private.billing_sync(text,jsonb,timestamptz) from public,anon,authenticated,service_role;
grant execute on function private.billing_sync(text,jsonb,timestamptz) to hub_app_server;

create or replace function private.billing_entitlements(p_tenant uuid,p_product uuid) returns jsonb
language sql stable security definer set search_path='' as $$
  with settings as (select livemode from private.billing_settings),
  subs as (
    select s.* from private.billing_subscriptions s, settings
    where s.tenant_id=p_tenant and s.product_id=p_product and (settings.livemode is null or s.livemode=settings.livemode)
      and s.status not in ('canceled','incomplete_expired')
      and not exists(select 1 from private.customer_checkout_holds h where h.stripe_subscription_id=s.stripe_subscription_id
        and not exists(select 1 from private.customer_billing_quotes q where q.id=h.quote_id and q.state='applied'
          and q.stripe_subscription_id=s.stripe_subscription_id and q.tenant_id=s.tenant_id and q.product_id=s.product_id
          and q.checkout_verified_at is not null))
  ),
  ranked as (
    select s.*, case s.status when 'active' then 1 when 'trialing' then 2 when 'past_due' then 3 when 'paused' then 4 when 'unpaid' then 5 else 6 end as rank
    from subs s
  )
  select jsonb_build_object(
    'tenant_id',p_tenant,
    'app',(select slug from hub.products where id=p_product),
    'status',coalesce((select status from ranked order by rank,stripe_created desc limit 1),'none'),
    'entitled',exists(select 1 from subs where status in ('active','trialing','past_due')),
    'trial_end',(select max(trial_end) from subs where status='trialing'),
    'current_period_end',(select max(current_period_end) from subs where status in ('active','trialing','past_due')),
    'cancel_at_period_end',coalesce((select bool_and(cancel_at_period_end) from subs where status in ('active','trialing','past_due')),false),
    'products',coalesce((select jsonb_agg(jsonb_build_object(
        'product',p.stripe_product_id,'key',p.entitlement_key,'kind',p.kind,'name',p.name,'quantity',i.quantity,
        'unit_label',p.unit_label,'status',s.status,'subscription',s.stripe_subscription_id,
        'plan',coalesce(p.metadata->>'plan',p.metadata->>'tier',''),'package_id',coalesce(p.metadata->>'package_id',''))
        order by p.kind,p.name)
      from subs s join private.billing_subscription_items i on i.stripe_subscription_id=s.stripe_subscription_id
      join private.billing_products p on p.stripe_product_id=i.stripe_product_id
      where s.status in ('active','trialing','past_due')),'[]'::jsonb));
$$;



-- Shared by native trials and customer Checkout. The committed checkout reservation
-- prevents a concurrent trial or another application from creating a second payer.
create function private.lock_customer_subscription_start(p_tenant uuid,p_product uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
 perform private.require_hub_app_server();
 perform pg_advisory_xact_lock(hashtextextended('customer_subscription_start:'||p_tenant::text,0));
 if exists(select 1 from private.customer_billing_quotes where tenant_id=p_tenant and execution->>'kind'='checkout' and state in ('confirming','pending_payment')) then
  raise exception 'Resume or cancel the pending checkout before starting a subscription' using errcode='40001';end if;
 if exists(select 1 from private.customer_checkout_holds h join private.billing_subscriptions s using(stripe_subscription_id)
  where s.tenant_id=p_tenant and s.product_id=p_product and s.status not in ('canceled','incomplete_expired')
  and not exists(select 1 from private.customer_billing_quotes q where q.id=h.quote_id and q.state='applied' and q.stripe_subscription_id=s.stripe_subscription_id)) then
  raise exception 'The initial payment needs reconciliation before starting another subscription' using errcode='40001';end if;
end;$$;

create function private.customer_checkout_record(q private.customer_billing_quotes) returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object('id',q.id,'state',q.state,'execution',q.execution,'checkout',q.stripe_checkout_id,
  'subscription',q.stripe_subscription_id,'payment_invoice',q.payment_invoice_id,'confirmed_at',q.confirmed_at,
  'payment_request_started_at',q.payment_request_started_at,'connection_id',q.connection_id,'tenant_id',q.tenant_id,'product_id',q.product_id);
$$;
revoke all on function private.customer_checkout_record(private.customer_billing_quotes) from public,anon,authenticated,service_role,hub_app_server;

create function private.customer_checkout_status(p_id uuid,p_connection uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare c private.self_service_connections; q private.customer_billing_quotes;
begin
 perform private.require_hub_app_server();
 if not private.current_app_session_verified() then raise exception 'Sign in to continue' using errcode='28000';end if;
 select * into c from private.self_service_connections where id=p_connection and user_id=auth.uid() and revoked_at is null;
 if not found or c.role<>'organization_admin' or not private.is_active_member(c.tenant_id,c.product_id) then raise exception 'Organization billing access denied' using errcode='42501';end if;
 select * into q from private.customer_billing_quotes where id=p_id and tenant_id=c.tenant_id and product_id=c.product_id and execution->>'kind'='checkout' and state<>'preview';
 if not found then raise exception 'Checkout unavailable' using errcode='42501';end if;
 return private.customer_checkout_record(q);
end;$$;

create function private.customer_checkout_work(p_id uuid default null) returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
 perform private.require_hub_app_server();
 return coalesce((select jsonb_agg(private.customer_checkout_record(q) order by q.created_at) from private.customer_billing_quotes q
  where q.execution->>'kind'='checkout' and ((p_id is not null and q.id=p_id) or p_id is null and q.state in ('confirming','pending_payment'))),'[]'::jsonb);
end;$$;

create function private.customer_checkout_for_session(p_checkout text) returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
 perform private.require_hub_app_server();
 return coalesce((select jsonb_agg(private.customer_checkout_record(q)) from private.customer_billing_quotes q
  where q.stripe_checkout_id=p_checkout and q.execution->>'kind'='checkout'),'[]'::jsonb);
end;$$;

create function private.bind_customer_checkout(p_id uuid,p_customer text,p_checkout text default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare q private.customer_billing_quotes;
begin
 perform private.require_hub_app_server();
 select * into q from private.customer_billing_quotes where id=p_id for update;
 if not found or q.execution->>'kind' is distinct from 'checkout' or q.state='preview' then raise exception 'Checkout unavailable' using errcode='42501';end if;
 if not exists(select 1 from private.billing_customers where tenant_id=q.tenant_id and stripe_customer_id=p_customer and not deleted)
  or q.execution->>'customer' is not null and q.execution->>'customer'<>p_customer
  or p_checkout is not null and p_checkout !~ '^cs_[A-Za-z0-9_]{1,250}$'
  or q.stripe_checkout_id is not null and q.stripe_checkout_id is distinct from p_checkout then raise exception 'Checkout account or receipt changed' using errcode='40001';end if;
 update private.customer_billing_quotes set execution=jsonb_set(execution,'{customer}',to_jsonb(p_customer)),stripe_checkout_id=coalesce(p_checkout,stripe_checkout_id),
  state=case when state='confirming' and p_checkout is not null then 'pending_payment' else state end where id=p_id returning * into q;
 return private.customer_checkout_record(q);
end;$$;

create function private.complete_customer_checkout(p_id uuid,p_checkout text,p_subscription text,p_invoice text) returns void
language plpgsql security definer set search_path='' as $$
declare q private.customer_billing_quotes; s private.billing_subscriptions; i private.billing_invoices;
begin
 perform private.require_hub_app_server();
 select * into q from private.customer_billing_quotes where id=p_id for update;
 if not found or q.execution->>'kind' is distinct from 'checkout' or q.stripe_checkout_id is distinct from p_checkout then raise exception 'Checkout receipt unavailable' using errcode='42501';end if;
 if q.state='applied' then
  if q.stripe_subscription_id is distinct from p_subscription or q.payment_invoice_id is distinct from p_invoice then raise exception 'Checkout receipt changed' using errcode='40001';end if;
  return;
 end if;
 if q.state not in ('confirming','pending_payment') then raise exception 'Checkout is no longer pending' using errcode='40001';end if;
 select * into s from private.billing_subscriptions where stripe_subscription_id=p_subscription;
 select * into i from private.billing_invoices where stripe_invoice_id=p_invoice;
 if s.stripe_subscription_id is null or i.stripe_invoice_id is null or s.tenant_id<>q.tenant_id or s.product_id is distinct from q.product_id
  or s.stripe_customer_id<>q.execution->>'customer' or s.status<>'active'
  or i.tenant_id<>q.tenant_id or i.stripe_customer_id<>s.stripe_customer_id or i.stripe_subscription_id is distinct from s.stripe_subscription_id
  or i.status<>'paid' or i.amount_remaining<>0 or i.amount_due>(q.execution->>'maximumDue')::bigint or i.currency<>q.execution->>'currency'
  or not exists(select 1 from private.customer_checkout_holds h where h.stripe_subscription_id=s.stripe_subscription_id and h.quote_id=q.id)
  or (select jsonb_agg(jsonb_build_object('price',stripe_price_id,'quantity',quantity) order by stripe_price_id) from private.billing_subscription_items where stripe_subscription_id=s.stripe_subscription_id)
     is distinct from (select jsonb_agg(line order by line->>'price') from jsonb_array_elements(q.execution->'lines') line)
 then raise exception 'Initial payment receipt does not match this purchase' using errcode='40001';end if;
 update private.customer_billing_quotes set checkout_verified_at=now(),payment_invoice_id=p_invoice where id=q.id;
 perform private.settle_customer_billing_quote(q.id,'applied',s.stripe_subscription_id,null,p_checkout);
end;$$;

revoke all on function private.lock_customer_subscription_start(uuid,uuid),private.customer_checkout_status(uuid,uuid),private.customer_checkout_work(uuid),private.customer_checkout_for_session(text),private.bind_customer_checkout(uuid,text,text),private.complete_customer_checkout(uuid,text,text,text) from public,anon,authenticated,service_role;
grant execute on function private.lock_customer_subscription_start(uuid,uuid),private.customer_checkout_status(uuid,uuid),private.customer_checkout_work(uuid),private.customer_checkout_for_session(text),private.bind_customer_checkout(uuid,text,text),private.complete_customer_checkout(uuid,text,text,text) to hub_app_server;

-- Publish only after the receipt gate and private state are installed.
do $$ declare contract jsonb; signature text; begin
 select hub.get_backend_contract() into contract;
 if not exists(select 1 from pg_class where oid='private.customer_checkout_holds'::regclass and relrowsecurity)
  or has_table_privilege('authenticated','private.customer_checkout_holds','SELECT,INSERT,UPDATE,DELETE') then raise exception 'Checkout state must remain private';end if;
 foreach signature in array array['private.complete_customer_checkout(uuid,text,text,text)','private.bind_customer_checkout(uuid,text,text)','private.customer_checkout_work(uuid)'] loop
  if has_function_privilege('authenticated',signature,'EXECUTE') or has_function_privilege('anon',signature,'EXECUTE') then raise exception 'Checkout service functions must remain private';end if;
 end loop;
 if not (contract->'features' @> '["billing.customer-checkout.v1"]'::jsonb) then contract:=jsonb_set(contract,'{features}',(contract->'features')||'["billing.customer-checkout.v1"]'::jsonb);end if;
 execute format('create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='''' as %L','select '||quote_literal(contract::text)||'::jsonb');
end $$;
revoke all on function hub.get_backend_contract() from public;
grant execute on function hub.get_backend_contract() to anon,authenticated;
