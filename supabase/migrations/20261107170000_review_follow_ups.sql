-- Follow-up fixes after the November 7 feature review. Function replacements keep their signatures, so grants are kept.
--
-- 1. A tenant whose Stripe customer was deleted could not be billed again. The Billing screen showed "Set up billing", but
--    private.billing_lock compared the deleted row's version with 0 and refused every save ("Billing changed"); and creating
--    the new customer (from that screen, an application trial or a customer Checkout) swapped the tenant's stripe_customer_id,
--    which the old subscriptions' foreign key refused. Stripe cancels a deleted customer's subscriptions, so those mirror rows
--    are final and keep the customer id they had; the foreign key is dropped (a subscription is still mirrored only for a
--    known customer), and a deleted customer now locks as version 0.
alter table private.billing_subscriptions drop constraint if exists billing_subscriptions_stripe_customer_id_fkey;

CREATE OR REPLACE FUNCTION private.billing_lock(p_kind text, p_id text, p_expected_version integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v integer;
begin
  perform private.require_hub_app_server();
  if p_expected_version is null or p_expected_version<0 then raise exception 'Invalid billing version.' using errcode='22023'; end if;
  -- A customer deleted in Stripe reads as none (version 0), as every billing screen shows it, so the tenant can be set up again;
  -- its row is still locked, so two set-ups cannot race.
  if p_kind='customer' then select case when deleted then 0 else version end into v from private.billing_customers where tenant_id=p_id::uuid for update;
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
end; $function$;
