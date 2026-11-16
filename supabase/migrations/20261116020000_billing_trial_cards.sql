-- Stripe's last answer on whether a trialing Intel subscription has a card (server/trial-card.mjs), kept so the Hub can answer Intel's
-- entitlement check while Stripe cannot be reached, a restart during the outage included (docs/PLATFORM_BILLING.md). Every new Intel
-- trial needs a card, but Stripe starts the trial before the card is entered, so a trialing subscription alone proves nothing: a
-- confirmation is recorded only when Stripe confirmed the card, and forgotten as soon as a check finds none.
set local lock_timeout = '10s';

create table if not exists private.billing_trial_cards (
  stripe_subscription_id text primary key references private.billing_subscriptions(stripe_subscription_id) on delete cascade,
  tenant_id uuid not null references hub.tenants(id) on delete cascade,
  confirmed_at timestamptz not null default now()
);
create index if not exists billing_trial_cards_confirmed on private.billing_trial_cards (confirmed_at);

alter table private.billing_trial_cards enable row level security;
revoke all on private.billing_trial_cards from public, anon, authenticated, service_role, hub_app_server;

-- Server: records Stripe's answer for one tenant's trialing subscriptions. Confirmed: each subscription that is the tenant's is kept as
-- confirmed now. Not confirmed: every one of them is forgotten, whichever tenant it was kept for. Confirmations older than 90 days
-- (trials last 30) are removed on the way.
create or replace function private.billing_trial_card_record(p_tenant uuid, p_subscriptions text[], p_confirmed boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_hub_app_server();
  if p_tenant is null or p_confirmed is null or coalesce(cardinality(p_subscriptions), 0) not between 1 and 20
     or exists (select 1 from unnest(p_subscriptions) s where s is null or s !~ '^sub_[A-Za-z0-9]{1,250}$') then
    raise exception 'Name the tenant and its trialing subscriptions.' using errcode = '22023';
  end if;
  if p_confirmed then
    insert into private.billing_trial_cards (stripe_subscription_id, tenant_id, confirmed_at)
    select b.stripe_subscription_id, p_tenant, now() from private.billing_subscriptions b
     where b.stripe_subscription_id = any (p_subscriptions) and b.tenant_id = p_tenant
    on conflict (stripe_subscription_id) do update set tenant_id = excluded.tenant_id, confirmed_at = excluded.confirmed_at;
  else
    delete from private.billing_trial_cards where stripe_subscription_id = any (p_subscriptions);
  end if;
  delete from private.billing_trial_cards where confirmed_at < now() - interval '90 days';
end; $$;

-- Server: whether Stripe last confirmed a card on every one of the tenant's trialing subscriptions named. A subscription that is not
-- the tenant's, is no longer trialing, or has no confirmation reads as not confirmed.
create or replace function private.billing_trial_card_confirmed(p_tenant uuid, p_subscriptions text[]) returns boolean
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_hub_app_server();
  if p_tenant is null or coalesce(cardinality(p_subscriptions), 0) not between 1 and 20 then return false; end if;
  return not exists (
    select 1 from unnest(p_subscriptions) s
     where not exists (
       select 1 from private.billing_trial_cards c
         join private.billing_subscriptions b on b.stripe_subscription_id = c.stripe_subscription_id
        where c.stripe_subscription_id = s and c.tenant_id = p_tenant and b.tenant_id = p_tenant and b.status = 'trialing'));
end; $$;

revoke all on function private.billing_trial_card_record(uuid, text[], boolean), private.billing_trial_card_confirmed(uuid, text[])
  from public, anon, authenticated, service_role;
grant execute on function private.billing_trial_card_record(uuid, text[], boolean), private.billing_trial_card_confirmed(uuid, text[])
  to hub_app_server;
