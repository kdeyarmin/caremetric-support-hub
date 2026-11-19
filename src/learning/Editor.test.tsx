// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Product } from "../domain";
import type { Draft, DraftDocument } from "./model";

const api = vi.hoisted(() => ({ editorAccess: vi.fn(), drafts: vi.fn(), draft: vi.fn(), mediaList: vi.fn(), save: vi.fn(), publish: vi.fn(), uploadMedia: vi.fn() }));
vi.mock("./api", () => ({ learningApi: api }));
const { CourseEditor, CourseLibrary } = await import("./Editor");

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

it("keeps an ineligible product already on a draft visible and saved unless the author clears it", async () => {
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
  // The server refuses this placement, so the author must be able to clear it (but not add it back).
  expect(advisors.disabled).toBe(false);
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

it("lets an author clear a placement on an app retired since the draft was made, so the draft can be saved again", async () => {
  // Drafts made before CareMetric EMR and Go were retired carry them; the server refuses those placements now.
  const live = products.map(p => p.slug === "caremetric-emr" || p.slug === "caremetric-go" ? { ...p, status: "retired" as const } : p);
  const itemId = "20000000-0000-4000-8000-000000000002";
  api.draft.mockResolvedValue({ itemId, draftVersion: 2, published: false, document: {
    title: "Existing course", summary: "", overview: "", category: "Safety", durationMinutes: 15, accessLevel: "customer",
    productIds: [ids.carebase, ids.emr, ids.go], units: [{ id: "30000000-0000-4000-8000-000000000001", type: "text", title: "First lesson", body: "Lesson content." }],
  } } satisfies Draft);
  render(<MemoryRouter initialEntries={[`/library/courses/${itemId}`]}><Routes><Route path="/library/courses/:itemId" element={<CourseEditor products={live} />} /></Routes></MemoryRouter>);
  const emr = await screen.findByRole("checkbox", { name: /CareMetric EMR/ }) as HTMLInputElement;
  expect([emr.checked, emr.disabled]).toEqual([true, false]);
  fireEvent.click(emr);
  fireEvent.click(box(/CareMetric Go/));
  // Once cleared, a retired app is no longer offered.
  expect(screen.queryByRole("checkbox", { name: /CareMetric EMR|CareMetric Go/ })).toBeNull();
  const [, document] = await saveDraft();
  expect(document.productIds).toEqual([ids.carebase]);
});

it("turns a question into select all that apply and saves its set of correct answers", async () => {
  const itemId = "20000000-0000-4000-8000-000000000001", [first, second, third] = ["30000000-0000-4000-8000-000000000001", "30000000-0000-4000-8000-000000000002", "30000000-0000-4000-8000-000000000003"];
  const question = "40000000-0000-4000-8000-000000000001";
  const draft: Draft = { itemId, draftVersion: 3, published: false, document: { title: "Home safety basics", summary: "", overview: "", category: "Safety", durationMinutes: 20, accessLevel: "customer", productIds: [ids.carebase], units: [
    { id: "50000000-0000-4000-8000-000000000001", type: "text", title: "Lesson", body: "Read the lesson before continuing." },
    { id: "50000000-0000-4000-8000-000000000002", type: "quiz", title: "Post-test", body: "", passingScore: 80, maxAttempts: 3, questions: [{ id: question, prompt: "Which apply?", points: 1, correctOptionId: first,
      options: [{ id: first, text: "Lock wheels" }, { id: second, text: "Clear the path" }, { id: third, text: "Rush the transfer" }] }] },
  ] } };
  api.draft.mockResolvedValue(draft);
  renderEditor(`/library/courses/${itemId}`);
  fireEvent.click(await screen.findByRole("checkbox", { name: /Select all that apply/ }));
  const correct = (n: number) => screen.getByRole("checkbox", { name: `Correct answer: option ${n}` }) as HTMLInputElement;
  expect(correct(1).checked).toBe(true);
  fireEvent.click(correct(2));
  expect([correct(1).checked, correct(2).checked, correct(3).checked]).toEqual([true, true, false]);
  // The last correct answer cannot be cleared.
  fireEvent.click(correct(1)); fireEvent.click(correct(2));
  expect(correct(2).checked).toBe(true);
  fireEvent.click(correct(1));
  fireEvent.click(screen.getByRole("button", { name: "Remove option 3" }));
  const [, document, version] = await saveDraft();
  expect(version).toBe(3);
  const saved = document.units[1];
  expect(saved.type === "quiz" && saved.questions[0]).toEqual({ id: question, prompt: "Which apply?", points: 1, correctOptionIds: [second, first],
    options: [{ id: first, text: "Lock wheels" }, { id: second, text: "Clear the path" }] });
});

it("offers CareMetric PennSync, retired except for courses, as a placement authors can clear", async () => {
  const live = products.map(p => p.slug === "pennsync" ? { ...p, name: "CareMetric PennSync", status: "retired" as const } : p);
  render(<MemoryRouter initialEntries={["/library/courses/new"]}><Routes><Route path="/library/courses/:itemId" element={<CourseEditor products={live} />} /></Routes></MemoryRouter>);
  const pennsync = await screen.findByRole("checkbox", { name: /CareMetric PennSync/ }) as HTMLInputElement;
  expect(pennsync.checked).toBe(true);
  expect(pennsync.disabled).toBe(false);
  expect(screen.queryByRole("checkbox", { name: /Legacy/ })).toBeNull();
  fireEvent.click(pennsync);
  fillRequired();
  const [, document] = await saveDraft();
  expect(document.productIds).not.toContain(ids.pennsync);
  expect([...document.productIds].sort()).toEqual(eligibleIds.filter(id => id !== ids.pennsync).sort());
});

it("links course editors to material imports from Course authoring, and nobody else", async () => {
  api.drafts.mockResolvedValue([]);
  const { unmount } = render(<MemoryRouter><CourseLibrary products={products} /></MemoryRouter>);
  expect((await screen.findByRole("link", { name: "Review material imports" })).getAttribute("href")).toBe("/imports/docstudio");
  expect(screen.getByRole("heading", { name: /Create a course/ })).toBeTruthy();
  unmount();
  api.editorAccess.mockResolvedValue(false);
  render(<MemoryRouter><CourseLibrary products={products} /></MemoryRouter>);
  await waitFor(() => expect(api.editorAccess).toHaveBeenCalledTimes(2));
  expect(screen.queryByRole("link", { name: "Review material imports" })).toBeNull();
  expect(screen.queryByRole("heading", { name: /Create a course/ })).toBeNull();
});

it("asks before a link inside the Hub discards unsaved course edits", async () => {
  render(<MemoryRouter initialEntries={["/library/courses/new"]}><Routes>
    <Route path="/library/courses/:itemId" element={<CourseEditor products={products} />} />
    <Route path="/library" element={<p>Library page</p>} />
  </Routes></MemoryRouter>);
  await screen.findByLabelText("Course title");
  fillRequired();
  const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false);
  fireEvent.click(screen.getByRole("link", { name: "Course library" }));
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(screen.queryByText("Library page")).toBeNull();
  expect((screen.getByLabelText("Course title") as HTMLInputElement).value).toBe("Home safety basics");
  confirm.mockReturnValueOnce(true);
  fireEvent.click(screen.getByRole("link", { name: "Course library" }));
  expect(await screen.findByText("Library page")).toBeTruthy();
});
