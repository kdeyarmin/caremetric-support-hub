-- The owner retired DocStudio; PR #85 removed its application runtime.
-- Keep the shared publication-import tables, functions, manifest source_system
-- compatibility and publication-media transport intact.
set local lock_timeout = '10s';
drop trigger if exists docstudio_publication_guard on private.publication_imports;
drop trigger if exists docstudio_approval_immutable on private.docstudio_approvals;
drop trigger if exists docstudio_revision_immutable on private.docstudio_revisions;
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private' and p.proname like 'docstudio\_%'
  loop
    execute format('drop function %s', r.sig);
  end loop;
end
$$;
drop table
  private.docstudio_media_tokens, private.docstudio_cleanup_queue, private.docstudio_outputs,
  private.docstudio_jobs, private.docstudio_exports, private.docstudio_approvals,
  private.docstudio_revisions, private.docstudio_assets, private.docstudio_intents,
  private.docstudio_workers, private.docstudio_projects;

-- Complete API 4 contract through 20261022120100_learning_catalog_authoring_contract.sql,
-- preserving every feature and its order except knowledge.docstudio.v1.
create or replace function hub.get_backend_contract() returns jsonb
language sql stable security invoker set search_path = '' as $$
  select '{
  "api_version": 4,
  "features": [
    "learning.runtime.v1",
    "platform.admin.read.v1",
    "app.sms.v1",
    "learning.sources.v1",
    "platform.admin.command.v1",
    "learning.receipts.v1",
    "learning.authoring.v1",
    "knowledge.publications.v1",
    "support.readiness.v1",
    "platform.admin.intel.v1",
    "learning.draft-editing.v1",
    "billing.portal.v1",
    "support.customer-onboarding.v1",
    "learning.structure.v1",
    "support.customer-registration.v1",
    "billing.checkout.v1",
    "learning.course-creation.v1",
    "learning.credit-policy.v1",
    "learning.distribution.v1",
    "learning.pennsync-source.v1",
    "learning.media.v1",
    "phone.registry.v1",
    "phone.accounts.v1",
    "learning.sequence.v1",
    "support.ai-assistance.v1",
    "support.ai-automation.v1",
    "support.go-live-readiness.v1",
    "support.ai-automation-server.v1",
    "platform.admin.advisors.v1",
    "support.ai-automation-failure-policy.v1",
    "support.communications.v1",
    "support.ai-usage.v1",
    "platform.admin.tenants.v1",
    "support.bulk-email.v1",
    "learning.catalog-authoring.v1"
  ]
}'::jsonb;
$$;
