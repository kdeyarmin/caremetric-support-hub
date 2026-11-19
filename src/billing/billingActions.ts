import { useRef, useState } from 'react';
import { prepareMutationRequest, type PendingMutationRequest } from '../security/mutationRequestKey';
import type { BillingResult } from './billingProtocol';

/**
 * Runs one billing command. The request key stays the same while the submitted
 * values are unchanged, so retrying after an uncertain failure never creates a
 * second Stripe object.
 */
export function useBillingAction() {
  const pending = useRef<PendingMutationRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function run(parts: ReadonlyArray<string | number | boolean | null>, send: (requestKey: string) => Promise<BillingResult>): Promise<BillingResult | null> {
    pending.current = prepareMutationRequest(pending.current, parts);
    setBusy(true); setError('');
    try {
      const result = await send(pending.current.requestKey);
      pending.current = null;
      return result;
    } catch (caught) {
      const issue = caught && typeof caught === 'object' && 'issues' in caught && Array.isArray(caught.issues) && caught.issues[0] && typeof caught.issues[0] === 'object' && 'message' in caught.issues[0] && typeof caught.issues[0].message === 'string' ? caught.issues[0].message : null;
      setError(issue ?? (caught instanceof Error ? caught.message : 'The billing change could not be confirmed. Retry to check its result.'));
      return null;
    } finally { setBusy(false); }
  }
  return { busy, error, setError, run };
}

/** A calendar date this many days from now, as YYYY-MM-DD in the viewer's time zone. */
export const dayAfter = (days: number, from = new Date()) => {
  const date = new Date(from.getTime());
  date.setDate(date.getDate() + days);
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
};
