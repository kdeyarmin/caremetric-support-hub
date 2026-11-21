import { useCallback, useMemo, useRef, useState } from "react";
import { Check, Clapperboard, Columns2, Download, MessageSquareText, Palette, Plus, RefreshCw, ShieldAlert, ShieldCheck, Trash2, Upload, X } from "lucide-react";
import { Link, useInRouterContext } from "react-router-dom";
import { Loading, ReadFailure } from "./AdminReads";
import { timeLabel } from "./readState";
import { useAdminRead } from "./useAdminRead";
import { TeamApiError } from "./teamClient";
import { creativeClient, fileAsBase64 } from "./creativeClient";
import type { CreativeClient, NewBrief, StudioFilter } from "./creativeClient";
import {
  creativePlatforms, creativeProducts, creativeStatuses, fileUrl, fittingPlacements, healthWords, hookLabels, placementLabel, platformLabels, productLabels, renderErrorLabel, sizeLabel,
  sourceLabels, statusLabels, videoLengthKeys, videoUploadLimit,
} from "./creativeProtocol";
import type { BrandKit, CreativeAsset, CreativeBrief, CreativeLearning, CreativePlatform, CreativeProduct, CreativeStatus, CreativeStudio, CreativeTheme } from "./creativeProtocol";
import "./admin.css";
import "./creative.css";

type Notice = { ok: boolean; text: string } | null;
type Change = (id: string, work: () => Promise<unknown>, success: string | (() => string)) => Promise<boolean>;
const failureText = (error: unknown) => error instanceof TeamApiError ? error.message
  : "The result could not be confirmed, so the change may have gone through. Refresh and check before you try again.";
const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;
const pageSize = 24;
// The most the studio read returns at once (server/agents/creative/admin.mjs): "Approve all" reads every waiting asset in pages of this size.
const allPageSize = 60;
/** An asset still waiting for the owner's decision. */
const awaitingDecision = (asset: CreativeAsset) => asset.status === "proposed" && asset.actionStatus === "proposed" && Boolean(asset.actionId);

/** The compliance result on a card: passed, or passed with warnings. A blocked asset is never listed. */
function ComplianceBadge({ asset }: { asset: CreativeAsset }) {
  const verdict = asset.compliance.verdict;
  const warnings = (asset.compliance.reasons ?? []).filter(reason => reason.level === "warn");
  const review = asset.compliance.review;
  if (!verdict) return null;
  return <>
    {verdict === "pass"
      ? <span className="creative-badge creative-badge-pass"><ShieldCheck size={14} aria-hidden="true" />Passed every check</span>
      : <details className="creative-badge creative-badge-warn"><summary><ShieldAlert size={14} aria-hidden="true" />{plural(warnings.length, "warning")}</summary>
        <ul>{warnings.map(item => <li key={`${item.rule}:${item.message}`}>{item.message}</li>)}</ul></details>}
    {review?.score ? <p className="creative-review">Image review: {review.score} of 5 as its audience would see it.{review.reader ? ` ${review.reader}` : ""}</p> : null}
  </>;
}

function Preview({ asset }: { asset: CreativeAsset }) {
  const ratio = `${asset.width} / ${asset.height}`;
  if (!asset.contentType) {
    return <div className="creative-preview creative-preview-empty" style={{ aspectRatio: ratio }}>
      <span>{asset.status === "failed" ? renderErrorLabel(asset.renderError) || "Could not render" : statusLabels[asset.status]}</span></div>;
  }
  return <div className="creative-preview" style={{ aspectRatio: ratio }}>
    {asset.contentType === "video/mp4"
      ? <video src={fileUrl(asset.id)} controls preload="metadata" playsInline aria-label={asset.altText || asset.headline} />
      : <img src={fileUrl(asset.id)} alt={asset.altText || asset.headline} loading="lazy" />}
  </div>;
}

function AssetCard({ asset, busy, onDecide, onCompare, comparing }: {
  asset: CreativeAsset; busy: string; comparing: boolean;
  onDecide: (asset: CreativeAsset, decision: "approve" | "reject" | "revise", note: string) => void; onCompare: (asset: CreativeAsset) => void;
}) {
  const [note, setNote] = useState("");
  const [asking, setAsking] = useState(false);
  const open = awaitingDecision(asset);
  const working = busy === `decide:${asset.id}`;
  return <article className={`creative-card${comparing ? " creative-card-comparing" : ""}`} id={`asset-${asset.id}`}>
    <Preview asset={asset} />
    <div className="creative-card-body">
      <div className="creative-card-meta">
        <span className={`creative-status creative-status-${asset.status}`}>{statusLabels[asset.status]}</span>
        <span>{platformLabels[asset.platform]} · {placementLabel(asset.placement)} · {asset.width}×{asset.height}{asset.kind === "video" && asset.durationSeconds ? ` · ${asset.durationSeconds.toFixed(0)}s` : ""}</span>
      </div>
      <p className="creative-card-variant"><strong>{productLabels[asset.product]}</strong> · variant {asset.variantLabel} · {hookLabels[asset.hookType]} hook · {asset.layout}</p>
      <ComplianceBadge asset={asset} />
      <h3>{asset.headline}</h3>
      <p className="creative-copy">{asset.primaryText}</p>
      {asset.description && <p className="creative-copy muted">{asset.description}</p>}
      <p className="creative-cta">Call to action: <strong>{asset.cta}</strong></p>
      {asset.landingUrl && <p className="creative-link muted">Landing page: <a href={asset.landingUrl} target="_blank" rel="noreferrer">{asset.landingUrl.replace(/\?.*$/, "")}</a></p>}
      {asset.revisionNotes && <p className="creative-note">Your note: {asset.revisionNotes}</p>}
      <div className="creative-card-actions">
        {asset.contentType && <a className="button button-secondary button-small" href={fileUrl(asset.id, true)} download><Download size={14} aria-hidden="true" />Download{asset.fileBytes ? ` (${sizeLabel(asset.fileBytes)})` : ""}</a>}
        <button type="button" className="button button-secondary button-small" onClick={() => onCompare(asset)} aria-pressed={comparing}><Columns2 size={14} aria-hidden="true" />Compare variants</button>
      </div>
      {open && <div className="creative-decision">
        {asking && <label className="team-field">What should change?<textarea rows={3} maxLength={1000} value={note} onChange={event => setNote(event.target.value)} placeholder="For example: lead with the free trial, and use the checklist layout." /></label>}
        {!asking && <label className="team-field">Note (optional)<input maxLength={1000} value={note} onChange={event => setNote(event.target.value)} /></label>}
        <div className="button-row">
          <button type="button" className="button button-primary button-small" disabled={Boolean(busy)} onClick={() => onDecide(asset, "approve", note)}><Check size={14} aria-hidden="true" />{working ? "Working…" : "Approve"}</button>
          <button type="button" className="button button-secondary button-small" disabled={Boolean(busy)} onClick={() => onDecide(asset, "reject", note)}><X size={14} aria-hidden="true" />Reject</button>
          {asking
            ? <button type="button" className="button button-secondary button-small" disabled={Boolean(busy) || !note.trim()} onClick={() => onDecide(asset, "revise", note)}><MessageSquareText size={14} aria-hidden="true" />Send changes</button>
            : <button type="button" className="button button-secondary button-small" disabled={Boolean(busy)} onClick={() => setAsking(true)}><MessageSquareText size={14} aria-hidden="true" />Request changes</button>}
        </div>
        <p className="muted creative-hint">Approving hands it to the Social Media Manager. A rejection with a note becomes a revision brief.</p>
      </div>}
    </div>
  </article>;
}

function Comparison({ base, assets, onClose }: { base: CreativeAsset; assets: CreativeAsset[]; onClose: () => void }) {
  const siblings = assets.filter(asset => asset.briefId === base.briefId && asset.platform === base.platform && asset.kind === base.kind);
  return <section className="panel creative-compare" aria-labelledby="creative-compare-title">
    <div className="admin-section-title"><div><h2 id="creative-compare-title">Variants side by side</h2><p>{productLabels[base.product]} on {platformLabels[base.platform]}, from the same brief: {plural(siblings.length, "variant")} on this page.</p></div>
      <button type="button" className="button button-secondary button-small" onClick={onClose}><X size={14} aria-hidden="true" />Close</button></div>
    <div className="creative-compare-row">
      {siblings.map(asset => <figure key={asset.id} className="creative-compare-item">
        <Preview asset={asset} />
        <figcaption><strong>{asset.variantLabel} · {hookLabels[asset.hookType]}</strong><span>{asset.headline}</span><span className="muted">{statusLabels[asset.status]}</span></figcaption>
      </figure>)}
    </div>
  </section>;
}

// Examples only: an Intel brief may aim at any kind of organization Intel is for, or at several.
const audienceExamples: Record<CreativeProduct, string> = {
  "caremetric-intel": "Marketing and business development leaders at hospitals, nursing homes and home health agencies",
  carebase: "Administrators and training leads at Pennsylvania personal care homes",
};
const emptyBrief = (product: CreativeProduct): Omit<NewBrief, "requestKey"> => ({ product, goal: "", audience: "", platforms: ["meta"], formats: ["static"], videoLengths: [], angle: "", offerCode: null });

function BriefForm({ client, busy, change }: { client: CreativeClient; busy: string; change: Change }) {
  const [brief, setBrief] = useState(() => emptyBrief("caremetric-intel"));
  const [error, setError] = useState<string | null>(null);
  const key = useRef<string | null>(null);
  const edit = (patch: Partial<typeof brief>) => { setBrief(previous => ({ ...previous, ...patch })); setError(null); key.current = null; };
  const toggle = <T extends string>(list: T[], value: T) => (list.includes(value) ? list.filter(item => item !== value) : [...list, value]);
  const submit = async () => {
    if (!brief.goal.trim() || !brief.audience.trim()) { setError("Enter a goal and an audience."); return; }
    if (healthWords.test(brief.audience)) { setError("Describe the audience as organizations and roles, never by a health condition."); return; }
    if (!brief.platforms.length || !brief.formats.length) { setError("Choose at least one platform and one format."); return; }
    key.current ??= crypto.randomUUID();
    const requestKey = key.current;
    const ok = await change("brief", () => client.createBrief({ ...brief, videoLengths: brief.formats.includes("video") ? (brief.videoLengths.length ? brief.videoLengths : ["15s"]) : [], requestKey }),
      "Brief saved. The Creative Director drafts it now; finished assets appear here for your approval.");
    if (ok) { setBrief(emptyBrief(brief.product)); key.current = null; }
  };
  return <section className="panel creative-brief-form" aria-labelledby="creative-brief-title">
    <div className="admin-section-title"><div><h2 id="creative-brief-title">New brief</h2><p>Ask for creative on demand. Facts come only from your fact sheet; offers only from billing.</p></div></div>
    <form onSubmit={event => { event.preventDefault(); void submit(); }}>
      <div className="creative-form-grid">
        <label className="team-field">Product<select value={brief.product} onChange={event => edit({ product: event.target.value as CreativeProduct })}>
          {creativeProducts.map(product => <option key={product} value={product}>{productLabels[product]}</option>)}</select></label>
        <label className="team-field">Offer<select value={brief.offerCode ?? ""} onChange={event => edit({ offerCode: event.target.value || null })}>
          <option value="">No offer</option><option value="FOUNDERS50">Founders Sale (FOUNDERS50)</option></select></label>
        <label className="team-field creative-wide">Goal<input required maxLength={500} value={brief.goal} onChange={event => edit({ goal: event.target.value })} placeholder="Drive free-trial starts from marketing leaders" /></label>
        <label className="team-field creative-wide">Audience<input required maxLength={500} value={brief.audience} onChange={event => edit({ audience: event.target.value })} placeholder={audienceExamples[brief.product]} /></label>
        <label className="team-field creative-wide">Angle (optional)<textarea rows={2} maxLength={500} value={brief.angle} onChange={event => edit({ angle: event.target.value })} /></label>
      </div>
      <fieldset className="creative-choices"><legend>Platforms</legend>
        {creativePlatforms.map(platform => <label key={platform}><input type="checkbox" checked={brief.platforms.includes(platform)} onChange={() => edit({ platforms: toggle(brief.platforms, platform) })} />{platformLabels[platform]}</label>)}
      </fieldset>
      <fieldset className="creative-choices"><legend>Formats</legend>
        <label><input type="checkbox" checked={brief.formats.includes("static")} onChange={() => edit({ formats: toggle(brief.formats, "static") })} />Images</label>
        <label><input type="checkbox" checked={brief.formats.includes("video")} onChange={() => edit({ formats: toggle(brief.formats, "video") })} />Short videos</label>
      </fieldset>
      {brief.formats.includes("video") && <fieldset className="creative-choices"><legend>Video lengths</legend>
        {videoLengthKeys.map(length => <label key={length}><input type="checkbox" checked={brief.videoLengths.includes(length)} onChange={() => edit({ videoLengths: toggle(brief.videoLengths, length) })} />{length === "45-60s" ? "45 to 60 seconds" : `${length.replace("s", "")} seconds`}</label>)}
      </fieldset>}
      {error && <p className="form-message form-error" role="alert">{error}</p>}
      <div className="button-row"><button type="submit" className="button button-primary button-small" disabled={Boolean(busy)}><Plus size={14} aria-hidden="true" />{busy === "brief" ? "Saving…" : "Start this brief"}</button></div>
    </form>
  </section>;
}

/**
 * The owner's own finished video: it becomes approved creative for each placement it fits (one per platform), and the Social Media Manager
 * uses it in its next weekly plan. Each post with it still waits for the owner's approval; uploading publishes nothing.
 */
function VideoUpload({ client, busy, change }: { client: CreativeClient; busy: string; change: Change }) {
  const [product, setProduct] = useState<CreativeProduct>("caremetric-intel");
  const [file, setFile] = useState<File | null>(null);
  const [info, setInfo] = useState<{ width: number; height: number; durationSeconds: number } | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  const [label, setLabel] = useState("");
  const [attested, setAttested] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = useRef<string | null>(null);
  const fits = info ? fittingPlacements(info) : [];
  const pick = async (picked: File | undefined) => {
    setError(null); setInfo(null); setChosen([]); setFile(null); key.current = null;
    if (!picked) return;
    if (picked.size > videoUploadLimit) { setError(`This file is ${sizeLabel(picked.size)}. A video may be at most 60 MB; export it at a lower bit rate.`); return; }
    try {
      const read = await client.videoInfo(picked);
      setFile(picked); setInfo(read);
      setChosen(fittingPlacements(read).map(item => item.key));
      setLabel(previous => previous || picked.name.replace(/\.mp4$/i, "").replace(/[-_]+/g, " ").slice(0, 120));
    } catch (failure) { setError(failureText(failure)); }
  };
  const submit = async () => {
    if (!file || !info) { setError("Choose an MP4 video."); return; }
    if (!chosen.length) { setError("Choose where the video may be used."); return; }
    if (!label.trim()) { setError("Name the video."); return; }
    if (!attested) { setError("Confirm that the video shows no patient, resident or personal information."); return; }
    key.current ??= crypto.randomUUID();
    const requestKey = key.current;
    const places = chosen.map(item => fits.find(fit => fit.key === item)?.label ?? placementLabel(item)).join(" and ");
    const ok = await change("video", () => client.uploadVideo({ product, placements: chosen, label: label.trim(), attested, requestKey, file }),
      `Added to the library, approved for ${places}. The Social Media Manager uses it in its next weekly plan; each post still waits for your approval.`);
    if (ok) { setFile(null); setInfo(null); setChosen([]); setLabel(""); setAttested(false); key.current = null; }
  };
  return <section className="panel creative-video-upload" aria-labelledby="creative-video-title">
    <div className="admin-section-title"><div><h2 id="creative-video-title"><Clapperboard size={16} aria-hidden="true" /> Add a finished video</h2>
      <p>Your own MP4 (at most 60 MB and two minutes): 1080 x 1920 for Reels and vertical LinkedIn, 1080 x 1080 or 1080 x 1350 for feeds, 1920 x 1080 for Facebook and LinkedIn. Adding it approves it; posting it still waits for you.</p></div></div>
    <form onSubmit={event => { event.preventDefault(); void submit(); }}>
      <div className="creative-form-grid">
        <label className="team-field">Product<select value={product} onChange={event => { setProduct(event.target.value as CreativeProduct); setError(null); key.current = null; }}>
          {creativeProducts.map(item => <option key={item} value={item}>{productLabels[item]}</option>)}</select></label>
        <label className="team-field">Name<input value={label} maxLength={120} onChange={event => { setLabel(event.target.value); setError(null); key.current = null; }} placeholder="30-second commercial" /></label>
        <label className="team-field creative-wide">Video file<input type="file" accept="video/mp4" disabled={Boolean(busy)} onChange={event => void pick(event.target.files?.[0])} /></label>
      </div>
      {info && <p className="muted">{info.width} x {info.height}, {Math.round(info.durationSeconds)} seconds{file ? `, ${sizeLabel(file.size)}` : ""}.</p>}
      {info && (fits.length
        ? <fieldset className="creative-choices"><legend>Use it for</legend>
          {fits.map(item => <label key={item.key}><input type="checkbox" checked={chosen.includes(item.key)} onChange={() => { setChosen(list => list.includes(item.key) ? list.filter(value => value !== item.key) : [...list, item.key]); setError(null); key.current = null; }} />{item.label}</label>)}
        </fieldset>
        : <p className="form-message form-error" role="alert">This video fits no placement. Use 1080 x 1920, 1080 x 1080, 1080 x 1350 or 1920 x 1080, at most two minutes long (one minute for Instagram Reels).</p>)}
      <label className="creative-check"><input type="checkbox" checked={attested} onChange={event => { setAttested(event.target.checked); setError(null); key.current = null; }} />This video shows no patient, resident or personal information.</label>
      {error && <p className="form-message form-error" role="alert">{error}</p>}
      <div className="button-row"><button type="submit" className="button button-primary button-small" disabled={Boolean(busy) || !file || !fits.length}><Upload size={14} aria-hidden="true" />{busy === "video" ? "Adding…" : "Add to the library"}</button></div>
    </form>
  </section>;
}

const colorFields = [["primaryColor", "Primary"], ["secondaryColor", "Secondary"], ["accentColor", "Accent"], ["textColor", "Text"], ["backgroundColor", "Background"]] as const;
const lines = (value: string) => value.split("\n").map(item => item.trim()).filter(Boolean);

const fonts = ["Geist", "Inter"] as const;

/**
 * One product's brand kit. Every field is optional: a blank one uses the product's brand theme (Emberline for CareMetric Intel, CareBase's
 * own for CareBase), the same colors, type and logo as the product's app and emails, so creative is on brand before anything is set here.
 */
function BrandKitEditor({ kit, theme, client, busy, change }: { kit: BrandKit; theme?: CreativeTheme; client: CreativeClient; busy: string; change: Change }) {
  const [draft, setDraft] = useState(() => ({
    ...Object.fromEntries(colorFields.map(([field]) => [field, kit[field] ?? ""])) as Record<typeof colorFields[number][0], string>,
    headingFont: kit.headingFont ?? "", bodyFont: kit.bodyFont ?? "", voiceNotes: kit.voiceNotes, requiredDisclaimers: kit.requiredDisclaimers.join("\n"),
    bannedPhrases: kit.bannedPhrases.join("\n"), videoAvatarId: kit.videoAvatarId ?? "", videoVoiceId: kit.videoVoiceId ?? "", captionsDefault: kit.captionsDefault,
  }));
  const [attested, setAttested] = useState(false);
  const [label, setLabel] = useState("");
  const overridden = colorFields.filter(([field]) => kit[field]).length + (kit.headingFont || kit.bodyFont ? 1 : 0);
  const themeName = theme ? `the ${theme.name} theme` : "the product's brand theme";
  const save = () => change(`kit:${kit.product}`, () => client.setBrandKit({ product: kit.product, expectedVersion: kit.version, kit: {
    ...Object.fromEntries(colorFields.map(([field]) => [field, draft[field]])), headingFont: draft.headingFont, bodyFont: draft.bodyFont, voiceNotes: draft.voiceNotes,
    requiredDisclaimers: lines(draft.requiredDisclaimers), bannedPhrases: lines(draft.bannedPhrases), videoAvatarId: draft.videoAvatarId.trim(), videoVoiceId: draft.videoVoiceId.trim(),
    captionsDefault: draft.captionsDefault,
  } }), `${productLabels[kit.product]} brand kit saved.`);
  const upload = (kind: "logo" | "screenshot") => async (file: File | undefined) => {
    if (!file) return;
    const ok = await change(`file:${kit.product}`, async () => client.addBrandFile({ product: kit.product, kind, data: await fileAsBase64(file), attested: kind === "screenshot" ? attested : false, ...(label.trim() ? { label: label.trim() } : {}) }),
      kind === "logo" ? "Logo saved." : "Screenshot saved.");
    if (ok) { setLabel(""); setAttested(false); }
  };
  return <section className="panel creative-kit" aria-labelledby={`kit-${kit.product}`}>
    <div className="admin-section-title"><div><h2 id={`kit-${kit.product}`}><Palette size={16} aria-hidden="true" /> {productLabels[kit.product]} brand kit</h2>
      <p>{overridden ? `Your colors and fonts replace ${themeName}'s; a blank field uses the theme.` : `Drawn in ${themeName}: the colors, type and logo of ${productLabels[kit.product]}'s app and emails. A field you set here replaces the theme's.`} Version {kit.version}, saved {timeLabel(kit.updatedAt)}. The brand name is always CareMetric.</p></div></div>
    {theme && <div className="creative-theme" aria-label={`${theme.name} theme colors`}>
      {colorFields.map(([field, name]) => <span key={field} className="creative-swatch"><span style={{ backgroundColor: kit[field] ?? theme.colors[field] }} aria-hidden="true" />{name}</span>)}
      <span className="muted">{theme.name} · {theme.mode === "dark" ? "dark" : "light"} · {kit.headingFont || theme.font}{theme.tagline ? ` · “${theme.tagline}”` : ""}</span>
    </div>}
    <form onSubmit={event => { event.preventDefault(); void save(); }}>
      <div className="creative-colors">
        {colorFields.map(([field, name]) => <label key={field} className="team-field">{name}
          <span className="creative-color"><input type="color" value={(draft[field] || theme?.colors[field] || "#ffffff").toLowerCase()} aria-label={`${name} color picker`} onChange={event => setDraft(value => ({ ...value, [field]: event.target.value.toUpperCase() }))} />
            <input value={draft[field]} maxLength={7} placeholder={theme ? `Theme ${theme.colors[field]}` : "#RRGGBB"} aria-label={`${name} color`} onChange={event => setDraft(value => ({ ...value, [field]: event.target.value }))} />
            {draft[field] && <button type="button" className="button button-secondary button-small" onClick={() => setDraft(value => ({ ...value, [field]: "" }))}>Use theme</button>}</span></label>)}
      </div>
      <div className="creative-form-grid">
        <label className="team-field">Heading font<select value={draft.headingFont} onChange={event => setDraft(value => ({ ...value, headingFont: event.target.value }))}><option value="">{theme ? `${theme.font} (theme)` : "Theme font"}</option>{fonts.map(font => <option key={font} value={font}>{font}</option>)}</select></label>
        <label className="team-field">Body font<select value={draft.bodyFont} onChange={event => setDraft(value => ({ ...value, bodyFont: event.target.value }))}><option value="">{theme ? `${theme.font} (theme)` : "Theme font"}</option>{fonts.map(font => <option key={font} value={font}>{font}</option>)}</select></label>
        <label className="team-field creative-wide">Voice notes<textarea rows={3} maxLength={2000} value={draft.voiceNotes} onChange={event => setDraft(value => ({ ...value, voiceNotes: event.target.value }))} placeholder="Warm, practical, plain words. Speak to operators, never down to them." /></label>
        <label className="team-field">Required disclaimers (one per line)<textarea rows={3} value={draft.requiredDisclaimers} onChange={event => setDraft(value => ({ ...value, requiredDisclaimers: event.target.value }))} /></label>
        <label className="team-field">Banned phrases (one per line)<textarea rows={3} value={draft.bannedPhrases} onChange={event => setDraft(value => ({ ...value, bannedPhrases: event.target.value }))} /></label>
        <label className="team-field">HeyGen avatar id<input value={draft.videoAvatarId} maxLength={100} onChange={event => setDraft(value => ({ ...value, videoAvatarId: event.target.value }))} /></label>
        <label className="team-field">HeyGen voice id<input value={draft.videoVoiceId} maxLength={100} onChange={event => setDraft(value => ({ ...value, videoVoiceId: event.target.value }))} /></label>
        <label className="creative-check creative-wide"><input type="checkbox" checked={draft.captionsDefault} onChange={event => setDraft(value => ({ ...value, captionsDefault: event.target.checked }))} />Burn captions into videos (required to pass the checks)</label>
      </div>
      <div className="button-row"><button type="submit" className="button button-primary button-small" disabled={Boolean(busy)}>{busy === `kit:${kit.product}` ? "Saving…" : "Save brand kit"}</button></div>
    </form>
    <div className="creative-files">
      <div className="creative-file-row">
        {kit.logoFileId ? <img className="creative-logo" src={fileUrl(kit.logoFileId)} alt={`${productLabels[kit.product]} logo`} /> : <span className="muted">No logo uploaded: the official {productLabels[kit.product]} logo is used.</span>}
        <label className="button button-secondary button-small creative-upload"><Upload size={14} aria-hidden="true" />{kit.logoFileId ? "Replace logo" : "Add logo"}
          <input type="file" accept="image/png,image/jpeg" disabled={Boolean(busy)} onChange={event => void upload("logo")(event.target.files?.[0])} /></label>
      </div>
      <p className="muted creative-hint">Use a PNG with a transparent background. A logo saved on white or a color (every JPEG is) is only placed on a background of exactly that color; anywhere else the official logo or the product name is used, so a logo&apos;s own box never shows.</p>
      <h3>Product screenshots</h3>
      {kit.screenshots.length ? <ul className="creative-shots">{kit.screenshots.map(shot => <li key={shot.id}>
        <img src={fileUrl(shot.id)} alt={shot.label || "Product screenshot"} loading="lazy" /><span>{shot.label || "Screenshot"} · {sizeLabel(shot.bytes)}</span>
        <button type="button" className="button button-secondary button-small" disabled={Boolean(busy)} onClick={() => void change(`file:${kit.product}`, () => client.removeBrandFile({ id: shot.id }), "Screenshot removed.")}><Trash2 size={13} aria-hidden="true" />Remove</button>
      </li>)}</ul> : <p className="muted">No screenshots yet. Screenshot layouts and demo videos need one.</p>}
      <div className="creative-shot-add">
        <label className="team-field">Label<input value={label} maxLength={120} onChange={event => setLabel(event.target.value)} placeholder="Territory map" /></label>
        <label className="creative-check"><input type="checkbox" checked={attested} onChange={event => setAttested(event.target.checked)} />This screenshot shows no patient, resident or personal information.</label>
        <label className={`button button-secondary button-small creative-upload${attested ? "" : " creative-upload-disabled"}`}><Upload size={14} aria-hidden="true" />Add screenshot
          <input type="file" accept="image/png,image/jpeg" disabled={Boolean(busy) || !attested} onChange={event => void upload("screenshot")(event.target.files?.[0])} /></label>
      </div>
    </div>
  </section>;
}

function Learnings({ learnings }: { learnings: CreativeLearning[] }) {
  if (!learnings.length) return <p className="muted">No learnings yet. The weekly report adds them once live creative has 1,000 impressions.</p>;
  return <ul className="creative-learnings">{learnings.map(item => <li key={`${item.product}:${item.platform}:${item.kind}:${item.value}`} className={`creative-learning-${item.verdict}`}>
    <strong>{item.verdict === "win" ? "Working" : item.verdict === "lose" ? "Not working" : "No difference"}</strong>
    <span>{productLabels[item.product]}, {platformLabels[item.platform]}: {item.kind} “{item.value}”</span>
    <span className="muted">{item.score > 0 ? "+" : ""}{Math.round(item.score * 100)}% vs average · {plural(item.samples, "asset")}</span>
  </li>)}</ul>;
}

function Briefs({ briefs }: { briefs: CreativeBrief[] }) {
  if (!briefs.length) return <p className="muted">No briefs yet.</p>;
  return <ul className="creative-briefs">{briefs.map(brief => <li key={brief.id}>
    <span className="creative-brief-source">{sourceLabels[brief.source]}</span>
    <strong>{productLabels[brief.product]}: {brief.goal}</strong>
    <span className="muted">{brief.platforms.map(platform => platformLabels[platform]).join(", ")} · {brief.formats.join(" and ")} · {brief.status}{brief.revisionNote ? ` · note: ${brief.revisionNote}` : ""}</span>
  </li>)}</ul>;
}

function TeamLink() {
  return useInRouterContext() ? <Link className="button button-secondary" to="/admin/team">AI team</Link> : <a className="button button-secondary" href="/admin/team">AI team</a>;
}

export function Creative({ client = creativeClient }: { client?: CreativeClient }) {
  const [filter, setFilter] = useState<StudioFilter>({ product: null, platform: null, status: null, offset: 0, limit: pageSize });
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState<Notice>(null);
  const [comparing, setComparing] = useState<CreativeAsset | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);
  const [progress, setProgress] = useState("");
  const changing = useRef(false);
  const reload = useCallback(() => setRefresh(value => value + 1), []);
  const reader = useCallback((signal: AbortSignal) => { void refresh; return client.studio(filter, { signal }); }, [client, filter, refresh]);
  const state = useAdminRead(reader);
  const [kept, setKept] = useState<CreativeStudio | null>(null);
  if (state.status === "ready" && kept !== state.data) setKept(state.data);
  const shown = state.status === "ready" ? state.data : kept;

  const change: Change = async (id, work, success) => {
    if (changing.current) return false;
    changing.current = true;
    setBusy(id); setNotice(null);
    try { await work(); setNotice({ ok: true, text: typeof success === "function" ? success() : success }); return true; }
    catch (error) { setNotice({ ok: false, text: failureText(error) }); return false; }
    finally { changing.current = false; setBusy(""); reload(); }
  };
  const decide = (asset: CreativeAsset, decision: "approve" | "reject" | "revise", note: string) => {
    if (!asset.actionId) return;
    const trimmed = note.trim();
    let message = decision === "approve" ? "Approved and handed to the Social Media Manager." : decision === "revise" || trimmed ? "Sent back with your note. A revision is on its way." : "Rejected.";
    void change(`decide:${asset.id}`, async () => {
      const result = await client.decide({ actionId: asset.actionId!, decision: decision === "approve" ? "approve" : "reject", ...(trimmed ? { note: trimmed } : {}) });
      if (!result.decided) throw new TeamApiError(409, "This asset was no longer waiting (expired or decided elsewhere). Your decision was not applied. The gallery has been refreshed.");
      if (result.status === "failed") throw new TeamApiError(409, "The approval was recorded but the hand-over did not complete. Check the AI team's activity.");
      if (decision === "approve" && result.status !== "executed") {
        message = "Approved. The hand-over to the Social Media Manager is still pending. Check the AI team's activity.";
      }
    }, () => message);
  };
  /**
   * Approves every asset waiting for a decision, on every page, one at a time through the same decide route as each card's Approve (so each
   * approval is the signed-in owner's, as an asset with a warning requires). One the route refuses is counted and the rest go on; an answer
   * that cannot be confirmed stops the run, since that approval may or may not have gone through.
   */
  const approveAll = async () => {
    if (changing.current) return;
    changing.current = true;
    setBusy("approve-all"); setNotice(null); setConfirmAll(false);
    // Handed over now; approved, with the hand-over on the team's next run; no longer waiting (expired, or decided elsewhere meanwhile);
    // refused by the route or its hand-over.
    let handed = 0, later = 0, gone = 0, refused = 0;
    try {
      const open: CreativeAsset[] = [];
      for (let offset = 0; ; offset += allPageSize) {
        const page = await client.studio({ product: null, platform: null, status: "proposed", offset, limit: allPageSize }, { signal: new AbortController().signal });
        open.push(...page.assets.filter(awaitingDecision));
        if (!page.assets.length || offset + allPageSize >= page.total) break;
      }
      for (const [index, asset] of open.entries()) {
        setProgress(`Approving ${index + 1} of ${open.length}…`);
        try {
          const result = await client.decide({ actionId: asset.actionId!, decision: "approve" });
          // Only this run's own approval counts: an action that expired or was decided elsewhere meanwhile comes back undecided.
          if (!result.decided) gone += 1;
          else if (result.status === "executed") handed += 1;
          else if (result.status === "approved") later += 1;
          else refused += 1;
        } catch (error) {
          if (!(error instanceof TeamApiError)) throw error;
          refused += 1;
        }
      }
      const parts = [
        handed ? `Approved ${plural(handed, "asset")} and handed ${handed === 1 ? "it" : "them"} to the Social Media Manager.` : null,
        later ? `${plural(later, handed ? "more asset" : "asset")} ${later === 1 ? "is" : "are"} approved and ${later === 1 ? "goes" : "go"} to the Social Media Manager on the team's next run.` : null,
        gone ? `${plural(gone, "asset")} ${gone === 1 ? "was" : "were"} no longer waiting (expired, or decided elsewhere), so ${gone === 1 ? "it was" : "they were"} not approved.` : null,
        refused ? `${plural(refused, "asset")} could not be approved or handed over. Check the AI team's activity.` : null,
      ].filter(Boolean);
      setNotice({ ok: !gone && !refused, text: parts.length ? parts.join(" ") : "Nothing was waiting for your approval." });
    } catch (error) {
      const done = handed + later;
      setNotice({ ok: false, text: `${done ? `Approved ${plural(done, "asset")} first. ` : ""}${failureText(error)}` });
    } finally {
      changing.current = false; setBusy(""); setProgress(""); reload();
    }
  };
  const setFilterValue = <K extends keyof StudioFilter>(key: K, value: StudioFilter[K]) => setFilter(previous => ({ ...previous, [key]: value, offset: 0 }));
  const counts = useMemo(() => shown?.statusCounts ?? {}, [shown]);
  const waitingCount = counts.proposed ?? 0;

  return <div className="creative-page">
    <div className="page-heading creative-header"><div><span className="eyebrow">CareMetric Admin</span><h1><Palette size={22} aria-hidden="true" /> Creative</h1>
      <p>The Creative Director turns your marketing plans into ad images and short videos. Everything here passed the compliance checks; anything that failed was blocked and is not shown.</p></div>
      <div className="button-row">
        <TeamLink />
        <button type="button" className="button button-secondary" onClick={reload} disabled={state.status === "loading"}><RefreshCw size={16} aria-hidden="true" /> Refresh</button>
      </div></div>
    {notice && <p className={`form-message ${notice.ok ? "form-success" : "form-error"}`} role={notice.ok ? "status" : "alert"}>{notice.text}</p>}
    {!shown && state.status === "loading" && <Loading label="Loading creative" app="Creative" />}
    {state.status === "error" && <ReadFailure error={state.error} retry={reload} />}
    {shown && <>
      <section className="creative-summary" aria-label="Creative by status">
        {creativeStatuses.filter(status => counts[status]).map(status => <button type="button" key={status} className={`creative-count${filter.status === status ? " creative-count-active" : ""}`}
          onClick={() => setFilterValue("status", filter.status === status ? null : status)}><strong>{counts[status]}</strong>{statusLabels[status]}</button>)}
        {shown.blocked > 0 && <span className="creative-count creative-count-blocked"><strong>{shown.blocked}</strong>Blocked by the checks (not shown)</span>}
      </section>
      <div className="creative-filters">
        <label className="team-field">Product<select value={filter.product ?? ""} onChange={event => setFilterValue("product", (event.target.value || null) as CreativeProduct | null)}>
          <option value="">All products</option>{creativeProducts.map(product => <option key={product} value={product}>{productLabels[product]}</option>)}</select></label>
        <label className="team-field">Platform<select value={filter.platform ?? ""} onChange={event => setFilterValue("platform", (event.target.value || null) as CreativePlatform | null)}>
          <option value="">All platforms</option>{creativePlatforms.map(platform => <option key={platform} value={platform}>{platformLabels[platform]}</option>)}</select></label>
        <label className="team-field">Status<select value={filter.status ?? ""} onChange={event => setFilterValue("status", (event.target.value || null) as CreativeStatus | null)}>
          <option value="">Every status</option>{creativeStatuses.map(status => <option key={status} value={status}>{statusLabels[status]}</option>)}</select></label>
      </div>
      {waitingCount > 0 && <section className="panel creative-approve-all" aria-label="Approve everything waiting">
        {confirmAll
          ? <>
            <p>Approve all {plural(waitingCount, "asset")} waiting for you? Each one passed the compliance checks; any warnings are on its card. They go to the Social Media Manager, which can use them in posts and ads.</p>
            <div className="button-row">
              <button type="button" className="button button-primary button-small" disabled={Boolean(busy)} onClick={() => void approveAll()}><Check size={14} aria-hidden="true" />Yes, approve all {waitingCount}</button>
              <button type="button" className="button button-secondary button-small" disabled={Boolean(busy)} onClick={() => setConfirmAll(false)}><X size={14} aria-hidden="true" />Cancel</button>
            </div>
          </>
          : <div className="button-row">
            <span>{plural(waitingCount, "asset")} waiting for your approval.</span>
            <button type="button" className="button button-primary button-small" disabled={Boolean(busy)} onClick={() => setConfirmAll(true)}><Check size={14} aria-hidden="true" />{busy === "approve-all" ? progress || "Working…" : `Approve all ${waitingCount}`}</button>
          </div>}
      </section>}
      {comparing && <Comparison base={comparing} assets={shown.assets} onClose={() => setComparing(null)} />}
      {shown.assets.length
        ? <div className="creative-gallery">{shown.assets.map(asset => <AssetCard key={asset.id} asset={asset} busy={busy} comparing={comparing?.id === asset.id} onDecide={decide} onCompare={setComparing} />)}</div>
        : <p className="muted creative-empty">No creative matches these filters yet.</p>}
      {shown.total > pageSize && <div className="button-row creative-pages">
        <button type="button" className="button button-secondary button-small" disabled={filter.offset === 0} onClick={() => setFilter(previous => ({ ...previous, offset: Math.max(0, previous.offset - pageSize) }))}>Newer</button>
        <span className="muted">{filter.offset + 1}–{Math.min(filter.offset + pageSize, shown.total)} of {shown.total}</span>
        <button type="button" className="button button-secondary button-small" disabled={filter.offset + pageSize >= shown.total} onClick={() => setFilter(previous => ({ ...previous, offset: previous.offset + pageSize }))}>Older</button>
      </div>}
      <BriefForm client={client} busy={busy} change={change} />
      <VideoUpload client={client} busy={busy} change={change} />
      <section className="panel" aria-labelledby="creative-learnings-title"><div className="admin-section-title"><div><h2 id="creative-learnings-title">What the results say</h2><p>From the weekly report: ad results and website leads joined to each asset by utm_content.</p></div></div><Learnings learnings={shown.learnings} /></section>
      <section className="panel" aria-labelledby="creative-briefs-title"><div className="admin-section-title"><div><h2 id="creative-briefs-title">Recent briefs</h2><p>From the weekly social plan, the Marketing Manager, your own briefs, refreshes of winners and your change requests.</p></div></div><Briefs briefs={shown.briefs} /></section>
      <div className="creative-kits">{shown.brandKits.map(kit => <BrandKitEditor key={`${kit.product}:${kit.version}`} kit={kit} theme={shown.themes?.find(theme => theme.product === kit.product)} client={client} busy={busy} change={change} />)}</div>
    </>}
  </div>;
}
