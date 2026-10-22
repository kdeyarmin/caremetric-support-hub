import { useCallback, useEffect, useState } from "react";
import type { GovernedCourse } from "../imports/governedLearningImport";
import { packageClient, type PackageClient } from "./packageClient";
import type { PackageDependency } from "./packageProtocol";
import "./package.css";

const shortId = (value: string) => value.slice(0, 8);
const failure = (caught: unknown) => {
  const code = caught && typeof caught === "object" && "code" in caught ? caught.code : "upstream";
  return code === "conflict" ? "That package is not an eligible replacement, or the original package is no longer available. Choose or upload another package." :
    code === "notfound" ? "This version is no longer an editable draft, or it no longer depends on that package. Load the course versions again." :
    code === "invalid_request" ? "Choose a replacement that is a different package from the original." :
    code === "unauthenticated" || code === "forbidden" ? "A current administrator session in the Hub and CareBase is required." :
    code === "unconfigured" ? "Package replacement is not switched on in CareBase yet." :
    "The request did not finish. Check the connection and try again.";
};

/** Replace packages: a cloned draft cannot publish until each copied package has a separately accepted replacement. */
export function PackageDependencyPanel({ courseId, versionId, material, disabled, onResolved, client = packageClient }: {
  courseId: string; versionId: string; material: GovernedCourse; disabled: boolean; onResolved: () => void; client?: PackageClient;
}) {
  const [rows, setRows] = useState<PackageDependency[] | null>(null);
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [message, setMessage] = useState("");
  const load = useCallback((signal: AbortSignal) => client.dependencies({ operation: "dependencies", courseId, versionId }, signal), [client, courseId, versionId]);
  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal).then(setRows).catch(caught => { if (!controller.signal.aborted) setError(failure(caught)); });
    return () => controller.abort();
  }, [load]);
  // Only accepted packages of the same standard in this draft can replace a source package.
  const candidates = (row: PackageDependency) => material.packages.filter(pkg => pkg.validationStatus === "accepted" && pkg.standard === row.standard
    && pkg.id.toLowerCase() !== row.sourcePackageId);
  async function resolve(row: PackageDependency) {
    const replacementPackageId = choices[row.sourcePackageId];
    if (!replacementPackageId || busy) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const result = await client.resolve({ operation: "resolve", courseId, versionId, sourcePackageId: row.sourcePackageId, replacementPackageId }, new AbortController().signal);
      const next = await load(new AbortController().signal);
      setRows(next); setMessage(`CareBase recorded package ${shortId(result.replacementPackageId)} as the replacement for ${shortId(result.sourcePackageId)}.`);
      if (next.every(value => value.resolved)) onResolved();
    } catch (caught) { setError(failure(caught)); }
    finally { setBusy(false); }
  }
  const open = rows?.filter(row => !row.resolved) ?? [];
  return <section aria-label="Replace packages"><h4>Replace packages</h4>
    <p>This draft was cloned from a version with SCORM or xAPI packages. Each copied package needs a separately uploaded replacement in this draft before it can be published.
      Upload each replacement with the package controls, finish it until CareBase accepts it, then load and preserve the course material again so it appears here.</p>
    {error && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}
    {!rows && !error && <p role="status">Loading package dependencies…</p>}
    {rows && rows.length === 0 && <p>This draft depends on no copied packages.</p>}
    {rows && rows.length > 0 && <ul className="learning-dependency-list">{rows.map(row => {
      const options = candidates(row);
      return <li key={row.sourcePackageId}><strong>Package {shortId(row.sourcePackageId)}</strong><span> · {row.standard ?? "Unknown standard"}</span>
        {row.resolved ? <span> · Replaced by {shortId(row.replacementPackageId!)}</span> : <>
          <span> · Needs a replacement{row.replacementPackageId ? ` (the recorded replacement ${shortId(row.replacementPackageId)} is no longer accepted)` : ""}</span>
          {options.length === 0 ? <span> · No accepted {row.standard ?? ""} package in this draft yet.</span> : <>
            <label>Replacement<select disabled={disabled || busy} value={choices[row.sourcePackageId] ?? ""}
              onChange={event => setChoices(current => ({ ...current, [row.sourcePackageId]: event.target.value }))}>
              <option value="">Choose an accepted package</option>{options.map(pkg => <option key={pkg.id} value={pkg.id}>{shortId(pkg.id)} · {pkg.entryPoint ?? "no entry point"}</option>)}</select></label>
            <button type="button" className="button button-secondary button-small" disabled={disabled || busy || !choices[row.sourcePackageId]}
              onClick={() => void resolve(row)}>Use this replacement</button></>}
        </>}</li>;
    })}</ul>}
    {rows && rows.length > 0 && open.length === 0 && <p role="status">Every package dependency is resolved. Load the course versions to preview publication.</p>}
  </section>;
}
