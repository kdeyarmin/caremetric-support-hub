// The Growth Manager and the lead form check through the actual Hub server role, on disposable local fixtures only. Leads arrive
// signed through the real POST /api/leads route and private.lead_intake; the agent reads them only through the server-only
// operations the migration adds, through the real store, task queue and notifier; the mail and text senders are recording fakes.
// The form check probes a local fake product that verifies the probe the way the products do and forwards its test lead back
// through the same real intake. A canary in a visitor's message and the contact's details must reach nothing the agent keeps.
// Every row this makes is removed at the end and every key is new per run, so CI runs it twice in a row. The last section runs
// the deployment gate against drift.
import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import pg from 'pg';
import { digest, ownerAccess, withSession } from './sms-auth.mjs';
import { gateway } from './gateway.mjs';
import { appServer } from './http.mjs';
import { escapeHtml } from './email-layout.mjs';
import { leadIntake, leadSignature } from './leads.mjs';
import { agentTeam } from './agents/index.mjs';
import { easternDate, easternMidnight, weekStart } from './agents/accounts/week.mjs';
import { composeGrowthReport } from './agents/growth/report.mjs';
import { formTargets } from './agents/targets.mjs';
import { growthHandlers } from './agents/tasks/growth.mjs';
import { agentSchema, scheduleSchema } from '../src/admin/teamProtocol.ts';

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
const gate = await readFile(new URL('../supabase/migrations/20261103130100_agent_growth_contract.sql', import.meta.url), 'utf8');

const run = randomBytes(4).toString('hex');
const owner = randomUUID();
const ownerToken = `growth-owner-${randomUUID()}`;
const ownerPhone = `+1202557${String(1000 + Math.floor(Math.random() * 9000))}`;
const secrets = { carebase: randomBytes(32).toString('hex'), intel: randomBytes(32).toString('hex'), advisors: randomBytes(32).toString('hex') };
// What a visitor may write or give, which must reach nothing the agent keeps (the organization may: it names a business).
const canary = `GROWTH-CANARY-${run}`;
const contact = { name: `Canary Visitor ${run}`, email: `growth-visitor-${run}@example.test`, phone: '+12025550188', role: `Canary Role ${run}` };
const organization = `Growth <b>IT</b> & "Co" ${run}`;
const campaign = `growth-${run}`;
const external = name => `growth-int-${run}-${name}`;
const advisorsKey = () => `CM-${randomBytes(6).toString('hex').toUpperCase()}`;
const advisorsKeys = [];
const leadIds = new Set();
const hubOrigin = 'https://hub.test';
const hour = 3_600_000;

const call = async (fn, args = []) => (await pool.query(`select ${fn}(${args.map((_, i) => `$${i + 1}`).join(',')}) as r`, args)).rows[0].r;
const ownerCall = (fn, args = [], token = ownerToken) => withSession(pool, token, async db =>
  (await db.query(`select to_jsonb(${fn}(${args.map((_, i) => `$${i + 1}`).join(',')})) as r`, args)).rows[0].r);
const refused = (code, pattern) => error => { assert.equal(error.code, code, error.message); if (pattern) assert.match(error.message, pattern); return true; };
const row = async (sql, params = []) => (await admin.query(sql, params)).rows[0];
const rows = async (sql, params = []) => (await admin.query(sql, params)).rows;

// ---- The Hub's real lead route, and the products' signed forwards to it --------------------------------------------------------
const logs = [];
const intake = leadIntake({ pool, secrets, enabled: true, log: line => logs.push(line) });
const hub = appServer({ auth: {}, owner: ownerAccess(pool), gateway: api, delegations: {}, leads: intake, origins: [hubOrigin] });
await new Promise(resolve => hub.listen(0, '127.0.0.1', resolve));
const hubBase = `http://127.0.0.1:${hub.address().port}`;
async function send(source, payload, { secret = secrets[source] } = {}) {
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const response = await fetch(`${hubBase}/api/leads`, {
    method: 'POST', body,
    headers: { 'Content-Type': 'application/json', 'X-CareMetric-Source': source, 'X-CareMetric-Timestamp': timestamp, 'X-CareMetric-Signature': leadSignature(secret, timestamp, Buffer.from(body)) },
  });
  const answer = { status: response.status, body: await response.json() };
  if (answer.body.id) leadIds.add(answer.body.id);
  return answer;
}
const lead = (source, kind, externalId, extra = {}) => ({
  version: 1, source, kind, externalId, occurredAt: new Date().toISOString(), test: false,
  contact: { ...contact, organization }, ...extra,
});

// ---- A fake product: it verifies a probe the way the products do and forwards its test lead to the Hub ---------------------------
const productSecrets = { ...secrets };
const productMode = { carebase: 'ok', intel: 'ok', advisors: 'ok' };
const productRequests = [];
const probeSignature = (secret, timestamp) => `v1=${createHmac('sha256', secret).update(`${timestamp}.probe`).digest('hex')}`;
const product = http.createServer(async (req, res) => {
  const source = new URL(req.url, 'http://product').pathname.slice(1);
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  productRequests.push({ source, method: req.method, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
  const stamp = req.headers['x-caremetric-timestamp'];
  const verified = typeof stamp === 'string' && /^\d{1,12}$/.test(stamp) && Math.abs(Math.floor(Date.now() / 1000) - Number(stamp)) <= 300
    && req.headers['x-caremetric-probe'] === probeSignature(productSecrets[source], stamp);
  const reply = (status, payload) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload)); };
  // Not a probe: an ordinary submission, which needs the captcha this request does not carry.
  if (!verified) return reply(400, { error: 'Verification is required' });
  if (productMode[source] === 'drop') return reply(200, { probe: true, forwarded: true, status: 202 });
  const externalId = source === 'advisors' ? advisorsKey() : `probe-${stamp}-${randomBytes(2).toString('hex')}`;
  if (source === 'advisors') advisorsKeys.push(externalId);
  const answer = await send(source, { version: 1, source, kind: source === 'advisors' ? 'consultation' : 'demo_request', externalId, occurredAt: new Date().toISOString(), test: true,
    contact: { email: 'probe@caremetric.invalid' } }, { secret: productSecrets[source] });
  return reply(200, { probe: true, forwarded: answer.status >= 200 && answer.status < 300, status: answer.status });
});
await new Promise(resolve => product.listen(0, '127.0.0.1', resolve));
const productBase = `http://127.0.0.1:${product.address().port}`;
// The real form targets (keys, labels, bodies, limits), pointed at the fake product.
const localForms = formTargets.map(target => ({ ...target, url: `${productBase}/${target.source}` }));

const seedAgents = (await admin.query('select key, status, autonomy, daily_budget_cents, config, updated_at from private.agents')).rows;
const seedSchedules = (await admin.query('select id, next_run_at, last_run_at, last_task_id, enabled from private.agent_schedules')).rows;
let setAside = [];
const mail = [];
const texts = [];
const clock = { value: null };

try {
  await admin.query("delete from private.owner_notifications where dedupe_key like 'growth:%' or dedupe_key like 'probe.%:%_forms:%'");
  await admin.query("delete from private.agent_probe_state where target_key in ('carebase_forms', 'intel_forms', 'advisors_forms')");
  await admin.query("insert into auth.users(id,email,is_anonymous) values($1,'growth-owner@test.invalid',false)", [owner]);
  await admin.query("insert into private.staff_permissions(user_id,permission) values($1,'platform.admin')", [owner]);
  await admin.query('insert into private.sms_identities(user_id,phone_e164,verified_at) values($1,$2,now())', [owner, ownerPhone]);
  await admin.query("insert into hub.profiles(id,display_name) values($1,'Growth integration owner') on conflict (id) do update set display_name=excluded.display_name", [owner]);
  await admin.query(`insert into private.sms_sessions(id,token_hash,user_id,identity_version,created_at,expires_at)
    select $1,$2,user_id,identity_version,now(),now()+interval '1 hour' from private.sms_identities where user_id=$3`, [randomUUID(), digest(ownerToken), owner]);
  setAside = (await admin.query("update private.staff_permissions set revoked_at = now() where permission = 'platform.admin' and revoked_at is null and user_id <> $1 returning id", [owner])).rows.map(entry => entry.id);

  // ---- The boundary: the Hub server reads through six operations; nobody else reads anything -------------------------------------
  const features = (await api.rpc('get_backend_contract', {})).features;
  assert.ok(features.includes('platform.agents.growth.v1'), 'the feature is declared');
  const operations = [
    ['private.agent_growth_pending', [10, 24]], ['private.agent_growth_lead', [randomUUID()]], ['private.agent_growth_mark_seen', [[]]],
    ['private.agent_growth_unanswered', [[60, 1440], 10080, 10]], ['private.agent_growth_facts', [new Date(Date.now() - 86_400_000), new Date()]],
    ['private.agent_lead_probe_seen', ['carebase', new Date()]],
  ];
  for (const [fn, args] of operations) {
    await assert.rejects(admin.query(`select ${fn}(${args.map((_, i) => `$${i + 1}`).join(',')})`, args), refused('42501', /Application server required/), `${fn} refuses any session user but the Hub server`);
    for (const role of ['anon', 'authenticated']) {
      const client = await admin.connect();
      try {
        await client.query('begin');
        await client.query(`set local role ${role}`);
        await assert.rejects(client.query(`select ${fn}(${args.map((_, i) => `$${i + 1}`).join(',')})`, args), refused('42501'), `${role} cannot run ${fn}`);
      } finally { await client.query('rollback'); client.release(); }
    }
  }
  for (const helper of ['private.agent_growth_waiting()', 'private.agent_growth_pending_json(10, 24)', `private.agent_growth_lead_json('${randomUUID()}')`,
    "private.agent_growth_mark_seen_rows('{}'::uuid[])", 'private.agent_growth_unanswered_json(array[60], 10080, 10)', "private.agent_growth_facts_json(now() - interval '1 day', now())",
    "private.agent_growth_probe_seen('carebase', now())", "private.agent_growth_product('intel')", "private.agent_growth_answers('note', 'recorded')",
    `private.agent_growth_reminded('${randomUUID()}', 60)`]) {
    await assert.rejects(pool.query(`select * from ${helper}`), refused('42501'), `the helper ${helper} is not callable, even by the server role`);
  }
  await assert.rejects(pool.query('select count(*) from private.leads'), refused('42501'), 'the server role has no direct access to the leads');
  // Each operation checks what it is given.
  const day = 86_400_000;
  // Exact boundary cases must share one clock reading. Separate reads can make
  // a zero-length interval positive, or push exactly 93 days over the limit.
  const periodEnd = new Date();
  for (const [fn, args, message] of [
    ['private.agent_growth_pending', [0, 24], /between 1 and 100 leads/], ['private.agent_growth_pending', [101, 24], /between 1 and 100 leads/],
    ['private.agent_growth_pending', [null, 24], /between 1 and 100 leads/], ['private.agent_growth_pending', [10, 0], /between 1 and 720 hours/],
    ['private.agent_growth_pending', [10, 721], /between 1 and 720 hours/], ['private.agent_growth_lead', [null], /Choose a lead/],
    ['private.agent_growth_mark_seen', [null], /between 0 and 100 leads/], ['private.agent_growth_mark_seen', [Array.from({ length: 101 }, () => randomUUID())], /between 0 and 100 leads/],
    ['private.agent_growth_mark_seen', [[randomUUID(), null]], /between 0 and 100 leads/],
    ['private.agent_growth_unanswered', [null, 10080, 10], /one to five reminder steps/], ['private.agent_growth_unanswered', [[], 10080, 10], /one to five reminder steps/],
    ['private.agent_growth_unanswered', [[1, 2, 3, 4, 5, 6], 10080, 10], /one to five reminder steps/], ['private.agent_growth_unanswered', [[0], 10080, 10], /one to five reminder steps/],
    ['private.agent_growth_unanswered', [[43_201], 10080, 10], /one to five reminder steps/], ['private.agent_growth_unanswered', [[60, null], 10080, 10], /one to five reminder steps/],
    ['private.agent_growth_unanswered', [[60], 0, 10], /longest wait between 1 and 44640/], ['private.agent_growth_unanswered', [[60], 44_641, 10], /longest wait between 1 and 44640/],
    ['private.agent_growth_unanswered', [[60], null, 10], /longest wait between 1 and 44640/],
    ['private.agent_growth_unanswered', [[60], 10080, 0], /between 1 and 100 conversations/], ['private.agent_growth_unanswered', [[60], 10080, 101], /between 1 and 100 conversations/],
    ['private.agent_growth_facts', [null, periodEnd], /up to 93 days/], ['private.agent_growth_facts', [periodEnd, periodEnd], /up to 93 days/],
    ['private.agent_growth_facts', [periodEnd, new Date(periodEnd.getTime() - day)], /up to 93 days/], ['private.agent_growth_facts', [new Date(periodEnd.getTime() - 93 * day - 1), periodEnd], /up to 93 days/],
    ['private.agent_lead_probe_seen', ['breathe', new Date()], /carebase, intel or advisors/], ['private.agent_lead_probe_seen', [null, new Date()], /carebase, intel or advisors/],
    ['private.agent_lead_probe_seen', ['carebase', null], /within the last day/], ['private.agent_lead_probe_seen', ['carebase', new Date(Date.now() - 2 * day)], /within the last day/],
  ]) {
    await assert.rejects(call(fn, args), refused('22023', message), `${fn}(${JSON.stringify(args).slice(0, 60)}) is refused`);
  }
  assert.deepEqual(await call('private.agent_growth_facts', [new Date(periodEnd.getTime() - 93 * day), periodEnd]).then(facts => Object.keys(facts).sort()),
    ['generatedAt', 'leads', 'replies', 'since', 'trials', 'unanswered', 'until'], 'a period of exactly 93 days is allowed');

  // The Team screen's own schemas accept the new agent and its schedules.
  const teamView = await ownerCall('hub.get_agent_team');
  const growthAgent = agentSchema.parse(teamView.agents.find(agent => agent.key === 'growth_manager'));
  assert.deepEqual([growthAgent.displayName, growthAgent.status, growthAgent.autonomy, growthAgent.modelTier, growthAgent.dailyBudgetCents, growthAgent.toolAllowlist],
    ['Growth Manager', 'paused', 'observe', 'fast', 50, ['notify_owner']]);
  assert.deepEqual(growthAgent.schedules.map(schedule => scheduleSchema.parse(schedule).taskKind).sort(), ['growth.followup', 'growth.leads', 'growth.weekly']);
  assert.ok(teamView.agents.find(agent => agent.key === 'platform_engineer').schedules.some(schedule => schedule.taskKind === 'probe.forms' && schedule.everySeconds === 21600));

  // ---- Leads through the real intake ---------------------------------------------------------------------------------------------
  const trial = await send('carebase', lead('carebase', 'trial_signup', external('trial'), {
    details: { plan: 'complete', facilityCount: 4 }, attribution: { utmSource: 'Google', utmMedium: 'cpc', utmCampaign: campaign, landingPath: '/pricing' } }));
  const demo = await send('intel', lead('intel', 'demo_request', external('demo'), { message: `${canary} We would like a demo.`, attribution: { referrerHost: 'www.bing.com', landingPath: '/demo' } }));
  const consultationKey = advisorsKey(); advisorsKeys.push(consultationKey);
  const consultation = await send('advisors', lead('advisors', 'consultation', consultationKey, { message: `${canary} Please help with a review.`, attribution: { utmSource: 'google', utmCampaign: campaign } }));
  const newsletter = await send('carebase', lead('carebase', 'newsletter', external('news')));
  const probeLead = await send('intel', lead('intel', 'demo_request', `probe-${run}`, { test: true, contact: { email: 'probe@caremetric.invalid' } }));
  for (const answer of [trial, demo, consultation, newsletter, probeLead]) assert.equal(answer.status, 202, JSON.stringify(answer.body));
  // A trial or newsletter sign-up opens a conversation too, so the Sales Executive follows up (20261113180000_lead_followup.sql);
  // a test lead never does. Those two are closed here, so the reminders and counts below stay about the demo and the consultation.
  assert.equal(probeLead.body.conversation, null);
  for (const answer of [trial, newsletter, demo]) assert.match(answer.body.conversation, /^CM-\d+$/);
  await admin.query('update private.communications set status = $2 where reference = any($1::bigint[])',
    [[trial, newsletter].map(answer => Number(answer.body.conversation.slice(3))), 'closed']);
  // A lead's version to the microsecond, as the Leads screen hands it back.
  const versions = async () => Object.fromEntries((await rows('select id, updated_at::text as version from private.leads where id = any($1::uuid[])', [[...leadIds]])).map(entry => [entry.id, entry.version]));
  const versionsBefore = await versions();

  // ---- The team: the real store, queue and notifier, with recording senders --------------------------------------------------------
  await admin.query("update private.agents set status = case when key in ('growth_manager', 'platform_engineer') then 'active' else 'paused' end");
  await admin.query("update private.agent_schedules set next_run_at = now() + interval '1 day', enabled = true");
  const sender = { configured: true, send: async (to, subject, content) => { mail.push({ to, subject, content }); return { delivery: 'sent', id: `fixture-${mail.length}` }; } };
  const phone = { configured: true, send: async (to, body) => { texts.push([to, body]); return { delivery: 'sent', id: `SM${String(texts.length).padStart(32, '0')}` }; } };
  const teamFor = ({ leadSecrets = secrets, ...options } = {}) => agentTeam({
    pool, enabled: true, ownerEmail: 'owner@example.test', publicOrigin: hubOrigin, log: line => logs.push(line), features: new Set(features),
    now: () => clock.value ?? new Date(), sms: phone, email: sender, leadSecrets,
    // The real growth handlers with the real form targets, pointed at the fake product instead of the live sites.
    handlers: ({ store, notifier }) => growthHandlers({ store, notifier, publicOrigin: hubOrigin, features: new Set(features), leadSecrets, formTargets: localForms, log: line => logs.push(line) }),
    ...options,
  });
  const team = teamFor();
  assert.ok(['growth.leads', 'growth.followup', 'growth.weekly', 'probe.forms'].every(kind => team.scheduler.kinds().includes(kind)), 'registered once the database declares the feature');
  const bare = agentTeam({ pool, enabled: true, features: new Set(features.filter(feature => feature !== 'platform.agents.growth.v1')), publicOrigin: hubOrigin, log: () => {} });
  assert.ok(!bare.scheduler.kinds().includes('growth.leads') && !bare.scheduler.kinds().includes('probe.forms'), 'a server whose database lacks the feature does not run it');
  await admin.query("update private.agent_schedules set next_run_at = now() - interval '1 minute' where task_kind = 'growth.leads'");
  assert.equal((await bare.tick()).fired, 0, 'and its schedule stays due instead of failing');

  let minutes = 2;
  const fire = async (kind, who = team) => {
    minutes += 1;
    await admin.query('update private.agent_schedules set next_run_at = now() - make_interval(mins => $1::int) where task_kind = $2', [minutes, kind]);
    const tick = await who.tick();
    assert.equal(tick.fired, 1, `the ${kind} schedule fires`);
    return row('select * from private.agent_tasks where kind = $1 order by created_at desc, id limit 1', [kind]);
  };
  const drain = async (who = team) => { for (let index = 0; index < 5; index += 1) if ((await who.tick()).claimed === 0) return; };
  const runNow = async (agentKey, kind, who = team) => {
    const asked = await ownerCall('hub.request_agent_task', [agentKey, kind]);
    assert.equal(asked.status, 'queued');
    await who.tick();
    return row('select * from private.agent_tasks where id = $1', [asked.id]);
  };
  const notificationsLike = prefix => rows('select * from private.owner_notifications where dedupe_key like $1 order by created_at, id', [`${prefix}%`]);

  // ---- growth.leads: one trial alert, everything looked at once -----------------------------------------------------------------
  const leadsTask = await fire('growth.leads');
  assert.equal(leadsTask.status, 'done', JSON.stringify(leadsTask.result));
  assert.ok(leadsTask.result.seen >= 4 && leadsTask.result.trials >= 1, JSON.stringify(leadsTask.result));
  const trialMail = mail.filter(entry => entry.subject.startsWith('New CareBase trial:'));
  assert.equal(trialMail.length, 1, 'one trial email');
  assert.equal(trialMail[0].subject, `New CareBase trial: ${organization}`);
  assert.ok(trialMail[0].content.html.includes(escapeHtml(organization)) && !trialMail[0].content.html.includes('<b>IT</b>'), 'the organization is escaped in the email');
  for (const phrase of ['Plan: complete', `Came from: google (cpc), campaign ${campaign}, landing page /pricing`, 'Facility count: 4', 'Open Leads', `${hubOrigin}/admin/leads`]) {
    assert.ok(trialMail[0].content.text.includes(phrase), `the trial email says "${phrase}"`);
  }
  const trialAlerts = await notificationsLike(`growth:trial:${trial.body.id}`);
  assert.match(trialAlerts[0].body, new RegExp(`Product: CareBase\\. Plan: complete\\. Came from google \\(cpc\\), campaign ${campaign}, landing page /pricing\\.`), 'the stored alert says the same in a sentence');
  assert.deepEqual(trialAlerts.map(entry => [entry.channel, entry.severity, entry.status, entry.agent_key, entry.task_id]), [['email', 'warning', 'sent', 'growth_manager', leadsTask.id]]);
  assert.equal(texts.length, 0, 'a trial alert never texts');
  assert.equal((await notificationsLike('growth:trial:')).length, 1, 'only the trial alerted: a demo, a consultation and a newsletter sign-up did not, nor the test lead');
  const seen = await rows('select id, test, growth_seen_at from private.leads where id = any($1::uuid[])', [[...leadIds]]);
  assert.ok(seen.filter(entry => !entry.test).every(entry => entry.growth_seen_at !== null), 'every lead that is not a test was looked at');
  assert.equal(seen.find(entry => entry.test).growth_seen_at, null, 'the test lead never was');
  assert.deepEqual(await versions(), versionsBefore, 'looking at a lead never changes its version');
  const leadsRun = await row("select * from private.agent_runs where agent_key = 'growth_manager' order by started_at desc limit 1");
  assert.deepEqual([leadsRun.model, leadsRun.prompt_version, leadsRun.outcome, Number(leadsRun.cost_cents), leadsRun.task_id], ['none', 'growth.1', 'completed', 0, leadsTask.id]);
  assert.match(leadsRun.summary, /^Looked at \d+ new leads: \d+ trials? alerted \(email:sent\)/);
  assert.ok(!(await call('private.agent_growth_pending', [100, 24])).some(entry => leadIds.has(entry.id)), 'nothing of ours is pending any more');
  const again = await fire('growth.leads');
  assert.deepEqual([again.status, again.result.seen], ['done', 0]);
  assert.equal(mail.filter(entry => entry.subject.startsWith('New CareBase trial:')).length, 1, 'the trial is alerted once');
  // What one lead looks like to the agent: no contact detail and no message, ever.
  const oneLead = await call('private.agent_growth_lead', [demo.body.id]);
  assert.deepEqual(Object.keys(oneLead).sort(), ['attribution', 'details', 'id', 'kind', 'organization', 'productSlug', 'receivedAt', 'reference', 'source', 'test']);
  assert.deepEqual([oneLead.kind, oneLead.productSlug, oneLead.reference, oneLead.attribution.source], ['demo_request', 'caremetric-intel', demo.body.conversation, 'www.bing.com']);
  assert.ok(!JSON.stringify(oneLead).includes(contact.email) && !JSON.stringify(oneLead).includes(canary) && !JSON.stringify(oneLead).includes(contact.name));

  // ---- growth.followup: one reminder per lead and step, never in quiet hours --------------------------------------------------------
  const conversationOf = async answer => row('select * from private.communications where reference = $1', [Number(answer.body.conversation.slice(3))]);
  const demoConversation = await conversationOf(demo);
  const consultationConversation = await conversationOf(consultation);
  const age = (conversation, hours) => admin.query('update private.communication_messages set created_at = now() - make_interval(hours => $2::int) where communication_id = $1', [conversation.id, hours]);
  await age(demoConversation, 2);
  await age(consultationConversation, 2);
  // The consultation was answered; the demo request was not: its only reply was refused by the provider, so it reached nobody.
  await admin.query("insert into private.communication_messages(communication_id, direction, body, delivery, delivery_channel, request_key, created_at) values ($1, 'outbound', 'Thanks, I will be in touch.', 'sent', 'email', gen_random_uuid(), now() - interval '1 hour')", [consultationConversation.id]);
  await admin.query("insert into private.communication_messages(communication_id, direction, body, delivery, delivery_channel, request_key, created_at) values ($1, 'outbound', 'Thanks for your request.', 'failed', 'email', gen_random_uuid(), now() - interval '90 minutes')", [demoConversation.id]);
  const daytime = new Date(`${easternDate(new Date())}T17:00:00Z`);
  clock.value = daytime;
  const followupTask = await fire('growth.followup');
  assert.equal(followupTask.status, 'done', JSON.stringify(followupTask.result));
  const reminders = await notificationsLike(`growth:followup:${demo.body.id}:`);
  assert.deepEqual(reminders.map(entry => [entry.dedupe_key, entry.severity, entry.status]), [[`growth:followup:${demo.body.id}:60`, 'warning', 'sent']]);
  assert.equal(reminders[0].subject, `Still unanswered after 1 hour: demo request ${demo.body.conversation}`);
  assert.match(reminders[0].body, new RegExp(`^A CareMetric Intel demo request \\(${demo.body.conversation}\\) has waited 2 hours for a first reply\\.`));
  assert.equal((await notificationsLike(`growth:followup:${consultation.body.id}:`)).length, 0, 'an answered lead is not chased, and a refused reply answers nothing');
  assert.equal((await notificationsLike(`growth:followup:${probeLead.body.id}:`)).length, 0, 'a test lead is not chased');
  await fire('growth.followup');
  assert.equal((await notificationsLike(`growth:followup:${demo.body.id}:`)).length, 1, 'the same step is reminded once');
  // A day later the second step; a lead found late gets only the largest step it passed.
  await age(demoConversation, 26);
  await fire('growth.followup');
  assert.deepEqual((await notificationsLike(`growth:followup:${demo.body.id}:`)).map(entry => entry.dedupe_key), [`growth:followup:${demo.body.id}:60`, `growth:followup:${demo.body.id}:1440`]);
  // Quiet hours: nothing is sent, and the task says when they end.
  clock.value = new Date(`${easternDate(new Date())}T03:30:00Z`);
  const quietTask = await fire('growth.followup');
  assert.equal(quietTask.result.skipped, 'quiet_hours');
  assert.ok(new Date(quietTask.result.resumesAt) > clock.value);
  clock.value = daytime;
  // The owner marks the lead contacted on the Leads screen, with the version read before the agent looked at it: the agent's
  // look never made that version stale, and the reminders stop.
  const marked = await ownerCall('hub.update_lead_status', [demo.body.id, 'contacted', versionsBefore[demo.body.id]]);
  assert.equal(marked.status, 'contacted');
  assert.ok(!(await call('private.agent_growth_unanswered', [[1], 44640, 100])).some(entry => entry.leadId === demo.body.id), 'a lead marked contacted is no longer waiting');
  await ownerCall('hub.update_lead_status', [demo.body.id, 'new', marked.updatedAt]);
  clock.value = null;

  // ---- The morning brief's Growth section --------------------------------------------------------------------------------------
  await admin.query("update private.agents set status = 'active' where key = 'chief_of_staff'");
  const briefTask = await runNow('chief_of_staff', 'brief.daily');
  assert.equal(briefTask.status, 'done', JSON.stringify(briefTask.result));
  const briefMail = mail.at(-1);
  assert.match(briefMail.subject, /^CareMetric brief for /);
  assert.ok(briefMail.content.text.includes('Growth: website leads yesterday, and what is waiting now') && briefMail.content.text.includes('Leads waiting for a first reply: 1'),
    'the brief has its Growth section, and an unanswered lead needs the owner');
  assert.match((await row("select body from private.owner_notifications where task_id = $1", [briefTask.id])).body, /Growth yesterday: .+ Lead conversations unanswered now: 1, the oldest waiting \d+ hours\./);
  await admin.query("update private.agents set status = 'paused' where key = 'chief_of_staff'");

  // ---- growth.weekly: counts that leave out test leads, Monday's work once a week, Run now any day -------------------------------
  // The newest Monday whose 12:30 UTC firing is already past (thirteen hours after an Eastern Monday begins, it always is).
  const monday = weekStart(new Date(Date.now() - 13 * hour));
  const [year, month, dayOfMonth] = monday.split('-').map(Number);
  const weekBefore = easternMidnight(new Date(Date.UTC(year, month - 1, dayOfMonth - 7)).toISOString().slice(0, 10));
  const weekEnd = easternMidnight(monday);
  const baseline = await call('private.agent_growth_facts', [weekBefore, weekEnd]);
  // Our leads, the test lead included, arrived on the Saturday of the week before this Monday.
  await admin.query('update private.leads set received_at = $2 where id = any($1::uuid[])', [[...leadIds], new Date(weekEnd.getTime() - 36 * hour)]);
  const facts = await call('private.agent_growth_facts', [weekBefore, weekEnd]);
  assert.equal(facts.leads.total - baseline.leads.total, 4, 'four leads in the week: the test lead is never counted');
  for (const [kind, added] of [['trial_signup', 1], ['demo_request', 1], ['consultation', 1], ['newsletter', 1]]) {
    assert.equal(facts.leads.byKind[kind] - baseline.leads.byKind[kind], added, `one more ${kind}`);
  }
  assert.equal(facts.trials.started - baseline.trials.started, 1);
  const ours = facts.leads.campaigns.find(entry => entry.campaign === campaign);
  assert.equal(ours?.count, 2, 'our campaign brought two leads');
  assert.ok(facts.leads.bySource.find(entry => entry.source === 'google').count >= 2 && facts.leads.bySource.some(entry => entry.source === 'www.bing.com'), 'sources by utm_source, else the referring host');
  assert.ok(facts.replies.replied - baseline.replies.replied >= 1, 'the answered consultation counts as a first reply');
  assert.ok(!JSON.stringify(facts).includes(contact.email) && !JSON.stringify(facts).includes(organization) && !JSON.stringify(facts).includes(canary), 'the facts hold no contact, organization or message');

  // Monday's scheduled report, under the week's key. The provider refuses it first: the task is retried under the same key, not lost.
  const mondayRun = new Date(`${monday}T12:30:00Z`);
  await admin.query("update private.agent_schedules set next_run_at = $1 where task_kind = 'growth.weekly'", [mondayRun]);
  const refusing = teamFor({ email: { configured: true, send: async () => ({ delivery: 'failed', id: null }) } });
  await refusing.tick();
  const refusedTask = await row("select * from private.agent_tasks where kind = 'growth.weekly' order by created_at desc, id limit 1");
  assert.deepEqual([refusedTask.status, refusedTask.last_error_code], ['queued', 'notification_failed'], 'a refused report waits to be tried again');
  assert.deepEqual((await notificationsLike(`growth:weekly:${monday}`)).map(entry => [entry.status, entry.attempts]), [['failed', 1]]);
  await admin.query("update private.agent_tasks set due_at = now() - interval '1 second' where id = $1", [refusedTask.id]);
  await team.tick();
  const weekly = await row('select * from private.agent_tasks where id = $1', [refusedTask.id]);
  assert.equal(weekly.status, 'done', JSON.stringify(weekly.result));
  assert.deepEqual((await notificationsLike(`growth:weekly:${monday}`)).map(entry => [entry.status, entry.attempts]), [['sent', 2]], 'the retry sent it under the same key');
  assert.equal(weekly.result.week, monday, 'the report is for the week of the Monday it was due on');
  const expected = composeGrowthReport(await call('private.agent_growth_facts', [weekBefore, weekEnd]), { since: weekBefore, until: weekEnd, publicOrigin: hubOrigin });
  const weeklyAlert = (await notificationsLike(`growth:weekly:${monday}`))[0];
  assert.deepEqual([weeklyAlert.channel, weeklyAlert.severity, weeklyAlert.status, weeklyAlert.subject], ['email', 'info', 'sent', expected.subject]);
  assert.equal(weekly.result.leads, expected.result.leads);
  const weeklyMail = mail.find(entry => entry.subject === expected.subject);
  assert.ok(weeklyMail, 'the weekly email went out');
  for (const phrase of ['Leads by kind', 'Where they came from', 'Trials and replies', 'Three things to do next', campaign, 'Test leads from the form checks are never counted.']) {
    assert.ok(weeklyMail.content.text.includes(phrase), `the weekly email says "${phrase}"`);
  }
  assert.ok(!weeklyMail.content.text.includes(contact.email) && !weeklyMail.content.text.includes(canary) && !weeklyMail.content.text.includes(organization), 'and names no visitor or organization');
  // The same week again: nothing more.
  await admin.query("update private.agent_schedules set next_run_at = $1 where task_kind = 'growth.weekly'", [new Date(mondayRun.getTime() + 60_000)]);
  await team.tick();
  assert.deepEqual((await row("select result from private.agent_tasks where kind = 'growth.weekly' order by created_at desc, id limit 1")).result, { skipped: 'already_sent', week: monday });
  // Sunday's firing does nothing; Run now reports on any day under a key of its own.
  await admin.query("update private.agent_schedules set next_run_at = $1 where task_kind = 'growth.weekly'", [new Date(mondayRun.getTime() - 86_400_000)]);
  await team.tick();
  assert.deepEqual((await row("select result from private.agent_tasks where kind = 'growth.weekly' order by created_at desc, id limit 1")).result, { skipped: 'not_monday' });
  const asked = await runNow('growth_manager', 'growth.weekly');
  assert.equal(asked.status, 'done');
  assert.equal((await notificationsLike(`growth:run:${asked.id}`)).length, 1, 'Run now sends a report of its own');
  assert.equal((await notificationsLike('growth:weekly:')).length, 1, 'and the week is reported once');

  // ---- probe.forms: a round trip through a fake product and the real intake ------------------------------------------------------
  const formsTask = await fire('probe.forms');
  assert.equal(formsTask.status, 'done', JSON.stringify(formsTask.result));
  assert.deepEqual([formsTask.result.checked, formsTask.result.passed, formsTask.result.skipped, formsTask.result.failing], [3, 3, [], []]);
  assert.equal(formsTask.result.summary, 'CareBase lead form passed; Intel lead form passed; Advisors consultation form passed.');
  const probes = productRequests.splice(0);
  assert.deepEqual(probes.map(entry => entry.source).sort(), ['advisors', 'carebase', 'intel']);
  for (const entry of probes) {
    const target = formTargets.find(item => item.source === entry.source);
    assert.equal(entry.method, 'POST');
    assert.deepEqual(JSON.parse(entry.body), target.body, 'the endpoint gets its own body, with invented values');
    assert.equal(entry.headers['x-caremetric-probe'], probeSignature(secrets[entry.source], entry.headers['x-caremetric-timestamp']));
    assert.equal(entry.headers['content-type'], 'application/json');
    assert.equal(entry.headers['user-agent'], 'CareMetric-Hub-Probe/1');
    assert.equal(entry.headers.origin, undefined);
    assert.ok(!entry.body.includes(secrets[entry.source]));
  }
  const state = async key => row('select * from private.agent_probe_state where target_key = $1', [key]);
  for (const key of ['carebase_forms', 'intel_forms', 'advisors_forms']) assert.deepEqual([(await state(key)).state, (await state(key)).consecutive_failures], ['up', 0], key);
  const testLeads = await rows("select source, kind, test, communication_id from private.leads where test and contact_email = 'probe@caremetric.invalid' and received_at > now() - interval '5 minutes' order by source");
  assert.deepEqual(testLeads.map(entry => [entry.source, entry.kind, entry.test, entry.communication_id]),
    [['advisors', 'consultation', true, null], ['carebase', 'demo_request', true, null], ['intel', 'demo_request', true, null]], 'each product\'s test lead arrived, and opened no conversation');
  const formsRun = await row("select * from private.agent_runs where task_id = $1", [formsTask.id]);
  assert.deepEqual([formsRun.model, formsRun.prompt_version, formsRun.outcome], ['none', 'forms.1', 'completed']);
  // Earlier test leads are no proof for a later check.
  await admin.query("update private.leads set received_at = now() - interval '1 hour' where test and contact_email = 'probe@caremetric.invalid'");

  // Intel says it forwarded but its lead never arrives; Advisors' secret no longer matches; CareBase has no secret on the Hub.
  productMode.intel = 'drop';
  productSecrets.advisors = randomBytes(32).toString('hex');
  const partial = teamFor({ leadSecrets: { ...secrets, carebase: null } });
  const failing = await fire('probe.forms', partial);
  assert.deepEqual(failing.result.skipped, ['carebase_forms'], 'a product with no secret on the Hub is skipped, not failed');
  assert.deepEqual(failing.result.failing.map(entry => [entry.target, entry.failure, entry.statusCode]).sort(), [['advisors_forms', 'status', 400], ['intel_forms', 'not_received', 200]]);
  assert.ok(!productRequests.some(entry => entry.source === 'carebase'), 'nothing was sent to a product without a secret');
  assert.deepEqual([(await state('intel_forms')).consecutive_failures, (await state('intel_forms')).state], [1, 'up'], 'one failed check is a blip');
  await drain(partial);
  assert.equal(texts.length, 0, 'and nothing is sent for it');
  // The second failure in a row opens an incident: a text and an email, and an incident record.
  await fire('probe.forms', partial);
  assert.deepEqual([(await state('intel_forms')).state, (await state('advisors_forms')).state], ['down', 'down']);
  await drain(partial);
  const incidentMail = mail.filter(entry => entry.subject === 'Intel lead form is not working');
  assert.equal(incidentMail.length, 1, 'one incident email');
  assert.ok(incidentMail[0].content.text.includes('said it forwarded its test lead, but the lead did not reach the Hub') && incidentMail[0].content.text.includes('Checks run every six hours.'));
  assert.ok(texts.some(([to, body]) => to === ownerPhone && body.startsWith('CareMetric: Intel lead form is not working.')), 'the owner was texted');
  assert.ok(mail.some(entry => entry.subject === 'Advisors consultation form is not working'));
  const incidentAction = await row("select * from private.agent_actions where kind = 'incident.open' and target_id like 'intel_forms:%' order by created_at desc limit 1");
  assert.equal(incidentAction.status, 'executed', 'the incident is recorded on the on-call agent');
  // Intel recovers: one email, no text.
  productMode.intel = 'ok';
  const textsBefore = texts.length;
  await fire('probe.forms', partial);
  await drain(partial);
  assert.equal((await state('intel_forms')).state, 'up');
  assert.equal(mail.filter(entry => entry.subject === 'Intel lead form is working again').length, 1);
  assert.equal(texts.length, textsBefore, 'a recovery never texts');

  // ---- A backlog longer than one run: fifty-five waiting leads are each reminded once, over two runs -------------------------------
  const bulk = [];
  for (let index = 1; index <= 55; index += 1) {
    const recorded = (await row('select private.lead_record($1, $2::jsonb) as r', ['carebase', JSON.stringify({
      version: 1, source: 'carebase', kind: 'demo_request', externalId: external(`bulk-${index}`), occurredAt: new Date().toISOString(),
      contact: { email: `growth-bulk-${run}-${index}@example.test` } })])).r;
    leadIds.add(recorded.id);
    bulk.push(recorded.id);
  }
  // Lead n has waited 100 + n minutes, so the first is the most recent.
  await admin.query(`update private.communication_messages m set created_at = now() - make_interval(mins => 100 + b.n::int)
    from (select l.communication_id, b.n from unnest($1::uuid[]) with ordinality as b(id, n) join private.leads l on l.id = b.id) b where m.communication_id = b.communication_id`, [bulk]);
  clock.value = daytime;
  const firstBacklog = await fire('growth.followup');
  const secondBacklog = await fire('growth.followup');
  const thirdBacklog = await fire('growth.followup');
  clock.value = null;
  assert.deepEqual([firstBacklog.result.reminded, secondBacklog.result.reminded, thirdBacklog.result.reminded], [50, 5, 0], 'fifty in the first run, the five older ones in the next');
  const backlogKeys = (await rows("select dedupe_key from private.owner_notifications where dedupe_key like 'growth:followup:%' and split_part(dedupe_key, ':', 3) = any($1::text[])", [bulk])).map(entry => entry.dedupe_key);
  assert.deepEqual([backlogKeys.length, new Set(backlogKeys).size], [55, 55], 'each of the fifty-five was reminded once');
  assert.ok(backlogKeys.every(key => key.endsWith(':60')));

  // ---- Nothing a visitor gave is anywhere but the lead desk and its conversations ----------------------------------------------
  const everything = JSON.stringify([
    await rows('select to_jsonb(t) as r from private.agent_tasks t'), await rows('select to_jsonb(r) as r from private.agent_runs r'),
    await rows('select to_jsonb(a) as r from private.agent_actions a'), await rows('select to_jsonb(n) as r from private.owner_notifications n'),
    await rows("select metadata from private.audit_events where action like 'agent.%' or action like 'lead.%'"), logs, texts,
    mail.map(entry => [entry.subject, entry.content.text]),
  ]);
  for (const secret of [canary, contact.email, contact.name, contact.phone, contact.role, `growth-bulk-${run}`, ...Object.values(secrets), ownerToken]) {
    for (const form of new Set([secret, JSON.stringify(secret).slice(1, -1)])) assert.ok(!everything.includes(form), `${secret.slice(0, 14)}… appears in no task, run, alert, audit event, log line, text or email`);
  }

  // ---- The deployment gate re-runs cleanly, and refuses to declare the feature once the boundary drifts ----------------------------
  const gateClient = await admin.connect();
  try {
    await gateClient.query('begin');
    await gateClient.query(gate);
    await gateClient.query(gate);
    await gateClient.query('rollback');
    for (const [sql, message] of [
      ['revoke execute on function private.agent_growth_pending(integer,integer) from hub_app_server', /executable by the Hub server only/],
      ['grant execute on function private.agent_growth_facts(timestamp with time zone,timestamp with time zone) to authenticated', /executable by the Hub server only/],
      ['alter function private.agent_growth_lead(uuid) security invoker', /executable by the Hub server only/],
      ['alter function private.agent_growth_mark_seen(uuid[]) reset search_path', /executable by the Hub server only/],
      ["create or replace function private.agent_lead_probe_seen(p_source text, p_since timestamptz) returns boolean language sql stable security definer set search_path = '' as $$ select false $$", /executable by the Hub server only/],
      ['alter function private.agent_communication_snapshot(uuid,uuid,integer,integer) security invoker', /executable by the Hub server only/],
      ['alter function private.agent_growth_waiting() reset search_path', /pinned search path/],
      ['grant execute on function private.agent_growth_facts_json(timestamp with time zone,timestamp with time zone) to hub_app_server', /internal to the operations/],
      ['grant execute on function private.agent_growth_product(text) to anon', /internal to the operations/],
      ['grant select on private.leads to authenticated', /closed to every browser, service and server role/],
      ['alter table private.leads disable row level security', /row level security/],
      ['alter table private.leads drop column growth_seen_at cascade', /which leads the Growth Manager has seen/],
      ["delete from private.agent_schedules where agent_key = 'growth_manager' and task_kind = 'growth.weekly'", /Growth Manager schedules must exist/],
      ["delete from private.agent_schedules where agent_key = 'platform_engineer' and task_kind = 'probe.forms'", /lead form check schedule must exist/],
      ["delete from private.owner_notifications where agent_key = 'growth_manager'; delete from private.agent_actions where agent_key = 'growth_manager'; delete from private.agent_runs where agent_key = 'growth_manager'; delete from private.agent_tasks where agent_key = 'growth_manager'; delete from private.agent_schedules where agent_key = 'growth_manager'; delete from private.agents where key = 'growth_manager'", /agent must exist/],
      [`create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='' as $$ select '{"api_version":4,"features":["platform.agents.v1","platform.agents.probes.v1"]}'::jsonb $$`, /the lead desk first/],
    ]) {
      await gateClient.query('begin');
      try {
        await gateClient.query(sql);
        await assert.rejects(gateClient.query(gate), rejection => rejection.code === '55000' && message.test(rejection.message), sql);
      } finally { await gateClient.query('rollback'); }
    }
  } finally { gateClient.release(); }

  console.log('Growth Manager: six server-only reads that refuse every other caller and check their input, leads through the signed intake, one trial alert, reminders after each step and never in quiet hours (a refused reply answers nothing), a lead the owner marked contacted left alone with its version intact, the brief\'s Growth section, a weekly report that never counts a test lead (retried under its key when refused, once a week, and Run now), a lead form check round trip through a fake product with its blip, incident and recovery, a backlog of 55 waiting leads each reminded once over two runs, a visitor\'s details in nothing the agent keeps, and a deployment gate that fails closed.');
} finally {
  const problems = [];
  const attempt = async (sql, params = []) => { try { await admin.query(sql, params); } catch (error) { problems.push(`${error.message} [${sql.slice(0, 70)}]`); } };
  const fromLeads = (await admin.query("select id, communication_id from private.leads where id = any($1::uuid[]) or external_id like $2 or external_id = any($3) or (test and contact_email = 'probe@caremetric.invalid')",
    [[...leadIds], `growth-int-${run}-%`, advisorsKeys]).catch(() => ({ rows: [] }))).rows;
  const conversations = [...new Set(fromLeads.map(entry => entry.communication_id).filter(Boolean))];
  await attempt("delete from private.audit_events where action like 'agent.%' or actor_id = $1 or (entity_type = 'lead' and entity_id = any($2::uuid[]))", [owner, fromLeads.map(entry => entry.id)]);
  await attempt('delete from private.agent_actions');
  await attempt('delete from private.agent_runs');
  await attempt('delete from private.owner_notifications');
  await attempt('delete from private.agent_tasks');
  await attempt("delete from private.agent_probe_state where target_key in ('carebase_forms', 'intel_forms', 'advisors_forms')");
  await attempt('delete from private.leads where id = any($1::uuid[])', [fromLeads.map(entry => entry.id)]);
  await attempt('delete from private.communications where id = any($1::uuid[])', [conversations]);
  for (const seed of seedAgents) await attempt('update private.agents set status=$2, autonomy=$3, daily_budget_cents=$4, config=$5, updated_at=$6 where key=$1', [seed.key, seed.status, seed.autonomy, seed.daily_budget_cents, seed.config, seed.updated_at]);
  for (const seed of seedSchedules) await attempt('update private.agent_schedules set next_run_at=$2, last_run_at=$3, last_task_id=$4, enabled=$5 where id=$1', [seed.id, seed.next_run_at, seed.last_run_at, seed.last_task_id, seed.enabled]);
  if (setAside.length) await attempt('update private.staff_permissions set revoked_at = null where id = any($1::uuid[])', [setAside]);
  await attempt('delete from private.sms_sessions where user_id = $1', [owner]);
  await attempt('delete from private.sms_identities where user_id = $1', [owner]);
  await attempt('delete from private.staff_permissions where user_id = $1', [owner]);
  await attempt('delete from hub.profiles where id = $1', [owner]);
  await attempt('delete from auth.users where id = $1', [owner]);
  await new Promise(resolve => hub.close(resolve));
  await new Promise(resolve => product.close(resolve));
  await pool.end();
  await admin.end();
  if (problems.length) { console.error(`Teardown problems: ${problems.join(' | ')}`); process.exitCode = 1; }
}
