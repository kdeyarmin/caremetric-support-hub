// Exercise the release gate against the real disposable PostgreSQL schema.
// Every synthetic omission is rolled back; no remote database is accepted.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { assertBackendContract } from '../src/lib/backendContract.ts';

const databaseUrl=process.env.HUB_TEST_DATABASE_URL,local=new URL(databaseUrl);
assert.equal(local.hostname,'127.0.0.1');assert.equal(local.port,'54322');
const client=new pg.Client({connectionString:databaseUrl});
const migration=await readFile(new URL('../supabase/migrations/20260911195910_billing_portal_backend_contract.sql',import.meta.url),'utf8');
const structureMigration=await readFile(new URL('../supabase/migrations/20260911202823_learning_structure_backend_contract.sql',import.meta.url),'utf8');
const checkoutMigration=await readFile(new URL('../supabase/migrations/20260911204842_billing_checkout_backend_contract.sql',import.meta.url),'utf8');
const onboardingMigration=await readFile(new URL('../supabase/migrations/20260911200100_support_customer_onboarding_contract.sql',import.meta.url),'utf8');
const registrationMigration=await readFile(new URL('../supabase/migrations/20260911203100_support_customer_registration_contract.sql',import.meta.url),'utf8');
const readContract=async()=> (await client.query('select hub.get_backend_contract() as contract')).rows[0].contract;
const fixtures=[
  {
    sql:'alter function private.reserve_billing_portal(jsonb) rename to test_missing_portal_reserve',
    error:/missing function private.reserve_billing_portal/,
  },
  {
    sql:'alter function private.record_billing_portal_result(uuid,jsonb) rename to test_missing_portal_record',
    error:/missing function private.record_billing_portal_result/,
  },
  {
    sql:'alter table private.billing_portal_intents rename to test_missing_portal_intents',
    error:/billing portal intent table/,
  },
  {
    sql:"alter type private.billing_portal_action rename value 'billing.portal.create' to 'test.unsupported'",
    error:/closed billing portal action contract/,
  },
  {
    sql:'alter table private.billing_portal_intents alter column action drop not null',
    error:/closed billing portal action contract/,
  },
  {
    sql:"create or replace function private.reserve_billing_portal(p_request jsonb) returns jsonb language sql set search_path='' as $$ select null::jsonb $$",
    error:/closed billing portal action contract/,
  },
  {
    sql:"create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='' as $$ select null::jsonb $$",
    error:/combined editing contract/,
  },
];
await client.connect();
try {
  assertBackendContract(await readContract());
  for(const fixture of fixtures) {
    await client.query('begin');
    try {
      await client.query(fixture.sql);
      const before=await readContract();
      await client.query('savepoint before_portal_declaration');
      await assert.rejects(()=>client.query(migration),error=>error.code==='55000' && fixture.error.test(error.message));
      await client.query('rollback to savepoint before_portal_declaration');
      assert.deepEqual(await readContract(),before,'Rejected portal declaration must retain existing metadata');
    } finally { await client.query('rollback'); }
  }
  await client.query('begin');
  try {
    const before=await readContract();
    await client.query(migration);
    assert.deepEqual(await readContract(),{...before,features:before.features.filter(feature=>!['support.customer-onboarding.v1','learning.structure.v1','support.customer-registration.v1','billing.checkout.v1'].includes(feature))});
    const portalOnly=await readContract(); assert.throws(()=>assertBackendContract(portalOnly),/incompatible/);
    await client.query(onboardingMigration);
    await client.query(structureMigration);
    assert.deepEqual(await readContract(),{...before,features:before.features.filter(feature=>!['support.customer-registration.v1','billing.checkout.v1'].includes(feature))});
    await client.query(registrationMigration);
    assert.deepEqual(await readContract(),{...before,features:before.features.filter(feature=>feature!=='billing.checkout.v1')});
    assert.throws(()=>assertBackendContract({...before,features:before.features.filter(feature=>feature!=='billing.checkout.v1')}),/incompatible/);
    await client.query(checkoutMigration);
    assert.deepEqual(await readContract(),before);
    assertBackendContract(await readContract());
  } finally { await client.query('rollback'); }
  console.log('Billing portal declaration rejected seven incomplete SQL boundaries and preserved the complete feature union.');
} finally { await client.end(); }
