import { describe, expect, it, vi } from "vitest";
import { verifyBackendContract, REQUIRED_BACKEND_FEATURES } from "./backendContract";

const origin = "https://project.supabase.co";
const key = "sb_publishable_test";

describe("deployed backend compatibility", () => {
  it("checks the hub schema using only public configuration", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ api_version: 4, features: REQUIRED_BACKEND_FEATURES }));
    await verifyBackendContract(origin, key, fetcher);
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, options] = fetcher.mock.calls[0];
    expect(String(url)).toBe(`${origin}/rest/v1/rpc/get_backend_contract`);
    expect(options).toMatchObject({
      method: "POST", redirect: "error", body: "{}",
      headers: { apikey: key, "Content-Type": "application/json", "Content-Profile": "hub" },
    });
    expect(options?.headers).not.toHaveProperty("Authorization");
  });

  it.each(REQUIRED_BACKEND_FEATURES)("rejects a release missing required feature %s even when its integer matches", async feature => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ api_version: 4, features: REQUIRED_BACKEND_FEATURES.filter(value => value !== feature) }));
    await expect(verifyBackendContract(origin, key, fetcher)).rejects.toThrow(/incompatible/);
  });

  it("accepts a later additive feature without weakening required capabilities", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ api_version: 4, features: [...REQUIRED_BACKEND_FEATURES, "learning.receipts.v1"] }));
    await expect(verifyBackendContract(origin, key, fetcher)).resolves.toBeUndefined();
  });

  it.each([404, 401, 500, 503])("blocks deployment on HTTP %s", async (status) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status }));
    await expect(verifyBackendContract(origin, key, fetcher)).rejects.toThrow(/Apply the reviewed migrations/);
  });

  it.each([null, {}, { api_version: "4" }, { api_version: 0 }, { api_version: 1 }, { api_version: 2 }, { api_version: 3 }, { api_version: 5 }])("rejects incompatible responses: %j", async (contract) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(contract));
    await expect(verifyBackendContract(origin, key, fetcher)).rejects.toThrow(/incompatible/);
  });

  it("blocks deployment when the backend cannot be reached", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error("network failure"));
    await expect(verifyBackendContract(origin, key, fetcher)).rejects.toThrow(/connectivity/);
  });

  it.each(["http://project.supabase.co", "https://user:pass@project.supabase.co", `${origin}/other`, `${origin}?token=x`])("does not transmit configuration to an invalid origin: %s", async (url) => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(verifyBackendContract(url, key, fetcher)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects a secret key before making a request", async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(verifyBackendContract(origin, "sb_secret_test", fetcher)).rejects.toThrow(/publishable/);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
