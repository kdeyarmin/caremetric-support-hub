const pennsyncMigration=await readFile(new URL('../supabase/migrations/20260912002100_pennsync_learning_contract.sql',import.meta.url),'utf8');
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
const creationMigration=await readFile(new URL('../supabase/migrations/20260911212027_governed_course_creation_contract.sql',import.meta.url),'utf8');
const docstudioMigration=await readFile(new URL('../supabase/migrations/20260911223938_docstudio_backend_contract.sql',import.meta.url),'utf8');
const aiContractMigration=await readFile(new URL('../supabase/migrations/20261015120100_ai_case_assistance_contract.sql',import.meta.url),'utf8');
const readinessContractMigration=await readFile(new URL('../supabase/migrations/20261017120000_go_live_readiness_contract.sql',import.meta.url),'utf8');
const automationServerContractMigration=await readFile(new URL('../supabase/migrations/20261020120100_ai_automation_server_contract.sql',import.meta.url),'utf8');
const advisorsContractMigration=await readFile(new URL('../supabase/migrations/20261020150100_advisors_application_contract.sql',import.meta.url),'utf8');
const automationFailurePolicyContractMigration=await readFile(new URL('../supabase/migrations/20261020160100_ai_automation_failure_policy_contract.sql',import.meta.url),'utf8');
const policyMigration=await readFile(new URL('../supabase/migrations/20260911215751_learning_credit_policy_contract.sql',import.meta.url),'utf8');
const policyIntentMigration=await readFile(new URL('../supabase/migrations/20260911215749_learning_credit_policy_intents.sql',import.meta.url),'utf8');
const historicalStructure=await readFile(new URL('../supabase/migrations/20260911202021_learning_structure_intents.sql',import.meta.url),'utf8');
const structureActionsSql=historicalStructure.slice(0,historicalStructure.indexOf('revoke all'));
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
    assert.deepEqual(await readContract(),{...before,features:before.features.filter(feature=>!['support.customer-onboarding.v1','learning.structure.v1','support.customer-registration.v1','billing.checkout.v1','learning.course-creation.v1','learning.credit-policy.v1','knowledge.docstudio.v1','learning.distribution.v1','learning.pennsync-source.v1','learning.media.v1','phone.registry.v1','phone.accounts.v1','learning.sequence.v1','support.ai-assistance.v1','support.ai-automation.v1','support.go-live-readiness.v1','support.ai-automation-server.v1','platform.admin.advisors.v1','support.ai-automation-failure-policy.v1','support.communications.v1','support.ai-usage.v1','platform.admin.tenants.v1','support.bulk-email.v1','learning.catalog-authoring.v1'].includes(feature))});
    const portalOnly=await readContract(); assert.throws(()=>assertBackendContract(portalOnly),/incompatible/);
    await client.query(onboardingMigration);
    // Old declaration requires its exact historical five-action shape.
    await client.query(structureActionsSql);
    await client.query(structureMigration);
    assert.deepEqual(await readContract(),{...before,features:before.features.filter(feature=>!['support.customer-registration.v1','billing.checkout.v1','learning.course-creation.v1','learning.credit-policy.v1','knowledge.docstudio.v1','learning.distribution.v1','learning.pennsync-source.v1','learning.media.v1','phone.registry.v1','phone.accounts.v1','learning.sequence.v1','support.ai-assistance.v1','support.ai-automation.v1','support.go-live-readiness.v1','support.ai-automation-server.v1','platform.admin.advisors.v1','support.ai-automation-failure-policy.v1','support.communications.v1','support.ai-usage.v1','platform.admin.tenants.v1','support.bulk-email.v1','learning.catalog-authoring.v1'].includes(feature))});
    await client.query(registrationMigration);
    assert.deepEqual(await readContract(),{...before,features:before.features.filter(feature=>!['billing.checkout.v1','learning.course-creation.v1','learning.credit-policy.v1','knowledge.docstudio.v1','learning.distribution.v1','learning.pennsync-source.v1','learning.media.v1','phone.registry.v1','phone.accounts.v1','learning.sequence.v1','support.ai-assistance.v1','support.ai-automation.v1','support.go-live-readiness.v1','support.ai-automation-server.v1','platform.admin.advisors.v1','support.ai-automation-failure-policy.v1','support.communications.v1','support.ai-usage.v1','platform.admin.tenants.v1','support.bulk-email.v1','learning.catalog-authoring.v1'].includes(feature))});
    assert.throws(()=>assertBackendContract({...before,features:before.features.filter(feature=>feature!=='billing.checkout.v1')}),/incompatible/);
    await client.query(checkoutMigration);
    assert.deepEqual(await readContract(),{...before,features:before.features.filter(feature=>!['learning.course-creation.v1','learning.credit-policy.v1','knowledge.docstudio.v1','learning.distribution.v1','learning.pennsync-source.v1','learning.media.v1','phone.registry.v1','phone.accounts.v1','learning.sequence.v1','support.ai-assistance.v1','support.ai-automation.v1','support.go-live-readiness.v1','support.ai-automation-server.v1','platform.admin.advisors.v1','support.ai-automation-failure-policy.v1','support.communications.v1','support.ai-usage.v1','platform.admin.tenants.v1','support.bulk-email.v1','learning.catalog-authoring.v1'].includes(feature))});
    assert.throws(()=>assertBackendContract({...before,features:before.features.filter(feature=>feature!=='learning.course-creation.v1')}),/incompatible/);
    await client.query(creationMigration);
    assert.deepEqual(await readContract(),{...before,features:before.features.filter(feature=>!['learning.credit-policy.v1','knowledge.docstudio.v1','learning.distribution.v1','learning.pennsync-source.v1','learning.media.v1','phone.registry.v1','phone.accounts.v1','learning.sequence.v1','support.ai-assistance.v1','support.ai-automation.v1','support.go-live-readiness.v1','support.ai-automation-server.v1','platform.admin.advisors.v1','support.ai-automation-failure-policy.v1','support.communications.v1','support.ai-usage.v1','platform.admin.tenants.v1','support.bulk-email.v1','learning.catalog-authoring.v1'].includes(feature))});
    assert.throws(()=>assertBackendContract({...before,features:before.features.filter(feature=>feature!=='learning.credit-policy.v1')}),/incompatible/);
    await client.query(policyIntentMigration);
    await client.query(policyMigration);
    assert.deepEqual(await readContract(),{...before,features:before.features.filter(feature=>!['knowledge.docstudio.v1','learning.distribution.v1','learning.pennsync-source.v1','learning.media.v1','phone.registry.v1','phone.accounts.v1','learning.sequence.v1','support.ai-assistance.v1','support.ai-automation.v1','support.go-live-readiness.v1','support.ai-automation-server.v1','platform.admin.advisors.v1','support.ai-automation-failure-policy.v1','support.communications.v1','support.ai-usage.v1','platform.admin.tenants.v1','support.bulk-email.v1','learning.catalog-authoring.v1'].includes(feature))});
    assert.throws(()=>assertBackendContract({...before,features:before.features.filter(feature=>feature!=='learning.distribution.v1')}),/incompatible/);
    await client.query(docstudioMigration);
    assert.deepEqual(await readContract(),{...before,features:before.features.filter(feature=>!['learning.distribution.v1','learning.pennsync-source.v1','learning.media.v1','phone.registry.v1','phone.accounts.v1','learning.sequence.v1','support.ai-assistance.v1','support.ai-automation.v1','support.go-live-readiness.v1','support.ai-automation-server.v1','platform.admin.advisors.v1','support.ai-automation-failure-policy.v1','support.communications.v1','support.ai-usage.v1','platform.admin.tenants.v1','support.bulk-email.v1','learning.catalog-authoring.v1'].includes(feature))});
    await client.query(await readFile(new URL('../supabase/migrations/20260911234549_governed_course_distribution_contract.sql',import.meta.url),'utf8'));
    assert.deepEqual(await readContract(),{...before,features:before.features.filter(feature=>!['learning.pennsync-source.v1','learning.media.v1','phone.registry.v1','phone.accounts.v1','learning.sequence.v1','support.ai-assistance.v1','support.ai-automation.v1','support.go-live-readiness.v1','support.ai-automation-server.v1','platform.admin.advisors.v1','support.ai-automation-failure-policy.v1','support.communications.v1','support.ai-usage.v1','platform.admin.tenants.v1','support.bulk-email.v1','learning.catalog-authoring.v1'].includes(feature))});
    assert.throws(()=>assertBackendContract({...before,features:before.features.filter(feature=>feature!=='learning.pennsync-source.v1')}),/incompatible/);
    await client.query(pennsyncMigration);
    assert.deepEqual(await readContract(),{...before,features:before.features.filter(feature=>!['learning.media.v1','phone.registry.v1','phone.accounts.v1','learning.sequence.v1','support.ai-assistance.v1','support.ai-automation.v1','support.go-live-readiness.v1','support.ai-automation-server.v1','platform.admin.advisors.v1','support.ai-automation-failure-policy.v1','support.communications.v1','support.ai-usage.v1','platform.admin.tenants.v1','support.bulk-email.v1','learning.catalog-authoring.v1'].includes(feature))});
    await client.query(await readFile(new URL('../supabase/migrations/20260912002345_governed_course_media_contract.sql',import.meta.url),'utf8'));
    await client.query(await readFile(new URL('../supabase/migrations/20260925022151_phone_registry_contract.sql',import.meta.url),'utf8'));
    await client.query(await readFile(new URL('../supabase/migrations/20260925030135_phone_registry_tenant_accounts.sql',import.meta.url),'utf8'));
    await client.query(await readFile(new URL('../supabase/migrations/20261009203100_learning_course_sequence_contract.sql',import.meta.url),'utf8'));
    await client.query(aiContractMigration);
    assert.deepEqual(await readContract(),{...before,features:before.features.filter(feature=>!['support.go-live-readiness.v1','support.ai-automation-server.v1','platform.admin.advisors.v1','support.ai-automation-failure-policy.v1','support.communications.v1','support.ai-usage.v1','platform.admin.tenants.v1','support.bulk-email.v1','learning.catalog-authoring.v1'].includes(feature))});
    assert.throws(()=>assertBackendContract({...before,features:before.features.filter(feature=>feature!=='support.go-live-readiness.v1')}),/incompatible/);
    await client.query(readinessContractMigration);
    assert.deepEqual(await readContract(),{...before,features:before.features.filter(feature=>!['support.ai-automation-server.v1','platform.admin.advisors.v1','support.ai-automation-failure-policy.v1','support.communications.v1','support.ai-usage.v1','platform.admin.tenants.v1','support.bulk-email.v1','learning.catalog-authoring.v1'].includes(feature))});
    assert.throws(()=>assertBackendContract({...before,features:before.features.filter(feature=>feature!=='support.ai-automation-server.v1')}),/incompatible/);
    await client.query(automationServerContractMigration);
    assert.deepEqual(await readContract(),{...before,features:before.features.filter(feature=>!['platform.admin.advisors.v1','support.ai-automation-failure-policy.v1','support.communications.v1','support.ai-usage.v1','platform.admin.tenants.v1','support.bulk-email.v1','learning.catalog-authoring.v1'].includes(feature))});
    assert.throws(()=>assertBackendContract({...before,features:before.features.filter(feature=>feature!=='platform.admin.advisors.v1')}),/incompatible/);
    await client.query(advisorsContractMigration);
    assert.deepEqual(await readContract(),{...before,features:before.features.filter(feature=>!['support.ai-automation-failure-policy.v1','support.communications.v1','support.ai-usage.v1','platform.admin.tenants.v1','support.bulk-email.v1','learning.catalog-authoring.v1'].includes(feature))});
    assert.throws(()=>assertBackendContract({...before,features:before.features.filter(feature=>feature!=='support.ai-automation-failure-policy.v1')}),/incompatible/);
    await client.query(automationFailurePolicyContractMigration);
    assert.deepEqual(await readContract(),{...before,features:before.features.filter(feature=>!['support.communications.v1','support.ai-usage.v1','platform.admin.tenants.v1','support.bulk-email.v1','learning.catalog-authoring.v1'].includes(feature))});
    assert.throws(()=>assertBackendContract({...before,features:before.features.filter(feature=>feature!=='support.communications.v1')}),/incompatible/);
    await client.query(await readFile(new URL('../supabase/migrations/20261020163100_unified_communications_contract.sql',import.meta.url),'utf8'));
    assert.deepEqual(await readContract(),{...before,features:before.features.filter(feature=>!['support.ai-usage.v1','platform.admin.tenants.v1','support.bulk-email.v1','learning.catalog-authoring.v1'].includes(feature))});
    assert.throws(()=>assertBackendContract({...before,features:before.features.filter(feature=>feature!=='support.ai-usage.v1')}),/incompatible/);
    await client.query(await readFile(new URL('../supabase/migrations/20261021120100_ai_usage_ledger_contract.sql',import.meta.url),'utf8'));
    assert.deepEqual(await readContract(),{...before,features:before.features.filter(feature=>!['platform.admin.tenants.v1','support.bulk-email.v1','learning.catalog-authoring.v1'].includes(feature))});
    assert.throws(()=>assertBackendContract({...before,features:before.features.filter(feature=>feature!=='platform.admin.tenants.v1')}),/incompatible/);
    await client.query(await readFile(new URL('../supabase/migrations/20261021140100_tenant_subscriptions_contract.sql',import.meta.url),'utf8'));
    assert.deepEqual(await readContract(),{...before,features:before.features.filter(feature=>!['support.bulk-email.v1','learning.catalog-authoring.v1'].includes(feature))});
    assert.throws(()=>assertBackendContract({...before,features:before.features.filter(feature=>feature!=='support.bulk-email.v1')}),/incompatible/);
    await client.query(await readFile(new URL('../supabase/migrations/20261021160100_bulk_email_contract.sql',import.meta.url),'utf8'));
    assert.deepEqual(await readContract(),{...before,features:before.features.filter(feature=>feature!=='learning.catalog-authoring.v1')});
    assert.throws(()=>assertBackendContract({...before,features:before.features.filter(feature=>feature!=='learning.catalog-authoring.v1')}),/incompatible/);
    // The replayed credit policy intents restored the historical six actions; replay the catalog actions first.
    await client.query(await readFile(new URL('../supabase/migrations/20261022120000_learning_catalog_authoring_intents.sql',import.meta.url),'utf8'));
    await client.query(await readFile(new URL('../supabase/migrations/20261022120100_learning_catalog_authoring_contract.sql',import.meta.url),'utf8'));
    assert.deepEqual(await readContract(),before);
    assertBackendContract(await readContract());
  } finally { await client.query('rollback'); }
  console.log('Billing portal declaration rejected seven incomplete SQL boundaries and preserved the complete feature union.');
} finally { await client.end(); }
