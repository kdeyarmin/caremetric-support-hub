import { describe, expect, it, vi } from 'vitest';
import { verifyLiveFlows } from './verify-live-flows.mjs';
import { challengeCookie, sessionCookie, cookie } from '../server/sms-auth.mjs';
import { STRIPE_ACCOUNT_ID } from '../server/stripe.mjs';
import { providerContext, providerCourse } from '../src/learning/testFixtures/provider.ts';

const instant = '2026-11-07T00:00:00.000Z';
function fixture({ intercept } = {}) {
  let active = false;
  const readPhone = vi.fn(async () => '+12025550123'), readCode = vi.fn(async () => '654321');
  const reply = (data, status = 200, cookies = []) => Response.json(data, { status, headers: cookies.map(value => ['Set-Cookie', value]) });
  const fetchImpl = vi.fn(async (url, options) => {
    expect(url).toMatch(/^https:\/\/help\.caremetric\.ai\/api\//);
    expect(options.redirect).toBe('error');
    const path = new URL(url).pathname, body = options.body ? JSON.parse(options.body) : undefined;
    const override = intercept?.({ path, body, options, active, reply });
    if (override) return override;
    const signedIn = active && options.headers.Cookie?.includes(sessionCookie + '=');
    if (path === '/api/health') return reply({ ok: true });
    if (path === '/api/webhooks/stripe') { expect(options.headers.Origin).toBeUndefined(); expect(options.headers.Cookie).toBeUndefined(); return reply({ error: 'Invalid signature.' }, 400); }
    if (path === '/api/auth/sms/start') return reply({ challengeId: providerCourse }, 200, [cookie(challengeCookie, 'c'.repeat(43), 300)]);
    if (path === '/api/auth/sms/verify') {
      if (!options.headers.Cookie?.includes(challengeCookie)) return reply({}, 401);
      expect(body.code).toBe('654321'); active = true;
      return reply({ authenticated: true }, 200, [cookie(sessionCookie, 's'.repeat(43), 28800), cookie(challengeCookie, '', 0)]);
    }
    if (path === '/api/auth/logout') { active = false; return reply({ authenticated: false }, 200, [cookie(sessionCookie, '', 0)]); }
    if (path === '/api/auth/session') return reply({ authenticated: Boolean(signedIn), ...(signedIn ? { method: 'sms' } : {}) });
    if (!signedIn) return reply({}, 401);
    if (path === '/api/rpc/get_support_actor_context') return reply({ role: 'platform_admin', email: 'private@example.test' });
    if (path === '/api/admin/read') {
      const { product, operation } = body;
      let data;
      if (operation === 'capabilities') data = { apiVersion: 1, operations: ['overview'], sourceRevision: 'a'.repeat(40) };
      else if (operation === 'courses.list') data = { items: [{ id: providerCourse, title: 'Private course', description: null, category: null, status: 'published', estimatedDurationMinutes: null, updatedAt: instant }], total: 1, limit: 1, offset: 0 };
      else data = product === 'carebase' ? { organizationCount: 1, activeUserCount: 1, globalCourseCount: 1 }
        : product === 'breathe' ? { organizationCount: 1, activeUserCount: 1 }
        : product === 'intel' ? { organizationCount: null, activeUserCount: null, registeredUserCount: 1 }
        : { organizationCount: null, activeUserCount: null, inquiryCount: 1, openInquiryCount: 1 };
      return reply({ contractVersion: 1, product, operation, generatedAt: instant, data });
    }
    if (path === '/api/admin/provider') return reply(body.operation === 'context' ? providerContext : { items: [], nextOffset: null });
    if (path === '/api/admin/billing') { expect(body).toEqual({ action: 'catalog.sync' }); return reply({ ok: true, synced: 5 }); }
    if (path === '/api/rpc/billing_workspace') return reply({ mode: 'live', account: STRIPE_ACCOUNT_ID, apps: [], tenants: [], subscriptions: [], products: [], prices: [], coupons: [], promotion_codes: [], app_keys: [], webhook: { events_24h: 1 }, loaded_at: instant });
    throw new Error('Unexpected request');
  });
  return { fetchImpl, readPhone, readCode, now: () => new Date(instant) };
}

describe('live verification runner (simulated transport; these tests are not production evidence)', () => {
  it('checks owner auth, contracts, Stripe reads and revoked-cookie replay without reporting secrets or claiming payment completion', async () => {
    const input = fixture(), report = await verifyLiveFlows(input);
    expect(report.selectedChecks).toBe('passed');
    expect(report.checks).toContainEqual({ name: 'logout_revocation', status: 'passed' });
    expect(report.notExercised).toContain('payment_completion');
    expect(report.notExercised).toContain('outbound_support_sms');
    const output = JSON.stringify(report);
    for (const value of ['654321', '+12025550123', 'private@example.test', providerCourse, 's'.repeat(43), 'Private course']) expect(output).not.toContain(value);
    const commands = input.fetchImpl.mock.calls.filter(([url]) => /\/api\/admin\/billing$/.test(url));
    expect(commands).toHaveLength(1);
    expect(input.readPhone).toHaveBeenCalledTimes(1); expect(input.readCode).toHaveBeenCalledTimes(1);
  });
  it('reports an authenticated check as blocked in public-only mode without sending SMS', async () => {
    const input = fixture(), report = await verifyLiveFlows({ ...input, publicOnly: true });
    expect(report.selectedChecks).toBe('blocked'); expect(input.readPhone).not.toHaveBeenCalled();
    expect(input.fetchImpl.mock.calls.some(([url]) => url.includes('/auth/sms'))).toBe(false);
  });
  it('stops before authentication if anonymous private access is allowed', async () => {
    const input = fixture({ intercept: ({ path, active, reply }) => path.endsWith('get_support_actor_context') && !active ? reply({ role: 'platform_admin' }) : null });
    const report = await verifyLiveFlows(input);
    expect(report.selectedChecks).toBe('failed'); expect(input.readPhone).not.toHaveBeenCalled();
  });
  it('rejects HTTP 200 provider errors and still revokes the session', async () => {
    const input = fixture({ intercept: ({ path, reply }) => path === '/api/admin/read' ? reply({ error: 'secret@example.test' }) : null });
    const report = await verifyLiveFlows(input);
    expect(report.selectedChecks).toBe('failed');
    expect(report.checks).toContainEqual({ name: 'carebase.overview', status: 'failed', code: 'invalid_contract' });
    expect(report.checks).toContainEqual({ name: 'logout_revocation', status: 'passed' });
    expect(JSON.stringify(report)).not.toContain('secret@example.test');
  });
  it('fails when logout only clears the cookie but the server still accepts the old session', async () => {
    const input = fixture({ intercept: ({ path, reply }) => path === '/api/auth/logout' ? reply({ authenticated: false }, 200, [cookie(sessionCookie, '', 0)]) : null });
    const report = await verifyLiveFlows(input);
    expect(report.checks).toContainEqual({ name: 'logout_revocation', status: 'failed', code: 'revoked_session_accepted' });
  });
  it('does not accept a test-mode or different-account billing mirror as production verification', async () => {
    const input = fixture({ intercept: ({ path, reply }) => path.endsWith('billing_workspace') ? reply({ mode: 'test', account: STRIPE_ACCOUNT_ID }) : null });
    const report = await verifyLiveFlows(input);
    expect(report.checks).toContainEqual({ name: 'billing_workspace', status: 'failed', code: 'production_billing_account_unverified' });
  });
  it('revokes a created session when owner authorization fails', async () => {
    const input = fixture({ intercept: ({ path, active, reply }) => path.endsWith('get_support_actor_context') && active ? reply({ role: 'tenant_admin' }) : null });
    const report = await verifyLiveFlows(input);
    expect(report.checks).toContainEqual({ name: 'sms_signin', status: 'failed', code: 'owner_authority_missing' });
    expect(report.checks).toContainEqual({ name: 'logout_revocation', status: 'passed' });
    expect(input.fetchImpl.mock.calls.some(([url]) => url.includes('/api/admin/'))).toBe(false);
  });
  it('requires the challenge cookie before accepting an OTP', async () => {
    const input = fixture({ intercept: ({ path, options, reply }) => path === '/api/auth/sms/verify' && !options.headers.Cookie ? reply({ authenticated: true }) : null });
    const report = await verifyLiveFlows(input);
    expect(report.checks).toContainEqual({ name: 'sms_signin', status: 'failed', code: 'challenge_not_browser_bound' });
  });
});
