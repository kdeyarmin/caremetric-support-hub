-- Owner decision 2026-11-08: the Founders Sale reaches trials without anyone having to ask. The Account Manager's offer menu gets the
-- live Founders coupon (caremetric_founders_sale_50_12m_20261108: 50% off eligible subscription charges for the first 12 months of paid
-- service; docs/GTM_FACTS.md) for CareBase/Train and Intel trials that end within seven days, at most 50 a month, switched on.
--
-- Nothing else changes: the menu's existing rules decide every use. The coupon is offered only while it is valid, not deleted and in
-- live mode in the billing mirror; once per account; to a live trial of that product ending within the window; and never to a
-- subscription that already carries it. The "offers" autonomy step decides whether the owner approves each one. The owner can switch it
-- off, or change its cap, on the Team screen. On a database without the coupon (a local or CI stack) it is never offered.
insert into private.agent_offer_menu (key, label, kind, coupon_id, apps, eligibility, window_days, monthly_cap, enabled)
values ('founders_sale_50_12m', 'Founders Sale: 50% off the first 12 months', 'coupon', 'caremetric_founders_sale_50_12m_20261108',
  array['carebase', 'caremetric-intel'], 'trial_ending', 7, 50, true)
on conflict (key) do nothing;
