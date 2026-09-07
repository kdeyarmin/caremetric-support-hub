import { describe, expect, it } from "vitest";
import { buildHelpUrl } from "./index";

describe("buildHelpUrl", () => {
  it("adds only approved context fields", () => {
    const url = new URL(
      buildHelpUrl({
        baseUrl: "https://support-hub-web-production.up.railway.app",
        context: {
          product: "pennfit",
          route: "/members/invite",
          feature: "member-invitations",
          appVersion: "3.8.2",
          locale: "en-US",
          environment: "production",
        },
      }),
    );

    expect(url.origin).toBe("https://support-hub-web-production.up.railway.app");
    expect(url.pathname).toBe("/help");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      product: "pennfit",
      route: "/members/invite",
      feature: "member-invitations",
      app_version: "3.8.2",
      locale: "en-US",
      environment: "production",
    });
  });

  it("truncates untrusted route context", () => {
    const url = new URL(
      buildHelpUrl({
        baseUrl: "https://support-hub-web-production.up.railway.app",
        context: { product: "pennsync", route: `/${"x".repeat(400)}` },
      }),
    );

    expect(url.searchParams.get("route")).toHaveLength(256);
  });
});
