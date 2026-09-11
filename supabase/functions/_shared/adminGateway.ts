import { isUuid } from "./adminProtocol.ts";

const hubOrigin = "https://xgauehtwksmnoqhgqegm.supabase.co";
const allowedOrigins = new Set(["https://support-hub-web-production.up.railway.app", "https://help.caremetric.ai"]);
interface GatewayContract<T> {
  authorizationRpc: "authorize_platform_admin" | "authorize_platform_command";
  parse(input: unknown): T;
  target(input: T): { endpoint: string | null; body: unknown };
  project(response: unknown, input: T): unknown;
  validateAuthority?(actor: Record<string, unknown>): boolean;
  commandErrors?: boolean;
}
export interface AdminProxyOptions { publishableKey: string; fetcher?: typeof fetch; }

async function readJson(source: Request | Response, max: number, signal: AbortSignal): Promise<unknown> {
  if (!source.body) throw new Error("Missing JSON");
  const reader = source.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    let size = 0;
    const chunks: Uint8Array[] = [];
    while (true) {
      if (signal.aborted) throw new Error("Request timed out");
      const { value, done } = await reader.read();
      if (signal.aborted) throw new Error("Request timed out");
      if (done) break;
      size += value.length;
      if (size > max) { cancel(); throw new Error("Response too large"); }
      chunks.push(value);
    }
    const joined = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.length; }
    return JSON.parse(new TextDecoder().decode(joined));
  } finally { signal.removeEventListener("abort", cancel); reader.releaseLock(); }
}

export function createAdminGateway<T>({ publishableKey, fetcher = fetch }: AdminProxyOptions, contract: GatewayContract<T>) {
  const safeErrors = new Set(["unauthenticated", "forbidden", "unconfigured", "notfound", "upstream", ...(contract.commandErrors ? ["conflict", "expired", "invalid_request"] : [])]);
  return async (request: Request): Promise<Response> => {
    const origin = request.headers.get("origin");
    const headers: Record<string, string> = {
      "Cache-Control": "no-store", "Content-Type": "application/json", "X-Content-Type-Options": "nosniff", Vary: "Origin",
    };
    if (origin && allowedOrigins.has(origin)) {
      headers["Access-Control-Allow-Origin"] = origin;
      headers["Access-Control-Allow-Headers"] = "authorization, apikey, content-type, x-client-info";
      headers["Access-Control-Allow-Methods"] = "POST, OPTIONS";
    }
    const reply = (status: number, code: string) => new Response(JSON.stringify({ error: { code } }), { status, headers });
    if (origin && !allowedOrigins.has(origin)) return reply(403, "forbidden");
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    if (request.method !== "POST") return reply(405, "method_not_allowed");
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return reply(400, "invalid_request");
    const authorization = request.headers.get("authorization") ?? "";
    if (!/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(authorization) || authorization.length > 8192) return reply(401, "unauthenticated");
    if (!publishableKey || publishableKey.startsWith("sb_secret_")) return reply(503, "unconfigured");
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(12000)]);
    try {
      const authResponse = await fetcher(`${hubOrigin}/rest/v1/rpc/${contract.authorizationRpc}`, {
        method: "POST", headers: { apikey: publishableKey, Authorization: authorization, "Content-Type": "application/json", "Content-Profile": "hub" },
        body: "{}", redirect: "error", signal,
      });
      if (!authResponse.ok) return reply(authResponse.status === 401 ? 401 : authResponse.status === 403 ? 403 : 503,
        authResponse.status === 401 ? "unauthenticated" : authResponse.status === 403 ? "forbidden" : "unconfigured");
      const actor = await readJson(authResponse, 4096, signal) as Record<string, unknown>;
      if (!actor || !isUuid(actor.user_id) || actor.role !== "platform_admin" || actor.aal !== "aal2" || (contract.validateAuthority && !contract.validateAuthority(actor))) return reply(403, "forbidden");
      let parsed: T;
      try { parsed = contract.parse(await readJson(request, 4096, signal)); }
      catch { return reply(400, "invalid_request"); }
      const target = contract.target(parsed);
      const appUrl = target.endpoint;
      if (!appUrl) return reply(503, "unconfigured");
      const response = await fetcher(appUrl, { method: "POST", headers: { Authorization: authorization, "Content-Type": "application/json" }, body: JSON.stringify(target.body), redirect: "error", signal });
      if (!response.ok) {
        let code = response.status === 401 ? "unauthenticated" : response.status === 403 ? "forbidden" : response.status === 404 ? "unconfigured" : "upstream";
        try {
          const error = await readJson(response, 4096, signal) as { error?: { code?: string } };
          if (error.error?.code && safeErrors.has(error.error.code)) code = error.error.code;
        } catch { /* Never expose upstream pages, exception text, or credentials. */ }
        const status = code === "unauthenticated" ? 401 : code === "forbidden" ? 403 : code === "notfound" ? 404 : code === "conflict" || code === "expired" ? 409 : code === "invalid_request" ? 400 : 503;
        return reply(status, code);
      }
      if (!response.headers.get("content-type")?.includes("application/json")) return reply(502, "upstream");
      const data = contract.project(await readJson(response, 1048576, signal), parsed);
      return new Response(JSON.stringify(data), { status: 200, headers });
    } catch { return reply(503, "upstream"); }
  };
}
