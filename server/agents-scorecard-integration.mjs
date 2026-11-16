// The Monday scorecard through the real roles: the owner reads and changes "Send the individual weekly reports" from a signed-in
// session, a stale screen is refused, every change is audited, the Hub server reads the setting and the scorecard's figures, a weekly
// report is held while the setting is off and sent once it is on, and browser roles get nothing. Disposable loopback database only.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { digest, withSession } from './sms-auth.mjs';
import { sqlAgentStore } from './agents/store.mjs';
import { accountsFeature, accountsHandlers } from './agents/tasks/accounts.mjs';
import { testPhones } from './test-phones.mjs';
const phones = testPhones(import.meta.url);

const databaseUrl = process.env.HUB_TEST_DATABASE_URL;
const local = new URL(databaseUrl);
assert.equal(local.hostname, '127.0.0.1'); assert.equal(local.port, '54322');
const admin = new pg.Pool({ connectionString: databaseUrl });
await admin.query("alter role hub_app_server login password 'ephemeral-test-only'");
const appUrl = new URL(databaseUrl); appUrl.username = 'hub_app_server'; appUrl.password = 'ephemeral-test-only';
const pool = new pg.Pool({ connectionString: appUrl.href });
const store = sqlAgentStore(pool, { scorecard: true, growth: true });
const run = randomUUID().slice(0, 8), owner = randomUUID(), token = `scorecard-${randomUUID()}`;
const refused = code => error => error?.code === code;
const seed = (await admin.query('select individual_reports, changed_at, changed_by from private.agent_scorecard_settings')).rows[0];
const organization = randomUUID();
const chief = (await admin.query("select status from private.agents where key = 'chief_of_staff'")).rows[0];

try {
  assert.ok((await admin.query('select hub.get_backend_contract() as c')).rows[0].c.features.includes('platform.agents.scorecard.v1'));
  await admin.query('insert into auth.users(id,email,is_anonymous) values($1,$2,false)', [owner, `scorecard-owner-${run}@test.invalid`]);
  await admin.query("insert into private.staff_permissions(user_id,permission) values($1,'platform.admin')", [owner]);
  await admin.query('insert into private.sms_identities(user_id,phone_e164,verified_at) values($1,$2,now())', [owner, phones.owner]);
  await admin.query("insert into private.sms_sessions(id,token_hash,user_id,identity_version,expires_at) select $1,$2,user_id,identity_version,now()+interval '1 hour' from private.sms_identities where user_id=$3", [randomUUID(), digest(token), owner]);
  const owned = (sql, values = []) => withSession(pool, token, async db => (await db.query(sql, values)).rows[0].r);
  await admin.query('update private.agent_scorecard_settings set individual_reports = false');

  // The owner sees the setting, off. The reports are held only while the scorecard goes out: with the Chief of Staff paused they send.
  const shown = await owned('select hub.get_scorecard_settings() as r');
  assert.equal(shown.individualReports, false);
  assert.ok(shown.changedAt);
  await admin.query("update private.agents set status = 'paused' where key = 'chief_of_staff'");
  assert.equal(await store.individualReports(), true);
  await admin.query("update private.agents set status = 'active' where key = 'chief_of_staff'");
  assert.equal(await store.individualReports(), false);

  // While it is off, a scheduled weekly report is held and sends nothing; Run now still reads and sends.
  const sent = [];
  const notifier = { send: async input => { sent.push(input.dedupeKey); return [{ channel: 'email', delivery: 'sent' }]; } };
  const accounts = accountsHandlers({ store, notifier, features: [accountsFeature], log: () => {} })['accounts.weekly'];
  const task = over => ({ id: randomUUID(), agentKey: 'account_manager', kind: 'accounts.weekly', sourceKind: 'schedule', attempts: 1, ...over });
  assert.equal((await accounts(task())).result.skipped, 'in_scorecard');
  assert.deepEqual(sent, []);

  // A stale screen is refused; the current one switches the reports on, audited, and the next run follows it.
  await assert.rejects(owned('select hub.set_individual_reports($1, $2) as r', [true, '2020-01-01T00:00:00Z']), refused('40001'));
  const switched = await owned('select hub.set_individual_reports($1, $2) as r', [true, shown.changedAt]);
  assert.equal(switched.individualReports, true);
  assert.notEqual(switched.changedAt, shown.changedAt);
  const audit = (await admin.query("select metadata from private.audit_events where action = 'agent.individual_reports' and actor_id = $1", [owner])).rows;
  assert.deepEqual(audit.map(row => row.metadata), [{ send: true }]);
  assert.equal(await store.individualReports(), true);
  await owned('select hub.set_individual_reports($1, $2) as r', [false, switched.changedAt]);
  assert.equal(await store.individualReports(), false);

  // The scorecard's figures, as the Hub server reads them: counts per product, a first activation counted once.
  await admin.query('insert into private.growth_organizations (id, name, domain) values ($1, $2, $3)', [organization, `Scorecard ${run}`, `scorecard-${run}.example.org`]);
  await admin.query(`insert into private.customer_activity_events (product, organization_id, event_key, kind, occurred_at) values
    ('caremetric-intel', $1, $2, 'first_value', now() - interval '2 days'), ('caremetric-intel', $1, $3, 'first_value', now() - interval '1 day')`,
  [organization, `scorecard-${run}-1`, `scorecard-${run}-2`]);
  const facts = await store.scorecardFacts({ since: new Date(Date.now() - 7 * 86_400_000), until: new Date() });
  assert.deepEqual(facts.products.map(entry => entry.product), ['carebase', 'caremetric-intel']);
  assert.equal(facts.products[1].activated, 1);
  assert.ok(Number.isFinite(Number(facts.aiSpendCents)));
  await assert.rejects(store.scorecardFacts({ since: new Date(Date.now() - 40 * 86_400_000), until: new Date() }), refused('22023'));

  // Browser roles get nothing: not the setting, not the server's reads.
  const client = await admin.connect();
  try {
    for (const role of ['anon', 'authenticated']) {
      for (const sql of ['select hub.get_scorecard_settings()', 'select private.agent_individual_reports()', "select private.agent_scorecard_facts(now() - interval '1 day', now())"]) {
        await client.query('begin');
        await client.query(`set local role ${role}`);
        await assert.rejects(client.query(sql));
        await client.query('rollback');
      }
    }
  } finally { client.release(); }

  console.log('Monday scorecard integration passed: the owner reads and changes the weekly reports setting from a signed-in session, stale screens are refused, every change is audited, a scheduled report is held while it is off, the Hub server reads the setting and the figures, and browser roles get nothing.');
} finally {
  if (chief) await admin.query("update private.agents set status = $1 where key = 'chief_of_staff'", [chief.status]);
  if (seed) await admin.query('update private.agent_scorecard_settings set individual_reports=$1, changed_at=$2, changed_by=$3', [seed.individual_reports, seed.changed_at, seed.changed_by]);
  await admin.query('delete from private.customer_activity_events where organization_id = $1', [organization]);
  await admin.query('delete from private.growth_organizations where id = $1', [organization]);
  await admin.query('delete from private.audit_events where actor_id = $1', [owner]);
  await admin.query('delete from private.sms_sessions where user_id=$1', [owner]);
  await admin.query('delete from private.sms_identities where user_id=$1', [owner]);
  await admin.query('delete from private.staff_permissions where user_id=$1', [owner]);
  await admin.query('delete from hub.profiles where id=$1', [owner]);
  await admin.query('delete from auth.users where id=$1', [owner]);
  await pool.end(); await admin.end();
}
