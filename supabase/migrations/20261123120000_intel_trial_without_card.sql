-- An Intel trial starts without a card (owner decision 2026-11-23). Intel now opens the trial at sign-up (POST /api/apps/trials, the same
-- request its card setup sent), and the person is in the product at once; a card added in Billing before the trial ends keeps the plan,
-- and without one Stripe cancels the subscription when the trial ends. So a trialing Intel subscription is a trial from its start, as a
-- CareBase one always was. From 2026-11-14 until now it counted only from its card's first confirmation (20261117230000_trial_path.sql),
-- because Intel opened the trial when someone opened card setup, before any card existed.
--
-- 1. private.growth_intel_trial_started, a trigger beside the billing mirror's own capture, queues `trial_started` for a live Intel trial
--    when it starts, under the key the mirror and the card trigger use ('billing:trial:<subscription>'), so a trial is counted once
--    whichever writes first. The card trigger (private.growth_trial_card_seen) still keeps when a card was first confirmed (the card
--    reminder reads it) and queues nothing new: the start is already queued under its key.
-- 2. A trial that then ends with nothing paid is lost (`churned`), card or not, under the mirror's existing rule: its start was counted.
-- 3. Intel trials running now whose start was not counted, because no card was confirmed, are counted from their start, once.
set local lock_timeout = '10s';

-- 1. An Intel trial counts from its start. --------------------------------------------------------------------------------------------
create or replace function private.growth_intel_trial_started() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not new.livemode or new.status <> 'trialing' or new.trial_start is null
     or new.trial_start < (select started_at from private.growth_lifecycle_start)
     or (select slug from hub.products where id = new.product_id) is distinct from 'caremetric-intel' then
    return new;
  end if;
  insert into private.growth_billing_outbox (event_key, tenant_id, product, kind, subscription_id, occurred_at, facts)
  values ('billing:trial:' || new.stripe_subscription_id, new.tenant_id, 'caremetric-intel', 'trial_started', new.stripe_subscription_id,
    new.trial_start, jsonb_strip_nulls(jsonb_build_object('trialEnd', new.trial_end)))
  on conflict do nothing;
  return new;
end; $$;
revoke all on function private.growth_intel_trial_started() from public, anon, authenticated, service_role, hub_app_server;
drop trigger if exists growth_intel_trial_started on private.billing_subscriptions;
create trigger growth_intel_trial_started after insert or update on private.billing_subscriptions
  for each row execute function private.growth_intel_trial_started();

-- 3. Intel trials running now that were waiting for a card, counted from their start (the outbox's drain does the rest). -------------
insert into private.growth_billing_outbox (event_key, tenant_id, product, kind, subscription_id, occurred_at, facts)
select 'billing:trial:' || s.stripe_subscription_id, s.tenant_id, 'caremetric-intel', 'trial_started', s.stripe_subscription_id, s.trial_start,
  jsonb_strip_nulls(jsonb_build_object('trialEnd', s.trial_end))
from private.billing_subscriptions s
join hub.products p on p.id = s.product_id and p.slug = 'caremetric-intel'
where s.livemode and s.status = 'trialing' and s.trial_start is not null
  and s.trial_start >= (select started_at from private.growth_lifecycle_start)
on conflict do nothing;
