// The Hub's own people finder through the real roles (20261113280000_growth_people_finder.sql): candidates carry their roster agencies
// for the NPI registry, people are recorded from the website and the registry, a found address records how it was found (published
// with its page on the business's own site, or confirmed by its mail server with no page), waits for the owner, never on another
// domain or after an unsubscribe, the owner sees how each was found, and the gate refuses drift. Disposable loopback database only.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { digest, withSession } from './sms-auth.mjs';
import { growthStore } from './growth/store.mjs';

const databaseUrl = process.env.HUB_TEST_DATABASE_URL;
const local = new URL(databaseUrl);
assert.equal(local.hostname, '127.0.0.1'); assert.equal(local.port, '54322');
const admin = new pg.Pool({ connectionString: databaseUrl });
await admin.query("alter role hub_app_server login password 'ephemeral-test-only'");
const appUrl = new URL(databaseUrl); appUrl.username = 'hub_app_server'; appUrl.password = 'ephemeral-test-only';
const pool = new pg.Pool({ connectionString: appUrl.href });
const store = growthStore(pool);
const run = randomUUID().slice(0, 8), owner = randomUUID(), token = `growth-finder-${randomUUID()}`;
const row = async (sql, values = []) => (await admin.query(sql, values)).rows[0];
const refused = code => error => error?.code === code;
const gate = await readFile(new URL('../supabase/migrations/20261113280100_growth_people_finder_contract.sql', import.meta.url), 'utf8');
const domain = `finder-agency-${run}.example.org`, ccn = `F${run.slice(0, 5).toUpperCase().replace(/[^0-9A-Z]/g, '0')}`;
const suppressed = [];
let org = null;

try {
  await admin.query('insert into auth.users(id,email,is_anonymous) values($1,$2,false)', [owner, `growth-finder-owner-${run}@test.invalid`]);
  await admin.query("insert into private.staff_permissions(user_id,permission) values($1,'platform.admin')", [owner]);
  await admin.query("insert into private.sms_identities(user_id,phone_e164,verified_at) values($1,'+12025550975',now())", [owner]);
  await admin.query("insert into private.sms_sessions(id,token_hash,user_id,identity_version,expires_at) select $1,$2,user_id,identity_version,now()+interval '1 hour' from private.sms_identities where user_id=$3", [randomUUID(), digest(token), owner]);
  const ownerCall = (fn, values) => withSession(pool, token, async db => (await db.query(`select ${fn}(${values.map((_, i) => `$${i + 1}`).join(',')}) as r`, values)).rows[0].r);

  // ---- 1. A roster agency's prospect is a candidate with its agency's place and CMS number --------------------------------------
  await store.discover('caremetric-intel', [{ name: 'Synthetic Finder Hospice', domain, url: `https://${domain}/`, claim: 'A Medicare-certified hospice.' }]);
  org = (await row('select id from private.growth_organizations where domain=$1', [domain])).id;
  await admin.query("update private.growth_opportunities set stage='researched',fit=99 where organization_id=$1", [org]);
  await admin.query(`insert into private.growth_roster_targets(ccn,name,setting,city,state,zip,period,facts,claim,status,organization_id)
    values($1,'Synthetic Finder Hospice','hospice','Harrisburg','PA','17110','2026Q3',$2,'A Medicare-certified hospice.','graduated',$3)`, [ccn, JSON.stringify({ phone: '7175550100' }), org]);
  const candidate = (await store.peopleCandidates(20)).find(item => item.id === org);
  assert.ok(candidate, 'A researched roster agency is a candidate');
  assert.deepEqual(candidate.agencies, [{ ccn, name: 'Synthetic Finder Hospice', city: 'Harrisburg', state: 'PA', zip: '17110', phone: '7175550100', setting: 'hospice' }]);

  // ---- 2. People from the website and the NPI registry ----------------------------------------------------------------------------
  const recorded = await store.peopleRecord(org, [
    { name: 'Jane Doe', title: 'Administrator', source: 'website', sourceUrl: `https://${domain}/team` },
    { name: 'Sam A Lee', title: 'Owner', source: 'npi_registry', sourceUrl: 'https://npiregistry.cms.hhs.gov/provider-view/1578017406' },
    { name: 'Pat Kim', title: 'Director of Nursing', source: 'website', sourceUrl: `https://${domain}/team` }]);
  assert.deepEqual(recorded.map(item => item.source), ['website', 'npi_registry', 'website']);
  await assert.rejects(store.peopleRecord(org, [{ name: 'Someone', source: 'linkedin' }]), refused('23514'));
  const [jane, sam, pat] = recorded.map(item => item.id);

  // ---- 3. How an address was found, checked by the database ----------------------------------------------------------------------
  await assert.rejects(store.personAddress(jane, `jdoe@${domain}`, 'Jane Doe', 'published', null), refused('22023'));
  await assert.rejects(store.personAddress(jane, `jdoe@${domain}`, 'Jane Doe', 'published', 'https://directory.example.com/jane'), refused('22023'));
  await assert.rejects(store.personAddress(jane, `jdoe@${domain}`, 'Jane Doe', 'mail_server', `https://${domain}/team`), refused('22023'));
  await assert.rejects(store.personAddress(jane, `jdoe@${domain}`, 'Jane Doe', 'guessed', null), refused('22023'));
  await assert.rejects(store.personAddress(jane, 'jane.doe@gmail.com', 'Jane Doe', 'mail_server', null), refused('22023'));
  const published = await store.personAddress(jane, `JDoe@${domain}`, 'Jane Doe', 'published', `https://www.${domain}/team`);
  assert.equal(published.found, true);
  const confirmed = await store.personAddress(sam, `sam.lee@${domain}`, 'Sam Lee', 'mail_server', null);
  assert.equal(confirmed.found, true);
  const contact = await row('select * from private.growth_contacts where id=$1', [published.contactId]);
  assert.deepEqual([contact.email, contact.name, contact.role, contact.eligibility, contact.source_kind, contact.source_url],
    [`jdoe@${domain}`, 'Jane Doe', 'Administrator', 'review', 'enriched', `https://www.${domain}/team`]);
  assert.equal((await row('select source_url from private.growth_contacts where id=$1', [confirmed.contactId])).source_url, null);
  assert.deepEqual(await row('select contact_id,address_found from private.growth_people where id=$1', [jane]), { contact_id: published.contactId, address_found: 'published' });
  assert.equal((await row('select address_found from private.growth_people where id=$1', [sam])).address_found, 'mail_server');
  assert.deepEqual(await store.personAddress(pat, `jdoe@${domain}`, 'Pat Kim', 'mail_server', null), { found: false, reason: 'taken' });
  const unsubscribed = `pkim@${domain}`; suppressed.push(digest(unsubscribed));
  await admin.query('insert into private.email_suppressions(email_hash) values($1)', [digest(unsubscribed)]);
  assert.deepEqual(await store.personAddress(pat, unsubscribed, 'Pat Kim', 'mail_server', null), { found: false, reason: 'suppressed' });
  const asRole = async (role, sql, values = []) => {
    const client = await admin.connect();
    try { await client.query('begin'); await client.query(`set local role ${role}`); return await client.query(sql, values); }
    finally { await client.query('rollback').catch(() => {}); client.release(); }
  };
  for (const role of ['authenticated', 'anon', 'service_role']) {
    await assert.rejects(asRole(role, "select private.growth_person_address($1,$2,'Pat Kim','mail_server',null)", [pat, `pat.kim@${domain}`]), refused('42501'), role);
  }
  assert.ok(!(await store.peopleCandidates(20)).some(item => item.id === org), 'A business with a found person waits');

  // ---- 4. The owner sees how each waiting address was found -------------------------------------------------------------------------
  const listed = await ownerCall('hub.growth_people', [0]);
  const mine = listed.items.filter(item => item.domain === domain).map(item => [item.email, item.found, item.sourceUrl]);
  assert.deepEqual(mine, [[`jdoe@${domain}`, 'published', `https://www.${domain}/team`], [`sam.lee@${domain}`, 'mail_server', null]]);
  await assert.rejects(asRole('anon', 'select hub.growth_people(0)'), refused('42501'), 'Only signed-in sessions read the people waiting');

  // ---- 5. The gate refuses drift ------------------------------------------------------------------------------------------------
  const client = await admin.connect();
  const rewrite = (signature, from, to) => `do $$ declare d text := pg_get_functiondef('${signature}'::regprocedure); begin
    if position($q$${from}$q$ in d) = 0 then raise exception 'fixture text missing'; end if; execute replace(d, $q$${from}$q$, $q$${to}$q$); end $$`;
  try {
    for (const drift of [
      'grant execute on function private.growth_person_address(uuid,text,text,text,text) to authenticated',
      rewrite('private.growth_person_address(uuid,text,text,text,text)', "'review', now(), p_source_url, 'enriched'", "'permitted', now(), p_source_url, 'enriched'"),
      "alter table private.growth_people drop constraint growth_people_source_check, add constraint growth_people_source_check check (source in ('cms_owners','owner','import','apollo'))",
      rewrite('hub.growth_people(integer)', 'perform hub.authorize_app_admin();', 'perform 1;'),
    ]) {
      await client.query('begin');
      try { await client.query(drift); await assert.rejects(client.query(gate), refused('55000'), drift); }
      finally { await client.query('rollback'); }
    }
  } finally { client.release(); }

  console.log('People finder integration passed: candidates carry their roster agencies, people come from the website and the NPI registry, a found address records how it was found and its page on the business\'s own site, waits for the owner, never on another domain, taken or unsubscribed, the owner sees how each was found, and gate drift. Nothing was fetched or sent.');
} finally {
  if (org) {
    await admin.query('delete from private.growth_people where organization_id=$1', [org]);
    await admin.query('delete from private.growth_roster_targets where ccn=$1', [ccn]);
    await admin.query('delete from private.growth_evidence where opportunity_id in(select id from private.growth_opportunities where organization_id=$1)', [org]);
    await admin.query('delete from private.growth_opportunities where organization_id=$1', [org]);
    await admin.query('delete from private.growth_contacts where organization_id=$1', [org]);
    await admin.query("delete from private.audit_events where action like 'growth.%' and entity_id=$1", [org]);
    await admin.query('delete from private.growth_organizations where id=$1', [org]);
  }
  await admin.query('delete from private.email_suppressions where email_hash=any($1::text[])', [suppressed]);
  await admin.query('delete from private.sms_sessions where user_id=$1', [owner]);
  await admin.query('delete from private.sms_identities where user_id=$1', [owner]);
  await admin.query('delete from private.staff_permissions where user_id=$1', [owner]);
  await admin.query('delete from hub.profiles where id=$1', [owner]);
  await admin.query('delete from auth.users where id=$1', [owner]);
  await pool.end(); await admin.end();
}
