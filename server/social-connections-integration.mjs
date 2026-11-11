// Exercise encryption, owner authorization and atomic updates through the real
// application role. Disposable loopback database only; all fixtures are restored.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { digest } from './sms-auth.mjs';
import { hubSettings, settingsFeature } from './hub-settings.mjs';
import { openConnection, socialConnections, socialConnectionsFeature } from './social-connections.mjs';

const url = new URL(process.env.HUB_TEST_DATABASE_URL);
assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.port, '54322');
const admin = new pg.Pool({ connectionString: url.href });
await admin.query("alter role hub_app_server login password 'ephemeral-test-only'");
const appUrl = new URL(url); appUrl.username = 'hub_app_server'; appUrl.password = 'ephemeral-test-only';
const pool = new pg.Pool({ connectionString: appUrl.href });
const owner = randomUUID(), token = `social-${randomUUID()}`, credential = `test-only-${randomUUID()}`, key = randomBytes(32).toString('hex');
const seedSettings = (await admin.query("select key,value,imported_from,changed_at::text,changed_by from private.hub_settings where key like 'social.%'")).rows;
const seedConnections = (await admin.query('select * from private.social_connections')).rows;
const features = new Set([settingsFeature, socialConnectionsFeature]);
const settings = hubSettings({ pool, features, env: {}, log: { info() {}, warn() {} } });
const service = socialConnections({ pool, features, settings, env: { HUB_SOCIAL_CREDENTIALS_KEY: key },
  fetchImpl: async (_url, options) => { assert.equal(options.method, 'GET'); return new Response(JSON.stringify({ data: [], elements: [] })); } });
const refused = code => error => error?.code === code;
const current = async provider => (await service.list(token)).connections.find(item => item.provider === provider);
const input = (connection, secrets = {}) => ({ action: 'save', provider: connection.provider, revision: connection.revision,
  fields: Object.fromEntries(Object.entries(connection.fields).map(([name, field]) => [name, { ...field, value: name === 'pageId' || name === 'organizationId' ? '123' : field.value }])), secrets });

try {
  await admin.query('update private.social_connections set ciphertext=null, revision=gen_random_uuid()');
  await admin.query("update private.hub_settings set value=null, imported_from=null, changed_by=null where key like 'social.%'");
  await admin.query('insert into auth.users(id,email,is_anonymous) values($1,$2,false)', [owner, `social-${owner}@test.invalid`]);
  await admin.query("insert into private.staff_permissions(user_id,permission) values($1,'platform.admin')", [owner]);
  await admin.query("insert into private.sms_identities(user_id,phone_e164,verified_at) values($1,'+12025550975',now())", [owner]);
  await admin.query("insert into private.sms_sessions(id,token_hash,user_id,identity_version,expires_at) select $1,$2,user_id,identity_version,now()+interval '1 hour' from private.sms_identities where user_id=$3", [randomUUID(), digest(token), owner]);
  await settings.refresh(); await service.refresh();
  await assert.rejects(service.list('not-a-session'), error => error.status === 401);
  const first = await current('meta');
  assert.equal(first.secrets.token, false);
  await service.save(token, input(first, { token: credential }));
  assert.equal(settings.get('social.meta_page_id'), '123');
  assert.equal(service.resolvedEnv().HUB_META_ACCESS_TOKEN, credential);
  assert.equal((await service.check(token, 'meta')).ok, true);
  const stored = (await admin.query("select ciphertext,revision from private.social_connections where provider='meta'")).rows[0];
  assert.ok(!stored.ciphertext.includes(credential));
  assert.deepEqual(openConnection('meta', stored.ciphertext, key), { token: credential });
  assert.ok(!JSON.stringify(await service.list(token)).includes(credential));
  assert.ok(!JSON.stringify((await admin.query('select metadata from private.audit_events where actor_id=$1', [owner])).rows).includes(credential));
  await assert.rejects(service.save(token, input(first, { token: `${credential}-stale` })), refused('40001'));

  // A different Settings edit invalidates the form, and all account/secret writes roll back.
  const before = await current('meta');
  await settings.save(token, { key: 'social.meta_page_id', value: '789', expectedChangedAt: before.fields.pageId.changedAt });
  const stale = input(before, { token: `${credential}-must-not-save` });
  stale.fields.adAccountId.value = '555';
  await assert.rejects(service.save(token, stale), refused('40001'));
  assert.equal((await admin.query("select ciphertext from private.social_connections where provider='meta'")).rows[0].ciphertext, stored.ciphertext);
  assert.equal((await current('meta')).fields.adAccountId.value, '');
  assert.equal((await current('meta')).fields.pageId.value, '789');

  const linked = await current('linkedin');
  await service.save(token, input(linked, { token: `${credential}-linkedin`, refreshToken: `${credential}-refresh`, clientSecret: 'test-only-secret' }));
  assert.equal((await service.check(token, 'linkedin')).ok, true);
  await service.save(token, input(await current('meta'), { token: ' ' }));
  assert.equal(service.resolvedEnv().HUB_META_ACCESS_TOKEN, credential, 'Blank preserves the saved secret');
  await service.save(token, input(await current('meta'), { token: null }));
  assert.equal(service.resolvedEnv().HUB_META_ACCESS_TOKEN, '', 'Explicit removal disables the credential');
  assert.equal(service.resolvedEnv().HUB_LINKEDIN_ACCESS_TOKEN, `${credential}-linkedin`, 'Providers remain isolated');

  // Both application and SQL layers require a current owner command session.
  await admin.query("update private.sms_sessions set created_at=now()-interval '9 hours' where user_id=$1", [owner]);
  await assert.rejects(service.save(token, input(await current('meta'), { token: credential })), refused('28000'));
  await assert.rejects(service.check(token, 'meta'), refused('28000'));
  await admin.query('update private.sms_sessions set created_at=now() where user_id=$1', [owner]);
  await admin.query('delete from private.staff_permissions where user_id=$1', [owner]);
  await assert.rejects(service.list(token));
  await assert.rejects(pool.query("select private.save_social_connection('meta', $1, $2, '[]')", [randomUUID(), stored.ciphertext]));

  for (const role of ['anon','authenticated','service_role','hub_app_server']) {
    const access = (await admin.query("select has_table_privilege($1,'private.social_connections','select,insert,update,delete,truncate') as allowed", [role])).rows[0];
    assert.equal(access.allowed, false);
    if (role !== 'hub_app_server') {
      const functions = (await admin.query("select has_function_privilege($1,'private.social_connection_values()','execute') or has_function_privilege($1,'private.save_social_connection(text,uuid,text,jsonb)','execute') as allowed", [role])).rows[0];
      assert.equal(functions.allowed, false);
    }
  }
  console.log('Social connections integration passed: encrypted storage, hidden credentials, isolated providers, atomic versioned updates, read-only checks and current owner authorization.');
} finally {
  service.stop(); settings.stop();
  for (const row of seedConnections) await admin.query('update private.social_connections set ciphertext=$2,revision=$3 where provider=$1', [row.provider, row.ciphertext, row.revision]);
  for (const row of seedSettings) await admin.query('update private.hub_settings set value=$2::jsonb,imported_from=$3,changed_at=$4,changed_by=$5 where key=$1', [row.key, row.value === null ? null : JSON.stringify(row.value), row.imported_from, row.changed_at, row.changed_by]);
  await admin.query('delete from private.audit_events where actor_id=$1', [owner]);
  await admin.query('delete from private.sms_sessions where user_id=$1', [owner]);
  await admin.query('delete from private.sms_identities where user_id=$1', [owner]);
  await admin.query('delete from private.staff_permissions where user_id=$1', [owner]);
  await admin.query('delete from hub.profiles where id=$1', [owner]);
  await admin.query('delete from auth.users where id=$1', [owner]);
  await pool.end(); await admin.end();
}
