// The end-of-day summary through the real roles (20261118120000_owner_summary.sql): the notifier holds news and approval requests for the
// summary instead of emailing them and finds a held message again on a repeat; only a pending email that is not urgent can be held, and
// only a held row says why; the summary's facts count the window's conversations and replies, list what was held and what went at once
// (never the summary or the brief themselves), and are the Hub server's alone, at most eight days; a scheduled summary sends one email
// that lists them; and the gate refuses drift. Disposable loopback database only; no email or text is sent.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { sqlAgentStore } from './agents/store.mjs';
import { ownerNotifier } from './agents/notify.mjs';
import { summaryFeature, summaryHandlers } from './agents/tasks/summary.mjs';

const databaseUrl = process.env.HUB_TEST_DATABASE_URL;
const local = new URL(databaseUrl);
assert.equal(local.hostname, '127.0.0.1'); assert.equal(local.port, '54322');
const admin = new pg.Pool({ connectionString: databaseUrl });
await admin.query("alter role hub_app_server login password 'ephemeral-test-only'");
const appUrl = new URL(databaseUrl); appUrl.username = 'hub_app_server'; appUrl.password = 'ephemeral-test-only';
const pool = new pg.Pool({ connectionString: appUrl.href });
const store = sqlAgentStore(pool, { fenced: true, summary: true });
const run = randomUUID().slice(0, 8);
const prefix = `summary-it-${run}:`;
const refused = code => error => error?.code === code;
const row = async (sql, values = []) => (await admin.query(sql, values)).rows[0];
const gate = await readFile(new URL('../supabase/migrations/20261118120100_owner_summary_contract.sql', import.meta.url), 'utf8');
// A February day long ago, in its own window: 5 PM Eastern on Feb 3, 2001 is 22:00 UTC.
const since = new Date('2001-02-02T22:00:00Z'), until = new Date('2001-02-03T22:00:00Z'), inside = '2001-02-03T15:00:00Z';
const conversations = [], tasks = [];
const emails = [];
const email = { configured: true, send: async (to, subject, content) => { emails.push({ to, subject, content }); return { delivery: 'sent', id: `SG-${emails.length}` }; } };
const sms = { configured: false, send: async () => { throw new Error('No text is sent in this test.'); } };

try {
  assert.ok((await admin.query('select hub.get_backend_contract() as c')).rows[0].c.features.includes(summaryFeature));
  // The three settings exist: the summary on unless turned off, the hour and approvals right away unset.
  assert.deepEqual((await admin.query("select key, kind from private.hub_settings where key in ('agents.daily_summary','agents.summary_hour','agents.approvals_right_away') order by key")).rows,
    [{ key: 'agents.approvals_right_away', kind: 'flag' }, { key: 'agents.daily_summary', kind: 'flag' }, { key: 'agents.summary_hour', kind: 'number' }]);

  // News and approval requests are held; what cannot wait and anything urgent goes at once.
  const notifier = ownerNotifier({ store, sms, email, ownerEmail: 'owner@example.test', publicOrigin: 'https://hub.example.test', hold: attention => attention !== 'now', log: () => {} });
  const send = (key, extra) => notifier.send({ subject: `Subject ${key}`, body: `Body ${key}.`, dedupeKey: `${prefix}${key}`, agentKey: 'social_manager', ...extra });
  assert.deepEqual(await send('weekly', { severity: 'info', attention: 'update' }), [{ channel: 'email', delivery: 'held' }]);
  assert.deepEqual(await send('plan', { severity: 'info', attention: 'decision' }), [{ channel: 'email', delivery: 'held' }]);
  assert.deepEqual(await send('waiting', { severity: 'warning', attention: 'now' }), [{ channel: 'email', delivery: 'sent' }]);
  assert.deepEqual(await send('down', { severity: 'urgent', attention: 'update' }), [{ channel: 'sms', delivery: 'suppressed' }, { channel: 'email', delivery: 'sent' }]);
  assert.equal(emails.length, 2);
  // A repeat finds the held message and sends nothing.
  assert.deepEqual(await send('weekly', { severity: 'info', attention: 'update' }), [{ channel: 'email', delivery: 'duplicate', original: 'held' }]);
  assert.equal(emails.length, 2);
  const rows = (await admin.query('select dedupe_key, channel, status, attention from private.owner_notifications where dedupe_key like $1 order by dedupe_key, channel', [`${prefix}%`])).rows;
  assert.deepEqual(rows.map(item => [item.dedupe_key.slice(prefix.length), item.channel, item.status, item.attention]), [
    ['down', 'email', 'sent', null], ['down', 'sms', 'suppressed', null], ['plan', 'email', 'held', 'decision'], ['waiting', 'email', 'sent', null], ['weekly', 'email', 'held', 'update'],
  ]);

  // Only a pending email that is not urgent can be held; a held row says why, and no other row does.
  const pending = await row(`insert into private.owner_notifications(dedupe_key, channel, severity, subject, body) values ($1, 'email', 'urgent', 'Urgent', 'Body') returning id`, [`${prefix}urgent`]);
  await assert.rejects(store.notifyHold(pending.id, 'update'), refused('P0002'));
  const text = await row(`insert into private.owner_notifications(dedupe_key, channel, severity, subject, body) values ($1, 'sms', 'info', 'Text', 'Body') returning id`, [`${prefix}text`]);
  await assert.rejects(store.notifyHold(text.id, 'update'), refused('P0002'));
  const settled = await row('select id from private.owner_notifications where dedupe_key = $1 and channel = $2', [`${prefix}waiting`, 'email']);
  await assert.rejects(store.notifyHold(settled.id, 'update'), refused('P0002'));
  const fresh = await row(`insert into private.owner_notifications(dedupe_key, channel, severity, subject, body) values ($1, 'email', 'info', 'News', 'Body') returning id`, [`${prefix}fresh`]);
  await assert.rejects(store.notifyHold(fresh.id, 'now'), refused('22023'));
  await assert.rejects(admin.query("update private.owner_notifications set status = 'held' where id = $1", [fresh.id]), refused('23514'));
  await assert.rejects(admin.query("update private.owner_notifications set attention = 'update' where id = $1", [settled.id]), refused('23514'));
  assert.equal(await store.notifyHold(fresh.id, 'update'), 'held');
  await admin.query('delete from private.owner_notifications where id = any($1::uuid[])', [[pending.id, text.id, fresh.id]]);

  // Into a window of their own, with a conversation: two messages in, one reply sent, and one message outside the window.
  // Each at its own minute, in the order they were raised, so the summary's order is the day's order.
  for (const [key, at] of [['weekly', '2001-02-03T14:00:00Z'], ['plan', '2001-02-03T14:05:00Z'], ['waiting', '2001-02-03T14:10:00Z'], ['down', '2001-02-03T14:15:00Z']]) {
    await admin.query('update private.owner_notifications set created_at = $2 where dedupe_key = $1', [`${prefix}${key}`, at]);
  }
  const conversation = await row(`insert into private.communications(channel, source_system, source_key, product_id, status, subject, created_at, last_message_at)
    values ('email', 'hub.email', $1, (select id from hub.products where slug = 'carebase'), 'open', 'A question', $2, $3) returning id`, [`summary-${run}`, inside, '2001-02-04T15:00:00Z']);
  conversations.push(conversation.id);
  await admin.query(`insert into private.communication_messages(communication_id, direction, body, delivery, delivery_channel, created_at) values
    ($1, 'inbound', 'First', 'received', null, $2), ($1, 'inbound', 'Second', 'received', null, $2), ($1, 'outbound', 'Reply', 'sent', 'email', $2),
    ($1, 'inbound', 'Next day', 'received', null, '2001-02-04T15:00:00Z')`, [conversation.id, inside]);

  const facts = await store.summaryFacts({ since, until });
  assert.deepEqual(facts.inbound, { messages: 2, conversations: 1, newConversations: 1, byChannel: { email: 1 } });
  assert.deepEqual(facts.outbound, { messages: 1, conversations: 1 });
  // Its newest message came after the reply and has none: it still waits for an answer.
  assert.equal(facts.unanswered.count, 1);
  assert.equal(new Date(facts.unanswered.oldestAt).toISOString(), '2001-02-04T15:00:00.000Z');
  assert.equal(facts.notifications.heldCount, 2);
  assert.deepEqual(facts.notifications.held.map(item => [item.subject, item.attention, item.name]),
    [['Subject weekly', 'update', 'Social Media Manager'], ['Subject plan', 'decision', 'Social Media Manager']]);
  assert.deepEqual(facts.notifications.sent.map(item => item.subject).sort(), ['Subject down', 'Subject waiting']);
  assert.equal(facts.notifications.sentCount, 2);
  for (const key of ['day', 'work', 'executed', 'waiting']) assert.ok(key in facts, key);

  // The Hub server's alone, and never more than eight days.
  await assert.rejects(store.summaryFacts({ since: new Date('2001-01-01T00:00:00Z'), until }), refused('22023'));
  await assert.rejects(store.summaryFacts({ since: until, until: since }), refused('22023'));
  await assert.rejects(admin.query('select private.agent_summary_facts($1, $2)', [since, until]), refused('42501'));
  for (const role of ['anon', 'authenticated', 'service_role']) {
    for (const fn of ['private.agent_summary_facts(timestamptz,timestamptz)', 'private.agent_notify_hold(uuid,text)', 'private.agent_summary_cutoff()', 'private.agent_summary_ready()']) {
      assert.equal((await row('select has_function_privilege($1, $2, \'execute\') as ok', [role, fn])).ok, false, `${role} ${fn}`);
    }
  }

  // A scheduled summary for that day, through the same notifier: one email that lists what was held, what went at once and what came in.
  const handlers = summaryHandlers({ store, notifier, publicOrigin: 'https://hub.example.test', features: new Set([summaryFeature]), settings: { enabled: () => true, hour: () => 17 }, log: () => {} });
  const requestKey = 'schedule:00000000-0000-4000-8000-000000000001:20010203T170000Z';
  const made = await row(`insert into private.agent_tasks(agent_key, kind, request_key, source_kind, status, attempts, claimed_at, lease_until)
    values ('chief_of_staff', 'summary.daily', $1, 'owner', 'running', 1, now(), now() + interval '10 minutes') returning id`, [`${requestKey}:${run}`]);
  tasks.push(made.id);
  const task = { id: made.id, agentKey: 'chief_of_staff', kind: 'summary.daily', sourceKind: 'schedule', requestKey, attempts: 1 };
  const early = await handlers['summary.daily'](task, { now: () => new Date('2001-02-03T17:00:10Z') });
  assert.equal(early.status, 'queued');
  assert.equal(early.retryAt.toISOString(), until.toISOString());
  const before = emails.length;
  const outcome = await handlers['summary.daily'](task, { now: () => new Date('2001-02-03T22:00:05Z') });
  assert.equal(outcome.result.held, 2);
  assert.equal(emails.length, before + 1);
  const summary = emails.at(-1);
  assert.match(summary.subject, /^CareMetric end of day, Sat, Feb 3: /);
  for (const words of ['Social Media Manager: Subject plan', 'Social Media Manager: Subject weekly', 'Subject waiting', 'Customer messages: 2 messages in 1 conversation (1 new): 1 email',
    'Replies sent from Communications: 1 message in 1 conversation']) assert.ok(summary.content.text.includes(words), words);
  assert.equal((await row("select status from private.owner_notifications where dedupe_key = 'summary:2001-02-03' and channel = 'email'")).status, 'sent');
  assert.match((await row('select summary from private.agent_runs where task_id = $1', [made.id])).summary, /^Sent the end-of-day summary: /);
  // Once the task is done with that result, the next summary starts where it ended.
  assert.equal(outcome.result.until, until.toISOString());
  await admin.query("update private.agent_tasks set status = 'done', finished_at = now(), source_kind = 'schedule', result = $2 where id = $1", [made.id, outcome.result]);
  assert.ok(new Date(await store.summaryCutoff()).getTime() >= until.getTime());

  // A summary will be sent only while the Chief of Staff is active and its summary scheduled; nothing is held otherwise.
  const chief = (await row("select status from private.agents where key = 'chief_of_staff'")).status;
  try {
    await admin.query("update private.agents set status = 'active' where key = 'chief_of_staff'");
    assert.equal(await store.summaryReady(), true);
    await admin.query("update private.agent_schedules set enabled = false where agent_key = 'chief_of_staff' and task_kind = 'summary.daily'");
    assert.equal(await store.summaryReady(), false);
    await admin.query("update private.agent_schedules set enabled = true where agent_key = 'chief_of_staff' and task_kind = 'summary.daily'");
    await admin.query("update private.agents set status = 'paused' where key = 'chief_of_staff'");
    assert.equal(await store.summaryReady(), false);
  } finally {
    await admin.query("update private.agents set status = $1 where key = 'chief_of_staff'", [chief]);
    await admin.query("update private.agent_schedules set enabled = true where agent_key = 'chief_of_staff' and task_kind = 'summary.daily'");
  }

  // The gate holds as applied and refuses a database where a held row need not say why.
  await admin.query(gate);
  const client = await admin.connect();
  try {
    await client.query('begin');
    await client.query('alter table private.owner_notifications drop constraint owner_notifications_held_attention');
    await assert.rejects(client.query(gate), refused('55000'));
  } finally {
    await client.query('rollback');
    client.release();
  }
  console.log('End-of-day summary: held, counted and sent through the real roles.');
} finally {
  await admin.query("delete from private.owner_notifications where dedupe_key like $1 or dedupe_key = 'summary:2001-02-03'", [`${prefix}%`]);
  if (conversations.length) await admin.query('delete from private.communications where id = any($1::uuid[])', [conversations]);
  if (tasks.length) await admin.query('delete from private.agent_tasks where id = any($1::uuid[])', [tasks]);
  await pool.end();
  await admin.end();
}
