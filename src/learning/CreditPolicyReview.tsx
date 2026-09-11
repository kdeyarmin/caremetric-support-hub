import type { GovernedCourse } from "../imports/governedLearningImport";
import type { CreditPolicyChanges } from "./creditPolicyProtocol";

export function CreditPolicyReview({ material, changes }: { material: GovernedCourse; changes: CreditPolicyChanges }) {
  const original = new Map(material.credits.map(row => [row.id.toLowerCase(), row]));
  return <section aria-label="Review credit policy changes"><h4>Review credit policy</h4>
    {Object.hasOwn(changes.policy, "versionLabel") && <p>Version label: {material.version.label ?? "None"} → {changes.policy.versionLabel ?? "None"}</p>}
    {Object.hasOwn(changes.policy, "creditedDurationRationale") && <><p>Credited duration rationale:</p>
      <p style={{ whiteSpace: "pre-wrap" }}>{changes.policy.creditedDurationRationale ?? "Clear existing rationale"}</p></>}
    <ul>{changes.credits.map(row => <li key={row.creditId}>{"preserve" in row ? <>Keep {original.get(row.creditId.toLowerCase())?.topicCode ?? row.creditId} exactly as saved</> : <>
      <strong>{original.has(row.creditId.toLowerCase()) ? "Edit" : "Add"} {row.topicCode}</strong>
      <p>{row.creditHours} hours · {row.creditMode === "automatic" ? "Automatic" : "Verified evidence required"} · {row.isActive ? "Active" : "Inactive"}</p>
      <p>Training type: {row.trainingTypeId}</p><p style={{ whiteSpace: "pre-wrap" }}>{row.citationNote}</p>
    </>}</li>)}</ul>
    {changes.removedCreditIds.length > 0 && <><strong>Remove these rules</strong><ul>{changes.removedCreditIds.map(id => <li key={id}>
      {original.get(id.toLowerCase())?.topicCode ?? id} · {original.get(id.toLowerCase())?.creditHours ?? ""} hours</li>)}</ul></>}
    <p>The reviewed draft receives these changes together. Existing learner credit records are retained by CareBase.</p>
    <details><summary>Exact policy identifiers and values</summary><pre>{JSON.stringify(changes, null, 2)}</pre></details>
  </section>;
}
