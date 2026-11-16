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

it("never claims nothing changed when Advisors' answer was lost", async () => {
  render(<ConsultationRequests change={vi.fn(async () => { throw new AdminApiError("upstream"); })} />);
  const request = await row();
  fireEvent.change(within(request).getByLabelText("Notes"), { target: { value: "My note" } });
  fireEvent.click(within(request).getByRole("button", { name: "Save" }));
  const alert = (await within(request).findByRole("alert")).textContent ?? "";
  expect(alert).toMatch(/did not confirm the change\. Reload the list/);
  expect(alert).not.toMatch(/nothing changed/);
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

it("starts the next page where the source now is after deleting on this one, so no request is skipped", async () => {
  const { readPortfolio } = await import("./portfolioClient");
  const reads = vi.mocked(readPortfolio);
  reads.mockResolvedValueOnce({ ...page, total: 45 } as unknown as Awaited<ReturnType<typeof readPortfolio>>);
  render(<ConsultationRequests change={vi.fn(async () => ({}))} />);
  const request = await row();
  fireEvent.click(within(request).getByRole("button", { name: "Delete" }));
  fireEvent.click(within(request).getByRole("button", { name: "Yes, delete" }));
  await screen.findByText("Deleted from Advisors.");
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  await vi.waitFor(() => expect(reads.mock.calls.at(-1)?.[1]).toMatchObject({ operation: "inquiries.list", offset: 19 }));
});

it("reads the page again when deleting all of a full page leaves the next page at the same place", async () => {
  const { readPortfolio } = await import("./portfolioClient");
  const reads = vi.mocked(readPortfolio);
  const items = Array.from({ length: 20 }, (_, index) => ({ ...page.items[0], id: `CM-0000000000${String(index).padStart(2, "0")}`, name: `Requester ${index + 1}` }));
  reads.mockResolvedValueOnce({ ...page, total: 45, items } as unknown as Awaited<ReturnType<typeof readPortfolio>>);
  render(<ConsultationRequests change={vi.fn(async () => ({}))} />);
  await screen.findByText("Requester 20");
  for (let deleted = 1; deleted <= 20; deleted += 1) {
    fireEvent.click(screen.getAllByRole("button", { name: "Delete" })[0]);
    fireEvent.click(screen.getByRole("button", { name: "Yes, delete" }));
    await vi.waitFor(() => expect(screen.getAllByText("Deleted from Advisors.")).toHaveLength(deleted));
  }
  const before = reads.mock.calls.length;
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  // The source closed the gap, so the next records now start at the same offset: the page is read again there.
  await vi.waitFor(() => expect(reads.mock.calls.length).toBe(before + 1));
  expect(reads.mock.calls.at(-1)?.[1]).toMatchObject({ operation: "inquiries.list", offset: 0 });
});

it("links a self-reported email address without letting it add recipients or a message", async () => {
  const { readPortfolio } = await import("./portfolioClient");
  vi.mocked(readPortfolio).mockResolvedValueOnce({ ...page, items: [{ ...page.items[0], email: "alex@agency.test?bcc=someone@elsewhere.test&body=hi" }] } as unknown as Awaited<ReturnType<typeof readPortfolio>>);
  render(<ConsultationRequests change={vi.fn(async () => ({}))} />);
  const link = within(await row()).getByRole("link", { name: /alex@agency\.test/ });
  // Encoded, the address cannot start a query: no header such as bcc or body reaches the mail client.
  expect(link.getAttribute("href")).toMatch(/^mailto:/);
  expect(link.getAttribute("href")).not.toMatch(/[?&]/);
});
