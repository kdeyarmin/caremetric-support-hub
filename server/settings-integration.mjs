// The Hub's settings through the real roles: the Hub server copies Railway values into settings nobody has set, once; the owner reads
// every setting and changes one from a signed-in session; a stale screen and a value that does not fit are refused; every change is
// audited; the server applies a change at once and a later copy never overwrites what the owner saved; browser roles get nothing.
// Disposable loopback database only.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { digest } from './sms-auth.mjs';
import { hubSettings, retiredSettings, settingsCatalog, settingsFeature } from './hub-settings.mjs';
import { testPhones } from './test-phones.mjs';
const phones = testPhones(import.meta.url);

const databaseUrl = process.env.HUB_TEST_DATABASE_URL;
const local = new URL(databaseUrl);
assert.equal(local.hostname, '127.0.0.1'); assert.equal(local.port, '54322');
const admin = new pg.Pool({ connectionString: databaseUrl });
await admin.query("alter role hub_app_server login password 'ephemeral-test-only'");
const appUrl = new URL(databaseUrl); appUrl.username = 'hub_app_server'; appUrl.password = 'ephemeral-test-only';
const pool = new pg.Pool({ connectionString: appUrl.href });
const run = randomUUID().slice(0, 8), owner = randomUUID(), token = `settings-${randomUUID()}`;
const refused = code => error => error?.code === code;
const seed = (await admin.query('select key, value, imported_from, changed_at, changed_by from private.hub_settings')).rows;
const quiet = { info: () => {}, warn: () => {} };
const features = new Set([settingsFeature]);
const started = [];
const server = env => { const settings = hubSettings({ pool, features, env, log: quiet, refreshMs: 3_600_000 }); started.push(settings); return settings; };

try {
  assert.equal(seed.length, settingsCatalog.length + retiredSettings.length, 'Every setting the server knows, and every retired one, has a row');
  await admin.query('update private.hub_settings set value = null, imported_from = null, changed_by = null');
  await admin.query('insert into auth.users(id,email,is_anonymous) values($1,$2,false)', [owner, `settings-owner-${run}@test.invalid`]);
  await admin.query("insert into private.staff_permissions(user_id,permission) values($1,'platform.admin')", [owner]);
  await admin.query('insert into private.sms_identities(user_id,phone_e164,verified_at) values($1,$2,now())', [owner, phones.owner]);
  await admin.query("insert into private.sms_sessions(id,token_hash,user_id,identity_version,expires_at) select $1,$2,user_id,identity_version,now()+interval '1 hour' from private.sms_identities where user_id=$3", [randomUUID(), digest(token), owner]);

  // At start the server copies the usable Railway values in, and answers from the database.
  const first = server({ HUB_CHAT_ENABLED: 'true', HUB_AI_DRAFT_TIER: 'quality', HUB_OWNER_EMAIL: 'not an address' });
  await first.start();
  assert.equal(first.get('support.chat'), true);
  assert.equal(first.get('support.ai_draft_tier'), 'quality');
  assert.equal(first.get('agents.owner_email'), null, 'A variable the Hub cannot use is not copied');
  const copied = (await admin.query("select key, imported_from from private.hub_settings where value is not null order by key")).rows;
  assert.deepEqual(copied, [{ key: 'support.ai_draft_tier', imported_from: 'HUB_AI_DRAFT_TIER' }, { key: 'support.chat', imported_from: 'HUB_CHAT_ENABLED' }]);

  // The owner sees every setting with where its value came from.
  const view = await first.list(token);
  assert.equal(view.editable, true);
  const shown = new Map(view.groups.flatMap(group => group.settings).map(item => [item.key, item]));
  assert.equal(shown.size, settingsCatalog.length);
  assert.deepEqual([shown.get('support.chat').value, shown.get('support.chat').source], [true, 'copied']);
  assert.equal(shown.get('agents.enabled').source, 'default');

  // A stale screen and a value that does not fit are refused; the current screen switches chat off, audited, and applies at once.
  await assert.rejects(first.save(token, { key: 'support.chat', value: false, expectedChangedAt: '2020-01-01T00:00:00Z' }), refused('40001'));
  await assert.rejects(first.save(token, { key: 'agents.owner_email', value: 'not an address', expectedChangedAt: shown.get('agents.owner_email').changedAt }), error => error?.status === 400);
  const saved = await first.save(token, { key: 'support.chat', value: false, expectedChangedAt: shown.get('support.chat').changedAt });
  assert.equal(first.get('support.chat'), false);
  const chat = saved.groups.flatMap(group => group.settings).find(item => item.key === 'support.chat');
  assert.deepEqual([chat.value, chat.source], [false, 'hub']);
  await first.save(token, { key: 'agents.owner_email', value: ' owner@caremetric.test ', expectedChangedAt: shown.get('agents.owner_email').changedAt });
  assert.equal(first.get('agents.owner_email'), 'owner@caremetric.test');
  const audit = (await admin.query("select metadata from private.audit_events where action = 'hub.setting' and actor_id = $1 order by id", [owner])).rows;
  assert.deepEqual(audit.map(row => row.metadata), [{ key: 'support.chat', set: true, on: false }, { key: 'agents.owner_email', set: true }]);

  // A later start never overwrites what the owner saved, even when the old variable is still set; clearing returns to the default.
  const second = server({ HUB_CHAT_ENABLED: 'true', HUB_OWNER_EMAIL: 'other@caremetric.test' });
  await second.start();
  assert.equal(second.get('support.chat'), false);
  assert.equal(second.get('agents.owner_email'), 'owner@caremetric.test');
  const current = (await second.list(token)).groups.flatMap(group => group.settings).find(item => item.key === 'support.chat');
  await second.save(token, { key: 'support.chat', value: null, expectedChangedAt: current.changedAt });
  assert.equal(second.get('support.chat'), false, 'Cleared: the default (off)');
  const third = server({ HUB_CHAT_ENABLED: 'true' });
  await third.start();
  assert.equal(third.get('support.chat'), false, 'A setting the owner cleared is never copied again');

  // Browser roles get nothing: not the settings, not the server's read or copy.
  const client = await admin.connect();
  try {
    for (const role of ['anon', 'authenticated']) {
      for (const sql of ['select hub.get_hub_settings()', 'select private.hub_settings_values()', `select private.hub_settings_import('{}'::jsonb)`, 'select * from private.hub_settings']) {
        await client.query('begin');
        await client.query(`set local role ${role}`);
        await assert.rejects(client.query(sql), undefined, `${role}: ${sql}`);
        await client.query('rollback');
      }
    }
  } finally { client.release(); }

  console.log('Hub settings integration passed: the server copies usable Railway values into unset settings once, the owner reads and changes settings from a signed-in session, stale screens and unusable values are refused, every change is audited and applies at once, a later copy never overwrites the owner\'s choice, and browser roles get nothing.');
} finally {
  for (const settings of started) settings.stop();
  for (const row of seed) await admin.query('update private.hub_settings set value=$2, imported_from=$3, changed_at=$4, changed_by=$5 where key=$1', [row.key, row.value, row.imported_from, row.changed_at, row.changed_by]);
  await admin.query("delete from private.audit_events where action = 'hub.settings.import' and actor_id is null and created_at > now() - interval '1 hour' and metadata ? 'keys'");
  await admin.query('delete from private.audit_events where actor_id = $1', [owner]);
  await admin.query('delete from private.sms_sessions where user_id=$1', [owner]);
  await admin.query('delete from private.sms_identities where user_id=$1', [owner]);
  await admin.query('delete from private.staff_permissions where user_id=$1', [owner]);
  await admin.query('delete from hub.profiles where id=$1', [owner]);
  await admin.query('delete from auth.users where id=$1', [owner]);
  await pool.end(); await admin.end();
}
