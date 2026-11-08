// @vitest-environment jsdom
import { lazy } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PageBoundary } from "./PageBoundary";

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("shows progress while a page downloads and then renders the page", async () => {
  let finish!: (module: { default: () => React.ReactNode }) => void;
  const Page = lazy(() => new Promise<{ default: () => React.ReactNode }>(resolve => { finish = resolve; }));
  render(<PageBoundary><Page /></PageBoundary>);
  expect(screen.getByRole("status").textContent).toBe("Loading page…");
  await act(async () => finish({ default: () => <h1>Administration</h1> }));
  await screen.findByRole("heading", { name: "Administration" });
  expect(screen.queryByRole("status")).toBeNull();
});

it("offers recovery after a failed page download and allows navigation to another page", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const reload = vi.fn();
  vi.stubGlobal("location", { ...window.location, reload });
  const Page = lazy(async () => { throw new Error("Chunk unavailable"); });
  const view = render(<PageBoundary key="failed"><Page /></PageBoundary>);
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "Reload page" }));
  expect(reload).toHaveBeenCalledOnce();
  view.rerender(<PageBoundary key="another"><h1>Another page</h1></PageBoundary>);
  expect(screen.getByRole("heading", { name: "Another page" })).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
});
