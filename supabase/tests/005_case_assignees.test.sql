begin;

select plan(11);

select ok(
  pg_get_functiondef('hub.update_support_case(uuid,hub.case_status,hub.case_priority,uuid,boolean)'::regprocedure)
    like '%join auth.users assignee%',
  'case assignment verifies the current Auth record'
);

select ok(
  pg_get_functiondef('hub.update_support_case(uuid,hub.case_status,hub.case_priority,uuid,boolean)'::regprocedure)
    like '%join hub.profiles assignee_profile%',
  'case assignment requires a provisioned support profile'
);

select ok(
  pg_get_functiondef('hub.update_support_case(uuid,hub.case_status,hub.case_priority,uuid,boolean)'::regprocedure)
    like '%assignee.deleted_at is null%',
  'case assignment excludes deleted Auth users'
);

select ok(
  pg_get_functiondef('hub.update_support_case(uuid,hub.case_status,hub.case_priority,uuid,boolean)'::regprocedure)
    like '%assignee.banned_until is null or assignee.banned_until <= now()%'
    and pg_get_functiondef('hub.update_support_case(uuid,hub.case_status,hub.case_priority,uuid,boolean)'::regprocedure)
      like '%not coalesce(assignee.is_anonymous, false)%',
  'case assignment excludes banned and anonymous Auth users'
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
) values
  ('00000000-0000-0000-0000-000000000000', '97000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'assignment-writer@test.invalid', extensions.crypt('test-only', extensions.gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}'::jsonb, '{"display_name":"Assignment Writer"}'::jsonb, now(), now(), '', '', '', '', '', '', false, false),
  ('00000000-0000-0000-0000-000000000000', '97000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'assignment-deleted@test.invalid', extensions.crypt('test-only', extensions.gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}'::jsonb, '{"display_name":"Deleted Assignee"}'::jsonb, now(), now(), '', '', '', '', '', '', false, false),
  ('00000000-0000-0000-0000-000000000000', '97000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'assignment-banned@test.invalid', extensions.crypt('test-only', extensions.gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}'::jsonb, '{"display_name":"Banned Assignee"}'::jsonb, now(), now(), '', '', '', '', '', '', false, false),
  ('00000000-0000-0000-0000-000000000000', '97000000-0000-4000-8000-000000000004', 'authenticated', 'authenticated', 'assignment-anonymous@test.invalid', extensions.crypt('test-only', extensions.gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}'::jsonb, '{"display_name":"Anonymous Assignee"}'::jsonb, now(), now(), '', '', '', '', '', '', false, true),
  ('00000000-0000-0000-0000-000000000000', '97000000-0000-4000-8000-000000000005', 'authenticated', 'authenticated', 'assignment-unprofiled@test.invalid', extensions.crypt('test-only', extensions.gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}'::jsonb, '{"display_name":"Unprofiled Assignee"}'::jsonb, now(), now(), '', '', '', '', '', '', false, false),
  ('00000000-0000-0000-0000-000000000000', '97000000-0000-4000-8000-000000000006', 'authenticated', 'authenticated', 'assignment-valid@test.invalid', extensions.crypt('test-only', extensions.gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}'::jsonb, '{"display_name":"Valid Assignee"}'::jsonb, now(), now(), '', '', '', '', '', '', false, false);

update auth.users
set deleted_at = now()
where id = '97000000-0000-4000-8000-000000000002';

update auth.users
set banned_until = now() + interval '1 day'
where id = '97000000-0000-4000-8000-000000000003';

delete from hub.profiles
where id = '97000000-0000-4000-8000-000000000005';

insert into hub.products (id, slug, name, status, support_enabled)
values ('97100000-0000-4000-8000-000000000001', 'assignment-product', 'Assignment Product', 'active', true);

insert into hub.tenants (id, slug, name, status)
values ('97200000-0000-4000-8000-000000000001', 'assignment-tenant', 'Assignment Tenant', 'active');

insert into hub.tenant_products (tenant_id, product_id, status)
values ('97200000-0000-4000-8000-000000000001', '97100000-0000-4000-8000-000000000001', 'active');

insert into private.staff_permissions (user_id, product_id, permission, granted_by)
values
  ('97000000-0000-4000-8000-000000000001', '97100000-0000-4000-8000-000000000001', 'case.write', '97000000-0000-4000-8000-000000000001'),
  ('97000000-0000-4000-8000-000000000002', '97100000-0000-4000-8000-000000000001', 'case.read', '97000000-0000-4000-8000-000000000001'),
  ('97000000-0000-4000-8000-000000000003', '97100000-0000-4000-8000-000000000001', 'case.read', '97000000-0000-4000-8000-000000000001'),
  ('97000000-0000-4000-8000-000000000004', '97100000-0000-4000-8000-000000000001', 'case.read', '97000000-0000-4000-8000-000000000001'),
  ('97000000-0000-4000-8000-000000000005', '97100000-0000-4000-8000-000000000001', 'case.read', '97000000-0000-4000-8000-000000000001'),
  ('97000000-0000-4000-8000-000000000006', '97100000-0000-4000-8000-000000000001', 'case.read', '97000000-0000-4000-8000-000000000001');

insert into hub.support_cases (
  id,
  tenant_id,
  product_id,
  requester_id,
  requester_display_name,
  subject
) values (
  '97300000-0000-4000-8000-000000000001',
  '97200000-0000-4000-8000-000000000001',
  '97100000-0000-4000-8000-000000000001',
  '97000000-0000-4000-8000-000000000001',
  'Assignment Writer',
  'Assignment safety test'
);

set local request.jwt.claims = '{"sub":"97000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2"}';

select throws_ok(
  $$select hub.update_support_case('97300000-0000-4000-8000-000000000001', null, null, '97000000-0000-4000-8000-000000000002', true)$$,
  '42501',
  'Assignee is not authorized for this product.',
  'a deleted staff user cannot be assigned'
);

select throws_ok(
  $$select hub.update_support_case('97300000-0000-4000-8000-000000000001', null, null, '97000000-0000-4000-8000-000000000003', true)$$,
  '42501',
  'Assignee is not authorized for this product.',
  'a banned staff user cannot be assigned'
);

select throws_ok(
  $$select hub.update_support_case('97300000-0000-4000-8000-000000000001', null, null, '97000000-0000-4000-8000-000000000004', true)$$,
  '42501',
  'Assignee is not authorized for this product.',
  'an anonymous staff user cannot be assigned'
);

select throws_ok(
  $$select hub.update_support_case('97300000-0000-4000-8000-000000000001', null, null, '97000000-0000-4000-8000-000000000005', true)$$,
  '42501',
  'Assignee is not authorized for this product.',
  'an unprofiled staff user cannot be assigned'
);

select is(
  (select assigned_to from hub.support_cases where id = '97300000-0000-4000-8000-000000000001'),
  null::uuid,
  'failed assignment attempts leave the case unassigned'
);

select lives_ok(
  $$select hub.update_support_case('97300000-0000-4000-8000-000000000001', null, null, '97000000-0000-4000-8000-000000000006', true)$$,
  'a usable in-scope staff user can be assigned'
);

select is(
  (select assigned_to from hub.support_cases where id = '97300000-0000-4000-8000-000000000001'),
  '97000000-0000-4000-8000-000000000006'::uuid,
  'the valid assignee is persisted'
);

select * from finish();
rollback;
