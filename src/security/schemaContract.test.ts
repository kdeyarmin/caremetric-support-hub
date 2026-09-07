import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const schema = readFileSync(new URL("../../supabase/schema.sql", import.meta.url), "utf8");
const pennTrainCatalogMigration = readFileSync(
  new URL("../../supabase/migrations/20260907143500_import_penntrain_catalog.sql", import.meta.url),
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

  it("does not copy full row bodies into the audit trail", () => {
    expect(schema).not.toMatch(/to_jsonb\s*\(\s*(old|new)\s*\)/i);
    expect(schema).toContain("Never store subjects, message bodies, filenames");
  });
});
