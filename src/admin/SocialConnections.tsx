import { useCallback, useRef, useState } from "react";
import { ExternalLink, LockKeyhole, RefreshCw } from "lucide-react";
import { Loading, ReadFailure } from "./AdminReads";
import { useAdminRead } from "./useAdminRead";
import { SettingsApiError } from "./settingsClient";
import { socialConnectionsClient } from "./socialConnectionsClient";
import type { SocialConnection, SocialConnectionsClient, SocialProvider } from "./socialConnectionsClient";

type Field = { key: string; label: string; hint: string; placeholder?: string; secret?: boolean };
const meta: Field[] = [
  { key: "pageId", label: "Facebook Page ID or profile link", hint: "In your Page’s About → Page transparency, copy the numeric Page ID. A facebook.com/profile.php?id=… link also works.", placeholder: "Page ID or Facebook profile link" },
  { key: "token", label: "Meta access token", hint: "In Meta Business Settings → Users → System users, assign your Page, then generate a token for your app. Paste the token here.", secret: true },
];
const linkedin: Field[] = [
  { key: "organizationId", label: "LinkedIn Company Page ID or admin link", hint: "Open your Company Page as an admin and copy its link. Use the numeric /company/123456/admin/ link, not the public name link.", placeholder: "Company Page ID or admin link" },
  { key: "token", label: "LinkedIn access token", hint: "In LinkedIn Developers → your app → Tools → OAuth token tools, generate a token as a Page administrator. The app needs Community Management API access.", secret: true },
];
const advanced: Record<SocialProvider, Field[]> = {
  meta: [
    { key: "instagramId", label: "Instagram professional account ID", hint: "Optional numeric account ID for the professional Instagram account linked to your Facebook Page. This is different from your @username." },
    { key: "adAccountId", label: "Meta ad account ID", hint: "Optional. Copy it from Business Settings → Accounts → Ad accounts. A number with or without act_ works." },
  ],
  linkedin: [
    { key: "clientId", label: "LinkedIn app client ID", hint: "Optional automatic renewal: copy from your app’s Auth tab, together with the client secret and a refresh token if LinkedIn issued one." },
    { key: "clientSecret", label: "LinkedIn app client secret", hint: "Used only for token renewal.", secret: true },
    { key: "refreshToken", label: "LinkedIn refresh token", hint: "Only available for eligible apps. Without renewal credentials, replace the access token when it expires.", secret: true },
    { key: "adAccountId", label: "LinkedIn ad account ID", hint: "Optional numeric account ID from Campaign Manager. Advertising API access is required." },
    { key: "adsToken", label: "LinkedIn advertising access token", hint: "Optional separate token if your advertising app is different from your Page app.", secret: true },
    { key: "adsClientId", label: "LinkedIn advertising client ID", hint: "Optional client ID for the separate advertising app." },
    { key: "adsClientSecret", label: "LinkedIn advertising client secret", hint: "Optional renewal secret for the advertising app.", secret: true },
    { key: "adsRefreshToken", label: "LinkedIn advertising refresh token", hint: "Optional refresh token for the advertising app.", secret: true },
  ],
};

function ConnectionCard({ initial, editable, client }: { initial: SocialConnection; editable: boolean; client: SocialConnectionsClient }) {
  const [connection, setConnection] = useState(initial);
  const [fields, setFields] = useState(() => Object.fromEntries(Object.entries(initial.fields).map(([key, field]) => [key, field.value])));
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [remove, setRemove] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const changing = useRef(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const provider = connection.provider;
  const name = provider === "meta" ? "Meta" : "LinkedIn";
  const dirty = Object.entries(fields).some(([key, value]) => value !== connection.fields[key]?.value)
    || Object.values(secrets).some(value => value.trim()) || Object.values(remove).some(Boolean);
  const update = (work: () => void) => { setNotice(null); work(); };

  async function run(save: boolean) {
    if (changing.current) return;
    changing.current = true; setBusy(true); setNotice(null);
    let committed = false;
    try {
      if (save) {
        await client.save({ provider, revision: connection.revision,
          fields: Object.fromEntries(Object.entries(connection.fields).map(([key, field]) => [key, { value: fields[key] ?? "", changedAt: field.changedAt }])),
          secrets: Object.fromEntries([...new Set([...Object.keys(secrets), ...Object.keys(remove)])].flatMap<[string, string | null]>(key => remove[key] ? [[key, null]] : secrets[key]?.trim() ? [[key, secrets[key]]] : [])),
        });
        committed = true;
        setSecrets({}); setRemove({}); // Never retain an entered token after a confirmed save.
        setNotice({ ok: true, text: "Saved securely. Checking read access…" });
        const view = await client.view(AbortSignal.timeout(30000));
        const next = view.connections.find(item => item.provider === provider);
        if (!next) throw new Error("Connection unavailable.");
        setConnection(next); setFields(Object.fromEntries(Object.entries(next.fields).map(([key, field]) => [key, field.value])));
      }
      const checked = await client.check(provider);
      setNotice({ ok: checked.ok, text: `${committed ? "Saved securely. " : ""}${checked.message}` });
    } catch (error) {
      const detail = error instanceof SettingsApiError ? error.message : "The result could not be confirmed. Refresh the connections and try again.";
      setNotice({ ok: false, text: `${committed ? "Your details were saved, but the connection check could not finish. " : ""}${detail}` });
    } finally { changing.current = false; setBusy(false); }
  }
  function field(item: Field) {
    const id = `social-${provider}-${item.key}`;
    const saved = item.secret && connection.secrets[item.key];
    return <div className="social-connection-field" key={item.key}>
      <label htmlFor={id}>{item.label}</label>
      <input id={id} type={item.secret ? "password" : "text"} autoComplete="off" spellCheck={false}
        value={item.secret ? secrets[item.key] ?? "" : fields[item.key] ?? ""} maxLength={item.secret ? 8192 : 1000}
        disabled={busy || !editable || (item.secret && remove[item.key])} aria-describedby={`${id}-help`}
        placeholder={saved ? "Saved — leave blank to keep" : item.placeholder ?? (item.secret ? "Paste token or secret" : "Optional")}
        onChange={event => update(() => item.secret ? setSecrets(old => ({ ...old, [item.key]: event.target.value })) : setFields(old => ({ ...old, [item.key]: event.target.value })))} />
      <small id={`${id}-help`} className="muted">{item.hint}{saved ? " A credential is saved; its value stays hidden." : ""}</small>
      {saved && <label className="social-remove"><input type="checkbox" checked={remove[item.key] ?? false} disabled={busy || !editable}
        onChange={event => update(() => setRemove(old => ({ ...old, [item.key]: event.target.checked })))} />Remove saved {item.label.toLowerCase()} on save</label>}
    </div>;
  }
  return <form className="social-connection-card" aria-label={`${name} connection`} onSubmit={event => { event.preventDefault(); void run(true); }}>
    <div className="social-connection-heading"><div><h3>{name === "Meta" ? "Meta · Facebook & Instagram" : "LinkedIn · Company Page"}</h3>
      <p className="muted">{connection.secrets.token ? "Credential saved" : "Ready for your connection details"}</p></div>
      <a href={provider === "meta" ? "https://business.facebook.com/settings/" : "https://www.linkedin.com/developers/apps"} target="_blank" rel="noreferrer">Open {name} setup <ExternalLink size={13} aria-hidden="true" /></a></div>
    {(provider === "meta" ? meta : linkedin).map(field)}
    <details className="social-advanced"><summary>Advanced · {provider === "meta" ? "Instagram and advertising" : "automatic renewal and advertising"}</summary>{advanced[provider].map(field)}</details>
    <div className="button-row">
      <button className="button button-primary" type="submit" aria-label={busy ? `Working on ${name}` : `Save and check ${name}`} disabled={busy || !editable}>{busy ? "Working…" : "Save and check"}</button>
      <button className="button button-secondary" type="button" aria-label={`Check saved connection ${name}`} disabled={busy || !editable || dirty} onClick={() => void run(false)}>Check saved connection</button>
    </div>
    {notice && <p role={notice.ok ? "status" : "alert"} className={notice.ok ? "admin-explanation" : "form-message form-error"}>{notice.text}</p>}
  </form>;
}

export function SocialConnections({ client = socialConnectionsClient }: { client?: SocialConnectionsClient }) {
  const [refresh, setRefresh] = useState(0);
  const read = useCallback((signal: AbortSignal) => { void refresh; return client.view(signal); }, [client, refresh]);
  const state = useAdminRead(read);
  return <div className="social-connections">
    <p><LockKeyhole size={16} aria-hidden="true" /> Connect your Pages in three steps: open the provider’s setup, paste the Page ID and access token, then choose <strong>Save and check</strong>.</p>
    <p className="muted">Tokens are encrypted before storage and never shown again. Signing in to Meta or LinkedIn alone does not grant the Hub API access. Connection checks read account data; posts and ad changes keep the AI team’s existing approval rules.</p>
    <button type="button" className="button button-secondary button-small" onClick={() => setRefresh(value => value + 1)} disabled={state.status === "loading"}><RefreshCw size={14} aria-hidden="true" /> Refresh connections</button>
    {state.status === "loading" && <Loading label="Loading social connections" app="Hub" />}
    {state.status === "error" && <ReadFailure error={state.error} retry={() => setRefresh(value => value + 1)} />}
    {state.status === "ready" && <>
      {state.data.message && <p role="status" className="admin-explanation">{state.data.message}</p>}
      <div className="social-connection-grid">{state.data.connections.map(connection => <ConnectionCard key={`${refresh}:${connection.provider}`} initial={connection} editable={state.data.editable} client={client} />)}</div>
    </>}
  </div>;
}
