-- Customer invitations (owner request 2026-11-19): "an easy way for me to invite a customer to the platform (must choose which app)
-- and then authorize a price (with discount from 0-100%). They should get an email welcoming them to the platform, describe the app
-- they were chosen for, their discount and a link to sign up. If it's a 100% discount, it can bypass the Stripe interface completely."
--
-- 1. private.customer_invitations: one invitation the owner authorized, for one application (CareBase, Breathe or CareMetric Intel), one
--    published plan price and quantity, and a discount of 0 to 100% for as long as they subscribe, for some months, or once. The link's
--    token is stored only as its SHA-256 hash; the owner's Billing page never sees it.
-- 2. Accepting it on the Hub's welcome page creates the customer's tenant (private.customer_invitation_tenant). At 100% the Hub server
--    creates the subscription itself, with no Checkout and no card; below 100% the customer pays in Stripe Checkout first. The
--    invitation records each Stripe identity as it is made (private.customer_invitation_progress).
-- 3. The application's sign-up then passes the invitation (`invite` on POST /api/apps/trials). private.customer_invitation_claim links the
--    new application account to the invitation's tenant instead of starting a trial. An application that does not pass it yet is held
--    when the sign-up's email matches an activated invitation, so the customer is never billed twice; the owner links that account from
--    the invitation (private.customer_invitation_owner 'link').
-- 4. Settings -> Billing: each application's sign-up address and how many days an invitation link lasts.
--
-- Every function is a security definer with an empty search path that only the Hub server may run. Audit rows carry states, amounts
-- and identifiers only. 20261120120100_customer_invitations_contract.sql declares billing.customer-invitations.v1; the server answers
-- nothing about invitations until it is declared.
set local lock_timeout = '10s';

insert into private.hub_settings (key, kind) values
  ('billing.invite_carebase_signup', 'text'),
  ('billing.invite_breathe_signup', 'text'),
  ('billing.invite_intel_signup', 'text'),
  ('billing.invite_days', 'number')
on conflict (key) do nothing;

create table if not exists private.customer_invitations (
  id uuid primary key default gen_random_uuid(),
  -- The owner's request: sending the same form again (a retry after an uncertain answer) returns this invitation, never a second one.
  request_key uuid not null unique,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  product_id uuid not null references hub.products(id) on delete restrict,
  contact_name text not null check (char_length(btrim(contact_name)) between 1 and 120 and contact_name !~ '[[:cntrl:]]'),
  contact_email text not null check (char_length(contact_email) between 3 and 320 and contact_email ~ '^[^[:space:]@<>"]+@[^[:space:]@<>"]+\.[^[:space:]@<>"]+$'),
  organization_name text not null check (char_length(btrim(organization_name)) between 2 and 180 and organization_name !~ '[[:cntrl:]]'),
  -- The plan price the owner authorized, as it was when the invitation was made.
  stripe_price_id text not null check (stripe_price_id ~ '^[A-Za-z0-9_-]{1,255}$'),
  stripe_product_id text not null check (stripe_product_id ~ '^[A-Za-z0-9_-]{1,255}$'),
  plan_name text not null check (char_length(plan_name) between 1 and 250),
  unit_label text not null default '' check (char_length(unit_label) <= 12),
  pricing_model text not null check (pricing_model in ('flat', 'per_unit')),
  quantity integer not null default 1 check (quantity between 1 and 10000),
  unit_amount bigint not null check (unit_amount between 0 and 100000000),
  currency text not null check (currency ~ '^[a-z]{3}$'),
  recurring_interval text not null check (recurring_interval in ('day', 'week', 'month', 'year')),
  interval_count integer not null default 1 check (interval_count between 1 and 365),
  discount_percent numeric(5,2) not null check (discount_percent between 0 and 100),
  discount_duration text not null check (discount_duration in ('forever', 'once', 'repeating')),
  discount_months integer check (discount_months between 1 and 36),
  note text not null default '' check (char_length(note) <= 1000),
  status text not null default 'pending' check (status in ('pending', 'checkout', 'active', 'claimed', 'revoked')),
  expires_at timestamptz not null,
  tenant_id uuid references hub.tenants(id) on delete restrict,
  stripe_customer_id text check (stripe_customer_id ~ '^cus_[A-Za-z0-9]{1,250}$'),
  stripe_coupon_id text check (stripe_coupon_id ~ '^[A-Za-z0-9_-]{1,255}$'),
  checkout_session_id text check (checkout_session_id ~ '^cs_[A-Za-z0-9_]{1,250}$'),
  checkout_attempt integer not null default 0 check (checkout_attempt between 0 and 1000),
  stripe_subscription_id text check (stripe_subscription_id ~ '^sub_[A-Za-z0-9]{1,250}$'),
  -- An application sign-up held because its email matched this activated invitation: the account by hash and its last characters.
  pending_account_hash text check (pending_account_hash ~ '^[0-9a-f]{64}$'),
  pending_account_hint text check (pending_account_hint ~ '^[A-Za-z0-9_-]{1,6}$'),
  pending_account_at timestamptz,
  account_hint text check (account_hint ~ '^[A-Za-z0-9_-]{1,6}$'),
  claim_method text check (claim_method in ('code', 'owner')),
  claimed_at timestamptz,
  email_status text check (email_status in ('sent', 'failed', 'unknown')),
  email_sent_at timestamptz,
  send_count integer not null default 0 check (send_count between 0 and 1000),
  ready_email_at timestamptz,
  accepted_at timestamptz,
  activated_at timestamptz,
  revoked_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1 check (version > 0),
  check ((discount_duration = 'repeating') = (discount_months is not null)),
  check (discount_percent > 0 or (discount_duration = 'forever' and stripe_coupon_id is null)),
  check (pricing_model = 'per_unit' or quantity = 1),
  check ((pending_account_hash is null) = (pending_account_hint is null)),
  check (status not in ('active', 'claimed') or (tenant_id is not null and stripe_subscription_id is not null)),
  check ((status = 'claimed') = (claimed_at is not null and account_hint is not null and claim_method is not null)),
  check (status <> 'checkout' or checkout_session_id is not null)
);
create index if not exists customer_invitations_created on private.customer_invitations (created_at desc);
create index if not exists customer_invitations_email on private.customer_invitations (product_id, lower(contact_email)) where status = 'active';
create unique index if not exists customer_invitations_checkout on private.customer_invitations (checkout_session_id) where checkout_session_id is not null;
alter table private.customer_invitations enable row level security;
revoke all on private.customer_invitations from public, anon, authenticated, service_role, hub_app_server;

-- What the owner's Billing page shows for one invitation: never the token's hash, the account's hash or a Stripe customer.
create or replace function private.customer_invitation_view(p private.customer_invitations) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', p.id, 'app', (select slug from hub.products where id = p.product_id),
    'contact_name', p.contact_name, 'contact_email', p.contact_email, 'organization_name', p.organization_name,
    'price', p.stripe_price_id, 'plan_name', p.plan_name, 'unit_label', p.unit_label, 'pricing_model', p.pricing_model, 'quantity', p.quantity,
    'unit_amount', p.unit_amount, 'currency', p.currency, 'interval', p.recurring_interval, 'interval_count', p.interval_count,
    'discount_percent', p.discount_percent, 'discount_duration', p.discount_duration, 'discount_months', p.discount_months, 'note', p.note,
    'status', case when p.status in ('pending', 'checkout') and p.expires_at <= now() then 'expired' else p.status end,
    'expires_at', p.expires_at, 'tenant_id', p.tenant_id, 'subscription', p.stripe_subscription_id,
    'pending_account_hint', p.pending_account_hint, 'pending_account_at', p.pending_account_at,
    'account_hint', p.account_hint, 'claim_method', p.claim_method, 'claimed_at', p.claimed_at,
    'email_status', p.email_status, 'email_sent_at', p.email_sent_at, 'send_count', p.send_count,
    'accepted_at', p.accepted_at, 'activated_at', p.activated_at, 'revoked_at', p.revoked_at,
    'created_at', p.created_at, 'version', p.version);
$$;

-- Everything the Hub server needs to act on one invitation: the owner's view plus its Stripe and tenant identities.
create or replace function private.customer_invitation_internal(p private.customer_invitations) returns jsonb
language sql stable security definer set search_path = '' as $$
  select private.customer_invitation_view(p) || jsonb_build_object(
    'product_id', p.product_id, 'product', p.stripe_product_id, 'raw_status', p.status,
    'customer', p.stripe_customer_id, 'coupon', p.stripe_coupon_id, 'checkout', p.checkout_session_id, 'checkout_attempt', p.checkout_attempt,
    'ready_email_at', p.ready_email_at, 'app_name', (select name from hub.products where id = p.product_id));
$$;

-- One published plan price of an application, as an invitation would offer it: active, recurring, public (not one customer's own), flat or
-- per unit, of a plan (not an add-on or a fee), in the mode Stripe is in. The owner's preview and the invitation itself use it.
create or replace function private.customer_invitation_price(p_app text, p_price text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_price jsonb;
begin
  perform private.require_hub_app_server();
  if p_app is null or p_app not in ('carebase', 'breathe', 'caremetric-intel') then
    raise exception 'Choose CareBase, Breathe or CareMetric Intel.' using errcode = '22023';
  end if;
  select jsonb_build_object('product_id', a.id, 'price', r.stripe_price_id, 'product', p.stripe_product_id, 'plan_name', p.name, 'unit_label', p.unit_label,
           'pricing_model', r.pricing_model, 'unit_amount', r.unit_amount, 'currency', r.currency, 'interval', r.recurring_interval,
           'interval_count', coalesce(r.interval_count, 1))
    into v_price
    from private.billing_prices r join private.billing_products p on p.stripe_product_id = r.stripe_product_id
    join hub.products a on a.id = p.product_id
    where r.stripe_price_id = p_price and a.slug = p_app and a.status <> 'retired' and r.active and p.active and p.kind = 'plan'
      and r.type = 'recurring' and r.tenant_id is null and r.unit_amount is not null and r.pricing_model in ('flat', 'per_unit')
      and (r.livemode = (select livemode from private.billing_settings) or (select livemode from private.billing_settings) is null);
  if v_price is null then raise exception 'Choose an active, published plan price of this application.' using errcode = '22023'; end if;
  return v_price;
end;
$$;

-- The owner authorizes one invitation: an application, a contact, an organization, one published plan price of that application and a
-- quantity, and a discount. The server sends it once this returns.
create or replace function private.customer_invitation_create(p_actor uuid, p_record jsonb, p_request_key uuid, p_token_hash text, p_expires_at timestamptz) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_product uuid;
  v_snapshot jsonb;
  v_price record;
  v_percent numeric;
  v_duration text;
  v_months integer;
  v_quantity integer;
  v_row private.customer_invitations;
begin
  perform private.require_hub_app_server();
  if p_request_key is null then raise exception 'Invalid request.' using errcode = '22023'; end if;
  select * into v_row from private.customer_invitations where request_key = p_request_key;
  if found then
    if v_row.created_by is distinct from p_actor or v_row.stripe_price_id is distinct from p_record ->> 'price'
       or v_row.contact_email is distinct from lower(btrim(p_record ->> 'contact_email')) then
      raise exception 'This request was already used for another invitation.' using errcode = '22023';
    end if;
    return private.customer_invitation_view(v_row) || jsonb_build_object('replay', true);
  end if;
  perform private.billing_keys(p_record, array['app', 'contact_name', 'contact_email', 'organization_name', 'price', 'quantity',
    'discount_percent', 'discount_duration', 'discount_months', 'note']);
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then raise exception 'Invalid invitation link.' using errcode = '22023'; end if;
  if p_expires_at is null or p_expires_at <= now() or p_expires_at > now() + interval '91 days' then
    raise exception 'An invitation lasts between one and 90 days.' using errcode = '22023';
  end if;
  if jsonb_typeof(p_record -> 'app') <> 'string' or jsonb_typeof(p_record -> 'price') <> 'string' then
    raise exception 'Choose an application and one of its plan prices.' using errcode = '22023';
  end if;
  v_snapshot := private.customer_invitation_price(p_record ->> 'app', p_record ->> 'price');
  v_product := (v_snapshot ->> 'product_id')::uuid;
  select v_snapshot ->> 'price' as stripe_price_id, (v_snapshot ->> 'unit_amount')::bigint as unit_amount, v_snapshot ->> 'currency' as currency,
         v_snapshot ->> 'pricing_model' as pricing_model, v_snapshot ->> 'interval' as recurring_interval, (v_snapshot ->> 'interval_count')::integer as interval_count,
         v_snapshot ->> 'product' as stripe_product_id, v_snapshot ->> 'plan_name' as name, v_snapshot ->> 'unit_label' as unit_label
    into v_price;
  if jsonb_typeof(p_record -> 'quantity') <> 'number' or (p_record ->> 'quantity') !~ '^[0-9]{1,5}$' then
    raise exception 'Enter a quantity from 1 to 10,000.' using errcode = '22023';
  end if;
  v_quantity := (p_record ->> 'quantity')::integer;
  if v_quantity not between 1 and 10000 or (v_price.pricing_model = 'flat' and v_quantity <> 1) then
    raise exception 'A flat price is sold once; a per-unit price from 1 to 10,000.' using errcode = '22023';
  end if;
  if jsonb_typeof(p_record -> 'discount_percent') <> 'number' or (p_record ->> 'discount_percent') !~ '^[0-9]{1,3}(\.[0-9]{1,2})?$' then
    raise exception 'Enter a discount from 0 to 100 percent.' using errcode = '22023';
  end if;
  v_percent := (p_record ->> 'discount_percent')::numeric;
  if v_percent > 100 then raise exception 'Enter a discount from 0 to 100 percent.' using errcode = '22023'; end if;
  v_duration := p_record ->> 'discount_duration';
  if jsonb_typeof(p_record -> 'discount_duration') <> 'string' or v_duration not in ('forever', 'once', 'repeating') then
    raise exception 'Choose how long the discount lasts.' using errcode = '22023';
  end if;
  if v_duration = 'repeating' then
    if jsonb_typeof(p_record -> 'discount_months') <> 'number' or (p_record ->> 'discount_months') !~ '^[0-9]{1,2}$'
       or (p_record ->> 'discount_months')::integer not between 1 and 36 then
      raise exception 'A discount for some months lasts 1 to 36 months.' using errcode = '22023';
    end if;
    v_months := (p_record ->> 'discount_months')::integer;
  elsif jsonb_typeof(p_record -> 'discount_months') <> 'null' then
    raise exception 'Only a discount for some months has a number of months.' using errcode = '22023';
  end if;
  if v_percent = 0 then v_duration := 'forever'; v_months := null; end if;
  if jsonb_typeof(p_record -> 'contact_name') <> 'string' or jsonb_typeof(p_record -> 'contact_email') <> 'string'
     or jsonb_typeof(p_record -> 'organization_name') <> 'string' or jsonb_typeof(p_record -> 'note') <> 'string' then
    raise exception 'Enter the contact, organization and note as text.' using errcode = '22023';
  end if;
  insert into private.customer_invitations (request_key, token_hash, product_id, contact_name, contact_email, organization_name, stripe_price_id,
    stripe_product_id, plan_name, unit_label, pricing_model, quantity, unit_amount, currency, recurring_interval, interval_count,
    discount_percent, discount_duration, discount_months, note, expires_at, created_by)
  values (p_request_key, p_token_hash, v_product, btrim(p_record ->> 'contact_name'), lower(btrim(p_record ->> 'contact_email')),
    btrim(p_record ->> 'organization_name'), v_price.stripe_price_id, v_price.stripe_product_id, v_price.name, v_price.unit_label,
    v_price.pricing_model, v_quantity, v_price.unit_amount, v_price.currency, v_price.recurring_interval, v_price.interval_count,
    v_percent, v_duration, v_months, btrim(p_record ->> 'note'), p_expires_at, p_actor)
  returning * into v_row;
  perform private.billing_audit(p_actor, 'billing.invitation.create', null, v_product, jsonb_build_object('invitation', v_row.id::text,
    'price', v_row.stripe_price_id, 'quantity', v_row.quantity, 'discount_percent', v_row.discount_percent,
    'discount_duration', v_row.discount_duration, 'discount_months', v_row.discount_months));
  return private.customer_invitation_view(v_row);
end;
$$;

-- The owner's list: newest first, at most 300.
create or replace function private.customer_invitations_list() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_hub_app_server();
  return coalesce((select jsonb_agg(private.customer_invitation_view(i) order by i.created_at desc)
    from (select * from private.customer_invitations order by created_at desc limit 300) i), '[]'::jsonb);
end;
$$;

-- One invitation for the Hub server, by its id, its link's hash or its Checkout session; locked for the transaction when asked.
create or replace function private.customer_invitation_find(p_by text, p_value text, p_lock boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_row private.customer_invitations;
begin
  perform private.require_hub_app_server();
  if p_value is null then return null; end if;
  if p_by = 'id' then
    if p_value !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return null; end if;
    if p_lock then select * into v_row from private.customer_invitations where id = p_value::uuid for update;
    else select * into v_row from private.customer_invitations where id = p_value::uuid; end if;
  elsif p_by = 'token' then
    if p_value !~ '^[0-9a-f]{64}$' then return null; end if;
    if p_lock then select * into v_row from private.customer_invitations where token_hash = p_value for update;
    else select * into v_row from private.customer_invitations where token_hash = p_value; end if;
  elsif p_by = 'checkout' then
    if p_value !~ '^cs_[A-Za-z0-9_]{1,250}$' then return null; end if;
    if p_lock then select * into v_row from private.customer_invitations where checkout_session_id = p_value for update;
    else select * into v_row from private.customer_invitations where checkout_session_id = p_value; end if;
  else
    raise exception 'Unsupported invitation lookup.' using errcode = '22023';
  end if;
  if not found then return null; end if;
  return private.customer_invitation_internal(v_row);
end;
$$;

-- How the invitation email went: sent (the provider accepted it), failed (refused) or unknown.
create or replace function private.customer_invitation_sent(p_id uuid, p_delivery text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_hub_app_server();
  if p_delivery is null or p_delivery not in ('sent', 'failed', 'unknown') then raise exception 'Invalid delivery.' using errcode = '22023'; end if;
  update private.customer_invitations
  set email_status = p_delivery, email_sent_at = case when p_delivery = 'sent' then now() else email_sent_at end,
      send_count = send_count + 1, updated_at = now(), version = version + 1
  where id = p_id;
  if not found then raise exception 'Invitation not found.' using errcode = 'P0002'; end if;
end;
$$;

-- The customer accepted: the invitation's own tenant, made once, for the application it is for.
create or replace function private.customer_invitation_tenant(p_id uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_row private.customer_invitations;
  v_tenant uuid;
  v_slug text;
begin
  perform private.require_hub_app_server();
  select * into v_row from private.customer_invitations where id = p_id for update;
  if not found then raise exception 'Invitation not found.' using errcode = 'P0002'; end if;
  if v_row.tenant_id is not null then return v_row.tenant_id; end if;
  if v_row.status not in ('pending', 'checkout') or v_row.expires_at <= now() then
    raise exception 'This invitation is no longer open.' using errcode = '55000';
  end if;
  v_slug := 'invite-' || left(replace(v_row.id::text, '-', ''), 16);
  insert into hub.tenants (slug, name) values (v_slug, v_row.organization_name) on conflict (slug) do nothing returning id into v_tenant;
  if v_tenant is null then select id into v_tenant from hub.tenants where slug = v_slug; end if;
  insert into hub.tenant_products (tenant_id, product_id) values (v_tenant, v_row.product_id) on conflict do nothing;
  update private.customer_invitations set tenant_id = v_tenant, accepted_at = coalesce(accepted_at, now()), updated_at = now(), version = version + 1
  where id = p_id;
  perform private.billing_audit(null, 'billing.invitation.accept', v_tenant, v_row.product_id, jsonb_build_object('invitation', p_id::text));
  return v_tenant;
end;
$$;

-- Records each Stripe identity as the server makes it, and the invitation's step:
--   customer {customer}   the tenant's Stripe customer
--   coupon {coupon}       the invitation's own coupon
--   checkout {checkout, attempt}   a Checkout session for the customer to pay in (below 100%)
--   active {subscription} the subscription exists and is paid for, or is complimentary
--   ready_email {}        true once, for the one "your account is ready" email
create or replace function private.customer_invitation_progress(p_id uuid, p_change text, p_values jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_row private.customer_invitations;
  v_claimed boolean := false;
begin
  perform private.require_hub_app_server();
  if p_values is null or jsonb_typeof(p_values) <> 'object' then raise exception 'Invalid invitation change.' using errcode = '22023'; end if;
  select * into v_row from private.customer_invitations where id = p_id for update;
  if not found then raise exception 'Invitation not found.' using errcode = 'P0002'; end if;
  if p_change = 'customer' then
    if v_row.tenant_id is null or coalesce(p_values ->> 'customer', '') !~ '^cus_[A-Za-z0-9]{1,250}$'
       or v_row.stripe_customer_id is not null and v_row.stripe_customer_id <> p_values ->> 'customer' then
      raise exception 'The invitation''s customer does not match.' using errcode = '55000';
    end if;
    update private.customer_invitations set stripe_customer_id = p_values ->> 'customer', updated_at = now(), version = version + 1
    where id = p_id and stripe_customer_id is null;
  elsif p_change = 'coupon' then
    if v_row.discount_percent = 0 or coalesce(p_values ->> 'coupon', '') !~ '^[A-Za-z0-9_-]{1,255}$'
       or v_row.stripe_coupon_id is not null and v_row.stripe_coupon_id <> p_values ->> 'coupon' then
      raise exception 'The invitation''s coupon does not match.' using errcode = '55000';
    end if;
    update private.customer_invitations set stripe_coupon_id = p_values ->> 'coupon', updated_at = now(), version = version + 1
    where id = p_id and stripe_coupon_id is null;
  elsif p_change = 'checkout' then
    if v_row.status not in ('pending', 'checkout') or v_row.expires_at <= now() or v_row.discount_percent >= 100
       or coalesce(p_values ->> 'checkout', '') !~ '^cs_[A-Za-z0-9_]{1,250}$' or jsonb_typeof(p_values -> 'attempt') <> 'number' then
      raise exception 'This invitation cannot start a payment now.' using errcode = '55000';
    end if;
    update private.customer_invitations
    set status = 'checkout', checkout_session_id = p_values ->> 'checkout', checkout_attempt = (p_values ->> 'attempt')::integer,
        updated_at = now(), version = version + 1
    where id = p_id;
  elsif p_change = 'active' then
    if coalesce(p_values ->> 'subscription', '') !~ '^sub_[A-Za-z0-9]{1,250}$' or v_row.tenant_id is null then
      raise exception 'Invalid subscription.' using errcode = '22023';
    end if;
    if v_row.status in ('active', 'claimed') then
      if v_row.stripe_subscription_id <> p_values ->> 'subscription' then
        raise exception 'The invitation already has another subscription.' using errcode = '55000';
      end if;
    elsif v_row.status = 'revoked' then
      -- A payment that finished after the owner revoked: the subscription exists in Stripe, so the invitation records it.
      update private.customer_invitations
      set status = 'active', stripe_subscription_id = p_values ->> 'subscription', activated_at = now(), revoked_at = null,
          accepted_at = coalesce(accepted_at, now()), updated_at = now(), version = version + 1
      where id = p_id;
    else
      update private.customer_invitations
      set status = 'active', stripe_subscription_id = p_values ->> 'subscription', activated_at = now(),
          accepted_at = coalesce(accepted_at, now()), updated_at = now(), version = version + 1
      where id = p_id;
      perform private.billing_audit(null, 'billing.invitation.activate', v_row.tenant_id, v_row.product_id,
        jsonb_build_object('invitation', p_id::text, 'subscription', p_values ->> 'subscription', 'complimentary', v_row.discount_percent >= 100));
    end if;
  elsif p_change = 'ready_email' then
    if v_row.status not in ('active', 'claimed') or v_row.ready_email_at is not null then return jsonb_build_object('send', false); end if;
    update private.customer_invitations set ready_email_at = now(), updated_at = now(), version = version + 1 where id = p_id;
    v_claimed := true;
    return jsonb_build_object('send', v_claimed);
  else
    raise exception 'Unsupported invitation change.' using errcode = '22023';
  end if;
  select * into v_row from private.customer_invitations where id = p_id;
  return private.customer_invitation_internal(v_row);
end;
$$;

-- Links one application account (by its hash and last characters) to an activated invitation's tenant, as the account links of
-- private.billing_link_account do, and marks the invitation claimed.
create or replace function private.customer_invitation_link(p_id uuid, p_hash text, p_hint text, p_actor uuid, p_method text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_row private.customer_invitations;
  v_issuer uuid;
  v_prior uuid;
begin
  perform private.require_hub_app_server();
  select * into v_row from private.customer_invitations where id = p_id for update;
  if not found then raise exception 'Invitation not found.' using errcode = 'P0002'; end if;
  if v_row.status <> 'active' then raise exception 'Only an activated invitation that is not linked yet can be linked.' using errcode = '55000'; end if;
  v_issuer := private.billing_issuer(v_row.product_id);
  select hub_tenant_id into v_prior from private.federated_tenants where issuer_id = v_issuer and external_tenant_hash = p_hash for update;
  if v_prior is not null and v_prior <> v_row.tenant_id then
    raise exception 'That account is already linked to another tenant.' using errcode = '23505';
  end if;
  -- One account per tenant and application, as private.billing_link_account keeps it.
  delete from private.federated_tenants where issuer_id = v_issuer and hub_tenant_id = v_row.tenant_id and external_tenant_hash <> p_hash;
  if v_prior is null then
    insert into private.federated_tenants (issuer_id, external_tenant_hash, hub_tenant_id) values (v_issuer, p_hash, v_row.tenant_id);
  end if;
  insert into private.billing_account_links as l (tenant_id, product_id, account_hint, linked_by) values (v_row.tenant_id, v_row.product_id, p_hint, p_actor)
    on conflict (tenant_id, product_id) do update set account_hint = excluded.account_hint, linked_by = excluded.linked_by, linked_at = now(), version = l.version + 1;
  insert into hub.tenant_products (tenant_id, product_id) values (v_row.tenant_id, v_row.product_id) on conflict do nothing;
  update private.customer_invitations
  set status = 'claimed', account_hint = p_hint, claim_method = p_method, claimed_at = now(),
      pending_account_hash = null, pending_account_hint = null, pending_account_at = null, updated_at = now(), version = version + 1
  where id = p_id;
  perform private.billing_audit(p_actor, 'billing.invitation.claim', v_row.tenant_id, v_row.product_id,
    jsonb_build_object('invitation', p_id::text, 'method', p_method));
  return v_row.tenant_id;
end;
$$;

-- An application's sign-up (POST /api/apps/trials). With the invitation's code, a new account is linked to the invitation's tenant
-- instead of starting a trial ('linked'), and a retry by the same account answers the same. Without it, a new account whose sign-up email
-- matches an invitation activated in the last 60 days is held ('held') rather than given a second, separate trial: the owner links it
-- from the invitation. Anything else, and an account that is already linked, starts the ordinary trial ('none').
create or replace function private.customer_invitation_claim(p_product uuid, p_account text, p_email text, p_token_hash text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_row private.customer_invitations;
  v_hash text;
  v_hint text;
  v_linked uuid;
begin
  perform private.require_hub_app_server();
  if p_account is null or p_account !~ '^[A-Za-z0-9_-]{1,128}$' then raise exception 'Invalid account.' using errcode = '22023'; end if;
  v_hash := private.support_identity_hash(p_account);
  v_hint := right(p_account, 6);
  v_linked := private.billing_resolve_account(p_product, p_account);
  if p_token_hash is not null then
    if p_token_hash !~ '^[0-9a-f]{64}$' then raise exception 'Invalid invitation.' using errcode = '22023'; end if;
    select * into v_row from private.customer_invitations where token_hash = p_token_hash and product_id = p_product for update;
    if found and v_row.status = 'claimed' then
      if v_linked = v_row.tenant_id then return jsonb_build_object('outcome', 'linked', 'tenant', v_row.tenant_id); end if;
      raise exception 'This invitation has already been used by another account.' using errcode = '22023';
    end if;
    if found and v_row.status = 'active' then
      if v_linked is not null and v_linked <> v_row.tenant_id then
        raise exception 'That account is already linked to another tenant.' using errcode = '23505';
      end if;
      return jsonb_build_object('outcome', 'linked', 'tenant', private.customer_invitation_link(v_row.id, v_hash, v_hint, null, 'code'));
    end if;
    -- Unknown, revoked or not yet paid for: the sign-up goes on as an ordinary one.
    return jsonb_build_object('outcome', 'none');
  end if;
  if v_linked is not null or p_email is null or char_length(p_email) > 320 then return jsonb_build_object('outcome', 'none'); end if;
  select * into v_row from private.customer_invitations
  where product_id = p_product and status = 'active' and lower(contact_email) = lower(btrim(p_email))
    and activated_at > now() - interval '60 days' and (pending_account_hash is null or pending_account_hash = v_hash)
  order by activated_at desc limit 1 for update;
  if not found then return jsonb_build_object('outcome', 'none'); end if;
  if v_row.pending_account_hash is null then
    update private.customer_invitations
    set pending_account_hash = v_hash, pending_account_hint = v_hint, pending_account_at = now(), updated_at = now(), version = version + 1
    where id = v_row.id;
    perform private.billing_audit(null, 'billing.invitation.held', v_row.tenant_id, p_product, jsonb_build_object('invitation', v_row.id::text));
  end if;
  return jsonb_build_object('outcome', 'held', 'invitation', v_row.id);
end;
$$;

-- The owner's own changes to one invitation, at the version the owner saw:
--   rotate   a new link (its hash) and expiry, for sending again; not once it is linked or revoked
--   revoke   the link stops working; only before it is paid for or activated (the server expires an open Checkout first)
--   link     link the application account that was held for this invitation
create or replace function private.customer_invitation_owner(p_actor uuid, p_id uuid, p_action text, p_expected_version integer,
  p_token_hash text, p_expires_at timestamptz) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_row private.customer_invitations;
begin
  perform private.require_hub_app_server();
  select * into v_row from private.customer_invitations where id = p_id for update;
  if not found then raise exception 'That invitation was not found.' using errcode = 'P0002'; end if;
  if p_expected_version is null or v_row.version <> p_expected_version then
    raise exception 'The invitation changed. Refresh and review before saving.' using errcode = '40001';
  end if;
  if p_action = 'rotate' then
    if v_row.status not in ('pending', 'checkout', 'active') then
      raise exception 'A linked or revoked invitation cannot be sent again.' using errcode = '55000';
    end if;
    if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then raise exception 'Invalid invitation link.' using errcode = '22023'; end if;
    if p_expires_at is null or p_expires_at <= now() or p_expires_at > now() + interval '91 days' then
      raise exception 'An invitation lasts between one and 90 days.' using errcode = '22023';
    end if;
    update private.customer_invitations
    set token_hash = p_token_hash, expires_at = greatest(expires_at, p_expires_at), updated_at = now(), version = version + 1
    where id = p_id returning * into v_row;
    perform private.billing_audit(p_actor, 'billing.invitation.resend', v_row.tenant_id, v_row.product_id, jsonb_build_object('invitation', p_id::text));
  elsif p_action = 'revoke' then
    if v_row.status not in ('pending', 'checkout') then
      raise exception 'Only an invitation that is not paid for or activated can be revoked. Cancel its subscription in Billing instead.' using errcode = '55000';
    end if;
    update private.customer_invitations set status = 'revoked', revoked_at = now(), updated_at = now(), version = version + 1
    where id = p_id returning * into v_row;
    perform private.billing_audit(p_actor, 'billing.invitation.revoke', v_row.tenant_id, v_row.product_id, jsonb_build_object('invitation', p_id::text));
  elsif p_action = 'link' then
    if v_row.status <> 'active' or v_row.pending_account_hash is null then
      raise exception 'No application account is waiting to be linked to this invitation.' using errcode = '55000';
    end if;
    perform private.customer_invitation_link(p_id, v_row.pending_account_hash, v_row.pending_account_hint, p_actor, 'owner');
    select * into v_row from private.customer_invitations where id = p_id;
  else
    raise exception 'Unsupported invitation action.' using errcode = '22023';
  end if;
  return private.customer_invitation_internal(v_row);
end;
$$;

revoke all on function private.customer_invitation_view(private.customer_invitations), private.customer_invitation_internal(private.customer_invitations),
  private.customer_invitation_price(text, text),
  private.customer_invitation_create(uuid, jsonb, uuid, text, timestamptz), private.customer_invitations_list(), private.customer_invitation_find(text, text, boolean),
  private.customer_invitation_sent(uuid, text), private.customer_invitation_tenant(uuid), private.customer_invitation_progress(uuid, text, jsonb),
  private.customer_invitation_link(uuid, text, text, uuid, text), private.customer_invitation_claim(uuid, text, text, text),
  private.customer_invitation_owner(uuid, uuid, text, integer, text, timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function private.customer_invitation_price(text, text), private.customer_invitation_create(uuid, jsonb, uuid, text, timestamptz), private.customer_invitations_list(),
  private.customer_invitation_find(text, text, boolean), private.customer_invitation_sent(uuid, text), private.customer_invitation_tenant(uuid),
  private.customer_invitation_progress(uuid, text, jsonb), private.customer_invitation_claim(uuid, text, text, text),
  private.customer_invitation_owner(uuid, uuid, text, integer, text, timestamptz)
  to hub_app_server;
