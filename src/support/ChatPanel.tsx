import { useEffect, useRef, useState, type FormEvent } from "react";
import { MessageCircle, Send } from "lucide-react";
import { chatClient, type ChatClient, type ChatThread } from "./communicationsClient";
import "./communications.css";

/** Website chat with the CareMetric support team. Staff answer from the Hub's Communications inbox. */
export function ChatPanel({ productSlug, productName, client = chatClient, available = true }: { productSlug?: string; productName?: string; client?: ChatClient; available?: boolean }) {
  const [thread, setThread] = useState<ChatThread | null>(null);
  const [checked, setChecked] = useState(false);
  const [form, setForm] = useState({ name: "", email: "", message: "", noPhi: false });
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [retry, setRetry] = useState(0);
  const version = useRef(0);
  const sending = useRef(false);

  useEffect(() => {
    if (!available) return;
    const controller = new AbortController();
    let loading = false;
    // An open chat stays readable; new chats start only when the owner has enabled chat.
    void client.availability(controller.signal).then(value => setEnabled(value.chat)).catch(() => { if (!controller.signal.aborted) setEnabled(false); });
    const load = async () => {
      if (loading || sending.current) return;
      loading = true;
      const request = version.current;
      try {
        const next = await client.thread(controller.signal);
        if (!controller.signal.aborted && request === version.current) { setThread(next); setLoadError(""); setChecked(true); }
      } catch {
        if (!controller.signal.aborted && request === version.current) {
          setLoadError("Your chat could not be refreshed. Your conversation is still saved. Please try again.");
          setChecked(true);
        }
      } finally { loading = false; }
    };
    void load();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, 10000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [client, available, retry]);

  /** Runs one action; text the action returns is shown as a load error (the chat exists but cannot be shown), which offers Retry. */
  async function run(work: () => Promise<string | void>) {
    if (sending.current) return;
    sending.current = true;
    version.current += 1;
    setBusy(true); setError("");
    try { setLoadError((await work()) ?? ""); } catch (cause) { setError(cause instanceof Error ? cause.message : "Your message could not be sent. Please try again or call (877) 521-2890."); }
    finally { sending.current = false; setBusy(false); }
  }
  function start(event: FormEvent) {
    event.preventDefault();
    if (!form.noPhi) { setError("Confirm that your message contains no patient information."); return; }
    void run(async () => {
      await client.start({ name: form.name, email: form.email, message: form.message, noPhi: true, ...(productSlug ? { product: productSlug } : {}) });
      // Every start is a new conversation: once this one exists, the form must not come back to send it again.
      setForm(value => ({ ...value, message: "" }));
      try { setThread(await client.thread()); }
      catch { return "Your chat was started, but it could not be shown just now. It is saved. Please try again."; }
    });
  }
  function send(event: FormEvent) {
    event.preventDefault();
    if (message.trim()) void run(async () => { setThread(await client.send(message)); setMessage(""); });
  }

  return <section className="panel chat-panel" aria-labelledby="chat-heading">
    <h2 id="chat-heading"><MessageCircle size={19} aria-hidden="true" /> Chat with CareMetric support</h2>
    {!available ? <p>Chat opens here in the connected Hub. In this preview, use the phone number or support form.</p>
      : !checked ? <p role="status">Checking for an open chat…</p>
      : thread ? <>
        <p className="chat-reference">Reference CM-{thread.reference}{thread.status === "closed" ? " · closed" : ""}. A team member will answer here. Replies are not emailed: keep this page open, or come back to Help in this browser to read them.</p>
        <ol className="chat-messages" aria-live="polite">{thread.messages.map(item => <li key={item.id} className={`chat-${item.from}`}><strong>{item.from === "visitor" ? "You" : "CareMetric Support"}</strong><p>{item.body}</p></li>)}</ol>
        {thread.status === "closed"
          ? <button className="button button-secondary" type="button" disabled={busy} onClick={() => void run(async () => { await client.end(); setThread(null); })}>Start a new chat</button>
          : <form className="chat-compose" onSubmit={send}><label htmlFor="chat-message">Your message</label>
            <textarea id="chat-message" maxLength={4000} value={message} onChange={event => setMessage(event.target.value)} />
            <button className="button button-primary" type="submit" disabled={busy || !message.trim()}><Send size={15} aria-hidden="true" />Send</button></form>}
      </>
      : loadError ? null
      : !enabled ? <p>Chat is not available yet. Call (877) 521-2890, email support@caremetric.ai, or open a support request.</p>
      : <form className="chat-start" onSubmit={start}>
        <p>Ask about {productName ?? "any CareMetric application"}. Business hours replies usually arrive the same day.</p>
        <label>Name<input required maxLength={160} autoComplete="name" value={form.name} onChange={event => setForm(value => ({ ...value, name: event.target.value }))} /></label>
        <label>Email<input required type="email" maxLength={320} autoComplete="email" value={form.email} onChange={event => setForm(value => ({ ...value, email: event.target.value }))} /></label>
        <label>Question<textarea required maxLength={4000} value={form.message} onChange={event => setForm(value => ({ ...value, message: event.target.value }))} /></label>
        <label className="chat-consent"><input type="checkbox" checked={form.noPhi} onChange={event => setForm(value => ({ ...value, noPhi: event.target.checked }))} />My message contains no patient names, identifiers or clinical details.</label>
        <button className="button button-primary" type="submit" disabled={busy}>Start chat</button>
      </form>}
    {error && <p className="communications-error" role="alert">{error}</p>}
    {loadError && <div role="alert"><p>{loadError}</p><button type="button" className="button button-secondary" disabled={busy} onClick={() => setRetry(value => value + 1)}>Retry chat</button></div>}
  </section>;
}
