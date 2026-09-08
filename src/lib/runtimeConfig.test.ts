import { describe, expect, it } from "vitest";
import { resolveRuntimeConfig } from "./runtimeConfig";

describe("Support Hub runtime configuration", () => {
  it("uses demo data only when demo mode is explicitly enabled", () => {
    expect(resolveRuntimeConfig({ VITE_DEMO_MODE: "true" }, "http://localhost:5173"))
      .toMatchObject({ demoMode: true, helpBaseUrl: "http://localhost:5173" });
  });

  it("fails closed when the demo-mode setting is missing or invalid", () => {
    expect(() => resolveRuntimeConfig({})).toThrow(/VITE_DEMO_MODE must be explicitly set/);
    expect(() => resolveRuntimeConfig({ VITE_DEMO_MODE: "TRUE" })).toThrow(
      /VITE_DEMO_MODE must be explicitly set/,
    );
  });

  it("requires both browser-safe Supabase values in connected mode", () => {
    expect(() => resolveRuntimeConfig({ VITE_DEMO_MODE: "false" })).toThrow(
      /requires VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY/,
    );
    expect(() => resolveRuntimeConfig({
      VITE_DEMO_MODE: "false",
      VITE_SUPABASE_URL: "https://project.supabase.co",
    })).toThrow(/requires VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY/);
  });

  it("enables connected mode only with a complete backend configuration", () => {
    expect(resolveRuntimeConfig({
      VITE_DEMO_MODE: "false",
      VITE_SUPABASE_URL: " https://project.supabase.co ",
      VITE_SUPABASE_PUBLISHABLE_KEY: " sb_publishable_example ",
      VITE_HELP_BASE_URL: " https://help.example.test ",
    })).toMatchObject({
      demoMode: false,
      supabaseUrl: "https://project.supabase.co",
      supabasePublishableKey: "sb_publishable_example",
      helpBaseUrl: "https://help.example.test",
    });
  });
});
