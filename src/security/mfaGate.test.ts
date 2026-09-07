import { describe, expect, it } from "vitest";
import { decideMfaGate, normalizeAuthenticatorLevel } from "./mfaGate";

describe("MFA gate", () => {
  it("allows an AAL2 session into the authenticated application", () => {
    expect(decideMfaGate({
      currentLevel: "aal2",
      nextLevel: "aal2",
      verifiedTotpFactors: [{ id: "verified-factor", label: "Primary" }],
      requiresMfa: true,
    })).toEqual({ status: "ready" });
  });

  it("challenges an AAL1 session that can advance to AAL2", () => {
    expect(decideMfaGate({
      currentLevel: "aal1",
      nextLevel: "aal2",
      verifiedTotpFactors: [
        { id: "verified-factor", label: "Primary" },
        { id: "backup-factor", label: "Backup" },
      ],
      requiresMfa: true,
    })).toEqual({
      status: "challenge",
      factors: [
        { id: "verified-factor", label: "Primary" },
        { id: "backup-factor", label: "Backup" },
      ],
    });
  });

  it("enrolls a user that has no verified TOTP factor", () => {
    expect(decideMfaGate({
      currentLevel: "aal1",
      nextLevel: "aal1",
      verifiedTotpFactors: [],
      requiresMfa: true,
    })).toEqual({ status: "enroll" });
  });

  it("fails closed when the assurance data is incomplete", () => {
    expect(() => decideMfaGate({
      currentLevel: null,
      nextLevel: null,
      verifiedTotpFactors: [],
      requiresMfa: true,
    })).toThrow("Authenticator assurance data is unavailable.");
  });

  it("allows an ordinary customer without an enrolled factor to continue at AAL1", () => {
    expect(decideMfaGate({
      currentLevel: "aal1",
      nextLevel: "aal1",
      verifiedTotpFactors: [],
      requiresMfa: false,
    })).toEqual({ status: "ready" });
  });

  it("challenges an opted-in customer before continuing", () => {
    expect(decideMfaGate({
      currentLevel: "aal1",
      nextLevel: "aal2",
      verifiedTotpFactors: [{ id: "customer-factor", label: "Authenticator" }],
      requiresMfa: false,
    })).toEqual({
      status: "challenge",
      factors: [{ id: "customer-factor", label: "Authenticator" }],
    });
  });

  it("normalizes only supported assurance claims", () => {
    expect(normalizeAuthenticatorLevel("aal1")).toBe("aal1");
    expect(normalizeAuthenticatorLevel("aal2")).toBe("aal2");
    expect(normalizeAuthenticatorLevel("unexpected")).toBeNull();
    expect(normalizeAuthenticatorLevel(null)).toBeNull();
  });
});
