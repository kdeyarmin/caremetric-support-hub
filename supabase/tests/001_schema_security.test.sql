begin;

select plan(13);

select has_schema('hub', 'hub schema exists');
select has_schema('private', 'private schema exists');
select has_table('hub', 'support_cases', 'support cases table exists');
select has_table('private', 'case_notes', 'internal notes are physically separate');
select has_table('private', 'audit_events', 'append-only audit table exists');

select ok(
  (select relrowsecurity from pg_class where oid = 'hub.support_cases'::regclass),
  'support cases have RLS enabled'
);

select ok(
  (select relrowsecurity from pg_class where oid = 'hub.case_messages'::regclass),
  'customer-visible case messages have RLS enabled'
);

select ok(
  not has_table_privilege('anon', 'hub.support_cases', 'select'),
  'anonymous users cannot read support cases'
);

select ok(
  not has_table_privilege('authenticated', 'hub.support_cases', 'insert,update,delete'),
  'authenticated clients cannot directly mutate support cases'
);

select ok(
  not has_table_privilege('authenticated', 'private.case_notes', 'select,insert,update,delete'),
  'authenticated clients have no direct internal-note privileges'
);

select ok(
  not has_table_privilege('authenticated', 'private.audit_events', 'select,insert,update,delete'),
  'authenticated clients have no direct audit privileges'
);

select ok(
  coalesce((select reloptions @> array['security_invoker=true'] from pg_class where oid = 'hub.support_case_queue'::regclass), false),
  'case queue view is security-invoker'
);

select ok(
  coalesce((select reloptions @> array['security_invoker=true'] from pg_class where oid = 'hub.published_content'::regclass), false),
  'published-content view is security-invoker'
);

select * from finish();
rollback;
