import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { RefreshCw, RotateCcw, Save, SlidersHorizontal } from "lucide-react";
import { Loading, ReadFailure } from "./AdminReads";
import { SettingsApiError, settingsClient } from "./settingsClient";
import type { HubSetting, SettingValue, SettingsClient, SettingsView } from "./settingsClient";
import { fieldText, fieldValue } from "./settingsFields";
import { timeLabel } from "./readState";
import { useAdminRead } from "./useAdminRead";
import { SocialConnections } from "./SocialConnections";
import { guidedSocialSettings } from "./socialConnectionsClient";
import "./admin.css";

type Notice = { ok: boolean; text: string } | null;

const failureText = (error: unknown) => error instanceof SettingsApiError ? error.message
  : "The change could not be confirmed. Refresh to see whether it was saved.";

/** A value in words, for the default and the saved message. */
function valueWords(setting: HubSetting, value: SettingValue): string {
  if (value === null || (Array.isArray(value) && value.length === 0)) return "none";
  if (setting.input === "toggle") return value === true ? "on" : "off";
  if (setting.input === "choice") return setting.choices?.find(choice => choice.value === value)?.label ?? String(value);
  if (setting.input === "cents" && typeof value === "number") return `$${(value / 100).toFixed(2)}`;
  if (Array.isArray(value)) return value.length === 1 ? "1 item" : `${value.length} items`;
  return setting.unit ? `${String(value)} ${setting.unit}` : String(value);
}

function sourceWords(setting: HubSetting, editable: boolean): string {
  if (!editable) return setting.source === "railway" ? `Read from the Railway variable ${setting.variable}.`
    : setting.variable ? `Not set in Railway: the default (${valueWords(setting, setting.default)}).` : `The default (${valueWords(setting, setting.default)}) until the settings migration is applied.`;
  const where = setting.source === "hub" ? "Saved here."
    : setting.source === "copied" ? `Copied in from the Railway variable ${setting.variable}.`
      : `Not set: the default applies (${valueWords(setting, setting.default)}).`;
  return setting.variableSet ? `${where} ${setting.variable} is still set in Railway but is no longer read: you can delete it.` : where;
}

const fieldId = (setting: HubSetting) => `setting-${setting.key.replace(".", "-")}`;

function SettingRow({ setting, editable, busy, onSave }: { setting: HubSetting; editable: boolean; busy: boolean; onSave: (setting: HubSetting, value: SettingValue) => void }) {
  const [draft, setDraft] = useState(() => fieldText(setting, setting.value ?? (setting.input === "choice" ? setting.effective : null)));
  const id = fieldId(setting);
  const text = <div className="settings-text">
    {setting.input === "toggle" ? <span id={`${id}-label`} className="settings-label">{setting.label}</span> : <label htmlFor={id} className="settings-label">{setting.label}</label>}
    <span className="muted" id={`${id}-help`}>{setting.help}</span>
    <small className="settings-source">{sourceWords(setting, editable)}</small>
  </div>;
  if (setting.input === "toggle") {
    const on = setting.effective === true;
    return <li className="settings-row">
      {text}
      <div className="settings-field settings-field-switch">
        <button type="button" role="switch" aria-checked={on} aria-labelledby={`${id}-label`} aria-describedby={`${id}-help`}
          className={`settings-switch${on ? " is-on" : ""}`} disabled={!editable || busy} onClick={() => onSave(setting, !on)}>
          <span className="settings-switch-track" aria-hidden="true"><span className="settings-switch-knob" /></span>
          <span className="settings-switch-text">{on ? "On" : "Off"}</span>
        </button>
      </div>
    </li>;
  }
  const value = fieldValue(setting, draft);
  // A choice shows its default when nothing is saved, so it has changed only when it differs from what applies now.
  const current = setting.input === "choice" ? setting.effective : setting.value;
  const changed = value !== undefined && JSON.stringify(value) !== JSON.stringify(current);
  const common = { id, "aria-describedby": `${id}-help`, disabled: !editable || busy, value: draft };
  const field = setting.input === "choice"
    ? <select {...common} onChange={event => setDraft(event.target.value)}>{setting.choices?.map(choice => <option key={choice.value} value={choice.value}>{choice.label}</option>)}</select>
    : setting.input === "lines"
      ? <textarea {...common} rows={Math.min(8, Math.max(3, draft.split("\n").length + 1))} placeholder="One per line" onChange={event => setDraft(event.target.value)} />
      : <span className={setting.input === "cents" ? "settings-money" : undefined}>
        {setting.input === "cents" && <span aria-hidden="true">$</span>}
        <input {...common} type={setting.input === "email" ? "email" : setting.input === "url" ? "url" : setting.input === "text" ? "text" : "number"}
          inputMode={setting.input === "cents" ? "decimal" : setting.input === "number" ? "numeric" : undefined}
          step={setting.input === "cents" ? "0.01" : setting.input === "number" ? "1" : undefined} min={setting.input === "number" ? setting.min : setting.input === "cents" ? "0.01" : undefined}
          max={setting.input === "number" ? setting.max : undefined}
          placeholder={setting.default !== null && !Array.isArray(setting.default) ? `Default: ${valueWords(setting, setting.default)}` : undefined}
          onChange={event => setDraft(event.target.value)} />
        {setting.unit && <span className="muted">{setting.unit}</span>}
      </span>;
  return <li className="settings-row">
    {text}
    <div className="settings-field">
      {field}
      {draft.trim() && value === undefined && <span className="form-message form-error" role="alert">{setting.input === "cents" ? "Enter an amount in dollars, for example 25 or 12.50." : `Enter a whole number from ${setting.min} to ${setting.max}.`}</span>}
      <span className="button-row">
        <button type="button" className="button button-primary button-small" disabled={!editable || busy || !changed} onClick={() => value !== undefined && onSave(setting, value)}>
          <Save size={14} aria-hidden="true" />Save<span className="sr-only"> {setting.label}</span></button>
        {setting.value !== null && <button type="button" className="button button-secondary button-small" disabled={!editable || busy} onClick={() => onSave(setting, null)}>
          <RotateCcw size={14} aria-hidden="true" />Use default<span className="sr-only"> for {setting.label}</span></button>}
      </span>
    </div>
  </li>;
}

/**
 * Settings: every switch and value the Hub uses that is not a secret, changed here instead of in Railway. The server applies a change
 * within a minute, without a restart. Until the settings migration is applied the page shows what the Railway variables say, read-only.
 */
export function Settings({ client = settingsClient }: { client?: SettingsClient }) {
  const { hash } = useLocation();
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState("");
  const changing = useRef(false);
  const [notice, setNotice] = useState<Notice>(null);
  // The settings as the last save returned them; a refresh reads them again.
  const [saved, setSaved] = useState<{ view: SettingsView; at: Date } | null>(null);
  const reload = useCallback(() => { setSaved(null); setRefresh(value => value + 1); }, []);
  const reader = useCallback((signal: AbortSignal) => { void refresh; return client.view({ signal }); }, [client, refresh]);
  const state = useAdminRead(reader);
  const shown = saved ?? (state.status === "ready" ? { view: state.data, at: state.receivedAt } : null);
  const loaded = Boolean(shown);
  useEffect(() => {
    if (loaded && hash === "#settings-social") document.getElementById("settings-social")?.scrollIntoView?.({ block: "start" });
  }, [hash, loaded]);

  const onSave = async (setting: HubSetting, value: SettingValue) => {
    if (changing.current || !setting.changedAt) return;
    changing.current = true;
    setBusy(setting.key); setNotice(null);
    try {
      const view = await client.save({ key: setting.key, value, expectedChangedAt: setting.changedAt });
      setSaved({ view, at: new Date() });
      setNotice({ ok: true, text: value === null ? `${setting.label}: back to the default. It applies within a minute.`
        : setting.input === "toggle" ? `${setting.label} is ${value === true ? "on" : "off"}. It applies within a minute.` : `${setting.label} is saved. It applies within a minute.` });
    } catch (error) {
      setNotice({ ok: false, text: failureText(error) });
      // Someone changed it since this page was read: show the current settings.
      if (error instanceof SettingsApiError && error.status === 409) reload();
    } finally { changing.current = false; setBusy(""); }
  };

  return <div className="settings">
    <div className="page-heading"><div><span className="eyebrow">CareMetric Admin</span><h1><SlidersHorizontal size={22} aria-hidden="true" /> Settings</h1>
      <p>Turn features on and off, and set the addresses, accounts and limits the Hub uses. Connect Meta and LinkedIn below in <a href="#settings-social">Social media</a>. Changes apply within a minute. <Link to="/admin">Integration setup</Link> shows the other services the Hub uses.</p></div>
      <button type="button" className="button button-secondary" onClick={reload} disabled={state.status === "loading" && !shown}><RefreshCw size={16} aria-hidden="true" /> Refresh</button></div>
    {notice && <p role={notice.ok ? "status" : "alert"} className={notice.ok ? "admin-explanation" : "form-message form-error"}>{notice.text}</p>}
    {!shown && state.status === "loading" && <Loading label="Loading settings" app="Hub" />}
    {state.status === "error" && <ReadFailure error={state.error} retry={reload} />}
    {shown && <>
      <p className="admin-read-time">Loaded {timeLabel(shown.at)}.</p>
      {!shown.view.editable && <p className="admin-explanation settings-readonly" role="status">Read-only for now: apply the settings migration (supabase/migrations/20261109150000_hub_settings.sql) and its contract, and the Hub copies these values in from Railway. After that you change them here.</p>}
      {shown.view.groups.map(group => <section key={group.id} className="panel settings-group" aria-labelledby={`settings-${group.id}`}>
        <div className="admin-section-title"><div><h2 id={`settings-${group.id}`}>{group.label}</h2><p>{group.description}</p></div></div>
        {group.id === "social" && <SocialConnections key={refresh} />}
        <ul className="settings-list">{group.settings.filter(setting => !guidedSocialSettings.has(setting.key)).map(setting =>
          <SettingRow key={`${setting.key}:${setting.changedAt ?? ""}:${JSON.stringify(setting.value)}`} setting={setting} editable={shown.view.editable} busy={Boolean(busy)} onSave={onSave} />)}</ul>
      </section>)}
    </>}
  </div>;
}
