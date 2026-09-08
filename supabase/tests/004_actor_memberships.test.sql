begin;

select plan(10);

select ok(
  pg_get_functiondef('hub.get_support_actor_context()'::regprocedure) like '%jsonb_agg(%',
  'actor context aggregates active membership pairs'
);

select ok(
  pg_get_functiondef('hub.get_support_actor_context()'::regprocedure) not like '%limit 1%',
  'actor context does not discard later memberships'
);

insert into auth.users (
  instance_id,
  id,
  aud,
  role,
  email,
  encrypted_password,
  email_confirmed_at,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at,
  confirmation_token,
  recovery_token,
  email_change_token_new,
  email_change,
  email_change_token_current,
  reauthentication_token,
  is_sso_user,
  is_anonymous
) values (
  '00000000-0000-0000-0000-000000000000',
  '96000000-0000-4000-8000-000000000001',
  'authenticated',
  'authenticated',
  'actor-memberships@test.invalid',
  extensions.crypt('test-only', extensions.gen_salt('bf')),
  now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{"display_name":"Membership Test"}'::jsonb,
  now(), now(), '', '', '', '', '', '', false, false
);

insert into hub.products (id, slug, name, status, support_enabled)
values
  ('96100000-0000-4000-8000-000000000001', 'membership-product-a', 'Membership Product A', 'active', true),
  ('96100000-0000-4000-8000-000000000002', 'membership-product-b', 'Membership Product B', 'pilot', true),
  ('96100000-0000-4000-8000-000000000003', 'membership-product-inactive', 'Inactive Membership Product', 'active', true);

insert into hub.tenants (id, slug, name, status)
values
  ('96200000-0000-4000-8000-000000000001', 'membership-tenant-a', 'Membership Tenant A', 'active'),
  ('96200000-0000-4000-8000-000000000002', 'membership-tenant-b', 'Membership Tenant B', 'active'),
  ('96200000-0000-4000-8000-000000000003', 'membership-tenant-inactive', 'Inactive Membership Tenant', 'active');

insert into hub.tenant_products (tenant_id, product_id, status)
values
  ('96200000-0000-4000-8000-000000000001', '96100000-0000-4000-8000-000000000001', 'active'),
  ('96200000-0000-4000-8000-000000000002', '96100000-0000-4000-8000-000000000002', 'active'),
  ('96200000-0000-4000-8000-000000000003', '96100000-0000-4000-8000-000000000003', 'suspended');

insert into hub.tenant_product_memberships (
  tenant_id,
  product_id,
  user_id,
  role,
  case_scope,
  status,
  joined_at
) values
  (
    '96200000-0000-4000-8000-000000000003',
    '96100000-0000-4000-8000-000000000003',
    '96000000-0000-4000-8000-000000000001',
    'customer',
    'own',
    'active',
    '2026-01-01T00:00:00Z'
  ),
  (
    '96200000-0000-4000-8000-000000000001',
    '96100000-0000-4000-8000-000000000001',
    '96000000-0000-4000-8000-000000000001',
    'customer',
    'own',
    'active',
    '2026-02-01T00:00:00Z'
  ),
  (
    '96200000-0000-4000-8000-000000000002',
    '96100000-0000-4000-8000-000000000002',
    '96000000-0000-4000-8000-000000000001',
    'tenant_admin',
    'tenant',
    'active',
    '2026-03-01T00:00:00Z'
  );

set local request.jwt.claims = '{"sub":"96000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}';

select is(
  jsonb_array_length(hub.get_support_actor_context() -> 'memberships'),
  2,
  'all and only active membership pairs are returned'
);

select ok(
  hub.get_support_actor_context() -> 'memberships' @>
    '[{"tenant_id":"96200000-0000-4000-8000-000000000001","product_id":"96100000-0000-4000-8000-000000000001"}]'::jsonb,
  'the first active entitlement is returned intact'
);

select ok(
  hub.get_support_actor_context() -> 'memberships' @>
    '[{"tenant_id":"96200000-0000-4000-8000-000000000002","product_id":"96100000-0000-4000-8000-000000000002"}]'::jsonb,
  'the second active entitlement is returned intact'
);

select ok(
  not (hub.get_support_actor_context() -> 'memberships' @>
    '[{"tenant_id":"96200000-0000-4000-8000-000000000001","product_id":"96100000-0000-4000-8000-000000000002"}]'::jsonb),
  'actor context never synthesizes a cross-tenant entitlement'
);

select ok(
  not (hub.get_support_actor_context() -> 'memberships' @>
    '[{"tenant_id":"96200000-0000-4000-8000-000000000003","product_id":"96100000-0000-4000-8000-000000000003"}]'::jsonb),
  'an earlier inactive tenant-product entitlement is excluded'
);

select is(
  hub.get_support_actor_context() ->> 'role',
  'tenant_admin',
  'the actor role reflects an active tenant-admin membership'
);

select is(
  hub.get_support_actor_context() ->> 'tenant_id',
  '96200000-0000-4000-8000-000000000001',
  'legacy tenant context is the first active deterministic membership'
);

select is(
  ((hub.get_support_actor_context() -> 'memberships' -> 0) ->> 'intake_enabled')::boolean,
  false,
  'membership intake availability fails closed until explicitly activated'
);

select * from finish();
rollback;
