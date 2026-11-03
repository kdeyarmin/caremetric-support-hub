begin;
select plan(9);

select ok(not p.prosecdef, 'Public release metadata uses invoker privileges')
from pg_proc p where p.oid = 'hub.get_backend_contract()'::regprocedure;

set local role anon;
select is(hub.get_backend_contract(), '{"api_version":4,"features":["learning.runtime.v1","platform.admin.read.v1","app.sms.v1","learning.sources.v1","platform.admin.command.v1","learning.receipts.v1","learning.authoring.v1","knowledge.publications.v1","support.readiness.v1","platform.admin.intel.v1","learning.draft-editing.v1","support.customer-onboarding.v1","learning.structure.v1", "support.customer-registration.v1","learning.course-creation.v1","learning.credit-policy.v1","learning.distribution.v1","learning.pennsync-source.v1","learning.media.v1","phone.registry.v1","phone.accounts.v1","learning.sequence.v1","support.ai-assistance.v1","support.ai-automation.v1","support.go-live-readiness.v1","support.ai-automation-server.v1","platform.admin.advisors.v1","support.ai-automation-failure-policy.v1","support.communications.v1","support.ai-usage.v1","support.bulk-email.v1","learning.catalog-authoring.v1","billing.platform.v1","customer.self-service.v1","support.manual-escalation.v1","support.customer-diagnostics.v1","billing.customer-checkout.v1","billing.facility-entitlements.v1","platform.agents.v1","platform.agents.probes.v1","platform.agents.brief.v1","platform.agents.seo.v1","platform.agents.concierge.v1","platform.agents.accounts.v1","platform.agents.hardening.v1","support.leads.v1"]}'::jsonb, 'Anonymous callers see only the reviewed release features');
reset role;

set local role authenticated;
select is(hub.get_backend_contract(), '{"api_version":4,"features":["learning.runtime.v1","platform.admin.read.v1","app.sms.v1","learning.sources.v1","platform.admin.command.v1","learning.receipts.v1","learning.authoring.v1","knowledge.publications.v1","support.readiness.v1","platform.admin.intel.v1","learning.draft-editing.v1","support.customer-onboarding.v1","learning.structure.v1", "support.customer-registration.v1","learning.course-creation.v1","learning.credit-policy.v1","learning.distribution.v1","learning.pennsync-source.v1","learning.media.v1","phone.registry.v1","phone.accounts.v1","learning.sequence.v1","support.ai-assistance.v1","support.ai-automation.v1","support.go-live-readiness.v1","support.ai-automation-server.v1","platform.admin.advisors.v1","support.ai-automation-failure-policy.v1","support.communications.v1","support.ai-usage.v1","support.bulk-email.v1","learning.catalog-authoring.v1","billing.platform.v1","customer.self-service.v1","support.manual-escalation.v1","support.customer-diagnostics.v1","billing.customer-checkout.v1","billing.facility-entitlements.v1","platform.agents.v1","platform.agents.probes.v1","platform.agents.brief.v1","platform.agents.seo.v1","platform.agents.concierge.v1","platform.agents.accounts.v1","platform.agents.hardening.v1","support.leads.v1"]}'::jsonb, 'Authenticated callers see the same release metadata');
select throws_ok('select hub.get_support_actor_context()', '28000', 'Authentication required', 'Release metadata never grants actor access');
reset role;

select ok(to_regclass('private.learning_authoring_intents') is not null
  and to_regprocedure('hub.remember_learning_authoring_preview(uuid,jsonb)') is not null
  and to_regprocedure('hub.get_learning_authoring_intent(uuid,text)') is not null
  and to_regprocedure('hub.record_learning_authoring_result(uuid,text,jsonb)') is not null,
  'Declared authoring has all guarded intent endpoints');

select ok(to_regclass('private.publication_imports') is not null
  and to_regclass('private.publication_import_assets') is not null
  and to_regclass('private.publication_revision_provenance') is not null
  and to_regclass('private.publication_public_downloads') is not null
  and to_regclass('private.publication_cleanup_tokens') is not null
  and to_regprocedure('private.stage_publication_import(uuid,jsonb)') is not null
  and to_regprocedure('private.commit_publication_import(uuid,jsonb)') is not null
  and to_regprocedure('private.issue_publication_public_download(text,uuid,text,text)') is not null
  and to_regprocedure('private.consume_publication_public_download(text)') is not null
  and to_regprocedure('private.consume_publication_cleanup(text)') is not null,
  'Declared publications have staging, commit, public delivery and cleanup boundaries');

select ok(to_regclass('private.case_intake_settings') is not null
  and to_regprocedure('hub.get_support_readiness()') is not null
  and to_regprocedure('hub.list_support_intake_tenants(uuid,integer,integer)') is not null
  and to_regprocedure('hub.set_support_intake(uuid,uuid,boolean,boolean,timestamp with time zone)') is not null,
  'Declared support readiness has current reads and the reviewed setting endpoint');

select ok(to_regprocedure('hub.authorize_app_admin()') is not null
  and to_regprocedure('private.current_app_session_verified()') is not null
  and exists(select 1 from pg_catalog.pg_constraint c
    where c.conrelid='private.app_delegations'::regclass
      and c.conname='app_delegations_audience_check' and c.contype='c' and c.convalidated
      and position('''intel''::text' in pg_catalog.pg_get_expr(c.conbin,c.conrelid))>0),
  'Declared Intel reads have a validated native audience and current SMS authority');

select ok(private.learning_authoring_actions() @> array['learning.patchDraft','learning.reviewDraft']::text[]
  and not has_function_privilege('authenticated','private.learning_authoring_actions()','execute'),
  'Draft edits have a closed private action boundary');

select * from finish();
rollback;
