export type MutationPayloadPart = string | number | boolean | null;

export interface PendingMutationRequest {
  fingerprint: string;
  requestKey: string;
}

type RequestKeyFactory = () => string;

const defaultRequestKeyFactory: RequestKeyFactory = () => crypto.randomUUID();

function fingerprintPayloadPart(part: MutationPayloadPart): readonly [string, string?] {
  if (part === null) return ["null"];

  switch (typeof part) {
    case "string":
      return ["string", part];
    case "boolean":
      return ["boolean", part ? "true" : "false"];
    case "number":
      if (!Number.isFinite(part)) {
        throw new TypeError("Mutation payload numbers must be finite");
      }
      return ["number", Object.is(part, -0) ? "-0" : String(part)];
  }
}

/**
 * Returns the existing key only when every submitted payload value is unchanged.
 * Callers keep the returned state after a failed request, and clear it after a
 * successful request. This makes an ambiguous retry safe without sharing keys
 * between distinct user actions.
 */
export function prepareMutationRequest(
  pending: PendingMutationRequest | null,
  payload: readonly MutationPayloadPart[],
  createRequestKey: RequestKeyFactory = defaultRequestKeyFactory,
): PendingMutationRequest {
  const fingerprint = JSON.stringify(payload.map(fingerprintPayloadPart));
  if (pending?.fingerprint === fingerprint) return pending;

  return {
    fingerprint,
    requestKey: createRequestKey(),
  };
}
