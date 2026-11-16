// Support answers through the real roles: what the database admits as an answer, sending one without the owner's session (approved
// automatically or by the owner), and every refusal (the Concierge no longer trusted, a closed conversation, the customer writing
// again, no route). Disposable loopback database only; the email sender is a fake and nothing leaves the machine.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { digest, withSession } from './sms-auth.mjs';
import { communications } from './communications.mjs';
import { sqlAgentStore } from './agents/store.mjs';
import { actionExecutor } from './agents/actions.mjs';
import { conciergeExecutors } from './agents/concierge/index.mjs';
import { testPhones } from './test-phones.mjs';
const phones = testPhones(import.meta.url);

const databaseUrl = process.env.HUB_TEST_DATABASE_URL;
const local = new URL(databaseUrl);
assert.equal(local.hostname, '127.0.0.1'); assert.equal(local.port, '54322');
const admin = new pg.Pool({ connectionString: databaseUrl });
await admin.query("alter role hub_app_server login password 'ephemeral-test-only'");
const appUrl = new URL(databaseUrl); appUrl.username = 'hub_app_server'; appUrl.password = 'ephemeral-test-only';
const pool = new pg.Pool({ connectionString: appUrl.href });
const store = sqlAgentStore(pool, { fenced: true });
const run = randomUUID().slice(0, 8), owner = randomUUID(), token = `answers-${randomUUID()}`;
const aiAssistant = 'a1a00000-a1a0-4000-8000-000000000001';
const row = async (sql, values = []) => (await admin.query(sql, values)).rows[0];
const refused = code => error => error?.code === code;
const outbox = [];
const email = { configured: true, send: async (to, subject, content) => { outbox.push({ to, subject, text: content.text }); return { delivery: 'sent', id: `fixture-${outbox.length}` }; } };
const inbox = communications({ pool, delegations: {}, publicOrigin: 'https://hub.test', chatEnabled: true, sms: { configured: false }, email });
const notifier = { send: async () => [{ channel: 'email', delivery: 'sent' }] };
const features = new Set(['platform.agents.concierge.v1', 'platform.agents.concierge-autosend.v1']);
const actions = actionExecutor({ store, executors: conciergeExecutors({ communications: inbox, store, notifier, features, log: () => {} }), log: () => {} });
const seedConcierge = await row("select status, autonomy, config from private.agents where key = 'support_concierge'");
const made = [], tasks = [];

let counter = 0;
async function conversation({ channel = 'email', status = 'new' } = {}) {
  counter += 1;
  const created = await row(`insert into private.communications(channel, source_system, source_key, product_id, status, subject, contact_name, contact_email, chat_token_hash)
    values ($1, $2, $3, (select id from hub.products where slug = 'carebase'), $4, 'A question', 'Pat Example', $5, $6) returning id, reference`,
  [channel, channel === 'chat' ? 'hub.chat' : 'hub.email', `answers-${run}-${counter}`, status, channel === 'chat' ? null : `pat-${run}@example.test`, channel === 'chat' ? digest(`answers-${run}-${counter}`) : null]);
  made.push(created.id);
  const message = await row(`insert into private.communication_messages(communication_id, direction, body, delivery) values ($1, 'inbound', 'How do I export the roster?', 'received') returning id`, [created.id]);
  return { id: created.id, reference: Number(created.reference), head: message.id };
}
async function task() {
  const id = (await row("insert into private.agent_tasks(agent_key, kind, request_key, status, attempts, lease_until) values ('support_concierge', 'concierge.communication', $1, 'running', 1, now() + interval '10 minutes') returning id", [`answers:${run}:${randomUUID()}`])).id;
  tasks.push(id); return id;
}
const answerInput = (c, over = {}) => ({
  communicationId: c.id, reference: c.reference, channel: 'email', route: 'email', basedOnMessageId: c.head,
  body: 'Hello,\n\nOpen Reports, choose Staff roster and select Export.', classification: { category: 'general', phi: false, drafted: true },
  template: 'drafted', sources: ['Export the staff roster'], ...over,
});
const propose = async (c, over = {}) => store.proposeAction({ taskId: await task(), kind: 'communication.answer', targetKind: 'communication', targetId: `CM-${c.reference}`, preview: 'Hello', input: answerInput(c, over) });
const trust = async on => admin.query("update private.agents set status = 'active', autonomy = $1, config = jsonb_set(config, '{auto_approve_kinds}', $2::jsonb) where key = 'support_concierge'",
  [on ? 'act' : 'propose', on ? '["communication.answer"]' : '[]']);
const pgText = value => `'${value.replaceAll("'", "''")}'`;
const result = async id => (await row('select status, result from private.agent_actions where id = $1', [id]));

try {
  await admin.query('insert into auth.users(id,email,is_anonymous) values($1,$2,false)', [owner, `answers-owner-${run}@test.invalid`]);
  await admin.query("insert into private.staff_permissions(user_id,permission) values($1,'platform.admin')", [owner]);
  await admin.query('insert into private.sms_identities(user_id,phone_e164,verified_at) values($1,$2,now())', [owner, phones.owner]);
  await admin.query("insert into private.sms_sessions(id,token_hash,user_id,identity_version,expires_at) select $1,$2,user_id,identity_version,now()+interval '1 hour' from private.sms_identities where user_id=$3", [randomUUID(), digest(token), owner]);

  // What may be an answer at all: drafted, citing, no identifiers, by email or chat. Anything else is refused by the table.
  await trust(true);
  const shape = await conversation();
  for (const over of [{ template: 'standard' }, { classification: { category: 'general', phi: true, drafted: true } }, { sources: [] }, { route: 'sms' },
    { classification: { category: 'general', phi: false } }, { extra: 'x' }, { body: '' }]) {
    await assert.rejects(propose(shape, over), refused('23514'), JSON.stringify(over));
  }
  await assert.rejects(store.proposeAction({ taskId: await task(), kind: 'communication.answer', targetKind: 'communication', targetId: 'CM-1', preview: 'Hello', input: answerInput(shape) }), refused('23514'), 'the target must be its own conversation');

  // Trusted: approved on its own, sent by the tick's drain without any session, written by the AI assistant.
  const first = await conversation();
  const auto = await propose(first);
  assert.equal(auto.status, 'auto_approved');
  const drained = await actions.executeReady();
  assert.equal(drained.executed, 1);
  assert.deepEqual(await result(auto.id).then(r => [r.status, r.result.delivery, r.result.author]), ['executed', 'sent', 'ai_assistant']);
  const sent = await row("select author_id, author_name, delivery, delivery_channel, provider_message_id from private.communication_messages where communication_id = $1 and direction = 'outbound'", [first.id]);
  assert.deepEqual([sent.author_id, sent.author_name, sent.delivery, sent.delivery_channel, sent.provider_message_id], [aiAssistant, 'CareMetric AI Assistant', 'sent', 'email', 'fixture-1']);
  assert.equal((await row('select status from private.communications where id = $1', [first.id])).status, 'waiting');
  assert.deepEqual([outbox[0].to, outbox[0].subject], [`pat-${run}@example.test`, `Re: Your message to CareMetric support [CM-${first.reference}]`]);
  const audit = await row("select actor_id, metadata from private.audit_events where action = 'communication.reply' and entity_id = $1", [first.id]);
  assert.equal(audit.actor_id, aiAssistant);
  assert.equal(audit.metadata.approved, 'automatic');

  // A chat answer goes into the chat and nowhere else.
  const chat = await conversation({ channel: 'chat' });
  const chatAnswer = await propose(chat, { channel: 'chat', route: 'chat' });
  await actions.executeReady();
  assert.equal((await result(chatAnswer.id)).status, 'executed');
  assert.equal(outbox.length, 1, 'a chat answer is not emailed');

  // Refusals, each recorded on the action and nothing sent.
  const closing = await conversation();
  const closed = await propose(closing);
  await admin.query("update private.communications set status = 'closed' where id = $1", [closing.id]);
  const moving = await conversation();
  const moved = await propose(moving);
  await admin.query("insert into private.communication_messages(communication_id, direction, body, delivery, created_at) values ($1, 'inbound', 'Also, one more thing', 'received', now() + interval '1 second')", [moving.id]);
  const routeless = await conversation();
  const noRoute = await propose(routeless, { route: 'chat' });
  await actions.executeReady();
  for (const [id, code] of [[closed.id, 'conversation_closed'], [moved.id, 'thread_changed'], [noRoute.id, 'reply_refused']]) {
    assert.deepEqual(await result(id).then(r => [r.status, r.result.error]), ['failed', code]);
  }
  assert.equal(outbox.length, 1);

  // Trust withdrawn after the answer was approved automatically: it is not sent.
  const withdrawn = await conversation();
  const late = await propose(withdrawn);
  assert.equal(late.status, 'auto_approved');
  await trust(false);
  await actions.executeReady();
  assert.deepEqual(await result(late.id).then(r => [r.status, r.result.error]), ['failed', 'answers_off']);
  assert.equal((await row("select count(*)::integer as n from private.communication_messages where communication_id = $1 and direction = 'outbound'", [withdrawn.id])).n, 0);

  // During the supervised week: proposed, and the owner's approval sends it straight away, still without a session-bound path.
  const supervised = await conversation();
  const waiting = await propose(supervised);
  assert.equal(waiting.status, 'proposed');
  const decided = await withSession(pool, token, async db => (await db.query('select hub.decide_agent_action($1, $2, $3) as r', [waiting.id, 'approve', null])).rows[0].r);
  assert.equal(decided.status, 'approved');
  const outcome = await actions.executeOne(waiting.id, { kind: 'communication.answer' });
  assert.equal(outcome.executed, true);
  assert.equal((await row("select metadata from private.audit_events where action = 'communication.reply' and entity_id = $1", [supervised.id])).metadata.approved, 'owner');

  // A restart between recording and sending: the second start finds the recorded answer and settles it, never a second message.
  await trust(true);
  const replayed = await conversation();
  const twice = await propose(replayed);
  const started = await store.beginExecution(twice.id);
  const begin = (execution) => pool.query('select private.agent_answer_begin($1, $2, $3) as r', [twice.id, execution, ['email']]).then(r => r.rows[0].r);
  assert.equal((await begin(started.execution)).state, 'ready');
  assert.equal((await begin(started.execution)).state, 'replay');
  await assert.rejects(begin(started.execution + 1), refused('55000'), 'a stale execution is refused');
  assert.equal((await row("select count(*)::integer as n from private.communication_messages where communication_id = $1 and direction = 'outbound'", [replayed.id])).n, 1);
  await assert.rejects(admin.query('select private.agent_answer_begin($1, $2, $3)', [twice.id, started.execution, ['email']]), refused('42501'), 'only the Hub server records an answer');

  // An answer whose card names one conversation but whose input points at another is refused before anything is recorded.
  const named = await conversation();
  const other = await conversation();
  const crossed = await store.proposeAction({ taskId: await task(), kind: 'communication.answer', targetKind: 'communication', targetId: `CM-${named.reference}`, preview: 'Hello',
    input: answerInput(other, { reference: named.reference }) });
  assert.equal(crossed.status, 'auto_approved');
  await actions.executeReady();
  assert.deepEqual(await result(crossed.id).then(r => [r.status, r.result.error]), ['failed', 'target_mismatch']);
  for (const id of [named.id, other.id]) {
    assert.equal((await row("select count(*)::integer as n from private.communication_messages where communication_id = $1 and direction = 'outbound'", [id])).n, 0);
  }

  // The deployment gate declares the feature again as it is, and refuses it when anything it checks has drifted.
  const gate = await readFile(new URL('../supabase/migrations/20261105120100_concierge_answers_contract.sql', import.meta.url), 'utf8');
  const client = await admin.connect();
  try {
    await client.query('begin'); await client.query(gate); await client.query('rollback');
    for (const drift of [
      'grant execute on function private.agent_answer_begin(uuid,integer,text[]) to authenticated',
      'revoke execute on function private.agent_answer_begin(uuid,integer,text[]) from hub_app_server',
      'alter function private.agent_answer_begin(uuid,integer,text[]) reset search_path',
      'alter table private.agent_actions drop constraint agent_actions_communication_answer_check',
      // The trust and target guards themselves: an operation without one of them must not be declared.
      ...[["v_agent.autonomy is distinct from 'act'", 'false'], ["v_agent.status is distinct from 'active'", 'false'],
        ['where key = v_action.agent_key for share', 'where key = v_action.agent_key'], ["'code', 'target_mismatch'", "'code', 'reply_refused'"]]
        .map(([from, to]) => `do $d$ begin execute replace(pg_get_functiondef('private.agent_answer_begin(uuid,integer,text[])'::regprocedure), ${pgText(from)}, ${pgText(to)}); end $d$`),
    ]) {
      await client.query('begin');
      try { await client.query(drift); await assert.rejects(client.query(gate), refused('55000'), drift); }
      finally { await client.query('rollback'); }
    }
  } finally { client.release(); }

  console.log('Support answers integration passed: only cited drafted answers with no identifiers by email or chat, sent without a session as the AI assistant, chat kept in chat, closed/changed/routeless/withdrawn/crossed-target refusals, owner approval during supervision, replay without a second message, server-only recording, gate drift. No email left the machine.');
} finally {
  await admin.query("update private.agents set status=$1, autonomy=$2, config=$3 where key='support_concierge'", [seedConcierge.status, seedConcierge.autonomy, seedConcierge.config]);
  // Every audit row this run wrote about its actions (decided, executed, failed) is keyed by the action's id.
  await admin.query("delete from private.audit_events where entity_type = 'agent_action' and entity_id in (select id from private.agent_actions where task_id = any($1::uuid[]))", [tasks]);
  await admin.query('delete from private.agent_actions where task_id = any($1::uuid[])', [tasks]);
  await admin.query('delete from private.agent_tasks where id = any($1::uuid[])', [tasks]);
  await admin.query("delete from private.audit_events where action = 'communication.reply' and (entity_id = any($1::uuid[]) or actor_id = $2)", [made, owner]);
  await admin.query('delete from private.communication_messages where communication_id = any($1::uuid[])', [made]);
  await admin.query('delete from private.communications where id = any($1::uuid[])', [made]);
  await admin.query('delete from private.sms_sessions where user_id=$1', [owner]);
  await admin.query('delete from private.sms_identities where user_id=$1', [owner]);
  await admin.query('delete from private.staff_permissions where user_id=$1', [owner]);
  await admin.query('delete from hub.profiles where id=$1', [owner]);
  await admin.query('delete from auth.users where id=$1', [owner]);
  await pool.end(); await admin.end();
}
