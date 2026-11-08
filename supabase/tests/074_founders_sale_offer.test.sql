begin;
select plan(2);

select results_eq($$select kind, coupon_id, apps, window_days, monthly_cap, enabled from private.agent_offer_menu where key = 'founders_sale_50_12m'$$,
  $$values ('coupon'::text, 'caremetric_founders_sale_50_12m_20261108'::text, array['carebase', 'caremetric-intel']::text[], 7, 50, true)$$,
  'The Founders Sale is on the Account Manager''s menu for CareBase and Intel trials ending within a week');
select ok(not private.agent_offer_coupon_usable('caremetric_founders_sale_50_12m_20261108') or exists (
    select 1 from private.billing_coupons where stripe_coupon_id = 'caremetric_founders_sale_50_12m_20261108' and valid and not deleted and livemode),
  'It is offered only while the coupon is valid and live in the billing mirror');

select * from finish();
rollback;
