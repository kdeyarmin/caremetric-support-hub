begin;
select plan(12);

select ok(bool_and(to_regclass(tbl) is not null and (select relrowsecurity from pg_class where oid = to_regclass(tbl))),
  'Platform billing tables exist with row level security')
from unnest(array['private.billing_settings', 'private.billing_customers', 'private.billing_products', 'private.billing_prices',
  'private.billing_subscriptions', 'private.billing_subscription_items', 'private.billing_coupons', 'private.billing_promotion_codes',
  'private.billing_invoices', 'private.billing_webhook_events', 'private.billing_app_keys', 'private.billing_account_links',
  'private.billing_usage_reports']) as tbl;
select ok(not bool_or(has_table_privilege(role_name, tbl, 'select,insert,update,delete')
    or has_any_column_privilege(role_name, tbl, 'select,insert,update')),
  'No browser, service or server role touches billing tables directly')
from unnest(array['public', 'anon', 'authenticated', 'service_role', 'hub_app_server']) as role_name,
  unnest(array['private.billing_settings', 'private.billing_customers', 'private.billing_products', 'private.billing_prices',
    'private.billing_subscriptions', 'private.billing_subscription_items', 'private.billing_coupons', 'private.billing_promotion_codes',
    'private.billing_invoices', 'private.billing_webhook_events', 'private.billing_app_keys', 'private.billing_account_links',
    'private.billing_usage_reports']) as tbl;

select ok(to_regclass('private.tenant_subscriptions') is null and to_regclass('private.billing_portal_intents') is null
    and to_regclass('private.billing_checkout_intents') is null and to_regprocedure('hub.list_tenant_accounts()') is null,
  'The manual subscription records and app billing intents are retired');

select ok(bool_and(has_function_privilege('hub_app_server', signature, 'execute')
    and not has_function_privilege('authenticated', signature, 'execute') and not has_function_privilege('anon', signature, 'execute')),
  'Only the Hub server mirrors Stripe and answers applications')
from unnest(array['private.billing_sync(text,jsonb,timestamptz)', 'private.billing_record_event(text,text,boolean,text,timestamptz,text)',
  'private.billing_set_account(text,boolean)', 'private.billing_authenticate_app(text)', 'private.billing_app_entitlements(uuid,text)',
  'private.billing_record_usage(uuid,uuid,text,integer,uuid,text,integer)', 'private.billing_audit(uuid,text,uuid,uuid,jsonb)']) as signature;
select ok(not bool_or(has_function_privilege(role_name, signature, 'execute')),
  'Entitlement and pricing internals are not callable by any role')
from unnest(array['public', 'anon', 'authenticated', 'service_role', 'hub_app_server']) as role_name,
  unnest(array['private.billing_entitlements(uuid,uuid)']) as signature;
select throws_ok($$select private.billing_sync('customer', '{}'::jsonb, now())$$, '42501', 'Application server required.',
  'Mirroring refuses every session user other than the Hub server');
select throws_ok($$select private.billing_authenticate_app(repeat('a', 64))$$, '42501', 'Application server required.',
  'Application keys are checked only by the Hub server');

select ok(bool_and(has_function_privilege('authenticated', signature, 'execute') and not has_function_privilege('anon', signature, 'execute')),
  'Billing administration and tenant billing are signed-in calls only')
from unnest(array['hub.billing_workspace()', 'hub.billing_customer(uuid)', 'hub.create_tenant(jsonb)',
  'hub.save_tenant(uuid,jsonb,timestamp with time zone)', 'hub.my_billing()', 'hub.authorize_tenant_billing(uuid)']) as signature;

set local role authenticated;
select throws_ok('select hub.billing_workspace()', '28000', null, 'Reading billing requires the current administrator session');
select throws_ok('select hub.billing_customer(gen_random_uuid())', '28000', null, 'Reading a customer requires the current administrator session');
select throws_ok('select hub.my_billing()', '28000', null, 'Tenant billing requires a verified session');
reset role;

select ok(hub.get_backend_contract()->'features' @> '["billing.platform.v1"]'::jsonb
    and not (hub.get_backend_contract()->'features' ?| array['billing.portal.v1', 'billing.checkout.v1', 'platform.admin.tenants.v1']),
  'The release contract advertises platform billing and none of the retired billing features');

select * from finish();
rollback;
