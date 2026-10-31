// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ catalog: vi.fn(async () => []) }));
vi.mock("./api", () => ({ learningApi: api }));
const { LearningCatalog } = await import("./Catalog");

afterEach(cleanup);

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
