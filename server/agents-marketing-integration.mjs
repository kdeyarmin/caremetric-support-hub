// The owner's marketing switches through the real roles: the owner reads them and switches a product from a signed-in session, a stale
// screen is refused, every change is audited, the Hub server reads the products switched on, and prospect discovery follows the switch
// from its next run without a restart. Browser roles get nothing. Disposable loopback database only; nothing is searched for real.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { digest, withSession } from './sms-auth.mjs';
import { sqlAgentStore } from './agents/store.mjs';
import { growthHandlers } from './growth/worker.mjs';

const databaseUrl = process.env.HUB_TEST_DATABASE_URL;
const local = new URL(databaseUrl);
assert.equal(local.hostname, '127.0.0.1'); assert.equal(local.port, '54322');
const admin = new pg.Pool({ connectionString: databaseUrl });
await admin.query("alter role hub_app_server login password 'ephemeral-test-only'");
const appUrl = new URL(databaseUrl); appUrl.username = 'hub_app_server'; appUrl.password = 'ephemeral-test-only';
const pool = new pg.Pool({ connectionString: appUrl.href });
const store = sqlAgentStore(pool, { marketing: true });
const run = randomUUID().slice(0, 8), owner = randomUUID(), token = `marketing-${randomUUID()}`;
const refused = code => error => error?.code === code;
const seed = (await admin.query('select product, marketed, changed_at, changed_by from private.marketing_products order by product')).rows;

try {
  await admin.query('insert into auth.users(id,email,is_anonymous) values($1,$2,false)', [owner, `marketing-owner-${run}@test.invalid`]);
  await admin.query("insert into private.staff_permissions(user_id,permission) values($1,'platform.admin')", [owner]);
  await admin.query("insert into private.sms_identities(user_id,phone_e164,verified_at) values($1,'+12025550975',now())", [owner]);
  await admin.query("insert into private.sms_sessions(id,token_hash,user_id,identity_version,expires_at) select $1,$2,user_id,identity_version,now()+interval '1 hour' from private.sms_identities where user_id=$3", [randomUUID(), digest(token), owner]);
  const owned = (sql, values = []) => withSession(pool, token, async db => (await db.query(sql, values)).rows[0].r);
  await admin.query("update private.marketing_products set marketed = (product = 'caremetric-intel')");

  // The owner sees every product with its switch, in a fixed order.
  const shown = await owned('select hub.get_marketing_products() as r');
  assert.deepEqual(shown.map(item => [item.product, item.marketed]), [['caremetric-intel', true], ['carebase', false], ['advisors', false]]);
  assert.ok(shown.every(item => item.label && item.description && item.changedAt));

  // The Hub server reads the products switched on, and prospect discovery searches only those.
  assert.deepEqual(await store.marketedProducts(), ['caremetric-intel']);
  const searched = [];
  const growth = { store: { discover: async () => 0 }, research: { configured: true, search: async product => { searched.push(product); return []; } } };
  const discover = growthHandlers({ growth, marketed: () => store.marketedProducts() })['growth.discovery'];
  await discover({ id: 't', agent: { autonomy: 'propose' } });
  assert.deepEqual(searched, ['caremetric-intel']);

  // A stale screen is refused; the current one switches CareBase on, audited, and the next run follows it.
  const carebase = shown.find(item => item.product === 'carebase');
  await assert.rejects(owned('select hub.set_marketing_product($1, $2, $3) as r', ['carebase', true, '2020-01-01T00:00:00Z']), refused('40001'));
  await assert.rejects(owned('select hub.set_marketing_product($1, $2, $3) as r', ['breathe', true, carebase.changedAt]), refused('P0002'));
  const switched = await owned('select hub.set_marketing_product($1, $2, $3) as r', ['carebase', true, carebase.changedAt]);
  assert.equal(switched.marketed, true);
  assert.notEqual(switched.changedAt, carebase.changedAt);
  const audit = (await admin.query("select actor_id, metadata from private.audit_events where action = 'agent.marketing' and actor_id = $1", [owner])).rows;
  assert.deepEqual(audit.map(row => row.metadata), [{ product: 'carebase', marketed: true }]);
  assert.deepEqual(await store.marketedProducts(), ['carebase', 'caremetric-intel']);
  searched.length = 0;
  await discover({ id: 't', agent: { autonomy: 'propose' } });
  assert.deepEqual(searched.sort(), ['carebase', 'caremetric-intel']);

  // Switching it off again applies to the following run.
  await owned('select hub.set_marketing_product($1, $2, $3) as r', ['carebase', false, switched.changedAt]);
  searched.length = 0;
  await discover({ id: 't', agent: { autonomy: 'propose' } });
  assert.deepEqual(searched, ['caremetric-intel']);

  // Browser roles get nothing: not the switches, not the server's read.
  const client = await admin.connect();
  try {
    for (const role of ['anon', 'authenticated']) {
      await client.query('begin');
      await client.query(`set local role ${role}`);
      await assert.rejects(client.query('select hub.get_marketing_products()'));
      await client.query('rollback');
      await client.query('begin');
      await client.query(`set local role ${role}`);
      await assert.rejects(client.query('select private.marketed_products()'), refused('42501'));
      await client.query('rollback');
    }
  } finally { client.release(); }

  console.log('Marketing switches integration passed: the owner reads and switches products from a signed-in session, stale screens and unknown products are refused, every change is audited, the Hub server reads the switches and discovery follows them from its next run, and browser roles get nothing.');
} finally {
  for (const row of seed) await admin.query('update private.marketing_products set marketed=$2, changed_at=$3, changed_by=$4 where product=$1', [row.product, row.marketed, row.changed_at, row.changed_by]);
  await admin.query("delete from private.audit_events where action = 'agent.marketing' and actor_id = $1", [owner]);
  await admin.query('delete from private.audit_events where actor_id = $1', [owner]);
  await admin.query('delete from private.sms_sessions where user_id=$1', [owner]);
  await admin.query('delete from private.sms_identities where user_id=$1', [owner]);
  await admin.query('delete from private.staff_permissions where user_id=$1', [owner]);
  await admin.query('delete from hub.profiles where id=$1', [owner]);
  await admin.query('delete from auth.users where id=$1', [owner]);
  await pool.end(); await admin.end();
}
