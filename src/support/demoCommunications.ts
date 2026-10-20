import type { ChannelStatus, CommunicationsClient, Conversation, ConversationMessage, ConversationThread } from "./communicationsClient";

/** In-memory conversations for the credential-free implementation preview. Never a data store. */
export function demoCommunicationsClient(productIds: { breathe?: string; advisors?: string; pennsync?: string }): CommunicationsClient {
  const now = Date.now();
  const at = (minutes: number) => new Date(now - minutes * 60000).toISOString();
  const base = { assignedTo: null, assignedToName: null, organization: null, contactEmail: null, contactPhone: null, contactName: null };
  const threads: ConversationThread[] = [
    { ...base, id: "00000000-0000-4000-8000-00000000c001", reference: 1001, channel: "sms", sourceSystem: "hub.sms", productId: productIds.breathe ?? null, inquiryType: "technical_support", status: "new",
      subject: "Text message from +1 (202) 555-0144", contactPhone: "+12025550144", createdAt: at(12), updatedAt: at(12), lastMessageAt: at(12), messageCount: 1,
      messages: [{ id: "00000000-0000-4000-8000-00000000d001", direction: "inbound", body: "My sign-in code expired before it arrived.", authorName: null, delivery: "received", deliveryChannel: null, createdAt: at(12) }] },
    { ...base, id: "00000000-0000-4000-8000-00000000c002", reference: 1002, channel: "phone", sourceSystem: "breathe.phone", productId: productIds.advisors ?? null, inquiryType: "advisors", status: "open",
      subject: "Advisors call from Jordan Lee", contactName: "Jordan Lee", organization: "Lee Home Health", contactPhone: "+12025550171", contactEmail: "jordan@leehomehealth.test",
      createdAt: at(95), updatedAt: at(40), lastMessageAt: at(95), messageCount: 1,
      messages: [{ id: "00000000-0000-4000-8000-00000000d002", direction: "inbound", body: "Callback requested about an acquisition readiness review.", authorName: null, delivery: "received", deliveryChannel: null, createdAt: at(95) }] },
    { ...base, id: "00000000-0000-4000-8000-00000000c003", reference: 1003, channel: "chat", sourceSystem: "hub.chat", productId: productIds.pennsync ?? null, inquiryType: "unclassified", status: "waiting",
      subject: "Chat: How do I export OASIS data?", contactName: "Visitor", contactEmail: "visitor@agency.test", createdAt: at(180), updatedAt: at(170), lastMessageAt: at(170), messageCount: 2,
      messages: [
        { id: "00000000-0000-4000-8000-00000000d003", direction: "inbound", body: "How do I export OASIS data?", authorName: null, delivery: "received", deliveryChannel: null, createdAt: at(180) },
        { id: "00000000-0000-4000-8000-00000000d004", direction: "outbound", body: "Open Reports, then choose Export.", authorName: "CareMetric Support", delivery: "sent", deliveryChannel: "chat", createdAt: at(170) },
      ] },
  ];
  const summary = ({ messages, ...conversation }: ConversationThread): Conversation => ({ ...conversation, messageCount: messages.filter(message => message.direction !== "note").length });
  const find = (id: string) => { const thread = threads.find(item => item.id === id); if (!thread) throw new Error("Conversation not found."); return thread; };
  const append = (id: string, message: Omit<ConversationMessage, "id" | "createdAt">) => {
    const thread = find(id);
    thread.messages.push({ ...message, id: crypto.randomUUID(), createdAt: new Date().toISOString() });
    thread.updatedAt = new Date().toISOString();
    return thread;
  };
  return {
    async list(filter) {
      const needle = filter.search?.toLowerCase();
      const visible = threads.filter(item => (!filter.channel || item.channel === filter.channel) && (!filter.productId || item.productId === filter.productId)
        && (!needle || [item.subject, item.contactName, item.contactEmail, item.organization, `cm-${item.reference}`].some(value => value?.toLowerCase().includes(needle))));
      const matching = visible.filter(item => !filter.status || item.status === filter.status || (filter.status === "active" && item.status !== "closed"));
      const statusCounts: Record<string, number> = {};
      for (const item of visible) statusCounts[item.status] = (statusCounts[item.status] ?? 0) + 1;
      return { items: matching.slice(filter.offset, filter.offset + filter.limit).map(summary), total: matching.length, limit: filter.limit, offset: filter.offset, statusCounts };
    },
    async get(id) { return structuredClone(find(id)); },
    async update(update) {
      const thread = find(update.id);
      if (update.status) thread.status = update.status;
      if (update.inquiryType) thread.inquiryType = update.inquiryType;
      if (update.changeProduct) thread.productId = update.productId ?? null;
      if (update.changeAssignment) { thread.assignedTo = update.assignedTo ?? null; thread.assignedToName = update.assignedTo ? "CareMetric Support" : null; }
      thread.updatedAt = new Date().toISOString();
      return summary(thread);
    },
    async note(id, body) { return structuredClone(append(id, { direction: "note", body, authorName: "CareMetric Support", delivery: "recorded", deliveryChannel: null })); },
    async reply(id, body) {
      const thread = find(id);
      const route = thread.channel === "chat" ? "chat" : thread.channel === "sms" ? "sms" : "email";
      append(id, { direction: "outbound", body, authorName: "CareMetric Support", delivery: route === "chat" ? "sent" : "unknown", deliveryChannel: route });
      thread.status = "waiting";
      return { delivery: route === "chat" ? "sent" : "unknown", deliveryChannel: route, replay: false };
    },
    async sync(source) { return { source, read: 0, created: 0, skipped: 0 }; },
    async channels(): Promise<ChannelStatus> { return { sms: { inbound: false, replies: false }, email: { inbound: false, replies: false }, chat: { enabled: true }, phone: { sync: true }, webForm: { sync: true } }; },
  };
}
