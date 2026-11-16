// Run only against the disposable local Supabase stack, never a live project.
// Proves the production wiring: only the platform administrator (the owner) can sign in or stay signed in.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { smsAuth, ownerAccess, sessionCookie, digest, token } from './sms-auth.mjs';
import { gateway } from './gateway.mjs';
import { appServer, privateHubMessage } from './http.mjs';
import { removeTestIdentities, testPhones } from './test-phones.mjs';
const phones = testPhones(import.meta.url);
const databaseUrl = process.env.HUB_TEST_DATABASE_URL;
const local = new URL(databaseUrl);
assert.equal(local.hostname, '127.0.0.1'); assert.equal(local.port, '54322');
const admin = new pg.Pool({ connectionString: databaseUrl });
await admin.query("alter role hub_app_server login password 'ephemeral-test-only'");
const appUrl = new URL(databaseUrl); appUrl.username = 'hub_app_server'; appUrl.password = 'ephemeral-test-only';
const pool = new pg.Pool({ connectionString: appUrl.href });
// Emails are unique per run so the script can run again against the same stack.
const run = String(Math.floor(Math.random() * 9000) + 1000);
const owner = randomUUID(), customer = randomUUID(), ownerPhone = phones.owner, customerPhone = phones.customer;
await admin.query(`insert into auth.users(id,email,raw_user_meta_data,is_anonymous) values($1,$3,'{"display_name":"Hub owner"}',false),($2,$4,'{"display_name":"Customer"}',false)`, [owner, customer, `owner-only-owner-${run}@test.invalid`, `owner-only-customer-${run}@test.invalid`]);
await admin.query("insert into private.staff_permissions(user_id,permission,granted_by) values($1,'platform.admin',$1)", [owner]);
await admin.query('insert into private.sms_identities(user_id,phone_e164) values($1,$2),($3,$4)', [owner, ownerPhone, customer, customerPhone]);
const provider = { send: async () => randomUUID(), verify: async (_id, _phone, code) => code === '123456' };
const server = appServer({ auth: smsAuth({ pool, provider }), owner: ownerAccess(pool), gateway: gateway(pool), delegations: {}, selfService: {}, origins: ['https://hub.test'] });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

async function signIn(phone) {
  const jar = {};
  const call = async (path, body) => {
    const response = await fetch(`${origin}/api/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Origin: 'https://hub.test', 'Content-Type': 'application/json',
      Cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ') }, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const value of response.headers.getSetCookie()) { const [pair] = value.split(';'); const index = pair.indexOf('='); jar[pair.slice(0, index)] = pair.slice(index + 1); }
    return { status: response.status, body: await response.json() };
  };
  const started = await call('auth/sms/start', { phone });
  assert.equal(started.status, 200);
  return { verified: await call('auth/sms/verify', { challengeId: started.body.challengeId, code: '123456' }), call, jar };
}

try {
  // The owner signs in and stays signed in.
  const ownerSignIn = await signIn(ownerPhone);
  assert.equal(ownerSignIn.verified.status, 200);
  assert.equal((await ownerSignIn.call('auth/session')).body.authenticated, true);

  // Anyone else with a registered number is refused even with a correct code, and the session the code created is revoked.
  const customerSignIn = await signIn(customerPhone);
  assert.equal(customerSignIn.verified.status, 403);
  assert.deepEqual(customerSignIn.verified.body, { error: privateHubMessage });
  assert.equal(customerSignIn.jar[sessionCookie] ?? '', '');
  const { rows: customerSessions } = await admin.query('select revoked_at from private.sms_sessions where user_id=$1', [customer]);
  assert.equal(customerSessions.length, 1);
  assert.notEqual(customerSessions[0].revoked_at, null);

  // A customer session created any other way is treated as signed out.
  const planted = token();
  const { rows: [identity] } = await admin.query('select identity_version from private.sms_identities where user_id=$1', [customer]);
  await admin.query("insert into private.sms_sessions(id,token_hash,user_id,identity_version,expires_at) values($1,$2,$3,$4,now()+interval '1 hour')", [randomUUID(), digest(planted), customer, identity.identity_version]);
  const plantedSession = await fetch(`${origin}/api/auth/session`, { headers: { Cookie: `${sessionCookie}=${planted}` } });
  assert.equal((await plantedSession.json()).authenticated, false);

  // Removing the owner's administrator permission ends their access on the next request.
  await admin.query("update private.staff_permissions set revoked_at=now() where user_id=$1 and permission='platform.admin'", [owner]);
  assert.equal((await ownerSignIn.call('auth/session')).body.authenticated, false);

  // Routes that would create sign-ins for anyone else are closed.
  for (const path of ['auth/invitation/start', 'self-service/connect/start']) {
    const response = await fetch(`${origin}/api/${path}`, { method: 'POST', headers: { Origin: 'https://hub.test', 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(response.status, 403, path);
  }
  console.log('Owner-only sign-in integration passed.');
} finally {
  server.close();
  await removeTestIdentities(admin, [owner, customer]);
  await pool.end();
  await admin.end();
}
