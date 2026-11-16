// Decision-makers and imported lists through the real roles (20261113180000_growth_people.sql): candidates are researched or qualified
// prospects never yet emailed, people are recorded with ids, the owner's daily credit cap is reserved in the database, a found address
// must be a work address on the business's own domain and waits for the owner, permitting one makes it the opportunity's contact,
// imported lists skip addresses elsewhere and anyone who unsubscribed, and the gate refuses drift. Disposable loopback database only.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { digest, withSession } from './sms-auth.mjs';
import { growthStore } from './growth/store.mjs';
import { testPhones } from './test-phones.mjs';
const phones = testPhones(import.meta.url);

const databaseUrl = process.env.HUB_TEST_DATABASE_URL;
const local = new URL(databaseUrl);
assert.equal(local.hostname, '127.0.0.1'); assert.equal(local.port, '54322');
const admin = new pg.Pool({ connectionString: databaseUrl });
await admin.query("alter role hub_app_server login password 'ephemeral-test-only'");
const appUrl = new URL(databaseUrl); appUrl.username = 'hub_app_server'; appUrl.password = 'ephemeral-test-only';
const pool = new pg.Pool({ connectionString: appUrl.href });
const store = growthStore(pool);
const run = randomUUID().slice(0, 8), owner = randomUUID(), token = `growth-people-${randomUUID()}`;
const row = async (sql, values = []) => (await admin.query(sql, values)).rows[0];
const refused = code => error => error?.code === code;
const gate = await readFile(new URL('../supabase/migrations/20261113180100_growth_people_contract.sql', import.meta.url), 'utf8');
const domains = [], suppressed = [];
const domainOf = label => { const value = `${label}-${run}.example.org`; domains.push(value); return value; };
const seedCredits = await row("select value from private.hub_settings where key='growth.enrichment_daily_credits'");
const today = (await row("select (now() at time zone 'America/New_York')::date as d")).d;
const seedDay = await row('select used from private.growth_enrichment_days where day=$1', [today]);

try {
  await admin.query('insert into auth.users(id,email,is_anonymous) values($1,$2,false)', [owner, `growth-people-owner-${run}@test.invalid`]);
  await admin.query("insert into private.staff_permissions(user_id,permission) values($1,'platform.admin')", [owner]);
  await admin.query('insert into private.sms_identities(user_id,phone_e164,verified_at) values($1,$2,now())', [owner, phones.owner]);
  await admin.query("insert into private.sms_sessions(id,token_hash,user_id,identity_version,expires_at) select $1,$2,user_id,identity_version,now()+interval '1 hour' from private.sms_identities where user_id=$3", [randomUUID(), digest(token), owner]);
  const ownerCall = (fn, values) => withSession(pool, token, async db => (await db.query(`select ${fn}(${values.map((_, i) => `$${i + 1}`).join(',')}) as r`, values)).rows[0].r);

  // ---- 1. A researched prospect with a role address is a candidate until it is emailed ------------------------------------------
  const domain = domainOf('people-agency');
  await store.discover('caremetric-intel', [{ name: 'Synthetic People Agency', domain, url: `https://${domain}/`, claim: 'A Medicare-certified hospice.' }]);
  const org = (await row('select id from private.growth_organizations where domain=$1', [domain])).id;
  await store.recordContact(org, `info@${domain}`, `https://${domain}/contact`);
  const opp = (await row("select id from private.growth_opportunities where organization_id=$1", [org])).id;
  await admin.query("update private.growth_opportunities set stage='researched',fit=82 where id=$1", [opp]);
  assert.ok((await store.peopleCandidates(20)).some(item => item.id === org));

  // ---- 2. People recorded with their ids; searched businesses wait 60 days ------------------------------------------------------
  const recorded = await store.peopleRecord(org, [{ name: 'Jane Doe', title: 'Owner', source: 'cms_owners', sourceUrl: 'https://www.caremetricintel.com/data-use' },
    { name: 'Jane D***', title: 'Administrator', source: 'apollo', providerRef: 'apollo-p1' }]);
  assert.equal(recorded.length, 2); assert.ok(recorded.every(item => /^[0-9a-f-]{36}$/.test(item.id)));
  assert.ok(!(await store.peopleCandidates(20)).some(item => item.id === org), 'A searched business waits');
  await assert.rejects(store.peopleRecord(org, [{ name: 'x@y', source: 'apollo' }]), refused('23514'));

  // ---- 3. The owner's daily credit cap is reserved in the database --------------------------------------------------------------
  await admin.query("update private.hub_settings set value='2' where key='growth.enrichment_daily_credits'");
  await admin.query('delete from private.growth_enrichment_days where day=$1', [today]);
  assert.deepEqual([await store.enrichmentReserve(1), await store.enrichmentReserve(1), await store.enrichmentReserve(1)], [true, true, false]);
  await assert.rejects(store.enrichmentReserve(0), refused('22023'));

  // ---- 4. A found address: a work address on the business's own domain, waiting for the owner ----------------------------------
  const apolloPerson = recorded.find(item => item.source === 'apollo').id;
  await assert.rejects(store.enrichedContact(apolloPerson, 'jane@gmail.com', 'Jane Doe'), refused('22023'));
  await assert.rejects(store.enrichedContact(apolloPerson, `jane@other-${domain}`, 'Jane Doe'), refused('22023'));
  const found = await store.enrichedContact(apolloPerson, `Jane@${domain}`, 'Jane Doe');
  assert.equal(found.found, true);
  const contact = await row('select * from private.growth_contacts where id=$1', [found.contactId]);
  assert.deepEqual([contact.email, contact.name, contact.role, contact.eligibility, contact.source_kind], [`jane@${domain}`, 'Jane Doe', 'Administrator', 'review', 'enriched']);
  assert.equal((await row('select name,contact_id from private.growth_people where id=$1', [apolloPerson])).contact_id, found.contactId);
  const unsubscribed = `former@${domain}`; suppressed.push(digest(unsubscribed));
  await admin.query('insert into private.email_suppressions(email_hash) values($1)', [digest(unsubscribed)]);
  assert.deepEqual(await store.enrichedContact(recorded[0].id, unsubscribed), { found: false, reason: 'suppressed' });

  // ---- 5. The owner permits it: the opportunity now writes to the person, not the role address -----------------------------------
  const listed = await ownerCall('hub.growth_people', [0]);
  assert.ok(listed.items.some(item => item.id === found.contactId)); assert.equal(listed.creditCap, 2); assert.equal(listed.creditsToday, 2);
  assert.equal(await ownerCall('hub.growth_people_decide', [[found.contactId], 'permit']), 1);
  assert.equal((await row('select eligibility from private.growth_contacts where id=$1', [found.contactId])).eligibility, 'permitted');
  assert.equal((await row('select contact_id from private.growth_opportunities where id=$1', [opp])).contact_id, found.contactId);
  assert.equal(await ownerCall('hub.growth_people_decide', [[found.contactId], 'refuse']), 0, 'Only people waiting for review are decided');
  await assert.rejects(pool.query("select hub.growth_people_decide(array[$1]::uuid[],'permit')", [found.contactId]), error => ['28000', '42501'].includes(error?.code));
  assert.equal((await row("select private.growth_message_class('marketing_manager','marketing','enriched') as c")).c, 'growth.cold_email', 'A found person is cold email');

  // ---- 6. An imported list ------------------------------------------------------------------------------------------------------
  const listDomain = domainOf('imported-agency');
  const imported = await ownerCall('hub.growth_import', [JSON.stringify([
    { name: 'Imported Agency', domain: `https://www.${listDomain}/about`, email: `pat@${listDomain}`, contactName: 'Pat Reader', role: 'Administrator' },
    { name: 'Elsewhere Agency', domain: domainOf('elsewhere'), email: `pat@gmail.com` },
    { name: 'Gmail Agency', domain: 'gmail.com' },
    { name: 'Unsubscribed Agency', domain: domainOf('unsub'), email: unsubscribed },
  ])]);
  assert.deepEqual(imported, { rows: 4, organizations: 3, contacts: 1, skipped: 3 });
  const importedContact = await row('select c.*,g.discovered_at from private.growth_contacts c join private.growth_organizations g on g.id=c.organization_id where c.email=$1', [`pat@${listDomain}`]);
  assert.deepEqual([importedContact.source_kind, importedContact.eligibility, importedContact.name], ['imported', 'review', 'Pat Reader']);
  assert.ok(importedContact.discovered_at, 'Imported businesses are read by the contact finder like discovered ones');
  assert.equal((await store.importServer([{ name: 'Server Agency', domain: domainOf('server') }])).organizations, 1);
  await assert.rejects(ownerCall('hub.growth_import', [JSON.stringify(Array.from({ length: 501 }, () => ({ name: 'x', domain: 'x.org' })))]), refused('22023'));

  // ---- 7. Deeper research: one prospect at a time, within the daily number, not again for 30 days -------------------------------
  const researchDomain = domainOf('research-agency');
  await store.discover('caremetric-intel', [{ name: 'Synthetic Research Agency', domain: researchDomain, url: `https://${researchDomain}/`, claim: 'A home health agency.' }]);
  const researchOpp = (await row('select o.id from private.growth_opportunities o join private.growth_organizations g on g.id=o.organization_id where g.domain=$1', [researchDomain])).id;
  await admin.query("update private.growth_opportunities set fit=74,stage='researched',updated_at=now()-interval '10 years' where id=$1", [researchOpp]);
  const used = Number((await row('select count(*) n from private.growth_research_log where researched_at>=private.agent_day_start()')).n);
  assert.equal(await store.researchNext(used), null, 'The day\'s number is spent');
  const picked = await store.researchNext(used + 1);
  assert.equal(picked.id, researchOpp); assert.equal(picked.domain, researchDomain);
  assert.notEqual((await store.researchNext(used + 5))?.id, researchOpp, 'Not again for 30 days');
  await assert.rejects(store.researchNext(51), refused('22023'));

  // ---- 8. The gate refuses drift ------------------------------------------------------------------------------------------------
  const client = await admin.connect();
  const rewrite = (signature, from, to) => `do $$ declare d text := pg_get_functiondef('${signature}'::regprocedure); begin
    if position($q$${from}$q$ in d) = 0 then raise exception 'fixture text missing'; end if; execute replace(d, $q$${from}$q$, $q$${to}$q$); end $$`;
  try {
    for (const drift of [
      'grant select on private.growth_people to authenticated',
      'grant execute on function private.growth_enrichment_reserve(integer) to authenticated',
      rewrite('private.growth_enriched_contact(uuid,text,text)', "'review', now(), p.source_url, 'enriched'", "'permitted', now(), p.source_url, 'enriched'"),
      rewrite('private.growth_import_rows(jsonb,uuid)', "'review', now(), 'imported'", "'permitted', now(), 'imported'"),
      "delete from private.hub_settings where key='growth.enrichment_provider'",
    ]) {
      await client.query('begin');
      try { await client.query(drift); await assert.rejects(client.query(gate), refused('55000'), drift); }
      finally { await client.query('rollback'); }
    }
  } finally { client.release(); }

  console.log('Decision-makers integration passed: candidates never yet emailed, people recorded with ids, the daily credit cap reserved in the database, found addresses on the business\'s own domain waiting for the owner, permitting one makes it the contact, imported lists skip addresses elsewhere and unsubscribes, and gate drift. Nothing was fetched or sent.');
} finally {
  for (const domain of domains) {
    const org = (await row('select id from private.growth_organizations where domain=$1', [domain]))?.id;
    if (!org) continue;
    await admin.query('delete from private.growth_people where organization_id=$1', [org]);
    await admin.query('delete from private.growth_research_log where opportunity_id in(select id from private.growth_opportunities where organization_id=$1)', [org]);
    await admin.query('delete from private.growth_evidence where opportunity_id in(select id from private.growth_opportunities where organization_id=$1)', [org]);
    await admin.query('delete from private.growth_opportunities where organization_id=$1', [org]);
    await admin.query('delete from private.growth_contacts where organization_id=$1', [org]);
    await admin.query("delete from private.audit_events where action like 'growth.%' and entity_id=$1", [org]);
    await admin.query('delete from private.growth_organizations where id=$1', [org]);
  }
  await admin.query("delete from private.audit_events where action='growth.list_imported' and (actor_id=$1 or actor_id is null) and created_at>now()-interval '1 hour'", [owner]);
  await admin.query('delete from private.email_suppressions where email_hash=any($1::text[])', [suppressed]);
  await admin.query("update private.hub_settings set value=$1 where key='growth.enrichment_daily_credits'", [seedCredits?.value ?? null]);
  await admin.query('delete from private.growth_enrichment_days where day=$1', [today]);
  if (seedDay) await admin.query('insert into private.growth_enrichment_days(day,used) values($1,$2)', [today, seedDay.used]);
  await admin.query('delete from private.sms_sessions where user_id=$1', [owner]);
  await admin.query('delete from private.sms_identities where user_id=$1', [owner]);
  await admin.query('delete from private.staff_permissions where user_id=$1', [owner]);
  await admin.query('delete from hub.profiles where id=$1', [owner]);
  await admin.query('delete from auth.users where id=$1', [owner]);
  await pool.end(); await admin.end();
}
