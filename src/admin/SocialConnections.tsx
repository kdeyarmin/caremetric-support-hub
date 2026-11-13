import { useCallback, useRef, useState } from "react";
import { LockKeyhole, RefreshCw } from "lucide-react";
import { Loading, ReadFailure } from "./AdminReads";
import { useAdminRead } from "./useAdminRead";
import { SettingsApiError } from "./settingsClient";
import { socialConnectionsClient } from "./socialConnectionsClient";
import { SocialSetupGuide } from "./SocialSetupGuide";
import type { SocialConnection, SocialConnectionsClient, SocialProvider } from "./socialConnectionsClient";

type Field = { key: string; label: string; hint: string; placeholder?: string; secret?: boolean };
const meta: Field[] = [
  { key: "pageId", label: "Facebook Page ID", hint: "The number shown for your Page in Meta Business Suite → Settings → Accounts → Pages. A Page address ending in profile.php?id=… is also accepted; do not use your personal profile.", placeholder: "Example: 123456789" },
  { key: "token", label: "Meta system user access token", hint: "The token generated in Business Suite → Settings → Users → System users (setup step 4). This is a secret code that authorizes the Hub, not your Facebook password.", placeholder: "Paste the generated system user token", secret: true },
];
const linkedin: Field[] = [
  { key: "organizationId", label: "LinkedIn Company Page ID", hint: "The number in your Company Page’s admin address: linkedin.com/company/123456/admin/ means ID 123456. Your full numeric admin address is also accepted. Do not enter an email or personal profile.", placeholder: "Example: 123456 or your Company Page admin address" },
  { key: "token", label: "LinkedIn access token", hint: "Use Copy token in LinkedIn’s OAuth Token Tools after authorizing your approved app (setup step 4). This is not your password, app client ID or client secret.", placeholder: "Paste the value from Copy token", secret: true },
];
const advanced: Record<SocialProvider, Field[]> = {
  meta: [
    { key: "instagramId", label: "Instagram professional account ID", hint: "Copy the id inside instagram_business_account from the lookup described above. It is different from your @username and Facebook Page ID." },
    { key: "adAccountId", label: "Meta ad account ID", hint: "Optional. Copy it from Business Settings → Accounts → Ad accounts. A number with or without act_ works." },
  ],
  linkedin: [
    { key: "clientId", label: "LinkedIn app client ID", hint: "Copy from the same app’s Auth tab. Only needed here when LinkedIn has also issued a refresh token." },
    { key: "clientSecret", label: "LinkedIn app client secret", hint: "Used only for token renewal.", secret: true },
    { key: "refreshToken", label: "LinkedIn refresh token", hint: "Only available for eligible apps. Without renewal credentials, replace the access token when it expires.", secret: true },
    { key: "adAccountId", label: "LinkedIn ad account ID", hint: "Optional numeric account ID from Campaign Manager. Advertising API access is required." },
    { key: "adsToken", label: "LinkedIn advertising access token", hint: "Use a token from your approved Advertising API app. Leave blank only if the Page token already has advertising access.", secret: true },
    { key: "adsClientId", label: "LinkedIn advertising client ID", hint: "Optional client ID for the separate advertising app." },
    { key: "adsClientSecret", label: "LinkedIn advertising client secret", hint: "Optional renewal secret for the advertising app.", secret: true },
    { key: "adsRefreshToken", label: "LinkedIn advertising refresh token", hint: "Optional refresh token for the advertising app.", secret: true },
    { key: "memberToken", label: "Your personal LinkedIn access token", hint: "Optional. Lets the posts written for your own LinkedIn profile publish once you approve each one. Generate it in OAuth Token Tools for an app with the Share on LinkedIn and Sign In with LinkedIn using OpenID Connect products (scopes openid, profile and w_member_social). It lasts about 60 days; without it the posts are emailed for you to copy.", secret: true },
  ],
};

function ConnectionCard({ initial, editable, client }: { initial: SocialConnection; editable: boolean; client: SocialConnectionsClient }) {
  const [connection, setConnection] = useState(initial);
  const [fields, setFields] = useState(() => Object.fromEntries(Object.entries(initial.fields).map(([key, field]) => [key, field.value])));
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [remove, setRemove] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const changing = useRef(false);
  const pageInput = useRef<HTMLInputElement>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [verification, setVerification] = useState<"unchecked" | "verified" | "rejected">("unchecked");
  const provider = connection.provider;
  const name = provider === "meta" ? "Meta" : "LinkedIn";
  const pageKey = provider === "meta" ? "pageId" : "organizationId";
  const emailInPageField = /^[^\s/@]+@[^\s/@]+$/.test((fields[pageKey] ?? "").trim());
  const pageError = emailInPageField ? `That looks like an email address. Enter your ${name === "Meta" ? "Facebook Page’s numeric ID" : "Company Page’s numeric ID or admin address"}. Keep your sign-in email and password on ${name}.` : null;
  const dirty = Object.entries(fields).some(([key, value]) => value !== connection.fields[key]?.value)
    || Object.values(secrets).some(value => value.trim()) || Object.values(remove).some(Boolean);
  const update = (work: () => void) => { setNotice(null); setVerification("unchecked"); work(); };

  async function run(save: boolean) {
    if (changing.current) return;
    if (save && pageError) { setNotice(null); pageInput.current?.focus(); return; }
    changing.current = true; setBusy(true); setNotice(null);
    setVerification("unchecked");
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
      setVerification(checked.ok ? "verified" : "rejected");
      setNotice({ ok: checked.ok, text: `${committed ? "Saved securely. " : ""}${checked.message}` });
    } catch (error) {
      const detail = error instanceof SettingsApiError ? error.message : "The result could not be confirmed. Refresh the connections and try again.";
      setNotice({ ok: false, text: `${committed ? "Your details were saved, but the connection check could not finish. " : ""}${detail}` });
    } finally { changing.current = false; setBusy(false); }
  }
  function field(item: Field) {
    const id = `social-${provider}-${item.key}`;
    const saved = item.secret && connection.secrets[item.key];
    const error = item.key === pageKey ? pageError : null;
    return <div className="social-connection-field" key={item.key}>
      <label htmlFor={id}>{item.label}</label>
      <input id={id} name={`integration_${provider}_${item.key}`} ref={item.key === pageKey ? pageInput : undefined}
        type={item.secret ? "password" : "text"} autoComplete={item.secret ? "new-password" : "off"} autoCapitalize="none" spellCheck={false}
        data-lpignore="true" data-1p-ignore="true" data-bwignore="true" data-form-type="other"
        value={item.secret ? secrets[item.key] ?? "" : fields[item.key] ?? ""} maxLength={item.secret ? 8192 : 1000}
        disabled={busy || !editable || (item.secret && remove[item.key])} aria-invalid={Boolean(error)} aria-describedby={`${id}-help${error ? ` ${id}-error` : ""}`}
        placeholder={saved ? "Saved — leave blank to keep" : item.placeholder ?? (item.secret ? "Paste token or secret" : "Optional")}
        onChange={event => update(() => item.secret ? setSecrets(old => ({ ...old, [item.key]: event.target.value })) : setFields(old => ({ ...old, [item.key]: event.target.value })))} />
      <small id={`${id}-help`} className="muted">{item.hint}{saved ? " A credential is saved; its value stays hidden." : ""}</small>
      {error && <small id={`${id}-error`} className="form-message form-error" role="alert">{error}</small>}
      {saved && <label className="social-remove"><input type="checkbox" checked={remove[item.key] ?? false} disabled={busy || !editable}
        onChange={event => update(() => setRemove(old => ({ ...old, [item.key]: event.target.checked })))} />Remove saved {item.label.toLowerCase()} on save</label>}
    </div>;
  }
  return <form className="social-connection-card" autoComplete="off" data-lpignore="true" data-1p-ignore="true" aria-label={`${name} connection`} onSubmit={event => { event.preventDefault(); void run(true); }}>
    <div className="social-connection-heading"><div><h3>{name === "Meta" ? "Meta · Facebook & Instagram" : "LinkedIn · Company Page"}</h3>
      <p className="muted">{verification === "verified" ? "Read access verified" : verification === "rejected" ? "Connection needs attention" : connection.secrets.token ? "Access token saved · connection not checked" : "Connection not set up"}</p></div></div>
    <SocialSetupGuide provider={provider} onEnterDetails={() => pageInput.current?.focus()} />
    <h4 className="social-connection-details">Enter connection details</h4>
    {(provider === "meta" ? meta : linkedin).map(field)}
    {provider === "meta" ? <>
      <details className="social-advanced"><summary>Optional: add Instagram</summary>
        <p>Use a professional Instagram account linked to this Facebook Page. Assign it to the system user and include <code>instagram_basic</code>, <code>instagram_content_publish</code> and <code>instagram_manage_comments</code> when generating the Meta token.</p>
        <p>In <a href="https://developers.facebook.com/tools/explorer/" target="_blank" rel="noreferrer">Meta’s Graph API Explorer</a>, select your app, use that token, and run a <strong>GET</strong> request for <code>YOUR_PAGE_ID?fields=instagram_business_account</code>, replacing YOUR_PAGE_ID with your Facebook Page number. Copy the <code>id</code> inside <code>instagram_business_account</code>. If it is absent, check the Page’s linked Instagram account.</p>
        {advanced.meta.filter(item => item.key === "instagramId").map(field)}
      </details>
      <details className="social-advanced"><summary>Optional: add Meta advertising</summary>
        <p>Assign the ad account to the same system user and include <code>ads_read</code> and <code>ads_management</code> when generating its token. Complete Meta’s required app access review.</p>
        {advanced.meta.filter(item => item.key === "adAccountId").map(field)}
      </details>
    </> : <>
      <details className="social-advanced"><summary>Optional: renew LinkedIn tokens automatically</summary>
        <p>Fill in all three values only if LinkedIn has issued a refresh token for this app. A client ID and secret alone do not enable renewal. Otherwise, generate a replacement access token before its expiry date.</p>
        {advanced.linkedin.filter(item => ["clientId", "clientSecret", "refreshToken"].includes(item.key)).map(field)}
      </details>
      <details className="social-advanced"><summary>Optional: add LinkedIn advertising</summary>
        <p>First obtain <strong>Advertising API</strong> approval for your app and access to the ad account in Campaign Manager. For an app with Development access, add the ad account under <strong>Products → Advertising API → View settings</strong>.</p>
        <p>Generate a token with <code>r_ads</code>, <code>rw_ads</code>, <code>r_ads_reporting</code>, <code>r_organization_social</code> and <code>w_organization_social</code>. A separate advertising app can use the fields below.</p>
        {advanced.linkedin.filter(item => !["clientId", "clientSecret", "refreshToken"].includes(item.key)).map(field)}
      </details>
    </>}
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
    <p><LockKeyhole size={16} aria-hidden="true" /> Connect your business Pages so the Social Media Manager can use them. Start with either provider’s setup instructions below.</p>
    <p className="muted">Each connection needs a Page ID (the number identifying your business Page) and an access token (a secret code issued by the provider). These are different from your sign-in email and password. Provider app approval may be required before a usable token can be issued.</p>
    <p className="muted">The Hub encrypts saved tokens. Save and check tests read access; it does not publish a post or verify publishing permission.</p>
    <button type="button" className="button button-secondary button-small" onClick={() => setRefresh(value => value + 1)} disabled={state.status === "loading"}><RefreshCw size={14} aria-hidden="true" /> Refresh connections</button>
    {state.status === "loading" && <Loading label="Loading social connections" app="Hub" />}
    {state.status === "error" && <ReadFailure error={state.error} retry={() => setRefresh(value => value + 1)} />}
    {state.status === "ready" && <>
      {state.data.message && <p role="status" className="admin-explanation">{state.data.message}</p>}
      <div className="social-connection-grid">{state.data.connections.map(connection => <ConnectionCard key={`${refresh}:${connection.provider}`} initial={connection} editable={state.data.editable} client={client} />)}</div>
    </>}
  </div>;
}
