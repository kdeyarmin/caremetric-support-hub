import { HttpError } from './sms-auth.mjs';
import { callNativeAdmin } from './admin-transport.mjs';
import { boundedSession } from './bounded-session.mjs';
import { projectTenantLifecycleResult, tenantLifecycleDomain, tenantLifecycleEndpoint, tenantLifecycleOperation } from '../src/admin/tenantLifecycleProtocol.ts';
import { projectStaffAccessResult, staffAccessDomain, staffAccessEndpoint, staffAccessOperation } from '../src/admin/staffAccessProtocol.ts';

// Each governed Breathe change: its closed operations, Breathe's fixed endpoint for it, and the projection of Breathe's answer.
const breatheChanges = {
  [tenantLifecycleDomain]: { operation: tenantLifecycleOperation, endpoint: tenantLifecycleEndpoint, project: projectTenantLifecycleResult, record: 'organization' },
  [staffAccessDomain]: { operation: staffAccessOperation, endpoint: staffAccessEndpoint, project: projectStaffAccessResult, record: 'staff sign-in' },
};

/**
 * Breathe's governed changes: an organization's suspend and restore (tenant.lifecycle.v1) and a staff sign-in's deactivate and
 * reactivate (staff.access.v1). Each operation (context, preview, apply, resume) goes to Breathe's fixed endpoint for its domain
 * with a one-use breathe.command capability bound to the exact operation. Breathe redeems it at
 * /api/internal/command/breathe/authorize and records the change and its receipt in one transaction. A logout or revocation
 * while Breathe answered keeps the answer from the browser. Offered only while platform.admin.app-commands.v1 is declared.
 */
export function tenantLifecycle({ pool, issue, fetchImpl = fetch, enabled = false }) {
  return async (sessionToken, input, requestSignal) => {
    if (!enabled) throw new HttpError(503, 'Breathe changes are not switched on yet.', 'unconfigured');
    const change = Object.hasOwn(breatheChanges, input?.domain) ? breatheChanges[input.domain] : null;
    let operation;
    try { operation = change.operation.parse(input); } catch { throw new HttpError(400, 'Review the change and try again.', 'invalid_request'); }
    const signal = AbortSignal.any([...(requestSignal ? [requestSignal] : []), AbortSignal.timeout(15000)]);
    try {
      signal.throwIfAborted();
      const capability = await issue(sessionToken, 'breathe.command', operation, signal);
      signal.throwIfAborted();
      const result = await callNativeAdmin(fetchImpl, change.endpoint, 'Authorization', capability, operation,
        value => change.project(value, operation), true, signal, 131072);
      await boundedSession(pool, sessionToken, signal, async db => { signal.throwIfAborted(); await db.query('select hub.authorize_app_command() as actor'); });
      return result;
    } catch (error) {
      if (error instanceof HttpError) throw error;
      if (signal.aborted) throw new HttpError(503, `Breathe did not confirm the outcome. Load the ${change.record} again to see whether it changed.`, 'upstream');
      const status = error?.code === '42501' ? 403 : error?.code === '28000' ? 401 : 503;
      throw new HttpError(status, `The ${change.record} change could not be completed.`, status === 503 ? 'upstream' : undefined);
    }
  };
}
