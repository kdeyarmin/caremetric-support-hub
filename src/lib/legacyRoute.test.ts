import { expect, it } from "vitest";
import { legacyRoute } from "./legacyRoute";

it("preserves local legacy routes, queries, and section links", () => {
  expect(legacyRoute("#/cases?new=1&product=carebase", "https://help.caremetric.ai")).toBe("/cases?new=1&product=carebase");
  expect(legacyRoute("#/help#articles", "https://help.caremetric.ai")).toBe("/help#articles");
  expect(legacyRoute("#section", "https://help.caremetric.ai")).toBeNull();
});

it("rejects cross-origin and malformed legacy routes without throwing", () => {
  for (const hash of ["#//example.invalid", "#/\\example.invalid", "#//[invalid", "#//help.caremetric.ai.evil.invalid", "#//help.caremetric.ai:8443"]) {
    expect(legacyRoute(hash, "https://help.caremetric.ai")).toBeNull();
  }
});
