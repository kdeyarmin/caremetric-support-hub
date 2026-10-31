// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { AdvisorCommand } from "../../supabase/functions/_shared/advisorsCommands";
import { AdminApiError } from "./transport";

const page = { total: 1, limit: 20, offset: 0, items: [{ id: "CM-00000000000A", createdAt: "2026-10-01T10:00:00.000Z", name: "Alex Rivera", email: "alex@agency.test",
  organization: "River Home Health", phone: "(814) 555-0100", sector: "Home Health", service: "Strategic Planning & Operations", message: "Operations review.", status: "new", notes: "" }] };
vi.mock("./portfolioClient", () => ({ readPortfolio: vi.fn(async () => page) }));
const { ConsultationRequests } = await import("./ConsultationRequests");

afterEach(cleanup);
const row = async () => (await screen.findByText("Alex Rivera")).closest("tr") as HTMLElement;

it("updates a request's status and notes in Advisors, naming what the owner saw", async () => {
  const change = vi.fn<(command: AdvisorCommand) => Promise<unknown>>(async () => ({}));
  render(<ConsultationRequests change={change} />);
  const request = await row();
  expect((within(request).getByRole("link", { name: "alex@agency.test" }) as HTMLAnchorElement).href).toBe("mailto:alex@agency.test");
  expect((within(request).getByRole("link", { name: "(814) 555-0100" }) as HTMLAnchorElement).href).toBe("tel:8145550100");
  const save = within(request).getByRole("button", { name: "Save" }) as HTMLButtonElement;
  expect(save.disabled).toBe(true);
  fireEvent.change(within(request).getByLabelText("Status"), { target: { value: "in-progress" } });
  fireEvent.change(within(request).getByLabelText("Notes"), { target: { value: "Called back on Tuesday." } });
  fireEvent.click(save);
  expect(await within(request).findByText("Saved in Advisors.")).toBeTruthy();
  expect(change).toHaveBeenCalledWith({ operation: "inquiries.update", id: "CM-00000000000A", status: "in-progress", notes: "Called back on Tuesday.", expected: { status: "new", notes: "" } });

  // The next change names the saved values as what the owner saw.
  fireEvent.change(within(request).getByLabelText("Status"), { target: { value: "closed" } });
  fireEvent.click(save);
  await within(request).findByText("Saved in Advisors.");
  expect(change.mock.calls[1][0]).toMatchObject({ status: "closed", expected: { status: "in-progress", notes: "Called back on Tuesday." } });
});

it("explains a conflict instead of overwriting a change made in Advisors' own inbox", async () => {
  render(<ConsultationRequests change={vi.fn(async () => { throw new AdminApiError("conflict"); })} />);
  const request = await row();
  fireEvent.change(within(request).getByLabelText("Notes"), { target: { value: "My note" } });
  fireEvent.click(within(request).getByRole("button", { name: "Save" }));
  expect((await within(request).findByRole("alert")).textContent).toMatch(/changed in Advisors since the list loaded/);
});

it("deletes a request only after a second, explicit confirmation", async () => {
  const change = vi.fn<(command: AdvisorCommand) => Promise<unknown>>(async () => ({}));
  render(<ConsultationRequests change={change} />);
  const request = await row();
  fireEvent.click(within(request).getByRole("button", { name: "Delete" }));
  fireEvent.click(within(request).getByRole("button", { name: "Keep it" }));
  expect(change).not.toHaveBeenCalled();
  fireEvent.click(within(request).getByRole("button", { name: "Delete" }));
  fireEvent.click(within(request).getByRole("button", { name: "Yes, delete" }));
  expect(await screen.findByText("Deleted from Advisors.")).toBeTruthy();
  expect(change).toHaveBeenCalledWith({ operation: "inquiries.delete", id: "CM-00000000000A", expected: { status: "new", notes: "" } });
});
