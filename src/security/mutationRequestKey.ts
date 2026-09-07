export type MutationPayloadPart = string | number | boolean | null;

export interface PendingMutationRequest {
  fingerprint: string;
  requestKey: string;
}

type RequestKeyFactory = () => string;

const defaultRequestKeyFactory: RequestKeyFactory = () => crypto.randomUUID();

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
  const fingerprint = JSON.stringify(payload);
  if (pending?.fingerprint === fingerprint) return pending;

  return {
    fingerprint,
    requestKey: createRequestKey(),
  };
}
