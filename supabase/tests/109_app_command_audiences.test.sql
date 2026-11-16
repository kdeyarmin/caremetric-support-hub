begin;
select plan(3);

-- Breathe and CareMetric Intel changes are redeemed under their own command audiences, never a read audience.
select ok((select pg_get_constraintdef(oid) like '%''breathe.command''%' and pg_get_constraintdef(oid) like '%''intel.command''%'
    and pg_get_constraintdef(oid) like '%''carebase.command''%' and pg_get_constraintdef(oid) like '%''advisors''%'
    and pg_get_constraintdef(oid) like '%''breathe''%' and pg_get_constraintdef(oid) like '%''intel''%'
    and pg_get_constraintdef(oid) like '%carebase.learning%' and pg_get_constraintdef(oid) like '%publication%' and pg_get_constraintdef(oid) like '%media%'
  from pg_constraint where conname = 'app_delegations_audience_check'),
  'The Breathe and Intel command audiences are added without dropping any existing capability audience');
select throws_ok($$insert into private.app_delegations(token_hash, session_id, audience, payload, expires_at)
  values (repeat('a', 64), gen_random_uuid(), 'breathe.admin', '{}', now() + interval '30 seconds')$$, '23514', null,
  'An audience outside the reviewed list is refused');
select ok(hub.get_backend_contract() -> 'features' ? 'platform.admin.app-commands.v1', 'Breathe and Intel access changes are declared in release metadata');

select * from finish();
rollback;
