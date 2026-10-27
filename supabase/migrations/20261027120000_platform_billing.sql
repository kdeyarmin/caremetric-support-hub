-- Platform billing for every CareMetric application, owned by the Hub.
--
-- Stripe (the CareMetric account) is the source of truth for money. These
-- private tables mirror it: the Hub server writes them from Stripe API
-- responses and from signed webhook events, which are recorded once by event id.
-- Administrators read through closed RPCs behind the current administrator
-- session; every Stripe-changing action runs on the Hub server after
-- hub.authorize_app_command(). Applications ask what a tenant has through the
-- server's entitlements endpoint with a per-application key, and their own
-- account ids resolve to Hub tenants through private.federated_tenants.
--
-- This replaces the manual price records (private.tenant_subscriptions) and the
-- CareBase-relayed billing portal and checkout intents. Audit rows carry states,
-- amounts and Stripe identifiers only, never names, emails or free text.

set local lock_timeout = '10s';

-- 1. Retire the manual price records and the CareBase billing relays.
drop function if exists hub.list_tenant_accounts();
drop function if exists hub.save_tenant_subscription(uuid,uuid,jsonb,integer);
drop function if exists hub.create_tenant(jsonb);
drop function if exists private.write_tenant_subscription(uuid,uuid,jsonb,integer);
drop function if exists private.validate_tenant_subscription(jsonb);
drop function if exists private.tenant_account(uuid);
drop table if exists private.tenant_subscriptions;

do $$ declare r record; begin
  for r in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='private' and (p.proname like '%billing\_portal%' or p.proname like '%billing\_checkout%')
  loop execute format('drop function %s', r.sig); end loop;
end $$;
drop table if exists private.billing_portal_intents;
drop table if exists private.billing_checkout_intents;
drop type if exists private.billing_portal_action;
drop type if exists private.billing_checkout_action;

-- 2. Mirror tables. RLS on, no direct privileges for any client or server role.
create table private.billing_settings (
  singleton boolean primary key default true check (singleton),
  livemode boolean,
  stripe_account_id text check (stripe_account_id ~ '^acct_[A-Za-z0-9]{1,64}$'),
  verified_at timestamptz,
  updated_at timestamptz not null default now()
);
insert into private.billing_settings(singleton) values (true);

create table private.billing_customers (
  tenant_id uuid primary key references hub.tenants(id) on delete restrict,
  stripe_customer_id text not null unique check (stripe_customer_id ~ '^cus_[A-Za-z0-9]{1,250}$'),
  email text not null default '' check (char_length(email) <= 320),
  name text not null default '' check (char_length(name) <= 256),
  delinquent boolean not null default false,
  balance bigint not null default 0,
  deleted boolean not null default false,
  livemode boolean not null,
  seen_at timestamptz not null,
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table private.billing_products (
  stripe_product_id text primary key check (stripe_product_id ~ '^[A-Za-z0-9_-]{1,255}$'),
  product_id uuid references hub.products(id) on delete restrict,
  name text not null check (char_length(name) between 1 and 250),
  description text not null default '' check (char_length(description) <= 2000),
  active boolean not null,
  kind text not null default 'plan' check (kind in ('plan','addon','fee')),
  entitlement_key text not null default '' check (entitlement_key ~ '^[a-z0-9_.-]{0,64}$'),
  unit_label text not null default '' check (char_length(unit_label) <= 12),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  livemode boolean not null,
  stripe_created timestamptz not null,
  seen_at timestamptz not null,
  version integer not null default 1 check (version > 0),
  synced_at timestamptz not null default now()
);
create index billing_products_app_idx on private.billing_products(product_id);

create table private.billing_prices (
  stripe_price_id text primary key check (stripe_price_id ~ '^[A-Za-z0-9_-]{1,255}$'),
  stripe_product_id text not null references private.billing_products(stripe_product_id) on delete restrict,
  active boolean not null,
  currency text not null check (currency ~ '^[a-z]{3}$'),
  unit_amount bigint check (unit_amount >= 0),
  pricing_model text not null check (pricing_model in ('flat','per_unit','tiered','custom')),
  type text not null check (type in ('recurring','one_time')),
  recurring_interval text check (recurring_interval in ('day','week','month','year')),
  interval_count integer check (interval_count between 1 and 365),
  lookup_key text check (char_length(lookup_key) <= 200),
  nickname text not null default '' check (char_length(nickname) <= 250),
  tenant_id uuid references hub.tenants(id) on delete restrict,
  replaces_price_id text check (replaces_price_id ~ '^[A-Za-z0-9_-]{1,255}$'),
  livemode boolean not null,
  stripe_created timestamptz not null,
  seen_at timestamptz not null,
  version integer not null default 1 check (version > 0),
  synced_at timestamptz not null default now(),
  check ((type = 'recurring') = (recurring_interval is not null))
);
create index billing_prices_product_idx on private.billing_prices(stripe_product_id);
create index billing_prices_tenant_idx on private.billing_prices(tenant_id) where tenant_id is not null;

create table private.billing_subscriptions (
  stripe_subscription_id text primary key check (stripe_subscription_id ~ '^sub_[A-Za-z0-9]{1,250}$'),
  tenant_id uuid not null references hub.tenants(id) on delete restrict,
  stripe_customer_id text not null references private.billing_customers(stripe_customer_id) on delete restrict,
  product_id uuid references hub.products(id) on delete restrict,
  status text not null check (status in ('incomplete','incomplete_expired','trialing','active','past_due','canceled','unpaid','paused')),
  collection_method text not null check (collection_method in ('charge_automatically','send_invoice')),
  cancel_at_period_end boolean not null default false,
  cancel_at timestamptz,
  canceled_at timestamptz,
  ended_at timestamptz,
  current_period_start timestamptz,
  current_period_end timestamptz,
  trial_start timestamptz,
  trial_end timestamptz,
  pause_behavior text check (pause_behavior in ('keep_as_draft','mark_uncollectible','void')),
  pause_resumes_at timestamptz,
  discounts jsonb not null default '[]'::jsonb check (jsonb_typeof(discounts) = 'array'),
  livemode boolean not null,
  stripe_created timestamptz not null,
  seen_at timestamptz not null,
  version integer not null default 1 check (version > 0),
  synced_at timestamptz not null default now()
);
create index billing_subscriptions_tenant_idx on private.billing_subscriptions(tenant_id, product_id);
create index billing_subscriptions_customer_idx on private.billing_subscriptions(stripe_customer_id);
create index billing_subscriptions_product_idx on private.billing_subscriptions(product_id);

create table private.billing_subscription_items (
  stripe_item_id text primary key check (stripe_item_id ~ '^si_[A-Za-z0-9]{1,250}$'),
  stripe_subscription_id text not null references private.billing_subscriptions(stripe_subscription_id) on delete cascade,
  stripe_price_id text not null check (stripe_price_id ~ '^[A-Za-z0-9_-]{1,255}$'),
  stripe_product_id text not null check (stripe_product_id ~ '^[A-Za-z0-9_-]{1,255}$'),
  quantity integer not null default 1 check (quantity between 0 and 1000000),
  unit_amount bigint check (unit_amount >= 0),
  currency text not null check (currency ~ '^[a-z]{3}$'),
  recurring_interval text check (recurring_interval in ('day','week','month','year')),
  interval_count integer check (interval_count between 1 and 365)
);
create index billing_subscription_items_subscription_idx on private.billing_subscription_items(stripe_subscription_id);
create index billing_subscription_items_price_idx on private.billing_subscription_items(stripe_price_id);

create table private.billing_coupons (
  stripe_coupon_id text primary key check (stripe_coupon_id ~ '^[A-Za-z0-9_-]{1,255}$'),
  name text not null default '' check (char_length(name) <= 40),
  percent_off numeric(5,2) check (percent_off > 0 and percent_off <= 100),
  amount_off bigint check (amount_off > 0),
  currency text check (currency ~ '^[a-z]{3}$'),
  duration text not null check (duration in ('once','repeating','forever')),
  duration_in_months integer check (duration_in_months between 1 and 120),
  max_redemptions integer check (max_redemptions > 0),
  times_redeemed integer not null default 0 check (times_redeemed >= 0),
  redeem_by timestamptz,
  valid boolean not null,
  applies_to_products text[] not null default array[]::text[],
  product_id uuid references hub.products(id) on delete restrict,
  deleted boolean not null default false,
  livemode boolean not null,
  stripe_created timestamptz not null,
  seen_at timestamptz not null,
  version integer not null default 1 check (version > 0),
  synced_at timestamptz not null default now(),
  check ((percent_off is null) <> (amount_off is null)),
  check ((amount_off is null) = (currency is null)),
  check ((duration = 'repeating') = (duration_in_months is not null))
);

create table private.billing_promotion_codes (
  stripe_promotion_code_id text primary key check (stripe_promotion_code_id ~ '^promo_[A-Za-z0-9]{1,250}$'),
  code text not null check (code ~ '^[A-Za-z0-9-]{1,100}$'),
  stripe_coupon_id text not null check (stripe_coupon_id ~ '^[A-Za-z0-9_-]{1,255}$'),
  active boolean not null,
  stripe_customer_id text check (stripe_customer_id ~ '^cus_[A-Za-z0-9]{1,250}$'),
  max_redemptions integer check (max_redemptions > 0),
  times_redeemed integer not null default 0 check (times_redeemed >= 0),
  expires_at timestamptz,
  first_time_transaction boolean not null default false,
  minimum_amount bigint check (minimum_amount > 0),
  livemode boolean not null,
  stripe_created timestamptz not null,
  seen_at timestamptz not null,
  version integer not null default 1 check (version > 0),
  synced_at timestamptz not null default now()
);
create index billing_promotion_codes_coupon_idx on private.billing_promotion_codes(stripe_coupon_id);

create table private.billing_invoices (
  stripe_invoice_id text primary key check (stripe_invoice_id ~ '^in_[A-Za-z0-9]{1,250}$'),
  tenant_id uuid not null references hub.tenants(id) on delete restrict,
  stripe_customer_id text not null check (stripe_customer_id ~ '^cus_[A-Za-z0-9]{1,250}$'),
  stripe_subscription_id text check (stripe_subscription_id ~ '^sub_[A-Za-z0-9]{1,250}$'),
  product_id uuid references hub.products(id) on delete restrict,
  status text not null check (status in ('draft','open','paid','uncollectible','void')),
  number text check (char_length(number) <= 100),
  currency text not null check (currency ~ '^[a-z]{3}$'),
  total bigint not null,
  subtotal bigint not null,
  amount_due bigint not null,
  amount_paid bigint not null,
  amount_remaining bigint not null,
  hosted_invoice_url text check (char_length(hosted_invoice_url) <= 1000 and hosted_invoice_url ~ '^https://[^[:space:]]+$'),
  invoice_pdf text check (char_length(invoice_pdf) <= 1000 and invoice_pdf ~ '^https://[^[:space:]]+$'),
  collection_method text check (collection_method in ('charge_automatically','send_invoice')),
  period_start timestamptz,
  period_end timestamptz,
  due_date timestamptz,
  livemode boolean not null,
  stripe_created timestamptz not null,
  seen_at timestamptz not null,
  version integer not null default 1 check (version > 0),
  synced_at timestamptz not null default now()
);
create index billing_invoices_tenant_idx on private.billing_invoices(tenant_id, stripe_created desc);
create index billing_invoices_subscription_idx on private.billing_invoices(stripe_subscription_id) where stripe_subscription_id is not null;

-- Every webhook delivery is applied at most once, identified by Stripe's event id.
create table private.billing_webhook_events (
  stripe_event_id text primary key check (stripe_event_id ~ '^evt_[A-Za-z0-9]{1,250}$'),
  event_type text not null check (event_type ~ '^[a-z_]+(\.[a-z_]+){1,4}$'),
  livemode boolean not null,
  object_id text check (object_id ~ '^[A-Za-z0-9_-]{1,255}$'),
  event_created timestamptz not null,
  outcome text not null check (outcome in ('applied','ignored')),
  received_at timestamptz not null default now()
);
create index billing_webhook_events_received_idx on private.billing_webhook_events(received_at desc);

-- One credential per application server for the entitlements and usage
-- endpoints. Only a SHA-256 digest is stored; the Hub shows the key once.
create table private.billing_app_keys (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references hub.products(id) on delete restrict,
  key_hash text not null unique check (key_hash ~ '^[0-9a-f]{64}$'),
  key_hint text not null check (key_hint ~ '^[A-Za-z0-9_-]{4}$'),
  created_by uuid,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
create index billing_app_keys_product_idx on private.billing_app_keys(product_id) where revoked_at is null;

-- Which application account a tenant's billing belongs to. Resolution goes
-- through private.federated_tenants (hashed ids); this keeps a short hint so an
-- administrator can recognize the link.
create table private.billing_account_links (
  tenant_id uuid not null references hub.tenants(id) on delete cascade,
  product_id uuid not null references hub.products(id) on delete restrict,
  account_hint text not null check (account_hint ~ '^[A-Za-z0-9_-]{1,6}$'),
  version integer not null default 1 check (version > 0),
  linked_by uuid,
  linked_at timestamptz not null default now(),
  primary key (tenant_id, product_id)
);

-- Quantity reports from applications (CareBase reports active facilities).
-- A request key makes a retried report a no-op.
create table private.billing_usage_reports (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references hub.products(id) on delete restrict,
  tenant_id uuid not null references hub.tenants(id) on delete cascade,
  metric text not null check (metric ~ '^[a-z][a-z0-9_]{0,39}$'),
  quantity integer not null check (quantity between 0 and 1000000),
  request_key uuid not null,
  outcome text not null check (outcome in ('updated','unchanged','no_subscription','failed')),
  items_updated integer not null default 0 check (items_updated >= 0),
  reported_at timestamptz not null default now(),
  unique (product_id, request_key)
);
create index billing_usage_reports_tenant_idx on private.billing_usage_reports(tenant_id, product_id, reported_at desc);

do $$ declare t text; begin
  foreach t in array array['billing_settings','billing_customers','billing_products','billing_prices','billing_subscriptions',
    'billing_subscription_items','billing_coupons','billing_promotion_codes','billing_invoices','billing_webhook_events',
    'billing_app_keys','billing_account_links','billing_usage_reports'] loop
    execute format('alter table private.%I enable row level security', t);
    execute format('revoke all on private.%I from public, anon, authenticated, service_role, hub_app_server', t);
  end loop;
end $$;
comment on table private.billing_subscriptions is 'Mirror of Stripe subscriptions for Hub tenants. Stripe is the source of truth; the Hub server writes this from API responses and signed webhooks.';

-- 3. Helpers.
create function private.require_hub_app_server() returns void
language plpgsql stable set search_path='' as $$
begin
  if session_user<>'hub_app_server' then raise exception 'Application server required.' using errcode='42501'; end if;
end; $$;

-- Exactly these keys, no more and no fewer.
create function private.billing_keys(p_record jsonb, p_keys text[]) returns void
language plpgsql immutable set search_path='' as $$
begin
  if p_record is null or jsonb_typeof(p_record)<>'object'
    or (select coalesce(array_agg(k order by k),array[]::text[]) from jsonb_object_keys(p_record) k)
       is distinct from (select array_agg(k order by k) from unnest(p_keys) k) then
    raise exception 'Invalid billing record.' using errcode='22023';
  end if;
end; $$;

create function private.billing_ts(p_value jsonb) returns timestamptz
language plpgsql immutable set search_path='' as $$
begin
  if p_value is null or jsonb_typeof(p_value)='null' then return null; end if;
  if jsonb_typeof(p_value)<>'number' or (p_value#>>'{}') !~ '^[0-9]{1,11}$' then
    raise exception 'Invalid billing timestamp.' using errcode='22023';
  end if;
  return to_timestamp((p_value#>>'{}')::bigint);
end; $$;

-- A single text value, null allowed, without control characters.
create function private.billing_text(p_value jsonb, p_max integer) returns text
language plpgsql immutable set search_path='' as $$
begin
  if p_value is null or jsonb_typeof(p_value)='null' then return null; end if;
  if jsonb_typeof(p_value)<>'string' or char_length(p_value#>>'{}')>p_max or (p_value#>>'{}') ~ '[[:cntrl:]]' then
    raise exception 'Invalid billing text.' using errcode='22023';
  end if;
  return p_value#>>'{}';
end; $$;

create function private.billing_int(p_value jsonb) returns bigint
language plpgsql immutable set search_path='' as $$
begin
  if p_value is null or jsonb_typeof(p_value)='null' then return null; end if;
  if jsonb_typeof(p_value)<>'number' or (p_value#>>'{}') !~ '^-?[0-9]{1,15}$' then
    raise exception 'Invalid billing amount.' using errcode='22023';
  end if;
  return (p_value#>>'{}')::bigint;
end; $$;

create function private.billing_bool(p_value jsonb) returns boolean
language plpgsql immutable set search_path='' as $$
begin
  if jsonb_typeof(p_value) is distinct from 'boolean' then raise exception 'Invalid billing flag.' using errcode='22023'; end if;
  return (p_value#>>'{}')::boolean;
end; $$;

create function private.billing_app(p_slug jsonb) returns uuid
language plpgsql stable set search_path='' as $$
declare v uuid;
begin
  if p_slug is null or jsonb_typeof(p_slug)='null' then return null; end if;
  select id into v from hub.products where slug=private.billing_text(p_slug,64);
  return v;
end; $$;

-- Applies one mirror write when it is at least as recent as what is stored.
-- seen_at is the Stripe event time, or the server's clock for a freshly
-- retrieved object, so a late webhook never overwrites newer state.
create function private.billing_sync(p_kind text, p_record jsonb, p_seen timestamptz) returns text
language plpgsql security definer set search_path='' as $$
declare
  v_tenant uuid; v_customer text; v_app uuid; v_live boolean; v_id text; item jsonb; v_settings private.billing_settings;
  v_items text[]:=array[]::text[];
begin
  perform private.require_hub_app_server();
  if p_seen is null or p_seen>now()+interval '10 minutes' then raise exception 'Invalid billing time.' using errcode='22023'; end if;
  select * into v_settings from private.billing_settings;
  v_live:=private.billing_bool(p_record->'livemode');
  if v_settings.livemode is not null and v_settings.livemode<>v_live then return 'ignored'; end if;
  v_id:=private.billing_text(p_record->'id',255);
  if v_id is null or v_id !~ '^[A-Za-z0-9_-]{1,255}$' then raise exception 'Invalid billing identifier.' using errcode='22023'; end if;

  if p_kind='customer' then
    perform private.billing_keys(p_record,array['id','tenant_id','email','name','delinquent','balance','deleted','livemode']);
    if jsonb_typeof(p_record->'tenant_id')<>'string' or (p_record->>'tenant_id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return 'ignored'; end if;
    v_tenant:=(p_record->>'tenant_id')::uuid;
    if not exists(select 1 from hub.tenants where id=v_tenant) then return 'ignored'; end if;
    if exists(select 1 from private.billing_customers where tenant_id=v_tenant and stripe_customer_id<>v_id and not deleted) then return 'ignored'; end if;
    insert into private.billing_customers as c(tenant_id,stripe_customer_id,email,name,delinquent,balance,deleted,livemode,seen_at)
      values(v_tenant,v_id,coalesce(private.billing_text(p_record->'email',320),''),coalesce(private.billing_text(p_record->'name',256),''),
        coalesce(private.billing_bool(p_record->'delinquent'),false),coalesce(private.billing_int(p_record->'balance'),0),
        private.billing_bool(p_record->'deleted'),v_live,p_seen)
    on conflict (tenant_id) do update set stripe_customer_id=excluded.stripe_customer_id,email=excluded.email,name=excluded.name,
      delinquent=excluded.delinquent,balance=excluded.balance,deleted=excluded.deleted,livemode=excluded.livemode,
      seen_at=excluded.seen_at,version=c.version+1,updated_at=clock_timestamp()
      where c.seen_at<=excluded.seen_at;
    return 'applied';

  elsif p_kind='product' then
    perform private.billing_keys(p_record,array['id','app','name','description','active','kind','entitlement_key','unit_label','metadata','livemode','created']);
    if jsonb_typeof(p_record->'metadata')<>'object' or (select count(*) from jsonb_each(p_record->'metadata'))>50
      or exists(select 1 from jsonb_each(p_record->'metadata') e where jsonb_typeof(e.value)<>'string' or char_length(e.key)>40 or char_length(e.value#>>'{}')>500) then
      raise exception 'Invalid product metadata.' using errcode='22023';
    end if;
    v_app:=private.billing_app(p_record->'app');
    insert into private.billing_products as p(stripe_product_id,product_id,name,description,active,kind,entitlement_key,unit_label,metadata,livemode,stripe_created,seen_at)
      values(v_id,v_app,private.billing_text(p_record->'name',250),coalesce(private.billing_text(p_record->'description',2000),''),
        private.billing_bool(p_record->'active'),private.billing_text(p_record->'kind',10),coalesce(private.billing_text(p_record->'entitlement_key',64),''),
        coalesce(private.billing_text(p_record->'unit_label',12),''),p_record->'metadata',v_live,private.billing_ts(p_record->'created'),p_seen)
    on conflict (stripe_product_id) do update set product_id=excluded.product_id,name=excluded.name,description=excluded.description,
      active=excluded.active,kind=excluded.kind,entitlement_key=excluded.entitlement_key,unit_label=excluded.unit_label,metadata=excluded.metadata,
      livemode=excluded.livemode,seen_at=excluded.seen_at,version=p.version+1,synced_at=clock_timestamp()
      where p.seen_at<=excluded.seen_at;
    return 'applied';

  elsif p_kind='price' then
    perform private.billing_keys(p_record,array['id','product','active','currency','unit_amount','pricing_model','type','interval','interval_count','lookup_key','nickname','tenant_id','replaces','livemode','created']);
    if not exists(select 1 from private.billing_products where stripe_product_id=private.billing_text(p_record->'product',255)) then return 'ignored'; end if;
    v_tenant:=case when jsonb_typeof(p_record->'tenant_id')='string' and (p_record->>'tenant_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then (select id from hub.tenants where id=(p_record->>'tenant_id')::uuid) end;
    insert into private.billing_prices as r(stripe_price_id,stripe_product_id,active,currency,unit_amount,pricing_model,type,recurring_interval,interval_count,
        lookup_key,nickname,tenant_id,replaces_price_id,livemode,stripe_created,seen_at)
      values(v_id,private.billing_text(p_record->'product',255),private.billing_bool(p_record->'active'),private.billing_text(p_record->'currency',3),
        private.billing_int(p_record->'unit_amount'),private.billing_text(p_record->'pricing_model',10),private.billing_text(p_record->'type',10),
        private.billing_text(p_record->'interval',5),private.billing_int(p_record->'interval_count'),private.billing_text(p_record->'lookup_key',200),
        coalesce(private.billing_text(p_record->'nickname',250),''),v_tenant,private.billing_text(p_record->'replaces',255),v_live,
        private.billing_ts(p_record->'created'),p_seen)
    on conflict (stripe_price_id) do update set active=excluded.active,lookup_key=excluded.lookup_key,nickname=excluded.nickname,
      tenant_id=excluded.tenant_id,replaces_price_id=excluded.replaces_price_id,pricing_model=excluded.pricing_model,
      livemode=excluded.livemode,seen_at=excluded.seen_at,version=r.version+1,synced_at=clock_timestamp()
      where r.seen_at<=excluded.seen_at;
    return 'applied';

  elsif p_kind='subscription' then
    perform private.billing_keys(p_record,array['id','customer','app','status','collection_method','cancel_at_period_end','cancel_at','canceled_at','ended_at',
      'current_period_start','current_period_end','trial_start','trial_end','pause_behavior','pause_resumes_at','discounts','items','livemode','created']);
    v_customer:=private.billing_text(p_record->'customer',255);
    select tenant_id into v_tenant from private.billing_customers where stripe_customer_id=v_customer;
    if v_tenant is null then return 'ignored'; end if;
    if jsonb_typeof(p_record->'items')<>'array' then raise exception 'Invalid subscription record.' using errcode='22023'; end if;
    -- The application comes from the subscription's metadata, else from its catalog items.
    v_app:=coalesce(private.billing_app(p_record->'app'),(select bp.product_id from jsonb_array_elements(p_record->'items') it
      join private.billing_products bp on bp.stripe_product_id=it->>'product' where bp.product_id is not null limit 1));
    if jsonb_typeof(p_record->'items')<>'array' or jsonb_array_length(p_record->'items')>50
      or jsonb_typeof(p_record->'discounts')<>'array' or jsonb_array_length(p_record->'discounts')>20
      or exists(select 1 from jsonb_array_elements(p_record->'discounts') d where jsonb_typeof(d)<>'object'
        or (select array_agg(k order by k) from jsonb_object_keys(d) k) is distinct from array['coupon','id','promotion_code']
        or coalesce(private.billing_text(d->'id',255),'') !~ '^di_[A-Za-z0-9]{1,250}$'
        or private.billing_text(d->'coupon',255) is null or coalesce(private.billing_text(d->'promotion_code',255),'promo_x') !~ '^promo_[A-Za-z0-9]+$') then
      raise exception 'Invalid subscription record.' using errcode='22023';
    end if;
    if exists(select 1 from private.billing_subscriptions where stripe_subscription_id=v_id and seen_at>p_seen) then return 'ignored'; end if;
    insert into private.billing_subscriptions as s(stripe_subscription_id,tenant_id,stripe_customer_id,product_id,status,collection_method,
        cancel_at_period_end,cancel_at,canceled_at,ended_at,current_period_start,current_period_end,trial_start,trial_end,pause_behavior,pause_resumes_at,
        discounts,livemode,stripe_created,seen_at)
      values(v_id,v_tenant,v_customer,v_app,private.billing_text(p_record->'status',20),private.billing_text(p_record->'collection_method',30),
        private.billing_bool(p_record->'cancel_at_period_end'),private.billing_ts(p_record->'cancel_at'),private.billing_ts(p_record->'canceled_at'),
        private.billing_ts(p_record->'ended_at'),private.billing_ts(p_record->'current_period_start'),private.billing_ts(p_record->'current_period_end'),
        private.billing_ts(p_record->'trial_start'),private.billing_ts(p_record->'trial_end'),private.billing_text(p_record->'pause_behavior',20),
        private.billing_ts(p_record->'pause_resumes_at'),p_record->'discounts',v_live,private.billing_ts(p_record->'created'),p_seen)
    on conflict (stripe_subscription_id) do update set tenant_id=excluded.tenant_id,stripe_customer_id=excluded.stripe_customer_id,
      product_id=coalesce(excluded.product_id,s.product_id),status=excluded.status,collection_method=excluded.collection_method,
      cancel_at_period_end=excluded.cancel_at_period_end,cancel_at=excluded.cancel_at,canceled_at=excluded.canceled_at,ended_at=excluded.ended_at,
      current_period_start=excluded.current_period_start,current_period_end=excluded.current_period_end,trial_start=excluded.trial_start,
      trial_end=excluded.trial_end,pause_behavior=excluded.pause_behavior,pause_resumes_at=excluded.pause_resumes_at,discounts=excluded.discounts,
      livemode=excluded.livemode,seen_at=excluded.seen_at,version=s.version+1,synced_at=clock_timestamp();
    for item in select value from jsonb_array_elements(p_record->'items') loop
      perform private.billing_keys(item,array['id','price','product','quantity','unit_amount','currency','interval','interval_count']);
      v_items:=v_items||private.billing_text(item->'id',255);
      insert into private.billing_subscription_items as i(stripe_item_id,stripe_subscription_id,stripe_price_id,stripe_product_id,quantity,unit_amount,currency,recurring_interval,interval_count)
        values(private.billing_text(item->'id',255),v_id,private.billing_text(item->'price',255),private.billing_text(item->'product',255),
          coalesce(private.billing_int(item->'quantity'),1),private.billing_int(item->'unit_amount'),private.billing_text(item->'currency',3),
          private.billing_text(item->'interval',5),private.billing_int(item->'interval_count'))
      on conflict (stripe_item_id) do update set stripe_subscription_id=excluded.stripe_subscription_id,stripe_price_id=excluded.stripe_price_id,
        stripe_product_id=excluded.stripe_product_id,quantity=excluded.quantity,unit_amount=excluded.unit_amount,currency=excluded.currency,
        recurring_interval=excluded.recurring_interval,interval_count=excluded.interval_count;
    end loop;
    delete from private.billing_subscription_items where stripe_subscription_id=v_id and not (stripe_item_id=any(v_items));
    -- A tenant subscribed to an application has access to it in the Hub as well.
    if v_app is not null then
      insert into hub.tenant_products(tenant_id,product_id) values(v_tenant,v_app) on conflict do nothing;
    end if;
    return 'applied';

  elsif p_kind='coupon' then
    perform private.billing_keys(p_record,array['id','name','percent_off','amount_off','currency','duration','duration_in_months','max_redemptions',
      'times_redeemed','redeem_by','valid','applies_to','app','deleted','livemode','created']);
    if jsonb_typeof(p_record->'applies_to')<>'array' or jsonb_array_length(p_record->'applies_to')>100
      or exists(select 1 from jsonb_array_elements(p_record->'applies_to') a where jsonb_typeof(a)<>'string' or (a#>>'{}') !~ '^[A-Za-z0-9_-]{1,255}$') then
      raise exception 'Invalid coupon record.' using errcode='22023';
    end if;
    if jsonb_typeof(p_record->'percent_off') not in ('number','null') then raise exception 'Invalid coupon record.' using errcode='22023'; end if;
    insert into private.billing_coupons as c(stripe_coupon_id,name,percent_off,amount_off,currency,duration,duration_in_months,max_redemptions,times_redeemed,
        redeem_by,valid,applies_to_products,product_id,deleted,livemode,stripe_created,seen_at)
      values(v_id,coalesce(private.billing_text(p_record->'name',40),''),(p_record->>'percent_off')::numeric,private.billing_int(p_record->'amount_off'),
        private.billing_text(p_record->'currency',3),private.billing_text(p_record->'duration',10),private.billing_int(p_record->'duration_in_months'),
        private.billing_int(p_record->'max_redemptions'),coalesce(private.billing_int(p_record->'times_redeemed'),0),private.billing_ts(p_record->'redeem_by'),
        private.billing_bool(p_record->'valid'),(select coalesce(array_agg(a#>>'{}'),array[]::text[]) from jsonb_array_elements(p_record->'applies_to') a),
        private.billing_app(p_record->'app'),private.billing_bool(p_record->'deleted'),v_live,private.billing_ts(p_record->'created'),p_seen)
    on conflict (stripe_coupon_id) do update set name=excluded.name,times_redeemed=excluded.times_redeemed,valid=excluded.valid,
      applies_to_products=excluded.applies_to_products,product_id=excluded.product_id,deleted=excluded.deleted,max_redemptions=excluded.max_redemptions,
      redeem_by=excluded.redeem_by,livemode=excluded.livemode,seen_at=excluded.seen_at,version=c.version+1,synced_at=clock_timestamp()
      where c.seen_at<=excluded.seen_at;
    return 'applied';

  elsif p_kind='promotion_code' then
    perform private.billing_keys(p_record,array['id','code','coupon','active','customer','max_redemptions','times_redeemed','expires_at',
      'first_time_transaction','minimum_amount','livemode','created']);
    insert into private.billing_promotion_codes as c(stripe_promotion_code_id,code,stripe_coupon_id,active,stripe_customer_id,max_redemptions,times_redeemed,
        expires_at,first_time_transaction,minimum_amount,livemode,stripe_created,seen_at)
      values(v_id,private.billing_text(p_record->'code',100),private.billing_text(p_record->'coupon',255),private.billing_bool(p_record->'active'),
        private.billing_text(p_record->'customer',255),private.billing_int(p_record->'max_redemptions'),coalesce(private.billing_int(p_record->'times_redeemed'),0),
        private.billing_ts(p_record->'expires_at'),private.billing_bool(p_record->'first_time_transaction'),private.billing_int(p_record->'minimum_amount'),
        v_live,private.billing_ts(p_record->'created'),p_seen)
    on conflict (stripe_promotion_code_id) do update set active=excluded.active,times_redeemed=excluded.times_redeemed,
      max_redemptions=excluded.max_redemptions,expires_at=excluded.expires_at,livemode=excluded.livemode,seen_at=excluded.seen_at,
      version=c.version+1,synced_at=clock_timestamp()
      where c.seen_at<=excluded.seen_at;
    return 'applied';

  elsif p_kind='invoice' then
    perform private.billing_keys(p_record,array['id','customer','subscription','app','status','number','currency','total','subtotal','amount_due','amount_paid',
      'amount_remaining','hosted_invoice_url','invoice_pdf','collection_method','period_start','period_end','due_date','livemode','created']);
    v_customer:=private.billing_text(p_record->'customer',255);
    select tenant_id into v_tenant from private.billing_customers where stripe_customer_id=v_customer;
    if v_tenant is null or p_record->>'status' is null then return 'ignored'; end if;
    insert into private.billing_invoices as v(stripe_invoice_id,tenant_id,stripe_customer_id,stripe_subscription_id,product_id,status,number,currency,total,subtotal,
        amount_due,amount_paid,amount_remaining,hosted_invoice_url,invoice_pdf,collection_method,period_start,period_end,due_date,livemode,stripe_created,seen_at)
      values(v_id,v_tenant,v_customer,private.billing_text(p_record->'subscription',255),
        coalesce(private.billing_app(p_record->'app'),(select product_id from private.billing_subscriptions where stripe_subscription_id=private.billing_text(p_record->'subscription',255))),
        private.billing_text(p_record->'status',20),private.billing_text(p_record->'number',100),private.billing_text(p_record->'currency',3),
        private.billing_int(p_record->'total'),private.billing_int(p_record->'subtotal'),private.billing_int(p_record->'amount_due'),
        private.billing_int(p_record->'amount_paid'),private.billing_int(p_record->'amount_remaining'),private.billing_text(p_record->'hosted_invoice_url',1000),
        private.billing_text(p_record->'invoice_pdf',1000),private.billing_text(p_record->'collection_method',30),private.billing_ts(p_record->'period_start'),
        private.billing_ts(p_record->'period_end'),private.billing_ts(p_record->'due_date'),v_live,private.billing_ts(p_record->'created'),p_seen)
    on conflict (stripe_invoice_id) do update set status=excluded.status,number=excluded.number,total=excluded.total,subtotal=excluded.subtotal,
      amount_due=excluded.amount_due,amount_paid=excluded.amount_paid,amount_remaining=excluded.amount_remaining,hosted_invoice_url=excluded.hosted_invoice_url,
      invoice_pdf=excluded.invoice_pdf,collection_method=excluded.collection_method,period_start=excluded.period_start,period_end=excluded.period_end,
      due_date=excluded.due_date,product_id=coalesce(excluded.product_id,v.product_id),livemode=excluded.livemode,seen_at=excluded.seen_at,
      version=v.version+1,synced_at=clock_timestamp()
      where v.seen_at<=excluded.seen_at;
    return 'applied';
  end if;
  raise exception 'Unsupported billing record.' using errcode='22023';
end; $$;

-- A draft invoice deleted in Stripe leaves the mirror too.
create function private.billing_forget_invoice(p_invoice text) returns void
language plpgsql security definer set search_path='' as $$
begin
  perform private.require_hub_app_server();
  delete from private.billing_invoices where stripe_invoice_id=p_invoice and status='draft';
end; $$;

-- Records a verified webhook event once. Returns false when it was already applied.
create function private.billing_record_event(p_event_id text,p_type text,p_livemode boolean,p_object_id text,p_created timestamptz,p_outcome text) returns boolean
language plpgsql security definer set search_path='' as $$
begin
  perform private.require_hub_app_server();
  insert into private.billing_webhook_events(stripe_event_id,event_type,livemode,object_id,event_created,outcome)
    values(p_event_id,p_type,p_livemode,p_object_id,p_created,p_outcome) on conflict (stripe_event_id) do nothing;
  return found;
end; $$;

create function private.billing_event_seen(p_event_id text) returns boolean
language sql stable security definer set search_path='' as $$
  select exists(select 1 from private.billing_webhook_events where stripe_event_id=p_event_id);
$$;

-- The server records the verified Stripe account and mode at startup; reads and
-- webhook writes follow that mode so test data never mixes with live data.
create function private.billing_set_account(p_account text,p_livemode boolean) returns void
language plpgsql security definer set search_path='' as $$
begin
  perform private.require_hub_app_server();
  update private.billing_settings set stripe_account_id=p_account,livemode=p_livemode,verified_at=now(),updated_at=now();
end; $$;

-- Server-side reads for validating one administrator command against the mirror.
create function private.billing_lookup(p_kind text,p_id text) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare v_app text; v_plan text;
begin
  perform private.require_hub_app_server();
  if p_kind='app' then
    return (select jsonb_build_object('id',id,'slug',slug) from hub.products where slug=p_id and status<>'retired' and slug<>'advisors');
  elsif p_kind='subscription' then
    return (select private.billing_subscription_view(s) from private.billing_subscriptions s where s.stripe_subscription_id=p_id);
  elsif p_kind='price' then
    return (select private.billing_price_view(r)||jsonb_build_object('app',h.slug,'product_active',p.active,'unit_label',p.unit_label)
      from private.billing_prices r join private.billing_products p on p.stripe_product_id=r.stripe_product_id
      left join hub.products h on h.id=p.product_id where r.stripe_price_id=p_id);
  elsif p_kind='product' then
    return (select jsonb_build_object('id',p.stripe_product_id,'app',h.slug,'name',p.name,'active',p.active,'kind',p.kind,'unit_label',p.unit_label,
        'entitlement_key',p.entitlement_key,'version',p.version)
      from private.billing_products p left join hub.products h on h.id=p.product_id where p.stripe_product_id=p_id);
  elsif p_kind='app_products' then
    return (select coalesce(jsonb_agg(p.stripe_product_id order by p.stripe_product_id),'[]'::jsonb)
      from private.billing_products p join hub.products h on h.id=p.product_id where h.slug=p_id and p.active);
  elsif p_kind='coupon' then
    return (select jsonb_build_object('id',c.stripe_coupon_id,'app',h.slug,'valid',c.valid,'deleted',c.deleted,'version',c.version)
      from private.billing_coupons c left join hub.products h on h.id=c.product_id where c.stripe_coupon_id=p_id);
  elsif p_kind='promotion_code' then
    return (select jsonb_build_object('id',c.stripe_promotion_code_id,'coupon',c.stripe_coupon_id,'active',c.active,'version',c.version)
      from private.billing_promotion_codes c where c.stripe_promotion_code_id=p_id);
  elsif p_kind='invoice' then
    return (select private.billing_invoice_view(v)||jsonb_build_object('customer',v.stripe_customer_id) from private.billing_invoices v where v.stripe_invoice_id=p_id);
  elsif p_kind='trial_price' then
    -- "<app>:<plan>": the plan's monthly price, else the application's default trial plan.
    v_app:=split_part(p_id,':',1); v_plan:=nullif(split_part(p_id,':',2),'');
    return (select jsonb_build_object('price',r.stripe_price_id,'product',p.stripe_product_id,
        'trial_days',case when coalesce(p.metadata->>'trial_days','') ~ '^[0-9]{1,3}$' then (p.metadata->>'trial_days')::integer end)
      from private.billing_prices r join private.billing_products p on p.stripe_product_id=r.stripe_product_id join hub.products h on h.id=p.product_id
      where h.slug=v_app and p.active and r.active and r.tenant_id is null and r.type='recurring' and r.recurring_interval='month' and p.kind='plan'
        and (case when v_plan is null then p.metadata->>'hub_trial_default'='true' else p.entitlement_key=v_plan end)
      order by (p.metadata->>'hub_trial_default'='true') desc nulls last, r.unit_amount, r.stripe_created desc limit 1);
  end if;
  raise exception 'Unsupported billing lookup.' using errcode='22023';
end; $$;

-- A deleted coupon stays on the subscriptions that already use it; the mirror marks it.
create function private.billing_mark_coupon_deleted(p_coupon text) returns void
language plpgsql security definer set search_path='' as $$
begin
  perform private.require_hub_app_server();
  update private.billing_coupons set deleted=true,valid=false,version=version+1,synced_at=clock_timestamp() where stripe_coupon_id=p_coupon;
end; $$;

-- Locks one mirrored object and checks the version the administrator reviewed.
create function private.billing_lock(p_kind text,p_id text,p_expected_version integer) returns void
language plpgsql security definer set search_path='' as $$
declare v integer;
begin
  perform private.require_hub_app_server();
  if p_expected_version is null or p_expected_version<0 then raise exception 'Invalid billing version.' using errcode='22023'; end if;
  if p_kind='customer' then select version into v from private.billing_customers where tenant_id=p_id::uuid for update;
  elsif p_kind='product' then select version into v from private.billing_products where stripe_product_id=p_id for update;
  elsif p_kind='price' then select version into v from private.billing_prices where stripe_price_id=p_id for update;
  elsif p_kind='subscription' then select version into v from private.billing_subscriptions where stripe_subscription_id=p_id for update;
  elsif p_kind='coupon' then select version into v from private.billing_coupons where stripe_coupon_id=p_id for update;
  elsif p_kind='promotion_code' then select version into v from private.billing_promotion_codes where stripe_promotion_code_id=p_id for update;
  elsif p_kind='invoice' then select version into v from private.billing_invoices where stripe_invoice_id=p_id for update;
  elsif p_kind='link' then select version into v from private.billing_account_links where tenant_id=split_part(p_id,':',1)::uuid and product_id=split_part(p_id,':',2)::uuid for update;
  else raise exception 'Unsupported billing record.' using errcode='22023'; end if;
  if coalesce(v,0)<>p_expected_version then
    raise exception 'Billing changed. Refresh and review before saving.' using errcode='40001';
  end if;
end; $$;

-- Server-side context for one action: the tenant's Stripe customer and application.
create function private.billing_context(p_tenant_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare v jsonb;
begin
  perform private.require_hub_app_server();
  select jsonb_build_object('tenant_id',t.id,'tenant_name',t.name,'tenant_status',t.status,'stripe_customer_id',c.stripe_customer_id,
      'customer_version',coalesce(c.version,0),'email',coalesce(c.email,''))
    into v from hub.tenants t left join private.billing_customers c on c.tenant_id=t.id and not c.deleted where t.id=p_tenant_id;
  if v is null then raise exception 'Tenant not found.' using errcode='P0002'; end if;
  return v;
end; $$;

-- Audit rows carry states, amounts and Stripe identifiers only.
create function private.billing_audit(p_actor uuid,p_action text,p_tenant uuid,p_product uuid,p_metadata jsonb) returns void
language plpgsql security definer set search_path='' as $$
declare e record;
begin
  perform private.require_hub_app_server();
  if p_action !~ '^billing(\.[a-z_]+){1,3}$' or jsonb_typeof(p_metadata)<>'object' or (select count(*) from jsonb_each(p_metadata))>20 then
    raise exception 'Invalid billing audit.' using errcode='22023';
  end if;
  for e in select * from jsonb_each(p_metadata) loop
    if e.key !~ '^[a-z_]{1,40}$' or not (
      jsonb_typeof(e.value) in ('number','boolean','null')
      or (jsonb_typeof(e.value)='string' and (e.value#>>'{}') ~ '^[A-Za-z0-9_.:-]{0,255}$')) then
      raise exception 'Billing audit carries states, amounts and identifiers only.' using errcode='22023';
    end if;
  end loop;
  insert into private.audit_events(actor_id,action,entity_type,entity_id,tenant_id,product_id,metadata)
    values(p_actor,p_action,'billing',p_tenant,p_tenant,p_product,p_metadata);
end; $$;

-- 4. Applications: credentials, account links and entitlements.
create function private.billing_issue_app_key(p_actor uuid,p_product uuid,p_hash text,p_hint text) returns uuid
language plpgsql security definer set search_path='' as $$
declare v uuid;
begin
  perform private.require_hub_app_server();
  if not exists(select 1 from hub.products where id=p_product and status<>'retired' and slug<>'advisors') then raise exception 'Choose an application that bills.' using errcode='22023'; end if;
  if (select count(*) from private.billing_app_keys where product_id=p_product and revoked_at is null)>=2 then
    raise exception 'Revoke an older key before issuing another.' using errcode='22023';
  end if;
  insert into private.billing_app_keys(product_id,key_hash,key_hint,created_by) values(p_product,p_hash,p_hint,p_actor) returning id into v;
  perform private.billing_audit(p_actor,'billing.app_key.issue',null,p_product,jsonb_build_object('key_id',v::text));
  return v;
end; $$;

create function private.billing_revoke_app_key(p_actor uuid,p_key uuid) returns void
language plpgsql security definer set search_path='' as $$
declare v private.billing_app_keys;
begin
  perform private.require_hub_app_server();
  update private.billing_app_keys set revoked_at=now() where id=p_key and revoked_at is null returning * into v;
  if v.id is null then raise exception 'Key not found.' using errcode='P0002'; end if;
  perform private.billing_audit(p_actor,'billing.app_key.revoke',null,v.product_id,jsonb_build_object('key_id',v.id::text));
end; $$;

-- The application a key belongs to, or null.
create function private.billing_authenticate_app(p_hash text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v jsonb;
begin
  perform private.require_hub_app_server();
  update private.billing_app_keys k set last_used_at=now() from hub.products p
    where k.key_hash=p_hash and k.revoked_at is null and p.id=k.product_id and p.status<>'retired'
    returning jsonb_build_object('product_id',p.id,'slug',p.slug) into v;
  return v;
end; $$;

-- The federation issuer for an application's own account ids, created exactly
-- as customer onboarding creates it so both paths share one binding.
create function private.billing_issuer(p_product uuid) returns uuid
language plpgsql security definer set search_path='' as $$
declare v_slug text; v_code text; v_id uuid;
begin
  select slug into v_slug from hub.products where id=p_product;
  if v_slug is null or v_slug='advisors' then raise exception 'Choose an application that bills.' using errcode='22023'; end if;
  v_code:=case v_slug when 'caremetric-intel' then 'intel' else v_slug end;
  if v_code='carebase' then
    insert into private.federation_issuers(product_id,issuer,audience,jwks_url,enabled,verification_method)
      values(p_product,private.support_native_issuer(v_code),'authenticated','https://xsqobvvreaovwibxwyvv.supabase.co/auth/v1/.well-known/jwks.json',false,'oidc')
      on conflict(issuer) do nothing;
  else
    insert into private.federation_issuers(product_id,issuer,audience,jwks_url,enabled,verification_method)
      values(p_product,private.support_native_issuer(v_code),'support.operator_review',null,false,'operator_review')
      on conflict(issuer) do nothing;
  end if;
  select id into v_id from private.federation_issuers where issuer=private.support_native_issuer(v_code) and product_id=p_product;
  if v_id is null then raise exception 'Application federation is misconfigured.' using errcode='55000'; end if;
  return v_id;
end; $$;

create function private.billing_resolve_account(p_product uuid,p_account text) returns uuid
language sql stable security definer set search_path='' as $$
  select t.hub_tenant_id from private.federated_tenants t join private.federation_issuers f on f.id=t.issuer_id
  join hub.products p on p.id=f.product_id
  where f.product_id=p_product and f.issuer=private.support_native_issuer(case p.slug when 'caremetric-intel' then 'intel' else p.slug end)
    and t.external_tenant_hash=private.support_identity_hash(p_account);
$$;

-- What a tenant has for one application. A subscription that is active,
-- trialing or past due (Stripe is retrying payment) grants its products.
create function private.billing_entitlements(p_tenant uuid,p_product uuid) returns jsonb
language sql stable security definer set search_path='' as $$
  with settings as (select livemode from private.billing_settings),
  subs as (
    select s.* from private.billing_subscriptions s, settings
    where s.tenant_id=p_tenant and s.product_id=p_product and (settings.livemode is null or s.livemode=settings.livemode)
      and s.status not in ('canceled','incomplete_expired')
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

create function private.billing_app_entitlements(p_product uuid,p_account text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_tenant uuid;
begin
  perform private.require_hub_app_server();
  if p_account is null or p_account !~ '^[A-Za-z0-9_-]{1,128}$' then raise exception 'Invalid account.' using errcode='22023'; end if;
  v_tenant:=private.billing_resolve_account(p_product,p_account);
  if v_tenant is null then
    return jsonb_build_object('tenant_id',null,'app',(select slug from hub.products where id=p_product),'status','none','entitled',false,
      'trial_end',null,'current_period_end',null,'cancel_at_period_end',false,'products','[]'::jsonb,'linked',false);
  end if;
  if (select status from hub.tenants where id=v_tenant)<>'active' then
    return private.billing_entitlements(v_tenant,p_product)||jsonb_build_object('entitled',false,'status','suspended','products','[]'::jsonb,'linked',true);
  end if;
  return private.billing_entitlements(v_tenant,p_product)||jsonb_build_object('linked',true);
end; $$;

-- A tenant for an application account that signs up on its own, created once
-- and linked, so the Hub can start its trial. Returns the existing tenant when
-- the account is already linked.
create function private.billing_app_tenant(p_product uuid,p_account text,p_name text) returns uuid
language plpgsql security definer set search_path='' as $$
declare v_tenant uuid; v_slug text; v_issuer uuid;
begin
  perform private.require_hub_app_server();
  if p_account is null or p_account !~ '^[A-Za-z0-9_-]{1,128}$' then raise exception 'Invalid account.' using errcode='22023'; end if;
  if p_name is null or char_length(btrim(p_name)) not between 2 and 180 or p_name ~ '[[:cntrl:]]' then raise exception 'Invalid organization name.' using errcode='22023'; end if;
  v_tenant:=private.billing_resolve_account(p_product,p_account);
  if v_tenant is not null then return v_tenant; end if;
  v_issuer:=private.billing_issuer(p_product);
  v_slug:=(select slug from hub.products where id=p_product)||'-'||left(private.support_identity_hash(p_account),12);
  insert into hub.tenants(slug,name) values(v_slug,btrim(p_name)) on conflict (slug) do nothing returning id into v_tenant;
  if v_tenant is null then select id into v_tenant from hub.tenants where slug=v_slug; end if;
  insert into private.federated_tenants(issuer_id,external_tenant_hash,hub_tenant_id)
    values(v_issuer,private.support_identity_hash(p_account),v_tenant) on conflict do nothing;
  insert into private.billing_account_links(tenant_id,product_id,account_hint) values(v_tenant,p_product,right(p_account,6)) on conflict do nothing;
  insert into hub.tenant_products(tenant_id,product_id) values(v_tenant,p_product) on conflict do nothing;
  perform private.billing_audit(null,'billing.trial.tenant',v_tenant,p_product,'{}'::jsonb);
  return v_tenant;
end; $$;

-- Subscription items a usage report may change: per-unit prices on live
-- subscriptions of this application whose product counts the reported metric.
create function private.billing_usage_targets(p_product uuid,p_account text,p_metric text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_tenant uuid;
begin
  perform private.require_hub_app_server();
  if p_account is null or p_account !~ '^[A-Za-z0-9_-]{1,128}$' or p_metric !~ '^[a-z][a-z0-9_]{0,39}$' then raise exception 'Invalid usage report.' using errcode='22023'; end if;
  v_tenant:=private.billing_resolve_account(p_product,p_account);
  if v_tenant is null then return jsonb_build_object('tenant_id',null,'items','[]'::jsonb); end if;
  return jsonb_build_object('tenant_id',v_tenant,'items',coalesce((select jsonb_agg(jsonb_build_object(
      'item',i.stripe_item_id,'subscription',s.stripe_subscription_id,'quantity',i.quantity,'version',s.version) order by i.stripe_item_id)
    from private.billing_subscriptions s join private.billing_subscription_items i on i.stripe_subscription_id=s.stripe_subscription_id
    join private.billing_prices r on r.stripe_price_id=i.stripe_price_id join private.billing_products p on p.stripe_product_id=i.stripe_product_id
    where s.tenant_id=v_tenant and s.product_id=p_product and s.status in ('active','trialing','past_due','paused')
      and r.pricing_model='per_unit' and (p.unit_label=p_metric or p.metadata->>'billing_metric'=p_metric)),'[]'::jsonb));
end; $$;

-- Returns the earlier outcome for a retried report, or null for a new one.
create function private.billing_usage_seen(p_product uuid,p_request_key uuid) returns jsonb
language sql stable security definer set search_path='' as $$
  select jsonb_build_object('outcome',outcome,'items_updated',items_updated,'quantity',quantity)
  from private.billing_usage_reports where product_id=p_product and request_key=p_request_key;
$$;

create function private.billing_record_usage(p_product uuid,p_tenant uuid,p_metric text,p_quantity integer,p_request_key uuid,p_outcome text,p_items integer) returns void
language plpgsql security definer set search_path='' as $$
begin
  perform private.require_hub_app_server();
  insert into private.billing_usage_reports(product_id,tenant_id,metric,quantity,request_key,outcome,items_updated)
    values(p_product,p_tenant,p_metric,p_quantity,p_request_key,p_outcome,p_items) on conflict (product_id,request_key) do nothing;
  if p_outcome in ('updated','failed') then
    perform private.billing_audit(null,'billing.usage.'||p_outcome,p_tenant,p_product,jsonb_build_object('metric',p_metric,'quantity',p_quantity,'items',p_items));
  end if;
end; $$;

-- Links (or relinks) an application account to a tenant for billing.
create function private.billing_link_account(p_actor uuid,p_tenant uuid,p_product uuid,p_account text,p_expected_version integer) returns void
language plpgsql security definer set search_path='' as $$
declare v_issuer uuid; v_hash text; v_prior uuid; v_link private.billing_account_links;
begin
  perform private.require_hub_app_server();
  if p_account is null or p_account !~ '^[A-Za-z0-9_-]{1,128}$' then raise exception 'Enter the application''s account id.' using errcode='22023'; end if;
  if not exists(select 1 from hub.tenants where id=p_tenant) then raise exception 'Tenant not found.' using errcode='P0002'; end if;
  perform private.billing_lock('link',p_tenant::text||':'||p_product::text,p_expected_version);
  v_issuer:=private.billing_issuer(p_product);
  v_hash:=private.support_identity_hash(p_account);
  select hub_tenant_id into v_prior from private.federated_tenants where issuer_id=v_issuer and external_tenant_hash=v_hash for update;
  if v_prior is not null and v_prior<>p_tenant then raise exception 'That account is already linked to another tenant.' using errcode='23505'; end if;
  -- One account per tenant and application: replace an earlier link.
  delete from private.federated_tenants where issuer_id=v_issuer and hub_tenant_id=p_tenant and external_tenant_hash<>v_hash;
  if v_prior is null then
    insert into private.federated_tenants(issuer_id,external_tenant_hash,hub_tenant_id) values(v_issuer,v_hash,p_tenant);
  end if;
  insert into private.billing_account_links as l(tenant_id,product_id,account_hint,linked_by) values(p_tenant,p_product,right(p_account,6),p_actor)
    on conflict (tenant_id,product_id) do update set account_hint=excluded.account_hint,linked_by=excluded.linked_by,linked_at=now(),version=l.version+1
    returning * into v_link;
  insert into hub.tenant_products(tenant_id,product_id) values(p_tenant,p_product) on conflict do nothing;
  perform private.billing_audit(p_actor,'billing.account.link',p_tenant,p_product,jsonb_build_object('version',v_link.version));
end; $$;

create function private.billing_unlink_account(p_actor uuid,p_tenant uuid,p_product uuid,p_expected_version integer) returns void
language plpgsql security definer set search_path='' as $$
declare v_issuer uuid;
begin
  perform private.require_hub_app_server();
  perform private.billing_lock('link',p_tenant::text||':'||p_product::text,p_expected_version);
  v_issuer:=private.billing_issuer(p_product);
  delete from private.federated_tenants where issuer_id=v_issuer and hub_tenant_id=p_tenant;
  delete from private.billing_account_links where tenant_id=p_tenant and product_id=p_product;
  perform private.billing_audit(p_actor,'billing.account.unlink',p_tenant,p_product,'{}'::jsonb);
end; $$;

-- 5. Read models.
create function private.billing_subscription_view(s private.billing_subscriptions) returns jsonb
language sql stable set search_path='' as $$
  select jsonb_build_object('id',s.stripe_subscription_id,'tenant_id',s.tenant_id,'customer',s.stripe_customer_id,
    'app',(select slug from hub.products where id=s.product_id),'status',s.status,'collection_method',s.collection_method,
    'cancel_at_period_end',s.cancel_at_period_end,'cancel_at',s.cancel_at,'canceled_at',s.canceled_at,'ended_at',s.ended_at,
    'current_period_start',s.current_period_start,'current_period_end',s.current_period_end,'trial_start',s.trial_start,'trial_end',s.trial_end,
    'pause_behavior',s.pause_behavior,'pause_resumes_at',s.pause_resumes_at,'discounts',s.discounts,'created',s.stripe_created,'version',s.version,
    'items',coalesce((select jsonb_agg(jsonb_build_object('id',i.stripe_item_id,'price',i.stripe_price_id,'product',i.stripe_product_id,
        'quantity',i.quantity,'unit_amount',i.unit_amount,'currency',i.currency,'interval',i.recurring_interval,'interval_count',i.interval_count,
        'product_name',coalesce(p.name,i.stripe_product_id),'kind',coalesce(p.kind,'plan'),'unit_label',coalesce(p.unit_label,''),
        'pricing_model',coalesce(r.pricing_model,'flat'),'custom',r.tenant_id is not null) order by p.kind,p.name)
      from private.billing_subscription_items i left join private.billing_products p on p.stripe_product_id=i.stripe_product_id
      left join private.billing_prices r on r.stripe_price_id=i.stripe_price_id
      where i.stripe_subscription_id=s.stripe_subscription_id),'[]'::jsonb));
$$;

create function private.billing_price_view(r private.billing_prices) returns jsonb
language sql stable set search_path='' as $$
  select jsonb_build_object('id',r.stripe_price_id,'product',r.stripe_product_id,'active',r.active,'currency',r.currency,'unit_amount',r.unit_amount,
    'pricing_model',r.pricing_model,'type',r.type,'interval',r.recurring_interval,'interval_count',r.interval_count,'lookup_key',r.lookup_key,
    'nickname',r.nickname,'tenant_id',r.tenant_id,'replaces',r.replaces_price_id,'created',r.stripe_created,'version',r.version,
    'subscribers',(select count(distinct i.stripe_subscription_id) from private.billing_subscription_items i join private.billing_subscriptions s
      on s.stripe_subscription_id=i.stripe_subscription_id where i.stripe_price_id=r.stripe_price_id and s.status not in ('canceled','incomplete_expired')));
$$;

create function private.billing_invoice_view(v private.billing_invoices) returns jsonb
language sql stable set search_path='' as $$
  select jsonb_build_object('id',v.stripe_invoice_id,'tenant_id',v.tenant_id,'subscription',v.stripe_subscription_id,
    'app',(select slug from hub.products where id=v.product_id),'status',v.status,'number',v.number,'currency',v.currency,'total',v.total,
    'amount_due',v.amount_due,'amount_paid',v.amount_paid,'amount_remaining',v.amount_remaining,'hosted_invoice_url',v.hosted_invoice_url,
    'invoice_pdf',v.invoice_pdf,'collection_method',v.collection_method,'period_start',v.period_start,'period_end',v.period_end,
    'due_date',v.due_date,'created',v.stripe_created,'version',v.version);
$$;

revoke all on function private.require_hub_app_server(),private.billing_keys(jsonb,text[]),private.billing_ts(jsonb),
  private.billing_text(jsonb,integer),private.billing_int(jsonb),private.billing_bool(jsonb),private.billing_app(jsonb),
  private.billing_sync(text,jsonb,timestamptz),private.billing_forget_invoice(text),private.billing_record_event(text,text,boolean,text,timestamptz,text),private.billing_event_seen(text),
  private.billing_set_account(text,boolean),private.billing_lookup(text,text),private.billing_mark_coupon_deleted(text),private.billing_lock(text,text,integer),private.billing_context(uuid),
  private.billing_audit(uuid,text,uuid,uuid,jsonb),private.billing_issue_app_key(uuid,uuid,text,text),private.billing_revoke_app_key(uuid,uuid),
  private.billing_authenticate_app(text),private.billing_issuer(uuid),private.billing_resolve_account(uuid,text),private.billing_entitlements(uuid,uuid),
  private.billing_app_entitlements(uuid,text),private.billing_app_tenant(uuid,text,text),private.billing_usage_targets(uuid,text,text),private.billing_usage_seen(uuid,uuid),
  private.billing_record_usage(uuid,uuid,text,integer,uuid,text,integer),private.billing_link_account(uuid,uuid,uuid,text,integer),
  private.billing_unlink_account(uuid,uuid,uuid,integer),private.billing_subscription_view(private.billing_subscriptions),
  private.billing_price_view(private.billing_prices),private.billing_invoice_view(private.billing_invoices)
  from public,anon,authenticated,service_role,hub_app_server;
-- The Hub server role runs only the write path, after relational authorization.
grant execute on function private.billing_sync(text,jsonb,timestamptz),private.billing_forget_invoice(text),private.billing_record_event(text,text,boolean,text,timestamptz,text),
  private.billing_event_seen(text),private.billing_set_account(text,boolean),private.billing_lookup(text,text),private.billing_mark_coupon_deleted(text),private.billing_lock(text,text,integer),private.billing_context(uuid),
  private.billing_audit(uuid,text,uuid,uuid,jsonb),private.billing_issue_app_key(uuid,uuid,text,text),private.billing_revoke_app_key(uuid,uuid),
  private.billing_authenticate_app(text),private.billing_app_entitlements(uuid,text),private.billing_app_tenant(uuid,text,text),private.billing_usage_targets(uuid,text,text),
  private.billing_usage_seen(uuid,uuid),private.billing_record_usage(uuid,uuid,text,integer,uuid,text,integer),
  private.billing_link_account(uuid,uuid,uuid,text,integer),private.billing_unlink_account(uuid,uuid,uuid,integer)
  to hub_app_server;

-- 6. Administrator RPCs.
-- Everything the Billing workspace lists: tenants and their Stripe customers,
-- every subscription across applications, the catalog, discounts and app keys.
create function hub.billing_workspace() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare v_live boolean;
begin
  perform hub.authorize_app_admin();
  select livemode into v_live from private.billing_settings;
  return jsonb_build_object(
    'mode',case when v_live is null then 'unverified' when v_live then 'live' else 'test' end,
    'account',(select stripe_account_id from private.billing_settings),
    'apps',(select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'slug',p.slug,'name',p.name,'status',p.status) order by p.name),'[]'::jsonb)
      from hub.products p where p.status<>'retired' and p.slug<>'advisors'),
    'tenants',(select coalesce(jsonb_agg(jsonb_build_object('id',t.id,'slug',t.slug,'name',t.name,'industry',coalesce(t.industry,''),'status',t.status,
        'updated_at',t.updated_at,'customer',case when c.tenant_id is null or c.deleted then null else jsonb_build_object('id',c.stripe_customer_id,
          'email',c.email,'name',c.name,'delinquent',c.delinquent,'balance',c.balance,'version',c.version) end) order by t.name,t.id),'[]'::jsonb)
      from hub.tenants t left join private.billing_customers c on c.tenant_id=t.id),
    'subscriptions',(select coalesce(jsonb_agg(private.billing_subscription_view(s) order by s.stripe_created desc),'[]'::jsonb)
      from private.billing_subscriptions s where v_live is null or s.livemode=v_live),
    'products',(select coalesce(jsonb_agg(jsonb_build_object('id',p.stripe_product_id,'app',(select slug from hub.products where id=p.product_id),
        'name',p.name,'description',p.description,'active',p.active,'kind',p.kind,'entitlement_key',p.entitlement_key,'unit_label',p.unit_label,
        'created',p.stripe_created,'version',p.version) order by p.active desc,p.name),'[]'::jsonb)
      from private.billing_products p where v_live is null or p.livemode=v_live),
    'prices',(select coalesce(jsonb_agg(private.billing_price_view(r) order by r.active desc,r.stripe_created desc),'[]'::jsonb)
      from private.billing_prices r where (v_live is null or r.livemode=v_live) and r.tenant_id is null),
    'coupons',(select coalesce(jsonb_agg(jsonb_build_object('id',c.stripe_coupon_id,'name',c.name,'percent_off',c.percent_off,'amount_off',c.amount_off,
        'currency',c.currency,'duration',c.duration,'duration_in_months',c.duration_in_months,'max_redemptions',c.max_redemptions,
        'times_redeemed',c.times_redeemed,'redeem_by',c.redeem_by,'valid',c.valid,'applies_to',to_jsonb(c.applies_to_products),
        'app',(select slug from hub.products where id=c.product_id),'created',c.stripe_created,'version',c.version) order by c.stripe_created desc),'[]'::jsonb)
      from private.billing_coupons c where not c.deleted and (v_live is null or c.livemode=v_live)),
    'promotion_codes',(select coalesce(jsonb_agg(jsonb_build_object('id',c.stripe_promotion_code_id,'code',c.code,'coupon',c.stripe_coupon_id,
        'active',c.active,'customer',c.stripe_customer_id,'max_redemptions',c.max_redemptions,'times_redeemed',c.times_redeemed,
        'expires_at',c.expires_at,'first_time_transaction',c.first_time_transaction,'minimum_amount',c.minimum_amount,
        'created',c.stripe_created,'version',c.version) order by c.stripe_created desc),'[]'::jsonb)
      from private.billing_promotion_codes c where v_live is null or c.livemode=v_live),
    'app_keys',(select coalesce(jsonb_agg(jsonb_build_object('id',k.id,'app',p.slug,'hint',k.key_hint,'created_at',k.created_at,
        'last_used_at',k.last_used_at,'revoked_at',k.revoked_at) order by k.created_at desc),'[]'::jsonb)
      from private.billing_app_keys k join hub.products p on p.id=k.product_id),
    'webhook',(select jsonb_build_object('last_received_at',max(received_at),'events_24h',count(*) filter (where received_at>now()-interval '24 hours'))
      from private.billing_webhook_events),
    'loaded_at',now());
end; $$;

-- One customer: subscriptions, customer-specific prices, invoices, links and usage.
create function hub.billing_customer(p_tenant_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare v_live boolean; v_out jsonb;
begin
  perform hub.authorize_app_admin();
  select livemode into v_live from private.billing_settings;
  select jsonb_build_object('id',t.id,'slug',t.slug,'name',t.name,'industry',coalesce(t.industry,''),'status',t.status,'updated_at',t.updated_at,
    'customer',case when c.tenant_id is null or c.deleted then null else jsonb_build_object('id',c.stripe_customer_id,'email',c.email,'name',c.name,
      'delinquent',c.delinquent,'balance',c.balance,'version',c.version) end,
    'subscriptions',(select coalesce(jsonb_agg(private.billing_subscription_view(s) order by s.stripe_created desc),'[]'::jsonb)
      from private.billing_subscriptions s where s.tenant_id=t.id and (v_live is null or s.livemode=v_live)),
    'custom_prices',(select coalesce(jsonb_agg(private.billing_price_view(r) order by r.stripe_created desc),'[]'::jsonb)
      from private.billing_prices r where r.tenant_id=t.id and (v_live is null or r.livemode=v_live)),
    'invoices',(select coalesce(jsonb_agg(private.billing_invoice_view(v) order by v.stripe_created desc),'[]'::jsonb)
      from (select * from private.billing_invoices where tenant_id=t.id and (v_live is null or livemode=v_live) order by stripe_created desc limit 100) v),
    'links',(select coalesce(jsonb_agg(jsonb_build_object('app',p.slug,'hint',l.account_hint,'version',l.version,'linked_at',l.linked_at) order by p.name),'[]'::jsonb)
      from private.billing_account_links l join hub.products p on p.id=l.product_id where l.tenant_id=t.id),
    'usage',(select coalesce(jsonb_agg(jsonb_build_object('app',p.slug,'metric',u.metric,'quantity',u.quantity,'outcome',u.outcome,'reported_at',u.reported_at)
        order by u.reported_at desc),'[]'::jsonb)
      from (select * from private.billing_usage_reports where tenant_id=t.id order by reported_at desc limit 20) u join hub.products p on p.id=u.product_id),
    'loaded_at',now())
  into v_out from hub.tenants t left join private.billing_customers c on c.tenant_id=t.id where t.id=p_tenant_id;
  if v_out is null then raise exception 'Tenant not found.' using errcode='P0002'; end if;
  return v_out;
end; $$;

-- Sets up a tenant by hand. Slugs that onboarding generates stay reserved for it.
create function hub.create_tenant(p_record jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_tenant_id uuid;
begin
  perform hub.authorize_app_command();
  perform private.billing_keys(p_record,array['name','slug','industry']);
  if jsonb_typeof(p_record->'name')<>'string' or jsonb_typeof(p_record->'slug')<>'string' or jsonb_typeof(p_record->'industry')<>'string'
    or char_length(btrim(p_record->>'name')) not between 2 and 180 or p_record->>'name' ~ '[[:cntrl:]]'
    or char_length(p_record->>'industry')>120 or p_record->>'industry' ~ '[[:cntrl:]]' then
    raise exception 'Invalid tenant details.';
  end if;
  if char_length(p_record->>'slug') not between 2 and 63 or p_record->>'slug' !~ '^[a-z0-9]+(-[a-z0-9]+)*$' then
    raise exception 'Use a slug of lowercase letters, numbers and single hyphens.';
  end if;
  if p_record->>'slug' ~ '^(carebase|support)-' then
    raise exception 'Slugs beginning with carebase- or support- are reserved for app onboarding.';
  end if;
  begin
    insert into hub.tenants(slug,name,industry) values(p_record->>'slug',btrim(p_record->>'name'),nullif(btrim(p_record->>'industry'),''))
      returning id into v_tenant_id;
  exception when unique_violation then
    raise exception 'A tenant with this slug already exists.';
  end;
  insert into private.audit_events(actor_id,action,entity_type,entity_id,tenant_id,metadata)
    values(auth.uid(),'tenant.create','tenant',v_tenant_id,v_tenant_id,jsonb_build_object('status','active'));
  return jsonb_build_object('id',v_tenant_id);
end; $$;

-- Edits a tenant's name, industry and status. The slug never changes.
create or replace function hub.save_tenant(p_tenant_id uuid,p_record jsonb,p_expected_updated_at timestamptz) returns jsonb
language plpgsql security definer set search_path='' as $$
declare old hub.tenants; saved hub.tenants;
begin
  perform hub.authorize_app_command();
  perform private.billing_keys(p_record,array['name','industry','status']);
  if jsonb_typeof(p_record->'name')<>'string' or jsonb_typeof(p_record->'industry')<>'string' or jsonb_typeof(p_record->'status')<>'string'
    or char_length(btrim(p_record->>'name')) not between 2 and 180 or p_record->>'name' ~ '[[:cntrl:]]'
    or char_length(p_record->>'industry')>120 or p_record->>'industry' ~ '[[:cntrl:]]'
    or p_record->>'status' not in ('active','suspended','closed') then
    raise exception 'Invalid tenant details.';
  end if;
  select * into old from hub.tenants where id=p_tenant_id for update;
  if not found or old.updated_at is distinct from p_expected_updated_at then
    raise exception 'Tenant changed. Refresh and review before saving.';
  end if;
  update hub.tenants set name=btrim(p_record->>'name'),industry=nullif(btrim(p_record->>'industry'),''),
    status=(p_record->>'status')::hub.tenant_status where id=p_tenant_id returning * into saved;
  insert into private.audit_events(actor_id,action,entity_type,entity_id,tenant_id,metadata)
    values(auth.uid(),'tenant.update','tenant',p_tenant_id,p_tenant_id,jsonb_build_object('status',p_record->>'status'));
  return jsonb_build_object('id',saved.id,'updated_at',saved.updated_at);
end; $$;

-- The tenant administrator's own billing: plans, quantities and invoices for
-- each tenant they administer. Never another tenant's.
create function hub.my_billing() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare v_live boolean;
begin
  if not private.current_app_session_verified() then raise exception 'Sign in with an SMS code to continue.' using errcode='28000'; end if;
  select livemode into v_live from private.billing_settings;
  return jsonb_build_object('tenants',(select coalesce(jsonb_agg(jsonb_build_object('id',t.id,'name',t.name,
      'has_customer',exists(select 1 from private.billing_customers c where c.tenant_id=t.id and not c.deleted),
      'subscriptions',(select coalesce(jsonb_agg(jsonb_build_object('app',(select name from hub.products where id=s.product_id),'status',s.status,
          'cancel_at_period_end',s.cancel_at_period_end,'current_period_end',s.current_period_end,'trial_end',s.trial_end,
          'paused',s.pause_behavior is not null,'items',(select coalesce(jsonb_agg(jsonb_build_object('name',coalesce(p.name,'Plan'),'kind',coalesce(p.kind,'plan'),
            'quantity',i.quantity,'unit_label',coalesce(p.unit_label,''),'unit_amount',i.unit_amount,'currency',i.currency,'interval',i.recurring_interval,
            'interval_count',i.interval_count) order by p.kind,p.name),'[]'::jsonb)
            from private.billing_subscription_items i left join private.billing_products p on p.stripe_product_id=i.stripe_product_id
            where i.stripe_subscription_id=s.stripe_subscription_id)) order by s.stripe_created desc),'[]'::jsonb)
        from private.billing_subscriptions s where s.tenant_id=t.id and (v_live is null or s.livemode=v_live)
          and s.status not in ('incomplete_expired') and (s.status<>'canceled' or s.ended_at>now()-interval '90 days')),
      'invoices',(select coalesce(jsonb_agg(jsonb_build_object('id',v.stripe_invoice_id,'number',v.number,'status',v.status,'currency',v.currency,
          'total',v.total,'amount_remaining',v.amount_remaining,'due_date',v.due_date,'created',v.stripe_created,
          'hosted_invoice_url',v.hosted_invoice_url,'invoice_pdf',v.invoice_pdf) order by v.stripe_created desc),'[]'::jsonb)
        from (select * from private.billing_invoices where tenant_id=t.id and status<>'draft' and (v_live is null or livemode=v_live)
          order by stripe_created desc limit 50) v)
    ) order by t.name),'[]'::jsonb)
    from hub.tenants t where exists(select 1 from hub.tenant_product_memberships m where m.tenant_id=t.id and m.user_id=(select auth.uid())
      and m.role='tenant_admin' and m.status='active' and m.revoked_at is null)),
    'loaded_at',now());
end; $$;

-- The Stripe customer of a tenant the current user administers, for opening
-- the customer portal. Raises for anyone else.
create function hub.authorize_tenant_billing(p_tenant_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare v text;
begin
  if not private.current_app_session_verified() or not exists(select 1 from hub.tenant_product_memberships m where m.tenant_id=p_tenant_id
      and m.user_id=(select auth.uid()) and m.role='tenant_admin' and m.status='active' and m.revoked_at is null)
    or not exists(select 1 from hub.tenants where id=p_tenant_id and status<>'closed') then
    raise exception 'You do not manage billing for this organization.' using errcode='42501';
  end if;
  select stripe_customer_id into v from private.billing_customers where tenant_id=p_tenant_id and not deleted;
  if v is null then raise exception 'Billing is not set up for this organization yet.' using errcode='P0002'; end if;
  return jsonb_build_object('tenant_id',p_tenant_id,'stripe_customer_id',v,'user_id',auth.uid());
end; $$;

revoke all on function hub.billing_workspace(),hub.billing_customer(uuid),hub.create_tenant(jsonb),hub.save_tenant(uuid,jsonb,timestamptz),hub.my_billing(),hub.authorize_tenant_billing(uuid) from public,anon;
grant execute on function hub.billing_workspace(),hub.billing_customer(uuid),hub.create_tenant(jsonb),hub.save_tenant(uuid,jsonb,timestamptz),hub.my_billing(),hub.authorize_tenant_billing(uuid) to authenticated;
