// The Sales Executive's hand-off through the actual Hub server role, on disposable local fixtures only. The server pool logs in as
// hub_app_server exactly like production and calls private.sales_handoff through the real agent store; fixtures are written as a
// superuser so each is exactly what the check needs. No model is called and nothing is sent.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { sqlAgentStore } from './agents/store.mjs';

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
const store = sqlAgentStore(pool, { fenced: true, growth: true });

const run = randomUUID().slice(0, 8);
const row = async (sql, params = []) => (await admin.query(sql, params)).rows[0];
const original = await row("select status, autonomy from private.agents where key = 'sales_executive'");
assert.ok(original, 'The Sales Executive is seeded');
const conversations = [];
const messages = [];
const organizations = [];

async function conversation({ channel = 'email', system = 'hub.email', product = null, inquiry = 'unclassified', status = 'new', email = `prospect.${run}@example.test`, provider = null, body = 'How much is it?' }) {
  const created = await row(`insert into private.communications(channel, source_system, source_key, product_id, inquiry_type, status, subject, contact_email)
    values ($1, $2, $3, (select id from hub.products where slug = $4), $5, $6, 'A question', $7) returning id, reference`,
  [channel, system, `sales-it-${run}-${conversations.length}`, product, inquiry, status, email]);
  conversations.push(created.id);
  const message = await row(`insert into private.communication_messages(communication_id, direction, body, delivery, provider_message_id)
    values ($1, 'inbound', $2, 'received', $3) returning id`, [created.id, body, provider]);
  messages.push(message.id);
  return { id: created.id, reference: Number(created.reference), message: message.id };
}
const handoff = (c, messageId = c.message) => store.salesHandoff({ communicationId: c.id, messageId });
const taskFor = messageId => row("select agent_key, kind, status, payload, priority, source_kind, source_ref from private.agent_tasks where request_key = $1", [`sales:${messageId}`]);

try {
  const lead = await conversation({ channel: 'web_form', system: 'carebase.web', product: 'carebase', inquiry: 'sales' });
  const billing = await conversation({ product: 'carebase', inquiry: 'billing', provider: `email:${run}-billing` });
  const advisors = await conversation({ channel: 'web_form', system: 'advisors.web', product: 'advisors', inquiry: 'advisors' });
  const support = await conversation({ product: 'carebase', inquiry: 'technical_support', provider: `email:${run}-support` });
  const closed = await conversation({ channel: 'web_form', system: 'intel.web', product: 'caremetric-intel', inquiry: 'sales', status: 'closed' });

  // A growth contact replying to outreach from the address on file, in an unclassified conversation with no product.
  const org = await row("insert into private.growth_organizations(name, domain) values ($1, $2) returning id", [`Sales IT ${run}`, `sales-it-${run}.example.test`]);
  organizations.push(org.id);
  const contact = await row("insert into private.growth_contacts(organization_id, email, eligibility) values ($1, $2, 'permitted') returning id", [org.id, `info@sales-it-${run}.example.test`]);
  await admin.query("insert into private.growth_opportunities(organization_id, product, contact_id, stage) values ($1, 'caremetric-intel', $2, 'contacted')", [org.id, contact.id]);
  const reply = await conversation({ email: `info@sales-it-${run}.example.test`, provider: `email:${run}-reply`, body: 'Thanks. How does the trial work?' });
  // The same address typed into a chat or a form is a visitor's claim: it binds nobody.
  const claimed = await conversation({ channel: 'web_form', system: 'advisors.web', email: `info@sales-it-${run}.example.test` });

  await admin.query("update private.agents set status = 'paused', autonomy = 'propose' where key = 'sales_executive'");
  assert.deepEqual(await handoff(lead), { handoff: false, reason: 'sales_executive_off' }, 'A paused Sales Executive takes nothing');
  assert.equal(await taskFor(lead.message), undefined);

  await admin.query("update private.agents set status = 'active' where key = 'sales_executive'");
  assert.deepEqual(await handoff(lead), { handoff: true, product: 'carebase' }, 'A CareBase lead is handed over');
  assert.deepEqual(await taskFor(lead.message), {
    agent_key: 'sales_executive', kind: 'sales.reply', status: 'queued', priority: 3, source_kind: 'communication', source_ref: `CM-${lead.reference}`,
    payload: { communicationId: lead.id, messageId: lead.message, product: 'carebase' },
  }, 'Its task carries ids and the product only');
  assert.deepEqual(await handoff(lead), { handoff: true, product: 'carebase' }, 'Handing it over again is harmless');
  assert.equal(Number((await row("select count(*) from private.agent_tasks where request_key = $1", [`sales:${lead.message}`])).count), 1, 'and makes no second task');

  assert.deepEqual(await handoff(reply), { handoff: true, product: 'caremetric-intel' }, 'A reply to outreach from the contact on file is handed over for its opportunity\'s product');
  assert.deepEqual((await taskFor(reply.message)).payload.opportunity, { stage: 'contacted', contacted: false }, 'with the stage the Sales Executive needs');

  assert.deepEqual(await handoff(billing), { handoff: false, reason: 'not_sales' }, 'Billing stays with the owner');
  assert.deepEqual(await handoff(closed), { handoff: false, reason: 'not_sales' }, 'A closed conversation is not reopened');
  assert.deepEqual(await handoff(advisors), { handoff: false, reason: 'not_prospect' }, 'Advisors consultations stay with the owner');
  assert.deepEqual(await handoff(support), { handoff: false, reason: 'not_prospect' }, 'A support question from someone unknown stays with the Concierge');
  assert.deepEqual(await handoff(claimed), { handoff: false, reason: 'not_prospect' }, 'An address typed into a form binds no growth contact');
  assert.deepEqual(await handoff(lead, billing.message), { handoff: false, reason: 'not_found' }, 'A message from another conversation is refused');

  await admin.query("update private.growth_opportunities set stage = 'paying' where organization_id = $1", [org.id]);
  const customer = await conversation({ email: `info@sales-it-${run}.example.test`, provider: `email:${run}-customer`, body: 'A question about our account.' });
  assert.deepEqual(await handoff(customer), { handoff: false, reason: 'not_prospect' }, 'A paying customer is the Account Manager\'s, not sold to again');

  await admin.query("update private.agents set autonomy = 'observe' where key = 'sales_executive'");
  const later = await conversation({ channel: 'web_form', system: 'intel.web', product: 'caremetric-intel', inquiry: 'sales' });
  assert.deepEqual(await handoff(later), { handoff: false, reason: 'sales_executive_off' }, 'An observe-only Sales Executive takes nothing');

  await assert.rejects(admin.query('select private.sales_handoff($1, $2)', [lead.id, lead.message]), error => error.code === '42501', 'Only the Hub server may hand over');
  console.log('Sales Executive hand-off checks passed.');
} finally {
  await admin.query('delete from private.agent_tasks where request_key = any($1::text[])', [messages.map(id => `sales:${id}`)]);
  await admin.query('delete from private.growth_opportunities where organization_id = any($1::uuid[])', [organizations]);
  await admin.query('delete from private.growth_contacts where organization_id = any($1::uuid[])', [organizations]);
  await admin.query('delete from private.growth_organizations where id = any($1::uuid[])', [organizations]);
  await admin.query('delete from private.communications where id = any($1::uuid[])', [conversations]);
  await admin.query("update private.agents set status = $1, autonomy = $2 where key = 'sales_executive'", [original.status, original.autonomy]);
  await Promise.all([pool.end(), admin.end()]);
}
