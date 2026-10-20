import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
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
const advisorsMigration = readFileSync(
  new URL("../../supabase/migrations/20261020120000_advisors_application.sql", import.meta.url),
  "utf8",
);
const knowledgeAuthoringMigration = readFileSync(
  new URL("../../supabase/migrations/20261020120200_advisors_knowledge_authoring.sql", import.meta.url),
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
const caseIntakeSafetyMigration = readFileSync(
  new URL("../../supabase/migrations/20260907222641_gate_case_intake_and_add_idempotency.sql", import.meta.url),
  "utf8",
);
const actorMembershipsMigration = readFileSync(
  new URL("../../supabase/migrations/20260908004000_return_all_actor_memberships.sql", import.meta.url),
  "utf8",
);
const safeAssigneesMigration = readFileSync(
  new URL("../../supabase/migrations/20260908004500_restrict_case_assignees_to_usable_staff.sql", import.meta.url),
  "utf8",
);
const courseCreationAdminMigration = readFileSync(
  new URL("../../supabase/migrations/20261015130000_course_creation_super_admin_only.sql", import.meta.url),
  "utf8",
);
const productionRollout = readFileSync(
  new URL("../../docs/PRODUCTION_ROLLOUT.md", import.meta.url),
  "utf8",
);
const migrationFilenames = readdirSync(new URL("../../supabase/migrations", import.meta.url));

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
  "case_intake_settings",
  "support_request_keys",
  "case_notes",
  "case_sla",
  "audit_events",
  "federation_issuers",
  "federated_principals",
  "federated_tenants",
  "context_nonces",
  "communications",
  "communication_messages",
  "communication_rate_events",
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

  it("reserves course creation and authoring to the platform administrator", () => {
    expect(courseCreationAdminMigration).toContain("create or replace function private.require_learning_editor()");
    expect(courseCreationAdminMigration).toContain("create or replace function hub.get_learning_editor_access()");
    expect(courseCreationAdminMigration).toContain("private.has_staff_permission('platform.admin', null)");
    expect(courseCreationAdminMigration).not.toContain("has_staff_permission('content.write'");
    expect(courseCreationAdminMigration).toContain("'Shared-course editor access required.'");
    // The owner authored the entire existing catalog, so this change must
    // not hide any existing course: it touches no learner read path.
    expect(courseCreationAdminMigration).not.toContain("can_view_content_item");
    expect(courseCreationAdminMigration).not.toContain("list_learning_catalog");
    expect(courseCreationAdminMigration).not.toContain("enroll_learning_course");
    expect(schema).toContain("-- Appended migration: 20261015130000_course_creation_super_admin_only.sql");
  });

  it("keeps case intake disabled until an MFA-ready support route is explicitly activated", () => {
    expect(caseIntakeSafetyMigration).toContain("create table private.case_intake_settings");
    expect(caseIntakeSafetyMigration).toContain("enabled boolean not null default false");
    expect(caseIntakeSafetyMigration).toContain("create or replace function private.is_case_intake_enabled");
    expect(caseIntakeSafetyMigration).toMatch(/permission\.permission in \('case\.write', 'platform\.admin'\)[\s\S]*?from auth\.mfa_factors factor[\s\S]*?factor\.status = 'verified'/);
    expect(caseIntakeSafetyMigration).toContain("staff_user.deleted_at is null");
    expect(caseIntakeSafetyMigration).toContain("staff_user.banned_until is null or staff_user.banned_until <= now()");
    expect(caseIntakeSafetyMigration).toContain("not coalesce(staff_user.is_anonymous, false)");
    expect(caseIntakeSafetyMigration).toContain("from hub.profiles staff_profile");
    expect(caseIntakeSafetyMigration).toContain("if not private.is_case_intake_enabled(p_tenant_id, p_product_id) then");
    expect(caseIntakeSafetyMigration).toContain("revoke all on table private.case_intake_settings from public, anon, authenticated;");
    expect(schema).toContain("alter table private.case_intake_settings enable row level security;");
    expect(schema).toContain("revoke all on function private.is_case_intake_enabled(uuid, uuid) from public, anon, authenticated;");
  });

  it("keeps the applied case-intake migration version aligned with production history", () => {
    expect(migrationFilenames.filter((name) => name.endsWith("gate_case_intake_and_add_idempotency.sql")))
      .toEqual(["20260907222641_gate_case_intake_and_add_idempotency.sql"]);
    expect(productionRollout).toContain("20260907222641_gate_case_intake_and_add_idempotency.sql");
    expect(productionRollout).not.toContain("20260907203511_gate_case_intake_and_add_idempotency.sql");
    expect(Buffer.byteLength(caseIntakeSafetyMigration)).toBe(27_272);
    expect(createHash("sha256").update(caseIntakeSafetyMigration).digest("hex"))
      .toBe("a05602a56317c0b549d65eb39d26f455eb121aee86104bfa040be3ae024a3511");
  });

  it("returns every active actor membership as an exact tenant/product pair", () => {
    for (const source of [actorMembershipsMigration, schema]) {
      const actorContext = source.match(
        /create or replace function hub\.get_support_actor_context\(\)[\s\S]*?\$\$;/,
      )?.[0] ?? "";
      expect(actorContext).toContain("jsonb_agg(");
      expect(actorContext).toContain("'memberships', v_memberships");
      expect(actorContext).toContain("entitlement.product_id = membership.product_id");
      expect(actorContext).toContain("entitlement.status = 'active'");
      expect(actorContext).not.toContain("limit 1");
    }
  });

  it("allows assignment only to usable, provisioned staff principals", () => {
    for (const source of [safeAssigneesMigration, schema]) {
      const updateCase = source.match(
        /create or replace function hub\.update_support_case\([\s\S]*?\$\$;/,
      )?.[0] ?? "";
      expect(updateCase).toContain("join auth.users assignee");
      expect(updateCase).toContain("join hub.profiles assignee_profile");
      expect(updateCase).toContain("assignee.deleted_at is null");
      expect(updateCase).toContain("assignee.banned_until is null or assignee.banned_until <= now()");
      expect(updateCase).toContain("not coalesce(assignee.is_anonymous, false)");
    }
  });

  it("revokes authorization immediately for unusable Auth principals", () => {
    expect(caseIntakeSafetyMigration).toContain("create or replace function private.current_user_is_usable()");
    expect(caseIntakeSafetyMigration).toContain("app_user.deleted_at is null");
    expect(caseIntakeSafetyMigration).toContain("app_user.banned_until is null or app_user.banned_until <= now()");
    expect(caseIntakeSafetyMigration).toContain("not coalesce(app_user.is_anonymous, false)");
    expect(caseIntakeSafetyMigration).toMatch(/create or replace function private\.current_session_is_aal2\(\)[\s\S]*?private\.current_user_is_usable\(\)/);
    expect(caseIntakeSafetyMigration).toMatch(/create or replace function private\.is_staff_principal\(\)[\s\S]*?private\.current_user_is_usable\(\)/);
    expect(caseIntakeSafetyMigration).toMatch(/create or replace function private\.current_principal_requires_aal2\(\)[\s\S]*?not private\.current_user_is_usable\(\)/);
    expect(caseIntakeSafetyMigration).toContain("revoke all on function private.current_user_is_usable() from public, anon, authenticated;");
    expect(caseIntakeSafetyMigration).toMatch(/create or replace function hub\.get_support_actor_context\(\)[\s\S]*?v_user_id is null or not private\.current_user_is_usable\(\)/);
  });

  it("makes case creation and replies idempotent without removing legacy RPC signatures", () => {
    expect(caseIntakeSafetyMigration).toContain("create table private.support_request_keys");
    expect(caseIntakeSafetyMigration).toContain("primary key (actor_id, operation, request_key)");
    expect(caseIntakeSafetyMigration).toContain("request_hash text not null");
    const requestLedger = caseIntakeSafetyMigration.match(
      /create table private\.support_request_keys[\s\S]*?\n\);/,
    )?.[0] ?? "";
    expect(requestLedger).not.toMatch(/(subject|body)\s+text/i);
    expect(caseIntakeSafetyMigration).toContain("create unique index if not exists case_messages_client_message_id_idx");
    expect(caseIntakeSafetyMigration).toContain("where client_message_id is not null");
    expect(schema).toContain("p_request_key uuid");
    expect(schema).toContain("hub.create_support_case(uuid, uuid, text, hub.case_category, hub.case_priority, text, text, text, boolean, uuid)");
    expect(schema).toContain("hub.create_support_case(uuid, uuid, text, hub.case_category, hub.case_priority, text, text, text, boolean)");
    expect(schema).toContain("hub.reply_to_support_case(uuid, text, text, uuid)");
    expect(schema).toContain("hub.reply_to_support_case(uuid, text, text)");

    const createFunctions = [
      ...caseIntakeSafetyMigration.matchAll(
        /create or replace function hub\.create_support_case\([\s\S]*?\n\$\$;/g,
      ),
    ].map((match) => match[0]);
    const keyedCreate = createFunctions.find((definition) => definition.includes("p_request_key uuid")) ?? "";
    const legacyCreate = createFunctions.find((definition) => !definition.includes("p_request_key uuid")) ?? "";
    expect(keyedCreate).toContain("if p_request_key is null then");
    expect(keyedCreate).toMatch(/A request key is required\.[\s\S]*?errcode = '22023'/);
    expect(keyedCreate).toContain("if p_contains_phi is distinct from false then");
    expect(keyedCreate.indexOf("if v_inserted = 0 then")).toBeLessThan(
      keyedCreate.indexOf("if not private.is_case_intake_enabled(p_tenant_id, p_product_id) then"),
    );
    expect(keyedCreate).toMatch(/select case[\s\S]*?membership\.role = 'tenant_admin'[\s\S]*?else 'customer'/);
    expect(keyedCreate.indexOf("membership.role = 'tenant_admin'")).toBeLessThan(
      keyedCreate.indexOf("insert into hub.case_messages"),
    );
    expect(legacyCreate).toContain("coalesce(p_contains_phi, false)");
    expect(legacyCreate).toContain("gen_random_uuid()");
    expect(legacyCreate).not.toContain("null::uuid");

    const replyFunctions = [
      ...caseIntakeSafetyMigration.matchAll(
        /create or replace function hub\.reply_to_support_case\([\s\S]*?\n\$\$;/g,
      ),
    ].map((match) => match[0]);
    const keyedReply = replyFunctions.find((definition) => definition.includes("p_request_key uuid")) ?? "";
    const legacyReply = replyFunctions.find((definition) => !definition.includes("p_request_key uuid")) ?? "";
    expect(keyedReply).toContain("if p_request_key is null then");
    expect(keyedReply).toMatch(/A request key is required\.[\s\S]*?errcode = '22023'/);
    expect(keyedReply).toContain("if p_visibility is null or p_visibility not in ('customer', 'internal') then");
    expect(keyedReply).toContain("if p_visibility = 'internal' and not v_is_staff then");
    expect(keyedReply).toContain("v_can_reply_as_member boolean");
    expect(keyedReply).toContain("membership.case_scope = 'tenant'");
    expect(keyedReply).toContain("and not (v_is_staff or v_can_reply_as_member) then");
    expect(keyedReply).toMatch(/if v_is_staff then\s+v_role := private\.actor_role_label[\s\S]*?else[\s\S]*?membership\.role = 'tenant_admin'[\s\S]*?else 'customer'/);
    expect(legacyReply).toContain("gen_random_uuid()");
    expect(legacyReply).not.toContain("null::uuid");
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

  it("registers Healthcare Advisors with its published FAQ and no client or course data", () => {
    expect(advisorsMigration).toContain("'advisors'");
    expect(advisorsMigration).toContain("advisors@37afa7a884dc70f52d1134a7a27927ffee847373:site-content.mjs#faqs");
    expect(advisorsMigration).toContain("'support.protect-patient-information'");
    expect(advisorsMigration).not.toContain("item.kind = 'course'");
    expect(advisorsMigration).not.toContain("'account.invite-user'");
    for (const field of ["form_digest", "inquiries.sqlite", '"email":', '"phone":', '"notes":']) expect(advisorsMigration).not.toContain(field);
    expect(schema).toContain(advisorsMigration.trim());
  });

  it("lets articles reach all seven applications without loosening other publication checks", () => {
    expect(knowledgeAuthoringMigration).toContain("jsonb_array_length(p_manifest->'placements')>7");
    expect(knowledgeAuthoringMigration).toContain("jsonb_array_length(p_body->'products') not between 1 and 7");
    expect(knowledgeAuthoringMigration).toContain("coalesce(p_manifest#>>'{governance,phi_review}','')<>'passed'");
    expect(knowledgeAuthoringMigration).not.toMatch(/grant |security invoker/i);
    expect(schema).toContain(knowledgeAuthoringMigration.trim());
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
