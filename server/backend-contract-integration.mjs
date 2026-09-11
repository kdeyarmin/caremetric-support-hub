// Exercise the actual declaration against disposable PostgreSQL, with every
// synthetic schema change rolled back. Never accept a remote test database.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { assertBackendContract } from '../src/lib/backendContract.ts';

const databaseUrl=process.env.HUB_TEST_DATABASE_URL;
const local=new URL(databaseUrl);
assert.equal(local.hostname,'127.0.0.1'); assert.equal(local.port,'54322');
const client=new pg.Client({connectionString:databaseUrl});
const migration=await readFile(new URL('../supabase/migrations/20260911190819_combined_authoring_publication_support_contract.sql',import.meta.url),'utf8');
const editingMigration=await readFile(new URL('../supabase/migrations/20260911192238_learning_draft_editing_contract.sql',import.meta.url),'utf8');
const billingMigration=await readFile(new URL('../supabase/migrations/20260911195910_billing_portal_backend_contract.sql',import.meta.url),'utf8');
const structureMigration=await readFile(new URL('../supabase/migrations/20260911202823_learning_structure_backend_contract.sql',import.meta.url),'utf8');
const checkoutMigration=await readFile(new URL('../supabase/migrations/20260911204842_billing_checkout_backend_contract.sql',import.meta.url),'utf8');
const readContract=async()=> (await client.query('select hub.get_backend_contract() as contract')).rows[0].contract;
const cases=[
  {
    sql:'alter function hub.get_support_readiness() rename to test_missing_support_readiness',
    error:/missing function hub.get_support_readiness\(\)/,
  },
  {
    sql:'alter table private.publication_public_downloads rename to test_missing_public_downloads',
    error:/missing table private.publication_public_downloads/,
  },
  {
    sql:"alter table private.app_delegations drop constraint app_delegations_audience_check; alter table private.app_delegations add constraint app_delegations_audience_check check(audience <> 'not-a-real-product')",
    error:/reviewed Intel delegation audience/,
  },
  {
    sql:"create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='' as $$ select '{\"api_version\":4,\"features\":[]}'::jsonb $$",
    error:/API 4 foundation and receipt features/,
  },
  {
    sql:"create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='' as $$ select null::jsonb $$",
    error:/API 4 foundation and receipt features/,
  },
];

await client.connect();
try {
  assertBackendContract(await readContract());
  for(const fixture of cases) {
    await client.query('begin');
    try {
      await client.query(fixture.sql);
      const before=await readContract();
      await client.query('savepoint before_declaration');
      await assert.rejects(()=>client.query(migration),error=>error.code==='55000' && fixture.error.test(error.message));
      await client.query('rollback to savepoint before_declaration');
      assert.deepEqual(await readContract(),before,'A rejected declaration must not change release metadata');
    } finally { await client.query('rollback'); }
  }
  await client.query('begin');
  try {
    const before=await readContract();
    await client.query(migration);
    assert.deepEqual(await readContract(),{...before,features:before.features.filter(feature=>!['learning.draft-editing.v1','billing.portal.v1','learning.structure.v1','billing.checkout.v1'].includes(feature))});
    assert.throws(()=>assertBackendContract({...before,features:before.features.filter(feature=>feature!=='learning.draft-editing.v1')}),/incompatible/);
    await client.query(editingMigration);
    assert.deepEqual(await readContract(),{...before,features:before.features.filter(feature=>!['billing.portal.v1','learning.structure.v1','billing.checkout.v1'].includes(feature))});
    assert.throws(()=>assertBackendContract({...before,features:before.features.filter(feature=>feature!=='billing.portal.v1')}),/incompatible/);
    await client.query(billingMigration);
    assert.deepEqual(await readContract(),{...before,features:before.features.filter(feature=>!['learning.structure.v1','billing.checkout.v1'].includes(feature))});
    assert.throws(()=>assertBackendContract({...before,features:before.features.filter(feature=>feature!=='learning.structure.v1')}),/incompatible/);
    await client.query(structureMigration);
    assert.deepEqual(await readContract(),{...before,features:before.features.filter(feature=>feature!=='billing.checkout.v1')});
    assert.throws(()=>assertBackendContract({...before,features:before.features.filter(feature=>feature!=='billing.checkout.v1')}),/incompatible/);
    await client.query(checkoutMigration);
    assert.deepEqual(await readContract(),before,'Forward declarations restore the exact current feature set');
    assertBackendContract(await readContract());
  } finally { await client.query('rollback'); }
  for(const sql of [
    'alter function private.learning_authoring_actions() rename to test_missing_editing_actions',
    "create or replace function private.learning_authoring_actions() returns text[] language sql immutable security invoker set search_path='' as $$ select array['learning.cloneVersion','learning.publishVersion']::text[] $$",
  ]) {
    await client.query('begin');
    try { await client.query(sql);await assert.rejects(()=>client.query(editingMigration),error=>error.code==='55000' && /draft editing/.test(error.message)); }
    finally { await client.query('rollback'); }
  }
  for(const sql of [
    'alter function private.validate_governed_learning_source(text,text) rename to test_missing_structure_reader',
    'alter function hub.record_learning_authoring_result(uuid,text,jsonb) rename to test_missing_structure_result',
    "create or replace function private.learning_authoring_actions() returns text[] language sql immutable security invoker set search_path='' as $$ select array['learning.cloneVersion','learning.publishVersion','learning.patchDraft','learning.reviewDraft']::text[] $$",
    "create or replace function private.validate_governed_learning_source(p_payload text,p_revision text) returns jsonb language sql set search_path='' as $$ select p_payload::jsonb $$",
    "create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='' as $$ select null::jsonb $$",
  ]) {
    await client.query('begin');
    try { await client.query(sql);await assert.rejects(()=>client.query(structureMigration),error=>error.code==='55000' && /structure|draft reader/.test(error.message)); }
    finally { await client.query('rollback'); }
  }
  console.log('Backend declarations rejected twelve incomplete SQL boundaries and accepted the complete combined structure contract.');
} finally { await client.end(); }
