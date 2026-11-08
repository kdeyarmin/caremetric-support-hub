// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useNavigate } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import type { Product } from "../domain";
import type { learningApi } from "./api";

const api = vi.hoisted(() => ({ catalog: vi.fn<typeof learningApi.catalog>(async () => []) }));
vi.mock("./api", () => ({ learningApi: api }));
const { LearningCatalog } = await import("./Catalog");

afterEach(() => { cleanup(); api.catalog.mockReset().mockResolvedValue([]); });

function renderCatalog(canAuthor?: boolean) {
  render(<MemoryRouter><LearningCatalog products={[]} legacyContent={[]} {...(canAuthor === undefined ? {} : { canAuthor })} /></MemoryRouter>);
}

it("offers course authoring only to people who can author courses", async () => {
  renderCatalog();
  expect(await screen.findByRole("link", { name: "My learning" })).toBeTruthy();
  expect(screen.queryByRole("link", { name: "Create and manage courses" })).toBeNull();
  cleanup();

  renderCatalog(true);
  expect((await screen.findByRole("link", { name: "Create and manage courses" })).getAttribute("href")).toBe("/library");
});

it("counts courses in words that match the number", async () => {
  renderCatalog();
  expect(await screen.findByText("0 courses")).toBeTruthy();
});

it("recovers a failed catalog load without reporting that there are no matching courses", async () => {
  api.catalog.mockRejectedValueOnce(new Error("Catalog unavailable")).mockResolvedValueOnce([]);
  renderCatalog();
  await screen.findByText("Catalog unavailable");
  expect(screen.queryByText("No courses match your search.")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Retry catalog" }));
  await screen.findByText("No courses match your search.");
  expect(screen.queryByRole("alert")).toBeNull();
});

it("does not retain an unavailable category when switching product libraries", async () => {
  const products: Product[] = [
    { id: "carebase", slug: "carebase", name: "CareBase", description: "", status: "active", color: "#3355ff" },
    { id: "intel", slug: "caremetric-intel", name: "Intel", description: "", status: "active", color: "#3355ff" },
  ];
  api.catalog.mockResolvedValue([
    { itemId: "safety", versionId: "v1", title: "Safety course", summary: "", category: "Safety", durationMinutes: 10, productIds: ["carebase"], unitCount: 1 },
    { itemId: "analysis", versionId: "v2", title: "Analysis course", summary: "", category: "Analysis", durationMinutes: 10, productIds: ["intel"], unitCount: 1 },
  ]);
  function SwitchProduct() { const navigate = useNavigate(); return <button onClick={() => navigate('/learn?product=caremetric-intel')}>Intel library</button>; }
  render(<MemoryRouter initialEntries={['/learn?product=carebase']}><SwitchProduct /><LearningCatalog products={products} legacyContent={[]} /></MemoryRouter>);
  await screen.findByRole("heading", { name: "Safety course" });
  fireEvent.change(screen.getByRole("combobox", { name: "Filter courses by category" }), { target: { value: "Safety" } });
  fireEvent.click(screen.getByRole("button", { name: "Intel library" }));
  expect(screen.getByRole("heading", { name: "Analysis course" })).toBeTruthy();
  expect((screen.getByRole("combobox", { name: "Filter courses by category" }) as HTMLSelectElement).value).toBe("");
});
