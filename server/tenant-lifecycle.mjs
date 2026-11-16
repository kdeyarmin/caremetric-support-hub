import { HttpError } from './sms-auth.mjs';
import { callNativeAdmin } from './admin-transport.mjs';
import { boundedSession } from './bounded-session.mjs';
import { projectTenantLifecycleResult, tenantLifecycleEndpoint, tenantLifecycleOperation } from '../src/admin/tenantLifecycleProtocol.ts';

/**
 * Breathe's organization suspend and restore (tenant.lifecycle.v1): context, preview, apply and resume, sent to Breathe's fixed
 * endpoint with a one-use breathe.command capability bound to the exact operation. Breathe redeems it at
 * /api/internal/command/breathe/authorize and records the change and its receipt in one transaction. A logout or revocation
 * while Breathe answered keeps the answer from the browser. Offered only while platform.admin.app-commands.v1 is declared.
 */
export function tenantLifecycle({ pool, issue, fetchImpl = fetch, enabled = false }) {
  return async (sessionToken, input, requestSignal) => {
    if (!enabled) throw new HttpError(503, 'Breathe organization changes are not switched on yet.', 'unconfigured');
    let operation;
    try { operation = tenantLifecycleOperation.parse(input); } catch { throw new HttpError(400, 'Review the change and try again.', 'invalid_request'); }
    const signal = AbortSignal.any([...(requestSignal ? [requestSignal] : []), AbortSignal.timeout(15000)]);
    try {
      signal.throwIfAborted();
      const capability = await issue(sessionToken, 'breathe.command', operation, signal);
      signal.throwIfAborted();
      const result = await callNativeAdmin(fetchImpl, tenantLifecycleEndpoint, 'Authorization', capability, operation,
        value => projectTenantLifecycleResult(value, operation), true, signal, 131072);
      await boundedSession(pool, sessionToken, signal, async db => { signal.throwIfAborted(); await db.query('select hub.authorize_app_command() as actor'); });
      return result;
    } catch (error) {
      if (error instanceof HttpError) throw error;
      if (signal.aborted) throw new HttpError(503, 'Breathe did not confirm the outcome. Load the organization again to see whether it changed.', 'upstream');
      const status = error?.code === '42501' ? 403 : error?.code === '28000' ? 401 : 503;
      throw new HttpError(status, 'The organization change could not be completed.', status === 503 ? 'upstream' : undefined);
    }
  };
}
