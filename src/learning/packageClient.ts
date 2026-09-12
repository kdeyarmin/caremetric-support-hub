import { AdminApiError } from "../admin/transport";
import { portfolioClient } from "../admin/portfolioClient";
import { config } from "../lib/config";
import { packageCapabilities, packageContextViewSchema, packageOperationSchema, packageResultSchema, packageStageSchema, packageStatusSchema,
  PACKAGE_MAX_BYTES, PACKAGE_RESPONSE_BYTES, type PackageOperation, type PackageContextView, type PackageStatus, type PackageResult, type PackageStage } from "./packageProtocol";

export interface PackageClient {
  available(signal: AbortSignal): Promise<boolean>;
  context(operation: Extract<PackageOperation, { operation: "context" }>, signal: AbortSignal): Promise<PackageContextView>;
  status(operation: Extract<PackageOperation, { operation: "status" }>, signal: AbortSignal): Promise<PackageStatus>;
  stage(operation: Extract<PackageOperation, { operation: "upload" | "accept" }>, file: File | null, signal: AbortSignal): Promise<PackageStage>;
  finish(operation: Extract<PackageOperation, { operation: "finish" }>, signal: AbortSignal): Promise<PackageResult>;
}
export function encodePackageHeader(operation: PackageOperation): string {
  const bytes = new TextEncoder().encode(JSON.stringify(packageOperationSchema.parse(operation)));
  return btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join("")).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
export async function hashPackage(file: File): Promise<string> {
  if (file.size < 1 || file.size > PACKAGE_MAX_BYTES) throw new AdminApiError("payload_too_large");
  const result = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(result), value => value.toString(16).padStart(2, "0")).join("");
}
async function readJson(response: Response, signal: AbortSignal) {
  if (!response.body) throw new AdminApiError("upstream");
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) { signal.throwIfAborted(); const { done, value } = await reader.read(); if (done) break;
      size += value.length; if (size > PACKAGE_RESPONSE_BYTES) { await reader.cancel(); throw new AdminApiError("upstream"); } chunks.push(value); }
    signal.throwIfAborted(); const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } finally { signal.removeEventListener("abort", cancel); reader.releaseLock(); }
}
async function request(operation: PackageOperation, signal: AbortSignal, file: File | null = null): Promise<unknown> {
  if (config.demoMode) throw new AdminApiError("unconfigured");
  const op = packageOperationSchema.parse(operation);
  const timeout = AbortSignal.any([signal, AbortSignal.timeout(120000)]);
  const upload = op.operation === "upload";
  if (upload && (!file || file.size !== op.sourceBytes)) throw new AdminApiError("invalid_request");
  const response = await fetch("/api/admin/packages", { method: "POST", credentials: "same-origin", redirect: "error", cache: "no-store", signal: timeout,
    headers: upload ? { "Content-Type": "application/zip", "x-caremetric-package-request": encodePackageHeader(op) } : { "Content-Type": "application/json" },
    body: upload ? file : JSON.stringify(op) });
  let result: unknown;
  try { result = await readJson(response, timeout); } catch { throw new AdminApiError(response.status === 401 ? "unauthenticated" : response.status === 403 ? "forbidden" : "upstream"); }
  if (!response.ok) {
    let code = response.status === 401 ? "unauthenticated" : response.status === 403 ? "forbidden" : "upstream";
    const error = result && typeof result === "object" && "error" in result ? result.error : null;
    if (error && typeof error === "object" && "code" in error && typeof error.code === "string"
      && ["unconfigured", "busy", "notfound", "upstream", "invalid_request", "conflict", "artifact_mismatch", "payload_too_large", "unauthenticated", "forbidden"].includes(error.code)) code = error.code;
    throw new AdminApiError(code);
  }
  return result;
}
export const packageClient: PackageClient = {
  available: async signal => { const capabilities = await portfolioClient.capabilities({ product: "carebase", signal }); return packageCapabilities.every(value => capabilities.operations.includes(value)); },
  context: async (operation, signal) => packageContextViewSchema.parse(await request(operation, signal)),
  status: async (operation, signal) => packageStatusSchema.parse(await request(operation, signal)),
  stage: async (operation, file, signal) => packageStageSchema.parse(await request(operation, signal, file)),
  finish: async (operation, signal) => packageResultSchema.parse(await request(operation, signal)),
};
