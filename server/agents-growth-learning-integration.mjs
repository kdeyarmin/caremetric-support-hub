// What is working, through the real roles (20261113200000_growth_learning.sql): the counts follow each sent email's arms to the first
// reply within 30 days of it (never one before it), bounces count, objections and the owner's notes on turned-down drafts come back as
// counts and words, a memo is proposed once and replaces an undecided one, only the owner can use it, one memo is active per product,
// drafts record the memo they were written with, and the gate refuses drift. Disposable loopback database only.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { digest, withSession } from './sms-auth.mjs';
import { growthStore } from './growth/store.mjs';
import { composeMemo } from './growth/learning.mjs';
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
const run = randomUUID().slice(0, 8), owner = randomUUID(), token = `growth-learning-${randomUUID()}`;
const row = async (sql, values = []) => (await admin.query(sql, values)).rows[0];
const refused = code => error => error?.code === code;
const gate = await readFile(new URL('../supabase/migrations/20261113200100_growth_learning_contract.sql', import.meta.url), 'utf8');
const product = 'caremetric-intel', domains = [], actions = [];
const seedMemos = (await admin.query('select id from private.growth_learning_memos')).rows.map(r => r.id);

try {
  await admin.query('insert into auth.users(id,email,is_anonymous) values($1,$2,false)', [owner, `growth-learning-owner-${run}@test.invalid`]);
  await admin.query("insert into private.staff_permissions(user_id,permission) values($1,'platform.admin')", [owner]);
  await admin.query('insert into private.sms_identities(user_id,phone_e164,verified_at) values($1,$2,now())', [owner, phones.owner]);
  await admin.query("insert into private.sms_sessions(id,token_hash,user_id,identity_version,expires_at) select $1,$2,user_id,identity_version,now()+interval '1 hour' from private.sms_identities where user_id=$3", [randomUUID(), digest(token), owner]);
  const ownerCall = (fn, values) => withSession(pool, token, async db => (await db.query(`select ${fn}(${values.map((_, i) => `$${i + 1}`).join(',')}) as r`, values)).rows[0].r);

  // ---- 1. Four sent emails under one arm, and what came back ---------------------------------------------------------------------
  const sent = async (label, daysAgo, extra = {}) => {
    const domain = `${label}-${run}.example.org`; domains.push(domain);
    await store.discover(product, [{ name: `Synthetic ${label}`, domain, url: `https://${domain}/`, claim: 'A Medicare-certified hospice.' }]);
    const org = (await row('select id from private.growth_organizations where domain=$1', [domain])).id;
    await store.recordContact(org, `info@${domain}`, `https://${domain}/contact`);
    const opp = (await row('select id from private.growth_opportunities where organization_id=$1', [org])).id;
    const work = await store.plan(opp, { key: `learn:${run}:${label}`, kind: 'outreach', action: 'Write.', success: 'Reply.', owner: 'marketing_manager', dueAt: new Date().toISOString() });
    const message = (await row(`insert into private.growth_messages(opportunity_id,work_id,contact_id,purpose,subject,body,citations,opportunity_version,contact_version,policy_version,unsubscribe_hash,status,attempted_at,arms,memo_version)
      select o.id,$2,o.contact_id,'marketing','Hello','Hello.','[]',o.version,1,1,md5($3),$4,now()-make_interval(days=>$5),$6,$7 from private.growth_opportunities o where o.id=$1 returning id`,
    [opp, work, `${run}:${label}`, extra.status ?? 'delivered', daysAgo, JSON.stringify({ itest: run }), extra.memo ?? null])).id;
    return { org, opp, message };
  };
  const event = (org, key, kind, at, facts = {}) => admin.query('insert into private.customer_activity_events(product,organization_id,event_key,kind,occurred_at,facts) values($1,$2,$3,$4,$5,$6)',
    [product, org, `learn:${run}:${key}`, kind, at, JSON.stringify(facts)]);
  const a = await sent('positive', 5);
  await event(a.org, 'a', 'positive_reply', new Date(Date.now() - 4 * 86_400_000), { objection: 'price' });
  const b = await sent('bounced', 5, { status: 'bounced' });
  await event(b.org, 'b', 'reply', new Date(Date.now() - 30 * 86_400_000), {}); // before the email: not its reply
  const c = await sent('late', 60, { memo: 7 });
  await event(c.org, 'c', 'not_now', new Date(Date.now() - 20 * 86_400_000), {}); // 40 days after the email: too late to count
  const d = await sent('notnow', 10, { memo: 7 });
  await event(d.org, 'd', 'not_now', new Date(Date.now() - 9 * 86_400_000), { objection: 'timing' });

  // ---- 2. The owner's note on a draft they turned down ---------------------------------------------------------------------------
  const action = (await row(`insert into private.agent_actions(agent_key,kind,target_kind,target_id,preview,status,decided_by,decided_at,decision_note)
    values('marketing_manager','growth.message','growth_message',$1,'Draft.','rejected',$2,now(),$3) returning id`, [d.message, owner, `Too long, itest ${run}`])).id;
  actions.push(action);
  await admin.query('update private.growth_messages set action_id=$1 where id=$2', [action, d.message]);

  // ---- 3. The counts ------------------------------------------------------------------------------------------------------------
  await assert.rejects(admin.query("select private.growth_learning_facts('caremetric-intel',90)"), refused('42501'));
  await assert.rejects(store.learningFacts(product, 3), refused('22023'));
  const facts = await store.learningFacts(product, 90);
  const arm = facts.arms.find(item => item.arm === 'itest' && item.value === run);
  assert.deepEqual(arm, { arm: 'itest', value: run, sent: 4, replied: 2, positive: 1, negative: 0, notNow: 1, bounced: 1 });
  assert.ok(facts.sent >= 4 && facts.replied >= 2 && facts.bounced >= 1);
  const memo7 = facts.memos.find(item => item.version === 7);
  assert.ok(memo7.sent >= 2 && memo7.replied >= 1);
  assert.ok(facts.objections.price >= 1 && facts.objections.timing >= 1);
  assert.ok(facts.ownerNotes.includes(`Too long, itest ${run}`));
  assert.ok(facts.rejectedDrafts >= 1);
  assert.deepEqual(Object.keys(facts).sort(), ['arms', 'bounced', 'days', 'draftChecks', 'memos', 'objections', 'ownerNotes', 'positive', 'product', 'rejectedDrafts', 'replied', 'sent']);
  assert.equal(JSON.stringify(facts).includes('@'), false, 'No address leaves the database');
  const memo = composeMemo(product, facts);
  assert.ok(memo.text.includes(`Too long, itest ${run}`), 'The owner\'s note is in the memo');

  // Report-led first touches used ordinary length labels in growth.11. The read-time filter
  // drops only that dimension, including an old draft sent after the new code rolls out.
  const lengthCase = async (label, extraArms = {}, created = '2026-11-15T12:00:00Z', productName = product) => {
    const item = await sent(`report-${label}`, 0);
    await admin.query('update private.growth_messages set arms=$2,created_at=$3 where id=$1',
      [item.message, JSON.stringify({ length: run, subject: run, angle: run, trigger: 'cms_record', ...extraArms }), created]);
    if (productName !== product) await admin.query('update private.growth_opportunities set product=$2 where id=$1', [item.opp, productName]);
    return item;
  };
  await lengthCase('legacy');
  await lengthCase('unknown-trigger', { trigger: '' });
  await lengthCase('new-ordinary', { length_basis: 'applied_v1' });
  const report = await lengthCase('new-report', { length: 'report', length_basis: 'applied_v1' });
  await admin.query("update private.growth_messages set variant='report' where id=$1", [report.message]);
  await lengthCase('inbound', { trigger: 'inbound' });
  await lengthCase('reask', { trigger: 'reask_later' });
  await lengthCase('before', {}, '2026-11-14T12:00:00Z');
  const later = await lengthCase('later');
  // An earlier primary attempt establishes a later touch, even outside the learning window.
  await admin.query(`insert into private.growth_messages(opportunity_id,work_id,contact_id,purpose,subject,body,citations,
    opportunity_version,contact_version,policy_version,unsubscribe_hash,status,attempted_at,created_at)
    select opportunity_id,work_id,contact_id,purpose,subject,body,citations,opportunity_version+1,contact_version,policy_version,
      unsubscribe_hash,'delivered','2026-11-14T10:00:00Z','2026-11-14T09:00:00Z' from private.growth_messages where id=$1`, [later.message]);
  await lengthCase('carebase', {}, '2026-11-15T12:00:00Z', 'carebase');
  const filtered = await store.learningFacts(product, 90);
  const count = (f, dimension) => f.arms.find(x => x.arm === dimension && x.value === run)?.sent ?? 0;
  assert.equal(count(filtered, 'length'), 5, 'Only legacy cold first-touch lengths are excluded');
  assert.equal(count(filtered, 'angle'), 8, 'All legitimate angle experiments remain');
  assert.equal(count(filtered, 'subject'), 8, 'All legitimate subject experiments remain');
  assert.equal(count(await store.learningFacts('carebase', 90), 'length'), 1, 'CareBase length is unchanged');

  // ---- 4. Proposed once, replacing an undecided proposal; only the owner decides -------------------------------------------------
  await admin.query("update private.growth_learning_memos set status='retired' where product=$1 and status in ('proposed','active')", [product]);
  const first = await store.learningPropose(product, `First memo ${run}.`, { sent: 4 });
  assert.equal(first.proposed, true);
  assert.deepEqual(await store.learningPropose(product, `First memo ${run}.`, { sent: 4 }), { proposed: false, reason: 'unchanged' });
  const second = await store.learningPropose(product, `Second memo ${run}.`, { sent: 4 });
  assert.equal(second.version, first.version + 1);
  assert.equal((await row('select status from private.growth_learning_memos where id=$1', [first.id])).status, 'rejected');
  await assert.rejects(store.learningPropose(product, '', {}), refused('22023'));
  assert.equal(await store.learningActive(product), null, 'Nothing is used until the owner chooses it');
  const listed = await store.learning(token);
  assert.ok(listed.some(item => item.id === second.id && item.status === 'proposed' && item.stats.sent === 4));
  assert.equal(JSON.stringify(listed).includes('arms'), false, 'The list shows only the headline counts');
  await assert.rejects(admin.query("select hub.growth_learning_decide($1,'activate')", [second.id]));
  assert.deepEqual(await store.learningDecide(token, second.id, 'activate'), { status: 'active', version: second.version });
  assert.deepEqual(await store.learningActive(product), { version: second.version, memo: `Second memo ${run}.` });
  await assert.rejects(store.learningDecide(token, second.id, 'reject'), refused('22023'), 'A decided memo stays decided');
  const third = await store.learningPropose(product, `Third memo ${run}.`, { sent: 5 });
  await ownerCall('hub.growth_learning_decide', [third.id, 'activate']);
  assert.equal((await row('select status from private.growth_learning_memos where id=$1', [second.id])).status, 'retired', 'The earlier memo retires');
  assert.equal((await row("select count(*)::int n from private.growth_learning_memos where product=$1 and status='active'", [product])).n, 1);
  assert.ok((await row("select 1 as ok from private.audit_events where action='growth.memo_activated' and actor_id=$1", [owner]))?.ok);

  // ---- 5. A draft records the memo it was written with ---------------------------------------------------------------------------
  const opp = await row('select o.id,o.version,o.contact_id,(select version from private.growth_contacts where id=o.contact_id) cv,(select version from private.growth_policies where product=o.product) pv from private.growth_opportunities o where o.id=$1', [a.opp]);
  const work = await store.plan(a.opp, { key: `learn:${run}:draft`, kind: 'outreach', action: 'Write.', success: 'Reply.', owner: 'marketing_manager', dueAt: new Date().toISOString() });
  const saved = await store.draft(a.opp, work, { version: opp.version, contactVersion: opp.cv, policyVersion: opp.pv, purpose: 'marketing', subject: 'Hello', body: 'Hello.', citations: [],
    unsubscribeHash: digest(`${run}:draft`), arms: { length: 'control' }, memoVersion: third.version });
  assert.equal((await row('select memo_version from private.growth_messages where id=$1', [saved.id])).memo_version, third.version);
  const plain = await store.plan(a.opp, { key: `learn:${run}:plain`, kind: 'outreach', action: 'Write.', success: 'Reply.', owner: 'marketing_manager', dueAt: new Date().toISOString() });
  const unmarked = await store.draft(a.opp, plain, { version: opp.version, contactVersion: opp.cv, policyVersion: opp.pv, purpose: 'marketing', subject: 'Hello', body: 'Hello.', citations: [],
    unsubscribeHash: digest(`${run}:plain`), memoVersion: 'seven' });
  assert.equal((await row('select memo_version from private.growth_messages where id=$1', [unmarked.id])).memo_version, null, 'Only a number is kept');

  // ---- 6. The gate refuses drift ------------------------------------------------------------------------------------------------
  const client = await admin.connect();
  try {
    for (const drift of [
      'grant select on private.growth_learning_memos to authenticated',
      'grant execute on function private.growth_learning_facts(text,integer) to authenticated',
      "delete from private.hub_settings where key='growth.learning_memo'",
      "delete from private.agent_schedules where task_kind='growth.learn'",
    ]) {
      await client.query('begin');
      try { await client.query(drift); await assert.rejects(client.query(gate), refused('55000'), drift); }
      finally { await client.query('rollback'); }
    }
  } finally { client.release(); }

  console.log('Learning integration passed: counts by arm to the first reply within 30 days (never one before), bounces, objections and the owner\'s notes, no address in the counts, a memo proposed once and replacing an undecided one, used only after the owner chooses it, one active memo per product, drafts recording their memo, and gate drift. Nothing was sent.');
} finally {
  await admin.query('delete from private.growth_learning_memos where not (id=any($1::uuid[]))', [seedMemos]);
  for (const domain of domains) {
    const org = (await row('select id from private.growth_organizations where domain=$1', [domain]))?.id;
    if (!org) continue;
    await admin.query('delete from private.growth_messages where opportunity_id in(select id from private.growth_opportunities where organization_id=$1)', [org]);
    await admin.query('delete from private.customer_success_plans where opportunity_id in(select id from private.growth_opportunities where organization_id=$1)', [org]);
    await admin.query('delete from private.growth_evidence where opportunity_id in(select id from private.growth_opportunities where organization_id=$1)', [org]);
    await admin.query('delete from private.customer_activity_events where organization_id=$1', [org]);
    await admin.query('delete from private.growth_opportunities where organization_id=$1', [org]);
    await admin.query('delete from private.growth_contacts where organization_id=$1', [org]);
    await admin.query("delete from private.audit_events where action like 'growth.%' and entity_id=$1", [org]);
    await admin.query('delete from private.growth_organizations where id=$1', [org]);
  }
  await admin.query('delete from private.agent_actions where id=any($1::uuid[])', [actions]);
  await admin.query("delete from private.audit_events where action like 'growth.memo_%' and actor_id=$1", [owner]);
  await admin.query('delete from private.sms_sessions where user_id=$1', [owner]);
  await admin.query('delete from private.sms_identities where user_id=$1', [owner]);
  await admin.query('delete from private.staff_permissions where user_id=$1', [owner]);
  await admin.query('delete from hub.profiles where id=$1', [owner]);
  await admin.query('delete from auth.users where id=$1', [owner]);
  await pool.end(); await admin.end();
}
