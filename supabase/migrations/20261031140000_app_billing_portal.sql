-- Customers manage their billing from inside their own application, never the Hub: the Hub is private to its owner.
-- An application, authenticated by its application key, asks for the Stripe customer portal of one of its own
-- linked accounts. This resolves that account exactly as entitlements do, so a key reaches only its own
-- application's linked customers, and returns the tenant's Stripe customer. An unlinked account, or a tenant without
-- a Stripe customer, has no billing to open.
set local lock_timeout='10s';

create function private.app_billing_portal_customer(p_product uuid,p_account text) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare tenant uuid; customer text;
begin
  perform private.require_hub_app_server();
  tenant:=private.billing_resolve_account(p_product,p_account);
  if tenant is not null then
    select c.stripe_customer_id into customer from private.billing_customers c where c.tenant_id=tenant and not c.deleted;
  end if;
  if customer is null then raise exception 'This account has no CareMetric billing yet.' using errcode='P0002'; end if;
  return jsonb_build_object('tenant',tenant,'customer',customer);
end; $$;
revoke all on function private.app_billing_portal_customer(uuid,text) from public,anon,authenticated,service_role,hub_app_server;
grant execute on function private.app_billing_portal_customer(uuid,text) to hub_app_server;
