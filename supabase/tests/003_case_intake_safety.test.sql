begin;

select plan(72);

select has_table('private', 'case_intake_settings', 'case-intake settings are private');
select has_table('private', 'support_request_keys', 'idempotency ledger is private');

select ok(
  (select relrowsecurity from pg_class where oid = 'private.case_intake_settings'::regclass),
  'case-intake settings have defense-in-depth RLS'
);

select ok(
  (select relrowsecurity from pg_class where oid = 'private.support_request_keys'::regclass),
  'idempotency ledger has defense-in-depth RLS'
);

select ok(
  not has_table_privilege('authenticated', 'private.case_intake_settings', 'select,insert,update,delete'),
  'authenticated clients cannot read or change intake activation'
);

select ok(
  not has_table_privilege('authenticated', 'private.support_request_keys', 'select,insert,update,delete'),
  'authenticated clients cannot read or change request keys'
);

select has_function(
  'private',
  'is_case_intake_enabled',
  array['uuid', 'uuid'],
  'case-intake readiness helper exists'
);

select has_function(
  'private',
  'current_user_is_usable',
  array[]::text[],
  'current Auth principal usability helper exists'
);

select ok(
  not has_function_privilege('authenticated', 'private.current_user_is_usable()', 'execute'),
  'authenticated clients cannot invoke the private usability helper directly'
);

select ok(
  not has_function_privilege('authenticated', 'private.is_case_intake_enabled(uuid,uuid)', 'execute'),
  'authenticated clients cannot invoke the private readiness helper directly'
);

select is(
  private.is_case_intake_enabled(
    'ffffffff-ffff-4fff-8fff-fffffffffff1'::uuid,
    'ffffffff-ffff-4fff-8fff-fffffffffff2'::uuid
  ),
  false,
  'an absent activation row fails closed'
);

select is(
  (
    select pg_get_expr(default_value.adbin, default_value.adrelid)
    from pg_attrdef default_value
    join pg_attribute column_definition
      on column_definition.attrelid = default_value.adrelid
     and column_definition.attnum = default_value.adnum
    where default_value.adrelid = 'private.case_intake_settings'::regclass
      and column_definition.attname = 'enabled'
  ),
  'false',
  'new activation rows default to disabled'
);

select ok(
  pg_get_functiondef('private.is_case_intake_enabled(uuid,uuid)'::regprocedure)
    like '%permission.permission in (''case.write'', ''platform.admin'')%',
  'intake requires an active support writer'
);

select ok(
  pg_get_functiondef('private.is_case_intake_enabled(uuid,uuid)'::regprocedure)
    like '%from auth.mfa_factors factor%',
  'intake requires a verified staff authenticator enrollment'
);

select ok(
  pg_get_functiondef('private.is_case_intake_enabled(uuid,uuid)'::regprocedure)
    like '%staff_user.deleted_at is null%',
  'deleted staff accounts do not satisfy intake readiness'
);

select ok(
  pg_get_functiondef('private.is_case_intake_enabled(uuid,uuid)'::regprocedure)
    like '%staff_user.banned_until is null or staff_user.banned_until <= now()%',
  'banned staff accounts do not satisfy intake readiness'
);

select has_function(
  'hub',
  'create_support_case',
  array['uuid', 'uuid', 'text', 'hub.case_category', 'hub.case_priority', 'text', 'text', 'text', 'boolean'],
  'legacy create-case RPC remains available'
);

select has_function(
  'hub',
  'create_support_case',
  array['uuid', 'uuid', 'text', 'hub.case_category', 'hub.case_priority', 'text', 'text', 'text', 'boolean', 'uuid'],
  'idempotent create-case RPC overload exists'
);

select has_function(
  'hub',
  'reply_to_support_case',
  array['uuid', 'text', 'text'],
  'legacy reply RPC remains available'
);

select has_function(
  'hub',
  'reply_to_support_case',
  array['uuid', 'text', 'text', 'uuid'],
  'idempotent reply RPC overload exists'
);

select ok(
  pg_get_functiondef(
    'hub.create_support_case(uuid,uuid,text,hub.case_category,hub.case_priority,text,text,text,boolean,uuid)'::regprocedure
  ) like '%private.is_case_intake_enabled(p_tenant_id, p_product_id)%',
  'case creation is guarded by the activation helper'
);

select ok(
  lower(pg_get_indexdef('hub.case_messages_client_message_id_idx'::regclass))
    like '%where (client_message_id is not null)%',
  'message idempotency is enforced only for non-null client keys'
);

select ok(
  lower(pg_get_indexdef('private.case_notes_client_message_id_idx'::regclass))
    like '%where (client_message_id is not null)%',
  'internal-note idempotency is enforced only for non-null client keys'
);

select ok(
  pg_get_functiondef(
    'hub.create_support_case(uuid,uuid,text,hub.case_category,hub.case_priority,text,text,text,boolean)'::regprocedure
  ) like '%gen_random_uuid()%',
  'legacy case creation generates a server request key'
);

select ok(
  pg_get_functiondef(
    'hub.create_support_case(uuid,uuid,text,hub.case_category,hub.case_priority,text,text,text,boolean)'::regprocedure
  ) not like '%null::uuid%',
  'legacy case creation never forwards a null request key'
);

select ok(
  pg_get_functiondef('hub.reply_to_support_case(uuid,text,text)'::regprocedure)
    like '%gen_random_uuid()%',
  'legacy replies generate a server request key'
);

select ok(
  pg_get_functiondef('hub.reply_to_support_case(uuid,text,text)'::regprocedure)
    not like '%null::uuid%',
  'legacy replies never forward a null request key'
);

select ok(
  pg_get_functiondef(
    'hub.create_support_case(uuid,uuid,text,hub.case_category,hub.case_priority,text,text,text,boolean,uuid)'::regprocedure
  ) like '%p_contains_phi is distinct from false%',
  'keyed case creation requires an explicit no-PHI acknowledgement'
);

select ok(
  pg_get_functiondef('hub.reply_to_support_case(uuid,text,text,uuid)'::regprocedure)
    like '%p_visibility is null or p_visibility not in (''customer'', ''internal'')%',
  'keyed replies reject null visibility explicitly'
);

-- Transactional fixtures exercise the real functions. Fixed UUIDs and
-- test.invalid addresses make the rows deterministic and non-production.
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
  (
    '00000000-0000-0000-0000-000000000000',
    '91000000-0000-4000-8000-000000000001',
    'authenticated',
    'authenticated',
    'case-customer@test.invalid',
    extensions.crypt('test-only', extensions.gen_salt('bf')),
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"display_name":"Case Customer"}'::jsonb,
    now(), now(), '', '', '', '', '', '', false, false
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '91000000-0000-4000-8000-000000000002',
    'authenticated',
    'authenticated',
    'case-writer@test.invalid',
    extensions.crypt('test-only', extensions.gen_salt('bf')),
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"display_name":"Case Writer"}'::jsonb,
    now(), now(), '', '', '', '', '', '', false, false
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '91000000-0000-4000-8000-000000000003',
    'authenticated',
    'authenticated',
    'case-reader@test.invalid',
    extensions.crypt('test-only', extensions.gen_salt('bf')),
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"display_name":"Case Reader"}'::jsonb,
    now(), now(), '', '', '', '', '', '', false, false
  );

insert into hub.products (id, slug, name, description, status, support_enabled)
values (
  '92000000-0000-4000-8000-000000000001',
  'pgtap-case-intake',
  'pgTAP Case Intake',
  'Transactional case-intake test product.',
  'active',
  true
);

insert into hub.tenants (id, slug, name, status)
values (
  '93000000-0000-4000-8000-000000000001',
  'pgtap-case-tenant',
  'pgTAP Case Tenant',
  'active'
);

insert into hub.tenant_products (tenant_id, product_id, status)
values (
  '93000000-0000-4000-8000-000000000001',
  '92000000-0000-4000-8000-000000000001',
  'active'
);

insert into hub.tenant_product_memberships (
  tenant_id,
  product_id,
  user_id,
  role,
  case_scope,
  status
) values
  (
    '93000000-0000-4000-8000-000000000001',
    '92000000-0000-4000-8000-000000000001',
    '91000000-0000-4000-8000-000000000001',
    'customer',
    'own',
    'active'
  ),
  (
    '93000000-0000-4000-8000-000000000001',
    '92000000-0000-4000-8000-000000000001',
    '91000000-0000-4000-8000-000000000003',
    'customer',
    'own',
    'active'
  );

insert into private.staff_permissions (user_id, product_id, permission, granted_by)
values
  (
    '91000000-0000-4000-8000-000000000002',
    '92000000-0000-4000-8000-000000000001',
    'case.write',
    '91000000-0000-4000-8000-000000000002'
  ),
  (
    '91000000-0000-4000-8000-000000000003',
    '92000000-0000-4000-8000-000000000001',
    'case.read',
    '91000000-0000-4000-8000-000000000002'
  );

insert into auth.mfa_factors (
  id,
  user_id,
  friendly_name,
  factor_type,
  status,
  created_at,
  updated_at,
  secret
) values
  (
    '94000000-0000-4000-8000-000000000001',
    '91000000-0000-4000-8000-000000000002',
    'pgTAP writer TOTP',
    'totp',
    'verified',
    now(),
    now(),
    'JBSWY3DPEHPK3PXP'
  ),
  (
    '94000000-0000-4000-8000-000000000002',
    '91000000-0000-4000-8000-000000000003',
    'pgTAP reader TOTP',
    'totp',
    'verified',
    now(),
    now(),
    'JBSWY3DPEHPK3PXQ'
  );

insert into private.case_intake_settings (
  tenant_id,
  product_id,
  enabled,
  activated_at,
  activated_by
) values (
  '93000000-0000-4000-8000-000000000001',
  '92000000-0000-4000-8000-000000000001',
  true,
  now(),
  '91000000-0000-4000-8000-000000000002'
);

create temporary table case_intake_test_state (
  label text primary key,
  entity_id uuid not null,
  response jsonb not null
) on commit drop;

update auth.users
set is_anonymous = true
where id = '91000000-0000-4000-8000-000000000002';

select is(
  private.is_case_intake_enabled(
    '93000000-0000-4000-8000-000000000001'::uuid,
    '92000000-0000-4000-8000-000000000001'::uuid
  ),
  false,
  'an anonymous staff account cannot make intake ready'
);

update auth.users
set is_anonymous = false
where id = '91000000-0000-4000-8000-000000000002';

delete from hub.profiles
where id = '91000000-0000-4000-8000-000000000002';

select is(
  private.is_case_intake_enabled(
    '93000000-0000-4000-8000-000000000001'::uuid,
    '92000000-0000-4000-8000-000000000001'::uuid
  ),
  false,
  'a staff account without a support profile cannot make intake ready'
);

insert into hub.profiles (id, display_name)
values ('91000000-0000-4000-8000-000000000002', 'Case Writer');

set local request.jwt.claims = '{"sub":"91000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}';

select throws_ok(
  $test$
    select hub.create_support_case(
      '93000000-0000-4000-8000-000000000001'::uuid,
      '92000000-0000-4000-8000-000000000001'::uuid,
      'Cannot open a report',
      'technical_issue'::hub.case_category,
      'normal'::hub.case_priority,
      'The report does not open for me.',
      null,
      '/reports',
      false,
      null::uuid
    )
  $test$,
  '22023',
  'A request key is required.',
  'keyed case creation rejects a null request key'
);

select throws_ok(
  $test$
    select hub.create_support_case(
      '93000000-0000-4000-8000-000000000001'::uuid,
      '92000000-0000-4000-8000-000000000001'::uuid,
      'Cannot open a report',
      'technical_issue'::hub.case_category,
      'normal'::hub.case_priority,
      'The report does not open for me.',
      null,
      '/reports',
      null::boolean,
      '95000000-0000-4000-8000-000000000001'::uuid
    )
  $test$,
  'P0001',
  'Remove patient or clinical information before creating this support case.',
  'keyed case creation rejects a null PHI acknowledgement'
);

select throws_ok(
  $test$
    select hub.create_support_case(
      '93000000-0000-4000-8000-000000000001'::uuid,
      '92000000-0000-4000-8000-000000000001'::uuid,
      null::text,
      'technical_issue'::hub.case_category,
      'normal'::hub.case_priority,
      'The report does not open for me.',
      null,
      '/reports',
      false,
      '95000000-0000-4000-8000-000000000011'::uuid
    )
  $test$,
  '22023',
  'Subject must be between 3 and 160 characters.',
  'keyed case creation rejects a null subject explicitly'
);

select throws_ok(
  $test$
    select hub.create_support_case(
      '93000000-0000-4000-8000-000000000001'::uuid,
      '92000000-0000-4000-8000-000000000001'::uuid,
      'Cannot open a report',
      null::hub.case_category,
      'normal'::hub.case_priority,
      'The report does not open for me.',
      null,
      '/reports',
      false,
      '95000000-0000-4000-8000-000000000012'::uuid
    )
  $test$,
  '22023',
  'Category is required.',
  'keyed case creation rejects a null category explicitly'
);

select throws_ok(
  $test$
    select hub.create_support_case(
      '93000000-0000-4000-8000-000000000001'::uuid,
      '92000000-0000-4000-8000-000000000001'::uuid,
      'Cannot open a report',
      'technical_issue'::hub.case_category,
      null::hub.case_priority,
      'The report does not open for me.',
      null,
      '/reports',
      false,
      '95000000-0000-4000-8000-000000000013'::uuid
    )
  $test$,
  '22023',
  'Priority is required.',
  'keyed case creation rejects a null priority explicitly'
);

select throws_ok(
  $test$
    select hub.create_support_case(
      '93000000-0000-4000-8000-000000000001'::uuid,
      '92000000-0000-4000-8000-000000000001'::uuid,
      'Cannot open a report',
      'technical_issue'::hub.case_category,
      'normal'::hub.case_priority,
      null::text,
      null,
      '/reports',
      false,
      '95000000-0000-4000-8000-000000000014'::uuid
    )
  $test$,
  '22023',
  'Message must be between 10 and 5000 characters.',
  'keyed case creation rejects a null message explicitly'
);

insert into case_intake_test_state (label, entity_id, response)
select 'keyed-create', created.id, to_jsonb(created)
from hub.create_support_case(
  '93000000-0000-4000-8000-000000000001'::uuid,
  '92000000-0000-4000-8000-000000000001'::uuid,
  'Cannot open a report',
  'technical_issue'::hub.case_category,
  'normal'::hub.case_priority,
  'The report does not open for me.',
  null,
  '/reports',
  false,
  '95000000-0000-4000-8000-000000000002'::uuid
) as created;

select ok(
  (select entity_id is not null from case_intake_test_state where label = 'keyed-create'),
  'first keyed case creation succeeds'
);

update private.case_intake_settings
set enabled = false
where tenant_id = '93000000-0000-4000-8000-000000000001'
  and product_id = '92000000-0000-4000-8000-000000000001';

select is(
  (
    select to_jsonb(replayed)
    from hub.create_support_case(
      '93000000-0000-4000-8000-000000000001'::uuid,
      '92000000-0000-4000-8000-000000000001'::uuid,
      'Cannot open a report',
      'technical_issue'::hub.case_category,
      'normal'::hub.case_priority,
      'The report does not open for me.',
      null,
      '/reports',
      false,
      '95000000-0000-4000-8000-000000000002'::uuid
    ) as replayed
  ),
  (select response from case_intake_test_state where label = 'keyed-create'),
  'identical keyed case replay returns the original after intake is disabled'
);

select is(
  (
    select count(*)
    from hub.support_cases
    where requester_id = '91000000-0000-4000-8000-000000000001'
      and subject = 'Cannot open a report'
  ),
  1::bigint,
  'identical keyed case replay does not create another case'
);

select throws_ok(
  $test$
    select hub.create_support_case(
      '93000000-0000-4000-8000-000000000001'::uuid,
      '92000000-0000-4000-8000-000000000001'::uuid,
      'A newly disabled request',
      'technical_issue'::hub.case_category,
      'normal'::hub.case_priority,
      'This new request must fail while intake is disabled.',
      null,
      '/reports',
      false,
      '95000000-0000-4000-8000-000000000006'::uuid
    )
  $test$,
  'P0001',
  'Support case intake is not active for this organization and product. Use the central phone or email listed in Help.',
  'a new request still fails while intake is disabled'
);

select is(
  (
    select count(*)
    from private.support_request_keys
    where actor_id = '91000000-0000-4000-8000-000000000001'
      and operation = 'case.create'
      and request_key = '95000000-0000-4000-8000-000000000006'
  ),
  0::bigint,
  'a disabled new request leaves no provisional ledger row'
);

select throws_ok(
  $test$
    select hub.create_support_case(
      '93000000-0000-4000-8000-000000000001'::uuid,
      '92000000-0000-4000-8000-000000000001'::uuid,
      'Changed request data',
      'technical_issue'::hub.case_category,
      'normal'::hub.case_priority,
      'The report does not open for me.',
      null,
      '/reports',
      false,
      '95000000-0000-4000-8000-000000000002'::uuid
    )
  $test$,
  '22023',
  'Request key was already used with different case data.',
  'changed case data cannot reuse an existing request key'
);

select throws_ok(
  $test$
    select hub.reply_to_support_case(
      (select entity_id from case_intake_test_state where label = 'keyed-create'),
      'Here is the additional detail.',
      'customer',
      null::uuid
    )
  $test$,
  '22023',
  'A request key is required.',
  'keyed replies reject a null request key'
);

select throws_ok(
  $test$
    select hub.reply_to_support_case(
      (select entity_id from case_intake_test_state where label = 'keyed-create'),
      null::text,
      'customer',
      '95000000-0000-4000-8000-000000000015'::uuid
    )
  $test$,
  '22023',
  'Reply must be between 1 and 5000 characters.',
  'keyed replies reject a null body explicitly'
);

insert into case_intake_test_state (label, entity_id, response)
select 'keyed-reply', (created.response ->> 'id')::uuid, created.response
from (
  select hub.reply_to_support_case(
    (select entity_id from case_intake_test_state where label = 'keyed-create'),
    'Here is the additional detail.',
    'customer',
    '95000000-0000-4000-8000-000000000003'::uuid
  ) as response
) as created;

select ok(
  (select entity_id is not null from case_intake_test_state where label = 'keyed-reply'),
  'first keyed reply succeeds'
);

select is(
  hub.reply_to_support_case(
    (select entity_id from case_intake_test_state where label = 'keyed-create'),
    'Here is the additional detail.',
    'customer',
    '95000000-0000-4000-8000-000000000003'::uuid
  ),
  (select response from case_intake_test_state where label = 'keyed-reply'),
  'identical keyed reply returns the original response'
);

select is(
  (
    select count(*)
    from hub.case_messages
    where client_message_id = '95000000-0000-4000-8000-000000000003'
  ),
  1::bigint,
  'identical keyed reply does not create another message'
);

select throws_ok(
  $test$
    select hub.reply_to_support_case(
      (select entity_id from case_intake_test_state where label = 'keyed-create'),
      'Changed reply data.',
      'customer',
      '95000000-0000-4000-8000-000000000003'::uuid
    )
  $test$,
  '22023',
  'Request key was already used with different reply data.',
  'changed reply data cannot reuse an existing request key'
);

select throws_ok(
  $test$
    select hub.reply_to_support_case(
      (select entity_id from case_intake_test_state where label = 'keyed-create'),
      'Customer cannot add internal notes.',
      'internal',
      '95000000-0000-4000-8000-000000000004'::uuid
    )
  $test$,
  '42501',
  'Only support staff can create internal notes.',
  'internal replies still require case-write permission'
);

set local request.jwt.claims = '{"sub":"91000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal2"}';

insert into case_intake_test_state (label, entity_id, response)
select 'internal-reply', (created.response ->> 'id')::uuid, created.response
from (
  select hub.reply_to_support_case(
    (select entity_id from case_intake_test_state where label = 'keyed-create'),
    'Staff-only diagnostic note.',
    'internal',
    '95000000-0000-4000-8000-000000000007'::uuid
  ) as response
) as created;

select is(
  (select response ->> 'visibility' from case_intake_test_state where label = 'internal-reply'),
  'internal',
  'AAL2 case-write staff can create an internal note'
);

select is(
  hub.reply_to_support_case(
    (select entity_id from case_intake_test_state where label = 'keyed-create'),
    'Staff-only diagnostic note.',
    'internal',
    '95000000-0000-4000-8000-000000000007'::uuid
  ),
  (select response from case_intake_test_state where label = 'internal-reply'),
  'identical keyed internal-note replay returns the original response'
);

select is(
  (
    select count(*)
    from private.case_notes
    where client_message_id = '95000000-0000-4000-8000-000000000007'
  ),
  1::bigint,
  'identical keyed internal-note replay does not create another note'
);

update auth.users
set banned_until = now() + interval '1 hour'
where id = '91000000-0000-4000-8000-000000000002';

select is(
  private.current_user_is_usable(),
  false,
  'a banned staff principal becomes unusable immediately'
);

select is(
  private.current_session_is_aal2(),
  false,
  'a stale AAL2 claim does not restore a banned principal'
);

select is(
  private.has_staff_permission(
    'case.write',
    '92000000-0000-4000-8000-000000000001'::uuid
  ),
  false,
  'a banned principal cannot retain an unrevoked staff permission'
);

select throws_ok(
  $$select hub.get_support_actor_context()$$,
  '28000',
  'Authentication required',
  'the actor bootstrap rejects a banned principal'
);

update auth.users
set banned_until = null
where id = '91000000-0000-4000-8000-000000000002';

set local request.jwt.claims = '{"sub":"91000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}';

select is(
  (
    select count(*)
    from hub.get_support_case_thread(
      (select entity_id from case_intake_test_state where label = 'keyed-create')
    )
    where visibility = 'internal'
  ),
  0::bigint,
  'customer thread reads never expose staff-only notes'
);

select is(
  (
    select count(*)
    from hub.get_support_case_thread(
      (select entity_id from case_intake_test_state where label = 'keyed-create')
    )
    where id = (select entity_id from case_intake_test_state where label = 'internal-reply')
  ),
  0::bigint,
  'the internal note identifier is absent from the customer-visible thread'
);

update auth.users
set banned_until = now() + interval '1 hour'
where id = '91000000-0000-4000-8000-000000000001';

select is(
  private.is_active_member(
    '93000000-0000-4000-8000-000000000001'::uuid,
    '92000000-0000-4000-8000-000000000001'::uuid
  ),
  false,
  'a banned customer cannot retain an active membership path'
);

select is(
  private.can_view_case_id(
    (select entity_id from case_intake_test_state where label = 'keyed-create')
  ),
  false,
  'a banned customer cannot use a stale token to read a case'
);

update auth.users
set banned_until = null
where id = '91000000-0000-4000-8000-000000000001';

set local request.jwt.claims = '{"sub":"91000000-0000-4000-8000-000000000003","role":"authenticated","aal":"aal2"}';

select is(
  private.can_view_case_id(
    (select entity_id from case_intake_test_state where label = 'keyed-create')
  ),
  true,
  'AAL2 read-only staff can view the fixture case'
);

select is(
  private.has_staff_permission(
    'case.write',
    '92000000-0000-4000-8000-000000000001'::uuid
  ),
  false,
  'AAL2 read-only staff do not gain case-write permission'
);

select is(
  private.is_active_member(
    '93000000-0000-4000-8000-000000000001'::uuid,
    '92000000-0000-4000-8000-000000000001'::uuid
  ),
  true,
  'the read-only staff fixture also has an active own-scope customer membership'
);

select throws_ok(
  $test$
    select hub.reply_to_support_case(
      (select entity_id from case_intake_test_state where label = 'keyed-create'),
      'Read-only dual-role staff cannot reply to another requester case.',
      'customer',
      '95000000-0000-4000-8000-000000000008'::uuid
    )
  $test$,
  '42501',
  'No permission to reply to this case.',
  'case-read plus unrelated own-scope membership cannot compose into case-write'
);

select throws_ok(
  $test$
    select hub.reply_to_support_case(
      (select entity_id from case_intake_test_state where label = 'keyed-create'),
      'Visibility must be explicit.',
      null::text,
      '95000000-0000-4000-8000-000000000005'::uuid
    )
  $test$,
  '22023',
  'Invalid reply visibility.',
  'null visibility is rejected even for AAL2 read-only staff'
);

set local request.jwt.claims = '{"sub":"91000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}';
update private.case_intake_settings
set enabled = true
where tenant_id = '93000000-0000-4000-8000-000000000001'
  and product_id = '92000000-0000-4000-8000-000000000001';

insert into case_intake_test_state (label, entity_id, response)
select 'legacy-create', created.id, to_jsonb(created)
from hub.create_support_case(
  '93000000-0000-4000-8000-000000000001'::uuid,
  '92000000-0000-4000-8000-000000000001'::uuid,
  'Legacy wrapper request',
  'general'::hub.case_category,
  'normal'::hub.case_priority,
  'Legacy wrapper creates a server request key.',
  null,
  null,
  null::boolean
) as created;

select ok(
  exists (
    select 1
    from private.support_request_keys request
    where request.operation = 'case.create'
      and request.case_id = (
        select entity_id from case_intake_test_state where label = 'legacy-create'
      )
      and request.request_key is not null
  ),
  'legacy case creation persists its generated request key'
);

insert into case_intake_test_state (label, entity_id, response)
select 'legacy-reply', (created.response ->> 'id')::uuid, created.response
from (
  select hub.reply_to_support_case(
    (select entity_id from case_intake_test_state where label = 'legacy-create'),
    'Legacy reply also gets a server request key.',
    'customer'
  ) as response
) as created;

select ok(
  exists (
    select 1
    from private.support_request_keys request
    where request.operation = 'case.reply'
      and request.entity_id = (
        select entity_id from case_intake_test_state where label = 'legacy-reply'
      )
      and request.request_key is not null
  ),
  'legacy replies persist their generated request keys'
);

set local request.jwt.claims = '{"sub":"91000000-0000-4000-8000-000000000003","role":"authenticated","aal":"aal2"}';

insert into case_intake_test_state (label, entity_id, response)
select 'dual-role-own-case', created.id, to_jsonb(created)
from hub.create_support_case(
  '93000000-0000-4000-8000-000000000001'::uuid,
  '92000000-0000-4000-8000-000000000001'::uuid,
  'Dual-role own request',
  'general'::hub.case_category,
  'normal'::hub.case_priority,
  'This request is created through the customer membership path.',
  null,
  null,
  false,
  '95000000-0000-4000-8000-000000000009'::uuid
) as created;

select is(
  (
    select author_role
    from hub.case_messages
    where case_id = (select entity_id from case_intake_test_state where label = 'dual-role-own-case')
    order by created_at, id
    limit 1
  ),
  'customer',
  'dual-role case creation labels the membership-authored message as customer'
);

insert into case_intake_test_state (label, entity_id, response)
select 'dual-role-own-reply', (created.response ->> 'id')::uuid, created.response
from (
  select hub.reply_to_support_case(
    (select entity_id from case_intake_test_state where label = 'dual-role-own-case'),
    'This is a customer-path reply to my own case.',
    'customer',
    '95000000-0000-4000-8000-000000000010'::uuid
  ) as response
) as created;

select is(
  (select response ->> 'author_role' from case_intake_test_state where label = 'dual-role-own-reply'),
  'customer',
  'dual-role own-case replies are not mislabeled as official staff answers'
);

select is(
  (
    select status::text
    from hub.support_cases
    where id = (select entity_id from case_intake_test_state where label = 'dual-role-own-case')
  ),
  'open',
  'a dual-role membership reply follows customer status transitions'
);

select is(
  (
    select count(*)
    from hub.case_messages
    where case_id = (select entity_id from case_intake_test_state where label = 'dual-role-own-case')
      and author_id = '91000000-0000-4000-8000-000000000003'
      and author_role = 'support_agent'
  ),
  0::bigint,
  'no dual-role membership message is persisted with a staff trust label'
);

select * from finish();
rollback;
