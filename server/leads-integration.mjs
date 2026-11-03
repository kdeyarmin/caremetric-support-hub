// Website leads through the real Hub server, on disposable local fixtures only: signed requests through the actual
// POST /api/leads route and handler, private.lead_intake run by the server pool that logs in as hub_app_server exactly
// like production, the owner's Leads reads and status changes with a real SMS session, and the Advisors manual import.
// A canary in a visitor's message must reach the conversation and nothing else. Retention then deletes an old lead and
// an idle website conversation through private.lead_retention as hub_app_server, the way the server's cleanup runs it.
// Every row this makes is removed at the end, and every key is new per run, so CI runs it twice in a row. The last
// section runs the deployment gate against drift.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import pg from 'pg';
import { digest, ownerAccess, sessionCookie, token, withSession } from './sms-auth.mjs';
import { gateway } from './gateway.mjs';
import { appServer } from './http.mjs';
import { leadAdmin, leadIntake, leadSignature } from './leads.mjs';
import { leadRetention } from './lead-retention.mjs';
import { leadPageSchema, leadSchema } from '../src/admin/leadsProtocol.ts';

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
const gate = await readFile(new URL('../supabase/migrations/20261103120100_lead_desk_contract.sql', import.meta.url), 'utf8');

// Everything a log line could carry is captured: the handler's own lines and anything the server writes to the console.
const logs = [];
const original = { info: console.info, warn: console.warn, error: console.error, log: console.log };
for (const name of Object.keys(original)) console[name] = (...parts) => { logs.push(parts.map(String).join(' ')); };

const run = randomBytes(4).toString('hex');
const canary = `LEAD-CANARY-${run}-MESSAGE`;
const visitorEmail = `visitor-${run}@example.org`;
const secrets = { carebase: randomBytes(32).toString('hex'), intel: randomBytes(32).toString('hex'), advisors: randomBytes(32).toString('hex') };
const owner = randomUUID();
// The browser's session cookie: 43 URL-safe characters, as the Hub issues it.
const ownerToken = token();
const ownerPhone = `+1202556${String(1000 + Math.floor(Math.random() * 9000))}`;
const advisorsKey = () => `CM-${randomBytes(6).toString('hex').toUpperCase()}`;
const external = name => `leads-int-${run}-${name}`;
const advisorsKeys = [];
const leadIds = new Set();
const hubOrigin = 'https://hub.test';
// The audit events this run's retention batches write are removed at the end too.
let retentionAuditFloor = null;

const intake = leadIntake({ pool, secrets, enabled: true, log: line => console.info(line) });
const server = appServer({ auth: {}, owner: ownerAccess(pool), gateway: gateway(pool), delegations: {}, leads: intake, leadAdmin: leadAdmin({ pool, enabled: true }), origins: [hubOrigin] });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const lead = (source, kind, externalId, extra = {}) => ({
  version: 1, source, kind, externalId, occurredAt: new Date().toISOString(), test: false,
  contact: { name: 'Integration Visitor', email: visitorEmail, organization: 'Integration Assisted Living Facility' }, ...extra,
});
const responses = [];
async function send(source, payload, { secret = secrets[source], timestamp = Math.floor(Date.now() / 1000), raw } = {}) {
  const body = raw ?? JSON.stringify(payload);
  const response = await fetch(`${base}/api/leads`, {
    method: 'POST', body,
    headers: { 'Content-Type': 'application/json', 'X-CareMetric-Source': source, 'X-CareMetric-Timestamp': String(timestamp),
      'X-CareMetric-Signature': leadSignature(secret, String(timestamp), Buffer.from(body)) },
  });
  const text = await response.text();
  responses.push(text);
  const answer = { status: response.status, body: JSON.parse(text) };
  if (answer.body.id) leadIds.add(answer.body.id);
  return answer;
}
// The same handler instance, called the way the router calls it, for configurations the main server does not have.
const direct = (handler, source, payload, secret = secrets[source]) => {
  const body = Buffer.from(JSON.stringify(payload));
  const timestamp = String(Math.floor(Date.now() / 1000));
  return handler.handle(Object.assign(Readable.from([body]), { method: 'POST', url: '/api/leads', headers: {
    'content-type': 'application/json', 'content-length': String(body.length), 'x-caremetric-source': source, 'x-caremetric-timestamp': timestamp,
    'x-caremetric-signature': leadSignature(secret, timestamp, body) } }));
};
const owned = async (path, body, token = ownerToken) => {
  const response = await fetch(`${base}/api/${path}`, { method: 'POST', body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', Origin: hubOrigin, ...(token ? { Cookie: `${sessionCookie}=${token}` } : {}) } });
  const text = await response.text();
  responses.push(text);
  return { status: response.status, body: JSON.parse(text) };
};
const row = async (sql, params = []) => (await admin.query(sql, params)).rows[0];
const conversationOf = reference => row('select * from private.communications where reference = $1', [Number(String(reference).slice(3))]);
const messagesOf = async id => (await admin.query('select direction, body, provider_message_id from private.communication_messages where communication_id = $1 order by created_at, id', [id])).rows;

try {
  await admin.query('insert into auth.users(id,email,is_anonymous) values($1,$2,false)', [owner, `leads-owner-${run}@test.invalid`]);
  await admin.query("insert into private.staff_permissions(user_id,permission) values($1,'platform.admin')", [owner]);
  await admin.query('insert into private.sms_identities(user_id,phone_e164,verified_at) values($1,$2,now())', [owner, ownerPhone]);
  await admin.query("insert into hub.profiles(id,display_name) values($1,'Leads integration owner') on conflict (id) do update set display_name=excluded.display_name", [owner]);
  await admin.query(`insert into private.sms_sessions(id,token_hash,user_id,identity_version,created_at,expires_at)
    select $1,$2,user_id,identity_version,now(),now()+interval '1 hour' from private.sms_identities where user_id=$3`, [randomUUID(), digest(ownerToken), owner]);
  assert.ok((await row('select hub.get_backend_contract() as c')).c.features.includes('support.leads.v1'), 'the feature is declared');
  await assert.rejects(admin.query("select private.lead_intake('carebase', '{}'::jsonb)"), error => error.code === '42501', 'only the Hub server records leads');
  await assert.rejects(pool.query('select * from private.leads'), /permission denied/, 'the server role has no direct table access');

  // ---- Every kind, signed, through the real route ---------------------------------------------------------------------
  const demo = await send('carebase', lead('carebase', 'demo_request', external('demo'), {
    contact: { name: 'Integration Visitor', email: ` ${visitorEmail.toUpperCase()} `, phone: '(202) 555-0199', organization: 'Integration Assisted Living Facility', role: 'Administrator' },
    details: { facilityCount: 2, plan: 'complete' }, message: `${canary} We want a demo before our next survey.`,
    attribution: { utmSource: 'google', utmMedium: 'cpc', utmCampaign: `fall-${run}`, referrerHost: 'www.google.com', landingPath: '/pricing', firstSeenAt: new Date(Date.now() - 86400000).toISOString() } }));
  assert.equal(demo.status, 202);
  assert.deepEqual(Object.keys(demo.body).sort(), ['conversation', 'duplicate', 'id']);
  assert.equal(demo.body.duplicate, false);
  assert.match(demo.body.conversation, /^CM-\d+$/);
  const demoConversation = await conversationOf(demo.body.conversation);
  assert.deepEqual([demoConversation.channel, demoConversation.source_system, demoConversation.source_key, demoConversation.inquiry_type, demoConversation.status],
    ['web_form', 'carebase.web', external('demo'), 'sales', 'new']);
  assert.equal(demoConversation.subject, 'Demo request: Integration Assisted Living Facility');
  assert.equal(demoConversation.contact_email, visitorEmail);
  assert.equal(demoConversation.product_id, (await row("select id from hub.products where slug = 'carebase'")).id);
  assert.deepEqual(await messagesOf(demoConversation.id), [{ direction: 'inbound', provider_message_id: `carebase.web:${external('demo')}`,
    body: `${canary} We want a demo before our next survey.\n\nRole: Administrator\nFacility count: 2\nPlan: complete` }]);

  const consultationKey = advisorsKey(); advisorsKeys.push(consultationKey);
  // No role, phone or other optional field here, so the message has nowhere it could be mistaken for one.
  const consultation = await send('advisors', lead('advisors', 'consultation', consultationKey, { details: { service: 'strategy', sector: 'Hospice' }, message: `${canary} Please call about a review.` }));
  assert.equal(consultation.status, 202);
  const consultationConversation = await conversationOf(consultation.body.conversation);
  assert.deepEqual([consultationConversation.source_system, consultationConversation.source_key, consultationConversation.inquiry_type],
    ['advisors.web', consultationKey, 'advisors']);
  assert.equal(consultationConversation.product_id, (await row("select id from hub.products where slug = 'advisors'")).id);

  const contact = await send('intel', lead('intel', 'contact', external('contact')));
  assert.equal(contact.status, 202);
  const contactConversation = await conversationOf(contact.body.conversation);
  assert.deepEqual([contactConversation.source_system, contactConversation.inquiry_type, contactConversation.subject],
    ['intel.web', 'sales', 'Contact request: Integration Assisted Living Facility']);
  assert.equal(contactConversation.product_id, (await row("select id from hub.products where slug = 'caremetric-intel'")).id);
  assert.equal((await messagesOf(contactConversation.id))[0].body, 'No message was included with this request.');

  // A message on a kind without a conversation is kept nowhere.
  for (const [source, kind] of [['carebase', 'trial_signup'], ['intel', 'newsletter'], ['carebase', 'savings_model'], ['intel', 'county_report']]) {
    const answer = await send(source, lead(source, kind, external(kind), { details: { state: 'PA' }, message: `${canary} sent with a ${kind}` }));
    assert.deepEqual([answer.status, answer.body.duplicate, answer.body.conversation], [202, false, null], `${kind} is recorded without a conversation`);
    assert.equal((await row('select communication_id from private.leads where id = $1', [answer.body.id])).communication_id, null);
  }
  assert.equal(Number((await row('select count(*) from private.communications where source_key = any($1)', [['trial_signup', 'newsletter', 'savings_model', 'county_report'].map(external)])).count), 0);

  // ---- A repeat is a duplicate and changes nothing ----------------------------------------------------------------
  const repeat = await send('carebase', lead('carebase', 'demo_request', external('demo'), { message: 'A second copy' }));
  assert.deepEqual([repeat.status, repeat.body], [200, { id: demo.body.id, duplicate: true, conversation: demo.body.conversation }]);
  assert.equal((await messagesOf(demoConversation.id)).length, 1, 'the repeat added no message');
  assert.equal(Number((await row("select count(*) from private.audit_events where action = 'lead.received' and entity_id = $1", [demo.body.id])).count), 1);

  // ---- Authentication failures --------------------------------------------------------------------------------------
  const unauthorized = { status: 401, body: { error: 'unauthorized' } };
  const forged = await send('carebase', lead('carebase', 'demo_request', external('forged')), { secret: secrets.intel });
  assert.deepEqual(forged, unauthorized, 'a signature made with another product\'s secret');
  assert.deepEqual(await send('carebase', lead('carebase', 'demo_request', external('old')), { timestamp: Math.floor(Date.now() / 1000) - 301 }), unauthorized, 'an old timestamp');
  assert.deepEqual(await send('carebase', lead('carebase', 'demo_request', external('early')), { timestamp: Math.floor(Date.now() / 1000) + 301 }), unauthorized, 'a timestamp from the future');
  const tampered = await fetch(`${base}/api/leads`, { method: 'POST', body: JSON.stringify(lead('carebase', 'demo_request', external('tampered'))), headers: {
    'Content-Type': 'application/json', 'X-CareMetric-Source': 'carebase', 'X-CareMetric-Timestamp': String(Math.floor(Date.now() / 1000)), 'X-CareMetric-Signature': `v1=${'0'.repeat(64)}` } });
  assert.deepEqual([tampered.status, await tampered.json()], [401, { error: 'unauthorized' }], 'a bad signature');
  assert.equal(Number((await row('select count(*) from private.leads where external_id = any($1)', [['forged', 'old', 'early', 'tampered'].map(external)])).count), 0);

  // ---- Refusals that are not authentication -------------------------------------------------------------------------
  const invalid = await send('carebase', lead('carebase', 'demo_request', external('invalid'), { contact: { email: 'not an address' } }));
  assert.deepEqual(invalid, { status: 400, body: { error: 'invalid_lead' } });
  assert.deepEqual(await send('advisors', lead('advisors', 'consultation', external('advisors-key'))), { status: 400, body: { error: 'invalid_lead' } }, 'an Advisors inquiry needs its CM- reference');
  const tooLarge = await send('carebase', null, { raw: JSON.stringify(lead('carebase', 'contact', external('large'), { message: 'x'.repeat(4000), details: { notes: 'é'.repeat(200) } })).padEnd(16385, ' ') });
  assert.deepEqual(tooLarge, { status: 413, body: { error: 'too_large' } });
  const partly = leadIntake({ pool, secrets: { carebase: secrets.carebase }, enabled: true, limit: 1, log: line => console.info(line) });
  assert.deepEqual(await direct(partly, 'advisors', lead('advisors', 'consultation', advisorsKey())), { status: 503, body: { error: 'not_configured' }, headers: {} });
  assert.equal((await direct(partly, 'carebase', lead('carebase', 'demo_request', external('demo')))).status, 200, 'the first signed request in a minute goes through');
  assert.deepEqual(await direct(partly, 'carebase', lead('carebase', 'demo_request', external('demo'))), { status: 429, body: { error: 'rate_limited' }, headers: {} });
  const undeclared = leadIntake({ pool, secrets, enabled: false, log: line => console.info(line) });
  assert.deepEqual(await direct(undeclared, 'intel', lead('intel', 'contact', external('undeclared'))), { status: 503, body: { error: 'unavailable' }, headers: {} });

  // ---- A probe: recorded as a test, no conversation, left out of the owner's list ----------------------------------
  // probe-<timestamp>, made unique per run so two runs in the same second never meet.
  const probeId = `probe-${Math.floor(Date.now() / 1000)}.${run}`;
  const probe = await send('advisors', lead('advisors', 'consultation', probeId, { test: true, contact: { email: 'probe@caremetric.invalid' } }));
  assert.deepEqual([probe.status, probe.body.conversation], [202, null]);
  assert.equal((await row('select test from private.leads where id = $1', [probe.body.id])).test, true);
  assert.equal(Number((await row('select count(*) from private.communications where source_key = $1', [probeId])).count), 0);

  // ---- Advisors: an inquiry the owner already imported is linked, not duplicated -------------------------------------
  const importedKey = advisorsKey(); advisorsKeys.push(importedKey);
  const imported = await withSession(pool, ownerToken, async db => (await db.query('select hub.import_communications($1, $2::jsonb) as result', ['advisors.web', JSON.stringify([{
    sourceKey: importedKey, receivedAt: new Date(Date.now() - 600000).toISOString(), status: 'open', productSlug: 'advisors', inquiryType: 'advisors',
    subject: 'Consultation request from Integration Hospice', body: 'Imported before the lead arrived.', contactName: 'Integration Visitor', contactEmail: visitorEmail,
    contactPhone: null, organization: 'Integration Hospice' }])])).rows[0].result);
  assert.deepEqual(imported, { created: 1, skipped: 0 });
  const importedConversation = await row('select * from private.communications where source_system = $1 and source_key = $2', ['advisors.web', importedKey]);
  const linked = await send('advisors', lead('advisors', 'consultation', importedKey, { message: 'The same request, forwarded.' }));
  assert.deepEqual([linked.status, linked.body.conversation], [202, `CM-${importedConversation.reference}`], 'the lead names the imported conversation');
  assert.equal((await row('select communication_id from private.leads where id = $1', [linked.body.id])).communication_id, importedConversation.id);
  assert.equal(Number((await row('select count(*) from private.communications where source_system = $1 and source_key = $2', ['advisors.web', importedKey])).count), 1);
  assert.deepEqual((await messagesOf(importedConversation.id)).map(message => message.body), ['Imported before the lead arrived.'], 'no second copy of the request');
  assert.equal((await row('select status from private.communications where id = $1', [importedConversation.id])).status, 'open', 'staff work is untouched');
  // And the other way round: the import skips a request the lead already brought in.
  const reimport = await withSession(pool, ownerToken, async db => (await db.query('select hub.import_communications($1, $2::jsonb) as result', ['advisors.web', JSON.stringify([importedKey, consultationKey].map(key => ({
    sourceKey: key, receivedAt: new Date().toISOString(), status: 'new', productSlug: 'advisors', inquiryType: 'advisors', subject: 'Consultation request',
    body: 'Imported again.', contactName: null, contactEmail: null, contactPhone: null, organization: null })))])).rows[0].result);
  assert.deepEqual(reimport, { created: 0, skipped: 2 });

  // ---- The owner's Leads screen: reads through the RPC allowlist, changes through the owner route ---------------
  const listing = async (args, token = ownerToken) => owned('rpc/list_leads', { p_kind: null, p_source: null, p_include_test: false, p_offset: 0, p_limit: 50, ...args }, token);
  assert.equal((await listing({}, null)).status, 401, 'reading leads needs a session');
  const page = await listing({});
  assert.equal(page.status, 200);
  const parsed = leadPageSchema.parse(page.body);
  const mine = parsed.items.filter(item => leadIds.has(item.id));
  assert.ok(mine.some(item => item.id === demo.body.id), 'the demo request is listed');
  assert.ok(!mine.some(item => item.id === probe.body.id), 'a test lead is left out by default');
  const listedDemo = mine.find(item => item.id === demo.body.id);
  assert.deepEqual([listedDemo.contact.email, listedDemo.contact.role, listedDemo.details, listedDemo.attribution.utmCampaign, listedDemo.conversation?.reference],
    [visitorEmail, 'Administrator', { facilityCount: 2, plan: 'complete' }, `fall-${run}`, demo.body.conversation]);
  const withTests = leadPageSchema.parse((await listing({ p_include_test: true, p_source: 'advisors', p_kind: 'consultation' })).body);
  assert.ok(withTests.items.some(item => item.id === probe.body.id), 'test leads are shown when asked for');
  assert.ok(withTests.items.every(item => item.source === 'advisors' && item.kind === 'consultation'), 'and the filters apply');

  assert.equal((await owned('admin/leads/status', { id: demo.body.id, status: 'contacted', expectedUpdatedAt: listedDemo.updatedAt }, null)).status, 401, 'changing a lead needs a session');
  const changed = await owned('admin/leads/status', { id: demo.body.id, status: 'contacted', expectedUpdatedAt: listedDemo.updatedAt });
  assert.equal(changed.status, 200);
  assert.equal(leadSchema.parse(changed.body).status, 'contacted');
  const stale = await owned('admin/leads/status', { id: demo.body.id, status: 'won', expectedUpdatedAt: listedDemo.updatedAt });
  assert.deepEqual(stale, { status: 409, body: { error: 'This lead changed. Refresh and try again.' } }, 'a stale version is refused');
  assert.equal((await owned('admin/leads/status', { id: randomUUID(), status: 'won', expectedUpdatedAt: listedDemo.updatedAt })).status, 404);
  const statusAudit = await row("select actor_id, metadata, changed_columns from private.audit_events where action = 'lead.status' and entity_id = $1", [demo.body.id]);
  assert.deepEqual([statusAudit.actor_id, statusAudit.metadata, statusAudit.changed_columns], [owner, { from: 'new', to: 'contacted' }, ['status']]);

  // ---- The canary: only the conversation holds what the visitor wrote ------------------------------------------------
  assert.equal(Number((await row('select count(*) from private.communication_messages where strpos(body, $1) > 0', [canary])).count), 2, 'each message reached its own conversation, and only those two');
  assert.equal((await messagesOf(consultationConversation.id))[0].body, `${canary} Please call about a review.\n\nSector: Hospice\nService: strategy`);
  assert.equal(Number((await row('select count(*) from private.leads l where strpos(to_jsonb(l)::text, $1) > 0', [canary])).count), 0, 'no lead row holds it');
  assert.equal(Number((await row('select count(*) from private.communications c where strpos(to_jsonb(c)::text, $1) > 0', [canary])).count), 0, 'no conversation field holds it');
  assert.equal(Number((await row('select count(*) from private.audit_events a where strpos(to_jsonb(a)::text, $1) > 0', [canary])).count), 0, 'no audit event holds it');
  const received = (await admin.query("select metadata from private.audit_events where action = 'lead.received' and entity_id = any($1::uuid[])", [[...leadIds]])).rows;
  assert.equal(received.length, leadIds.size, 'one audit event per lead');
  assert.ok(leadIds.size >= 9 && received.every(entry => Object.keys(entry.metadata).sort().join() === 'kind,source,test'), 'audit metadata is the source, kind and test flag only');
  assert.ok(logs.some(line => line === 'Lead intake: source=carebase outcome=accepted status=202'), 'the handler logged its outcomes');
  for (const line of logs) for (const hidden of [canary, visitorEmail, ...Object.values(secrets)]) assert.ok(!line.includes(hidden), `a log line carried something it must not: ${line.slice(0, 40)}`);
  for (const text of responses) assert.ok(!text.includes(canary), 'no answer carried the message');

  // ---- Retention: a lead twelve months after it arrived, a website conversation twelve months after its last message --
  // Old and recent rows are made directly; a disposable database has nothing else due.
  const retentionCanary = `RETENTION-CANARY-${run}`;
  const idleKey = advisorsKey(); advisorsKeys.push(idleKey);
  const idle = await row(`insert into private.communications (channel, source_system, source_key, status, inquiry_type, subject, contact_email, created_at, updated_at, last_message_at)
    values ('web_form', 'advisors.web', $1, 'closed', 'advisors', 'Consultation request from Retention Hospice', $2, now() - interval '14 months', now() - interval '13 months', now() - interval '13 months')
    returning id`, [idleKey, visitorEmail]);
  await admin.query(`insert into private.communication_messages (communication_id, direction, body, delivery, delivery_channel, created_at)
    values ($1, 'inbound', $2, 'received', null, now() - interval '14 months'), ($1, 'outbound', 'Our answer, long ago.', 'sent', 'email', now() - interval '13 months')`,
    [idle.id, `${retentionCanary} An old consultation request.`]);
  const active = await row(`insert into private.communications (channel, source_system, source_key, subject, created_at, updated_at, last_message_at)
    values ('web_form', 'carebase.web', $1, 'Demo request: Retention Assisted Living Facility', now() - interval '2 years', now() - interval '1 day', now() - interval '1 day')
    returning id`, [external('retention-active')]);
  await admin.query(`insert into private.communication_messages (communication_id, direction, body, delivery, delivery_channel, created_at)
    values ($1, 'inbound', 'An old question.', 'received', null, now() - interval '2 years'), ($1, 'outbound', 'An answer yesterday.', 'sent', 'email', now() - interval '1 day')`,
    [active.id]);
  const mail = await row(`insert into private.communications (channel, source_system, source_key, subject, created_at, updated_at, last_message_at)
    values ('email', 'hub.email', $1, 'An old email', now() - interval '3 years', now() - interval '3 years', now() - interval '3 years') returning id`, [external('retention-mail')]);
  // Two leads 13 months old that named the conversation answered yesterday, and a recent one that named the idle one.
  const oldLeadKeys = [external('retention-old-1'), external('retention-old-2')];
  await admin.query(`insert into private.leads (source, kind, external_id, occurred_at, received_at, contact_email, communication_id)
    select 'carebase', 'demo_request', k.key, now() - interval '13 months', now() - interval '13 months' + k.n * interval '1 minute', $2::text, $3::uuid
    from unnest($1::text[]) with ordinality as k(key, n)`, [oldLeadKeys, visitorEmail, active.id]);
  const recentLead = await row(`insert into private.leads (source, kind, external_id, occurred_at, received_at, contact_email, communication_id)
    values ('advisors', 'consultation', $1, now() - interval '1 day', now() - interval '1 day', $2, $3) returning id`, [idleKey, visitorEmail, idle.id]);

  retentionAuditFloor = Number((await row('select coalesce(max(id), 0) as id from private.audit_events')).id);
  await assert.rejects(admin.query('select private.lead_retention(500)'), error => error.code === '42501', 'only the Hub server runs retention');
  for (const limit of [0, 5001]) {
    await assert.rejects(pool.query('select private.lead_retention($1)', [limit]), error => error.code === '22023', `a batch of ${limit} rows is refused`);
  }
  assert.deepEqual((await pool.query('select private.lead_retention(1) as result')).rows[0].result, { leads: 1, conversations: 1, more: true },
    'a batch of one deletes one lead and one website conversation and says more are due');
  const retention = leadRetention({ pool, enabled: true, log: line => console.info(line), warn: line => console.warn(line) });
  const swept = await retention.tick();
  assert.ok(swept && swept.more === false && swept.leads >= 1 && swept.batches >= 1, 'the server\'s run deletes what is still due');
  assert.equal(await retention.tick(), null, 'and does not run again within six hours');
  assert.equal(Number((await row('select count(*) from private.leads where external_id = any($1)', [oldLeadKeys])).count), 0, 'the old leads are gone');
  assert.equal(Number((await row('select count(*) from private.communications where id = $1', [idle.id])).count), 0, 'the idle website conversation is gone');
  assert.equal(Number((await row('select count(*) from private.communication_messages where communication_id = $1 or strpos(body, $2) > 0', [idle.id, retentionCanary])).count), 0,
    'with its messages');
  assert.deepEqual(await row('select communication_id from private.leads where id = $1', [recentLead.id]), { communication_id: null },
    'a recent lead that named it stays, without the link');
  assert.deepEqual((await messagesOf(active.id)).map(message => message.body), ['An old question.', 'An answer yesterday.'],
    'a website conversation answered yesterday stays with its messages, though the old leads that named it are gone');
  assert.ok(await row('select id from private.communications where id = $1', [mail.id]), 'an old email conversation stays');
  const retentionEvents = (await admin.query("select actor_id, entity_id, metadata from private.audit_events where action = 'lead.retention' and id > $1 order by id", [retentionAuditFloor])).rows;
  assert.ok(retentionEvents.length >= 2 && retentionEvents.every(event => event.actor_id === null && event.entity_id === null
    && Object.keys(event.metadata).sort().join() === 'conversations,leads'), 'each batch that deleted something is audited with its counts only');
  assert.ok(logs.some(line => /^Lead retention: deleted \d+ leads? and \d+ website conversations?\.$/.test(line)), 'the run logged its counts');
  for (const line of logs) for (const hidden of [retentionCanary, visitorEmail, idleKey]) assert.ok(!line.includes(hidden), `a log line carried something it must not: ${line.slice(0, 40)}`);

  // ---- The deployment gate fails closed ---------------------------------------------------------------------------
  {
    const client = await admin.connect();
    try {
      await client.query('begin');
      const before = (await client.query('select hub.get_backend_contract() as c')).rows[0].c;
      await client.query(gate);
      assert.deepEqual((await client.query('select hub.get_backend_contract() as c')).rows[0].c, before, 'the declaration is idempotent');
      await client.query('rollback');
      for (const [sql, message] of [
        ['alter table private.leads disable row level security', /row level security/],
        ['grant select on private.leads to hub_app_server', /must remain closed/],
        ['grant select (contact_email) on private.leads to authenticated', /must remain closed/],
        ['grant insert on private.leads to service_role', /must remain closed/],
        ['alter table private.communications drop constraint communications_source_system_check', /websites as sources/],
        ["alter table private.communications drop constraint communications_source_system_check, add constraint communications_source_system_check check (source_system in ('hub.sms','hub.email','hub.chat','breathe.phone','advisors.web')) not valid", /websites as sources/],
        ['alter function private.lead_intake(text,jsonb) reset search_path', /Hub server only/],
        ['alter function private.lead_intake(text,jsonb) security invoker', /Hub server only/],
        ['grant execute on function private.lead_intake(text,jsonb) to authenticated', /Hub server only/],
        ['revoke execute on function private.lead_intake(text,jsonb) from hub_app_server', /Hub server only/],
        ["create or replace function private.lead_intake(p_source text, p_lead jsonb) returns jsonb language plpgsql security definer set search_path = '' as $$ begin return private.lead_record(p_source, p_lead); end; $$", /Hub server only/],
        ['alter function private.lead_retention(integer) reset search_path', /Lead retention must/],
        ['alter function private.lead_retention(integer) security invoker', /Lead retention must/],
        ['grant execute on function private.lead_retention(integer) to authenticated', /Lead retention must/],
        ['grant execute on function private.lead_retention(integer) to service_role', /Lead retention must/],
        ['revoke execute on function private.lead_retention(integer) from hub_app_server', /Lead retention must/],
        ["create or replace function private.lead_retention(p_limit integer default 500) returns jsonb language plpgsql security definer set search_path = '' as $$ begin return private.lead_retention_batch(p_limit); end; $$", /Lead retention must/],
        ['alter function private.lead_retention_batch(integer) reset search_path', /pinned search path/],
        ['grant execute on function private.lead_retention_batch(integer) to hub_app_server', /internal to the operations/],
        ['alter function private.lead_record(text,jsonb) reset search_path', /pinned search path/],
        ['grant execute on function private.lead_record(text,jsonb) to hub_app_server', /internal to the operations/],
        ['grant execute on function private.lead_json(uuid) to authenticated', /internal to the operations/],
        ['alter function hub.list_leads(text,text,boolean,integer,integer) reset search_path', /administrator session/],
        ['grant execute on function hub.list_leads(text,text,boolean,integer,integer) to anon', /administrator session/],
        ["create or replace function hub.list_leads(p_kind text default null, p_source text default null, p_include_test boolean default false, p_offset integer default 0, p_limit integer default 25) returns jsonb language sql stable security definer set search_path = '' as $$ select '{}'::jsonb $$", /administrator session/],
        ['revoke execute on function hub.update_lead_status(uuid,text,timestamp with time zone) from authenticated', /command session/],
        ["create or replace function hub.update_lead_status(p_id uuid, p_status text, p_expected_updated_at timestamptz) returns jsonb language plpgsql security definer set search_path = '' as $$ begin perform hub.authorize_app_admin(); return null; end; $$", /command session/],
        [`create or replace function hub.get_backend_contract() returns jsonb language sql stable security invoker set search_path='' as $$ select '{"api_version":4,"features":[]}'::jsonb $$`, /unified communications first/],
      ]) {
        await client.query('begin');
        try {
          await client.query(sql);
          await assert.rejects(client.query(gate), rejection => rejection.code === '55000' && message.test(rejection.message), sql);
        } finally { await client.query('rollback'); }
      }
    } finally { client.release(); }
  }

  original.log('Website leads: every kind through the signed route as hub_app_server, duplicates, forged, stale and early signatures, size, rate and configuration refusals, probes without conversations, Advisors imports linked both ways, the owner\'s list and status changes with a real session, a message that reached only its conversation, retention of old leads and idle website conversations as hub_app_server, and a deployment gate that fails closed.');
} finally {
  for (const [name, fn] of Object.entries(original)) console[name] = fn;
  const problems = [];
  const attempt = async (sql, params = []) => { try { await admin.query(sql, params); } catch (error) { problems.push(`${error.message} [${sql.slice(0, 70)}]`); } };
  const ids = [...leadIds];
  const fromLeads = (await admin.query("select id, communication_id from private.leads where id = any($1::uuid[]) or contact_email = $2 or external_id like $3 or external_id = any($4)",
    [ids, visitorEmail, `leads-int-${run}-%`, advisorsKeys]).catch(() => ({ rows: [] }))).rows;
  const conversations = [...new Set([...fromLeads.map(entry => entry.communication_id).filter(Boolean),
    ...(await admin.query("select id from private.communications where (source_system = 'advisors.web' and source_key = any($1)) or source_key like $2 or contact_email = $3",
      [advisorsKeys, `leads-int-${run}-%`, visitorEmail]).catch(() => ({ rows: [] }))).rows.map(entry => entry.id)])];
  await attempt('delete from private.audit_events where (entity_type = $1 and entity_id = any($2::uuid[])) or actor_id = $3', ['lead', fromLeads.map(entry => entry.id), owner]);
  await attempt('delete from private.leads where id = any($1::uuid[])', [fromLeads.map(entry => entry.id)]);
  await attempt('delete from private.communications where id = any($1::uuid[])', [conversations]);
  if (retentionAuditFloor !== null) await attempt("delete from private.audit_events where action = 'lead.retention' and id > $1", [retentionAuditFloor]);
  await attempt('delete from private.sms_sessions where user_id = $1', [owner]);
  await attempt('delete from private.sms_identities where user_id = $1', [owner]);
  await attempt('delete from private.staff_permissions where user_id = $1', [owner]);
  await attempt('delete from hub.profiles where id = $1', [owner]);
  await attempt('delete from auth.users where id = $1', [owner]);
  await new Promise(resolve => server.close(resolve));
  await pool.end();
  await admin.end();
  if (problems.length) { console.error(`Teardown problems: ${problems.join(' | ')}`); process.exitCode = 1; }
}
