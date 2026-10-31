// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Communications } from "./Communications";
import { ChatPanel } from "./ChatPanel";
import { demoCommunicationsClient } from "./demoCommunications";
import { replyRoute, type ChannelStatus, type ChatClient, type Conversation } from "./communicationsClient";
import type { Product } from "../domain";

afterEach(cleanup);
const products: Product[] = [
  { id: "00000000-0000-4000-8000-000000000002", slug: "breathe", name: "CareMetric Breathe", description: "", status: "active", color: "#2378c8" },
  { id: "00000000-0000-4000-8000-000000000007", slug: "advisors", name: "CareMetric Healthcare Advisors", description: "", status: "active", color: "#07356F" },
];
const actor = { id: "11111111-1111-4111-8111-111111111111", role: "platform_admin" };
const configured: ChannelStatus = { sms: { inbound: true, replies: true }, email: { inbound: true, replies: false }, chat: { enabled: true }, phone: { sync: true }, webForm: { sync: true } };
const conversation = (change: Partial<Conversation>): Conversation => ({
  id: "22222222-2222-4222-8222-222222222222", reference: 1001, channel: "phone", sourceSystem: "breathe.phone", productId: null, inquiryType: "unclassified", status: "new",
  subject: "Call", contactName: null, contactEmail: null, contactPhone: null, organization: null, assignedTo: null, assignedToName: null,
  createdAt: "2026-10-20T00:00:00Z", updatedAt: "2026-10-20T00:00:00Z", lastMessageAt: "2026-10-20T00:00:00Z", messageCount: 1, ...change,
});
function client() {
  const demo = demoCommunicationsClient({ breathe: products[0].id, advisors: products[1].id });
  return { ...demo, channels: vi.fn(async () => configured), sync: vi.fn(async (source: "breathe.phone" | "advisors.web", offset = 0) => ({ source, read: 3, created: 2, skipped: 1, nextOffset: source === "breathe.phone" && offset === 0 ? 200 : null })),
    reply: vi.fn(demo.reply), update: vi.fn(demo.update), note: vi.fn(demo.note) };
}

describe("unified communications inbox", () => {
  it("chooses the reply channel from the conversation and refuses an unconfigured provider", () => {
    expect(replyRoute(conversation({ channel: "chat" }), null)).toEqual({ label: "Reply in chat", available: true });
    expect(replyRoute(conversation({ channel: "sms", contactPhone: "+12025550144" }), configured).available).toBe(true);
    expect(replyRoute(conversation({ channel: "email", contactEmail: "pat@agency.test" }), configured)).toEqual({ label: "Reply by email — not configured in the Hub yet", available: false });
    expect(replyRoute(conversation({ contactEmail: "pat@agency.test", contactPhone: "+12025550144" }), configured).label).toBe("Reply by text message");
    expect(replyRoute(conversation({ contactPhone: "(202) 555" }), configured).available).toBe(false);
  });
  it("lists every channel, opens a thread, triages it and replies once", async () => {
    const fake = client();
    render(<Communications products={products} actor={actor} client={fake} />);
    const list = await screen.findByRole("region", { name: "Conversations" });
    expect(within(list).getByText("Text message from +1 (202) 555-0144")).toBeTruthy();
    expect(within(list).getByText("Advisors call from Jordan Lee")).toBeTruthy();
    expect(screen.getByText("Receiving · replies not configured")).toBeTruthy();
    fireEvent.click(within(list).getByText("Text message from +1 (202) 555-0144"));
    const thread = await screen.findByRole("region", { name: "Conversation" });
    expect(await within(thread).findByText("My sign-in code expired before it arrived.")).toBeTruthy();
    fireEvent.click(within(thread).getByRole("button", { name: "Assign to me" }));
    await waitFor(() => expect(fake.update).toHaveBeenCalledWith(expect.objectContaining({ changeAssignment: true, assignedTo: actor.id })));
    const reply = await within(thread).findByLabelText("Reply by text message");
    fireEvent.change(reply, { target: { value: "Request a new code from the sign-in page." } });
    fireEvent.click(within(thread).getByRole("button", { name: "Send reply" }));
    await waitFor(() => expect(fake.reply).toHaveBeenCalledTimes(1));
    expect(fake.reply.mock.calls[0][2]).toMatch(/^[0-9a-f-]{36}$/);
    expect(await screen.findByText(/delivery is not confirmed/)).toBeTruthy();
  });
  it("opens with the filters a control-center link carries", async () => {
    render(<Communications products={products} actor={actor} client={client()} initialFilter={{ channel: "sms", productId: products[0].id }} />);
    const list = await screen.findByRole("region", { name: "Conversations" });
    expect(within(list).getByText("Text message from +1 (202) 555-0144")).toBeTruthy();
    expect(within(list).queryByText("Advisors call from Jordan Lee")).toBeNull();
    expect((screen.getByLabelText("Channel") as HTMLSelectElement).value).toBe("sms");
    expect((screen.getByLabelText("Application") as HTMLSelectElement).value).toBe(products[0].id);
  });
  it("lets the administrator import the phone line and the Advisors form", async () => {
    const fake = client();
    render(<Communications products={products} actor={actor} client={fake} />);
    fireEvent.click(await screen.findByRole("button", { name: "Import phone-line messages" }));
    expect(await screen.findByText("Phone line: 2 new, 1 already in the Hub. More remain: import the next batch.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Import the next phone-line batch" }));
    await waitFor(() => expect(fake.sync).toHaveBeenLastCalledWith("breathe.phone", 200));
    expect(await screen.findByText("Phone line: 2 new, 1 already in the Hub.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Import the next phone-line batch" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Import Advisors requests" }));
    await waitFor(() => expect(fake.sync).toHaveBeenLastCalledWith("advisors.web", 0));
    expect(await screen.findByText("Advisors consultation form: 2 new, 1 already in the Hub.")).toBeTruthy();
    cleanup();
    render(<Communications products={products} actor={{ ...actor, role: "support_agent" }} client={client()} />);
    await screen.findByRole("region", { name: "Conversations" });
    expect(screen.queryByRole("button", { name: "Import phone-line messages" })).toBeNull();
  });
});

describe("inbox safety", () => {
  it("retries an unconfirmed reply with the same key and sends changed text only as an explicit new message", async () => {
    const fake = client();
    fake.reply.mockRejectedValueOnce(new Error("The connection was lost."));
    render(<Communications products={products} actor={actor} client={fake} />);
    fireEvent.click(within(await screen.findByRole("region", { name: "Conversations" })).getByText("Text message from +1 (202) 555-0144"));
    const thread = await screen.findByRole("region", { name: "Conversation" });
    const reply = await within(thread).findByLabelText("Reply by text message");
    fireEvent.change(reply, { target: { value: "First answer." } });
    fireEvent.click(within(thread).getByRole("button", { name: "Send reply" }));
    expect(await screen.findByText("The connection was lost.")).toBeTruthy();
    const firstKey = fake.reply.mock.calls[0][2];
    fireEvent.change(reply, { target: { value: "Edited answer." } });
    expect(within(thread).getByText(/The last reply may already have been saved or sent/)).toBeTruthy();
    fireEvent.click(within(thread).getByRole("button", { name: "Restore the original text" }));
    expect((reply as HTMLTextAreaElement).value).toBe("First answer.");
    fireEvent.click(within(thread).getByRole("button", { name: "Send reply" }));
    await waitFor(() => expect(fake.reply).toHaveBeenCalledTimes(2));
    expect(fake.reply.mock.calls[1]).toEqual([expect.any(String), "First answer.", firstKey]);
    await screen.findByText(/delivery is not confirmed/);
    fireEvent.change(reply, { target: { value: "A separate follow-up." } });
    fireEvent.click(within(thread).getByRole("button", { name: "Send reply" }));
    await waitFor(() => expect(fake.reply).toHaveBeenCalledTimes(3));
    expect(fake.reply.mock.calls[2][2]).not.toBe(firstKey);
  });
  it("saves changed note text after an unconfirmed attempt only as a new note", async () => {
    const fake = client();
    fake.note.mockRejectedValueOnce(new Error("The connection was lost."));
    render(<Communications products={products} actor={actor} client={fake} />);
    fireEvent.click(within(await screen.findByRole("region", { name: "Conversations" })).getByText("Text message from +1 (202) 555-0144"));
    const thread = await screen.findByRole("region", { name: "Conversation" });
    const note = await within(thread).findByLabelText("Internal note — never shown to the customer");
    fireEvent.change(note, { target: { value: "Called back." } });
    fireEvent.click(within(thread).getByRole("button", { name: "Save note" }));
    expect(await screen.findByText("The connection was lost.")).toBeTruthy();
    fireEvent.change(note, { target: { value: "Called back twice." } });
    fireEvent.click(within(thread).getByRole("button", { name: "Save as a new note" }));
    await waitFor(() => expect(fake.note).toHaveBeenCalledTimes(2));
    expect(fake.note.mock.calls[1][2]).not.toBe(fake.note.mock.calls[0][2]);
  });
  it("moves to the last page when a refresh leaves the current page empty", async () => {
    let total = 26;
    const rows = Array.from({ length: 26 }, (_, index) => conversation({ id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`, reference: 1001 + index, subject: `Conversation ${index + 1}` }));
    const fake = { ...client(), list: vi.fn(async (filter: { offset: number; limit: number }) => ({ items: rows.slice(0, total).slice(filter.offset, filter.offset + filter.limit), total, limit: filter.limit, offset: filter.offset, statusCounts: {} })) };
    render(<Communications products={products} actor={actor} client={fake} />);
    fireEvent.click(await screen.findByRole("button", { name: "Next" }));
    expect(await screen.findByText("Conversation 26")).toBeTruthy();
    total = 25;
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText("Conversation 1")).toBeTruthy();
    expect(fake.list).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 0 }), expect.anything());
  });
});

describe("website chat", () => {
  const thread = { reference: 1003, status: "new" as const, messages: [{ id: "33333333-3333-4333-8333-333333333333", from: "visitor" as const, body: "Hello", createdAt: "2026-10-20T00:00:00Z" }] };
  it("requires the patient-information acknowledgment before starting", async () => {
    const chat: ChatClient = { availability: vi.fn(async () => ({ chat: true })), start: vi.fn(async () => ({ reference: 1003 })), thread: vi.fn().mockRejectedValueOnce(new Error("none")).mockResolvedValue(thread), send: vi.fn(), end: vi.fn() };
    render(<ChatPanel productSlug="breathe" productName="CareMetric Breathe" client={chat} />);
    fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "Visitor" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "visitor@agency.test" } });
    fireEvent.change(screen.getByLabelText("Question"), { target: { value: "Hello" } });
    fireEvent.click(screen.getByRole("button", { name: "Start chat" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(chat.start).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText(/contains no patient names/));
    fireEvent.click(screen.getByRole("button", { name: "Start chat" }));
    await waitFor(() => expect(chat.start).toHaveBeenCalledWith({ name: "Visitor", email: "visitor@agency.test", message: "Hello", noPhi: true, product: "breathe" }));
    expect(await screen.findByText(/Reference CM-1003/)).toBeTruthy();
  });
  it("offers phone and email instead of a form until the owner enables chat", async () => {
    const chat: ChatClient = { availability: vi.fn(async () => ({ chat: false })), start: vi.fn(), thread: vi.fn().mockRejectedValue(new Error("none")), send: vi.fn(), end: vi.fn() };
    render(<ChatPanel client={chat} />);
    expect(await screen.findByText(/Chat is not available yet/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Start chat" })).toBeNull();
  });
  it("is clearly unavailable in the credential-free preview", () => {
    render(<ChatPanel available={false} />);
    expect(screen.getByText(/Chat opens here in the connected Hub/)).toBeTruthy();
  });
});
