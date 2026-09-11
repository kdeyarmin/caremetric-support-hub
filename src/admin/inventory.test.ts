import { describe, expect, it } from "vitest";
import { adminInventory, adminInventoryProducts, filterAdminInventory, parseAdminInventory } from "./inventory";

const revision = "a".repeat(40);
const header = '"Product","Repository","SourceRevision","SurfaceType","Surface","SourceFile","SourceLine","HubAvailability","SourceURL"';
const row = `"Example","example","${revision}","Source route","/admin","src/App.tsx","1","App-owned","https://github.com/kdeyarmin/example/blob/${revision}/src/App.tsx#L1"`;

describe("administration source inventory", () => {
  it("loads the source-linked inventory for every audited app", () => {
    expect(adminInventory).toHaveLength(97);
    expect(adminInventoryProducts).toHaveLength(9);
    expect(adminInventory.every((item) => item.sourceUrl.startsWith("https://github.com/kdeyarmin/"))).toBe(true);
  });

  it("handles BOM, CRLF, commas and escaped quotes without changing fields", () => {
    const csv = `\uFEFF${header}\r\n${row.replace('"/admin"', '"Users, including ""operators"""')}\r\n`;
    expect(parseAdminInventory(csv)[0].surface).toBe('Users, including "operators"');
  });

  it("rejects malformed CSV rather than silently losing surfaces", () => {
    expect(() => parseAdminInventory(`${header}\n${row.slice(0, -1)}`)).toThrow("incomplete quoted field");
    expect(() => parseAdminInventory(`"Product"\n${row}`)).toThrow("columns");
    expect(() => parseAdminInventory(`${header}\n${row},"extra"`)).toThrow("incomplete row");
  });

  it("rejects untrusted or mismatched source links", () => {
    expect(() => parseAdminInventory(`${header}\n${row.replace("https://github.com", "https://example.com")}`)).toThrow("source link");
    expect(() => parseAdminInventory(`${header}\n${row.replace('"1"', '"0"')}`)).toThrow("source reference");
  });

  it("combines search terms and an app filter", () => {
    const results = filterAdminInventory(adminInventory, "  BILLING platform ", "Breathe");
    expect(results.map((item) => item.surface)).toEqual(["/platform/billing"]);
    expect(filterAdminInventory(adminInventory, "billing", "CareBase")).toEqual([]);
    expect(filterAdminInventory(adminInventory, "")).toHaveLength(97);
  });
});
