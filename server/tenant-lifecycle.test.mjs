import { describe, expect, it, vi } from 'vitest';
import { tenantLifecycle } from './tenant-lifecycle.mjs';
import { commandId, envelope, lifecycleApplied, lifecycleContext, lifecyclePreview, organizationId } from '../src/admin/testFixtures/tenantLifecycle.ts';

const capability = `cmh_${'a'.repeat(43)}`;
const signedIn = [{ id: 'session', user_id: 'owner', auth_method: 'sms' }];
// A pool that answers the post-call session check: signed in, or revoked meanwhile.
const pool = (rows = signedIn) => ({ connect: async () => ({ release() {}, query: async text => (/^select s\.id/.test(text) ? { rows } : { rows: [] }) }) });
const context = { domain: 'tenant.lifecycle.v1', operation: 'context', targetId: organizationId };
const apply = { domain: 'tenant.lifecycle.v1', operation: 'apply', commandId, expectedDigest: lifecyclePreview.previewDigest };

describe('Breathe organization changes through the Hub', () => {
  it('is off until the database declares the feature', async () => {
    const issue = vi.fn();
    await expect(tenantLifecycle({ pool: pool(), issue, enabled: false })('token', context)).rejects.toMatchObject({ status: 503, code: 'unconfigured' });
    expect(issue).not.toHaveBeenCalled();
  });

  it('sends one exact operation with a breathe.command capability to the fixed Breathe endpoint and returns only its reviewed answer', async () => {
    const issue = vi.fn(async () => capability);
    const fetchImpl = vi.fn(async () => Response.json(envelope('context', lifecycleContext)));
    expect(await tenantLifecycle({ pool: pool(), issue, fetchImpl, enabled: true })('token', context)).toEqual(lifecycleContext);
    expect(issue).toHaveBeenCalledWith('token', 'breathe.command', context, expect.any(AbortSignal));
    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://cmbreathe.com/resupply-api/central-admin/tenant-lifecycle');
    expect(options).toMatchObject({ method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${capability}`, 'Content-Type': 'application/json' } });
    expect(JSON.parse(options.body)).toEqual(context);
  });

  it('refuses a malformed operation before issuing anything, and an answer that does not match', async () => {
    const issue = vi.fn(async () => capability);
    await expect(tenantLifecycle({ pool: pool(), issue, enabled: true })('token', { ...context, targetId: 'not-a-uuid' })).rejects.toMatchObject({ status: 400, code: 'invalid_request' });
    expect(issue).not.toHaveBeenCalled();
    const fetchImpl = vi.fn(async () => Response.json(envelope('apply', lifecyclePreview)));
    await expect(tenantLifecycle({ pool: pool(), issue, fetchImpl, enabled: true })('token', apply)).rejects.toMatchObject({ status: 503 });
  });

  it('maps Breathe refusals and keeps an applied result from a session revoked while Breathe answered', async () => {
    const issue = vi.fn(async () => capability);
    const answer = (status, code) => vi.fn(async () => Response.json({ error: { code } }, { status }));
    await expect(tenantLifecycle({ pool: pool(), issue, fetchImpl: answer(409, 'conflict'), enabled: true })('token', apply)).rejects.toMatchObject({ status: 409, code: 'conflict' });
    await expect(tenantLifecycle({ pool: pool(), issue, fetchImpl: answer(400, 'invalid_request'), enabled: true })('token', apply)).rejects.toMatchObject({ status: 400, code: 'invalid_request' });
    await expect(tenantLifecycle({ pool: pool(), issue, fetchImpl: answer(403, 'forbidden'), enabled: true })('token', apply)).rejects.toMatchObject({ status: 403 });
    const applied = vi.fn(async () => Response.json(envelope('apply', lifecycleApplied)));
    await expect(tenantLifecycle({ pool: pool([]), issue, fetchImpl: applied, enabled: true })('token', apply)).rejects.toMatchObject({ status: 401 });
    expect(await tenantLifecycle({ pool: pool(), issue, fetchImpl: applied, enabled: true })('token', apply)).toEqual(lifecycleApplied);
  });
});
