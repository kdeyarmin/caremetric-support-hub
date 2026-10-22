import { config } from "../lib/config";
import { generationMessage, generationOperationSchema, projectGenerationResult, type GenerationOperation, type GenerationResult } from "./generationProtocol";

const codes = ["unauthenticated", "forbidden", "conflict", "invalid_request", "timeout", "unconfigured", "provider_runtime_busy", "upstream"];
export class GenerationError extends Error {
  readonly code: string; readonly detail: string | null;
  constructor(code: string, detail: string | null) { super("Generation request could not be completed."); this.code = code; this.detail = detail; }
}
/** AI and video calls can run for about two and a half minutes before CareBase answers. */
export async function runGeneration<O extends GenerationOperation>(operation: O, signal: AbortSignal): Promise<GenerationResult<O["operation"]>> {
  const op = generationOperationSchema.parse(operation) as O;
  if (config.demoMode) throw new GenerationError("unconfigured", null);
  const response = await fetch("/api/admin/learning-generation", {
    method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(op),
    signal: AbortSignal.any([signal, AbortSignal.timeout(175_000)]), redirect: "error", cache: "no-store",
  }).catch(caught => { throw new GenerationError(caught instanceof DOMException && caught.name === "TimeoutError" ? "timeout" : "upstream", null); });
  if (!response.ok) {
    let code = response.status === 401 ? "unauthenticated" : response.status === 403 ? "forbidden" : "upstream", detail: string | null = null;
    try {
      const body = await response.json() as { error?: { code?: unknown; message?: unknown } };
      if (typeof body.error?.code === "string" && codes.includes(body.error.code)) code = body.error.code;
      detail = generationMessage(body.error?.message);
    } catch { /* Only the reviewed code and administrator message are shown. */ }
    throw new GenerationError(code, detail);
  }
  return projectGenerationResult(await response.json(), op);
}
export function generationFailure(caught: unknown, fallback: string) {
  if (!(caught instanceof GenerationError)) return fallback;
  if (caught.detail) return caught.detail;
  return caught.code === "timeout" ? "Generation ran past its time limit. You can retry with the same inputs." :
    caught.code === "provider_runtime_busy" ? "CareBase is already running two generation calls. Wait a moment, then retry." :
    caught.code === "unconfigured" ? "AI and video generation are not switched on in CareBase yet." :
    caught.code === "unauthenticated" || caught.code === "forbidden" ? "A current administrator session in the Hub and CareBase is required." :
    caught.code === "conflict" ? "The course changed or another generation is pending. Load the course material again." : fallback;
}
