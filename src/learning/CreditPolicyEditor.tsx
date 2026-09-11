import { useEffect, useRef, useState } from "react";
import type { GovernedCourse } from "../imports/governedLearningImport";
import type { CreditDefinition, CreditPolicyChanges } from "./creditPolicyProtocol";
import { creditPolicyChanges, editableCredit, initialCreditPolicy } from "./creditPolicyModel";
import { loadCreditTrainingTypes } from "./creditPolicyClient";

export function CreditPolicyEditor({ material, busy, reasonReady, onChange, onPreview }: {
  material: GovernedCourse; busy: boolean; reasonReady: boolean; onChange: () => void; onPreview: (changes: CreditPolicyChanges) => void;
}) {
  const [form, setForm] = useState(() => initialCreditPolicy(material));
  const [options, setOptions] = useState<{ id: string; label: string }[]>([]), [nextOffset, setNextOffset] = useState<number | null>(null);
  const [loaded, setLoaded] = useState(false), [loading, setLoading] = useState(false), [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => { controller.current?.abort(); }, []);
  const source = new Map(material.credits.map(row => [row.id.toLowerCase(), row]));
  const label = (id: string) => options.find(row => row.id.toLowerCase() === id.toLowerCase())?.label;
  const update = (next: typeof form) => { setForm(next); setError(""); onChange(); };
  const changeCredit = (next: CreditDefinition) => update({ ...form, credits: form.credits.map(row => row.creditId === next.creditId ? next : row) });
  const remove = (creditId: string) => update({ ...form, credits: form.credits.filter(row => row.creditId !== creditId) });
  async function load(offset: number) {
    if (controller.current || busy) return;
    const request = new AbortController(); controller.current = request; setLoading(true); setError("");
    try {
      const page = await loadCreditTrainingTypes(offset, request.signal);
      if (request.signal.aborted) return;
      setOptions(prior => offset === 0 ? page.trainingTypes : [...prior, ...page.trainingTypes.filter(row => !prior.some(value => value.id.toLowerCase() === row.id.toLowerCase()))]);
      setNextOffset(page.nextOffset); setLoaded(true);
    } catch (caught) {
      if (!request.signal.aborted) setError(caught && typeof caught === "object" && "code" in caught && ["401", "403"].includes(String(caught.code))
        ? "A current Hub and CareBase administrator session is required to load training types."
        : "Training types could not be loaded. Retry to obtain current native choices.");
    } finally { if (!request.signal.aborted) { setLoading(false); controller.current = null; } }
  }
  let changes: CreditPolicyChanges | null = null, invalid = "";
  try { changes = creditPolicyChanges(material, form); }
  catch { invalid = "Check the edited fields: credit hours need at most two decimal places, topic codes use uppercase letters, numbers, dots, underscores or hyphens, and each edited credit needs a citation. A supplied duration rationale needs at least 40 characters."; }
  const removed = material.credits.filter(row => !form.credits.some(value => value.creditId.toLowerCase() === row.id.toLowerCase()));
  return <section aria-label="Edit training credit policy"><h4>Training credit policy</h4>
    <p>Unchanged rules are retained exactly. Each edited or new rule must use a currently active global training type. CareBase validates the final policy before saving.</p>
    <fieldset disabled={busy || loading}>
      <label>Version label<input maxLength={300} value={form.versionLabel} onChange={event => update({ ...form, versionLabel: event.target.value })} /></label>
      <label>Credited duration rationale<textarea maxLength={12000} value={form.creditedDurationRationale}
        onChange={event => update({ ...form, creditedDurationRationale: event.target.value })} /></label>
      <p>A rationale may be cleared or must explain the duration in at least 40 characters.</p>
      <button type="button" onClick={() => void load(0)}>{loaded ? "Refresh active training types" : "Load active training types"}</button>
      {nextOffset !== null && <button type="button" onClick={() => void load(nextOffset)}>Load more training types</button>}
      {loaded && <p>{options.length} active training types loaded{nextOffset !== null ? "; more are available" : ""}.</p>}
      {form.credits.map((entry, index) => {
        const original = source.get(entry.creditId.toLowerCase());
        return <fieldset key={entry.creditId}><legend>Credit rule {index + 1}</legend>
          {"preserve" in entry && original ? <>
            <p>{original.topicCode} · {original.creditHours} hours · {original.mode === "verified_only" ? "Verified evidence required" : "Automatic"} · {original.active ? "Active" : "Inactive"}</p>
            <p>Training type: {label(original.trainingTypeId) ?? original.trainingTypeId}</p>
            <details><summary>Existing citation, retained exactly</summary><p style={{ whiteSpace: "pre-wrap" }}>{original.citationNote}</p></details>
            <button type="button" disabled={!label(original.trainingTypeId)} onClick={() => {
              try { changeCredit(editableCredit(original)); } catch { setError("This legacy rule can be retained or removed, but its current values cannot be edited in this form."); }
            }}>Edit credit rule {index + 1}</button>
            {!label(original.trainingTypeId) && <p>Load its active training type to edit this rule. Unavailable or inactive associations can be retained unchanged.</p>}
          </> : !("preserve" in entry) && <>
            <label>Training type{original ? <input readOnly value={label(entry.trainingTypeId) ?? entry.trainingTypeId} /> :
              <select value={entry.trainingTypeId} onChange={event => changeCredit({ ...entry, trainingTypeId: event.target.value })}>
                <option value="">Select a training type</option>{options.map(row => <option key={row.id} value={row.id}>{row.label}</option>)}
              </select>}</label>
            {original && <p>Changing this association requires removing this rule and adding a new rule.</p>}
            <label>Credit topic code<input maxLength={128} value={entry.topicCode} onChange={event => changeCredit({ ...entry, topicCode: event.target.value })} /></label>
            <label>Credit hours<input inputMode="decimal" value={entry.creditHours} onChange={event => changeCredit({ ...entry, creditHours: event.target.value })} /></label>
            <label>Credit mode<select value={entry.creditMode} onChange={event => changeCredit({ ...entry, creditMode: event.target.value as CreditDefinition["creditMode"] })}>
              <option value="automatic">Automatic</option><option value="verified_only">Verified evidence required</option></select></label>
            <label>Credit citation<textarea maxLength={12000} value={entry.citationNote} onChange={event => changeCredit({ ...entry, citationNote: event.target.value })} /></label>
            <label><input type="checkbox" checked={entry.isActive} onChange={event => changeCredit({ ...entry, isActive: event.target.checked })} />Credit rule active</label>
            {original && <button type="button" onClick={() => update({ ...form, credits: form.credits.map(row => row.creditId === entry.creditId ? { creditId: original.id, preserve: true } : row) })}>Keep original rule {index + 1}</button>}
          </>}
          <button type="button" onClick={() => remove(entry.creditId)}>Remove credit rule {index + 1}</button>
        </fieldset>;
      })}
      <button type="button" disabled={!options.length || form.credits.length >= 100} onClick={() => update({ ...form, credits: [...form.credits,
        { creditId: crypto.randomUUID(), trainingTypeId: "", topicCode: "", creditHours: "", creditMode: "automatic", citationNote: "", isActive: true }] })}>Add credit rule</button>
      {removed.length > 0 && <><p>These rules will be explicitly removed after review:</p><ul>{removed.map(row => <li key={row.id}>{row.topicCode} · {row.creditHours} hours</li>)}</ul></>}
      {invalid && <p>{invalid}</p>}
      <button type="button" disabled={!reasonReady || !changes || Boolean(invalid)} onClick={() => { if (changes) onPreview(changes); }}>Preview credit policy changes</button>
    </fieldset>
    {loading && <p role="status">Loading current training types…</p>}{error && <p role="alert">{error}</p>}
  </section>;
}
