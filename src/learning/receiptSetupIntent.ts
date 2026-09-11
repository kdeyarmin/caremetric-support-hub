import type { LearningReceiptOperation } from "./receiptProtocol";

export type ReceiptSetupIntent =
  | Omit<Extract<LearningReceiptOperation, { operation: "provision_access" }>, "hubTenantId">
  | Omit<Extract<LearningReceiptOperation, { operation: "provision" }>, "mappingId">;

// Keep an allocation for every submitted intent during this setup session. A lost
// response, form edit, or return to an earlier intent must not create a second writer.
export function receiptSetupId(cache: Map<string, string>, intent: ReceiptSetupIntent, createId: () => string = () => crypto.randomUUID()): string {
  const key = JSON.stringify(Object.entries(intent).sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => [name, name === "tenantName" ? value.trim() : value.trim().toLowerCase()]));
  const prior = cache.get(key);
  if (prior) return prior;
  const id = createId(); cache.set(key, id); return id;
}
