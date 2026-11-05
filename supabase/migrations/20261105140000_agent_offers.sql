-- Offers from the owner's menu. The owner chose (2026-11-04) a fixed menu with caps: the Account Manager may offer only what the owner
-- put on the menu (a trial extension of a set number of days, or one of the owner's own Stripe coupons), only to accounts that qualify,
-- at most once per account for each offer and at most the offer's monthly cap. After the "offers" autonomy step's supervised week
-- (20261104220000) it makes them without asking; until then the owner approves each one.
--
-- An offer is the new action kind `offer.apply`, aimed at a billing_account (the tenant's slug). Nothing here talks to Stripe: the Hub
-- server asks the database first (private.agent_offer_begin), which checks everything again inside one transaction and records the use
-- before Stripe is asked, under the action, so a retry can never make the offer twice and two servers can never both take the last place
-- under the cap. A refusal from Stripe gives the place back.
--
-- Today an offer qualifies a trial that ends within the offer's window (7 days for the seeded one). The seeded 14-day trial extension
-- starts switched off: the owner turns it on from the AI team page.
--
-- Boundary (the same closed shape as the rest of the AI team): both tables have row level security and no privilege for any browser,
-- service or server role; the server operations are security definers with a pinned empty search path that refuse every session user
-- but hub_app_server; the owner operations authorize the owner's session themselves; the helpers are executable by no role.

-- ---------------------------------------------------------------------------------------
-- 1. The menu and what was offered.
-- ---------------------------------------------------------------------------------------
create table private.agent_offer_menu (
  key text primary key check (key ~ '^[a-z][a-z0-9_]{2,39}$'),
  label text not null check (char_length(btrim(label)) between 3 and 80),
  kind text not null check (kind in ('trial_extension', 'coupon')),
  trial_days integer check (trial_days between 1 and 30),
  coupon_id text check (coupon_id ~ '^[A-Za-z0-9_-]{1,255}$'),
  -- The products (hub.products slugs) whose accounts may get it.
  apps text[] not null check (cardinality(apps) between 1 and 10 and array_position(apps, null) is null
    and array_to_string(apps, ',') ~ '^[a-z0-9]+(-[a-z0-9]+)*(,[a-z0-9]+(-[a-z0-9]+)*)*$'),
  -- Who qualifies: a trial that ends within window_days.
  eligibility text not null default 'trial_ending' check (eligibility in ('trial_ending')),
  window_days integer not null default 7 check (window_days between 1 and 30),
  monthly_cap integer not null check (monthly_cap between 1 and 50),
  enabled boolean not null default false,
  changed_at timestamptz not null default now(),
  changed_by uuid,
  check ((kind = 'trial_extension') = (trial_days is not null)),
  check ((kind = 'coupon') = (coupon_id is not null))
);
alter table private.agent_offer_menu enable row level security;
revoke all on private.agent_offer_menu from public, anon, authenticated, service_role, hub_app_server;

-- One row per offer made, recorded before Stripe is asked. 'applying' until the server settles it: 'applied', 'refused' (Stripe said no,
-- or the account no longer qualified there; the place is given back) or 'unconfirmed' (no answer: it may have been applied, so it keeps
-- its place and is never tried again on its own).
create table private.agent_offer_uses (
  id uuid primary key default gen_random_uuid(),
  offer_key text not null references private.agent_offer_menu(key) on delete restrict,
  tenant_id uuid not null references hub.tenants(id) on delete restrict,
  stripe_subscription_id text not null check (stripe_subscription_id ~ '^sub_[A-Za-z0-9]{1,250}$'),
  action_id uuid not null unique,
  kind text not null check (kind in ('trial_extension', 'coupon')),
  trial_end_before timestamptz,
  trial_end_after timestamptz,
  coupon_id text check (coupon_id ~ '^[A-Za-z0-9_-]{1,255}$'),
  -- A coupon offer's complete request to Stripe (the subscription's discounts plus the coupon), recorded before it is sent, so a retry
  -- under the same idempotency key sends exactly the same request whatever the subscription's discounts have become since.
  stripe_discounts jsonb check (stripe_discounts is null or (kind = 'coupon' and jsonb_typeof(stripe_discounts) = 'array'
    and jsonb_array_length(stripe_discounts) between 1 and 20)),
  status text not null default 'applying' check (status in ('applying', 'applied', 'refused', 'unconfirmed')),
  created_at timestamptz not null default now(),
  settled_at timestamptz,
  check ((kind = 'trial_extension') = coalesce(trial_end_after > trial_end_before, false)),
  check ((kind = 'coupon') = (coupon_id is not null)),
  check ((status = 'applying') = (settled_at is null))
);
-- Once per account for each offer: a refusal does not count.
create unique index agent_offer_uses_once on private.agent_offer_uses (offer_key, tenant_id) where status <> 'refused';
create index agent_offer_uses_month on private.agent_offer_uses (offer_key, created_at);
alter table private.agent_offer_uses enable row level security;
revoke all on private.agent_offer_uses from public, anon, authenticated, service_role, hub_app_server;

-- The one seeded offer: 14 more days for a trial that ends within a week, at most 10 a month, switched off until the owner turns it on.
insert into private.agent_offer_menu (key, label, kind, trial_days, apps, window_days, monthly_cap, enabled)
values ('trial_extension_14', '14 more trial days', 'trial_extension', 14,
  array['carebase', 'breathe', 'caremetric-emr', 'caremetric-go', 'caremetric-intel'], 7, 10, false)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------------------
-- 2. The action kind and its shape. The kind check is widened, never narrowed (read from the constraint itself, as every earlier change
--    did); billing_account is already a target kind (20261103140000).
-- ---------------------------------------------------------------------------------------
do $$
declare
  v_kinds text[];
begin
  select coalesce(array_agg(distinct m[1]), array[]::text[]) into v_kinds
  from pg_constraint c cross join lateral regexp_matches(pg_get_constraintdef(c.oid), '''([^'']+)''', 'g') m
  where c.conrelid = 'private.agent_actions'::regclass and c.conname = 'agent_actions_kind_check';
  if not v_kinds @> array['communication.reply', 'communication.note', 'communication.update', 'incident.open', 'incident.resolve', 'import.run', 'email.send']
    or exists (select 1 from unnest(v_kinds) value where value !~ '^[a-z][a-z0-9_.]{1,60}$') then
    raise exception 'The agent action kinds could not be read' using errcode = '55000';
  end if;
  execute format('alter table private.agent_actions drop constraint agent_actions_kind_check, add constraint agent_actions_kind_check check (kind in (%s))',
    (select string_agg(quote_literal(k), ', ' order by k) from (select distinct unnest(v_kinds || array['offer.apply']) as k) x));
end $$;

-- An offer carries exactly these facts: which offer, which account (by slug, the target), which product and which subscription. What
-- it changes is decided again when it is made, from the menu and the billing mirror, never from the proposal.
alter table private.agent_actions add constraint agent_actions_offer_apply_check check (
  kind <> 'offer.apply' or coalesce(
    target_kind = 'billing_account'
    and (input - array['offer', 'tenant', 'product', 'subscription']) = '{}'::jsonb
    and coalesce(input ->> 'offer', '') ~ '^[a-z][a-z0-9_]{2,39}$'
    and target_id = input ->> 'tenant'
    and target_id ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
    and coalesce(input ->> 'product', '') ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
    and coalesce(input ->> 'subscription', '') ~ '^sub_[A-Za-z0-9]{1,250}$', false));

-- ---------------------------------------------------------------------------------------
-- 3. What the daily run reads (server only). Each switched-on offer with room left under its monthly cap (offers already made this
--    month and offers still waiting to be made both count), and the accounts that qualify for it: a live trial of one of its products
--    that ends within its window, on an account that never had this offer and has no proposal of it open, refused by the owner, or
--    made. The soonest trial end comes first. The Stripe mode rule is the customer emails' (20261103140000): live-mode records only,
--    and nothing while the verified mode is test. Names, slugs, dates and Stripe ids; never an address.
-- ---------------------------------------------------------------------------------------
create function private.agent_offer_month_start() returns timestamptz
language sql stable set search_path = '' as $$
  select (date_trunc('month', now() at time zone 'America/New_York') at time zone 'America/New_York');
$$;

create function private.agent_offer_candidates(p_limit integer default 50) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_live boolean;
begin
  perform private.require_hub_app_server();
  if p_limit is null or p_limit < 1 or p_limit > 200 then
    raise exception 'Choose a limit between 1 and 200.' using errcode = '22023';
  end if;
  select livemode into v_live from private.billing_settings;
  return (
    with offers as (
      select m.*, m.monthly_cap
        - (select count(*) from private.agent_offer_uses u where u.offer_key = m.key and u.status <> 'refused' and u.created_at >= private.agent_offer_month_start())
        - (select count(*) from private.agent_actions a where a.kind = 'offer.apply' and a.input ->> 'offer' = m.key
             and a.status in ('proposed', 'approved', 'auto_approved', 'executing')
             and not exists (select 1 from private.agent_offer_uses u where u.action_id = a.id)) as remaining
      from private.agent_offer_menu m
      where m.enabled and coalesce(v_live, true)
        and (m.kind <> 'coupon' or exists (select 1 from private.billing_coupons c
          where c.stripe_coupon_id = m.coupon_id and c.valid and not c.deleted and c.livemode))
    ), qualified as (
      select distinct on (o.key, s.tenant_id) o.key as offer, t.slug as tenant, t.name as tenant_name, p.slug as product, p.name as product_name,
        s.stripe_subscription_id as subscription, s.trial_end
      from offers o
      join private.billing_subscriptions s on s.status = 'trialing' and s.livemode
        and s.trial_end > now() and s.trial_end <= now() + make_interval(days => o.window_days)
      join hub.tenants t on t.id = s.tenant_id and t.status = 'active'
      join hub.products p on p.id = s.product_id and p.status <> 'retired' and p.slug = any(o.apps)
      join private.billing_customers c on c.stripe_customer_id = s.stripe_customer_id and not c.deleted and c.livemode
      where o.remaining > 0
        and (o.kind <> 'coupon' or not exists (select 1 from jsonb_array_elements(s.discounts) d where d ->> 'coupon' = o.coupon_id))
        and not exists (select 1 from private.agent_offer_uses u where u.offer_key = o.key and u.tenant_id = s.tenant_id and u.status <> 'refused')
        -- A proposal of this offer to this account that is open, was refused by the owner or was made keeps it from being proposed again.
        -- One that expired, or failed for a reason that says nothing about the account (the cap, the hand-over, Stripe being busy), does not.
        and not exists (select 1 from private.agent_actions a where a.kind = 'offer.apply' and a.input ->> 'offer' = o.key and a.target_id = t.slug
          and not (a.status = 'expired' or (a.status = 'failed' and coalesce(a.result ->> 'error', '') in
            ('cap_reached', 'offers_off', 'offer_disabled', 'billing_unavailable', 'stripe_unavailable'))))
      order by o.key, s.tenant_id, s.trial_end, s.stripe_subscription_id
    ), page as (
      select * from qualified order by trial_end, offer, tenant limit p_limit
    )
    select jsonb_build_object(
      'generatedAt', now(),
      'mode', case when v_live is null then 'unverified' when v_live then 'live' else 'test' end,
      'offers', (select coalesce(jsonb_agg(jsonb_build_object('key', o.key, 'label', o.label, 'kind', o.kind, 'trialDays', o.trial_days,
          'couponId', o.coupon_id, 'remaining', greatest(o.remaining, 0)) order by o.key), '[]'::jsonb) from offers o),
      'candidates', (select coalesce(jsonb_agg(jsonb_build_object('offer', g.offer, 'tenant', g.tenant, 'tenantName', g.tenant_name,
          'product', g.product, 'productName', g.product_name, 'subscription', g.subscription, 'trialEnd', g.trial_end)
          order by g.trial_end, g.offer, g.tenant), '[]'::jsonb) from page g),
      'truncated', (select count(*) from qualified) > p_limit));
end;
$$;

-- ---------------------------------------------------------------------------------------
-- 4. Making one offer (server only). Returns what to ask Stripe for ('ready'), the use an earlier attempt of this action recorded
--    ('replay' while it was never settled, 'recorded' once it was), or why not ('refused' with a code).
-- ---------------------------------------------------------------------------------------
create function private.agent_offer_use_json(p_use private.agent_offer_uses, p_state text) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('state', p_state, 'status', p_use.status, 'offer', p_use.offer_key, 'kind', p_use.kind,
    'subscription', p_use.stripe_subscription_id, 'coupon', p_use.coupon_id,
    'trialEndBefore', floor(extract(epoch from p_use.trial_end_before))::bigint, 'trialEndAfter', floor(extract(epoch from p_use.trial_end_after))::bigint,
    'discounts', p_use.stripe_discounts);
$$;

create function private.agent_offer_begin(p_action_id uuid, p_execution integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_action private.agent_actions%rowtype;
  v_agent private.agents%rowtype;
  v_offer private.agent_offer_menu%rowtype;
  v_use private.agent_offer_uses%rowtype;
  v_sub private.billing_subscriptions%rowtype;
  v_tenant hub.tenants%rowtype;
  v_live boolean;
  v_after timestamptz;
begin
  perform private.require_hub_app_server();
  select * into v_action from private.agent_actions where id = p_action_id for update;
  if not found or v_action.kind <> 'offer.apply' then
    raise exception 'Unknown offer.' using errcode = 'P0002';
  end if;
  if v_action.status <> 'executing' or (p_execution is not null and v_action.executions <> p_execution) then
    raise exception 'That offer is not being made.' using errcode = '55000';
  end if;
  -- An earlier attempt of this action recorded its use: that is settled first, whatever has changed since.
  select * into v_use from private.agent_offer_uses where action_id = p_action_id;
  if found then
    return private.agent_offer_use_json(v_use, case when v_use.status = 'applying' then 'replay' else 'recorded' end);
  end if;
  -- Nobody approved it: the Account Manager must still be trusted with offers, now. The row is held (shared) until this transaction
  -- commits, so a pause, a level change or Keep approving either commits first (and the offer is refused) or waits until it is recorded.
  if v_action.decided_by is null then
    select * into v_agent from private.agents where key = v_action.agent_key for share;
    if v_agent.status is distinct from 'active' or v_agent.autonomy is distinct from 'act'
      or jsonb_typeof(v_agent.config -> 'auto_approve_kinds') is distinct from 'array'
      or not ((v_agent.config -> 'auto_approve_kinds') ? 'offer.apply') then
      return jsonb_build_object('state', 'refused', 'code', 'offers_off');
    end if;
  end if;
  -- The menu row is held to the end of the transaction, so two offers cannot both take the last place under the cap.
  select * into v_offer from private.agent_offer_menu where key = v_action.input ->> 'offer' for update;
  if not found or not v_offer.enabled then
    return jsonb_build_object('state', 'refused', 'code', 'offer_disabled');
  end if;
  select * into v_tenant from hub.tenants where slug = v_action.target_id;
  if not found or v_tenant.status <> 'active' or not ((v_action.input ->> 'product') = any(v_offer.apps)) then
    return jsonb_build_object('state', 'refused', 'code', 'not_eligible');
  end if;
  if exists (select 1 from private.agent_offer_uses u where u.offer_key = v_offer.key and u.tenant_id = v_tenant.id and u.status <> 'refused') then
    return jsonb_build_object('state', 'refused', 'code', 'already_offered');
  end if;
  if (select count(*) from private.agent_offer_uses u
      where u.offer_key = v_offer.key and u.status <> 'refused' and u.created_at >= private.agent_offer_month_start()) >= v_offer.monthly_cap then
    return jsonb_build_object('state', 'refused', 'code', 'cap_reached');
  end if;
  -- The account still qualifies, on the same terms the daily run chose it by: a live trial of this product on this account, not over yet
  -- and ending within the offer's window (a trial extended since the proposal no longer qualifies).
  select livemode into v_live from private.billing_settings;
  select s.* into v_sub from private.billing_subscriptions s join hub.products p on p.id = s.product_id
  where s.stripe_subscription_id = v_action.input ->> 'subscription' and s.tenant_id = v_tenant.id
    and p.slug = v_action.input ->> 'product' and p.status <> 'retired' and s.livemode and coalesce(v_live, true);
  if not found or v_sub.status <> 'trialing' or v_sub.trial_end is null or v_sub.trial_end <= now()
    or v_sub.trial_end > now() + make_interval(days => v_offer.window_days) then
    return jsonb_build_object('state', 'refused', 'code', 'not_eligible');
  end if;
  if v_offer.kind = 'trial_extension' then
    -- Whole seconds: Stripe takes a Unix time, and the recorded use must say exactly what was asked for.
    v_after := date_trunc('second', v_sub.trial_end + make_interval(days => v_offer.trial_days));
  elsif not exists (select 1 from private.billing_coupons c where c.stripe_coupon_id = v_offer.coupon_id and c.valid and not c.deleted and c.livemode)
    or exists (select 1 from jsonb_array_elements(v_sub.discounts) d where d ->> 'coupon' = v_offer.coupon_id) then
    return jsonb_build_object('state', 'refused', 'code', 'not_eligible');
  end if;
  insert into private.agent_offer_uses (offer_key, tenant_id, stripe_subscription_id, action_id, kind, trial_end_before, trial_end_after, coupon_id)
  values (v_offer.key, v_tenant.id, v_sub.stripe_subscription_id, v_action.id, v_offer.kind,
    case when v_offer.kind = 'trial_extension' then v_sub.trial_end end, v_after,
    case when v_offer.kind = 'coupon' then v_offer.coupon_id end)
  returning * into v_use;
  return private.agent_offer_use_json(v_use, 'ready');
end;
$$;

-- A coupon offer's request, recorded before it is sent (server only). The first request recorded for the offer is kept and returned, and
-- the server sends what is returned, so every attempt of one action sends the same request under its idempotency key. The request names
-- the subscription's discounts by id and adds this offer's coupon once; nothing else is accepted.
create function private.agent_offer_request(p_action_id uuid, p_execution integer, p_discounts jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_action private.agent_actions%rowtype;
  v_use private.agent_offer_uses%rowtype;
begin
  perform private.require_hub_app_server();
  select * into v_action from private.agent_actions where id = p_action_id for update;
  if not found or v_action.kind <> 'offer.apply' or v_action.status <> 'executing'
    or (p_execution is not null and v_action.executions <> p_execution) then
    raise exception 'That offer is not being made.' using errcode = '55000';
  end if;
  select * into v_use from private.agent_offer_uses where action_id = p_action_id and kind = 'coupon' and status = 'applying' for update;
  if not found then
    raise exception 'That offer has no coupon request to record.' using errcode = '55000';
  end if;
  if v_use.stripe_discounts is not null then
    return v_use.stripe_discounts;
  end if;
  if jsonb_typeof(p_discounts) is distinct from 'array' or jsonb_array_length(p_discounts) not between 1 and 20
    or exists (select 1 from jsonb_array_elements(p_discounts) e
               where jsonb_typeof(e) <> 'object' or (select count(*) from jsonb_object_keys(e)) <> 1
                 or not (coalesce(e ->> 'discount', '') ~ '^di_[A-Za-z0-9_]{1,250}$' or e ->> 'coupon' = v_use.coupon_id))
    or (select count(*) from jsonb_array_elements(p_discounts) e where e ? 'coupon') <> 1 then
    raise exception 'Invalid coupon request.' using errcode = '22023';
  end if;
  update private.agent_offer_uses set stripe_discounts = p_discounts where id = v_use.id;
  return p_discounts;
end;
$$;

-- What Stripe answered for one recorded offer. 'refused' gives its place under the cap and the once-per-account rule back. Audited once,
-- with whether the owner approved it or it went automatically. Internal: the server's settle operation and the completion trigger use it.
create function private.agent_offer_record(p_action_id uuid, p_status text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_use private.agent_offer_uses%rowtype;
  v_decided uuid;
begin
  if p_status is null or p_status not in ('applied', 'refused', 'unconfirmed') then
    raise exception 'Invalid offer outcome.' using errcode = '22023';
  end if;
  update private.agent_offer_uses set status = p_status, settled_at = now()
  where action_id = p_action_id and status = 'applying'
  returning * into v_use;
  if not found then
    return false;
  end if;
  select decided_by into v_decided from private.agent_actions where id = p_action_id;
  insert into private.audit_events (actor_id, action, entity_type, entity_id, tenant_id, metadata)
  values ('a1a00000-a1a0-4000-8000-000000000001', 'agent.offer', 'tenant', v_use.tenant_id, v_use.tenant_id,
    jsonb_build_object('offer', v_use.offer_key, 'kind', v_use.kind, 'status', p_status, 'action_id', p_action_id,
      'approved', case when v_decided is null then 'automatic' else 'owner' end));
  return true;
end;
$$;

-- Server: record what Stripe answered.
create function private.agent_offer_settle(p_action_id uuid, p_status text) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_hub_app_server();
  return private.agent_offer_record(p_action_id, p_status);
end;
$$;

-- An offer whose action ends while its use is still 'applying' (the server's settle call failed, or it stopped before making it) is
-- settled in the same transaction that ends the action, from how the action ended: carried out means Stripe applied it; a refusal the
-- server recorded (Stripe said no, or billing was unavailable before Stripe was asked) gives the place under the cap and the account's
-- one offer back; anything else may have been applied and keeps both. So a definite refusal never stays counted against the cap.
create function private.agent_offer_settle_on_completion() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform private.agent_offer_record(new.id, case
    when new.status = 'executed' then 'applied'
    when coalesce(new.result ->> 'error', '') in ('offer_refused', 'billing_unavailable') then 'refused'
    else 'unconfirmed' end);
  return null;
end;
$$;
create trigger agent_offer_settle_on_completion after update of status on private.agent_actions
  for each row when (new.kind = 'offer.apply' and new.status in ('executed', 'failed') and old.status is distinct from new.status)
  execute function private.agent_offer_settle_on_completion();

-- ---------------------------------------------------------------------------------------
-- 5. The owner's menu on the AI team page: read it, switch an offer on or off or change its cap, and add an offer.
-- ---------------------------------------------------------------------------------------
create function private.agent_offer_menu_json(p_offer private.agent_offer_menu) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('key', p_offer.key, 'label', p_offer.label, 'kind', p_offer.kind, 'trialDays', p_offer.trial_days,
    'couponId', p_offer.coupon_id, 'apps', to_jsonb(p_offer.apps), 'eligibility', p_offer.eligibility, 'windowDays', p_offer.window_days,
    'monthlyCap', p_offer.monthly_cap, 'enabled', p_offer.enabled, 'changedAt', p_offer.changed_at,
    'usedThisMonth', (select count(*)::integer from private.agent_offer_uses u
      where u.offer_key = p_offer.key and u.status <> 'refused' and u.created_at >= private.agent_offer_month_start()),
    'appliedTotal', (select count(*)::integer from private.agent_offer_uses u where u.offer_key = p_offer.key and u.status = 'applied'));
$$;

-- A coupon the menu may use: one of the owner's own Stripe coupons, valid, not deleted, in live mode.
create function private.agent_offer_coupon_usable(p_coupon text) returns boolean
language sql stable set search_path = '' as $$
  select exists (select 1 from private.billing_coupons c where c.stripe_coupon_id = p_coupon and c.valid and not c.deleted and c.livemode);
$$;

create function hub.get_agent_offers() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform hub.authorize_app_admin();
  return jsonb_build_object(
    'offers', (select coalesce(jsonb_agg(private.agent_offer_menu_json(m) order by m.label, m.key), '[]'::jsonb) from private.agent_offer_menu m),
    'coupons', (select coalesce(jsonb_agg(jsonb_build_object('id', c.stripe_coupon_id, 'name', c.name, 'percentOff', c.percent_off,
        'amountOff', c.amount_off, 'currency', c.currency, 'duration', c.duration, 'durationInMonths', c.duration_in_months)
        order by c.name, c.stripe_coupon_id), '[]'::jsonb)
      from private.billing_coupons c where c.valid and not c.deleted and c.livemode));
end;
$$;

-- Switch one offer on or off, or change its monthly cap. A stale screen is refused. A coupon offer is switched on only while its coupon is usable.
create function hub.set_agent_offer(p_key text, p_enabled boolean, p_monthly_cap integer, p_expected_changed_at timestamptz) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_actor jsonb;
  v_offer private.agent_offer_menu%rowtype;
begin
  v_actor := hub.authorize_app_command();
  if p_enabled is null or p_monthly_cap is null or p_monthly_cap < 1 or p_monthly_cap > 50 then
    raise exception 'Choose on or off and a monthly cap between 1 and 50.' using errcode = '22023';
  end if;
  -- Locked before the version is compared, so of two changes made from the same screen the second is refused instead of applied.
  select * into v_offer from private.agent_offer_menu where key = p_key for update;
  if not found then
    raise exception 'Unknown offer.' using errcode = 'P0002';
  end if;
  if v_offer.changed_at is distinct from p_expected_changed_at then
    raise exception 'This offer changed. Refresh and review again.' using errcode = '40001';
  end if;
  if p_enabled and v_offer.kind = 'coupon' and not private.agent_offer_coupon_usable(v_offer.coupon_id) then
    raise exception 'That coupon is no longer valid in Stripe, so the offer cannot be switched on.' using errcode = '22023';
  end if;
  update private.agent_offer_menu set enabled = p_enabled, monthly_cap = p_monthly_cap, changed_at = now(), changed_by = (v_actor ->> 'user_id')::uuid
  where key = p_key returning * into v_offer;
  insert into private.audit_events (actor_id, action, entity_type, metadata)
  values ((v_actor ->> 'user_id')::uuid, 'agent.offer_menu', 'agent',
    jsonb_build_object('offer', p_key, 'enabled', p_enabled, 'monthly_cap', p_monthly_cap));
  return private.agent_offer_menu_json(v_offer);
end;
$$;

-- Add an offer to the menu: a trial extension of 1 to 30 days, or one of the owner's own usable Stripe coupons. It starts switched off.
create function hub.add_agent_offer(p_label text, p_kind text, p_trial_days integer, p_coupon_id text, p_apps text[], p_window_days integer, p_monthly_cap integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_actor jsonb;
  v_offer private.agent_offer_menu%rowtype;
begin
  v_actor := hub.authorize_app_command();
  if p_label is null or char_length(btrim(p_label)) not between 3 and 80
    or p_kind is null or p_kind not in ('trial_extension', 'coupon')
    or (p_kind = 'trial_extension' and (p_trial_days is null or p_trial_days not between 1 and 30 or p_coupon_id is not null))
    or (p_kind = 'coupon' and (p_coupon_id is null or p_trial_days is not null))
    or p_window_days is null or p_window_days not between 1 and 30 or p_monthly_cap is null or p_monthly_cap not between 1 and 50
    or p_apps is null or cardinality(p_apps) not between 1 and 10 then
    raise exception 'Name the offer, choose what it gives, the products, the window and a monthly cap between 1 and 50.' using errcode = '22023';
  end if;
  if exists (select 1 from unnest(p_apps) a where not exists (select 1 from hub.products p where p.slug = a and p.status <> 'retired')) then
    raise exception 'Choose products that exist and are not retired.' using errcode = '22023';
  end if;
  if p_kind = 'coupon' and not private.agent_offer_coupon_usable(p_coupon_id) then
    raise exception 'Choose one of your coupons that is valid in Stripe.' using errcode = '22023';
  end if;
  insert into private.agent_offer_menu (key, label, kind, trial_days, coupon_id, apps, window_days, monthly_cap, enabled, changed_by)
  values ((case when p_kind = 'coupon' then 'coupon_' else 'trial_' end) || substr(md5(gen_random_uuid()::text), 1, 12), btrim(p_label), p_kind,
    p_trial_days, p_coupon_id, array(select distinct a from unnest(p_apps) a order by a), p_window_days, p_monthly_cap, false, (v_actor ->> 'user_id')::uuid)
  returning * into v_offer;
  insert into private.audit_events (actor_id, action, entity_type, metadata)
  values ((v_actor ->> 'user_id')::uuid, 'agent.offer_menu', 'agent',
    jsonb_build_object('offer', v_offer.key, 'kind', p_kind, 'added', true, 'monthly_cap', p_monthly_cap));
  return private.agent_offer_menu_json(v_offer);
end;
$$;

revoke all on function
  private.agent_offer_month_start(),
  private.agent_offer_use_json(private.agent_offer_uses, text),
  private.agent_offer_menu_json(private.agent_offer_menu),
  private.agent_offer_coupon_usable(text),
  private.agent_offer_candidates(integer),
  private.agent_offer_begin(uuid, integer),
  private.agent_offer_settle(uuid, text),
  private.agent_offer_record(uuid, text),
  private.agent_offer_settle_on_completion(),
  private.agent_offer_request(uuid, integer, jsonb)
from public, anon, authenticated, service_role, hub_app_server;
grant execute on function private.agent_offer_candidates(integer), private.agent_offer_begin(uuid, integer), private.agent_offer_settle(uuid, text),
  private.agent_offer_request(uuid, integer, jsonb) to hub_app_server;

revoke all on function hub.get_agent_offers(), hub.set_agent_offer(text, boolean, integer, timestamptz),
  hub.add_agent_offer(text, text, integer, text, text[], integer, integer) from public, anon, service_role;
grant execute on function hub.get_agent_offers(), hub.set_agent_offer(text, boolean, integer, timestamptz),
  hub.add_agent_offer(text, text, integer, text, text[], integer, integer) to authenticated;

-- ---------------------------------------------------------------------------------------
-- 6. The Account Manager's daily look for accounts that qualify, after the customer emails (08:20).
-- ---------------------------------------------------------------------------------------
insert into private.agent_schedules (agent_key, task_kind, cadence, every_seconds, at_local, timezone, requires_session, next_run_at)
values ('account_manager', 'accounts.offers', 'daily', null, '08:40', 'America/New_York', false,
  private.agent_schedule_next('daily', null, '08:40', 'America/New_York', now(), null))
on conflict (agent_key, task_kind) do nothing;
