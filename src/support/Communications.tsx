import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Mail, MessageCircle, MessageSquareText, Phone, RefreshCw, Search, Send, StickyNote, Globe2 } from "lucide-react";
import type { Product } from "../domain";
import {
  channelLabels, channels, communicationsClient, conversationStatuses, deliveryLabels, describeChannels, inquiryLabels, inquiryTypes, replyRoute, statusLabels,
  type Channel, type ChannelStatus, type CommunicationsClient, type ConversationPage, type ConversationStatus, type ConversationThread, type InquiryType, type SyncSource,
} from "./communicationsClient";
import "./communications.css";

const channelIcons: Record<Channel, typeof Phone> = { phone: Phone, sms: MessageSquareText, email: Mail, chat: MessageCircle, web_form: Globe2 };
const when = (value: string) => new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value));
const pageSize = 25;
const sourceLabels: Record<SyncSource, string> = { "breathe.phone": "Phone line", "advisors.web": "Advisors consultation form" };

/**
 * A request key bound to the exact text it was first sent with. Retrying the same
 * text reuses the key, so a lost response never records or sends twice. Changed
 * text after an unconfirmed attempt is sent only as an explicit new message.
 */
function useRequestKey() {
  const [attempt, setAttempt] = useState<{ key: string; body: string } | null>(null);
  return {
    pending: attempt,
    changed: (body: string) => attempt !== null && attempt.body !== body,
    keyFor(body: string, asNew: boolean) {
      const next = !asNew && attempt?.body === body ? attempt : { key: crypto.randomUUID(), body };
      setAttempt(next);
      return next.key;
    },
    settle: () => setAttempt(null),
  };
}

/** Filters a link can open the inbox with, for example the control center's "3 texts waiting" link. */
export interface CommunicationsFilter { status?: ConversationStatus | "active" | ""; channel?: Channel | ""; productId?: string }

export function Communications({ products, actor, client = communicationsClient, initialFilter }: { products: Product[]; actor: { id: string; role: string }; client?: CommunicationsClient; initialFilter?: CommunicationsFilter }) {
  const [filter, setFilter] = useState<{ status: ConversationStatus | "active" | ""; channel: Channel | ""; productId: string; search: string }>({ status: initialFilter?.status ?? "active", channel: initialFilter?.channel ?? "", productId: initialFilter?.productId ?? "", search: "" });
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
  const [resume, setResume] = useState<Partial<Record<SyncSource, number>>>({});
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
      .then(result => {
        setPage(result); setError("");
        // A refreshed total can end before this page (for example after closing its last conversation): move to the last page.
        if (result.items.length === 0 && offset > 0) setOffset(Math.max(0, Math.floor((result.total - 1) / pageSize) * pageSize));
      })
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
  const sync = (source: SyncSource, from = 0) => act(async () => {
    const result = await client.sync(source, from);
    setResume(value => ({ ...value, [source]: result.nextOffset ?? undefined }));
    return `${sourceLabels[source]}: ${result.created} new, ${result.skipped} already in the Hub.${result.nextOffset === null ? "" : " More remain: import the next batch."}`;
  });
  function search(event: FormEvent) { event.preventDefault(); setOffset(0); setFilter(value => ({ ...value, search: searchInput.trim() })); }

  return <div className="communications">
    <div className="page-heading"><div><span className="eyebrow">Every channel · every application</span><h1>Communications</h1>
      <p>Customer service and technical support for CareBase, Breathe, and Intel, in one queue.</p></div>
      <div className="communications-actions">
        {admin && <><button className="button button-secondary" type="button" disabled={busy} onClick={() => void sync("breathe.phone")}><Phone size={15} aria-hidden="true" />Import phone-line messages</button>
          {resume["breathe.phone"] !== undefined && <button className="button button-secondary" type="button" disabled={busy} onClick={() => void sync("breathe.phone", resume["breathe.phone"])}>Import the next phone-line batch</button>}
        </>}
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
  const items = status ? describeChannels(status) : [];
  return <section className="communications-channels" aria-label="Channel status">{items.map(item => <div key={item.channel} className={item.ready ? "ready" : "pending"}><strong>{item.label}</strong><span>{item.detail}</span></div>)}</section>;
}

function ThreadView({ thread, products, actorId, status, busy, client, act }: { thread: ConversationThread; products: Product[]; actorId: string; status: ChannelStatus | null; busy: boolean; client: CommunicationsClient; act: (work: () => Promise<string>) => Promise<void> }) {
  const [reply, setReply] = useState("");
  const [note, setNote] = useState("");
  const replyKey = useRequestKey(), noteKey = useRequestKey();
  const route = replyRoute(thread, status);
  const update = (change: Partial<Parameters<CommunicationsClient["update"]>[0]>) => act(async () => { await client.update({ id: thread.id, expectedUpdatedAt: thread.updatedAt, ...change }); return "Conversation updated."; });
  const ChannelIcon = channelIcons[thread.channel];
  const replyAsNew = replyKey.changed(reply), noteAsNew = noteKey.changed(note);
  const sendReply = () => act(async () => {
    const result = await client.reply(thread.id, reply, replyKey.keyFor(reply, replyAsNew));
    replyKey.settle(); setReply("");
    return result.delivery === "sent" ? "Reply sent." : result.delivery === "failed" ? "The provider rejected this reply. Check the contact details." : "The reply was recorded but delivery is not confirmed. Do not resend automatically.";
  });
  const saveNote = () => act(async () => { await client.note(thread.id, note, noteKey.keyFor(note, noteAsNew)); noteKey.settle(); setNote(""); return "Internal note saved."; });
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
    <form className="communications-compose" onSubmit={event => { event.preventDefault(); if (reply.trim()) void sendReply(); }}>
      <label htmlFor="communication-reply">{route.label}</label>
      <textarea id="communication-reply" maxLength={5000} value={reply} disabled={!route.available || busy} onChange={event => setReply(event.target.value)} placeholder="Write a reply without patient information." />
      {replyAsNew && <UnconfirmedAttempt kind="reply" disabled={busy} onRestore={() => setReply(replyKey.pending?.body ?? "")} />}
      <button className="button button-primary" type="submit" disabled={!route.available || busy || !reply.trim()}><Send size={15} aria-hidden="true" />{replyAsNew ? "Send as a new message" : "Send reply"}</button>
    </form>
    <form className="communications-compose" onSubmit={event => { event.preventDefault(); if (note.trim()) void saveNote(); }}>
      <label htmlFor="communication-note">Internal note — never shown to the customer</label>
      <textarea id="communication-note" maxLength={5000} value={note} disabled={busy} onChange={event => setNote(event.target.value)} placeholder="Record a callback, a decision, or a handoff." />
      {noteAsNew && <UnconfirmedAttempt kind="note" disabled={busy} onRestore={() => setNote(noteKey.pending?.body ?? "")} />}
      <button className="button button-secondary" type="submit" disabled={busy || !note.trim()}><StickyNote size={15} aria-hidden="true" />{noteAsNew ? "Save as a new note" : "Save note"}</button>
    </form>
  </>;
}

/** Shown when the text changed after an attempt whose outcome was not confirmed. */
function UnconfirmedAttempt({ kind, disabled, onRestore }: { kind: "reply" | "note"; disabled: boolean; onRestore: () => void }) {
  return <p className="communications-warning" role="status">
    The last {kind} may already have been saved{kind === "reply" ? " or sent" : ""}. Check the conversation above. To retry it safely, restore the original text; otherwise this text is saved as a separate {kind === "reply" ? "message" : "note"}.
    <button className="button button-secondary button-small" type="button" disabled={disabled} onClick={onRestore}>Restore the original text</button>
  </p>;
}
