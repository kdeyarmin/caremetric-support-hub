// The owner's own email sequences, through the real roles (20261127150000_owner_sequences.sql): only a current owner session saves,
// approves, stops or discards a sequence and only the Hub server claims and records its emails; nothing is claimed before approval or
// with the setting off; the claim keeps to weekdays, the window, the order of the steps (one a day per person), the sequence's daily
// limit and 25 prospecting emails a day; a reply stops a person, an out-of-office does not unless it says the person left, and a "no
// thanks" forbids the address, the agency's domain and its CCN for every later sequence and for the Marketing Manager's cold email; a
// bounce stops a person (a hard one suppresses the address); a complaint and the one-click unsubscribe forbid them; an open counts only
// after the first email; and the gate refuses drift. Disposable loopback database only; nothing is fetched or sent.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { digest, withSession } from './sms-auth.mjs';
import { testPhones, removeTestIdentities } from './test-phones.mjs';
import { ownerSequenceStore } from './growth/store.mjs';

const phones = testPhones(import.meta.url);
const databaseUrl = process.env.HUB_TEST_DATABASE_URL;
const local = new URL(databaseUrl);
assert.equal(local.hostname, '127.0.0.1'); assert.equal(local.port, '54322');
const admin = new pg.Pool({ connectionString: databaseUrl });
await admin.query("alter role hub_app_server login password 'ephemeral-test-only'");
const appUrl = new URL(databaseUrl); appUrl.username = 'hub_app_server'; appUrl.password = 'ephemeral-test-only';
const pool = new pg.Pool({ connectionString: appUrl.href });
const store = ownerSequenceStore(pool);
const gate = await readFile(new URL('../supabase/migrations/20261127150100_owner_sequences_contract.sql', import.meta.url), 'utf8');
// The requests' gate, once its migration is in this checkout (20261127200100_owner_sequence_requests_contract.sql).
const requestsGate = await readFile(new URL('../supabase/migrations/20261127200100_owner_sequence_requests_contract.sql', import.meta.url), 'utf8').catch(() => null);
const requests = [];
// The guard's gate, once its migration is in this checkout (20261127210100_owner_sequence_guard_contract.sql).
const guardGate = await readFile(new URL('../supabase/migrations/20261127210100_owner_sequence_guard_contract.sql', import.meta.url), 'utf8').catch(() => null);
const guardOrgs = [];
// The batches' gate, once its migration is in this checkout (20261127220100_owner_sequence_batches_contract.sql).
const batchesGate = await readFile(new URL('../supabase/migrations/20261127220100_owner_sequence_batches_contract.sql', import.meta.url), 'utf8').catch(() => null);
const batchSettings = ['growth.owner_sequence_batches', 'growth.owner_sequence_batch_approve'];
const batchSeed = batchesGate ? (await admin.query('select key, value from private.hub_settings where key = any($1::text[])', [batchSettings])).rows : [];
const strangers = [];
const run = randomUUID().slice(0, 8);
const owner = randomUUID();
const token = `owner-sequences-${randomUUID()}`;
const row = async (sql, values = []) => (await admin.query(sql, values)).rows[0];
const refused = (code, pattern) => error => { assert.equal(error.code, code, error.message); if (pattern) assert.match(error.message, pattern); return true; };
const domainOf = label => `${label}-${run}.example.org`;
const seedSetting = await row("select value from private.hub_settings where key = 'growth.owner_sequences'");
const sequences = [];
const shifted = [];
const comms = [];

// Today and the next weekdays, Eastern, as the database counts them.
const today = (await row("select (now() at time zone 'America/New_York')::date::text as d, extract(isodow from now() at time zone 'America/New_York')::int as dow")).d;
const weekday = (await row("select extract(isodow from now() at time zone 'America/New_York')::int as dow")).dow <= 5;
const weekdaysFrom = async (count, start) => (await admin.query(`select d::date::text as d from generate_series($1::date, $1::date + 30, interval '1 day') d
  where extract(isodow from d) <= 5 order by d limit $2`, [start, count])).rows.map(r => r.d);
const firstDay = weekday ? today : (await weekdaysFrom(1, today))[0];

function person(label, { ccn = null, steps = 3, dates } = {}) {
  return { id: randomUUID(), ref: `${label}-${run}`.slice(0, 40), email: `owner@${domainOf(label)}`, domain: domainOf(label), firstName: 'Jane', agency: `Synthetic ${label}`,
    county: 'Erie', setting: 'hha', ccn, reportUrl: null, unsubscribeHash: digest(`owner-sequence-${run}-${label}`), notes: {},
    messages: Array.from({ length: steps }, (_, i) => ({ step: i + 1, sendOn: dates[i], subject: `Synthetic ${label} ${i + 1}`, body: `Hi Jane,\n\nEmail ${i + 1} for ${label}.` })) };
}
const ownerCall = (fn, args = []) => withSession(pool, token, async db => (await db.query(`select ${fn}(${args.map((_, i) => `$${i + 1}`).join(',')}) as r`, args)).rows[0].r);
async function create(people, dates, extra = {}) {
  const saved = await ownerCall('hub.owner_sequence_create', [JSON.stringify({ name: `Synthetic ${run}`, template: 'intel-pa-cold-2026-11', campaign: 'pa-cold-email',
    sendDates: dates, windowStart: '00:00', windowEnd: '23:59:59', dailyLimit: 30, sender: { fromName: 'Kevin Deyarmin' }, people, ...extra })]);
  sequences.push(saved.id);
  return saved;
}
async function reply(email, body, subject = 'Re: your email') {
  const c = await row(`insert into private.communications(channel, source_system, source_key, subject, contact_email) values ('email', 'hub.email', $1, $2, $3) returning id`,
    [`owner-sequences-${run}-${comms.length}`, subject, email]);
  comms.push(c.id);
  await admin.query("insert into private.communication_messages(communication_id, direction, body, delivery, provider_message_id) values ($1, 'inbound', $2, 'received', $3)",
    [c.id, body, `email:owner-sequences-${run}-${comms.length}`]);
}
const recipient = ref => row('select * from private.owner_sequence_recipients where ref = $1 and sequence_id = any($2::uuid[]) order by created_at desc limit 1', [ref, sequences]);
const messages = id => admin.query('select step, status, attempted_at from private.owner_sequence_messages where recipient_id = $1 order by step', [id]).then(r => r.rows);

try {
  await admin.query('insert into auth.users(id,email,is_anonymous) values ($1,$2,false)', [owner, `owner-sequences-${run}@test.invalid`]);
  await admin.query("insert into hub.profiles(id,display_name) values ($1,'Owner sequences integration fixture') on conflict (id) do nothing", [owner]);
  await admin.query('insert into private.sms_identities(user_id,phone_e164,verified_at) values ($1,$2,now())', [owner, phones.owner]);
  await admin.query(`insert into private.sms_sessions(id,token_hash,user_id,identity_version,created_at,expires_at)
    select $1,$2,user_id,identity_version,now(),now()+interval '1 hour' from private.sms_identities where user_id=$3`, [randomUUID(), digest(token), owner]);
  await admin.query("insert into private.staff_permissions(user_id,permission) values ($1,'platform.admin')", [owner]);
  // Other scripts' growth emails sent today count toward the 25 a day; they are moved back a day for this run and restored after.
  shifted.push(...(await admin.query("update private.growth_messages set attempted_at = attempted_at - interval '2 days' where attempted_at >= private.agent_day_start() returning id")).rows.map(r => r.id));

  // 1. Boundaries: the tables are closed, the owner's commands need a current owner session, the server's are the server's alone.
  for (const table of ['owner_sequences', 'owner_sequence_recipients', 'owner_sequence_messages', 'outreach_do_not_contact']) {
    await assert.rejects(pool.query(`select 1 from private.${table} limit 1`), refused('42501'));
  }
  await assert.rejects(pool.query('select hub.owner_sequence_create($1)', ['{}']), refused('28000'));
  await assert.rejects(admin.query('select private.owner_sequence_claim()'), refused('42501'));
  await assert.rejects(withSession(pool, null, db => db.query('select hub.owner_sequences_list()'), false), refused('42501'));

  const dates = await weekdaysFrom(3, firstDay);
  // A weekend date, dates out of order or a missing email are refused.
  const saturday = (await row("select d::date::text as d from generate_series($1::date, $1::date + 7, interval '1 day') d where extract(isodow from d) = 6 limit 1", [firstDay])).d;
  await assert.rejects(create([person('weekend', { dates: [saturday, dates[1], dates[2]] })], [saturday, dates[1], dates[2]]), refused('22023'));
  await assert.rejects(create([person('order', { dates })], [dates[1], dates[0], dates[2]]), refused('22023'));
  await assert.rejects(create([{ ...person('short', { dates }), messages: person('short', { dates }).messages.slice(0, 2) }], dates), refused('22023'));

  // 2. A draft: nothing is claimed until it is approved, and only at its own version.
  await admin.query("update private.hub_settings set value = 'true'::jsonb where key = 'growth.owner_sequences'");
  const people = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot'].map((label, i) => person(label, { dates, ccn: i === 1 ? `39${run.replace(/[^0-9]/g, '0').slice(0, 4).padEnd(4, '0')}` : null }));
  const draft = await create(people, dates);
  assert.ok(['none_due', 'weekend'].includes((await store.claim()).status));
  await assert.rejects(ownerCall('hub.owner_sequence_approve', [draft.id, 7]), refused('40001'));
  await ownerCall('hub.owner_sequence_approve', [draft.id, draft.version]);
  const detail = await ownerCall('hub.owner_sequence_detail', [draft.id]);
  assert.equal(detail.status, 'approved'); assert.equal(detail.people.length, 6);
  assert.deepEqual(detail.people[0].messages.map(m => m.sendOn), dates);
  // Someone already in an approved sequence cannot be put in another.
  assert.equal((await ownerCall('hub.owner_sequence_check', [JSON.stringify([{ ref: 'x', email: people[0].email }])])).x, 'in_sequence');
  await admin.query("update private.hub_settings set value = 'false'::jsonb where key = 'growth.owner_sequences'");
  assert.equal((await store.claim()).status, 'off');
  await admin.query("update private.hub_settings set value = 'true'::jsonb where key = 'growth.owner_sequences'");

  if (!weekday || firstDay !== today) {
    assert.equal((await store.claim()).status, 'weekend');
    console.log('Owner sequences integration: today is a weekend in Eastern time, so the sending checks were skipped.');
  } else {
    // 3. One email at a time, first steps first, in reference order; never a second step the same day.
    const sent = [];
    for (let i = 0; i < 6; i++) {
      const claimed = await store.claim();
      assert.equal(claimed.send, true, JSON.stringify(claimed)); assert.equal(claimed.step, 1);
      assert.equal(claimed.body, `Hi Jane,\n\nEmail 1 for ${claimed.to.split('@')[1].split('-')[0]}.`);
      assert.equal(claimed.sender.fromName, 'Kevin Deyarmin');
      sent.push(claimed);
      assert.equal(await store.finish(claimed.id, 'accepted', `sg-${i}`), true);
    }
    assert.deepEqual(sent.map(c => c.to.split('@')[1].split('-')[0]), ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot']);
    assert.equal((await store.claim()).status, 'none_due');
    // The next day: step 2 is due once its date comes and step 1 went out on an earlier day.
    await admin.query("update private.owner_sequence_messages m set attempted_at = attempted_at - interval '1 day' from private.owner_sequence_recipients r where r.id = m.recipient_id and r.sequence_id = $1 and m.step = 1", [draft.id]);
    await admin.query("update private.owner_sequence_messages m set send_on = $2 from private.owner_sequence_recipients r where r.id = m.recipient_id and r.sequence_id = $1 and m.step = 2", [draft.id, today]);

    // 4. Replies. Alpha asks a question: stopped, the owner is told once. Bravo says no thanks: forbidden for good, address, domain and CCN.
    // Charlie is out of the office: nothing stops. Delta's auto-reply says she has left: stopped.
    const alpha = await recipient(people[0].ref); const bravo = await recipient(people[1].ref);
    const charlie = await recipient(people[2].ref); const delta = await recipient(people[3].ref);
    await reply(people[0].email, 'Thanks for this. How long does setup take?');
    await reply(`office@${domainOf('bravo')}`, 'No thanks.\n\nOn Tue, Kevin Deyarmin wrote:\n> Not relevant? Reply "no thanks"');
    await reply(people[2].email, 'I am out of the office until Monday with limited access to email.', 'Automatic reply: Valley Home Health in Erie County');
    await reply(people[3].email, 'Jane is no longer with the agency. Please contact the office.', 'Automatic reply');
    const review = await store.review();
    const stops = Object.fromEntries(review.stopped.map(item => [item.ref, item.reason]));
    assert.deepEqual(stops, { [people[0].ref]: 'replied', [people[1].ref]: 'opted_out', [people[3].ref]: 'left' });
    assert.deepEqual((await store.review()).stopped, []);
    assert.equal((await recipient(people[2].ref)).status, 'active');
    assert.ok((await recipient(people[2].ref)).notes.autoReplyAt);
    for (const who of [alpha, bravo, delta]) assert.deepEqual((await messages(who.id)).map(m => m.status), ['accepted', 'cancelled', 'cancelled']);
    assert.ok(await row("select 1 as ok from private.outreach_do_not_contact where kind = 'email_hash' and value = private.email_hash($1)", [people[1].email]));
    assert.ok(await row("select 1 as ok from private.outreach_do_not_contact where kind = 'domain' and value = $1", [domainOf('bravo')]));
    assert.ok(await row("select 1 as ok from private.outreach_do_not_contact where kind = 'ccn' and value = $1", [people[1].ccn]));
    assert.ok(await row('select 1 as ok from private.email_suppressions where email_hash = private.email_hash($1)', [people[1].email]));
    assert.equal((await ownerCall('hub.owner_sequence_check', [JSON.stringify([{ ref: 'a', email: `someone@${domainOf('bravo')}`, domain: domainOf('bravo') },
      { ref: 'b', email: `new@${domainOf('other')}`, domain: domainOf('other'), ccn: people[1].ccn }])])).a, 'do_not_contact');
    await assert.rejects(create([person('bravo2', { dates })].map(p => ({ ...p, email: `x@${domainOf('bravo')}`, domain: domainOf('bravo') })), dates), refused('22023', /may not be emailed/));
    // The Marketing Manager's cold email never writes to an organization on that domain.
    const org = await row('insert into private.growth_organizations(name, domain) values ($1, $2) returning id', [`Synthetic bravo ${run}`, domainOf('bravo')]);
    assert.equal((await row('select private.growth_outreach_stopped($1) as stopped', [org.id])).stopped, true);
    await admin.query('delete from private.growth_organizations where id = $1', [org.id]);
    // The Support Concierge leaves a sequence's person, and their colleagues, to the owner.
    assert.equal((await row('select private.owner_sequence_contact($1) as c', [`someone.else@${domainOf('charlie')}`])).c, true);
    assert.equal((await row('select private.owner_sequence_contact($1) as c', ['stranger@example.net'])).c, false);

    // 5. Charlie, still active, gets step 2 now; nobody else is due today but echo and foxtrot.
    const next = await store.claim();
    assert.equal(next.step, 2); assert.equal(next.to, people[2].email);
    await store.finish(next.id, 'unknown', null);
    // While Charlie's email is in doubt, nothing else goes to her; the others still go.
    const others = [await store.claim(), await store.claim()];
    assert.deepEqual(others.map(c => [c.to, c.step]), [[people[4].email, 2], [people[5].email, 2]]);
    for (const c of others) await store.finish(c.id, 'accepted', 'sg');

    // 6. Delivery events: a hard bounce stops echo and suppresses the address, once; a complaint forbids foxtrot.
    const echo = await recipient(people[4].ref); const foxtrot = await recipient(people[5].ref);
    const echoMessage = (await row('select id from private.owner_sequence_messages where recipient_id = $1 and step = 2', [echo.id])).id;
    assert.equal(await store.delivery(`bounce-${run}`, echoMessage, 'bounced', new Date().toISOString(), true), true);
    assert.equal(await store.delivery(`bounce-${run}`, echoMessage, 'bounced', new Date().toISOString(), true), false);
    assert.equal((await recipient(people[4].ref)).stop_reason, 'bounced');
    assert.ok(await row('select 1 as ok from private.email_suppressions where email_hash = private.email_hash($1)', [people[4].email]));
    assert.equal(await row("select 1 as ok from private.outreach_do_not_contact where kind = 'domain' and value = $1", [domainOf('echo')]), undefined);
    const foxMessage = (await row('select id from private.owner_sequence_messages where recipient_id = $1 and step = 2', [foxtrot.id])).id;
    await store.delivery(`spam-${run}`, foxMessage, 'complaint', new Date().toISOString(), true);
    assert.equal((await recipient(people[5].ref)).stop_reason, 'complaint');
    assert.ok(await row("select 1 as ok from private.outreach_do_not_contact where kind = 'domain' and value = $1", [domainOf('foxtrot')]));
    assert.equal(await store.unsubscribe(digest('not a sequence link')), false);

    // 7. Opens: one before the first email went out (plus two minutes) is ignored; a later one counts and is told once.
    const first = (await row('select min(attempted_at) as at from private.owner_sequence_messages where recipient_id = $1', [charlie.id])).at;
    assert.equal(await store.views([{ ref: people[2].ref, viewed_at: new Date(first.getTime() + 60_000).toISOString() }]), 0);
    assert.equal(await store.views([{ ref: people[2].ref, viewed_at: new Date(first.getTime() + 600_000).toISOString() }, { ref: 'unknown-ref', viewed_at: new Date().toISOString() }]), 1);
    const told = await store.review();
    assert.deepEqual(told.opened.map(item => item.ref), [people[2].ref]);
    assert.deepEqual((await store.review()).opened, []);
  }

  // 8. The one-click unsubscribe forbids the person; stopping the sequence cancels what is left; a draft is discarded, an approved one is not.
  const later = await weekdaysFrom(3, (await row("select ($1::date + 7)::text as d", [firstDay])).d);
  const second = await create([person('golf', { dates: later }), person('hotel', { dates: later })], later);
  await ownerCall('hub.owner_sequence_approve', [second.id, second.version]);
  assert.equal(await store.unsubscribe(digest(`owner-sequence-${run}-golf`)), true);
  assert.equal((await recipient(`golf-${run}`)).stop_reason, 'unsubscribed');
  assert.ok(await row("select 1 as ok from private.outreach_do_not_contact where kind = 'domain' and value = $1", [domainOf('golf')]));
  assert.equal((await ownerCall('hub.owner_sequence_stop', [second.id, null])).stopped, 1);
  assert.equal((await row('select status from private.owner_sequences where id = $1', [second.id])).status, 'stopped');
  assert.deepEqual((await messages((await recipient(`hotel-${run}`)).id)).map(m => m.status), ['cancelled', 'cancelled', 'cancelled']);
  await assert.rejects(ownerCall('hub.owner_sequence_discard', [second.id]), refused('40001'));
  const third = await create([person('india', { dates: later })], later);
  assert.equal((await ownerCall('hub.owner_sequence_discard', [third.id])).discarded, true);
  assert.equal(await row('select 1 as ok from private.owner_sequences where id = $1', [third.id]), undefined);
  assert.ok((await ownerCall('hub.owner_sequences_list')).some(item => item.id === second.id));

  // 8b. The guard (20261127210000_owner_sequence_guard.sql): the Marketing Manager's cold email leaves a sequence's agency alone, by its
  // domain or the CCN the roster tied to it; and a sequence leaves out an agency the Marketing Manager emailed, by its CCN too.
  if (guardGate) {
    const guardCcn = `3${run.replace(/[^0-9]/g, '1').slice(0, 5).padEnd(5, '1')}`;
    const guarded = await create([person('mike', { dates: later, ccn: guardCcn })], later);
    await ownerCall('hub.owner_sequence_approve', [guarded.id, guarded.version]);
    const org = async (label, ccn = null) => {
      const o = (await row('insert into private.growth_organizations(name, domain) values ($1, $2) returning id', [`Guard ${label} ${run}`, domainOf(label)])).id;
      guardOrgs.push(o);
      if (ccn) await admin.query("insert into private.growth_roster_targets(ccn, name, setting, state, period, claim, organization_id, status) values ($1, $2, 'home_health', 'PA', '2026Q3', 'Synthetic', $3, 'graduated')", [ccn, `Guard ${label}`, o]);
      return o;
    };
    const stopped = async id => (await row('select private.growth_outreach_stopped($1) as s', [id])).s;
    assert.equal(await stopped(await org('mike')), true, 'the sequence\'s own domain');
    assert.equal(await stopped(await org('november', guardCcn)), true, 'another domain the roster tied to the sequence\'s CCN');
    assert.equal(await stopped(await org('oscar')), false, 'an agency in no sequence');
    // An agency the Marketing Manager emailed, known to the sequence only by its CCN.
    const emailedCcn = `3${run.replace(/[^0-9]/g, '2').slice(0, 5).padEnd(5, '2')}`;
    const emailed = await org('papa', emailedCcn);
    const contact = (await row("insert into private.growth_contacts(organization_id, email, source_kind) values ($1, $2, 'role_address') returning id", [emailed, `info@${domainOf('papa')}`])).id;
    const opportunity = (await row("insert into private.growth_opportunities(organization_id, product, contact_id) values ($1, 'caremetric-intel', $2) returning id", [emailed, contact])).id;
    await admin.query("insert into private.growth_messages(opportunity_id,contact_id,purpose,subject,body,opportunity_version,contact_version,policy_version,status,unsubscribe_hash,attempted_at) values($1,$2,'marketing','Synthetic','Synthetic',1,1,1,'delivered',$3,now()-interval '3 days')",
      [opportunity, contact, digest(`guard-${run}`)]);
    const check = await ownerCall('hub.owner_sequence_check', [JSON.stringify([{ ref: 'by-ccn', email: `someone@${domainOf('quebec')}`, domain: domainOf('quebec'), ccn: emailedCcn },
      { ref: 'clean', email: `someone@${domainOf('romeo')}`, domain: domainOf('romeo') }])]);
    assert.deepEqual(check, { 'by-ccn': 'growth_contacted' });
  }

  // 9. Requests an operator queued (20261127200000_owner_sequence_requests.sql): the Hub server cannot queue one; one for someone who is not
  // a CareMetric admin fails; one for the owner is prepared, saved in the owner's name and approved when it asked; a draft the database
  // refuses fails the request with the reason; a request is finished once.
  if (requestsGate) {
    await assert.rejects(pool.query("insert into private.owner_sequence_requests(requested_by, payload) values ($1, '{}')", [owner]), refused('42501'));
    const stranger = randomUUID(); strangers.push(stranger);
    await admin.query('insert into auth.users(id,email,is_anonymous) values ($1,$2,false)', [stranger, `owner-sequences-stranger-${run}@test.invalid`]);
    const notAdmin = (await row("insert into private.owner_sequence_requests(requested_by, payload, approve) values ($1, '{}', true) returning id", [stranger])).id;
    requests.push(notAdmin);
    const requestDates = await weekdaysFrom(3, (await row("select ($1::date + 14)::text as d", [firstDay])).d);
    const queued = (await row("insert into private.owner_sequence_requests(requested_by, payload, approve) values ($1, $2, true) returning id",
      [owner, JSON.stringify({ name: 'Queued', csv: 'ref,email' })])).id;
    requests.push(queued);
    const next = await store.requestNext();
    assert.equal(next.id, queued); assert.equal(next.approve, true); assert.equal(next.payload.name, 'Queued');
    assert.deepEqual((await row('select status, result from private.owner_sequence_requests where id = $1', [notAdmin])), { status: 'failed', result: { error: 'not_an_admin' } });
    assert.equal(await store.requestNext(), null);
    await assert.rejects(store.requestCheck(notAdmin, []), refused('42501'));
    assert.equal((await store.requestCheck(queued, [{ ref: 'g', email: `x@${domainOf('golf')}`, domain: domainOf('golf') }])).g, 'do_not_contact');
    const queuedPerson = person('juliet', { dates: requestDates });
    const done = await store.requestFinish(queued, { name: `Queued ${run}`, template: 'intel-pa-cold-2026-11', campaign: 'pa-cold-email', sendDates: requestDates,
      dailyLimit: 8, sender: { fromName: 'Kevin Deyarmin' }, people: [queuedPerson] }, [{ row: null, ref: 'pa-x', agency: 'Left', reason: 'growth_contacted' }], null);
    assert.equal(done.status, 'prepared'); assert.equal(done.approved, true);
    sequences.push(done.sequenceId);
    const saved = await row('select status, created_by, approved_by from private.owner_sequences where id = $1', [done.sequenceId]);
    assert.deepEqual(saved, { status: 'approved', created_by: owner, approved_by: owner });
    assert.equal((await row("select metadata ->> 'via' as via from private.audit_events where action = 'growth.owner_sequence_approved' and entity_id = $1", [done.sequenceId])).via, 'request');
    assert.deepEqual((await row('select status, sequence_id, result from private.owner_sequence_requests where id = $1', [queued])),
      { status: 'prepared', sequence_id: done.sequenceId, result: { problems: [{ row: null, ref: 'pa-x', agency: 'Left', reason: 'growth_contacted' }], approved: true, people: 1 } });
    await assert.rejects(store.requestFinish(queued, null, [], 'again'), refused('40001'));
    // A draft the database refuses (a person on the do-not-contact list) fails the request; nothing is saved.
    const refusedRequest = (await row("insert into private.owner_sequence_requests(requested_by, payload, approve) values ($1, '{}', true) returning id", [owner])).id;
    requests.push(refusedRequest);
    assert.equal((await store.requestNext()).id, refusedRequest);
    const forbidden = { ...person('kilo', { dates: requestDates }), email: `y@${domainOf('golf')}`, domain: domainOf('golf') };
    const failed = await store.requestFinish(refusedRequest, { name: `Refused ${run}`, template: 'intel-pa-cold-2026-11', campaign: 'pa-cold-email', sendDates: requestDates,
      people: [forbidden] }, [], null);
    assert.equal(failed.status, 'failed'); assert.match(failed.error, /may not be emailed/);
    assert.equal(await row("select 1 as ok from private.owner_sequences where name = $1", [`Refused ${run}`]), undefined);
    // A request a restart left half done is taken up again after 15 minutes.
    const stale = (await row("insert into private.owner_sequence_requests(requested_by, payload, status, claimed_at) values ($1, '{}', 'preparing', now() - interval '20 minutes') returning id", [owner])).id;
    requests.push(stale);
    assert.equal((await store.requestNext()).id, stale);
    await store.requestFinish(stale, null, [], 'test');
  }

  // 9b. The AI team's weekly batch (20261127220000_owner_sequence_batches.sql): only the Hub server plans and queues one; off, none is due;
  // the candidates are proprietary, one-office agencies outside the owner's home area, never written to, with a person whose address was
  // confirmed on the agency's own domain; a batch is queued once a week in the owner's name, approved only per the setting.
  if (batchesGate) {
    await assert.rejects(admin.query('select private.owner_sequence_batch_plan(5)'), refused('42501'));
    await assert.rejects(pool.query('select private.owner_sequence_batch_candidates(5)'), refused('42501'));
    await admin.query("update private.hub_settings set value = 'false'::jsonb where key = 'growth.owner_sequence_batches'");
    assert.deepEqual(await store.batchPlan(5), { due: false, why: 'off' });
    await admin.query("update private.hub_settings set value = 'true'::jsonb where key = 'growth.owner_sequence_batches'");
    await admin.query("update private.hub_settings set value = 'false'::jsonb where key = 'growth.owner_sequence_batch_approve'");
    const agency = async (label, { control = 'Proprietary', county = '42079', mailbox = 'verified', offices = 1, emailed = false, onDomain = true } = {}) => {
      const org = (await row('insert into private.growth_organizations(name, domain) values ($1, $2) returning id', [`Batch ${label} ${run}`, domainOf(label)])).id;
      guardOrgs.push(org);
      for (let office = 0; office < offices; office += 1) {
        await admin.query("insert into private.growth_roster_targets(ccn, name, setting, state, period, claim, organization_id, status, county_fips, facts) values ($1, $2, 'home_health', 'PA', '2026Q3', 'Synthetic', $3, 'graduated', $4, $5)",
          [`Q${run.toUpperCase().slice(0, 6)}${String(guardOrgs.length % 100).padStart(2, '0')}${office}`, `BATCH ${label.toUpperCase()} HOME HEALTH LLC`, org, county,
            JSON.stringify({ control, address: `${office + 1} Main Street`, patients: 900000 + office })]);
      }
      const contact = (await row("insert into private.growth_contacts(organization_id, email, source_kind, mailbox_result, eligibility) values ($1, $2, 'enriched', $3, 'review') returning id",
        [org, `jane.${label}@${onDomain ? domainOf(label) : 'elsewhere-' + domainOf(label)}`, mailbox])).id;
      await admin.query("insert into private.growth_people(organization_id, name, title, source, contact_id, address_found) values ($1, 'JANE DOE', '5% OR GREATER DIRECT OWNERSHIP INTEREST', 'cms_owners', $2, 'mail_server')", [org, contact]);
      if (emailed) {
        const opportunity = (await row("insert into private.growth_opportunities(organization_id, product, contact_id) values ($1, 'caremetric-intel', $2) returning id", [org, contact])).id;
        await admin.query("insert into private.growth_messages(opportunity_id,contact_id,purpose,subject,body,opportunity_version,contact_version,policy_version,status,unsubscribe_hash,attempted_at) values($1,$2,'marketing','Synthetic','Synthetic',1,1,1,'delivered',$3,now()-interval '200 days')",
          [opportunity, contact, digest(`batch-${run}-${label}`)]);
      }
      return org;
    };
    const ready = await agency('sierra');
    const left = [await agency('tango', { control: 'Voluntary nonprofit, private' }), await agency('uniform', { county: '42021' }), await agency('victor', { mailbox: 'catch_all' }),
      await agency('whiskey', { offices: 2 }), await agency('xray', { emailed: true }), await agency('yankee', { onDomain: false })];
    const plan = await store.batchPlan(200);
    assert.equal(plan.due, true); assert.equal(plan.owner, owner);
    const found = plan.candidates.filter(candidate => [ready, ...left].includes(candidate.id));
    assert.deepEqual(found.map(candidate => candidate.id), [ready], 'only the proprietary, one-office agency outside the home area, never emailed, with a confirmed address on its domain');
    assert.equal(found[0].domain, domainOf('sierra'));
    assert.deepEqual(found[0].people, [{ name: 'JANE DOE', title: '5% OR GREATER DIRECT OWNERSHIP INTEREST', source: 'cms_owners', email: `jane.sierra@${domainOf('sierra')}` }]);
    assert.equal(found[0].targets[0].countyFips, '42079');
    await assert.rejects(store.batchQueue({ name: 'No list' }), refused('22023'));
    const queued = await store.batchQueue({ name: `Batch ${run}`, csv: 'ref,email\n' });
    assert.equal(queued.queued, true); assert.equal(queued.approve, false);
    requests.push(queued.id);
    assert.deepEqual(await row('select requested_by, approve, status, payload ->> \'builtBy\' as built from private.owner_sequence_requests where id = $1', [queued.id]),
      { requested_by: owner, approve: false, status: 'waiting', built: 'growth.sequence_batches' });
    assert.deepEqual(await store.batchPlan(5), { due: false, why: 'request_waiting' });
    await admin.query("update private.owner_sequence_requests set status = 'failed', finished_at = now() where id = $1", [queued.id]);
    assert.deepEqual(await store.batchPlan(5), { due: false, why: 'built_this_week' });
    assert.deepEqual(await store.batchQueue({ name: 'Again', csv: 'ref,email\n' }), { queued: false, why: 'built_this_week' });
  }

  // 10. The gate refuses drift and declares nothing on a database that no longer keeps its promises.
  const client = await admin.connect();
  try {
    await client.query('begin');
    await client.query('grant select on private.outreach_do_not_contact to hub_app_server');
    await assert.rejects(client.query(gate), refused('55000', /closed to hub_app_server/));
  } finally { await client.query('rollback'); client.release(); }
  const again = await admin.connect();
  try {
    await again.query('begin');
    await again.query("delete from private.agent_schedules where agent_key = 'marketing_manager' and task_kind = 'growth.sequences'");
    await assert.rejects(again.query(gate), refused('55000', /not scheduled/));
  } finally { await again.query('rollback'); again.release(); }

  if (batchesGate) {
    const drift = await admin.connect();
    try {
      await drift.query('begin');
      await drift.query('grant execute on function private.owner_sequence_batch_candidates(integer) to hub_app_server');
      await assert.rejects(drift.query(batchesGate), refused('55000', /must not be run directly/));
    } finally { await drift.query('rollback'); drift.release(); }
  }
  if (guardGate) {
    const drift = await admin.connect();
    try {
      await drift.query('begin');
      await drift.query("create or replace function private.growth_outreach_stopped(p_org uuid) returns boolean language sql stable set search_path = '' as $$ select false $$");
      await assert.rejects(drift.query(guardGate), refused('55000', /leave a sequence's agency alone/));
    } finally { await drift.query('rollback'); drift.release(); }
  }
  if (requestsGate) {
    const drift = await admin.connect();
    try {
      await drift.query('begin');
      await drift.query('grant insert on private.owner_sequence_requests to hub_app_server');
      await assert.rejects(drift.query(requestsGate), refused('55000', /closed to hub_app_server/));
    } finally { await drift.query('rollback'); drift.release(); }
  }

  console.log('Owner sequences integration passed: the owner\'s session alone saves, approves, stops and discards; nothing is claimed before approval or with the setting off; one email at a time in step order, one step a day; a reply stops, an out-of-office does not, a "no thanks" forbids the address, the domain and the CCN for later sequences and the Marketing Manager\'s cold email; bounces, complaints and the unsubscribe stop and suppress; opens count after the first email; and gate drift. Nothing was fetched or sent.');
} finally {
  if (shifted.length) await admin.query("update private.growth_messages set attempted_at = attempted_at + interval '2 days' where id = any($1::uuid[])", [shifted]);
  await admin.query('update private.hub_settings set value = $1 where key = $2', [seedSetting?.value ?? null, 'growth.owner_sequences']);
  if (comms.length) await admin.query('delete from private.communications where id = any($1::uuid[])', [comms]);
  const hashes = (await admin.query('select private.email_hash(email) as h, domain, ccn from private.owner_sequence_recipients where sequence_id = any($1::uuid[])', [sequences])).rows;
  await admin.query("delete from private.outreach_do_not_contact where (kind = 'email_hash' and value = any($1::text[])) or (kind = 'domain' and value like $2) or (kind = 'ccn' and value = any($3::text[]))",
    [hashes.map(h => h.h), `%-${run}.example.org`, hashes.map(h => h.ccn).filter(Boolean)]);
  await admin.query('delete from private.email_suppressions where email_hash = any($1::text[])', [hashes.map(h => h.h)]);
  if (requests.length) await admin.query('delete from private.owner_sequence_requests where id = any($1::uuid[])', [requests]);
  await admin.query('delete from private.owner_sequence_requests where requested_by = $1', [owner]);
  for (const seed of batchSeed) await admin.query('update private.hub_settings set value = $1 where key = $2', [seed.value, seed.key]);
  if (guardOrgs.length) await admin.query('delete from private.growth_people where organization_id = any($1::uuid[])', [guardOrgs]);
  if (guardOrgs.length) {
    await admin.query('delete from private.growth_messages where opportunity_id in (select id from private.growth_opportunities where organization_id = any($1::uuid[]))', [guardOrgs]);
    await admin.query('delete from private.growth_opportunities where organization_id = any($1::uuid[])', [guardOrgs]);
    await admin.query('delete from private.growth_contacts where organization_id = any($1::uuid[])', [guardOrgs]);
    await admin.query('delete from private.growth_roster_targets where organization_id = any($1::uuid[])', [guardOrgs]);
    await admin.query('delete from private.growth_organizations where id = any($1::uuid[])', [guardOrgs]);
  }
  await admin.query('delete from private.owner_sequences where id = any($1::uuid[])', [sequences]);
  if (strangers.length) await admin.query('delete from auth.users where id = any($1::uuid[])', [strangers]);
  await removeTestIdentities(admin, [owner], { also: ['delete from private.audit_events where actor_id = any($1::uuid[])'] });
  await pool.end(); await admin.end();
}
