import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildHelpUrl,
  buildLearningUrl,
  CAREMETRIC_PRODUCT_SLUGS,
  DEFAULT_HELP_BASE_URL,
  openHelp,
  openLearning,
} from "./index";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("buildHelpUrl", () => {
  it("accepts every registered CareMetric product and no unknown product", () => {
    expect(CAREMETRIC_PRODUCT_SLUGS).toEqual([
      "breathe",
      "carebase",
      "caremetric-emr",
      "caremetric-go",
      "caremetric-intel",
      "pennsync",
    ]);
    for (const product of CAREMETRIC_PRODUCT_SLUGS) {
      expect(new URL(buildHelpUrl({ context: { product } })).searchParams.get("product")).toBe(product);
    }
    expect(() => buildHelpUrl({
      context: { product: "unknown" } as unknown as Parameters<typeof buildHelpUrl>[0]["context"],
    })).toThrow("product slug");
  });

  it("adds only approved context fields", () => {
    const url = new URL(
      buildHelpUrl({
        baseUrl: "https://support-hub-web-production.up.railway.app",
        routeAllowlist: ["/members/invite"],
        featureAllowlist: ["member-invitations"],
        context: {
          product: "breathe",
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
      product: "breathe",
      route: "/members/invite",
      feature: "member-invitations",
      app_version: "3.8.2",
      locale: "en-US",
      environment: "production",
    });
  });

  it("omits overlong unregistered route context", () => {
    const url = new URL(
      buildHelpUrl({
        baseUrl: "https://support-hub-web-production.up.railway.app",
        context: { product: "pennsync", route: `/${"x".repeat(400)}` },
      }),
    );

    expect(url.searchParams.has("route")).toBe(false);
  });

  it("uses the live Support Hub when a base URL is omitted", () => {
    const url = new URL(buildHelpUrl({ context: { product: "breathe" } }));

    expect(url.origin).toBe(DEFAULT_HELP_BASE_URL);
    expect(url.pathname).toBe("/help");
    expect(url.searchParams.get("product")).toBe("breathe");
  });

  it("removes query strings and fragments from route context", () => {
    const url = new URL(
      buildHelpUrl({
        routeAllowlist: ["/patients/route-template"],
        context: {
          product: "pennsync",
          route: "/patients/route-template?patient=do-not-send#clinical-record",
        },
      }),
    );

    expect(url.searchParams.get("route")).toBe("/patients/route-template");
    expect(url.toString()).not.toContain("do-not-send");
    expect(url.toString()).not.toContain("clinical-record");
  });

  it("fails closed when route context is not in the caller's static registry", () => {
    for (const route of [
      "/patients/4535a2d2-3e4e-4c72-a3f6-77a1dc372be6",
      "/patients/12345",
      "/patients/Jane-Doe",
      "/patients/MRNABC123",
      "/accounts/acme-health",
      "/patients/01ARZ3NDEKTSV4RRFFQ69G5FAV",
      "/patients/name%40example.com",
      "not-an-absolute-route",
    ]) {
      const url = new URL(buildHelpUrl({
        routeAllowlist: ["/patients/:patientId"],
        context: { product: "caremetric-emr", route },
      }));
      expect(url.searchParams.has("route")).toBe(false);
    }
  });

  it("omits route and feature context when no static registry is supplied", () => {
    const url = new URL(buildHelpUrl({
      context: {
        product: "breathe",
        route: "/patients/Jane-Doe",
        feature: "MRNABC123",
      },
    }));

    expect(Object.fromEntries(url.searchParams)).toEqual({ product: "breathe" });
  });

  it("accepts only version-shaped application versions", () => {
    const accepted = new URL(buildHelpUrl({
      context: { product: "carebase", appVersion: "v3.8.2-beta.1" },
    }));
    const rejected = new URL(buildHelpUrl({
      context: { product: "carebase", appVersion: "MRNABC123" },
    }));

    expect(accepted.searchParams.get("app_version")).toBe("v3.8.2-beta.1");
    expect(rejected.searchParams.has("app_version")).toBe(false);
  });

  it("ignores fields outside the approved context contract", () => {
    const url = new URL(
      buildHelpUrl({
        context: {
          product: "breathe",
          environment: "invalid-at-runtime",
          patientId: "do-not-send",
          accessToken: "do-not-send",
        } as unknown as Parameters<typeof buildHelpUrl>[0]["context"],
      }),
    );

    expect(Object.fromEntries(url.searchParams)).toEqual({ product: "breathe" });
    expect(url.toString()).not.toContain("do-not-send");
  });

  it("rejects an empty product and base URLs with embedded credentials", () => {
    expect(() => buildHelpUrl({
      context: { product: "unknown" } as unknown as Parameters<typeof buildHelpUrl>[0]["context"],
    })).toThrow("product slug");
    expect(() =>
      buildHelpUrl({
        baseUrl: "https://user:secret@support.example.com",
        context: { product: "breathe" },
      }),
    ).toThrow("must not include credentials");
  });

  it("rejects insecure and localhost Hub destinations", () => {
    expect(() => buildHelpUrl({
      baseUrl: "http://support.example.com",
      context: { product: "breathe" },
    })).toThrow("must use https");
    for (const baseUrl of [
      "https://localhost:4173",
      "https://localhost.:4173",
      "https://preview.localhost",
      "https://127.0.0.2",
      "https://[::1]",
      "https://[::ffff:127.0.0.1]",
      "https://[::ffff:7f00:1]",
      "https://[::ffff:127.1.2.3]",
    ]) {
      expect(() => buildHelpUrl({
        baseUrl,
        context: { product: "breathe" },
      })).toThrow("loopback");
    }
  });
});

describe("openHelp", () => {
  it("opens the live portal in an isolated tab by default", () => {
    const opened = { opener: {} };
    const open = vi.fn(() => opened);
    vi.stubGlobal("window", { open });

    openHelp({
      featureAllowlist: ["member-invitations"],
      context: { product: "breathe", feature: "member-invitations" },
    });

    expect(open).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledWith(
      `${DEFAULT_HELP_BASE_URL}/help?product=breathe&feature=member-invitations`,
      "_blank",
      "noopener,noreferrer",
    );
    expect(opened.opener).toBeNull();
  });

  it("fails clearly when invoked during server rendering", () => {
    vi.stubGlobal("window", undefined);

    expect(() => openHelp({ context: { product: "breathe" } })).toThrow(
      "can only be called in a browser",
    );
  });
});

describe("buildLearningUrl", () => {
  it("builds the unfiltered live learning-library URL by default", () => {
    const url = new URL(buildLearningUrl());

    expect(url.origin).toBe(DEFAULT_HELP_BASE_URL);
    expect(url.pathname).toBe("/learn");
    expect([...url.searchParams]).toEqual([]);
  });

  it("accepts each registered product as the only optional context", () => {
    for (const product of CAREMETRIC_PRODUCT_SLUGS) {
      const url = new URL(buildLearningUrl({ product }));
      expect(Object.fromEntries(url.searchParams)).toEqual({ product });
    }
  });

  it("rejects an unregistered product instead of forwarding it", () => {
    expect(() => buildLearningUrl({
      product: "unknown" as unknown as (typeof CAREMETRIC_PRODUCT_SLUGS)[number],
    })).toThrow("product slug");
  });

  it("does not forward route, free-text, identity, or arbitrary fields", () => {
    const url = new URL(buildLearningUrl({
      product: "caremetric-intel",
      route: "/patients/12345",
      query: "Jane Doe medication error",
      userId: "user-123",
      tenantId: "tenant-456",
      patientId: "patient-789",
      accessToken: "secret-token",
    } as unknown as Parameters<typeof buildLearningUrl>[0]));

    expect(Object.fromEntries(url.searchParams)).toEqual({ product: "caremetric-intel" });
    expect(url.toString()).not.toMatch(/Jane|patient|tenant|secret|route/i);
  });

  it("uses only the validated origin from an explicit Hub URL", () => {
    const url = new URL(buildLearningUrl({
      baseUrl: "https://support.example.com/not-a-route?unsafe=value#fragment",
      product: "carebase",
    }));

    expect(url.toString()).toBe("https://support.example.com/learn?product=carebase");
  });

  it("rejects credentials, insecure schemes, and local destinations", () => {
    for (const baseUrl of [
      "https://user:secret@support.example.com",
      "http://support.example.com",
      "https://localhost:4173",
      "https://preview.localhost",
      "https://127.0.0.1",
      "https://[::1]",
      "https://[::ffff:127.0.0.1]",
    ]) {
      expect(() => buildLearningUrl({ baseUrl })).toThrow();
    }
  });
});

describe("openLearning", () => {
  it("opens a product-filtered learning library in an isolated tab by default", () => {
    const opened = { opener: {} };
    const open = vi.fn(() => opened);
    vi.stubGlobal("window", { open });

    openLearning({ product: "pennsync" });

    expect(open).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledWith(
      `${DEFAULT_HELP_BASE_URL}/learn?product=pennsync`,
      "_blank",
      "noopener,noreferrer",
    );
    expect(opened.opener).toBeNull();
  });

  it("supports same-window navigation without isolated-tab features", () => {
    const opened = { opener: {} };
    const open = vi.fn(() => opened);
    vi.stubGlobal("window", { open });

    openLearning({ target: "_self" });

    expect(open).toHaveBeenCalledWith(`${DEFAULT_HELP_BASE_URL}/learn`, "_self", undefined);
    expect(opened.opener).toEqual({});
  });

  it("fails clearly when invoked during server rendering", () => {
    vi.stubGlobal("window", undefined);

    expect(() => openLearning()).toThrow("can only be called in a browser");
  });
});
