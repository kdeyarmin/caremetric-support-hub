-- An application learns when a cancelled subscription ends.
--
-- Stripe's customer portal ends a subscription at the end of its period by setting `cancel_at` to that moment and leaving
-- `cancel_at_period_end` false (seen in the Stripe sandbox on November 20, 2026, for an Intel trial cancelled in the portal:
-- cancel_at = trial_end, cancel_at_period_end = false, status trialing). The entitlement answer carried only
-- `cancel_at_period_end`, so an application never learned of a portal cancellation: Intel kept telling the customer the plan
-- would continue. The answer now also carries `cancel_at`: when every live subscription is set to end (by either field), the
-- moment the last of them ends; null while any of them renews. `cancel_at_period_end` keeps Stripe's own meaning.
-- Only the new key is added; the rest of the definition is 20261027210000_customer_checkout.sql's.
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
  ),
  live as (select * from subs where status in ('active','trialing','past_due'))
  select jsonb_build_object(
    'tenant_id',p_tenant,
    'app',(select slug from hub.products where id=p_product),
    'status',coalesce((select status from ranked order by rank,stripe_created desc limit 1),'none'),
    'entitled',exists(select 1 from subs where status in ('active','trialing','past_due')),
    'trial_end',(select max(trial_end) from subs where status='trialing'),
    'current_period_end',(select max(current_period_end) from subs where status in ('active','trialing','past_due')),
    'cancel_at_period_end',coalesce((select bool_and(cancel_at_period_end) from subs where status in ('active','trialing','past_due')),false),
    'cancel_at',(select case when count(*)>0 and bool_and(cancel_at is not null or cancel_at_period_end)
        then max(coalesce(cancel_at,current_period_end)) end from live),
    'products',coalesce((select jsonb_agg(jsonb_build_object(
        'product',p.stripe_product_id,'key',p.entitlement_key,'kind',p.kind,'name',p.name,'quantity',i.quantity,
        'unit_label',p.unit_label,'status',s.status,'subscription',s.stripe_subscription_id,
        'plan',coalesce(p.metadata->>'plan',p.metadata->>'tier',''),'package_id',coalesce(p.metadata->>'package_id',''))
        order by p.kind,p.name)
      from subs s join private.billing_subscription_items i on i.stripe_subscription_id=s.stripe_subscription_id
      join private.billing_products p on p.stripe_product_id=i.stripe_product_id
      where s.status in ('active','trialing','past_due')),'[]'::jsonb));
$$;
revoke all on function private.billing_entitlements(uuid,uuid) from public,anon,authenticated,service_role,hub_app_server;
