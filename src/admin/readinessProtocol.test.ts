import { describe, expect, it } from "vitest";
import { parseReadinessReport } from "./readinessProtocol";

const report = {
  checkedAt: "2026-10-17T20:00:00.000Z",
  migrations: {
    complete: false,
    items: [
      { version: "20261015120000", name: "AI case assistance", applied: true },
      { version: "20261015120100", name: "AI case assistance contract", applied: false },
    ],
  },
  anthropicKey: { present: false },
  aiAutomation: { enabled: false },
  helpDomain: { hostname: "help.caremetric.ai", resolves: false, targets: [] },
};

describe("go-live readiness protocol", () => {
  it("accepts a well-formed report", () => {
    expect(parseReadinessReport(report)).toEqual(report);
  });

  it("accepts a fully complete report", () => {
    const complete = {
      ...report,
      migrations: { complete: true, items: report.migrations.items.map(item => ({ ...item, applied: true })) },
      anthropicKey: { present: true },
      aiAutomation: { enabled: true },
      helpDomain: { hostname: "help.caremetric.ai", resolves: true, targets: ["support-hub-web-production.up.railway.app"] },
    };
    expect(parseReadinessReport(complete)).toEqual(complete);
  });

  it("rejects a migrations summary that disagrees with its items", () => {
    expect(() => parseReadinessReport({ ...report, migrations: { ...report.migrations, complete: true } })).toThrow(/mismatch/);
  });

  it("rejects a key section carrying anything beyond presence", () => {
    expect(() => parseReadinessReport({ ...report, anthropicKey: { present: true, value: "sk-ant-anything" } })).toThrow(/mismatch/);
    expect(() => parseReadinessReport({ ...report, anthropicKey: { present: true, prefix: "sk-ant" } })).toThrow(/mismatch/);
  });

  it("rejects a domain section whose resolution disagrees with its targets", () => {
    expect(() => parseReadinessReport({ ...report, helpDomain: { hostname: "help.caremetric.ai", resolves: true, targets: [] } })).toThrow(/mismatch/);
    expect(() => parseReadinessReport({ ...report, helpDomain: { hostname: "help.caremetric.ai", resolves: false, targets: ["203.0.113.1"] } })).toThrow(/mismatch/);
  });

  it("rejects malformed payloads", () => {
    expect(() => parseReadinessReport(null)).toThrow(/mismatch/);
    expect(() => parseReadinessReport({ ...report, checkedAt: "not-a-date" })).toThrow(/mismatch/);
    expect(() => parseReadinessReport({ ...report, aiAutomation: { enabled: "true" } })).toThrow(/mismatch/);
    expect(() => parseReadinessReport({ ...report, migrations: { complete: false, items: [] } })).toThrow(/mismatch/);
  });
});
