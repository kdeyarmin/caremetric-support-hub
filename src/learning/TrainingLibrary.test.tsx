// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AdminApiError, requestAdmin } from "../admin/transport";
import type { AdminClient } from "../admin/types";
import { TrainingLibrary } from "./TrainingLibrary";
vi.mock("../admin/transport", async () => ({ ...await vi.importActual<object>("../admin/transport"), requestAdmin: vi.fn() }));
const published = "eeeeeeee-0000-0000-0000-000000000001", draft = "eeeeeeee-0000-0000-0000-000000000002";
const first = "eeeeeeee-0000-0000-0000-000000000003", second = "eeeeeeee-0000-0000-0000-000000000004";
const course = (id: string, title: string, status: string) => ({ id, title, status, description: null, category: null, estimatedDurationMinutes: null, updatedAt: "2026-10-22T12:00:00Z" });
const client: AdminClient = { getOverview: vi.fn(), getCourse: vi.fn(),
  listCourses: vi.fn(async () => ({ items: [course(published, "Fire safety", "published"), course(draft, "Draft course", "draft")], total: 2, limit: 50, offset: 0 })) };
const collection = (id: string, title: string) => ({ id, title, description: "", interests: [], jobTitles: [], published: true, courseIds: [published], updatedAt: "2026-10-22T12:00:00Z" });
type Op = { operation: string; section?: string; after?: string | null; requestId?: string; [key: string]: unknown };
const calls = (name: string) => vi.mocked(requestAdmin).mock.calls.map(call => call[1] as Op).filter(op => op.operation === name);
beforeEach(() => { vi.mocked(requestAdmin).mockReset(); });
afterEach(cleanup);
function serve(onSave: (op: Op) => unknown = op => ({ id: (op.collection as { id: string }).id })) {
  vi.mocked(requestAdmin).mockImplementation(async (_name, value) => {
    const op = value as Op;
    if (op.operation !== "catalog.read") return onSave(op);
    if (op.section === "collections") return op.after === null ? { section: "collections", items: [collection(second, "Wound care")], nextAfter: second }
      : { section: "collections", items: [collection(first, "Behavioral health")], nextAfter: null };
    if (op.section === "starterKits") return { section: "starterKits", items: [{ id: first, revision: 3, name: "New PCH hire", description: "", published: true,
      items: [{ courseId: published, isRequired: true }], updatedAt: "2026-10-22T12:00:00Z" }], nextAfter: null };
    return { section: op.section, items: [], nextAfter: null };
  });
}
it("reads every page of a section and lists the records in order", async () => {
  serve(); render(<TrainingLibrary client={client} />);
  await screen.findByText("Behavioral health");
  expect(calls("catalog.read")).toEqual([{ operation: "catalog.read", section: "collections", after: null }, { operation: "catalog.read", section: "collections", after: second }]);
  expect(screen.getAllByRole("listitem").map(item => item.querySelector("strong")!.textContent)).toEqual(["Behavioral health", "Wound care"]);
});
it("saves a new collection of published courses and reuses its request ID on retry", async () => {
  let fail = true;
  serve(op => { if (fail) { fail = false; throw new AdminApiError("upstream"); } return { id: (op.collection as { id: string }).id }; });
  render(<TrainingLibrary client={client} />);
  await screen.findByText("Behavioral health");
  fireEvent.click(screen.getByRole("button", { name: "New collection" }));
  fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Dementia electives" } });
  const picker = screen.getByLabelText("Add a course") as HTMLSelectElement;
  expect([...picker.options].map(option => option.textContent)).toEqual(["Choose a published course", "Fire safety"]);
  fireEvent.change(picker, { target: { value: published } }); fireEvent.click(screen.getByRole("button", { name: "Add course" }));
  fireEvent.click(screen.getByLabelText("Published"));
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByText(/Retry the same save/);
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByText("Saved the collection.");
  const saves = calls("collections.save");
  expect(saves).toHaveLength(2); expect(saves[0]).toEqual(saves[1]);
  expect(saves[0].collection).toMatchObject({ title: "Dementia electives", description: "", interests: [], jobTitles: [], published: true, courseIds: [published] });
});
it("refuses a published collection without courses before calling CareBase", async () => {
  serve(); render(<TrainingLibrary client={client} />);
  await screen.findByText("Behavioral health");
  fireEvent.click(screen.getByRole("button", { name: "New collection" }));
  fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Empty" } });
  fireEvent.click(screen.getByLabelText("Published"));
  expect(screen.getByRole("alert").textContent).toBe("A published collection needs at least one course.");
  expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
});
it("sends the loaded starter kit revision and reloads after a stale-revision conflict", async () => {
  serve(() => { throw new AdminApiError("conflict"); });
  render(<TrainingLibrary client={client} />);
  fireEvent.click(await screen.findByRole("button", { name: "Starter kits" }));
  await screen.findByText("New PCH hire");
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  fireEvent.change(screen.getByLabelText("Description"), { target: { value: "First 30 days" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByText(/The tab was reloaded/);
  expect(calls("starterKits.save")[0].kit).toEqual({ id: first, revision: 3, name: "New PCH hire", description: "First 30 days", items: [{ courseId: published, isRequired: true }], published: true });
  await waitFor(() => expect(calls("catalog.read").filter(op => op.section === "starterKits")).toHaveLength(2));
  expect(screen.queryByRole("form", { name: "Starter kit" })).toBeNull();
});
it("requires the credit statement and its evidence link together", async () => {
  serve(); render(<TrainingLibrary client={client} />);
  fireEvent.click(await screen.findByRole("button", { name: "Discovery metadata" }));
  await screen.findByText("No discovery metadata yet.");
  fireEvent.click(screen.getByRole("button", { name: "Edit a course’s details" }));
  fireEvent.change(screen.getByLabelText("Course"), { target: { value: draft } });
  fireEvent.change(screen.getByLabelText("Credit statement"), { target: { value: "Approved for one hour." } });
  expect(screen.getByRole("alert").textContent).toBe("Enter both the credit statement and its evidence link, or neither.");
  fireEvent.change(screen.getByLabelText("Credit evidence link (https)"), { target: { value: "https://example.org/approval" } });
  expect(screen.queryByRole("alert")).toBeNull();
});
