-- The account report's revenue figures leave a subscription whose payment collection is paused out of MRR, as the
-- Billing screen does (src/billing/billingMath.ts). Stripe keeps such a subscription "active" and sets pause_behavior,
-- so the facts the report reads now carry pause_behavior. Additive: before this migration the field is absent and the
-- report counts the subscription as it did before.
create or replace function private.agent_subscription_facts(s private.billing_subscriptions) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'app', v -> 'app', 'status', v -> 'status', 'collection_method', v -> 'collection_method',
    'cancel_at_period_end', v -> 'cancel_at_period_end', 'cancel_at', v -> 'cancel_at', 'canceled_at', v -> 'canceled_at', 'ended_at', v -> 'ended_at',
    'current_period_end', v -> 'current_period_end', 'trial_end', v -> 'trial_end', 'created', v -> 'created',
    'pause_behavior', v -> 'pause_behavior',
    'discounts', coalesce((select jsonb_agg(jsonb_build_object('coupon', d -> 'coupon')) from jsonb_array_elements(v -> 'discounts') d), '[]'::jsonb),
    'items', coalesce((select jsonb_agg(jsonb_build_object(
        'product', i -> 'product', 'quantity', i -> 'quantity', 'unit_amount', i -> 'unit_amount', 'currency', i -> 'currency',
        'interval', i -> 'interval', 'interval_count', i -> 'interval_count', 'kind', i -> 'kind'))
      from jsonb_array_elements(v -> 'items') i), '[]'::jsonb))
  from (select private.billing_subscription_view(s) as v) x;
$$;

revoke all on function private.agent_subscription_facts(private.billing_subscriptions)
  from public, anon, authenticated, service_role, hub_app_server;
