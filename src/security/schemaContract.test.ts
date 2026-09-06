import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const schema = readFileSync(new URL("../../supabase/schema.sql", import.meta.url), "utf8");

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

describe("Support Hub schema contract", () => {
  it.each(exposedTables)("enables RLS on hub.%s", (table) => {
    expect(schema).toContain(`alter table hub.${table} enable row level security;`);
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
    ]) {
      expect(schema).toMatch(new RegExp(`revoke all on function hub\\.${functionName}\\(`));
    }
  });

  it("does not seed fake phone numbers or placeholder email addresses", () => {
    expect(schema).not.toMatch(/555[- )]/);
    expect(schema).not.toMatch(/[a-z]+@(example|caremetricai?)\.com/i);
  });

  it("blocks direct client writes to support and content tables", () => {
    expect(schema).toContain("revoke insert, update, delete on all tables in schema hub from anon, authenticated;");
    expect(schema).not.toMatch(/grant\s+(insert|update|delete)[^;]+to\s+(anon|authenticated)/i);
  });

  it("does not copy full row bodies into the audit trail", () => {
    expect(schema).not.toMatch(/to_jsonb\s*\(\s*(old|new)\s*\)/i);
    expect(schema).toContain("Never store subjects, message bodies, filenames");
  });
});
