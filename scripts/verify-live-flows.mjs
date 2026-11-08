import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { adminRegistry } from '../supabase/functions/_shared/adminRegistry.ts';
import { parsePortfolioEnvelope, parsePortfolioRequest } from '../supabase/functions/_shared/portfolioProtocol.ts';
import { projectProviderResult } from '../src/learning/providerPolicyProtocol.ts';
import { challengeCookie, sessionCookie } from '../server/sms-auth.mjs';
import { normalizePhone } from '../server/sms-provider.mjs';
import { STRIPE_ACCOUNT_ID } from '../server/stripe.mjs';

const origin = 'https://help.caremetric.ai';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
class CheckError extends Error {
  constructor(code, status) { super(code); this.code = code; this.status = status; }
}
function requireCheck(value, code) { if (!value) throw new CheckError(code); }

/** Production HTTP checks. Injected transports are for unit tests only. No session, OTP, response body, or personal data is reported. */
export async function verifyLiveFlows({ fetchImpl = fetch, readPhone, readCode, publicOnly = false, now = () => new Date() } = {}) {
  const checks = [], jar = new Map();
  const startedAt = now().toISOString();
  const cookieHeader = () => [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
  async function request(path, body, { cookies = cookieHeader(), captureCookies = true, webhook = false } = {}) {
    let response;
    try {
      response = await fetchImpl(origin + path, {
        method: body === undefined ? 'GET' : 'POST', redirect: 'error', cache: 'no-store',
        signal: AbortSignal.timeout(60000),
        headers: { ...(cookies ? { Cookie: cookies } : {}), ...(body === undefined ? {} : { ...(!webhook ? { Origin: origin } : {}), 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch { throw new CheckError('network_or_redirect'); }
    const received = new Set(); let secureCookies = true;
    if (captureCookies) for (const header of response.headers.getSetCookie()) {
      const [pair, ...attributes] = header.split(';').map(value => value.trim());
      const separator = pair.indexOf('='), name = pair.slice(0, separator), value = pair.slice(separator + 1);
      if (![sessionCookie, challengeCookie].includes(name)) continue;
      received.add(name);
      const flags = attributes.map(value => value.toLowerCase());
      secureCookies &&= ['secure', 'httponly', 'samesite=strict', 'path=/'].every(flag => flags.includes(flag))
        && !flags.some(flag => flag.startsWith('domain='));
      if (flags.includes('max-age=0') || !value) jar.delete(name);
      else if (/^[A-Za-z0-9_-]{43}$/.test(value)) jar.set(name, value);
      else secureCookies = false;
    }
    let data;
    try { data = await response.json(); } catch { throw new CheckError('invalid_json', response.status); }
    return { status: response.status, data, received, secureCookies };
  }
  function ok(response) {
    if (response.status !== 200) throw new CheckError('unexpected_http_status', response.status);
    return response.data;
  }
  async function check(name, operation) {
    try {
      const value = await operation(); checks.push({ name, status: 'passed' }); return { value };
    } catch (error) {
      checks.push({ name, status: 'failed', code: error instanceof CheckError ? error.code : 'invalid_contract',
        ...(error instanceof CheckError && error.status ? { httpStatus: error.status } : {}) });
      return null;
    }
  }
  const blocked = (name, code) => checks.push({ name, status: 'blocked', code });
  async function native(product, operation) {
    const input = { product, ...operation };
    return parsePortfolioEnvelope(ok(await request('/api/admin/read', input)), parsePortfolioRequest(input));
  }
  const report = () => ({
    origin, startedAt, finishedAt: now().toISOString(),
    selectedChecks: checks.some(item => item.status === 'failed') ? 'failed' : checks.some(item => item.status === 'blocked') ? 'blocked' : 'passed', checks,
    notExercised: ['payment_completion', 'checkout_and_portal', 'outbound_support_sms', 'provider_mutations', 'private_media_playback', 'course_publication', 'ai_generation'],
  });
  await check('database_health', async () => requireCheck(ok(await request('/api/health')).ok === true, 'unhealthy'));
  await check('anonymous_access_denied', async () => requireCheck((await request('/api/rpc/get_support_actor_context', {})).status === 401, 'anonymous_access_allowed'));
  await check('unsigned_stripe_webhook_rejected', async () => requireCheck((await request('/api/webhooks/stripe', {}, { cookies: '', webhook: true })).status === 400, 'unsigned_webhook_not_rejected'));
  if (publicOnly) { blocked('authenticated_checks', 'owner_sms_signin_required'); return report(); }
  if (checks.some(item => item.status === 'failed')) { blocked('authenticated_checks', 'public_checks_failed'); return report(); }
  try {
    const login = await check('sms_signin', async () => {
      const phone = normalizePhone(await readPhone());
      requireCheck(phone, 'invalid_phone');
      const start = await request('/api/auth/sms/start', { phone });
      const challenge = ok(start);
      requireCheck(uuid.test(challenge?.challengeId ?? '') && start.secureCookies && start.received.has(challengeCookie) && jar.has(challengeCookie), 'invalid_challenge');
      const code = await readCode();
      requireCheck(/^[0-9]{6}$/.test(code ?? ''), 'invalid_code');
      const binding = await request('/api/auth/sms/verify', { challengeId: challenge.challengeId, code }, { cookies: '', captureCookies: false });
      requireCheck(binding.status === 401, 'challenge_not_browser_bound');
      const verified = await request('/api/auth/sms/verify', { challengeId: challenge.challengeId, code });
      requireCheck(ok(verified)?.authenticated === true && verified.secureCookies && verified.received.has(sessionCookie) && jar.has(sessionCookie), 'invalid_session');
      const session = ok(await request('/api/auth/session'));
      requireCheck(session?.authenticated === true && session.method === 'sms', 'sms_session_missing');
      requireCheck(ok(await request('/api/rpc/get_support_actor_context', {}))?.role === 'platform_admin', 'owner_authority_missing');
    });
    if (!login) blocked('authenticated_checks', 'sms_signin_failed');
    else {
    for (const [product, config] of Object.entries(adminRegistry)) {
      if (!config.endpoint) continue;
      for (const operation of ['capabilities', 'overview']) await check(`${product}.${operation}`, () => native(product, { operation }));
    }
    const courses = await check('carebase.courses', () => native('carebase', { operation: 'courses.list', limit: 1, offset: 0 }));
    const courseId = courses?.value?.data.items[0]?.id;
    if (courseId) {
      for (const operation of ['context', 'commands']) await check(`course_provider.${operation}`, async () => {
        const input = { domain: 'course.provider.v1', operation, courseId, ...(operation === 'commands' ? { offset: 0 } : {}) };
        return projectProviderResult(ok(await request('/api/admin/provider', input)), input);
      });
    } else blocked('course_provider', courses ? 'no_course_available' : 'course_list_failed');
    // Only GETs to Stripe. This existing command refreshes the Hub's catalog mirror and writes an audit event.
    await check('stripe_catalog_refresh', async () => {
      const result = ok(await request('/api/admin/billing', { action: 'catalog.sync' }));
      requireCheck(result?.ok === true && Number.isSafeInteger(result.synced) && result.synced >= 0, 'catalog_refresh_not_confirmed');
    });
    await check('billing_workspace', async () => {
      const workspace = ok(await request('/api/rpc/billing_workspace', {}));
      requireCheck(workspace?.mode === 'live' && workspace.account === STRIPE_ACCOUNT_ID, 'production_billing_account_unverified');
      requireCheck(['apps', 'tenants', 'subscriptions', 'products', 'prices', 'coupons', 'promotion_codes', 'app_keys'].every(key => Array.isArray(workspace[key]))
        && Number.isFinite(Date.parse(workspace.loaded_at)) && typeof workspace.webhook?.events_24h === 'number', 'invalid_billing_workspace');
    });
    }
  } finally {
    // Also revoke a session when login or a later assertion fails. Never persist the token.
    if (jar.has(sessionCookie)) {
      const oldCookies = cookieHeader();
      await check('logout_revocation', async () => {
        requireCheck(ok(await request('/api/auth/logout', {}))?.authenticated === false, 'logout_failed');
        requireCheck(ok(await request('/api/auth/session'))?.authenticated === false, 'session_survived_logout');
        const replay = await request('/api/rpc/get_support_actor_context', {}, { cookies: oldCookies, captureCookies: false });
        requireCheck(replay.status === 401, 'revoked_session_accepted');
      });
    }
    jar.clear();
  }
  return report();
}

function hiddenInput(prompt) {
  if (!process.stdin.isTTY || !process.stderr.isTTY) throw new CheckError('interactive_terminal_required');
  process.stderr.write(prompt);
  return new Promise((resolve, reject) => {
    // A terminal readline interface disables OS echo; its rendering goes only to this sink.
    const output = new Writable({ write(_chunk, _encoding, done) { done(); } });
    const reader = createInterface({ input: process.stdin, output, terminal: true, historySize: 0 });
    let answered = false;
    reader.on('SIGINT', () => reader.close());
    reader.on('close', () => { process.stderr.write('\n'); if (!answered) reject(new CheckError('input_cancelled')); });
    reader.question('', value => { answered = true; reader.close(); resolve(value.trim()); });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.slice(2).some(value => value !== '--public-only')) {
    process.stderr.write('Usage: npm run verify:live -- [--public-only]\n'); process.exitCode = 1;
  } else {
    process.stderr.write('Checking https://help.caremetric.ai. Full checks send one sign-in SMS and refresh the Stripe catalog mirror. Enter phone/code only in this local terminal; input is hidden.\n');
    const result = await verifyLiveFlows({ publicOnly: process.argv.includes('--public-only'),
      readPhone: () => hiddenInput('Owner mobile number: '), readCode: () => hiddenInput('Code received by SMS: ') });
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    process.exitCode = result.selectedChecks === 'failed' ? 1 : result.selectedChecks === 'blocked' ? 2 : 0;
  }
}
