const pennsyncMigration=await readFile(new URL('../supabase/migrations/20260912002100_pennsync_learning_contract.sql',import.meta.url),'utf8');
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
const onboardingMigration=await readFile(new URL('../supabase/migrations/20260911200100_support_customer_onboarding_contract.sql',import.meta.url),'utf8');
const registrationMigration=await readFile(new URL('../supabase/migrations/20260911203100_support_customer_registration_contract.sql',import.meta.url),'utf8');
const creationMigration=await readFile(new URL('../supabase/migrations/20260911212027_governed_course_creation_contract.sql',import.meta.url),'utf8');
const docstudioMigration=await readFile(new URL('../supabase/migrations/20260911223938_docstudio_backend_contract.sql',import.meta.url),'utf8');
const policyMigration=await readFile(new URL('../supabase/migrations/20260911215751_learning_credit_policy_contract.sql',import.meta.url),'utf8');
const policyIntentMigration=await readFile(new URL('../supabase/migrations/20260911215749_learning_credit_policy_intents.sql',import.meta.url),'utf8');
const historicalStructure=await readFile(new URL('../supabase/migrations/20260911202021_learning_structure_intents.sql',import.meta.url),'utf8');
const structureActionsSql=historicalStructure.slice(0,historicalStructure.indexOf('revoke all'));
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
    assert.deepEqual(await readContract(),{...before,features:before.features.filter(feature=>!['learning.draft-editing.v1','billing.portal.v1','support.customer-onboarding.v1','learning.structure.v1','support.customer-registration.v1','billing.checkout.v1','learning.course-creation.v1','learning.credit-policy.v1','knowledge.docstudio.v1','learning.distribution.v1','learning.pennsync-source.v1','learning.media.v1','phone.registry.v1','phone.accounts.v1'].includes(feature))});
    assert.throws(()=>assertBackendContract({...before,features:before.features.filter(feature=>feature!=='learning.draft-editing.v1')}),/incompatible/);
    await client.query(editingMigration);
    assert.deepEqual(await readContract(),{...before,features:before.features.filter(feature=>!['billing.portal.v1','support.customer-onboarding.v1','learning.structure.v1','support.customer-registration.v1','billing.checkout.v1','learning.course-creation.v1','learning.credit-policy.v1','knowledge.docstudio.v1','learning.distribution.v1','learning.pennsync-source.v1','learning.media.v1','phone.registry.v1','phone.accounts.v1'].includes(feature))});
    assert.throws(()=>assertBackendContract({...before,features:before.features.filter(feature=>feature!=='billing.portal.v1')}),/incompatible/);
    await client.query(billingMigration);
    assert.deepEqual(await readContract(),{...before,features:before.features.filter(feature=>!['support.customer-onboarding.v1','learning.structure.v1','support.customer-registration.v1','billing.checkout.v1','learning.course-creation.v1','learning.credit-policy.v1','knowledge.docstudio.v1','learning.distribution.v1','learning.pennsync-source.v1','learning.media.v1','phone.registry.v1','phone.accounts.v1'].includes(feature))});
    assert.throws(()=>assertBackendContract({...before,features:before.features.filter(feature=>feature!=='support.customer-onboarding.v1')}),/incompatible/);
    await client.query(onboardingMigration);
    assert.deepEqual(await readContract(),{...before,features:before.features.filter(feature=>!['learning.structure.v1','support.customer-registration.v1','billing.checkout.v1','learning.course-creation.v1','learning.credit-policy.v1','knowledge.docstudio.v1','learning.distribution.v1','learning.pennsync-source.v1','learning.media.v1','phone.registry.v1','phone.accounts.v1'].includes(feature))});
    assert.throws(()=>assertBackendContract({...before,features:before.features.filter(feature=>feature!=='learning.structure.v1')}),/incompatible/);
    // Old declaration requires its exact historical five-action shape.
    await client.query(structureActionsSql);
    await client.query(structureMigration);
    assert.deepEqual(await readContract(),{...before,features:before.features.filter(feature=>!['support.customer-registration.v1','billing.checkout.v1','learning.course-creation.v1','learning.credit-policy.v1','knowledge.docstudio.v1','learning.distribution.v1','learning.pennsync-source.v1','learning.media.v1','phone.registry.v1','phone.accounts.v1'].includes(feature))});
    assert.throws(()=>assertBackendContract({...before,features:before.features.filter(feature=>feature!=='support.customer-registration.v1')}),/incompatible/);
    await client.query(registrationMigration);
    assert.deepEqual(await readContract(),{...before,features:before.features.filter(feature=>!['billing.checkout.v1','learning.course-creation.v1','learning.credit-policy.v1','knowledge.docstudio.v1','learning.distribution.v1','learning.pennsync-source.v1','learning.media.v1','phone.registry.v1','phone.accounts.v1'].includes(feature))});
    assert.throws(()=>assertBackendContract({...before,features:before.features.filter(feature=>feature!=='billing.checkout.v1')}),/incompatible/);
    await client.query(checkoutMigration);
    assert.deepEqual(await readContract(),{...before,features:before.features.filter(feature=>!['learning.course-creation.v1','learning.credit-policy.v1','knowledge.docstudio.v1','learning.distribution.v1','learning.pennsync-source.v1','learning.media.v1','phone.registry.v1','phone.accounts.v1'].includes(feature))});
    assert.throws(()=>assertBackendContract({...before,features:before.features.filter(feature=>feature!=='learning.course-creation.v1')}),/incompatible/);
    await client.query(creationMigration);
    assert.deepEqual(await readContract(),{...before,features:before.features.filter(feature=>!['learning.credit-policy.v1','knowledge.docstudio.v1','learning.distribution.v1','learning.pennsync-source.v1','learning.media.v1','phone.registry.v1','phone.accounts.v1'].includes(feature))});
    assert.throws(()=>assertBackendContract({...before,features:before.features.filter(feature=>feature!=='learning.credit-policy.v1')}),/incompatible/);
    await client.query(policyIntentMigration);
    await client.query(policyMigration);
    assert.deepEqual(await readContract(),{...before,features:before.features.filter(feature=>!['knowledge.docstudio.v1','learning.distribution.v1','learning.pennsync-source.v1','learning.media.v1','phone.registry.v1','phone.accounts.v1'].includes(feature))});
    assert.throws(()=>assertBackendContract({...before,features:before.features.filter(feature=>feature!=='knowledge.docstudio.v1')}),/incompatible/);
    await client.query(docstudioMigration);
    assert.deepEqual(await readContract(),{...before,features:before.features.filter(feature=>!['learning.distribution.v1','learning.pennsync-source.v1','learning.media.v1','phone.registry.v1','phone.accounts.v1'].includes(feature))});
    await client.query(await readFile(new URL('../supabase/migrations/20260911234549_governed_course_distribution_contract.sql',import.meta.url),'utf8'));
    assert.deepEqual(await readContract(),{...before,features:before.features.filter(feature=>!['learning.pennsync-source.v1','learning.media.v1','phone.registry.v1','phone.accounts.v1'].includes(feature))});
    assert.throws(()=>assertBackendContract({...before,features:before.features.filter(feature=>feature!=='learning.pennsync-source.v1')}),/incompatible/);
    await client.query(pennsyncMigration);
    assert.deepEqual(await readContract(),{...before,features:before.features.filter(feature=>!['learning.media.v1','phone.registry.v1','phone.accounts.v1'].includes(feature))});
    await client.query(await readFile(new URL('../supabase/migrations/20260912002345_governed_course_media_contract.sql',import.meta.url),'utf8'));
    await client.query(await readFile(new URL('../supabase/migrations/20260925022151_phone_registry_contract.sql',import.meta.url),'utf8'));
    await client.query(await readFile(new URL('../supabase/migrations/20260925030135_phone_registry_tenant_accounts.sql',import.meta.url),'utf8'));
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
  await client.query('begin');
  try {
    const before=await readContract();
    const withLaterFeature={...before,features:[...before.features,'synthetic.reviewed-next.v1']};
    // Literal JSON is from this fixed synthetic fixture, not caller input.
    const literal=JSON.stringify(withLaterFeature).replaceAll("'","''");
    await client.query(`create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='' as $$ select '${literal}'::jsonb $$`);
    // Old declaration requires its exact historical five-action shape.
    await client.query(structureActionsSql);
    await client.query(structureMigration);
    await client.query(policyIntentMigration);
    assert.deepEqual(await readContract(),withLaterFeature,'An additive declaration preserves independently reviewed features');
    assertBackendContract(await readContract());
  } finally {await client.query('rollback');}
  for(const signature of ['hub.prepare_support_onboarding(uuid,uuid,jsonb,uuid,text)','hub.inspect_support_onboarding(uuid,uuid,uuid,text,uuid)','hub.apply_support_onboarding(uuid,uuid,uuid,text,uuid,jsonb,boolean)']) {
    await client.query('begin');
    try {await client.query(`alter function ${signature} rename to fixture_missing_onboarding`);await assert.rejects(()=>client.query(onboardingMigration),error=>error.code==='55000');}
    finally {await client.query('rollback');}
  }
  await client.query('begin');
  try {
    const future={...await readContract(),features:[...(await readContract()).features,'fixture.future.v1']};
    const declaration=(await client.query("select format('create or replace function hub.get_backend_contract() returns jsonb language sql stable set search_path='''' as %L', 'select '||quote_literal($1::text)||'::jsonb') as sql",[JSON.stringify(future)])).rows[0].sql;
    await client.query(declaration);
    const before=await readContract();await client.query(onboardingMigration);assert.deepEqual(await readContract(),before,'Onboarding preserves other reviewed features and is idempotent');
  } finally {await client.query('rollback');}
  console.log('Backend declarations rejected fifteen incomplete SQL boundaries and preserved independent onboarding and structure features.');
} finally { await client.end(); }
