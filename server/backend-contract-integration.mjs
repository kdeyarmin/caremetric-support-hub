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
const platformBillingMigration=await readFile(new URL('../supabase/migrations/20261027120100_platform_billing_contract.sql',import.meta.url),'utf8');
const selfServiceMigration=await readFile(new URL('../supabase/migrations/20261027134533_facility_self_service.sql',import.meta.url),'utf8');
const selfServiceContract=selfServiceMigration.slice(selfServiceMigration.indexOf('-- Contract publication is last:'));
const humanEscalationMigration=await readFile(new URL('../supabase/migrations/20261027183500_customer_human_escalation.sql',import.meta.url),'utf8');
const humanEscalationContract=humanEscalationMigration.slice(humanEscalationMigration.indexOf('do $$ declare contract'));
const diagnosticSupportMigration=await readFile(new URL('../supabase/migrations/20261027190000_customer_diagnostic_support.sql',import.meta.url),'utf8');
const checkoutMigration=await readFile(new URL('../supabase/migrations/20261027210000_customer_checkout.sql',import.meta.url),'utf8');
const checkoutContract=checkoutMigration.slice(checkoutMigration.indexOf('do $$ declare contract'));
const facilityMigration=await readFile(new URL('../supabase/migrations/20261028023422_facility_entitlement_snapshots.sql',import.meta.url),'utf8');
const facilityContract=facilityMigration.slice(facilityMigration.indexOf('do $$ declare contract'));
const agentsContract=await readFile(new URL('../supabase/migrations/20261102120100_agent_control_plane_contract.sql',import.meta.url),'utf8');
const probesContract=await readFile(new URL('../supabase/migrations/20261102130100_agent_probes_contract.sql',import.meta.url),'utf8');
const briefContract=await readFile(new URL('../supabase/migrations/20261102140100_agent_brief_contract.sql',import.meta.url),'utf8');
const seoContract=await readFile(new URL('../supabase/migrations/20261102150100_agent_seo_contract.sql',import.meta.url),'utf8');
const diagnosticSupportContract=diagnosticSupportMigration.slice(diagnosticSupportMigration.indexOf('do $$ declare contract'));
assert.ok(selfServiceContract.startsWith('-- Contract publication is last:'),'Recognize the self-service contract declaration');
const structureMigration=await readFile(new URL('../supabase/migrations/20260911202823_learning_structure_backend_contract.sql',import.meta.url),'utf8');
const onboardingMigration=await readFile(new URL('../supabase/migrations/20260911200100_support_customer_onboarding_contract.sql',import.meta.url),'utf8');
const registrationMigration=await readFile(new URL('../supabase/migrations/20260911203100_support_customer_registration_contract.sql',import.meta.url),'utf8');
const creationMigration=await readFile(new URL('../supabase/migrations/20260911212027_governed_course_creation_contract.sql',import.meta.url),'utf8');
const docstudioMigration=await readFile(new URL('../supabase/migrations/20260911223938_docstudio_backend_contract.sql',import.meta.url),'utf8');
const docstudioRuntimeSql=await readFile(new URL('../supabase/migrations/20260911220747_hub_docstudio_runtime.sql',import.meta.url),'utf8');
// Retirement leaves bucket removal to the Storage API. Reuse that bucket while
// rebuilding the historical runtime only inside the rolled-back replay fixture.
// The original contract gate still checks that the bucket exists and is private.
const docstudioRuntime=docstudioRuntimeSql.replace(/^(insert into storage\.buckets[^\n]+);$/m,'$1 on conflict (id) do nothing;');
assert.notEqual(docstudioRuntime,docstudioRuntimeSql,'The historical bucket insert must be recognized');
const retirementMigration=await readFile(new URL('../supabase/migrations/20261022210000_retire_docstudio.sql',import.meta.url),'utf8');
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
// Earlier declarations gate on the retired billing.portal.v1 feature; their replays start from a contract that still lists it.
const withPortalFeature=contract=>({...contract,features:contract.features.flatMap(feature=>feature==='learning.draft-editing.v1'?[feature,'billing.portal.v1']:[feature])});
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
const archivedAdvisors=(await client.query("select status,support_enabled from hub.products where slug='advisors'")).rows[0];
try {
  // Replay historical declaration prerequisites only in this disposable fixture.
  // Native authority stays disabled by the current application allowlist.
  await client.query("update hub.products set status='active',support_enabled=true where slug='advisors'");
  assert.equal((await client.query("select private.hub_application_enabled(id) as enabled from hub.products where slug='advisors'")).rows[0].enabled,false);
  assertBackendContract(await readContract());
  assert.equal((await readContract()).features.includes('knowledge.docstudio.v1'),false,'The current contract excludes the retired runtime');
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
    const latest=await readContract();
    // The AI team declarations are the newest features (declared ahead of the build that will require them): replay history without them, then replay their gates last, in order.
    const current={...latest,features:latest.features.filter(feature=>!['platform.agents.v1','platform.agents.probes.v1','platform.agents.brief.v1','platform.agents.seo.v1'].includes(feature))};
    // Platform billing replaced three app-specific billing features. Replay history with them in their original places.
    const before={...current,features:current.features.filter(feature=>!['billing.platform.v1','customer.self-service.v1','support.manual-escalation.v1','support.customer-diagnostics.v1','billing.customer-checkout.v1','billing.facility-entitlements.v1'].includes(feature)).flatMap(feature=>
      feature==='learning.draft-editing.v1'?[feature,'billing.portal.v1']
      :feature==='support.customer-registration.v1'?[feature,'billing.checkout.v1']
      :feature==='support.ai-usage.v1'?[feature,'platform.admin.tenants.v1']:[feature])};
    assert.equal(before.features.length,current.features.length-3);
    // Their objects are gone, so those three declarations are replayed as the features they appended.
    const appendFeature=async feature=>{
      const next=await readContract();
      const literal=JSON.stringify({...next,features:[...next.features,feature]}).replaceAll("'","''");
      await client.query(`create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='' as $$ select '${literal}'::jsonb $$`);
    };
    // Earlier declarations advertised DocStudio between credit policy and distribution.
    // Keep their exact historical feature lists separate from the retired current contract.
    const beforeRetirement={...before,features:before.features.flatMap(feature=>
      feature==='learning.distribution.v1'?['knowledge.docstudio.v1',feature]:[feature])};
    assert.equal(beforeRetirement.features.length,before.features.length+1);
    await client.query(migration);
    assert.deepEqual(await readContract(),{...before,features:before.features.filter(feature=>!['learning.draft-editing.v1','billing.portal.v1','support.customer-onboarding.v1','learning.structure.v1','support.customer-registration.v1','billing.checkout.v1','learning.course-creation.v1','learning.credit-policy.v1','learning.distribution.v1','learning.pennsync-source.v1','learning.media.v1','phone.registry.v1','phone.accounts.v1','learning.sequence.v1','support.ai-assistance.v1','support.ai-automation.v1','support.go-live-readiness.v1','support.ai-automation-server.v1','platform.admin.advisors.v1','support.ai-automation-failure-policy.v1','support.communications.v1','support.ai-usage.v1','platform.admin.tenants.v1','support.bulk-email.v1','learning.catalog-authoring.v1'].includes(feature))});
    assert.throws(()=>assertBackendContract({...before,features:before.features.filter(feature=>feature!=='learning.draft-editing.v1')}),/incompatible/);
    await client.query(editingMigration);
    assert.deepEqual(await readContract(),{...before,features:before.features.filter(feature=>!['billing.portal.v1','support.customer-onboarding.v1','learning.structure.v1','support.customer-registration.v1','billing.checkout.v1','learning.course-creation.v1','learning.credit-policy.v1','learning.distribution.v1','learning.pennsync-source.v1','learning.media.v1','phone.registry.v1','phone.accounts.v1','learning.sequence.v1','support.ai-assistance.v1','support.ai-automation.v1','support.go-live-readiness.v1','support.ai-automation-server.v1','platform.admin.advisors.v1','support.ai-automation-failure-policy.v1','support.communications.v1','support.ai-usage.v1','platform.admin.tenants.v1','support.bulk-email.v1','learning.catalog-authoring.v1'].includes(feature))});
    await appendFeature('billing.portal.v1');
    assert.deepEqual(await readContract(),{...before,features:before.features.filter(feature=>!['support.customer-onboarding.v1','learning.structure.v1','support.customer-registration.v1','billing.checkout.v1','learning.course-creation.v1','learning.credit-policy.v1','learning.distribution.v1','learning.pennsync-source.v1','learning.media.v1','phone.registry.v1','phone.accounts.v1','learning.sequence.v1','support.ai-assistance.v1','support.ai-automation.v1','support.go-live-readiness.v1','support.ai-automation-server.v1','platform.admin.advisors.v1','support.ai-automation-failure-policy.v1','support.communications.v1','support.ai-usage.v1','platform.admin.tenants.v1','support.bulk-email.v1','learning.catalog-authoring.v1'].includes(feature))});
    assert.throws(()=>assertBackendContract({...before,features:before.features.filter(feature=>feature!=='support.customer-onboarding.v1')}),/incompatible/);
    await client.query(onboardingMigration);
    assert.deepEqual(await readContract(),{...before,features:before.features.filter(feature=>!['learning.structure.v1','support.customer-registration.v1','billing.checkout.v1','learning.course-creation.v1','learning.credit-policy.v1','learning.distribution.v1','learning.pennsync-source.v1','learning.media.v1','phone.registry.v1','phone.accounts.v1','learning.sequence.v1','support.ai-assistance.v1','support.ai-automation.v1','support.go-live-readiness.v1','support.ai-automation-server.v1','platform.admin.advisors.v1','support.ai-automation-failure-policy.v1','support.communications.v1','support.ai-usage.v1','platform.admin.tenants.v1','support.bulk-email.v1','learning.catalog-authoring.v1'].includes(feature))});
    assert.throws(()=>assertBackendContract({...before,features:before.features.filter(feature=>feature!=='learning.structure.v1')}),/incompatible/);
    // Old declaration requires its exact historical five-action shape.
    await client.query(structureActionsSql);
    await client.query(structureMigration);
    assert.deepEqual(await readContract(),{...before,features:before.features.filter(feature=>!['support.customer-registration.v1','billing.checkout.v1','learning.course-creation.v1','learning.credit-policy.v1','learning.distribution.v1','learning.pennsync-source.v1','learning.media.v1','phone.registry.v1','phone.accounts.v1','learning.sequence.v1','support.ai-assistance.v1','support.ai-automation.v1','support.go-live-readiness.v1','support.ai-automation-server.v1','platform.admin.advisors.v1','support.ai-automation-failure-policy.v1','support.communications.v1','support.ai-usage.v1','platform.admin.tenants.v1','support.bulk-email.v1','learning.catalog-authoring.v1'].includes(feature))});
    assert.throws(()=>assertBackendContract({...before,features:before.features.filter(feature=>feature!=='support.customer-registration.v1')}),/incompatible/);
    await client.query(registrationMigration);
    assert.deepEqual(await readContract(),{...before,features:before.features.filter(feature=>!['billing.checkout.v1','learning.course-creation.v1','learning.credit-policy.v1','learning.distribution.v1','learning.pennsync-source.v1','learning.media.v1','phone.registry.v1','phone.accounts.v1','learning.sequence.v1','support.ai-assistance.v1','support.ai-automation.v1','support.go-live-readiness.v1','support.ai-automation-server.v1','platform.admin.advisors.v1','support.ai-automation-failure-policy.v1','support.communications.v1','support.ai-usage.v1','platform.admin.tenants.v1','support.bulk-email.v1','learning.catalog-authoring.v1'].includes(feature))});
    await appendFeature('billing.checkout.v1');
    assert.deepEqual(await readContract(),{...before,features:before.features.filter(feature=>!['learning.course-creation.v1','learning.credit-policy.v1','learning.distribution.v1','learning.pennsync-source.v1','learning.media.v1','phone.registry.v1','phone.accounts.v1','learning.sequence.v1','support.ai-assistance.v1','support.ai-automation.v1','support.go-live-readiness.v1','support.ai-automation-server.v1','platform.admin.advisors.v1','support.ai-automation-failure-policy.v1','support.communications.v1','support.ai-usage.v1','platform.admin.tenants.v1','support.bulk-email.v1','learning.catalog-authoring.v1'].includes(feature))});
    assert.throws(()=>assertBackendContract({...before,features:before.features.filter(feature=>feature!=='learning.course-creation.v1')}),/incompatible/);
    await client.query(creationMigration);
    assert.deepEqual(await readContract(),{...before,features:before.features.filter(feature=>!['learning.credit-policy.v1','learning.distribution.v1','learning.pennsync-source.v1','learning.media.v1','phone.registry.v1','phone.accounts.v1','learning.sequence.v1','support.ai-assistance.v1','support.ai-automation.v1','support.go-live-readiness.v1','support.ai-automation-server.v1','platform.admin.advisors.v1','support.ai-automation-failure-policy.v1','support.communications.v1','support.ai-usage.v1','platform.admin.tenants.v1','support.bulk-email.v1','learning.catalog-authoring.v1'].includes(feature))});
    assert.throws(()=>assertBackendContract({...before,features:before.features.filter(feature=>feature!=='learning.credit-policy.v1')}),/incompatible/);
    await client.query(policyIntentMigration);
    await client.query(policyMigration);
    assert.deepEqual(await readContract(),{...before,features:before.features.filter(feature=>!['learning.distribution.v1','learning.pennsync-source.v1','learning.media.v1','phone.registry.v1','phone.accounts.v1','learning.sequence.v1','support.ai-assistance.v1','support.ai-automation.v1','support.go-live-readiness.v1','support.ai-automation-server.v1','platform.admin.advisors.v1','support.ai-automation-failure-policy.v1','support.communications.v1','support.ai-usage.v1','platform.admin.tenants.v1','support.bulk-email.v1','learning.catalog-authoring.v1'].includes(feature))});
    assert.throws(()=>assertBackendContract({...before,features:before.features.filter(feature=>feature!=='learning.distribution.v1')}),/incompatible/);
    await client.query(docstudioRuntime);
    await client.query(docstudioMigration);
    assert.deepEqual(await readContract(),{...beforeRetirement,features:beforeRetirement.features.filter(feature=>!['learning.distribution.v1','learning.pennsync-source.v1','learning.media.v1','phone.registry.v1','phone.accounts.v1','learning.sequence.v1','support.ai-assistance.v1','support.ai-automation.v1','support.go-live-readiness.v1','support.ai-automation-server.v1','platform.admin.advisors.v1','support.ai-automation-failure-policy.v1','support.communications.v1','support.ai-usage.v1','platform.admin.tenants.v1','support.bulk-email.v1','learning.catalog-authoring.v1'].includes(feature))});
    await client.query(await readFile(new URL('../supabase/migrations/20260911234549_governed_course_distribution_contract.sql',import.meta.url),'utf8'));
    assert.deepEqual(await readContract(),{...beforeRetirement,features:beforeRetirement.features.filter(feature=>!['learning.pennsync-source.v1','learning.media.v1','phone.registry.v1','phone.accounts.v1','learning.sequence.v1','support.ai-assistance.v1','support.ai-automation.v1','support.go-live-readiness.v1','support.ai-automation-server.v1','platform.admin.advisors.v1','support.ai-automation-failure-policy.v1','support.communications.v1','support.ai-usage.v1','platform.admin.tenants.v1','support.bulk-email.v1','learning.catalog-authoring.v1'].includes(feature))});
    assert.throws(()=>assertBackendContract({...before,features:before.features.filter(feature=>feature!=='learning.pennsync-source.v1')}),/incompatible/);
    await client.query(pennsyncMigration);
    assert.deepEqual(await readContract(),{...beforeRetirement,features:beforeRetirement.features.filter(feature=>!['learning.media.v1','phone.registry.v1','phone.accounts.v1','learning.sequence.v1','support.ai-assistance.v1','support.ai-automation.v1','support.go-live-readiness.v1','support.ai-automation-server.v1','platform.admin.advisors.v1','support.ai-automation-failure-policy.v1','support.communications.v1','support.ai-usage.v1','platform.admin.tenants.v1','support.bulk-email.v1','learning.catalog-authoring.v1'].includes(feature))});
    await client.query(await readFile(new URL('../supabase/migrations/20260912002345_governed_course_media_contract.sql',import.meta.url),'utf8'));
    await client.query(await readFile(new URL('../supabase/migrations/20260925022151_phone_registry_contract.sql',import.meta.url),'utf8'));
    await client.query(await readFile(new URL('../supabase/migrations/20260925030135_phone_registry_tenant_accounts.sql',import.meta.url),'utf8'));
    await client.query(await readFile(new URL('../supabase/migrations/20261009203100_learning_course_sequence_contract.sql',import.meta.url),'utf8'));
    await client.query(aiContractMigration);
    assert.deepEqual(await readContract(),{...beforeRetirement,features:beforeRetirement.features.filter(feature=>!['support.go-live-readiness.v1','support.ai-automation-server.v1','platform.admin.advisors.v1','support.ai-automation-failure-policy.v1','support.communications.v1','support.ai-usage.v1','platform.admin.tenants.v1','support.bulk-email.v1','learning.catalog-authoring.v1'].includes(feature))});
    assert.throws(()=>assertBackendContract({...before,features:before.features.filter(feature=>feature!=='support.go-live-readiness.v1')}),/incompatible/);
    await client.query(readinessContractMigration);
    assert.deepEqual(await readContract(),{...beforeRetirement,features:beforeRetirement.features.filter(feature=>!['support.ai-automation-server.v1','platform.admin.advisors.v1','support.ai-automation-failure-policy.v1','support.communications.v1','support.ai-usage.v1','platform.admin.tenants.v1','support.bulk-email.v1','learning.catalog-authoring.v1'].includes(feature))});
    assert.throws(()=>assertBackendContract({...before,features:before.features.filter(feature=>feature!=='support.ai-automation-server.v1')}),/incompatible/);
    await client.query(automationServerContractMigration);
    assert.deepEqual(await readContract(),{...beforeRetirement,features:beforeRetirement.features.filter(feature=>!['platform.admin.advisors.v1','support.ai-automation-failure-policy.v1','support.communications.v1','support.ai-usage.v1','platform.admin.tenants.v1','support.bulk-email.v1','learning.catalog-authoring.v1'].includes(feature))});
    assert.throws(()=>assertBackendContract({...before,features:before.features.filter(feature=>feature!=='platform.admin.advisors.v1')}),/incompatible/);
    await client.query(advisorsContractMigration);
    assert.deepEqual(await readContract(),{...beforeRetirement,features:beforeRetirement.features.filter(feature=>!['support.ai-automation-failure-policy.v1','support.communications.v1','support.ai-usage.v1','platform.admin.tenants.v1','support.bulk-email.v1','learning.catalog-authoring.v1'].includes(feature))});
    assert.throws(()=>assertBackendContract({...before,features:before.features.filter(feature=>feature!=='support.ai-automation-failure-policy.v1')}),/incompatible/);
    await client.query(automationFailurePolicyContractMigration);
    assert.deepEqual(await readContract(),{...beforeRetirement,features:beforeRetirement.features.filter(feature=>!['support.communications.v1','support.ai-usage.v1','platform.admin.tenants.v1','support.bulk-email.v1','learning.catalog-authoring.v1'].includes(feature))});
    assert.throws(()=>assertBackendContract({...before,features:before.features.filter(feature=>feature!=='support.communications.v1')}),/incompatible/);
    await client.query(await readFile(new URL('../supabase/migrations/20261020163100_unified_communications_contract.sql',import.meta.url),'utf8'));
    assert.deepEqual(await readContract(),{...beforeRetirement,features:beforeRetirement.features.filter(feature=>!['support.ai-usage.v1','platform.admin.tenants.v1','support.bulk-email.v1','learning.catalog-authoring.v1'].includes(feature))});
    assert.throws(()=>assertBackendContract({...before,features:before.features.filter(feature=>feature!=='support.ai-usage.v1')}),/incompatible/);
    await client.query(await readFile(new URL('../supabase/migrations/20261021120100_ai_usage_ledger_contract.sql',import.meta.url),'utf8'));
    assert.deepEqual(await readContract(),{...beforeRetirement,features:beforeRetirement.features.filter(feature=>!['platform.admin.tenants.v1','support.bulk-email.v1','learning.catalog-authoring.v1'].includes(feature))});
    await appendFeature('platform.admin.tenants.v1');
    assert.deepEqual(await readContract(),{...beforeRetirement,features:beforeRetirement.features.filter(feature=>!['support.bulk-email.v1','learning.catalog-authoring.v1'].includes(feature))});
    assert.throws(()=>assertBackendContract({...before,features:before.features.filter(feature=>feature!=='support.bulk-email.v1')}),/incompatible/);
    await client.query(await readFile(new URL('../supabase/migrations/20261021160100_bulk_email_contract.sql',import.meta.url),'utf8'));
    assert.deepEqual(await readContract(),{...beforeRetirement,features:beforeRetirement.features.filter(feature=>feature!=='learning.catalog-authoring.v1')});
    assert.throws(()=>assertBackendContract({...before,features:before.features.filter(feature=>feature!=='learning.catalog-authoring.v1')}),/incompatible/);
    // The replayed credit policy intents restored the historical six actions; replay the catalog actions first.
    await client.query(await readFile(new URL('../supabase/migrations/20261022120000_learning_catalog_authoring_intents.sql',import.meta.url),'utf8'));
    await client.query(await readFile(new URL('../supabase/migrations/20261022120100_learning_catalog_authoring_contract.sql',import.meta.url),'utf8'));
    assert.deepEqual(await readContract(),beforeRetirement,'Historical declarations restore the exact pre-retirement feature set');
    await client.query(retirementMigration);
    assert.deepEqual(await readContract(),before,'Retirement restores the exact historical feature set');
    await client.query(platformBillingMigration);
    assert.deepEqual(await readContract(),{...current,features:current.features.filter(feature=>!['customer.self-service.v1','support.manual-escalation.v1','support.customer-diagnostics.v1','billing.customer-checkout.v1','billing.facility-entitlements.v1'].includes(feature))},'Platform billing restores its historical feature set');
    await client.query(selfServiceContract);
    assert.deepEqual(await readContract(),{...current,features:current.features.filter(feature=>!['support.manual-escalation.v1','support.customer-diagnostics.v1','billing.customer-checkout.v1','billing.facility-entitlements.v1'].includes(feature))},'Self-service restores its historical feature set');
    await client.query(humanEscalationContract);
    assert.deepEqual(await readContract(),{...current,features:current.features.filter(feature=>!['support.customer-diagnostics.v1','billing.customer-checkout.v1','billing.facility-entitlements.v1'].includes(feature))},'Customer escalation restores its historical feature set');
    await client.query(diagnosticSupportContract);
    assert.deepEqual(await readContract(),{...current,features:current.features.filter(feature=>!['billing.customer-checkout.v1','billing.facility-entitlements.v1'].includes(feature))},'Customer diagnostics restores its historical feature set');
    await client.query(checkoutContract);
    assert.deepEqual(await readContract(),{...current,features:current.features.filter(feature=>feature!=='billing.facility-entitlements.v1')},'Checkout restores its historical feature set');
    await client.query(facilityContract);
    assert.deepEqual(await readContract(),current,'Facility entitlements restore the exact pre-agents feature set');
    await client.query(agentsContract);
    assert.deepEqual(await readContract(),{...current,features:[...current.features,'platform.agents.v1']},'The AI team declaration adds only its own feature');
    await client.query(probesContract);
    assert.deepEqual(await readContract(),{...current,features:[...current.features,'platform.agents.v1','platform.agents.probes.v1']},'The health probe declaration adds only its own feature');
    await client.query(briefContract);
    assert.deepEqual(await readContract(),{...current,features:[...current.features,'platform.agents.v1','platform.agents.probes.v1','platform.agents.brief.v1']},'The morning brief declaration adds only its own feature');
    await client.query(seoContract);
    assert.deepEqual(await readContract(),latest,'The SEO analyst declaration restores the exact current feature set');
    assertBackendContract(await readContract());
    assert.throws(()=>assertBackendContract({...latest,features:latest.features.filter(feature=>feature!=='billing.platform.v1')}),/incompatible/);
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
    const before=withPortalFeature(await readContract());
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
    const historical=withPortalFeature(await readContract());
    const future={...historical,features:[...historical.features,'fixture.future.v1']};
    const declaration=(await client.query("select format('create or replace function hub.get_backend_contract() returns jsonb language sql stable set search_path='''' as %L', 'select '||quote_literal($1::text)||'::jsonb') as sql",[JSON.stringify(future)])).rows[0].sql;
    await client.query(declaration);
    const before=await readContract();await client.query(onboardingMigration);assert.deepEqual(await readContract(),before,'Onboarding preserves other reviewed features and is idempotent');
  } finally {await client.query('rollback');}
  console.log('Backend declarations rejected fifteen incomplete SQL boundaries and preserved independent onboarding and structure features.');
} finally {
  await client.query("update hub.products set status=$1,support_enabled=$2 where slug='advisors'",[archivedAdvisors.status,archivedAdvisors.support_enabled]);
  await client.end();
}
