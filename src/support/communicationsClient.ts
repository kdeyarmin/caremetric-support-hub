import { z } from "zod";
import { appRequest } from "../lib/appSession";

export const channels = ["phone", "sms", "email", "chat", "web_form"] as const;
export const conversationStatuses = ["new", "open", "waiting", "closed"] as const;
export const inquiryTypes = ["technical_support", "customer_service", "billing", "sales", "advisors", "unclassified"] as const;
export type Channel = typeof channels[number];
export type ConversationStatus = typeof conversationStatuses[number];
export type InquiryType = typeof inquiryTypes[number];

export const channelLabels: Record<Channel, string> = { phone: "Phone", sms: "Text message", email: "Email", chat: "Chat", web_form: "Web form" };
/** Which website a web-form conversation came from: the channel alone ("Web form") does not say. */
const conversationSourceLabels: Record<string, string> = {
  "carebase.web": "CareBase website", "intel.web": "Intel website", "advisors.web": "Advisors website",
};
export function conversationSourceLabel(sourceSystem: string): string | null {
  return Object.hasOwn(conversationSourceLabels, sourceSystem) ? conversationSourceLabels[sourceSystem] : null;
}
export const statusLabels: Record<ConversationStatus, string> = { new: "New", open: "Open", waiting: "Waiting on customer", closed: "Closed" };
export const inquiryLabels: Record<InquiryType, string> = {
  technical_support: "Technical support", customer_service: "Customer service", billing: "Billing",
  sales: "Software inquiry", advisors: "Healthcare Advisors", unclassified: "Not yet classified",
};
export const deliveryLabels: Record<string, string> = {
  received: "Received", pending: "Sending — outcome not yet confirmed", sent: "Sent", failed: "Not delivered",
  unknown: "Send outcome unknown — confirm with the customer before resending", recorded: "Internal note",
};

const text = z.string();
export const conversationSchema = z.object({
  id: z.uuid(), reference: z.number().int().positive(), channel: z.enum(channels), sourceSystem: text,
  productId: z.uuid().nullable(), inquiryType: z.enum(inquiryTypes), status: z.enum(conversationStatuses), subject: text,
  contactName: text.nullable(), contactEmail: text.nullable(), contactPhone: text.nullable(), organization: text.nullable(),
  assignedTo: z.uuid().nullable(), assignedToName: text.nullable(), createdAt: text, updatedAt: text, lastMessageAt: text,
  messageCount: z.number().int().nonnegative(),
});
export type Conversation = z.infer<typeof conversationSchema>;
export const messageSchema = z.object({
  id: z.uuid(), direction: z.enum(["inbound", "outbound", "note"]), body: text, authorName: text.nullable(),
  delivery: text, deliveryChannel: z.enum(["sms", "email", "chat"]).nullable(), createdAt: text,
});
export type ConversationMessage = z.infer<typeof messageSchema>;
export const threadSchema = conversationSchema.extend({ messages: z.array(messageSchema) });
export type ConversationThread = z.infer<typeof threadSchema>;
const pageSchema = z.object({
  items: z.array(conversationSchema), total: z.number().int().nonnegative(), limit: z.number().int(), offset: z.number().int(),
  statusCounts: z.record(z.string(), z.number().int().nonnegative()),
});
export type ConversationPage = z.infer<typeof pageSchema>;
const channelStatusSchema = z.object({
  sms: z.object({ inbound: z.boolean(), replies: z.boolean() }), email: z.object({ inbound: z.boolean(), replies: z.boolean() }),
  chat: z.object({ enabled: z.boolean() }), phone: z.object({ sync: z.boolean() }), webForm: z.object({ sync: z.boolean() }),
});
export type ChannelStatus = z.infer<typeof channelStatusSchema>;
const replySchema = z.object({ delivery: text, deliveryChannel: z.enum(["sms", "email", "chat"]), replay: z.boolean() });
export type SyncSource = "breathe.phone" | "advisors.web";
const syncSchema = z.object({ source: z.enum(["breathe.phone", "advisors.web"]), read: z.number().int(), created: z.number().int(), skipped: z.number().int(), nextOffset: z.number().int().nonnegative().nullable() });

export interface ConversationFilter { status?: ConversationStatus | "active"; channel?: Channel; productId?: string; search?: string; offset: number; limit: number }
export interface ConversationUpdate {
  id: string; expectedUpdatedAt: string; status?: ConversationStatus; inquiryType?: InquiryType;
  changeProduct?: boolean; productId?: string | null; changeAssignment?: boolean; assignedTo?: string | null;
}

/** Where a staff reply will go for this conversation, given the configured providers. */
export function replyRoute(conversation: Conversation, status: ChannelStatus | null): { label: string; available: boolean } {
  if (conversation.channel === "chat") return { label: "Reply in chat", available: true };
  const mobile = !!conversation.contactPhone && /^\+[1-9][0-9]{7,14}$/.test(conversation.contactPhone);
  const route = conversation.channel === "sms" ? "sms" : conversation.channel === "email" ? "email"
    : conversation.contactEmail && status?.email.replies ? "email" : mobile && status?.sms.replies ? "sms" : conversation.contactEmail ? "email" : mobile ? "sms" : null;
  if (!route) return { label: "No email address or mobile number — call back and record a note", available: false };
  const configured = route === "sms" ? !!status?.sms.replies : !!status?.email.replies;
  return { label: `${route === "sms" ? "Reply by text message" : "Reply by email"}${configured ? "" : " — not configured in the Hub yet"}`, available: configured };
}

/** One reviewed description of each customer channel, shared by the inbox strip and the control center so they never disagree. */
export interface ChannelSummary { channel: Channel; label: string; detail: string; ready: boolean }
export function describeChannels(status: ChannelStatus): ChannelSummary[] {
  const receiving = (item: { inbound: boolean; replies: boolean }) => item.inbound ? item.replies ? "Receiving and replying" : "Receiving · replies not configured" : "Not connected";
  return [
    { channel: "phone", label: "Phone line (877) 521-2890", detail: "Imported from the AI phone assistant", ready: status.phone.sync },
    { channel: "sms", label: "Text messages", detail: receiving(status.sms), ready: status.sms.inbound },
    { channel: "email", label: "Email", detail: receiving(status.email), ready: status.email.inbound },
    { channel: "chat", label: "Website chat", detail: status.chat.enabled ? "On every Help page" : "Off until the owner enables it", ready: status.chat.enabled },
    { channel: "web_form", label: "Website forms", detail: "Sent by the CareBase, Intel and Advisors websites; Advisors requests can also be imported", ready: status.webForm.sync },
  ];
}

export const communicationsClient = {
  async list(filter: ConversationFilter, signal?: AbortSignal) { return pageSchema.parse(await appRequest("communications/list", filter, signal)); },
  async get(id: string, signal?: AbortSignal) { return threadSchema.parse(await appRequest("communications/get", { id }, signal)); },
  async update(update: ConversationUpdate) { return conversationSchema.parse(await appRequest("communications/update", update)); },
  async note(id: string, body: string, requestKey: string) { return threadSchema.parse(await appRequest("communications/note", { id, body, requestKey })); },
  async reply(id: string, body: string, requestKey: string) { return replySchema.parse(await appRequest("communications/reply", { id, body, requestKey })); },
  /** Imports up to 200 messages starting at offset; nextOffset is where the next batch starts, or null when none remain. */
  async sync(source: SyncSource, offset = 0) { return syncSchema.parse(await appRequest("communications/sync", offset ? { source, offset } : { source })); },
  async channels(signal?: AbortSignal) { return channelStatusSchema.parse(await appRequest("communications/channels", undefined, signal)); },
};
export type CommunicationsClient = typeof communicationsClient;

const chatSchema = z.object({
  reference: z.number().int().positive(), status: z.enum(conversationStatuses),
  messages: z.array(z.object({ id: z.uuid(), from: z.enum(["visitor", "support"]), body: text, createdAt: text })),
});
export type ChatThread = z.infer<typeof chatSchema>;
export const chatClient = {
  async availability(signal?: AbortSignal) { return z.object({ chat: z.boolean() }).parse(await appRequest("chat/availability", undefined, signal)); },
  async start(input: { name: string; email: string; product?: string; message: string; noPhi: true }) {
    return z.object({ reference: z.number().int().positive() }).parse(await appRequest("chat/start", input));
  },
  async thread(signal?: AbortSignal) { return chatSchema.parse(await appRequest("chat/thread", undefined, signal)); },
  async send(message: string) { return chatSchema.parse(await appRequest("chat/message", { message })); },
  async end() { await appRequest("chat/end", {}); },
};
export type ChatClient = typeof chatClient;
