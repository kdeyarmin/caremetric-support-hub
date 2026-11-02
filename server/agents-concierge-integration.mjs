// The Support Concierge through the actual Hub server role, on disposable local fixtures only. The server pool logs in as
// hub_app_server exactly like production: it reads conversations only through the three private.agent_* operations the
// Concierge's migration adds, and it triages through the real store, the real task queue and the real owner notifier.
// No model is called, and nothing here sends a real message: the mail and text senders are recording fakes.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { digest, withSession } from './sms-auth.mjs';
import { communications } from './communications.mjs';
import { gateway } from './gateway.mjs';
import { agentTeam } from './agents/index.mjs';

const databaseUrl = process.env.HUB_TEST_DATABASE_URL;
const local = new URL(databaseUrl);
assert.equal(local.hostname, '127.0.0.1');
assert.equal(local.port, '54322');
const admin = new pg.Pool({ connectionString: databaseUrl });
await admin.query("alter role hub_app_server login password 'ephemeral-test-only'");
const appUrl = new URL(databaseUrl);
appUrl.username = 'hub_app_server';
appUrl.password = 'ephemeral-test-only';
const pool = new pg.Pool({ connectionString: appUrl.href });
const api = gateway(pool);
const gate = await readFile(new URL('../supabase/migrations/20261102160100_agent_concierge_contract.sql', import.meta.url), 'utf8');

const owner = randomUUID();
const ownerToken = `concierge-owner-${randomUUID()}`, staleToken = `concierge-stale-${randomUUID()}`;
const run = randomUUID().slice(0, 8);
const ownerPhone = `+1202555${String(1000 + Math.floor(Math.random() * 9000))}`;
// Text that must never leave the conversation table: the body, the contact details, the organization and an internal note.
const canary = `CANARY-${run}`;
const secrets = { name: `Pat Example ${run}`, email: `pat.${run}@example.test`, phone: '+12025550142', organization: `Example Facility ${run}`, note: `NOTE-${canary}`, body: `BODY-${canary}` };

const call = async (fn, args = []) => (await pool.query(`select ${fn}(${args.map((_, i) => `$${i + 1}`).join(',')}) as r`, args)).rows[0].r;
const refused = (code, pattern) => error => { assert.equal(error.code, code, error.message); if (pattern) assert.match(error.message, pattern); return true; };
const row = async (sql, params = []) => (await admin.query(sql, params)).rows[0];
const rows = async (sql, params = []) => (await admin.query(sql, params)).rows;
const minutesAgo = minutes => new Date(Date.now() - minutes * 60_000);
const action = id => row('select * from private.agent_actions where id = $1', [id]);
const auditFor = (actionName, entityId) => rows('select * from private.audit_events where action = $1 and entity_id = $2 order by id', [actionName, entityId]);

const made = [];
let counter = 0;
// A conversation with messages at exact times, written as a superuser so each fixture is exactly what the test needs.
async function conversation({ channel = 'email', product = 'carebase', status = 'new', subject = 'A question', messages = [], contact = true } = {}) {
  const system = { email: 'hub.email', sms: 'hub.sms', chat: 'hub.chat', phone: 'breathe.phone', web_form: 'advisors.web' }[channel];
  counter += 1;
  const times = messages.map(message => minutesAgo(message.ago));
  const last = times.reduce((a, b) => (a > b ? a : b), times[0]);
  const created = await row(`insert into private.communications(channel, source_system, source_key, product_id, status, subject, contact_name, contact_email, contact_phone, organization, chat_token_hash, created_at, updated_at, last_message_at)
    values ($1, $2, $3, (select id from hub.products where slug = $4), $5, $6, $7, $8, $9, $10, $11, $12, $12, $12) returning id, reference`,
  [channel, system, `it-${run}-${counter}`, product, status, subject, contact ? secrets.name : null, contact ? secrets.email : null, contact ? secrets.phone : null, contact ? secrets.organization : null,
    channel === 'chat' ? digest(`chat-${run}-${counter}`) : null, last]);
  made.push(created.id);
  const ids = [];
  for (const [index, message] of messages.entries()) {
    const inserted = await row(`insert into private.communication_messages(communication_id, direction, body, delivery, delivery_channel, request_key, created_at)
      values ($1, $2, $3, $4, $5, $6, $7) returning id`,
    [created.id, message.direction ?? 'inbound', message.body ?? `Hello ${counter}`, { inbound: 'received', outbound: 'sent', note: 'recorded' }[message.direction ?? 'inbound'],
      (message.direction ?? 'inbound') === 'outbound' ? 'email' : null, message.requestKey ?? null, times[index]]);
    ids.push(inserted.id);
  }
  return { id: created.id, reference: Number(created.reference), messages: ids };
}
// An owner call: the same statement the gateway runs, inside a real SMS session.
const ownerCall = (fn, args = [], token = ownerToken) => withSession(pool, token, async db =>
  (await db.query(`select to_jsonb(${fn}(${args.map((_, i) => `$${i + 1}`).join(',')})) as r`, args)).rows[0].r);
const pending = (settle = 90, window = 72, channels = null, limit = 50) => call('private.agent_concierge_pending', [limit, settle, window, channels]);
const snapshot = (id, key = null, count = 0, chars = 2000) => call('private.agent_communication_snapshot', [id, key, count, chars]);
const clearWork = async () => {
  await admin.query("update private.agent_actions set status = 'rejected' where status in ('proposed', 'approved', 'auto_approved', 'executing')");
  await admin.query("update private.agent_tasks set status = 'cancelled', lease_until = null where status in ('queued', 'running', 'awaiting_approval', 'awaiting_session')");
};

let setAside = [];
let foreign = [];
const seedAgents = (await admin.query('select key, status, autonomy, daily_budget_cents, config, updated_at from private.agents')).rows;
const seedSchedules = (await admin.query('select id, next_run_at, last_run_at, last_task_id, enabled from private.agent_schedules')).rows;

try {
  await admin.query("insert into auth.users(id,email,is_anonymous) values($1,'concierge-owner@test.invalid',false)", [owner]);
  await admin.query("insert into private.staff_permissions(user_id,permission) values($1,'platform.admin')", [owner]);
  await admin.query("insert into private.sms_identities(user_id,phone_e164,verified_at) values($1,$2,now())", [owner, ownerPhone]);
  await admin.query("insert into hub.profiles(id,display_name) values($1,'Concierge integration owner') on conflict (id) do update set display_name=excluded.display_name", [owner]);
  for (const [token, age] of [[ownerToken, '0 hours'], [staleToken, '9 hours']]) {
    await admin.query(`insert into private.sms_sessions(id,token_hash,user_id,identity_version,created_at,expires_at)
      select $1,$2,user_id,identity_version,now()-$4::interval,now()+interval '1 hour' from private.sms_identities where user_id=$3`, [randomUUID(), digest(token), owner, age]);
  }
  // The owner contact is "the single active administrator": set the ones other scripts left behind aside for this run.
  setAside = (await admin.query("update private.staff_permissions set revoked_at = now() where permission = 'platform.admin' and revoked_at is null and user_id <> $1 returning id", [owner])).rows.map(entry => entry.id);
  // Other scripts leave unanswered conversations behind. Close them for this run so every count below is this script's own, and reopen them after.
  foreign = (await admin.query("with old as (select id, status from private.communications where status in ('new', 'open')) update private.communications c set status = 'closed' from old where c.id = old.id returning old.id, old.status")).rows;

  // The boundary: the Hub server reads; every other session user is refused before arguments are looked at.
  for (const sql of ["select private.agent_concierge_pending(10, 90, 72, null)", "select private.agent_communication_snapshot(gen_random_uuid(), null, 0, 1000)", "select private.agent_notification_count('x', null, now())"]) {
    await assert.rejects(admin.query(sql), refused('42501', /Application server required/));
  }
  const features = (await api.rpc('get_backend_contract', {})).features;
  assert.ok(features.includes('platform.agents.concierge.v1'), 'the feature is declared');

  // Arguments are validated.
  for (const [fn, args] of [
    ['private.agent_concierge_pending', [0, 90, 72, null]], ['private.agent_concierge_pending', [51, 90, 72, null]], ['private.agent_concierge_pending', [10, -1, 72, null]],
    ['private.agent_concierge_pending', [10, 3601, 72, null]], ['private.agent_concierge_pending', [10, 90, 0, null]], ['private.agent_concierge_pending', [10, 90, 721, null]],
    ['private.agent_communication_snapshot', [randomUUID(), null, -1, 1000]], ['private.agent_communication_snapshot', [randomUUID(), null, 11, 1000]],
    ['private.agent_communication_snapshot', [randomUUID(), null, 1, 99]], ['private.agent_communication_snapshot', [randomUUID(), null, 1, 4001]],
    ['private.agent_notification_count', ['', null, new Date()]], ['private.agent_notification_count', ['x'.repeat(101), null, new Date()]],
    ['private.agent_notification_count', ['x', 'push', new Date()]], ['private.agent_notification_count', ['x', null, null]],
  ]) await assert.rejects(call(fn, args), refused('22023'), `${fn}(${args.map(String).join(', ')})`);

  // ---- Which conversations are pending ------------------------------------------------------------------------------------
  const quiet = await conversation({ messages: [{ ago: 5 }] });
  const fresh = await conversation({ messages: [{ ago: 0.2 }] });
  const stale = await conversation({ messages: [{ ago: 60 * 24 * 5 }] });
  const closed = await conversation({ status: 'closed', messages: [{ ago: 5 }] });
  const waiting = await conversation({ status: 'waiting', messages: [{ ago: 5 }] });
  const answered = await conversation({ messages: [{ ago: 10 }, { ago: 8, direction: 'outbound' }] });
  const noted = await conversation({ messages: [{ ago: 10 }, { ago: 8, direction: 'note', body: secrets.note }] });
  const followUp = await conversation({ messages: [{ ago: 20 }, { ago: 15, direction: 'outbound' }, { ago: 6 }] });
  const text = await conversation({ channel: 'sms', status: 'open', messages: [{ ago: 7 }] });
  const hasTask = await conversation({ messages: [{ ago: 9 }] });
  assert.equal(await call('private.agent_task_enqueue', ['support_concierge', 'concierge.communication', `concierge:${hasTask.messages[0]}`, {}, 5, null, 'communication', null, false]) !== null, true);
  const ids = list => list.map(item => item.id);

  let list = await pending();
  assert.deepEqual(ids(list).filter(id => made.includes(id)).sort(), [quiet.id, followUp.id, text.id].sort(), 'settled, recent, unanswered and without a task; text messages included when no channels are given');
  assert.deepEqual(Object.keys(list[0]).sort(), ['channel', 'id', 'messageId', 'receivedAt', 'reference'], 'ids, the channel, a time and the reference number: no text');
  const quietItem = list.find(item => item.id === quiet.id);
  assert.deepEqual([quietItem.reference, quietItem.channel, quietItem.messageId], [quiet.reference, 'email', quiet.messages[0]]);
  assert.equal(list.find(item => item.id === followUp.id).messageId, followUp.messages[2], 'a customer\'s reply after an answer is pending as its own message');
  assert.deepEqual(ids(await pending(90, 72, ['email', 'chat', 'web_form', 'phone'])).filter(id => made.includes(id)).sort(), [quiet.id, followUp.id].sort(), 'channels are filtered in the database');
  assert.ok(ids(await pending(0)).includes(fresh.id), 'a message that has not settled is pending only when nobody asked it to settle');
  assert.ok(!ids(list).includes(fresh.id), 'a burst of messages waits for the settle time');
  assert.ok(ids(await pending(90, 24 * 6)).includes(stale.id), 'a wider window reaches an older message');
  assert.ok(!ids(list).some(id => [stale.id, closed.id, waiting.id, answered.id, noted.id, hasTask.id].includes(id)), 'old, closed, waiting, answered, noted and already-queued conversations are left alone');
  assert.deepEqual(ids(await pending()).filter(id => made.includes(id)), [text.id, followUp.id, quiet.id], 'oldest message first');
  assert.equal((await pending(90, 72, null, 1)).length, 1, 'the limit applies');
  assert.deepEqual(ids(await pending(90, 72, [])).filter(id => made.includes(id)), [], 'an empty channel list watches nothing');
  await admin.query("delete from private.agent_tasks where request_key like 'concierge:%'");

  // ---- A snapshot is minimal ----------------------------------------------------------------------------------------------
  assert.equal(await snapshot(randomUUID()), null, 'a conversation that does not exist is null, not an error');
  const rich = await conversation({ messages: [{ ago: 30, body: 'First question', direction: 'inbound' }, { ago: 28, direction: 'note', body: secrets.note }, { ago: 25, direction: 'outbound', body: 'Our answer', requestKey: randomUUID() }, { ago: 5, body: `${secrets.body} ${'x'.repeat(300)}` }] });
  const full = await snapshot(rich.id, null, 10, 200);
  assert.deepEqual(Object.keys(full).sort(), ['answered', 'canEmail', 'canText', 'channel', 'createdAt', 'headMessageId', 'id', 'inboundCount', 'inquiryType', 'latestInboundId', 'messages', 'outboundCount', 'productSlug', 'reference', 'status', 'subject', 'updatedAt']);
  const serialized = JSON.stringify(full);
  for (const secret of [secrets.name, secrets.email, secrets.phone, secrets.organization, secrets.note]) assert.ok(!serialized.includes(secret), `the snapshot never carries ${secret.slice(0, 8)}…`);
  assert.deepEqual([full.canEmail, full.canText, full.productSlug, full.subject, full.answered], [true, true, 'carebase', 'A question', false]);
  assert.deepEqual(full.messages.map(message => message.direction), ['inbound', 'outbound', 'inbound'], 'the thread has no notes, oldest first');
  assert.equal(full.messages[2].body.length, 200, 'a body is clipped to the length asked for');
  assert.equal(full.messages[2].body.startsWith(secrets.body), true);
  assert.deepEqual([full.latestInboundId, full.headMessageId], [rich.messages[3], rich.messages[3]]);
  assert.deepEqual([full.inboundCount, full.outboundCount], [2, 1], 'the counts ignore internal notes');
  assert.deepEqual((await snapshot(rich.id, null, 1, 200)).messages.map(message => message.id), [rich.messages[3]], 'only the newest message when one is asked for');
  assert.deepEqual((await snapshot(rich.id, null, 0, 200)).messages, [], 'heads only when none are asked for');
  const aside = await conversation({ messages: [{ ago: 10 }, { ago: 5, direction: 'outbound', requestKey: randomUUID() }] });
  const sentKey = (await row("select request_key from private.communication_messages where id = $1", [aside.messages[1]])).request_key;
  const sentSnapshot = await snapshot(aside.id, null, 0, 200);
  assert.deepEqual([sentSnapshot.headMessageId, sentSnapshot.latestInboundId, sentSnapshot.answered], [aside.messages[1], aside.messages[0], true], 'a reply is the head and answers the message');
  assert.deepEqual([(await snapshot(aside.id, sentKey, 0, 200)).headMessageId], [aside.messages[0]], 'the head ignores the reply sent under the key it is asked about');
  assert.equal((await snapshot(aside.id, randomUUID(), 0, 200)).headMessageId, aside.messages[1], 'and only that key');
  const phoneLine = await conversation({ channel: 'phone', product: 'breathe', subject: `Billing call from ${secrets.name}`, messages: [{ ago: 5 }] });
  const textLine = await conversation({ channel: 'sms', subject: `Text message from ${secrets.phone}`, messages: [{ ago: 5 }] });
  const noContact = await conversation({ channel: 'web_form', product: 'advisors', subject: 'Consultation request from someone', contact: false, messages: [{ ago: 5 }] });
  assert.equal((await snapshot(phoneLine.id)).subject, null, 'the subject of a phone-line message names the caller, so it is withheld');
  assert.equal((await snapshot(textLine.id)).subject, null, 'a text message\'s subject carries the number, so it is withheld');
  assert.deepEqual([(await snapshot(noContact.id)).canEmail, (await snapshot(noContact.id)).canText, (await snapshot(noContact.id)).productSlug], [false, false, 'advisors']);

  // ---- Counting alerts ----------------------------------------------------------------------------------------------------
  const begin = (key, channel, severity = 'info') => call('private.agent_notify_begin', [channel, severity, 'Counted', 'Body', key, 'support_concierge', null]);
  for (const [key, channel] of [[`concierge:count:${run}:1`, 'email'], [`concierge:count:${run}:2`, 'email'], [`concierge:count:${run}:2`, 'sms'], [`concierge:other:${run}:1`, 'email']]) await begin(key, channel);
  const suppressed = await begin(`concierge:count:${run}:3`, 'sms');
  await call('private.agent_notify_finish', [suppressed.id, 'suppressed', null]);
  const hourAgo = minutesAgo(60);
  assert.equal(await call('private.agent_notification_count', [`concierge:count:${run}:`, 'email', hourAgo]), 2);
  assert.equal(await call('private.agent_notification_count', [`concierge:count:${run}:`, 'sms', hourAgo]), 1, 'an alert that was never sent does not count');
  assert.equal(await call('private.agent_notification_count', [`concierge:count:${run}:`, null, hourAgo]), 3);
  assert.equal(await call('private.agent_notification_count', [`concierge:count:${run}:`, 'email', new Date(Date.now() + 60_000)]), 0, 'only alerts since the time');
  await admin.query("delete from private.owner_notifications where dedupe_key like $1", [`concierge:%:${run}:%`]);

  // ---- The whole flow, through the real store, queue and notifier -----------------------------------------------------------
  await clearWork();
  await admin.query("delete from private.agent_tasks where request_key like 'concierge:%'");
  for (const id of made) await admin.query("update private.communications set status = 'closed' where id = $1", [id]);
  await admin.query("update private.agents set status = 'active' where key = 'support_concierge'");
  await admin.query("update private.agent_schedules set next_run_at = now() + interval '1 day', enabled = true");
  const mail = [];
  const texts = [];
  const logs = [];
  const team = agentTeam({
    pool, enabled: true, ownerEmail: 'owner@example.test', publicOrigin: 'https://hub.test', log: line => logs.push(line), features: new Set(features),
    sms: { configured: true, send: async (to, body) => { texts.push([to, body]); return { delivery: 'sent', id: 'SM' + '0'.repeat(32) }; } },
    email: { configured: true, send: async (to, subject, content) => { mail.push([to, subject, content]); return { delivery: 'sent', id: 'fixture-message' }; } },
  });
  assert.ok(['concierge.sweep', 'concierge.communication'].every(kind => team.scheduler.kinds().includes(kind)));
  const flow = {
    ordinary: await conversation({ messages: [{ ago: 6, body: `How do I export the staff roster by month? ${canary}` }] }),
    outage: await conversation({ channel: 'chat', status: 'open', messages: [{ ago: 6, body: `Everything is down for every user. ${canary}` }] }),
    billing: await conversation({ messages: [{ ago: 6, body: `We were charged twice this month. ${canary}` }] }),
    identifiers: await conversation({ messages: [{ ago: 6, body: `Resident A. Sample, DOB 01/01/1900, SSN 000-12-3456 ${canary}` }] }),
    lead: await conversation({ channel: 'web_form', product: 'advisors', contact: true, subject: 'Consultation request', messages: [{ ago: 6, body: `We run 12 ALFs and are interested in consulting. ${canary}` }] }),
    autoReply: await conversation({ messages: [{ ago: 6, body: 'Automatic reply: I am out of the office until Monday.' }] }),
    superseded: await conversation({ messages: [{ ago: 6, body: `First message ${canary}` }] }),
    handled: await conversation({ messages: [{ ago: 6, body: `Please help ${canary}` }] }),
  };
  await admin.query("update private.agent_schedules set next_run_at = now() - interval '2 minutes' where task_kind = 'concierge.sweep'");
  let tick = await team.tick();
  assert.deepEqual([tick.fired, tick.claimed], [1, 1], 'the schedule fires the sweep');
  const sweepTask = await row("select * from private.agent_tasks where kind = 'concierge.sweep' order by created_at desc limit 1");
  assert.equal(sweepTask.status, 'done');
  assert.deepEqual(sweepTask.result, { pending: 8, enqueued: 8 }, `eight settled, unanswered conversations (${logs.join(' | ')})`);
  const queued = await rows("select * from private.agent_tasks where kind = 'concierge.communication' order by created_at");
  assert.equal(queued.length, 8);
  assert.ok(queued.every(task => task.source_kind === 'communication' && /^CM-\d+$/.test(task.source_ref) && task.request_key.startsWith('concierge:')));
  assert.deepEqual(Object.keys(queued[0].payload).sort(), ['communicationId', 'messageId'], 'a task carries two ids and nothing else');

  // A newer message arrives for one (already settled by the next sweep), and a person answers another, before triage reaches them.
  const newer = await row(`insert into private.communication_messages(communication_id, direction, body, delivery, created_at) values ($1, 'inbound', 'Second message', 'received', now() - interval '5 minutes') returning id`, [flow.superseded.id]);
  await admin.query(`insert into private.communication_messages(communication_id, direction, body, delivery, delivery_channel, request_key, created_at) values ($1, 'outbound', 'Answered by hand', 'sent', 'email', gen_random_uuid(), now() - interval '2 minutes')`, [flow.handled.id]);
  // The sweep runs again: it finds the newer message, which gets a task of its own, and nothing it already queued.
  await admin.query("update private.agent_schedules set next_run_at = now() - interval '3 minutes' where task_kind = 'concierge.sweep'");
  for (let index = 0; index < 5; index += 1) tick = await team.tick();
  const triage = await rows("select source_ref, request_key, result, status from private.agent_tasks where kind = 'concierge.communication' order by created_at");
  assert.equal(triage.length, 9, 'eight conversations, and the newer message of one of them');
  assert.ok(triage.every(entry => entry.status === (entry.result.reply === 'proposed' ? 'awaiting_approval' : 'done')), 'every triage task finished, and one with a proposed reply waits for the owner');
  const results = Object.fromEntries(triage.map(entry => [entry.source_ref, entry]));
  const outcomeOf = conversationFixture => results[`CM-${conversationFixture.reference}`];
  assert.deepEqual(outcomeOf(flow.ordinary).result, { outcome: 'alerted', reference: flow.ordinary.reference, channel: 'email', product: 'carebase', category: 'general', phi: false, severity: 'info', delivery: ['email:sent'], reply: 'proposed', template: 'standard', screen: [], rules: [] });
  assert.deepEqual([outcomeOf(flow.outage).result.category, outcomeOf(flow.outage).result.severity, outcomeOf(flow.outage).result.delivery], ['outage', 'urgent', ['sms:sent', 'email:sent']]);
  assert.deepEqual([outcomeOf(flow.billing).result.category, outcomeOf(flow.billing).result.severity], ['billing', 'warning']);
  assert.deepEqual([outcomeOf(flow.identifiers).result.phi, outcomeOf(flow.identifiers).result.screen, outcomeOf(flow.identifiers).result.severity, outcomeOf(flow.identifiers).result.template], [true, ['ssn', 'dob'], 'warning', 'phi']);
  assert.deepEqual([flow.outage, flow.billing, flow.lead].map(entry => outcomeOf(entry).result.reply), ['owner_only', 'owner_only', 'owner_only'], 'the owner answers an outage, billing and a sales lead personally');
  assert.deepEqual([outcomeOf(flow.lead).result.category, outcomeOf(flow.lead).result.product], ['sales', 'advisors']);
  assert.deepEqual(outcomeOf(flow.autoReply).result, { outcome: 'skipped', reason: 'auto_reply', reference: flow.autoReply.reference });
  assert.deepEqual(outcomeOf(flow.handled).result, { outcome: 'skipped', reason: 'answered', reference: flow.handled.reference }, 'a conversation a person answered is left alone');
  const supersededTasks = triage.filter(entry => entry.source_ref === `CM-${flow.superseded.reference}`);
  assert.equal(supersededTasks.length, 2, 'one task for each message of the conversation');
  assert.deepEqual(supersededTasks[0].result, { outcome: 'skipped', reason: 'superseded', reference: flow.superseded.reference }, 'the first message was superseded by the newer one');
  assert.deepEqual([supersededTasks[1].request_key, supersededTasks[1].result.outcome], [`concierge:${newer.id}`, 'alerted'], 'and the newer message was triaged on its own');

  // What the owner was told: by whom, how, and in what words.
  const subjects = mail.map(entry => entry[1]);
  assert.ok(subjects.includes(`New email: CM-${flow.ordinary.reference} for CareBase`));
  assert.ok(subjects.includes(`Urgent: possible outage report (CM-${flow.outage.reference}, chat)`));
  assert.ok(subjects.includes(`New email: CM-${flow.billing.reference} for CareBase, billing question`));
  assert.ok(subjects.includes(`New email: CM-${flow.identifiers.reference} for CareBase, personal identifiers`));
  assert.ok(subjects.includes(`New web form message: CM-${flow.lead.reference} for Healthcare Advisors, sales or consulting inquiry`));
  assert.equal(texts.length, 1, 'only the outage was texted');
  assert.match(texts[0][1], new RegExp(`^CareMetric: Urgent: possible outage report \\(CM-${flow.outage.reference}, chat\\)\\.`));
  assert.ok(!subjects.some(subject => subject.includes(String(flow.autoReply.reference))), 'an automatic reply is not announced');
  assert.equal((await rows("select * from private.agent_runs where agent_key = 'support_concierge' and prompt_version = 'rules.1'")).every(entry => entry.model === 'none' && entry.outcome === 'completed' && Number(entry.cost_cents) === 0), true);
  assert.equal((await rows("select * from private.agent_runs where agent_key = 'support_concierge' and prompt_version = 'rules.1'")).length, 6, 'a run for each message that was triaged, none for the three skipped');

  // Every sweep uses a scheduled instant no other sweep used (a firing is keyed by its instant to the second).
  // Running everything again changes nothing: the sweep finds nothing new and an alert is never sent twice.
  const before = [mail.length, texts.length];
  await admin.query("update private.agent_schedules set next_run_at = now() - interval '4 minutes' where task_kind = 'concierge.sweep'");
  for (let index = 0; index < 3; index += 1) await team.tick();
  assert.deepEqual([mail.length, texts.length], before, 'no alert is repeated');
  assert.equal((await row("select result from private.agent_tasks where kind = 'concierge.sweep' order by created_at desc limit 1")).result.enqueued, 0, 'and nothing is queued twice');

  // The twenty-first alert of a level in a day becomes one rollup email.
  for (let index = 0; index < 20; index += 1) await begin(`concierge:new:cap${run}:${index}`, 'email');
  const capped = await conversation({ messages: [{ ago: 6, body: `Another question ${canary}` }] });
  await admin.query("update private.agent_schedules set next_run_at = now() - interval '5 minutes' where task_kind = 'concierge.sweep'");
  for (let index = 0; index < 3; index += 1) await team.tick();
  assert.equal((await row("select result from private.agent_tasks where source_ref = $1", [`CM-${capped.reference}`])).result.delivery[0], 'email:sent');
  assert.ok(mail.some(entry => entry[1] === 'Many new messages today'), 'the rollup was emailed');
  assert.ok(!mail.some(entry => entry[1] === `New email: CM-${capped.reference} for CareBase`), 'and the twenty-first was not emailed on its own');

  // Nothing the customer wrote left the conversation table: not in a task, a run, an alert, the audit log, a log line or an email.
  const everything = JSON.stringify([
    await rows('select to_jsonb(t) as r from private.agent_tasks t'), await rows('select to_jsonb(r) as r from private.agent_runs r'),
    await rows('select to_jsonb(a) as r from private.agent_actions a'), await rows('select to_jsonb(n) as r from private.owner_notifications n'),
    await rows("select metadata from private.audit_events where action like 'agent.%'"), logs, mail, texts,
  ]);
  for (const secret of [canary, secrets.name, secrets.email, secrets.phone, secrets.organization, secrets.note, 'Resident A. Sample', '000-12-3456', '01/01/1900']) {
    assert.ok(!everything.includes(secret), `${secret.slice(0, 12)}… appears in no task, run, alert, audit event, log line or email`);
  }

  // A schedule for the sweep with no feature declared stays untouched.
  const bare = agentTeam({ pool, enabled: true, publicOrigin: 'https://hub.test', features: new Set(['platform.agents.v1']), log: () => {} });
  assert.ok(!bare.scheduler.kinds().includes('concierge.sweep'), 'a server whose database lacks the feature does not run the sweep');
  await clearWork();

  // ---- Approved replies: sent as the owner, once, into the thread they were written for ------------------------------------------
  await clearWork();
  await admin.query("update private.agent_schedules set next_run_at = now() + interval '1 day'");
  const outbox = [];
  let customerEmail = { delivery: 'sent', id: 'fixture-reply' };
  const emailSender = { configured: true, send: async (to, subject, content) => { outbox.push([to, subject, content]); return to === 'owner@example.test' ? { delivery: 'sent', id: 'fixture-alert' } : customerEmail; } };
  const textSender = { configured: true, send: async () => ({ delivery: 'sent', id: `SM${'2'.repeat(32)}` }) };
  const messaging = communications({ pool, delegations: {}, publicOrigin: 'https://hub.test', chatEnabled: true, sms: textSender, email: emailSender });
  const replyTeam = agentTeam({ pool, enabled: true, ownerEmail: 'owner@example.test', publicOrigin: 'https://hub.test', log: line => logs.push(line), features: new Set(features), sms: textSender, email: emailSender, communications: messaging });
  const toCustomers = () => outbox.filter(entry => entry[0] !== 'owner@example.test');
  let sweepMinutes = 10;
  // Every sweep needs a scheduled instant no other sweep used (a firing is keyed by its instant to the second).
  const sweepAndTriage = async () => {
    await admin.query(`update private.agent_schedules set next_run_at = now() - interval '${sweepMinutes} minutes' where task_kind = 'concierge.sweep'`);
    sweepMinutes += 1;
    for (let index = 0; index < 6; index += 1) await replyTeam.tick();
  };
  const reached = async (id, statuses, table = 'private.agent_actions', timeout = 5000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { const current = await row(`select * from ${table} where id = $1`, [id]); if (statuses.includes(current.status)) return current; await new Promise(resolve => setTimeout(resolve, 25)); }
    assert.fail(`${id} never reached ${statuses.join(' or ')}`);
  };
  const proposalFor = async fixture => row("select * from private.agent_actions where target_id = $1 and kind = 'communication.reply' order by created_at desc limit 1", [`CM-${fixture.reference}`]);
  const ackText = 'Hello,\n\nThank you for contacting CareMetric Support. We have your message and a member of our team will review it and reply here.';
  const reply = {
    ok: await conversation({ messages: [{ ago: 6, body: `How do I export the staff roster by month? ${canary}` }] }),
    moved: await conversation({ messages: [{ ago: 6, body: `Can you add a second administrator? ${canary}` }] }),
    closes: await conversation({ messages: [{ ago: 6, body: `Where is the export button? ${canary}` }] }),
    phi: await conversation({ messages: [{ ago: 6, body: `Resident A. Sample, SSN 000-12-3456, cannot be found. ${canary}` }] }),
    follow: await conversation({ messages: [{ ago: 30, body: 'First question' }, { ago: 20, direction: 'outbound', body: 'We answered by hand', requestKey: randomUUID() }, { ago: 6, body: `Thanks, one more thing ${canary}` }] }),
  };
  await sweepAndTriage();
  const proposals = Object.fromEntries(await Promise.all(Object.entries(reply).map(async ([name, fixture]) => [name, await proposalFor(fixture)])));
  assert.equal(proposals.follow, undefined, 'a follow-up in a thread the team already joined is not acknowledged');
  assert.equal((await row("select result from private.agent_tasks where source_ref = $1 and kind = 'concierge.communication'", [`CM-${reply.follow.reference}`])).result.reply, 'follow_up');
  const okInput = proposals.ok.input;
  assert.deepEqual([proposals.ok.status, proposals.ok.preview === okInput.body, okInput.body, okInput.template, okInput.basedOnMessageId, okInput.route], ['proposed', true, ackText, 'standard', reply.ok.messages[0], 'email'], 'the preview is the exact text, written from the template');
  assert.equal(proposals.phi.input.template, 'phi');
  assert.match(proposals.phi.preview, /not set up to receive patient or resident information/);
  assert.ok(!JSON.stringify(proposals).includes('000-12-3456') && !JSON.stringify(proposals).includes(canary), 'a proposal repeats nothing the customer wrote');
  assert.equal((await replyTeam.actions.sessionActions()).length, 0, 'nothing is approved yet');

  // Approving sends it once, as the owner, in the conversation it was written for.
  const mailBefore = toCustomers().length;
  assert.deepEqual(await replyTeam.admin.decide(ownerToken, { actionId: proposals.ok.id, decision: 'approve' }), { id: proposals.ok.id, kind: 'communication.reply', status: 'executed', decided: true });
  assert.equal(toCustomers().length, mailBefore + 1);
  const [to, subject, content] = toCustomers().at(-1);
  assert.deepEqual([to, subject.endsWith(`[CM-${reply.ok.reference}]`), content.text.includes('We have your message and a member of our team will review it')], [secrets.email, true, true]);
  assert.ok(!/\bAI\b|assistant/i.test(content.text), 'the reply says nothing about AI');
  const sentRow = await row("select m.*, c.status as conversation_status from private.communication_messages m join private.communications c on c.id = m.communication_id where m.communication_id = $1 and m.direction = 'outbound'", [reply.ok.id]);
  assert.deepEqual([sentRow.body, sentRow.delivery, sentRow.delivery_channel, sentRow.request_key, sentRow.author_id, sentRow.conversation_status], [ackText, 'sent', 'email', proposals.ok.request_key, owner, 'waiting'], 'recorded under the action\'s own key, authored by the owner');
  const executed = await action(proposals.ok.id);
  assert.deepEqual([executed.status, executed.result], ['executed', { delivery: 'sent', channel: 'email', replay: false }]);
  assert.equal((await row('select status from private.agent_tasks where id = $1', [proposals.ok.task_id])).status, 'done', 'the task closes once its proposal is settled');
  assert.equal((await replyTeam.admin.decide(ownerToken, { actionId: proposals.ok.id, decision: 'approve' })).decided, false, 'deciding twice changes nothing');
  assert.equal(toCustomers().length, mailBefore + 1, 'and sends nothing');
  assert.ok((await auditFor('communication.reply', reply.ok.id)).length === 1 && (await auditFor('agent.action.executed', proposals.ok.id)).length === 1, 'one audit event for the reply and one for the execution');

  // The identifier notice goes out the same way, and repeats nothing.
  assert.equal((await replyTeam.admin.decide(ownerToken, { actionId: proposals.phi.id, decision: 'approve' })).status, 'executed');
  const phiMail = toCustomers().at(-1)[2].text;
  assert.match(phiMail, /not set up to receive patient or resident information/);
  assert.ok(!phiMail.includes('000-12-3456') && !phiMail.includes('Sample') && !phiMail.includes(canary), 'the notice repeats nothing');

  // A conversation that moved on, or was closed, is never answered with a reply written for an earlier moment.
  await admin.query(`insert into private.communication_messages(communication_id, direction, body, delivery, created_at) values ($1, 'inbound', 'Actually, never mind. Also...', 'received', now() - interval '1 minute')`, [reply.moved.id]);
  await admin.query("update private.communications set status = 'closed' where id = $1", [reply.closes.id]);
  const sentSoFar = toCustomers().length;
  assert.deepEqual(await replyTeam.admin.decide(ownerToken, { actionId: proposals.moved.id, decision: 'approve' }), { id: proposals.moved.id, kind: 'communication.reply', status: 'failed', decided: true, error: 'thread_changed' });
  assert.deepEqual(await replyTeam.admin.decide(ownerToken, { actionId: proposals.closes.id, decision: 'approve' }), { id: proposals.closes.id, kind: 'communication.reply', status: 'failed', decided: true, error: 'conversation_closed' });
  assert.equal(toCustomers().length, sentSoFar, 'nothing was sent');
  assert.equal(Number((await row("select count(*) from private.communication_messages where communication_id = any($1) and direction = 'outbound'", [[reply.moved.id, reply.closes.id]])).count), 0, 'and nothing was recorded');
  assert.deepEqual((await action(proposals.moved.id)).result, { error: 'thread_changed' });

  // An approval the server could not carry out waits for the owner's session; the tick never sends it, and a lapsed session cannot.
  const late = await conversation({ messages: [{ ago: 6, body: `Please help ${canary}` }] });
  await sweepAndTriage();
  const lateProposal = await proposalFor(late);
  assert.equal((await ownerCall('hub.decide_agent_action', [lateProposal.id, 'approve', null])).status, 'approved', 'the database holds the approval; nothing has been sent');
  const tickAfter = await replyTeam.tick();
  assert.equal(tickAfter.executedActions, 0, 'the tick leaves a reply that needs the owner\'s session');
  assert.equal((await action(lateProposal.id)).status, 'approved');
  assert.equal((await replyTeam.admin.overview(ownerToken, {})).waitingActions, 1, 'the owner\'s screen says one approved reply is waiting');
  await assert.rejects(replyTeam.admin.waiting(staleToken, {}), error => error.status === 401, 'a lapsed session sends nothing');
  assert.equal((await action(lateProposal.id)).status, 'approved');
  const lateMail = toCustomers().length;
  assert.deepEqual(await replyTeam.admin.waiting(ownerToken, {}), { started: 0, actions: 1 });
  await reached(lateProposal.id, ['executed']);
  assert.equal(toCustomers().length, lateMail + 1, 'pressing the button sent it');
  assert.equal((await replyTeam.admin.overview(ownerToken, {})).waitingActions, 0);

  // A send that did not go through is reported with its code, never retried, never recorded as sent; an unconfirmed one warns the owner.
  const refusedConv = await conversation({ messages: [{ ago: 6, body: `Hello ${canary}` }] });
  const unknownConv = await conversation({ messages: [{ ago: 6, body: `Hello again ${canary}` }] });
  await sweepAndTriage();
  customerEmail = { delivery: 'failed', id: null };
  const failed = await replyTeam.admin.decide(ownerToken, { actionId: (await proposalFor(refusedConv)).id, decision: 'approve' });
  assert.deepEqual([failed.status, failed.error], ['failed', 'delivery_failed']);
  assert.equal((await row("select delivery from private.communication_messages where communication_id = $1 and direction = 'outbound'", [refusedConv.id])).delivery, 'failed');
  customerEmail = { delivery: 'unknown', id: null };
  const alertsBefore = outbox.filter(entry => entry[0] === 'owner@example.test').length;
  const unknown = await replyTeam.admin.decide(ownerToken, { actionId: (await proposalFor(unknownConv)).id, decision: 'approve' });
  assert.deepEqual([unknown.status, unknown.error], ['failed', 'delivery_unknown']);
  assert.equal((await row("select delivery from private.communication_messages where communication_id = $1 and direction = 'outbound'", [unknownConv.id])).delivery, 'unknown');
  assert.ok(outbox.filter(entry => entry[0] === 'owner@example.test').slice(alertsBefore).some(entry => entry[1] === `Check CM-${unknownConv.reference} before sending again`), 'the owner is told to look at the thread');
  customerEmail = { delivery: 'sent', id: 'fixture-reply' };

  // An agent trusted to act still never sends a reply on its own: the executor refuses one nobody approved.
  await admin.query(`update private.agents set autonomy = 'act', config = config || '{"auto_approve_kinds": ["communication.reply"]}'::jsonb where key = 'support_concierge'`);
  const auto = await conversation({ messages: [{ ago: 6, body: `Hello once more ${canary}` }] });
  await sweepAndTriage();
  const autoProposal = await proposalFor(auto);
  assert.equal(autoProposal.status, 'auto_approved');
  assert.equal((await action(autoProposal.id)).status, 'auto_approved', 'the tick does not send it');
  const autoMail = toCustomers().length;
  assert.deepEqual(await replyTeam.admin.waiting(ownerToken, {}), { started: 0, actions: 1 });
  const refusedAuto = await reached(autoProposal.id, ['failed']);
  assert.deepEqual(refusedAuto.result, { error: 'auto_approved_refused' });
  assert.equal(toCustomers().length, autoMail, 'nothing was sent');
  await admin.query(`update private.agents set autonomy = 'propose', config = config || '{"auto_approve_kinds": []}'::jsonb where key = 'support_concierge'`);

  // Still nothing the customer wrote is anywhere but the conversation: not in a task, action, run, alert, audit event or log line.
  const afterReplies = JSON.stringify([
    await rows('select to_jsonb(t) as r from private.agent_tasks t'), await rows('select to_jsonb(r) as r from private.agent_runs r'),
    await rows('select to_jsonb(a) as r from private.agent_actions a'), await rows('select to_jsonb(n) as r from private.owner_notifications n'),
    await rows("select metadata from private.audit_events where action like 'agent.%' or action = 'communication.reply'"), logs,
  ]);
  for (const secret of [canary, secrets.name, secrets.email, secrets.phone, secrets.organization, secrets.note, 'Resident A. Sample', '000-12-3456', ownerToken, staleToken]) {
    assert.ok(!afterReplies.includes(secret), `${secret.slice(0, 12)}… appears in no task, action, run, alert, audit event or log line`);
  }
  await clearWork();

  // ---- The deployment gate re-runs cleanly, and refuses to declare the feature once the boundary drifts -----------------------
  const client = await admin.connect();
  try {
    await client.query('begin');
    await client.query(gate);
    await client.query('rollback');
    for (const [sql, message] of [
      ['revoke execute on function private.agent_concierge_pending(integer,integer,integer,text[]) from hub_app_server', /executable by the Hub server only/],
      ['grant execute on function private.agent_communication_snapshot(uuid,uuid,integer,integer) to authenticated', /executable by the Hub server only/],
      ['grant execute on function private.agent_notification_count(text,text,timestamptz) to anon', /executable by the Hub server only/],
      ['alter function private.agent_notification_count(text,text,timestamptz) security invoker', /security definers/],
      ['alter function private.agent_concierge_pending(integer,integer,integer,text[]) reset search_path', /security definers/],
      ["delete from private.agent_schedules where agent_key = 'support_concierge' and task_kind = 'concierge.sweep'", /sweep schedule must exist/],
      ["delete from private.owner_notifications where agent_key = 'support_concierge'; delete from private.agent_actions where agent_key = 'support_concierge'; delete from private.agent_runs where agent_key = 'support_concierge'; delete from private.agent_tasks where agent_key = 'support_concierge'; delete from private.agent_schedules where agent_key = 'support_concierge'; delete from private.agents where key = 'support_concierge'", /agent must exist/],
    ]) {
      await client.query('begin');
      try {
        await client.query(sql);
        await assert.rejects(client.query(gate), rejection => rejection.code === '55000' && message.test(rejection.message), sql);
      } finally { await client.query('rollback'); }
    }
  } finally { client.release(); }

  console.log('Support Concierge: the three server-only operations (pending conversations, minimal snapshots, alert counts), the sweep, rule-based triage with its identifier screen, the owner alerts and their caps, the approved replies sent once as the owner into the thread they were written for, the privacy of every stored record, and the deployment gate all behave through hub_app_server.');
} finally {
  await admin.query("delete from private.audit_events where action like 'agent.%' or actor_id = $1", [owner]);
  await admin.query('delete from private.agent_actions');
  await admin.query('delete from private.agent_runs');
  await admin.query('delete from private.owner_notifications');
  await admin.query('delete from private.agent_tasks');
  if (made.length) await admin.query('delete from private.communications where id = any($1::uuid[])', [made]);
  for (const seed of seedAgents) await admin.query('update private.agents set status=$2, autonomy=$3, daily_budget_cents=$4, config=$5, updated_at=$6 where key=$1', [seed.key, seed.status, seed.autonomy, seed.daily_budget_cents, seed.config, seed.updated_at]);
  for (const seed of seedSchedules) await admin.query('update private.agent_schedules set next_run_at=$2, last_run_at=$3, last_task_id=$4, enabled=$5 where id=$1', [seed.id, seed.next_run_at, seed.last_run_at, seed.last_task_id, seed.enabled]);
  if (setAside.length) await admin.query('update private.staff_permissions set revoked_at = null where id = any($1::uuid[])', [setAside]);
  if (foreign.length) await admin.query('update private.communications c set status = r.status from jsonb_to_recordset($1::jsonb) as r(id uuid, status text) where c.id = r.id', [JSON.stringify(foreign)]);
  await admin.query('delete from private.sms_sessions where user_id = $1', [owner]);
  await admin.query('delete from private.sms_identities where user_id = $1', [owner]);
  await admin.query('delete from private.staff_permissions where user_id = $1', [owner]);
  await admin.query('delete from hub.profiles where id = $1', [owner]);
  await admin.query('delete from auth.users where id = $1', [owner]);
  await pool.end();
  await admin.end();
}
