import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Mail, MessageCircle, MessageSquareText, Phone, RefreshCw, Search, Send, StickyNote, Globe2 } from "lucide-react";
import type { Product } from "../domain";
import {
  channelLabels, channels, communicationsClient, conversationStatuses, deliveryLabels, inquiryLabels, inquiryTypes, replyRoute, statusLabels,
  type Channel, type ChannelStatus, type CommunicationsClient, type ConversationPage, type ConversationStatus, type ConversationThread, type InquiryType,
} from "./communicationsClient";
import "./communications.css";

const channelIcons: Record<Channel, typeof Phone> = { phone: Phone, sms: MessageSquareText, email: Mail, chat: MessageCircle, web_form: Globe2 };
const when = (value: string) => new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value));
const pageSize = 25;

export function Communications({ products, actor, client = communicationsClient }: { products: Product[]; actor: { id: string; role: string }; client?: CommunicationsClient }) {
  const [filter, setFilter] = useState<{ status: ConversationStatus | "active" | ""; channel: Channel | ""; productId: string; search: string }>({ status: "active", channel: "", productId: "", search: "" });
  const [searchInput, setSearchInput] = useState("");
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<ConversationPage | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [thread, setThread] = useState<ConversationThread | null>(null);
  const [status, setStatus] = useState<ChannelStatus | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(() => setRevision(value => value + 1), []);
  const productName = useMemo(() => new Map(products.map(product => [product.id, product.name])), [products]);
  const admin = actor.role === "platform_admin";

  useEffect(() => {
    const controller = new AbortController();
    client.channels(controller.signal).then(setStatus).catch(() => { if (!controller.signal.aborted) setStatus(null); });
    return () => controller.abort();
  }, [client]);
  useEffect(() => {
    const controller = new AbortController();
    client.list({ ...(filter.status ? { status: filter.status } : {}), ...(filter.channel ? { channel: filter.channel } : {}), ...(filter.productId ? { productId: filter.productId } : {}),
      ...(filter.search ? { search: filter.search } : {}), offset, limit: pageSize }, controller.signal)
      .then(result => { setPage(result); setError(""); })
      .catch(() => { if (!controller.signal.aborted) setError("Conversations could not be loaded. Check your sign-in and try again."); });
    return () => controller.abort();
  }, [client, filter, offset, revision]);
  useEffect(() => {
    if (!selected) return;
    const controller = new AbortController();
    client.get(selected, controller.signal).then(setThread).catch(() => { if (!controller.signal.aborted) setError("This conversation could not be opened."); });
    return () => controller.abort();
  }, [client, selected, revision]);
  useEffect(() => {
    // New texts, emails and chats arrive without a page reload.
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") refresh(); }, 30000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  async function act(work: () => Promise<string>) {
    setBusy(true); setNotice(""); setError("");
    try { setNotice(await work()); refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "The action could not be completed."); }
    finally { setBusy(false); }
  }
  const sync = (source: "breathe.phone" | "advisors.web") => act(async () => {
    const result = await client.sync(source);
    return `${source === "breathe.phone" ? "Phone line" : "Advisors consultation form"}: ${result.created} new, ${result.skipped} already in the Hub.`;
  });
  function search(event: FormEvent) { event.preventDefault(); setOffset(0); setFilter(value => ({ ...value, search: searchInput.trim() })); }

  return <div className="communications">
    <div className="page-heading"><div><span className="eyebrow">Every channel · every application</span><h1>Communications</h1>
      <p>Customer service and technical support from phone, text message, email, chat and web forms for every CareMetric application, in one queue.</p></div>
      <div className="communications-actions">
        {admin && <><button className="button button-secondary" type="button" disabled={busy} onClick={() => void sync("breathe.phone")}><Phone size={15} aria-hidden="true" />Import phone-line messages</button>
          <button className="button button-secondary" type="button" disabled={busy} onClick={() => void sync("advisors.web")}><Globe2 size={15} aria-hidden="true" />Import Advisors requests</button></>}
        <button className="button button-secondary" type="button" onClick={refresh}><RefreshCw size={15} aria-hidden="true" />Refresh</button>
      </div></div>
    <ChannelStrip status={status} />
    {notice && <p className="communications-notice" role="status">{notice}</p>}
    {error && <p className="communications-error" role="alert">{error}</p>}
    <div className="communications-filters">
      <label>Status<select value={filter.status} onChange={event => { setOffset(0); setFilter(value => ({ ...value, status: event.target.value as typeof filter.status })); }}>
        <option value="active">Needs attention</option>{conversationStatuses.map(item => <option key={item} value={item}>{statusLabels[item]}{page?.statusCounts[item] ? ` (${page.statusCounts[item]})` : ""}</option>)}<option value="">All</option></select></label>
      <label>Channel<select value={filter.channel} onChange={event => { setOffset(0); setFilter(value => ({ ...value, channel: event.target.value as Channel | "" })); }}>
        <option value="">All channels</option>{channels.map(item => <option key={item} value={item}>{channelLabels[item]}</option>)}</select></label>
      <label>Application<select value={filter.productId} onChange={event => { setOffset(0); setFilter(value => ({ ...value, productId: event.target.value })); }}>
        <option value="">All applications</option>{products.map(product => <option key={product.id} value={product.id}>{product.name}</option>)}</select></label>
      <form onSubmit={search}><label>Search<span className="communications-search"><Search size={15} aria-hidden="true" /><input type="search" maxLength={100} value={searchInput} placeholder="Name, email, phone, organization or CM-1001" onChange={event => setSearchInput(event.target.value)} /></span></label></form>
    </div>
    <div className="communications-layout">
      <section className="panel communications-list" aria-label="Conversations">
        {!page && !error && <p role="status">Loading conversations…</p>}
        {page && page.items.length === 0 && <p className="communications-empty">No conversations match these filters.</p>}
        {page?.items.map(item => { const Icon = channelIcons[item.channel]; return <button key={item.id} type="button" className={`communications-row${selected === item.id ? " active" : ""}`} aria-pressed={selected === item.id} onClick={() => setSelected(item.id)}>
          <Icon size={17} aria-hidden="true" /><span><strong>{item.subject}</strong><small>{item.contactName ?? item.contactEmail ?? item.contactPhone ?? "Unidentified contact"} · {item.productId ? productName.get(item.productId) ?? "Application" : "Application not set"}</small></span>
          <span className={`communications-status status-${item.status}`}>{statusLabels[item.status]}</span><time dateTime={item.lastMessageAt}>{when(item.lastMessageAt)}</time></button>; })}
        {page && page.total > pageSize && <div className="admin-pagination"><span>{offset + 1}–{Math.min(offset + pageSize, page.total)} of {page.total}</span><div>
          <button className="button button-secondary button-small" type="button" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - pageSize))}>Previous</button>
          <button className="button button-secondary button-small" type="button" disabled={offset + pageSize >= page.total} onClick={() => setOffset(offset + pageSize)}>Next</button></div></div>}
      </section>
      <section className="panel communications-thread" aria-label="Conversation">
        {!thread || thread.id !== selected ? <p className="communications-empty">Choose a conversation to read it and reply.</p>
          : <ThreadView key={thread.id} thread={thread} products={products} actorId={actor.id} status={status} busy={busy} client={client} act={act} />}
      </section>
    </div>
  </div>;
}

function ChannelStrip({ status }: { status: ChannelStatus | null }) {
  const items = status ? [
    { label: "Phone line (877) 521-2890", detail: "Imported from the AI phone assistant", ready: status.phone.sync },
    { label: "Text messages", detail: status.sms.inbound ? status.sms.replies ? "Receiving and replying" : "Receiving · replies not configured" : "Not connected", ready: status.sms.inbound },
    { label: "Email", detail: status.email.inbound ? status.email.replies ? "Receiving and replying" : "Receiving · replies not configured" : "Not connected", ready: status.email.inbound },
    { label: "Website chat", detail: status.chat.enabled ? "On every Help page" : "Off until the owner enables it", ready: status.chat.enabled },
    { label: "Advisors web form", detail: "Imported from caremetricadvisors.com", ready: status.webForm.sync },
  ] : [];
  return <section className="communications-channels" aria-label="Channel status">{items.map(item => <div key={item.label} className={item.ready ? "ready" : "pending"}><strong>{item.label}</strong><span>{item.detail}</span></div>)}</section>;
}

function ThreadView({ thread, products, actorId, status, busy, client, act }: { thread: ConversationThread; products: Product[]; actorId: string; status: ChannelStatus | null; busy: boolean; client: CommunicationsClient; act: (work: () => Promise<string>) => Promise<void> }) {
  const [reply, setReply] = useState("");
  const [note, setNote] = useState("");
  // One request key per message; a retried send reuses it so the server never records or sends twice.
  const [replyKey, setReplyKey] = useState(() => crypto.randomUUID());
  const [noteKey, setNoteKey] = useState(() => crypto.randomUUID());
  const route = replyRoute(thread, status);
  const update = (change: Partial<Parameters<CommunicationsClient["update"]>[0]>) => act(async () => { await client.update({ id: thread.id, expectedUpdatedAt: thread.updatedAt, ...change }); return "Conversation updated."; });
  const ChannelIcon = channelIcons[thread.channel];
  return <>
    <header className="communications-thread-header">
      <div><span className="eyebrow"><ChannelIcon size={14} aria-hidden="true" /> {channelLabels[thread.channel]} · CM-{thread.reference}</span><h2>{thread.subject}</h2>
        <p>{[thread.contactName, thread.organization, thread.contactEmail, thread.contactPhone].filter(Boolean).join(" · ") || "No contact details were provided."}</p>
        <p className="communications-privacy">Contact details are self-reported and do not verify an account. This conversation may contain patient information: do not copy it elsewhere.</p></div>
      <div className="communications-controls">
        <label>Status<select value={thread.status} disabled={busy} onChange={event => void update({ status: event.target.value as ConversationStatus })}>{conversationStatuses.map(item => <option key={item} value={item}>{statusLabels[item]}</option>)}</select></label>
        <label>Type<select value={thread.inquiryType} disabled={busy} onChange={event => void update({ inquiryType: event.target.value as InquiryType })}>{inquiryTypes.map(item => <option key={item} value={item}>{inquiryLabels[item]}</option>)}</select></label>
        <label>Application<select value={thread.productId ?? ""} disabled={busy} onChange={event => void update({ changeProduct: true, productId: event.target.value || null })}><option value="">Not set</option>{products.map(product => <option key={product.id} value={product.id}>{product.name}</option>)}</select></label>
        <div className="communications-assignee"><span>{thread.assignedToName ? `Assigned to ${thread.assignedToName}` : "Unassigned"}</span>
          {thread.assignedTo === actorId ? <button className="button button-secondary button-small" type="button" disabled={busy} onClick={() => void update({ changeAssignment: true, assignedTo: null })}>Unassign</button>
            : <button className="button button-secondary button-small" type="button" disabled={busy} onClick={() => void update({ changeAssignment: true, assignedTo: actorId })}>Assign to me</button>}</div>
      </div>
    </header>
    <ol className="communications-messages">{thread.messages.map(message => <li key={message.id} className={`message-${message.direction}`}>
      <div><strong>{message.direction === "inbound" ? thread.contactName ?? "Customer" : message.authorName ?? "CareMetric Support"}</strong>{message.direction === "note" && <span className="communications-tag">Internal note</span>}<time dateTime={message.createdAt}>{when(message.createdAt)}</time></div>
      <p>{message.body}</p>{message.direction === "outbound" && <small>{message.deliveryChannel ? `${channelLabels[message.deliveryChannel]} · ` : ""}{deliveryLabels[message.delivery] ?? message.delivery}</small>}</li>)}</ol>
    <form className="communications-compose" onSubmit={event => { event.preventDefault(); if (reply.trim()) void act(async () => { const result = await client.reply(thread.id, reply, replyKey); setReply(""); setReplyKey(crypto.randomUUID()); return result.delivery === "sent" ? "Reply sent." : result.delivery === "failed" ? "The provider rejected this reply. Check the contact details." : "The reply was recorded but delivery is not confirmed. Do not resend automatically."; }); }}>
      <label htmlFor="communication-reply">{route.label}</label>
      <textarea id="communication-reply" maxLength={5000} value={reply} disabled={!route.available || busy} onChange={event => setReply(event.target.value)} placeholder="Write a reply without patient information." />
      <button className="button button-primary" type="submit" disabled={!route.available || busy || !reply.trim()}><Send size={15} aria-hidden="true" />Send reply</button>
    </form>
    <form className="communications-compose" onSubmit={event => { event.preventDefault(); if (note.trim()) void act(async () => { await client.note(thread.id, note, noteKey); setNote(""); setNoteKey(crypto.randomUUID()); return "Internal note saved."; }); }}>
      <label htmlFor="communication-note">Internal note — never shown to the customer</label>
      <textarea id="communication-note" maxLength={5000} value={note} disabled={busy} onChange={event => setNote(event.target.value)} placeholder="Record a callback, a decision, or a handoff." />
      <button className="button button-secondary" type="submit" disabled={busy || !note.trim()}><StickyNote size={15} aria-hidden="true" />Save note</button>
    </form>
  </>;
}
