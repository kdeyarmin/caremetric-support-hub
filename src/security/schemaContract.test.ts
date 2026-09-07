import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const schema = readFileSync(new URL("../../supabase/schema.sql", import.meta.url), "utf8");
const pennTrainCatalogMigration = readFileSync(
  new URL("../../supabase/migrations/20260907143500_import_penntrain_catalog.sql", import.meta.url),
  "utf8",
);
const videoLessonCatalogMigration = readFileSync(
  new URL("../../supabase/migrations/20260907164813_expose_video_lesson_titles.sql", import.meta.url),
  "utf8",
);
const careMetricGoMigration = readFileSync(
  new URL("../../supabase/migrations/20260907172720_register_caremetric_go.sql", import.meta.url),
  "utf8",
);
const careMetricGoSharedCoreMigration = readFileSync(
  new URL("../../supabase/migrations/20260907173139_extend_shared_core_to_caremetric_go.sql", import.meta.url),
  "utf8",
);
const careMetricIntelMigration = readFileSync(
  new URL("../../supabase/migrations/20260907180410_register_caremetric_intel.sql", import.meta.url),
  "utf8",
);
const sharedCourseAlignmentMigration = readFileSync(
  new URL("../../supabase/migrations/20260907182246_align_shared_course_placements.sql", import.meta.url),
  "utf8",
);
const staffMfaMigration = readFileSync(
  new URL("../../supabase/migrations/20260907202818_require_aal2_for_authenticated_support.sql", import.meta.url),
  "utf8",
);

const exposedTables = [
  "products",
  "tenants",
  "profiles",
  "tenant_products",
  "tenant_product_memberships",
  "support_cases",
  "case_participants",
  "case_messages",
  "support_contacts",
  "content_items",
  "content_revisions",
  "content_publications",
  "content_relations",
  "media_assets",
  "course_links",
];

const privateTables = [
  "staff_permissions",
  "case_notes",
  "case_sla",
  "audit_events",
  "federation_issuers",
  "federated_principals",
  "federated_tenants",
  "context_nonces",
];

describe("Support Hub schema contract", () => {
  it.each(exposedTables)("enables RLS on hub.%s", (table) => {
    expect(schema).toContain(`alter table hub.${table} enable row level security;`);
  });

  it.each(privateTables)("enables defense-in-depth RLS on private.%s", (table) => {
    expect(schema).toContain(`alter table private.${table} enable row level security;`);
  });

  it("makes every exposed view security-invoker", () => {
    const views = [...schema.matchAll(/create or replace view hub\.([a-z_]+)/g)].map((match) => match[1]);
    expect(views.length).toBeGreaterThan(0);
    for (const view of views) {
      expect(schema).toMatch(new RegExp(`create or replace view hub\\.${view}\\s+with \\(security_invoker = true\\)`));
    }
  });

  it("keeps internal notes and audit records outside the exposed schema", () => {
    expect(schema).toContain("create table private.case_notes");
    expect(schema).toContain("create table private.audit_events");
    expect(schema).not.toContain("create table hub.case_notes");
    expect(schema).not.toContain("create table hub.audit_events");
  });

  it("revokes public execution on each exposed security-definer RPC", () => {
    for (const functionName of [
      "get_support_actor_context",
      "create_support_case",
      "get_support_case_thread",
      "reply_to_support_case",
      "update_support_case",
      "list_published_content",
    ]) {
      expect(schema).toMatch(new RegExp(`revoke all on function hub\\.${functionName}\\(`));
    }
  });

  it("does not seed fake phone numbers or placeholder email addresses", () => {
    expect(schema).not.toMatch(/555[- )]/);
    expect(schema).not.toMatch(/[a-z]+@(example|caremetricai?)\.com/i);
  });

  it("publishes only the owner-verified central support routes", () => {
    expect(schema).toContain("+18775212890");
    expect(schema).toContain("support@caremetric.ai");
    expect(schema).not.toContain("+18144710627");
    expect(schema).not.toContain("(814) 471-0627");
  });

  it("keeps the completed super-admin bootstrap closed", () => {
    expect(schema).not.toContain("lower(coalesce(new.email, '')) = 'kdeyarmin@comcast.net'");
    expect(schema).not.toContain("create trigger on_auth_user_confirmed");
    expect(schema).not.toContain("values (new.id, null, 'platform.admin', new.id)");
  });

  it("requires AAL2 for staff permissions without locking ordinary customers out", () => {
    expect(staffMfaMigration).toContain("create or replace function private.current_session_is_aal2()");
    expect(staffMfaMigration).toContain("auth.jwt() ->> 'aal'");
    expect(staffMfaMigration).toContain("create or replace function private.is_staff_principal()");
    expect(staffMfaMigration).toContain("create or replace function private.current_principal_requires_aal2()");
    expect(staffMfaMigration).toMatch(/from auth\.mfa_factors factor[\s\S]*?factor\.factor_type = 'totp'[\s\S]*?factor\.status = 'verified'/);
    expect(staffMfaMigration).toMatch(/create or replace function private\.has_staff_permission[\s\S]*?private\.current_session_is_aal2\(\)/);
    expect(staffMfaMigration).toMatch(/create or replace function private\.is_support_staff[\s\S]*?private\.current_session_is_aal2\(\)/);
    expect(staffMfaMigration).toContain("not private.current_principal_requires_aal2() or private.current_session_is_aal2()");
    expect(staffMfaMigration).toContain("revoke all on function private.current_session_is_aal2() from public, anon, authenticated;");
    expect(staffMfaMigration).toContain("revoke all on function private.is_staff_principal() from public, anon, authenticated;");
    expect(staffMfaMigration).toContain("revoke all on function private.current_principal_requires_aal2() from public, anon, authenticated;");

    const actorRole = staffMfaMigration.match(/create or replace function private\.actor_role_label[\s\S]*?\$\$;/)?.[0] ?? "";
    expect(actorRole).not.toContain("current_session_is_aal2");
    for (const permission of [
      "case.read",
      "case.write",
      "content.read",
      "content.write",
      "sla.manage",
      "tenant.manage",
      "audit.read",
      "platform.admin",
    ]) {
      expect(actorRole).toContain(`'${permission}'`);
    }

    const actorContext = staffMfaMigration.match(/create or replace function hub\.get_support_actor_context\(\)[\s\S]*?\$\$;/)?.[0] ?? "";
    expect(actorContext).toContain("v_is_staff := private.is_staff_principal();");
    expect(actorContext).toContain("v_requires_aal2 := private.current_principal_requires_aal2();");
    expect(actorContext).toContain("if not v_requires_aal2 or private.current_session_is_aal2() then");
    expect(actorContext.indexOf("if not v_requires_aal2")).toBeLessThan(actorContext.indexOf("select * into v_membership"));
    expect(actorContext).toMatch(/if v_is_staff then\s+v_role := private\.actor_role_label\(v_user_id, null\);/);
  });

  it("keeps membership RLS non-recursive", () => {
    expect(schema).toContain("private.can_read_membership_row(tenant_id, product_id, user_id)");
    const policy = schema.match(/create policy memberships_self_or_admin_read[\s\S]*?\);/)?.[0] ?? "";
    expect(policy).not.toContain("from hub.tenant_product_memberships");
  });

  it("blocks direct client writes to support and content tables", () => {
    expect(schema).toContain("revoke insert, update, delete on all tables in schema hub from anon, authenticated;");
    expect(schema).not.toMatch(/grant\s+(insert|update|delete)[^;]+to\s+(anon|authenticated)/i);
  });

  it("serves content through the sanitized RPC instead of raw tables", () => {
    expect(schema).toContain("create or replace function hub.list_published_content()");
    expect(schema).toMatch(/revoke select\s+on table[\s\S]*hub\.content_items[\s\S]*hub\.media_assets[\s\S]*hub\.published_content\s+from anon, authenticated;/);
    expect(schema).toContain("private.can_access_content_publication(item_id, revision_id, product_id)");
    expect(schema).toContain("private.has_active_content_audience(publication.product_id, publication.audience)");
  });

  it("exposes only safe learning metadata through the sanitized RPC", () => {
    expect(schema).toContain("content_category text");
    expect(schema).toContain("course_duration_minutes integer");
    expect(schema).toContain("course_video_count integer");
    expect(schema).toContain("course_video_titles text[]");
    expect(schema).not.toContain("course_video_url");
  });

  it("imports the complete non-PHI PennTrain catalog snapshot", () => {
    const courseIds = new Set(
      [...pennTrainCatalogMigration.matchAll(/"launch_path":"\/app\/courses\/([0-9a-f-]{36})"/g)]
        .map((match) => match[1]),
    );
    expect(courseIds.size).toBe(80);
    expect(pennTrainCatalogMigration.match(/"content_key":"penntrain\.help\./g)).toHaveLength(70);
    expect(pennTrainCatalogMigration).not.toContain("video_url");
    expect(pennTrainCatalogMigration).not.toContain("course_progress");
    expect(pennTrainCatalogMigration).not.toContain("support_ticket_messages");
  });

  it("makes current video lessons discoverable without exposing media locators", () => {
    expect(videoLessonCatalogMigration.match(/'penntrain\.course\.[^']+',\n\s+jsonb_build_array/g)).toHaveLength(7);
    expect(videoLessonCatalogMigration).toContain("carebase-video-lessons-2026-09-07");
    expect(videoLessonCatalogMigration).toContain("course_video_titles text[]");
    expect(videoLessonCatalogMigration).not.toContain("video_url");
    expect(videoLessonCatalogMigration).not.toContain("storage_key");
    expect(videoLessonCatalogMigration).not.toContain("renderer_job_id");
  });

  it("registers CareMetric Go and reuses the governed course catalog", () => {
    expect(careMetricGoMigration).toContain("'caremetric-go'");
    expect(careMetricGoMigration).toContain("'CareMetric Go'");
    expect(careMetricGoMigration).toContain("item.kind = 'course'");
    expect(careMetricGoMigration).toContain("item.source_system = 'penntrain'");
    expect(careMetricGoMigration).not.toContain("video_url");
    expect(careMetricGoMigration).not.toContain("patient_id");
    expect(careMetricGoSharedCoreMigration).toContain("'support.protect-patient-information'");
    expect(careMetricGoSharedCoreMigration).toContain("'account.invite-user'");
  });

  it("registers CareMetric Intel without importing its unreviewed product guide", () => {
    expect(careMetricIntelMigration).toContain("'caremetric-intel'");
    expect(careMetricIntelMigration).toContain("item.kind = 'course'");
    expect(careMetricIntelMigration).toContain("'support.protect-patient-information'");
    expect(careMetricIntelMigration).not.toContain("GUIDE_SECTIONS");
    expect(careMetricIntelMigration).not.toContain("provider_id");
  });

  it("aligns the approved onboarding course across every registered product", () => {
    expect(sharedCourseAlignmentMigration).toContain("'course.team-onboarding'");
    for (const slug of [
      "carebase",
      "breathe",
      "pennsync",
      "caremetric-emr",
      "caremetric-go",
      "caremetric-intel",
    ]) {
      expect(sharedCourseAlignmentMigration).toContain(`'${slug}'`);
    }
    expect(sharedCourseAlignmentMigration).not.toContain("learner_id");
    expect(sharedCourseAlignmentMigration).not.toContain("patient_id");
    expect(sharedCourseAlignmentMigration).not.toContain("video_url");
  });

  it("does not copy full row bodies into the audit trail", () => {
    expect(schema).not.toMatch(/to_jsonb\s*\(\s*(old|new)\s*\)/i);
    expect(schema).toContain("Never store subjects, message bodies, filenames");
  });
});
