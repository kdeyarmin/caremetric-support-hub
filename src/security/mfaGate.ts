export type AuthenticatorLevel = "aal1" | "aal2" | null;

export interface VerifiedTotpFactor {
  id: string;
  label: string;
}

export type MfaGate =
  | { status: "checking" }
  | { status: "enroll" }
  | { status: "challenge"; factors: VerifiedTotpFactor[] }
  | { status: "ready" };

interface MfaGateInput {
  currentLevel: AuthenticatorLevel;
  nextLevel: AuthenticatorLevel;
  verifiedTotpFactors: VerifiedTotpFactor[];
  requiresMfa: boolean;
}

export function normalizeAuthenticatorLevel(value: string | null): AuthenticatorLevel {
  if (value === "aal1" || value === "aal2") return value;
  return null;
}

export function decideMfaGate({
  currentLevel,
  nextLevel,
  verifiedTotpFactors,
  requiresMfa,
}: MfaGateInput): MfaGate {
  if (!currentLevel || !nextLevel) {
    throw new Error("Authenticator assurance data is unavailable.");
  }
  if (currentLevel === "aal2") return { status: "ready" };

  if (nextLevel === "aal2" && verifiedTotpFactors.length > 0) {
    return { status: "challenge", factors: verifiedTotpFactors };
  }

  if (!requiresMfa) return { status: "ready" };
  return { status: "enroll" };
}
