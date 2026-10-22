import { useEffect, useRef, useState } from "react";
import type { GovernedCourse } from "../imports/governedLearningImport";
import { courseDraftRequestSchema, type Avatar, type Voice } from "./generationProtocol";
import { GenerationError, generationFailure, runGeneration } from "./generationClient";

type Block = GovernedCourse["blocks"][number];
const POLL_MS = 30_000;
const bodyText = (block: Block, key: string) => block.body && typeof block.body === "object" && !Array.isArray(block.body)
  && typeof (block.body as Record<string, unknown>)[key] === "string" ? (block.body as Record<string, string>)[key] : "";
const lessonName = (block: Block) => `${block.sortOrder + 1}. ${block.title || "Untitled lesson"} · ${block.type}`;
const optionalNumber = (value: string) => value.trim() === "" ? undefined : Number(value);

/** Draft with AI: a new global draft course, flagged as AI-generated until an administrator reviews it. */
export function AiCourseDraftPanel({ onOpen }: { onOpen: (courseId: string) => void }) {
  const [fields, setFields] = useState({ title_hint: "", category: "", source_material: "", desired_module_count: "", desired_duration_minutes: "", notes: "" });
  const [running, setRunning] = useState(false); const [error, setError] = useState(""); const [created, setCreated] = useState<string | null>(null);
  const pending = useRef(false);
  const request = Object.fromEntries(Object.entries({ generation_mode: "course", title_hint: fields.title_hint.trim() || undefined, category: fields.category.trim() || undefined,
    source_material: fields.source_material.trim() ? fields.source_material : undefined, notes: fields.notes.trim() ? fields.notes : undefined,
    desired_module_count: optionalNumber(fields.desired_module_count), desired_duration_minutes: optionalNumber(fields.desired_duration_minutes) })
    .filter(([, value]) => value !== undefined));
  const parsed = courseDraftRequestSchema.safeParse(request);
  const set = (patch: Partial<typeof fields>) => { setFields(current => ({ ...current, ...patch })); setCreated(null); };
  async function draft() {
    if (pending.current || !parsed.success) return;
    pending.current = true; setRunning(true); setError(""); setCreated(null);
    try { setCreated((await runGeneration({ operation: "ai.generateCourse", request: parsed.data }, new AbortController().signal)).courseId); }
    catch (caught) { setError(generationFailure(caught, "The draft was not created. Retry with the same inputs; a failed attempt is recorded in the CareBase audit trail.")); }
    finally { pending.current = false; setRunning(false); }
  }
  return <details className="admin-authoring"><summary>Draft a course with AI</summary>
    <form aria-label="Draft a course with AI" onSubmit={event => { event.preventDefault(); void draft(); }}>
      <p>CareBase drafts one new global course and flags it as AI-generated. It cannot be published until an administrator reviews it in the course version controls.</p>
      <label>Working title<input disabled={running} value={fields.title_hint} maxLength={300} onChange={event => set({ title_hint: event.target.value })} /></label>
      <label>Category<input disabled={running} value={fields.category} maxLength={100} onChange={event => set({ category: event.target.value })} /></label>
      <label>Source material (up to 100,000 characters)<textarea disabled={running} value={fields.source_material} maxLength={100_000}
        onChange={event => set({ source_material: event.target.value })} /></label>
      <p>Paste the regulation or policy text the course must follow. CareBase treats it as the authority for regulatory specifics; without it, the draft says those specifics are unverified.</p>
      <label>Number of lessons (1 to 30)<input disabled={running} type="number" min={1} max={30} step={1} value={fields.desired_module_count}
        onChange={event => set({ desired_module_count: event.target.value })} /></label>
      <label>Duration in minutes (1 to 1,440)<input disabled={running} type="number" min={1} max={1440} step={1} value={fields.desired_duration_minutes}
        onChange={event => set({ desired_duration_minutes: event.target.value })} /></label>
      <label>Notes for the drafter<textarea disabled={running} value={fields.notes} maxLength={4000} onChange={event => set({ notes: event.target.value })} /></label>
      {!parsed.success && <p>Enter a working title, source material or notes, and whole numbers within the limits.</p>}
      {running && <p role="status">Drafting the course. This can take up to about two and a half minutes.</p>}
      {error && <p role="alert">{error}</p>}
      {created && <p role="status">CareBase created the draft. <button type="button" className="button button-secondary button-small" onClick={() => onOpen(created)}>Open the draft</button></p>}
      <button type="submit" className="button button-primary" disabled={running || !parsed.success}>{error ? "Retry with the same inputs" : "Draft with AI"}</button>
    </form>
  </details>;
}

/** Regenerate with AI: rewrites one text, video script or quiz block of a draft in place. */
export function BlockRegenerationPanel({ material, busy, onBusy, onRegenerated }: { material: GovernedCourse; busy: boolean; onBusy: (value: boolean) => void; onRegenerated: () => void }) {
  const blocks = [...material.blocks].filter(block => ["text", "video", "quiz"].includes(block.type)).sort((a, b) => a.sortOrder - b.sortOrder);
  const [blockId, setBlockId] = useState(""); const [feedback, setFeedback] = useState("");
  const [running, setRunning] = useState(false); const [error, setError] = useState("");
  const block = blocks.find(value => value.id === blockId);
  async function regenerate() {
    if (!block || running) return;
    setRunning(true); onBusy(true); setError("");
    try { await runGeneration({ operation: "ai.regenerateBlock", request: { course_block_id: block.id, feedback } }, new AbortController().signal); onRegenerated(); }
    catch (caught) { setError(generationFailure(caught, "The lesson was not regenerated. Retry, or check the CareBase audit trail for the failed attempt.")); }
    finally { setRunning(false); onBusy(false); }
  }
  return <details><summary>Regenerate a lesson with AI</summary>
    <p>CareBase overwrites the chosen lesson in place: a text lesson’s text, a video lesson’s script (which removes its attached video) or a quiz’s whole question set.
      The draft is marked AI-generated again, so it needs a new review before publication.</p>
    <label>Lesson to regenerate<select disabled={busy || running} value={blockId} onChange={event => { setBlockId(event.target.value); setError(""); }}>
      <option value="">Choose a lesson</option>{blocks.map(value => <option key={value.id} value={value.id}>{lessonName(value)}</option>)}</select></label>
    <label>What to change (up to 4,000 characters)<textarea disabled={busy || running} value={feedback} maxLength={4000} onChange={event => setFeedback(event.target.value)} /></label>
    {running && <p role="status">Regenerating the lesson. This can take up to about two and a half minutes.</p>}
    {error && <p role="alert">{error}</p>}
    <button type="button" className="button button-secondary" disabled={busy || running || !block || !feedback.trim()} onClick={() => void regenerate()}>Regenerate with AI</button>
  </details>;
}

type VideoState = { kind: "idle" } | { kind: "rendering" } | { kind: "completed" } | { kind: "failed"; error: string };
/** Generate video: a paid HeyGen avatar render from a draft video lesson's script, attached when it finishes. */
export function AvatarVideoPanel({ material, busy, onBusy, onAttached }: { material: GovernedCourse; busy: boolean; onBusy: (value: boolean) => void; onAttached: () => void }) {
  const blocks = [...material.blocks].filter(block => block.type === "video").sort((a, b) => a.sortOrder - b.sortOrder);
  const [blockId, setBlockId] = useState("");
  const block = blocks.find(value => value.id === blockId);
  if (blocks.length === 0) return null;
  return <details><summary>Generate an avatar video</summary>
    <label>Video lesson<select disabled={busy} value={blockId} onChange={event => setBlockId(event.target.value)}>
      <option value="">Choose a video lesson</option>{blocks.map(value => <option key={value.id} value={value.id}>{lessonName(value)}</option>)}</select></label>
    {block && <AvatarVideoDialog key={block.id} block={block} busy={busy} onBusy={onBusy} onAttached={onAttached} />}
  </details>;
}
function AvatarVideoDialog({ block, busy, onBusy, onAttached }: { block: Block; busy: boolean; onBusy: (value: boolean) => void; onAttached: () => void }) {
  // One request ID per dialog: every retry from it reuses the same paid attempt.
  const [requestId] = useState(() => crypto.randomUUID());
  const [options, setOptions] = useState<{ avatars: Avatar[]; voices: Voice[] } | null>(null);
  const [avatarId, setAvatarId] = useState(""); const [voiceId, setVoiceId] = useState("");
  const [script, setScript] = useState(bodyText(block, "script")); const [title, setTitle] = useState(block.title ?? "");
  const [replace, setReplace] = useState(false); const [running, setRunning] = useState(false);
  const [error, setError] = useState(""); const [retryable, setRetryable] = useState(true); const [waiting, setWaiting] = useState(false);
  const [state, setState] = useState<VideoState>({ kind: "idle" });
  const attached = useRef(onAttached);
  useEffect(() => { attached.current = onAttached; });
  const linkedVideo = block.videoLocatorSha256 !== null, existingAsset = block.mediaAsset?.id ?? null;
  useEffect(() => {
    if (linkedVideo) return;
    const controller = new AbortController();
    runGeneration({ operation: "video.options", request: {} }, controller.signal).then(setOptions)
      .catch(caught => { if (!controller.signal.aborted) setError(generationFailure(caught, "Avatars and voices did not load. Close and reopen this lesson to retry.")); });
    return () => controller.abort();
  }, [linkedVideo]);
  useEffect(() => {
    if (state.kind !== "rendering") return;
    const controller = new AbortController();
    const timer = setInterval(() => {
      runGeneration({ operation: "video.status", request: { course_block_id: block.id } }, controller.signal).then(status => {
        if (status.status === "completed") { setState({ kind: "completed" }); attached.current(); }
        else if (status.status === "failed") setState({ kind: "failed", error: status.error ?? "The video could not be generated." });
      }).catch(() => { /* CareBase also finishes renders on its own schedule; keep polling. */ });
    }, POLL_MS);
    return () => { clearInterval(timer); controller.abort(); };
  }, [state.kind, block.id]);
  useEffect(() => { if (!waiting) return; const timer = setTimeout(() => setWaiting(false), 45_000); return () => clearTimeout(timer); }, [waiting]);
  function chooseAvatar(id: string) { setAvatarId(id); const avatar = options?.avatars.find(value => value.id === id); if (avatar?.defaultVoiceId) setVoiceId(avatar.defaultVoiceId); }
  async function generate() {
    if (running) return;
    setRunning(true); onBusy(true); setError("");
    try {
      const result = await runGeneration({ operation: "video.generate", request: { course_block_id: block.id, request_id: requestId, avatar_id: avatarId, voice_id: voiceId, script,
        ...(title.trim() ? { title } : {}), ...(existingAsset ? { replace_existing: replace } : {}), expected_video_url: null, expected_media_asset_id: existingAsset } }, new AbortController().signal);
      if (result.status === "completed") { setState({ kind: "completed" }); attached.current(); } else setState({ kind: "rendering" });
    } catch (caught) {
      const detail = caught instanceof GenerationError ? caught.detail ?? "" : "", code = caught instanceof GenerationError ? caught.code : "upstream";
      // Retry only what the same request can resume. An unresolved provider response needs a
      // person in CareBase, and anything else needs the lesson reloaded or a new dialog.
      const confirming = /45 seconds|still being confirmed/i.test(detail);
      setRetryable(!/unresolved/i.test(detail) && (["upstream", "timeout", "provider_runtime_busy"].includes(code) || (code === "conflict" && confirming)));
      setWaiting(confirming);
      setError(generationFailure(caught, "HeyGen did not confirm the render. Retry: the same request reuses the same paid attempt."));
    } finally { setRunning(false); onBusy(false); }
  }
  if (linkedVideo) return <p>This lesson already has a linked video. The Hub never loads video links, so it cannot confirm which video a new render would replace.
    Remove the linked video in CareBase’s course media first, then generate a new one here.</p>;
  if (state.kind === "rendering") return <p role="status">HeyGen is rendering the video. This page checks every 30 seconds; you can also close it, because CareBase finishes renders on its own schedule.</p>;
  if (state.kind === "completed") return <p role="status">The video is attached to the lesson. Load the course material and preserve it again before another change.</p>;
  const ready = Boolean(avatarId && voiceId && script.trim() && (!existingAsset || replace));
  return <div aria-label="Avatar video">
    <p>Each render is a paid HeyGen call. Retrying from this lesson reuses the same request, so a retry never pays twice.</p>
    {state.kind === "failed" && <p role="alert">{state.error}</p>}
    {!options && !error && <p role="status">Loading avatars and voices…</p>}
    {options && <>
      <label>Avatar<select disabled={busy || running} value={avatarId} onChange={event => chooseAvatar(event.target.value)}>
        <option value="">Choose an avatar</option>{options.avatars.map(avatar => <option key={avatar.id} value={avatar.id}>
          {avatar.name ?? avatar.id}{avatar.aiTwin ? " · AI twin" : avatar.private ? " · private" : ""}{avatar.gender ? ` · ${avatar.gender}` : ""}</option>)}</select></label>
      <label>Voice<select disabled={busy || running} value={voiceId} onChange={event => setVoiceId(event.target.value)}>
        <option value="">Choose a voice</option>{options.voices.map(voice => <option key={voice.id} value={voice.id}>
          {voice.name ?? voice.id}{voice.language ? ` · ${voice.language}` : ""}{voice.gender ? ` · ${voice.gender}` : ""}</option>)}</select></label>
    </>}
    <label>Script (up to 50,000 characters)<textarea disabled={busy || running} value={script} maxLength={50_000} onChange={event => setScript(event.target.value)} /></label>
    <label>Video title (optional)<input disabled={busy || running} value={title} maxLength={1000} onChange={event => setTitle(event.target.value)} /></label>
    {existingAsset && <label className="learning-checkbox"><input type="checkbox" disabled={busy || running} checked={replace} onChange={event => setReplace(event.target.checked)} />
      Replace this lesson’s current video</label>}
    {running && <p role="status">Submitting the render to HeyGen…</p>}
    {error && <p role="alert">{error}</p>}
    {error && !retryable && <p>Close this lesson’s dialog and load the course material again before starting a new render.</p>}
    {waiting && <p role="status">Wait 45 seconds before retrying; the retry reuses the same paid attempt.</p>}
    <button type="button" className="button button-primary" disabled={busy || running || waiting || !options || !ready || (Boolean(error) && !retryable)}
      onClick={() => void generate()}>{error && retryable ? "Retry the same render" : "Generate video"}</button>
  </div>;
}
