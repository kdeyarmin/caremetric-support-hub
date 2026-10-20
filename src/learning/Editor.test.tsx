// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Product } from "../domain";
import type { Draft, DraftDocument } from "./model";

const api = vi.hoisted(() => ({ editorAccess: vi.fn(), drafts: vi.fn(), draft: vi.fn(), mediaList: vi.fn(), save: vi.fn(), publish: vi.fn(), uploadMedia: vi.fn() }));
vi.mock("./api", () => ({ learningApi: api }));
const { CourseEditor } = await import("./Editor");

// Placement eligibility mirrors private.validate_learning_document: the six
// app products below may hold courses; a registered product outside that set
// (slug "advisors") must never be placed, defaulted, or offered as a choice.
const ids = {
  carebase: "10000000-0000-4000-8000-000000000001",
  pennsync: "10000000-0000-4000-8000-000000000002",
  breathe: "10000000-0000-4000-8000-000000000003",
  emr: "10000000-0000-4000-8000-000000000004",
  go: "10000000-0000-4000-8000-000000000005",
  intel: "10000000-0000-4000-8000-000000000006",
  advisors: "10000000-0000-4000-8000-000000000007",
  legacy: "10000000-0000-4000-8000-000000000008",
};
const eligibleIds = [ids.carebase, ids.pennsync, ids.breathe, ids.emr, ids.go, ids.intel];
function product(id: string, slug: string, name: string, status: Product["status"] = "active"): Product {
  return { id, slug, name, description: "", status, color: "#3355ff" };
}
const products: Product[] = [
  product(ids.carebase, "carebase", "CareMetric CareBase"),
  product(ids.pennsync, "pennsync", "PennSync"),
  product(ids.breathe, "breathe", "CareMetric Breathe"),
  product(ids.emr, "caremetric-emr", "CareMetric EMR", "pilot"),
  product(ids.go, "caremetric-go", "CareMetric Go", "pilot"),
  product(ids.intel, "caremetric-intel", "CareMetric Intel", "pilot"),
  product(ids.advisors, "advisors", "CareMetric Healthcare Advisors"),
  product(ids.legacy, "legacy-app", "Legacy App", "retired"),
];
const box = (name: RegExp) => screen.getByRole("checkbox", { name }) as HTMLInputElement;
function renderEditor(path = "/library/courses/new") {
  return render(<MemoryRouter initialEntries={[path]}><Routes><Route path="/library/courses/:itemId" element={<CourseEditor products={products} />} /></Routes></MemoryRouter>);
}
function fillRequired() {
  fireEvent.change(screen.getByLabelText("Course title"), { target: { value: "Home safety basics" } });
  fireEvent.change(screen.getByLabelText("Lesson content"), { target: { value: "Read the lesson before continuing." } });
}
async function saveDraft() {
  fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
  await waitFor(() => expect(api.save).toHaveBeenCalledTimes(1));
  return api.save.mock.calls[0] as [string, DraftDocument, number];
}
beforeEach(() => {
  api.editorAccess.mockResolvedValue(true);
  api.mediaList.mockResolvedValue([]);
  api.save.mockImplementation(async (itemId: string | null, document: DraftDocument) => ({ itemId: itemId ?? "new-item", draftVersion: 1, document, published: false }));
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });

it("starts a new course placed only on the eligible products and disables the rest", async () => {
  renderEditor();
  const advisors = await screen.findByRole("checkbox", { name: /Healthcare Advisors/ }) as HTMLInputElement;
  for (const name of [/CareBase/, /PennSync/, /Breathe/, /EMR/, /CareMetric Go/, /Intel/]) {
    expect(box(name).checked).toBe(true);
    expect(box(name).disabled).toBe(false);
  }
  expect(advisors.checked).toBe(false);
  expect(advisors.disabled).toBe(true);
  expect(screen.getByText(/\(unavailable for courses\)/)).toBeTruthy();
  expect(screen.queryByRole("checkbox", { name: /Legacy/ })).toBeNull();
});

it("saves a new course with exactly the eligible product ids", async () => {
  renderEditor();
  await screen.findByRole("checkbox", { name: /CareBase/ });
  fillRequired();
  const [itemId, document, version] = await saveDraft();
  expect(itemId).toEqual(expect.any(String));
  expect(version).toBe(0);
  expect([...document.productIds].sort()).toEqual([...eligibleIds].sort());
});

it("updates the placement selection when an eligible product is toggled", async () => {
  renderEditor();
  const breathe = await screen.findByRole("checkbox", { name: /Breathe/ }) as HTMLInputElement;
  expect(breathe.checked).toBe(true);
  fireEvent.click(breathe);
  expect(breathe.checked).toBe(false);
  fireEvent.click(breathe);
  expect(breathe.checked).toBe(true);
  fireEvent.click(breathe);
  expect(breathe.checked).toBe(false);
  fillRequired();
  const [, document] = await saveDraft();
  expect(document.productIds).not.toContain(ids.breathe);
  expect(document.productIds).not.toContain(ids.advisors);
  expect([...document.productIds].sort()).toEqual(eligibleIds.filter(id => id !== ids.breathe).sort());
});

it("keeps an ineligible product already on a draft visible, disabled, and saved", async () => {
  const itemId = "20000000-0000-4000-8000-000000000001";
  const existing: Draft = {
    itemId, draftVersion: 3, published: false,
    document: {
      title: "Existing course", summary: "", overview: "", category: "Safety", durationMinutes: 15, accessLevel: "customer",
      productIds: [ids.carebase, ids.advisors],
      units: [{ id: "30000000-0000-4000-8000-000000000001", type: "text", title: "First lesson", body: "Lesson content." }],
    },
  };
  api.draft.mockResolvedValue(existing);
  renderEditor(`/library/courses/${itemId}`);
  const advisors = await screen.findByRole("checkbox", { name: /Healthcare Advisors/ }) as HTMLInputElement;
  expect(advisors.checked).toBe(true);
  expect(advisors.disabled).toBe(true);
  expect(box(/CareBase/).checked).toBe(true);
  expect(box(/CareBase/).disabled).toBe(false);
  fireEvent.change(screen.getByLabelText("Summary"), { target: { value: "Updated summary" } });
  const [savedId, document, version] = await saveDraft();
  expect(savedId).toBe(itemId);
  expect(version).toBe(3);
  expect(document.productIds).toContain(ids.advisors);
  expect(document.productIds).toContain(ids.carebase);
  expect(document.productIds).toHaveLength(2);
});
