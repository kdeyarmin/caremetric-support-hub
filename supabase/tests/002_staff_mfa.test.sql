begin;

select plan(17);

select has_function(
  'private',
  'current_session_is_aal2',
  array[]::text[],
  'AAL2 session helper exists'
);

select has_function(
  'private',
  'is_staff_principal',
  array[]::text[],
  'factor-independent staff principal helper exists'
);

select has_function(
  'private',
  'current_principal_requires_aal2',
  array[]::text[],
  'staff-or-enrolled-factor enforcement helper exists'
);

select ok(
  not has_function_privilege('anon', 'private.current_session_is_aal2()', 'execute'),
  'anonymous users cannot invoke the private AAL helper'
);

select ok(
  not has_function_privilege('authenticated', 'private.is_staff_principal()', 'execute'),
  'authenticated users cannot invoke the private staff helper directly'
);

select ok(
  not has_function_privilege('authenticated', 'private.current_principal_requires_aal2()', 'execute'),
  'authenticated users cannot invoke the private factor-enforcement helper directly'
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
)
values (
  '00000000-0000-0000-0000-000000000000',
  '90000000-0000-4000-8000-000000000001',
  'authenticated',
  'authenticated',
  'mfa-helper@test.invalid',
  extensions.crypt('test-only', extensions.gen_salt('bf')),
  now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{"display_name":"MFA Helper Test"}'::jsonb,
  now(),
  now(),
  '', '', '', '', '', '', false, false
);

set local request.jwt.claims = '{"sub":"90000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}';
select is(private.current_session_is_aal2(), false, 'AAL1 fails the assurance check');

set local request.jwt.claims = '{"sub":"90000000-0000-4000-8000-000000000001","role":"authenticated"}';
select is(private.current_session_is_aal2(), false, 'a missing AAL claim fails closed');

set local request.jwt.claims = '{"sub":"90000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2"}';
select is(private.current_session_is_aal2(), true, 'AAL2 passes the assurance check');

select ok(
  pg_get_functiondef('private.has_staff_permission(private.staff_permission,uuid)'::regprocedure)
    like '%private.current_session_is_aal2()%',
  'staff permissions depend on AAL2'
);

select ok(
  pg_get_functiondef('private.is_active_member(uuid,uuid)'::regprocedure)
    like '%not private.current_principal_requires_aal2() or private.current_session_is_aal2()%',
  'staff and customers with verified TOTP cannot use membership at AAL1'
);

select ok(
  pg_get_functiondef('private.current_principal_requires_aal2()'::regprocedure)
    like '%from auth.mfa_factors%',
  'verified authenticator enrollment is enforced below the UI layer'
);

select ok(
  pg_get_functiondef('private.actor_role_label(uuid,uuid)'::regprocedure)
    not like '%current_session_is_aal2%',
  'actor-role bootstrap remains available before the MFA challenge'
);

select ok(
  pg_get_functiondef('private.actor_role_label(uuid,uuid)'::regprocedure)
    like '%content.read%',
  'content readers are classified as staff for the MFA gate'
);

select ok(
  pg_get_functiondef('private.actor_role_label(uuid,uuid)'::regprocedure)
    like '%audit.read%',
  'audit readers are classified as staff for the MFA gate'
);

select ok(
  pg_get_functiondef('hub.get_support_actor_context()'::regprocedure)
    like '%if not v_requires_aal2 or private.current_session_is_aal2() then%',
  'AAL1 staff and enrolled customers have tenant metadata redacted'
);

select ok(
  pg_get_functiondef('hub.get_support_actor_context()'::regprocedure)
    like '%v_role := private.actor_role_label(v_user_id, null)%',
  'dual-role product-scoped staff retain a staff role after AAL2'
);

select * from finish();
rollback;
