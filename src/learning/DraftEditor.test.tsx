// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DraftEditor } from "./DraftEditor";
import fixture from "../imports/fixtures/governedCourse.json";
import { validateGovernedCourse } from "../imports/governedLearningImport";
afterEach(cleanup);
function setup(aiGenerated = true, body: unknown = { content: "Existing lesson", estimated_minutes: 2, retained: "native metadata" }) {
  const material = validateGovernedCourse({ ...fixture, sourceVersionState: "draft", version: { ...fixture.version, aiGenerated },
    blocks: [{ ...fixture.blocks[0], type: "text", title: "Lesson", body }] });
  const callbacks = { onPreview: vi.fn(), onReview: vi.fn(), onChange: vi.fn(), onPublish: vi.fn() };
  render(<DraftEditor material={material} busy={false} reasonReady publishReady {...callbacks} />);
  return { ...callbacks, material };
}
it("previews only edited fields and prevents approval or publication with unsaved material", () => {
  const f = setup();
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.change(screen.getByLabelText("Lesson text"), { target: { value: "Updated lesson\nwith detail" } });
  expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
  expect((screen.getByRole("button", { name: "Preview content approval" }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "Preview publication" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Preview draft edits" }));
  expect(f.onPreview).toHaveBeenCalledExactlyOnceWith({ blocks: [{ blockId: f.material.blocks[0].id, content: "Updated lesson\nwith detail" }] });
  expect(f.material.blocks[0].body).toEqual({ content: "Existing lesson", estimated_minutes: 2, retained: "native metadata" });
  fireEvent.change(screen.getByLabelText("Lesson text"), { target: { value: "Existing lesson" } });
  expect((screen.getByRole("button", { name: "Preview draft edits" }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "Preview content approval" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Preview content approval" }));
  expect(f.onReview).toHaveBeenCalledTimes(1);
});
it("reads native duration without changing the field name in the command contract", () => {
  const f = setup();
  expect((screen.getByLabelText("Estimated minutes") as HTMLInputElement).value).toBe("2");
  fireEvent.change(screen.getByLabelText("Estimated minutes"), { target: { value: "5" } });
  fireEvent.click(screen.getByRole("button", { name: "Preview draft edits" }));
  expect(f.onPreview).toHaveBeenCalledExactlyOnceWith({ blocks: [{ blockId: f.material.blocks[0].id, estimatedMinutes: 5 }] });
  fireEvent.change(screen.getByLabelText("Estimated minutes"), { target: { value: "2" } });
  expect((screen.getByRole("button", { name: "Preview draft edits" }) as HTMLButtonElement).disabled).toBe(true);
});
it("allows new content for an empty native body", () => {
  const f = setup(true, null);
  fireEvent.change(screen.getByLabelText("Estimated minutes"), { target: { value: "5" } });
  fireEvent.change(screen.getByLabelText("Estimated minutes"), { target: { value: "" } });
  expect(screen.queryByRole("alert")).toBeNull();
  fireEvent.change(screen.getByLabelText("Lesson text"), { target: { value: "New lesson" } });
  fireEvent.click(screen.getByRole("button", { name: "Preview draft edits" }));
  expect(f.onPreview).toHaveBeenCalledExactlyOnceWith({ blocks: [{ blockId: f.material.blocks[0].id, content: "New lesson" }] });
});
it.each([{ content: { html: "Saved rich content" }, estimated_minutes: "5" }, ["Legacy body"]])("preserves legacy fields while allowing a title-only edit", body => {
  const f = setup(true, body);
  expect(screen.queryByLabelText("Lesson text")).toBeNull();
  expect(screen.queryByLabelText("Estimated minutes")).toBeNull();
  fireEvent.change(screen.getByLabelText("Lesson title"), { target: { value: "Revised title" } });
  fireEvent.click(screen.getByRole("button", { name: "Preview draft edits" }));
  expect(f.onPreview).toHaveBeenCalledExactlyOnceWith({ blocks: [{ blockId: f.material.blocks[0].id, title: "Revised title" }] });
  expect(f.material.blocks[0].body).toEqual(body);
});
it("retains native non-AI review policy and blocks oversized byte patches", () => {
  const f = setup(false);
  expect(screen.queryByRole("checkbox")).toBeNull();
  fireEvent.change(screen.getByLabelText("Draft description"), { target: { value: "日".repeat(9000) } });
  expect(screen.getByRole("alert").textContent).toContain("24 KB");
  expect((screen.getByRole("button", { name: "Preview draft edits" }) as HTMLButtonElement).disabled).toBe(true);
  expect(f.onReview).not.toHaveBeenCalled();
});
