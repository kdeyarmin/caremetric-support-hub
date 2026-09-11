import { describe, expect, it } from "vitest";
import { parsePortfolioEnvelope, parsePortfolioRequest, portfolioProducts } from "../../supabase/functions/_shared/portfolioProtocol";
import { operationalReadOperations, parseOperationalRead } from "../../supabase/functions/_shared/operationsProtocol";
import { job, release, audit } from "./testFixtures/operations";
import { operationalCount, operationalStatus } from "./operationsPresentation";
const generatedAt = "2026-09-11T12:00:00.000Z";
const page = (item: unknown) => ({ items: [item], limit: 25, offset: 0, total: 1 });
const envelope = (operation: string, data: unknown) => ({ contractVersion: 1, product: "carebase", operation, generatedAt, data });
const parse = (operation: string, data: unknown) => parsePortfolioEnvelope(envelope(operation, data), parsePortfolioRequest({ operation })).data;

describe("operational read boundary", () => {
  it.each(operationalReadOperations)("binds %s to bounded literal search and the CareBase read audience", operation => {
    expect(parsePortfolioRequest({ operation, search: " 100%_worker " })).toEqual({ product: "carebase", operation: { operation, search: "100%_worker", limit: 25, offset: 0 } });
    for (const product of portfolioProducts.filter(value => value !== "carebase")) expect(() => parsePortfolioRequest({ product, operation })).toThrow();
  });
  it.each([{ search: "*" }, { search: "a\nb" }, { search: "x".repeat(101) }, { limit: 0 }, { limit: 51 }, { limit: 1.5 }, { offset: -1 }, { offset: 10001 }, { offset: "20" }, { url: "https://evil.invalid" }, { action: "jobs.retry" }, { session_id: audit.id }])("rejects unreviewed input %j", change => {
    expect(() => parseOperationalRead({ operation: "operations.jobs.list", ...change })).toThrow();
  });
  it("keeps unknown run metadata and unconfigured rollout definitions explicit", () => {
    expect(parse("operations.jobs.list", page(job))).toEqual(page(job));
    expect(parse("operations.releases.list", page(release))).toEqual(page(release));
    expect(parse("operations.audit.list", page(audit))).toEqual(page(audit));
  });
  it("preserves exact bigint strings and zero independently of null", () => {
    const row = { ...job, attemptedCount: "9223372036854775807", succeededCount: "9007199254740993", failedCount: "0" };
    expect(parse("operations.jobs.list", page(row))).toEqual(page(row));
    expect(operationalCount(row.attemptedCount)).toBe("9,223,372,036,854,775,807");
    expect(operationalCount(row.succeededCount)).toBe("9,007,199,254,740,993");
    expect(operationalCount("0")).toBe("0"); expect(operationalCount(null)).toBe("Not reported");
  });
  it.each([9007199254740992, -1, "01", "-1", "1.1", "1e4", "9".repeat(21), undefined])("rejects unsafe or noncanonical counters %j", attemptedCount => expect(() => parse("operations.jobs.list", page({ ...job, attemptedCount }))).toThrow());
  it.each(["starting", "sending", "connecting", "queued", "running"] as const)("classifies native %s as in progress", lastStatus => {
    expect(parse("operations.jobs.list", page({ ...job, lastStatus }))).toEqual(page({ ...job, lastStatus }));
    expect(operationalStatus(lastStatus)).toContain("in progress");
  });
  it.each([{ items: [job, job], total: 2 }, { offset: 20 }, { limit: 50 }, { total: 0 }, { total: -1 }, { total: Number.MAX_SAFE_INTEGER + 1 }, { raw: "private" }])("rejects contradictory or extended pages %j", change => {
    expect(() => parse("operations.jobs.list", { ...page(job), ...change })).toThrow();
  });
  it("rejects extra or missing record fields including private error/audit bodies", () => {
    for (const [operation, row, extra] of [
      ["operations.jobs.list", job, { errorMessage: "secret" }],
      ["operations.releases.list", release, { cohortOrganizationIds: [audit.id] }],
      ["operations.audit.list", audit, { metadata: { clinical: "secret" } }],
    ] as const) {
      expect(() => parse(operation, page({ ...row, ...extra }))).toThrow();
      const incomplete = { ...row } as Record<string, unknown>; delete incomplete[Object.keys(incomplete)[0]];
      expect(() => parse(operation, page(incomplete))).toThrow();
    }
  });
  it.each([{ isEnabled: false }, { owner: "someone" }, { updatedAt: generatedAt }, { expiresAt: generatedAt }, { organizationKillSwitchCount: null }, { rolloutMode: "global" }])("rejects contradictory rollout metadata %j", change => {
    expect(() => parse("operations.releases.list", page({ ...release, ...change }))).toThrow();
  });
  it("rejects invalid dates, subjects, statuses and envelope bindings", () => {
    expect(() => parse("operations.jobs.list", page({ ...job, lastAttemptAt: "yesterday" }))).toThrow();
    expect(() => parse("operations.jobs.list", page({ ...job, lastStatus: "healthy" }))).toThrow();
    expect(() => parse("operations.audit.list", page({ ...audit, actorProfileId: "arbitrary" }))).toThrow();
    expect(() => parse("operations.audit.list", page({ ...audit, createdAt: null }))).toThrow();
    const request = parsePortfolioRequest({ operation: "operations.jobs.list" });
    for (const changed of [{ product: "breathe" }, { operation: "operations.audit.list" }, { contractVersion: 2 }, { generatedAt: null }, { generatedAt: "2026-09-11" }, { raw: "secret" }]) {
      expect(() => parsePortfolioEnvelope({ ...envelope(request.operation.operation, page(job)), ...changed }, request)).toThrow();
    }
  });
  it("does not advertise operational reads for other products", () => {
    for (const product of portfolioProducts) {
      const result = parsePortfolioEnvelope({ ...envelope("capabilities", { apiVersion: 1, operations: [...operationalReadOperations], sourceRevision: null }), product }, parsePortfolioRequest({ product, operation: "capabilities" }));
      expect(result.data).toEqual({ apiVersion: 1, operations: product === "carebase" ? [...operationalReadOperations] : [], sourceRevision: null });
    }
  });
});
