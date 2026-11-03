import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { leadEmailPattern, leadSchema } from "./leadsProtocol";

const migration = readFileSync(new URL("../../supabase/migrations/20261103120000_lead_desk.sql", import.meta.url), "utf8");
/** A SQL string literal's text: '' is one quote. */
const sqlText = (literal: string) => literal.replace(/''/g, "'");

describe("lead protocol and the database", () => {
  it("checks an address with exactly the pattern the intake and the table use", () => {
    const intake = migration.match(/v_email !~ '((?:[^']|'')+)'/);
    const table = migration.match(/and contact_email ~ '((?:[^']|'')+)'/);
    expect(intake && sqlText(intake[1])).toBe(leadEmailPattern.source);
    expect(table && sqlText(table[1])).toBe(leadEmailPattern.source);
  });

  it("reports the deepest page hub.list_leads serves, the same ceiling it enforces", () => {
    const list = migration.slice(migration.indexOf("create function hub.list_leads("), migration.indexOf("create function hub.update_lead_status("));
    expect(list).toMatch(/v_max_offset constant integer := 10000;/);
    expect(list).toContain("p_offset > v_max_offset");
    expect(list).toContain("'maxOffset', v_max_offset");
    expect(list).not.toMatch(/p_offset > \d/);
  });

  it("accepts the punctuation real addresses use and nothing that means something in a mailto: link", () => {
    for (const address of ["jordan.rivera@sunrise.example", "o'brien.ops+leads_2026@mail-1.example.co.uk", "a1@b2.io"]) {
      expect(leadEmailPattern.test(address), address).toBe(true);
    }
    for (const address of [
      "jordan@example.org?bcc=other%40example.net", "jordan&co@example.org", "jordan#1@example.org", "jordan%40ops@example.org",
      "jordan/ops@example.org", "jordan\\ops@example.org", "jordan@example.org,other@example.net", "jordan@example.org;other@example.net",
      "jordan=ops@example.org", "jordan@example.org:25", "\"jordan rivera\"@example.org", "Jordan@example.org", "jordan@[192.0.2.1]",
      "jordan..rivera@example.org", ".jordan@example.org", "jordan@localhost", "jordan@example..org", "jordán@example.org",
    ]) {
      expect(leadEmailPattern.test(address), address).toBe(false);
    }
    const lead = leadSchema.shape.contact;
    expect(lead.safeParse({ name: null, email: "jordan@example.org?bcc=x%40y.z", phone: null, organization: null, role: null }).success).toBe(false);
    expect(lead.safeParse({ name: null, email: "jordan@example.org", phone: null, organization: null, role: null }).success).toBe(true);
  });
});
