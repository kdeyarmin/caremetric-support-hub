import { describe, expect, it } from "vitest";
import { reconcileCaseSelection } from "./caseListState";

const rows = [{ id: "case-a" }, { id: "case-b" }];

describe("case-list selection reconciliation", () => {
  it("preserves the user's current selection during a background refresh", () => {
    expect(reconcileCaseSelection(rows, "case-b")).toBe("case-b");
  });

  it("forces only a returned preferred case and otherwise falls back safely", () => {
    expect(reconcileCaseSelection(rows, "case-a", "case-b")).toBe("case-b");
    expect(reconcileCaseSelection(rows, "case-a", "missing")).toBe("case-a");
    expect(reconcileCaseSelection(rows, "missing", "also-missing")).toBe("case-a");
    expect(reconcileCaseSelection([], "case-a", "case-b")).toBeNull();
  });
});
