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
const conciergeContract=await readFile(new URL('../supabase/migrations/20261102160100_agent_concierge_contract.sql',import.meta.url),'utf8');
const accountsContract=await readFile(new URL('../supabase/migrations/20261102170100_agent_accounts_contract.sql',import.meta.url),'utf8');
const hardeningContract=await readFile(new URL('../supabase/migrations/20261102180100_agent_hardening_contract.sql',import.meta.url),'utf8');
const leadDeskContract=await readFile(new URL('../supabase/migrations/20261103120100_lead_desk_contract.sql',import.meta.url),'utf8');
const growthContract=await readFile(new URL('../supabase/migrations/20261103130100_agent_growth_contract.sql',import.meta.url),'utf8');
const lifecycleContract=await readFile(new URL('../supabase/migrations/20261103140100_agent_lifecycle_contract.sql',import.meta.url),'utf8');
const contentContract=await readFile(new URL('../supabase/migrations/20261103150100_agent_content_contract.sql',import.meta.url),'utf8');
const customerGrowthContract=await readFile(new URL('../supabase/migrations/20261103150102_customer_growth_contract.sql',import.meta.url),'utf8');
const autonomyContract=await readFile(new URL('../supabase/migrations/20261104220100_agent_autonomy_contract.sql',import.meta.url),'utf8');
const externalEmailContract=await readFile(new URL('../supabase/migrations/20261104230057_agent_external_email_contract.sql',import.meta.url),'utf8');
const answersContract=await readFile(new URL('../supabase/migrations/20261105120100_concierge_answers_contract.sql',import.meta.url),'utf8');
const autopublishContract=await readFile(new URL('../supabase/migrations/20261105130100_content_autopublish_contract.sql',import.meta.url),'utf8');
const offersContract=await readFile(new URL('../supabase/migrations/20261105140100_agent_offers_contract.sql',import.meta.url),'utf8');
const growthAutonomyContract=await readFile(new URL('../supabase/migrations/20261105150100_growth_autonomy_contract.sql',import.meta.url),'utf8');
const mediaImportContract=await readFile(new URL('../supabase/migrations/20261106220100_learning_media_import_contract.sql',import.meta.url),'utf8');
const selectAllContract=await readFile(new URL('../supabase/migrations/20261107030100_learning_select_all_contract.sql',import.meta.url),'utf8');
const salesExecutiveContract=await readFile(new URL('../supabase/migrations/20261108180100_sales_executive_contract.sql',import.meta.url),'utf8');
const socialContract=await readFile(new URL('../supabase/migrations/20261108190100_social_manager_contract.sql',import.meta.url),'utf8');
const marketingContract=await readFile(new URL('../supabase/migrations/20261108210100_marketing_switches_contract.sql',import.meta.url),'utf8');
const scorecardContract=await readFile(new URL('../supabase/migrations/20261109120100_monday_scorecard_contract.sql',import.meta.url),'utf8');
const publicArticlesContract=await readFile(new URL('../supabase/migrations/20261109130100_public_articles_contract.sql',import.meta.url),'utf8');
const settingsContract=await readFile(new URL('../supabase/migrations/20261109150100_hub_settings_contract.sql',import.meta.url),'utf8');
const creativeContract=await readFile(new URL('../supabase/migrations/20261109200100_creative_director_contract.sql',import.meta.url),'utf8');
const marketingConnectionContracts=await Promise.all([
  ['platform.agents.social-video.v1','20261111031738_social_video_publication_contract.sql'],
  ['platform.agents.app-growth.v1','20261111032205_growth_app_lifecycle_contract.sql'],
  ['platform.agents.visitor-metrics.v1','20261111040100_visitor_metrics_contract.sql'],
  ['platform.social-connections.v1','20261111060001_social_connections_contract.sql'],
  ['platform.agents.growth-roster.v1','20261113170600_growth_roster_contract.sql'],
  ['platform.agents.growth-inbound.v1','20261113171100_growth_inbound_contract.sql'],
  ['platform.agents.growth-reengage.v1','20261113172100_growth_reengage_contract.sql'],
  ['platform.agents.growth-people.v1','20261113180100_growth_people_contract.sql'],
  ['platform.agents.growth-research.v1','20261113190100_growth_research_contract.sql'],
  ['platform.agents.growth-learning.v1','20261113200100_growth_learning_contract.sql'],
  ['platform.agents.creative-data.v1','20261113210100_creative_data_contract.sql'],
  ['platform.agents.founder-posts.v1','20261113220100_founder_posts_contract.sql'],
  ['platform.agents.ads.v1','20261113230100_ads_buildout_contract.sql'],
  ['platform.agents.watchdog.v1','20261113240100_agent_watchdog_contract.sql'],
  ['platform.agents.creative-uploads.v1','20261113250100_creative_uploads_contract.sql'],
  ['platform.agents.growth-soft-bounce.v1','20261113280100_growth_soft_bounce_contract.sql'],
  ['platform.agents.growth-people-finder.v1','20261113290100_growth_people_finder_contract.sql'],
  ['platform.agents.lifecycle-save.v1','20261113300100_lifecycle_save_contract.sql'],
  ['platform.agents.autonomy-handover.v1','20261115200100_autonomy_handover_contract.sql'],
  ['platform.agents.growth-colleagues.v1','20261115230100_growth_colleagues_contract.sql'],
  ['platform.agents.growth-roster-match.v1','20261115233100_growth_roster_match_contract.sql'],
  ['billing.trial-cards.v1','20261116020100_billing_trial_cards_contract.sql'],
  ['platform.agents.growth-address-check.v1','20261116100100_growth_address_check_contract.sql'],
  ['platform.agents.growth-brief.v1','20261116110100_growth_brief_contract.sql'],
  ['platform.agents.growth-report-views.v1','20261116120100_growth_report_views_contract.sql'],
  ['platform.agents.creative-review.v1','20261116130100_creative_review_contract.sql'],
  ['platform.admin.app-commands.v1','20261117110100_app_command_audiences_contract.sql'],
  ['knowledge.publications.direct-storage.v1','20261117130100_publication_import_window_contract.sql'],
  ['learning.lesson-media.direct-storage.v1','20261117140000_lesson_media_direct_storage_contract.sql'],
  ['platform.agents.growth-diagnostics.v1','20261117160100_growth_diagnostics_contract.sql'],
  ['platform.agents.strategist.v1','20261117170100_weekly_strategist_contract.sql'],
  ['platform.agents.work-recovery.v1','20261117180100_work_recovery_contract.sql'],
  ['platform.agents.growth-priority.v1','20261117190100_growth_priority_contract.sql'],
  ['platform.agents.growth-reach.v1','20261117210100_growth_reach_contract.sql'],
  ['platform.agents.trial-path.v1','20261117230100_trial_path_contract.sql'],
  ['platform.agents.growth-address-service.v1','20261117233100_growth_address_service_contract.sql'],
  ['platform.agents.support-truth.v1','20261117240100_support_truth_contract.sql'],
  ['platform.agents.reach.v1','20261117250100_reach_contract.sql'],
  ['platform.agents.owner-summary.v1','20261118120100_owner_summary_contract.sql'],
  ['billing.customer-invitations.v1','20261120120100_customer_invitations_contract.sql'],
  ['platform.agents.first-replies.v1','20261124159000_first_replies_contract.sql'],
  ['platform.agents.first-replies-2.v1','20261125169000_first_replies_two_contract.sql'],
].map(async([feature,file])=>({feature,sql:await readFile(new URL(`../supabase/migrations/${file}`,import.meta.url),'utf8')})));
// The owner's 2026-11-15 hand-over (20261115200000_autonomy_handover.sql) lifted two refusals the founder post and paid ads gates read
// when they were declared: any automatic approval of those kinds, and any autonomy step naming a founder post. Their replays run against
// that earlier state, restored only inside the rolled-back replay below; the hand-over migration (idempotent) is applied again before
// its own gate is replayed.
const handoverMigration=await readFile(new URL('../supabase/migrations/20261115200000_autonomy_handover.sql',import.meta.url),'utf8');
// Applying the hand-over migration again redefines private.growth_person_address without the work recovery's patch (20261117180000), so
// that migration (idempotent too) is applied again before its own gate is replayed.
const workRecoveryMigration=await readFile(new URL('../supabase/migrations/20261117180000_work_recovery.sql',import.meta.url),'utf8');
// The verification service's migration takes 'service' in the address recorder the hand-over replay above restores, so it is replayed
// before its gate, as work recovery's is.
const addressServiceMigration=await readFile(new URL('../supabase/migrations/20261117233000_growth_address_service.sql',import.meta.url),'utf8');
// Applying the work recovery migration again redefines private.agent_watchdog_facts without stage 5's patch (20261117240000), so that
// migration (idempotent too) is applied again before its own gate is replayed.
const supportTruthMigration=await readFile(new URL('../supabase/migrations/20261117240000_support_truth.sql',import.meta.url),'utf8');
const beforeHandover=`delete from private.agent_autonomy_steps where requires_feature='platform.agents.autonomy-handover.v1';
alter table private.agent_actions drop constraint agent_actions_founder_post_check, add constraint agent_actions_founder_post_check check (
  kind <> 'social.founder_post' or coalesce(agent_key = 'social_manager' and target_kind = 'social_item' and target_id ~ '^founder:[0-9]{4}-[0-9]{2}-[0-9]{2}:[1-5]$'
    and status <> 'auto_approved', false));
alter table private.agent_actions drop constraint agent_actions_campaign_check, add constraint agent_actions_campaign_check check (
  kind not in ('social.campaign_create', 'social.google_campaign') or coalesce(agent_key = 'social_manager' and target_kind = 'social_item'
    and target_id ~ '^(meta|linkedin|google):(carebase|caremetric-intel):[0-9]{4}-[0-9]{2}$' and status <> 'auto_approved', false));`;
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
    const deployed=await readContract();
    // Historical replays stop at Creative before these newer gates add their features in migration order.
    const latest={...deployed,features:deployed.features.filter(feature=>!marketingConnectionContracts.some(entry=>entry.feature===feature))};
    // Replay history without the newer workforce features, then replay their reviewed gates last, in order.
    const current={...latest,features:latest.features.filter(feature=>!['platform.agents.v1','platform.agents.probes.v1','platform.agents.brief.v1','platform.agents.seo.v1','platform.agents.concierge.v1','platform.agents.accounts.v1','platform.agents.hardening.v1','support.leads.v1','platform.agents.growth.v1','platform.agents.lifecycle.v1','platform.agents.content.v1','platform.agents.customer-growth.v1','platform.agents.autonomy.v1','platform.agents.external-email.v1','platform.agents.concierge-autosend.v1','platform.agents.content-autopublish.v1','platform.agents.offers.v1','platform.agents.growth-autonomy.v1','learning.media-import.v1','learning.select-all.v1','platform.agents.sales-executive.v1','platform.agents.social.v1','platform.agents.marketing.v1','platform.agents.scorecard.v1','content.public-articles.v1','platform.settings.v1','platform.agents.creative.v1'].includes(feature))};
    const latestBase={...latest,features:latest.features.filter(feature=>!['platform.agents.customer-growth.v1','platform.agents.autonomy.v1','platform.agents.external-email.v1','platform.agents.concierge-autosend.v1','platform.agents.content-autopublish.v1','platform.agents.offers.v1','platform.agents.growth-autonomy.v1','learning.media-import.v1','learning.select-all.v1','platform.agents.sales-executive.v1','platform.agents.social.v1','platform.agents.marketing.v1','platform.agents.scorecard.v1','content.public-articles.v1','platform.settings.v1','platform.agents.creative.v1'].includes(feature))};
    const beforeAutonomy={...latest,features:latest.features.filter(feature=>!['platform.agents.autonomy.v1','platform.agents.external-email.v1','platform.agents.concierge-autosend.v1','platform.agents.content-autopublish.v1','platform.agents.offers.v1','platform.agents.growth-autonomy.v1','learning.media-import.v1','learning.select-all.v1','platform.agents.sales-executive.v1','platform.agents.social.v1','platform.agents.marketing.v1','platform.agents.scorecard.v1','content.public-articles.v1','platform.settings.v1','platform.agents.creative.v1'].includes(feature))};
    const beforeExternalEmail={...latest,features:latest.features.filter(feature=>!['platform.agents.external-email.v1','platform.agents.concierge-autosend.v1','platform.agents.content-autopublish.v1','platform.agents.offers.v1','platform.agents.growth-autonomy.v1','learning.media-import.v1','learning.select-all.v1','platform.agents.sales-executive.v1','platform.agents.social.v1','platform.agents.marketing.v1','platform.agents.scorecard.v1','content.public-articles.v1','platform.settings.v1','platform.agents.creative.v1'].includes(feature))};
    const beforeAnswers={...latest,features:latest.features.filter(feature=>!['platform.agents.concierge-autosend.v1','platform.agents.content-autopublish.v1','platform.agents.offers.v1','platform.agents.growth-autonomy.v1','learning.media-import.v1','learning.select-all.v1','platform.agents.sales-executive.v1','platform.agents.social.v1','platform.agents.marketing.v1','platform.agents.scorecard.v1','content.public-articles.v1','platform.settings.v1','platform.agents.creative.v1'].includes(feature))};
    const beforeAutopublish={...latest,features:latest.features.filter(feature=>!['platform.agents.content-autopublish.v1','platform.agents.offers.v1','platform.agents.growth-autonomy.v1','learning.media-import.v1','learning.select-all.v1','platform.agents.sales-executive.v1','platform.agents.social.v1','platform.agents.marketing.v1','platform.agents.scorecard.v1','content.public-articles.v1','platform.settings.v1','platform.agents.creative.v1'].includes(feature))};
    const beforeOffers={...latest,features:latest.features.filter(feature=>!['platform.agents.offers.v1','platform.agents.growth-autonomy.v1','learning.media-import.v1','learning.select-all.v1','platform.agents.sales-executive.v1','platform.agents.social.v1','platform.agents.marketing.v1','platform.agents.scorecard.v1','content.public-articles.v1','platform.settings.v1','platform.agents.creative.v1'].includes(feature))};
    const beforeGrowthAutonomy={...latest,features:latest.features.filter(feature=>!['platform.agents.growth-autonomy.v1','learning.media-import.v1','learning.select-all.v1','platform.agents.sales-executive.v1','platform.agents.social.v1','platform.agents.marketing.v1','platform.agents.scorecard.v1','content.public-articles.v1','platform.settings.v1','platform.agents.creative.v1'].includes(feature))};
    const beforeMediaImport={...latest,features:latest.features.filter(feature=>!['learning.media-import.v1','learning.select-all.v1','platform.agents.sales-executive.v1','platform.agents.social.v1','platform.agents.marketing.v1','platform.agents.scorecard.v1','content.public-articles.v1','platform.settings.v1','platform.agents.creative.v1'].includes(feature))};
    const beforeSelectAll={...latest,features:latest.features.filter(feature=>!['learning.select-all.v1','platform.agents.sales-executive.v1','platform.agents.social.v1','platform.agents.marketing.v1','platform.agents.scorecard.v1','content.public-articles.v1','platform.settings.v1','platform.agents.creative.v1'].includes(feature))};
    const beforeSalesExecutive={...latest,features:latest.features.filter(feature=>!['platform.agents.sales-executive.v1','platform.agents.social.v1','platform.agents.marketing.v1','platform.agents.scorecard.v1','content.public-articles.v1','platform.settings.v1','platform.agents.creative.v1'].includes(feature))};
    const beforeSocial={...latest,features:latest.features.filter(feature=>!['platform.agents.social.v1','platform.agents.marketing.v1','platform.agents.scorecard.v1','content.public-articles.v1','platform.settings.v1','platform.agents.creative.v1'].includes(feature))};
    const beforeMarketing={...latest,features:latest.features.filter(feature=>!['platform.agents.marketing.v1','platform.agents.scorecard.v1','content.public-articles.v1','platform.settings.v1','platform.agents.creative.v1'].includes(feature))};
    const beforeScorecard={...latest,features:latest.features.filter(feature=>!['platform.agents.scorecard.v1','content.public-articles.v1','platform.settings.v1','platform.agents.creative.v1'].includes(feature))};
    const beforePublicArticles={...latest,features:latest.features.filter(feature=>!['content.public-articles.v1','platform.settings.v1','platform.agents.creative.v1'].includes(feature))};
    const beforeSettings={...latest,features:latest.features.filter(feature=>!['platform.settings.v1','platform.agents.creative.v1'].includes(feature))};
    const beforeCreative={...latest,features:latest.features.filter(feature=>feature!=='platform.agents.creative.v1')};
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
    assert.deepEqual(await readContract(),{...current,features:[...current.features,'platform.agents.v1','platform.agents.probes.v1','platform.agents.brief.v1','platform.agents.seo.v1']},'The SEO analyst declaration adds only its own feature');
    await client.query(conciergeContract);
    assert.deepEqual(await readContract(),{...current,features:[...current.features,'platform.agents.v1','platform.agents.probes.v1','platform.agents.brief.v1','platform.agents.seo.v1','platform.agents.concierge.v1']},'The Support Concierge declaration adds only its own feature');
    await client.query(accountsContract);
    assert.deepEqual(await readContract(),{...current,features:[...current.features,'platform.agents.v1','platform.agents.probes.v1','platform.agents.brief.v1','platform.agents.seo.v1','platform.agents.concierge.v1','platform.agents.accounts.v1']},'The Account Manager declaration adds only its own feature');
    await client.query(hardeningContract);
    assert.deepEqual(await readContract(),{...current,features:[...current.features,'platform.agents.v1','platform.agents.probes.v1','platform.agents.brief.v1','platform.agents.seo.v1','platform.agents.concierge.v1','platform.agents.accounts.v1','platform.agents.hardening.v1']},'The AI team hardening declaration adds only its own feature');
    await client.query(leadDeskContract);
    assert.deepEqual(await readContract(),{...latestBase,features:latestBase.features.filter(feature=>!['platform.agents.growth.v1','platform.agents.lifecycle.v1','platform.agents.content.v1'].includes(feature))},'The lead desk declaration adds only its own feature');
    await client.query(leadDeskContract);
    assert.deepEqual(await readContract(),{...latestBase,features:latestBase.features.filter(feature=>!['platform.agents.growth.v1','platform.agents.lifecycle.v1','platform.agents.content.v1'].includes(feature))},'The lead desk declaration is idempotent');
    await client.query(growthContract);
    assert.deepEqual(await readContract(),{...latestBase,features:latestBase.features.filter(feature=>!['platform.agents.lifecycle.v1','platform.agents.content.v1'].includes(feature))},'The Growth Manager declaration adds only its own feature');
    await client.query(growthContract);
    assert.deepEqual(await readContract(),{...latestBase,features:latestBase.features.filter(feature=>!['platform.agents.lifecycle.v1','platform.agents.content.v1'].includes(feature))},'The Growth Manager declaration is idempotent');
    await client.query(lifecycleContract);
    assert.deepEqual(await readContract(),{...latestBase,features:latestBase.features.filter(feature=>feature!=='platform.agents.content.v1')},'The customer email declaration adds only its own feature');
    await client.query(contentContract);
    assert.deepEqual(await readContract(),latestBase,'The Content Marketer declaration restores the exact current feature set');
    await client.query(customerGrowthContract);
    assert.deepEqual(await readContract(),beforeAutonomy,'The customer growth declaration adds only its own feature');
    await client.query(autonomyContract);
    assert.deepEqual(await readContract(),beforeExternalEmail,'The autonomy steps declaration adds only its reviewed feature');
    await client.query(autonomyContract);
    assert.deepEqual(await readContract(),beforeExternalEmail,'The autonomy steps declaration is idempotent');
    await client.query(externalEmailContract);
    assert.deepEqual(await readContract(),beforeAnswers,'The owner-directed email declaration adds only its reviewed feature');
    await client.query(externalEmailContract);
    assert.deepEqual(await readContract(),beforeAnswers,'The owner-directed email declaration is idempotent');
    await client.query(answersContract);
    assert.deepEqual(await readContract(),beforeAutopublish,'The support answers declaration adds only its own feature');
    await client.query(autopublishContract);
    assert.deepEqual(await readContract(),beforeOffers,'The article publishing declaration adds only its own feature');
    await client.query(offersContract);
    assert.deepEqual(await readContract(),beforeGrowthAutonomy,'The offers declaration adds only its own feature');
    await client.query(offersContract);
    assert.deepEqual(await readContract(),beforeGrowthAutonomy,'The offers declaration is idempotent');
    await client.query(growthAutonomyContract);
    assert.deepEqual(await readContract(),beforeMediaImport,'The sales follow-up and cold email declaration adds only its own feature');
    await client.query(growthAutonomyContract);
    assert.deepEqual(await readContract(),beforeMediaImport,'The sales follow-up and cold email declaration is idempotent');
    await client.query(mediaImportContract);
    assert.deepEqual(await readContract(),beforeSelectAll,'The bulk media import declaration adds only its own feature');
    await client.query(mediaImportContract);
    assert.deepEqual(await readContract(),beforeSelectAll,'The bulk media import declaration is idempotent');
    await client.query(selectAllContract);
    assert.deepEqual(await readContract(),beforeSalesExecutive,'The select-all declaration adds only its own feature');
    await client.query(selectAllContract);
    assert.deepEqual(await readContract(),beforeSalesExecutive,'The select-all declaration is idempotent');
    await client.query(salesExecutiveContract);
    assert.deepEqual(await readContract(),beforeSocial,'The Sales Executive declaration adds only its own feature');
    await client.query(salesExecutiveContract);
    assert.deepEqual(await readContract(),beforeSocial,'The Sales Executive declaration is idempotent');
    await client.query(socialContract);
    assert.deepEqual(await readContract(),beforeMarketing,'The Social Media Manager declaration adds only its own feature');
    await client.query(socialContract);
    assert.deepEqual(await readContract(),beforeMarketing,'The Social Media Manager declaration is idempotent');
    await client.query(marketingContract);
    assert.deepEqual(await readContract(),beforeScorecard,'The marketing switches declaration adds only its own feature');
    await client.query(marketingContract);
    assert.deepEqual(await readContract(),beforeScorecard,'The marketing switches declaration is idempotent');
    await client.query(scorecardContract);
    assert.deepEqual(await readContract(),beforePublicArticles,'The Monday scorecard declaration adds only its own feature');
    await client.query(scorecardContract);
    assert.deepEqual(await readContract(),beforePublicArticles,'The Monday scorecard declaration is idempotent');
    await client.query(publicArticlesContract);
    assert.deepEqual(await readContract(),beforeSettings,'The public article feed declaration adds only its own feature');
    await client.query(publicArticlesContract);
    assert.deepEqual(await readContract(),beforeSettings,'The public article feed declaration is idempotent');
    await client.query(settingsContract);
    assert.deepEqual(await readContract(),beforeCreative,'The Hub settings declaration adds only its own feature');
    await client.query(settingsContract);
    assert.deepEqual(await readContract(),beforeCreative,'The Hub settings declaration is idempotent');
    await client.query(creativeContract);
    assert.deepEqual(await readContract(),latest,'The Creative Director declaration restores its historical feature set');
    await client.query(creativeContract);
    assert.deepEqual(await readContract(),latest,'The Creative Director declaration is idempotent');
    const expected={...latest,features:[...latest.features]};
    for(const entry of marketingConnectionContracts) {
      if(entry.feature==='platform.agents.founder-posts.v1') await client.query(beforeHandover);
      if(entry.feature==='platform.agents.autonomy-handover.v1') await client.query(handoverMigration);
      if(entry.feature==='platform.agents.work-recovery.v1') await client.query(workRecoveryMigration);
      if(entry.feature==='platform.agents.growth-address-service.v1') await client.query(addressServiceMigration);
      if(entry.feature==='platform.agents.support-truth.v1') await client.query(supportTruthMigration);
      expected.features.push(entry.feature);
      await client.query(entry.sql);
      assert.deepEqual(await readContract(),expected,`${entry.feature} adds only its own feature`);
      await client.query(entry.sql);
      assert.deepEqual(await readContract(),expected,`${entry.feature} is idempotent`);
    }
    assert.deepEqual(await readContract(),deployed,'Replaying every reviewed gate restores the deployed contract');
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
    // The structure gate (2026-09-11) bounds the list at 99 features, a sanity bound of its day that production never runs again; it
    // predates every AI team feature (platform.agents.*, declared from 2026-11-02 on), so it is replayed against a contract without them,
    // as it could have seen it (as credit-policy-contract-integration.mjs does). Nothing it checks is left out.
    const current=withPortalFeature(await readContract());
    const before={...current,features:current.features.filter(feature=>!feature.startsWith('platform.agents.'))};
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
