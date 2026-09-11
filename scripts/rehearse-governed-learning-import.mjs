// Offline by design. Staging is available only through the authenticated Hub UI/RPC.
// Never print source payloads, answer keys, provider names, or local input paths.
import { readFileSync, statSync } from "node:fs";
import { prepareGovernedImport, governedImportSummary } from "../src/imports/governedLearningImport.ts";
const [path, ...extra] = process.argv.slice(2);
if (!path || extra.length) throw new Error("Usage: node scripts/rehearse-governed-learning-import.mjs snapshot.json");
try {
  if (statSync(path).size > 25_000_000) throw new Error("size");
  const imports = await prepareGovernedImport(JSON.parse(readFileSync(path, "utf8")));
  console.log(JSON.stringify({ valid: true, ...governedImportSummary(imports), publicationEnabled: false }, null, 2));
} catch {
  console.error("Governed export validation failed. Review its format, size, checksums, and excluded credentials in the authorized editor.");
  process.exitCode = 1;
}
