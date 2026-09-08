import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const nginx = readFileSync(new URL("../../nginx.conf", import.meta.url), "utf8");
const dockerfile = readFileSync(new URL("../../Dockerfile", import.meta.url), "utf8");
const viteConfig = readFileSync(new URL("../../vite.config.ts", import.meta.url), "utf8");
const railway = readFileSync(new URL("../../railway.json", import.meta.url), "utf8");

describe("production web-server contract", () => {
  it("sets HSTS on both application and immutable-asset responses", () => {
    expect(nginx.match(/add_header Strict-Transport-Security/g)).toHaveLength(2);
    expect(nginx).toContain('"max-age=31536000; includeSubDomains" always');
  });

  it("keeps the full response-header set inside the asset location", () => {
    const assetLocation = nginx.match(/location ~\*[\s\S]+?\n[ ]{2}}/)?.[0] ?? "";
    for (const header of [
      "Cache-Control",
      "X-Content-Type-Options",
      "X-Frame-Options",
      "Strict-Transport-Security",
      "Referrer-Policy",
      "Permissions-Policy",
      "Content-Security-Policy",
    ]) {
      expect(assetLocation).toContain(`add_header ${header}`);
    }
  });

  it("feeds connected-mode variables into the validated production build", () => {
    for (const name of [
      "VITE_DEMO_MODE",
      "VITE_SUPABASE_URL",
      "VITE_SUPABASE_PUBLISHABLE_KEY",
    ]) {
      expect(dockerfile).toContain(`ARG ${name}`);
      expect(dockerfile).toContain(`ENV ${name}=\${${name}}`);
    }
    expect(dockerfile).toContain("RUN npm run build");
    expect(viteConfig).toContain('if (command === "build")');
    expect(viteConfig).toContain("validateBuildRuntimeConfig(");
    expect(railway).toContain('"builder": "DOCKERFILE"');
  });
});
