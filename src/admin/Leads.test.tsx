// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Leads } from "./Leads";
import { LeadsApiError } from "./leadsClient";
import type { LeadsClient } from "./leadsClient";
import { attributionSummary, detailLabel, detailValue } from "./leadsProtocol";
import type { Lead, LeadPage } from "./leadsProtocol";

// DOM tests inject every data client; initialize the app's ordinary explicit preview configuration.
vi.hoisted(() => { vi.stubEnv("VITE_DEMO_MODE", "true"); });
afterEach(cleanup);

const noAttribution = { utmSource: null, utmMedium: null, utmCampaign: null, utmTerm: null, utmContent: null, referrerHost: null, landingPath: null, firstSeenAt: null };
const demo: Lead = {
  id: "11111111-1111-4111-8111-111111111111", source: "carebase", kind: "demo_request", externalId: "cb-1", test: false,
  occurredAt: "2026-11-03T12:00:00+00:00", receivedAt: "2026-11-03T12:00:01.123456+00:00",
  contact: { name: "Jordan Rivera", email: "jordan@sunrise.example", phone: "(202) 555-0101", organization: "Sunrise Assisted Living Facility", role: "Administrator" },
  details: { facilityCount: 3, trialRequested: true },
  attribution: { ...noAttribution, utmSource: "google", utmMedium: "cpc", utmCampaign: "fall", referrerHost: "www.google.com", landingPath: "/pricing" },
  productId: "00000000-0000-4000-8000-000000000001",
  conversation: { id: "22222222-2222-4222-8222-222222222222", reference: "CM-1042", status: "new" },
  status: "new", createdAt: "2026-11-03T12:00:01.123456+00:00", updatedAt: "2026-11-03T12:00:01.123456+00:00",
};
const newsletter: Lead = {
  ...demo, id: "33333333-3333-4333-8333-333333333333", source: "intel", kind: "newsletter", externalId: "intel-7",
  contact: { name: null, email: "reader@agency.example", phone: null, organization: null, role: null }, details: {}, attribution: noAttribution, conversation: null,
};
const page = (items: Lead[], total = items.length, offset = 0): LeadPage => ({ items, total, offset, limit: 25 });
function fakeClient(data: LeadPage = page([demo, newsletter]), overrides: Partial<LeadsClient> = {}): LeadsClient {
  return { list: vi.fn(async () => data), setStatus: vi.fn(async input => ({ ...demo, status: input.status, updatedAt: "2026-11-03T12:05:00.000001+00:00" })), ...overrides };
}
const table = () => screen.findByRole("table", { name: "Leads, newest first" });
const rowOf = (text: string) => screen.getByText(text).closest("tr") as HTMLElement;

describe("Leads screen", () => {
  it("lists every lead with its product, kind, contact, where it came from, status and conversation", async () => {
    const client = fakeClient();
    render(<Leads client={client} />);
    await table();
    expect(client.list).toHaveBeenCalledWith({ kind: null, source: null, includeTest: false, offset: 0, limit: 25 }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    const row = rowOf("Jordan Rivera");
    for (const text of ["CareBase", "Demo request", "Administrator", "Sunrise Assisted Living Facility", "jordan@sunrise.example", "(202) 555-0101"]) expect(within(row).getByText(text)).toBeTruthy();
    expect(within(row).getByText("Facility count: 3 · Trial requested: Yes")).toBeTruthy();
    expect(within(row).getByText("google / cpc (fall) · from www.google.com · landed on /pricing")).toBeTruthy();
    expect((within(row).getByLabelText("Status for Jordan Rivera") as HTMLSelectElement).value).toBe("new");
    expect(within(row).getByRole("link", { name: "Open CM-1042" }).getAttribute("href")).toBe("/communications?search=CM-1042&status=all");
    const quiet = rowOf("reader@agency.example");
    expect(within(quiet).getByText("Intel")).toBeTruthy();
    expect(within(quiet).getByText("Newsletter sign-up")).toBeTruthy();
    expect(within(quiet).getByText("Direct or not recorded")).toBeTruthy();
    expect(within(quiet).getByText("None")).toBeTruthy();
    expect(screen.getByText("Showing 1–2 of 2")).toBeTruthy();
    expect(screen.getByText(/What they wrote is kept only in the conversation/)).toBeTruthy();
  });

  it("filters by kind and product, shows test leads only when asked, and starts each new list from the first page", async () => {
    const client = fakeClient(page([demo], 60));
    render(<Leads client={client} />);
    await table();
    fireEvent.click(screen.getByRole("button", { name: "Older" }));
    await waitFor(() => expect(client.list).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 25 }), expect.anything()));
    fireEvent.change(screen.getByLabelText("Kind"), { target: { value: "consultation" } });
    await waitFor(() => expect(client.list).toHaveBeenLastCalledWith({ kind: "consultation", source: null, includeTest: false, offset: 0, limit: 25 }, expect.anything()));
    fireEvent.change(screen.getByLabelText("Product"), { target: { value: "advisors" } });
    await waitFor(() => expect(client.list).toHaveBeenLastCalledWith({ kind: "consultation", source: "advisors", includeTest: false, offset: 0, limit: 25 }, expect.anything()));
    fireEvent.click(screen.getByLabelText("Show test leads"));
    await waitFor(() => expect(client.list).toHaveBeenLastCalledWith({ kind: "consultation", source: "advisors", includeTest: true, offset: 0, limit: 25 }, expect.anything()));
  });

  it("marks a probe as a test lead", async () => {
    render(<Leads client={fakeClient(page([{ ...demo, test: true, contact: { ...demo.contact, name: "Probe" } }]))} />);
    await table();
    expect(within(rowOf("Probe")).getByText("Test")).toBeTruthy();
  });

  it("changes a status with the version it was loaded at, says so, and reloads", async () => {
    const client = fakeClient();
    render(<Leads client={client} />);
    await table();
    fireEvent.change(screen.getByLabelText("Status for Jordan Rivera"), { target: { value: "contacted" } });
    await waitFor(() => expect(client.setStatus).toHaveBeenCalledWith({ id: demo.id, status: "contacted", expectedUpdatedAt: demo.updatedAt }));
    expect((await screen.findByText("Jordan Rivera is marked contacted.")).getAttribute("role")).toBe("status");
    await waitFor(() => expect(client.list).toHaveBeenCalledTimes(2));
  });

  it("explains a change someone else made first, and reloads the list under it", async () => {
    const client = fakeClient(undefined, { setStatus: vi.fn(async () => { throw new LeadsApiError(409, "This lead changed. Refresh and try again."); }) });
    render(<Leads client={client} />);
    await table();
    fireEvent.change(screen.getByLabelText("Status for reader@agency.example"), { target: { value: "spam" } });
    expect(await screen.findByText(/This lead changed since the list loaded, so nothing was saved/)).toBeTruthy();
    await waitFor(() => expect(client.list).toHaveBeenCalledTimes(2));
  });

  it("asks for a new sign-in when the command session has lapsed, and never claims nothing changed after a lost answer", async () => {
    const lapsed = fakeClient(undefined, { setStatus: vi.fn(async () => { throw new LeadsApiError(401, "Current administrator session required."); }) });
    render(<Leads client={lapsed} />);
    await table();
    fireEvent.change(screen.getByLabelText("Status for Jordan Rivera"), { target: { value: "won" } });
    expect(await screen.findByText(/Your administrator session has ended/)).toBeTruthy();
    cleanup();
    const lost = fakeClient(undefined, { setStatus: vi.fn(async () => { throw new TypeError("Failed to fetch"); }) });
    render(<Leads client={lost} />);
    await table();
    fireEvent.change(screen.getByLabelText("Status for Jordan Rivera"), { target: { value: "won" } });
    expect(await screen.findByText(/could not be confirmed/)).toBeTruthy();
  });

  it("does not call the server for the status a lead already has", async () => {
    const client = fakeClient();
    render(<Leads client={client} />);
    await table();
    fireEvent.change(screen.getByLabelText("Status for Jordan Rivera"), { target: { value: "new" } });
    expect(client.setStatus).not.toHaveBeenCalled();
  });

  it("says plainly when there are no leads yet, and when filters match none", async () => {
    render(<Leads client={fakeClient(page([]))} />);
    expect(await screen.findByText(/No leads yet/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Kind"), { target: { value: "county_report" } });
    expect(await screen.findByText("No leads match these filters.")).toBeTruthy();
  });

  it("shows the administrator read failure when the list cannot be loaded", async () => {
    render(<Leads client={fakeClient(undefined, { list: vi.fn(async () => { throw new LeadsApiError(403, "You do not have access to this action."); }) })} />);
    expect(await screen.findByText("Administrator access required")).toBeTruthy();
  });
});

describe("lead wording", () => {
  it("describes where a person came from and the facts they gave", () => {
    expect(attributionSummary(noAttribution)).toBe("Direct or not recorded");
    expect(attributionSummary({ ...noAttribution, utmCampaign: "spring" })).toBe("spring");
    expect(attributionSummary({ ...noAttribution, referrerHost: "duckduckgo.com" })).toBe("from duckduckgo.com");
    expect(detailLabel("facilityCount")).toBe("Facility count");
    expect(detailLabel("beds")).toBe("Beds");
    expect(detailValue(false)).toBe("No");
    expect(detailValue(12)).toBe("12");
  });
});
