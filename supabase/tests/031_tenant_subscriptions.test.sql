begin;
select plan(12);

select has_table('private', 'tenant_subscriptions', 'Tenant subscription pricing exists');
select ok((select relrowsecurity from pg_class where oid = 'private.tenant_subscriptions'::regclass),
  'Pricing enforces row level security');
select ok(not bool_or(has_table_privilege(role_name, 'private.tenant_subscriptions', 'select,insert,update,delete')
    or has_any_column_privilege(role_name, 'private.tenant_subscriptions', 'select,insert,update')),
  'No browser, service or server role touches pricing directly')
from unnest(array['public', 'anon', 'authenticated', 'service_role', 'hub_app_server']) as role_name;

select ok(not bool_or(has_function_privilege(role_name, signature, 'execute')),
  'The pricing helpers stay private')
from unnest(array['anon', 'authenticated', 'service_role', 'hub_app_server']) as role_name,
  unnest(array['private.validate_tenant_subscription(jsonb)', 'private.tenant_account(uuid)',
    'private.write_tenant_subscription(uuid,uuid,jsonb,integer)']) as signature;

select ok(bool_and(has_function_privilege('authenticated', signature, 'execute')
    and not has_function_privilege('anon', signature, 'execute')),
  'Tenant setup is a signed-in call only')
from unnest(array['hub.list_tenant_accounts()', 'hub.create_tenant(jsonb)',
  'hub.save_tenant(uuid,jsonb,timestamptz)', 'hub.save_tenant_subscription(uuid,uuid,jsonb,integer)']) as signature;

set local role authenticated;
select throws_ok('select hub.list_tenant_accounts()', '28000', 'Current administrator session required.',
  'Listing tenants requires the current administrator session');
select throws_ok($$select hub.create_tenant('{}'::jsonb)$$, '28000', 'Current administrator session required.',
  'Creating a tenant requires the current administrator session');
select throws_ok($$select hub.save_tenant_subscription(gen_random_uuid(), gen_random_uuid(), '{}'::jsonb, 0)$$, '28000',
  'Current administrator session required.', 'Pricing requires the current administrator session');
reset role;

-- The table refuses pricing that is neither paid nor explicitly complimentary.
insert into hub.tenants (id, slug, name) values ('00000000-0000-4000-8000-0000000000a1', 'pgtap-pricing-fixture', 'pgTAP pricing fixture');
insert into hub.tenant_products (tenant_id, product_id) select '00000000-0000-4000-8000-0000000000a1', id from hub.products where slug = 'carebase';
select throws_ok($$insert into private.tenant_subscriptions (tenant_id, product_id, plan_name, price_cents, billing_interval)
  select '00000000-0000-4000-8000-0000000000a1', id, 'Free by accident', 0, 'month' from hub.products where slug = 'carebase'$$,
  '23514', null, 'A paid subscription needs a price');
select throws_ok($$insert into private.tenant_subscriptions (tenant_id, product_id, plan_name, price_cents, billing_interval, complimentary)
  select '00000000-0000-4000-8000-0000000000a1', id, 'Unexplained', 0, 'month', true from hub.products where slug = 'carebase'$$,
  '23514', null, 'A complimentary subscription needs a reason');
select lives_ok($$insert into private.tenant_subscriptions (tenant_id, product_id, plan_name, price_cents, billing_interval, complimentary, complimentary_reason)
  select '00000000-0000-4000-8000-0000000000a1', id, 'Pilot', 0, 'month', true, 'Launch partner' from hub.products where slug = 'carebase'$$,
  'A complimentary subscription with a reason is accepted');

select ok(hub.get_backend_contract()->'features' @> '["platform.admin.tenants.v1"]'::jsonb,
  'Tenant setup is declared in release metadata');

select * from finish();
rollback;
