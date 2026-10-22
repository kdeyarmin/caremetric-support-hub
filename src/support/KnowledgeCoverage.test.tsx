// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { KnowledgeCoverage } from "./KnowledgeCoverage";
import { knowledgeCoverage } from "./knowledgeCoverage";
import { resolveProductSlug, type ContentItem, type Product } from "../domain";

afterEach(cleanup);
const product = (id: string, slug: string, name: string, status: Product["status"] = "active"): Product => ({ id, slug, name, description: "", status, color: "#0a7a70" });
const products = [product("p-carebase", "carebase", "CareBase"), product("p-advisors", "advisors", "Healthcare Advisors"), product("p-old", "old", "Retired app", "retired")];
const article = (id: string, productIds: string[], change: Partial<ContentItem> = {}): ContentItem => ({
  id, contentKey: id, kind: "article", title: id, summary: "", body: null, status: "published", accessLevel: "public", productIds, audience: ["all"],
  locale: "en-US", revision: 1, sourceSystem: "support_hub", routePattern: null, ...change,
});
const content = [article("shared", ["p-carebase", "p-advisors"]), article("carebase-only", ["p-carebase"]), article("draft", ["p-advisors"], { status: "draft" }), article("course", ["p-advisors"], { kind: "course" })];

describe("knowledge coverage", () => {
  it("counts only published articles and separates app-specific from shared guidance", () => {
    expect(knowledgeCoverage(products, content).map(({ product: { slug }, ...counts }) => ({ slug, ...counts }))).toEqual([
      { slug: "carebase", published: 2, appSpecific: 1, shared: 1 },
      { slug: "advisors", published: 1, appSpecific: 0, shared: 1 },
    ]);
  });
  it("flags applications without their own articles and filters on click", () => {
    const onSelect = vi.fn();
    render(<MemoryRouter><KnowledgeCoverage products={products} content={content} selectedProductId="all" onSelect={onSelect} /></MemoryRouter>);
    expect(screen.getAllByText("Needs app-specific articles")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: /Healthcare Advisors/ }));
    expect(onSelect).toHaveBeenCalledWith("p-advisors");
    expect(screen.queryByRole("link", { name: /Write an article/ })).toBeNull();
    expect(screen.queryByText("Retired app")).toBeNull();
  });
  it("accepts the repository names the owner uses for each application", () => {
    expect(["PennFit", "penntrain", "CareMetric-Pennsync", "intel", "healthcare-advisors", " Breathe "].map(resolveProductSlug))
      .toEqual(["breathe", "carebase", "pennsync", "caremetric-intel", "advisors", "breathe"]);
    expect(resolveProductSlug(null)).toBe("");
  });
});
