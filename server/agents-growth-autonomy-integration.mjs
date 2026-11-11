// Sales follow-ups and capped cold email through the real roles: the contact finder keeps only a role address found on a business's
// own website, rule-based qualification, the two autonomy steps (trusted, supervised, withdrawn), cold email kept out of the product
// policy's automatic path, one business contacted once, at most ten cold emails a day, a policy that no longer overwrites an agent's
// list, the daily evaluation, and the gate's drift checks. Disposable loopback database only; websites and mail are fakes.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { digest, withSession } from './sms-auth.mjs';
import { growthStore } from './growth/store.mjs';
import { sqlAgentStore } from './agents/store.mjs';
import { growthHandlers, growthAutonomyFeature, unchangedSinceCancelled } from './growth/worker.mjs';
import { growthContactFinder } from './growth/contacts.mjs';

const databaseUrl = process.env.HUB_TEST_DATABASE_URL;
const local = new URL(databaseUrl);
assert.equal(local.hostname, '127.0.0.1'); assert.equal(local.port, '54322');
const admin = new pg.Pool({ connectionString: databaseUrl });
await admin.query("alter role hub_app_server login password 'ephemeral-test-only'");
const appUrl = new URL(databaseUrl); appUrl.username = 'hub_app_server'; appUrl.password = 'ephemeral-test-only';
const pool = new pg.Pool({ connectionString: appUrl.href });
const store = growthStore(pool), agents = sqlAgentStore(pool, { fenced: true, growth: true });
const run = randomUUID().slice(0, 8), owner = randomUUID(), token = `growth-autonomy-${randomUUID()}`, source = `growth-autonomy-integration:${run}`;
const features = new Set([growthAutonomyFeature]);
const row = async (sql, values = []) => (await admin.query(sql, values)).rows[0];
const refused = code => error => error?.code === code;
const ownerCall = (fn, values) => withSession(pool, token, async db => (await db.query(`select ${fn}(${values.map((_, i) => `$${i + 1}`).join(',')}) as r`, values)).rows[0].r);
const gate = await readFile(new URL('../supabase/migrations/20261105150100_growth_autonomy_contract.sql', import.meta.url), 'utf8');
const seedAgents = (await admin.query("select key,status,autonomy,config from private.agents where key in ('marketing_manager','account_manager')")).rows;
const seedPolicies = (await admin.query('select * from private.growth_policies')).rows;
const seedSteps = (await admin.query("select * from private.agent_autonomy_steps where category in ('sales_followups','cold_email')")).rows;
const runStart = (await row('select now() as t')).t;
const domains = [], suppressed = [], tasks = [];
const domainOf = label => { const value = `${label}-${run}.example.org`; domains.push(value); return value; };
const task = async () => {
  const id = (await row("insert into private.agent_tasks(agent_key,kind,request_key,status,attempts,lease_until) values('marketing_manager','growth.pipeline',$1,'running',1,now()+interval '10 minutes') returning id", [`growth-autonomy:${run}:${randomUUID()}`])).id;
  tasks.push(id); return id;
};
const step = (category, action) => admin.query('select private.agent_autonomy_apply($1,$2,null,$3)', [category, action, source]);
const kinds = async key => (await row('select config from private.agents where key=$1', [key])).config.auto_approve_kinds;
const orgId = async domain => (await row('select id from private.growth_organizations where domain=$1', [domain])).id;
const opportunityOf = async (domain, product = 'carebase') => row('select o.* from private.growth_opportunities o join private.growth_organizations g on g.id=o.organization_id where g.domain=$1 and o.product=$2', [domain, product]);
const discovered = (domain, path = '/about') => ({ name: `Synthetic ${domain}`, domain, url: `https://${domain}${path}`, claim: 'A personal care home serving older adults.' });
// Researched with a fresh, cited assessment, then qualified by the rules (the only way a found business becomes qualified).
async function assess(domain, product = 'carebase', fit = 82) {
  const o = await opportunityOf(domain, product);
  const evidence = (await admin.query('select id from private.growth_evidence where opportunity_id=$1', [o.id])).rows.map(e => e.id);
  assert.equal(await store.assess(o.id, { fit, intent: null, rationale: 'Synthetic assessment.', citations: evidence, nextAction: 'Qualify', version: o.version }), true);
  return opportunityOf(domain, product);
}
// A drafted, model-written outreach message proposed by the Marketing Manager; returns the message and its action.
async function propose(domain, product = 'carebase', key = 'outreach:0', modelGenerated = true) {
  const o = await opportunityOf(domain, product);
  const versions = await row('select o.version,c.version as "contactVersion",p.version as "policyVersion" from private.growth_opportunities o join private.growth_contacts c on c.id=o.contact_id join private.growth_policies p on p.product=o.product where o.id=$1', [o.id]);
  const work = await store.plan(o.id, { key, kind: 'outreach', action: 'Offer a conversation.', success: 'Qualified reply.', owner: 'marketing_manager', dueAt: new Date().toISOString() });
  const citations = (await admin.query('select id from private.growth_evidence where opportunity_id=$1', [o.id])).rows.map(e => e.id);
  const draft = await store.draft(o.id, work, { ...versions, purpose: 'marketing', subject: 'A question about staff training', body: 'Would a short conversation about staff training records be useful?', citations, unsubscribeHash: digest(`${work}:${run}`), modelGenerated });
  const action = await store.propose(await task(), draft.id);
  return { id: draft.id, action: action.id, status: action.status };
}
const approve = id => ownerCall('hub.decide_agent_action', [id, 'approve', 'Reviewed synthetic message.']);
const claim = async message => { await agents.beginExecution(message.action); return store.claim(message.id, message.action); };
// One opportunity's entry in the pipeline's snapshot, as the sweep reads it.
const snapshotOf = async opportunityId => {
  for (let offset = 0; ; offset += 100) {
    const page = await store.snapshot(offset);
    const hit = page.items.find(item => item.id === opportunityId);
    if (hit || page.items.length === 0) return hit;
  }
};
const messageStatus = async id => (await row('select status from private.growth_messages where id=$1', [id])).status;
// A fake web: only the URLs listed answer. Every request is recorded.
const fetched = [];
const page = (body, type = 'text/html') => new Response(body, { status: 200, headers: { 'content-type': type } });
const web = {};
const fetchImpl = async url => { fetched.push(url); return web[url]?.() ?? new Response('Not found', { status: 404 }); };
const finder = growthContactFinder({ fetchImpl, lookup: async () => [{ address: '93.184.216.34', family: 4 }] });

try {
  await admin.query('insert into auth.users(id,email,is_anonymous) values($1,$2,false)', [owner, `growth-autonomy-owner-${run}@test.invalid`]);
  await admin.query("insert into private.staff_permissions(user_id,permission) values($1,'platform.admin')", [owner]);
  await admin.query("insert into private.sms_identities(user_id,phone_e164,verified_at) values($1,'+12025550972',now())", [owner]);
  await admin.query("insert into private.sms_sessions(id,token_hash,user_id,identity_version,expires_at) select $1,$2,user_id,identity_version,now()+interval '1 hour' from private.sms_identities where user_id=$3", [randomUUID(), digest(token), owner]);
  await admin.query("update private.agents set status='active',autonomy='propose',config=jsonb_set(config,'{auto_approve_kinds}','[]') where key in ('marketing_manager','account_manager')");
  for (const p of await admin.query('select * from private.growth_policies').then(r => r.rows)) {
    await store.manage(token, 'policy', { product: p.product, version: p.version, enabled: true, autoSend: false, dailyLimit: 50, minGapHours: 24, maxTouches: 3, bookingUrl: '', approvedClaim: 'Discuss staff training records.' });
  }

  // ---- 1. Steps ship off and the evaluation is scheduled -------------------------------------------------------------------
  assert.deepEqual((await admin.query("select category,status,requires_feature from private.agent_autonomy_steps where category in ('sales_followups','cold_email') order by category")).rows,
    [{ category: 'cold_email', status: 'off', requires_feature: growthAutonomyFeature }, { category: 'sales_followups', status: 'off', requires_feature: growthAutonomyFeature }]);
  assert.ok(await row("select 1 from private.agent_schedules where agent_key='marketing_manager' and task_kind='growth.evaluate' and cadence='daily' and not requires_session"));

  // ---- 2. Discovery reads each new business's own site and keeps only a role address on its domain ---------------------------
  const found = domainOf('cold-found'), personal = domainOf('cold-personal'), closed = domainOf('cold-robots');
  web[`https://${found}/contact`] = () => page('<a href="mailto:jane.doe@' + found + '">Jane</a> Write to <a href="mailto:info@' + found + '">info@' + found + '</a> or office@elsewhere.example.org');
  web[`https://${personal}/`] = () => page('Ask for pat@' + personal + ' or call 555-0100.');
  web[`https://${closed}/robots.txt`] = () => page('User-agent: *\nDisallow: /', 'text/plain');
  web[`https://${closed}/contact`] = () => page('info@' + closed);
  const research = { configured: true, search: async product => (product === 'carebase' ? [found, personal, closed].map(d => discovered(d)) : []) };
  const pending = await store.contactCandidates(20);
  assert.deepEqual(pending.map(entry => entry.domain).filter(d => !domains.includes(d)), [], 'no other discovered business is waiting');
  const discovery = await growthHandlers({ growth: { store, research, contacts: finder }, features })['growth.discovery']({ id: await task(), agent: { autonomy: 'propose' } });
  assert.deepEqual(discovery.result, { candidates: 3, contacts: { searched: 3, found: 1, none: 2 }, qualified: 0, enrichment: { searched: 3, evidenceRows: 3 } });
  assert.ok(!JSON.stringify(discovery).includes('@'), 'the task result holds no address');
  const foundContact = await row("select c.* from private.growth_contacts c join private.growth_organizations g on g.id=c.organization_id where g.domain=$1", [found]);
  assert.deepEqual([foundContact.email, foundContact.source_kind, foundContact.eligibility, foundContact.source_url], [`info@${found}`, 'role_address', 'permitted', `https://${found}/contact`]);
  for (const d of [personal, closed]) assert.equal((await row('select count(*)::integer as n from private.growth_contacts c join private.growth_organizations g on g.id=c.organization_id where g.domain=$1', [d])).n, 0, `${d} gets no contact`);
  assert.ok(!fetched.some(url => url.startsWith(`https://${closed}/`) && !url.endsWith('/robots.txt')), 'a site whose robots.txt forbids it is not read');
  assert.ok((await row('select contact_searched_at from private.growth_organizations where domain=$1', [personal])).contact_searched_at, 'a searched business is not searched again for 90 days');
  assert.deepEqual((await store.contactCandidates(20)).filter(entry => domains.includes(entry.domain)), []);
  assert.equal((await opportunityOf(found)).contact_id, foundContact.id);

  // The database admits only a role address on the business's own domain, found on that domain, and never one that unsubscribed.
  const foundOrg = await orgId(found);
  await assert.rejects(store.recordContact(foundOrg, 'info@elsewhere.example.org', `https://${found}/contact`), refused('22023'), 'another domain');
  await assert.rejects(store.recordContact(foundOrg, `info@${found}`, `https://directory.example.org/${found}`), refused('22023'), 'found off the business site');
  await assert.rejects(store.recordContact(foundOrg, `info@${found}`, `http://${found}/contact`), refused('22023'), 'plain http');
  const personalOrg = await orgId(personal);
  await assert.rejects(store.recordContact(personalOrg, `pat@${personal}`, `https://${personal}/`), refused('23514'), 'a personal address is never admitted');
  suppressed.push(digest(`office@${personal}`));
  await admin.query('insert into private.email_suppressions(email_hash) values($1) on conflict do nothing', [digest(`office@${personal}`)]);
  assert.deepEqual(await store.recordContact(personalOrg, `office@${personal}`, `https://${personal}/`), { found: false, reason: 'suppressed' });
  const second = await store.recordContact(foundOrg, `sales@${found}`, `https://${found}/contact`);
  assert.equal(second.contactId, foundContact.id, 'one finder contact per business; a second address is not added');
  assert.equal((await row('select count(*)::integer as n from private.growth_contacts where organization_id=$1', [foundOrg])).n, 1);
  const ownerOrg = domainOf('owner-added');
  await store.manage(token, 'create', { name: 'Synthetic owner organization', domain: ownerOrg, product: 'caremetric-intel', email: `buyer@${ownerOrg}`, contactName: 'Buyer', role: 'Director', goal: 'Evaluate.' });
  await assert.rejects(store.recordContact(await orgId(ownerOrg), `info@${ownerOrg}`, `https://${ownerOrg}/`), refused('22023'), 'only businesses found online');
  await assert.rejects(pool.query('select * from private.growth_contacts'), refused('42501'));
  await assert.rejects(admin.query('select private.growth_contact_candidates(5)'), refused('42501'), 'server role only');

  // ---- 3. Qualification from the assessment, by the versioned rules -------------------------------------------------------
  const low = domainOf('cold-low');
  await store.discover('carebase', [discovered(low)]);
  await store.recordContact(await orgId(low), `contact@${low}`, `https://${low}/about`);
  await assess(found);
  await assess(low, 'carebase', 60);
  assert.equal((await store.autoQualify(100)).rules, 'qualify.1');
  assert.equal((await opportunityOf(found)).stage, 'qualified');
  assert.equal((await opportunityOf(found)).memory.qualifiedBy, 'qualify.1');
  assert.equal((await opportunityOf(low)).stage, 'researched', 'below the fit threshold');
  assert.ok(await row("select 1 from private.audit_events where action='growth.auto_qualified' and created_at>=$1", [runStart]));

  // ---- 4. A product policy adds or removes only its own value ---------------------------------------------------------------
  await step('cold_email', 'supervise');
  await step('cold_email', 'automatic');
  assert.deepEqual(await kinds('marketing_manager'), ['growth.cold_email']);
  const policy = async (product, autoSend) => {
    const p = await row('select * from private.growth_policies where product=$1', [product]);
    await store.manage(token, 'policy', { product, version: p.version, enabled: true, autoSend, dailyLimit: p.daily_limit, minGapHours: p.min_gap_hours, maxTouches: p.max_touches, bookingUrl: '', approvedClaim: p.approved_claim });
  };
  await policy('carebase', true);
  assert.deepEqual(await kinds('marketing_manager'), ['growth.cold_email', 'growth.message']);
  assert.deepEqual(await kinds('account_manager'), ['growth.message']);
  await policy('carebase', false);
  assert.deepEqual(await kinds('marketing_manager'), ['growth.cold_email'], 'turning the policy off removes only growth.message');
  assert.deepEqual(await kinds('account_manager'), []);

  // ---- 5. Cold email the owner handed over: approved on its own, but only after the daily evaluation passes ---------------------
  const trusted = await propose(found);
  assert.equal(trusted.status, 'auto_approved');
  await admin.query("insert into private.agent_evaluations(product,version,passed,results) values('carebase','growth.1',false,'[]')");
  assert.deepEqual(await claim(trusted), { send: false, status: 'evaluation_required' });
  await admin.query("update private.agent_actions set status='auto_approved',executing_at=null where id=$1", [trusted.action]);
  const evaluated = await growthHandlers({ growth: { store }, features })['growth.evaluate']({ id: await task(), agentKey: 'marketing_manager' });
  assert.deepEqual(evaluated.result.failed, []);
  assert.equal((await row("select count(*)::integer as n from private.agent_evaluations where version='growth.1' and passed and created_at>=$1", [runStart])).n, 2);
  // Withdrawn before it went: never sent, and the message is cancelled.
  await step('cold_email', 'hold');
  assert.deepEqual(await kinds('marketing_manager'), []);
  assert.deepEqual(await claim(trusted), { send: false, status: 'outreach_off' });
  assert.equal(await messageStatus(trusted.id), 'cancelled');
  // The sweep sees the withdrawal: it drafts this work again.
  const withdrawnEntry = await snapshotOf((await opportunityOf(found)).id);
  const withdrawnWork = withdrawnEntry.work.find(w => w.message_id === trusted.id);
  assert.equal(withdrawnWork.message_withdrawn, true);
  assert.equal(unchangedSinceCancelled(withdrawnWork, withdrawnEntry), false);
  // The withdrawn message no longer holds its work: the same work, unchanged, is drafted again and goes to the owner.
  const redrafted = await propose(found);
  assert.notEqual(redrafted.id, trusted.id);
  assert.equal(redrafted.status, 'proposed', 'held: the work comes back to the owner');
  assert.equal(await messageStatus(trusted.id), 'cancelled', 'the withdrawn message is kept, never sent');
  // Any other cancellation keeps the key: unchanged work is not drafted again.
  await admin.query("update private.growth_messages set status='cancelled' where id=$1", [redrafted.id]);
  const versionsOf = await row('select work_id,opportunity_version,contact_version,policy_version from private.growth_messages where id=$1', [redrafted.id]);
  const sameDraft = await store.draft((await opportunityOf(found)).id, versionsOf.work_id, { version: versionsOf.opportunity_version, contactVersion: versionsOf.contact_version,
    policyVersion: versionsOf.policy_version, purpose: 'marketing', subject: 'Again', body: 'Again?', citations: [], unsubscribeHash: digest(randomUUID()), modelGenerated: true });
  assert.equal(sameDraft.id, redrafted.id);
  assert.equal(sameDraft.status, 'cancelled');
  // ... and the sweep knows it before paying for a draft: the snapshot reports the cancelled message, not withdrawn, at today's versions.
  const cancelledEntry = await snapshotOf((await opportunityOf(found)).id);
  const cancelledWork = cancelledEntry.work.find(w => w.id === versionsOf.work_id);
  assert.deepEqual([cancelledWork.message_id, cancelledWork.message_status, cancelledWork.message_withdrawn], [redrafted.id, 'cancelled', false]);
  assert.equal(unchangedSinceCancelled(cancelledWork, cancelledEntry), true);

  // ---- 6. Supervised: proposed, the owner's approval sends it; cold email never rides the product policy ---------------------------
  await step('cold_email', 'supervise');
  await policy('carebase', true);
  const template = await propose(found, 'carebase', 'outreach:template', false);
  assert.equal(template.status, 'proposed', 'cold email is never approved by the product policy, even as a template');
  await admin.query("update private.agent_actions set status='auto_approved' where id=$1", [template.action]);
  assert.deepEqual(await claim(template), { send: false, status: 'outreach_off' }, 'and claiming refuses it if it was approved anyway');
  await policy('carebase', false);
  const supervised = await propose(found, 'carebase', 'outreach:supervised');
  assert.equal(supervised.status, 'proposed');
  await approve(supervised.action);
  const sent = await claim(supervised);
  assert.equal(sent.send, true);
  assert.equal(sent.to, `info@${found}`);
  await store.finish(supervised.id, 'accepted', 'synthetic-provider');

  // ---- 7. One business, contacted once: a second product's first touch to the same business is refused ----------------------
  await store.discover('caremetric-intel', [discovered(found, '/services')]);
  await store.recordContact(foundOrg, `info@${found}`, `https://${found}/contact`);
  await assess(found, 'caremetric-intel');
  await store.autoQualify(100);
  assert.equal((await opportunityOf(found, 'caremetric-intel')).stage, 'qualified');
  const again = await propose(found, 'caremetric-intel', 'outreach:0');
  await approve(again.action);
  assert.deepEqual(await claim(again), { send: false, status: 'business_contacted' });
  assert.equal(await messageStatus(again.id), 'cancelled');

  // ---- 8. Sales follow-ups: a contact the owner added; trusted, then withdrawn ----------------------------------------------------
  const followUp = await opportunityOf(ownerOrg, 'caremetric-intel');
  await store.manage(token, 'opportunity', { id: followUp.id, version: followUp.version, stage: 'qualified', goal: 'Evaluate.', nextAction: 'Offer a conversation', nextAt: new Date().toISOString(), trialEnd: '', renewalAt: '', memory: {} });
  await store.manage(token, 'contact', { id: followUp.contact_id, version: 1, eligibility: 'permitted', verified: true, sourceUrl: `https://${ownerOrg}/team` });
  await store.manage(token, 'evidence', { opportunityId: followUp.id, sourceUrl: `https://${ownerOrg}/about`, claim: 'A referral-driven home health agency.', confidence: 'high', observedAt: new Date().toISOString() });
  await step('sales_followups', 'supervise');
  await step('sales_followups', 'automatic');
  assert.deepEqual(await kinds('marketing_manager'), ['growth.sales_followup']);
  const followed = await propose(ownerOrg, 'caremetric-intel', 'outreach:0');
  assert.equal(followed.status, 'auto_approved', 'a model-written follow-up goes on its own once handed over');
  const followSent = await claim(followed);
  assert.equal(followSent.send, true);
  await store.finish(followed.id, 'accepted', 'synthetic-provider');
  const withdrawn = await propose(ownerOrg, 'caremetric-intel', 'outreach:1');
  assert.equal(withdrawn.status, 'auto_approved');
  await step('sales_followups', 'hold');
  assert.deepEqual(await claim(withdrawn), { send: false, status: 'outreach_off' });
  const heldProposal = await propose(ownerOrg, 'caremetric-intel', 'outreach:2');
  assert.equal(heldProposal.status, 'proposed', 'held: back to the owner');
  // Paused (or moved to Observe) while an automatic message waits: it is withdrawn, not left proposed behind an error; a message
  // the owner approved is still refused as before.
  await step('sales_followups', 'automatic');
  const pausedAway = await propose(ownerOrg, 'caremetric-intel', 'outreach:3');
  assert.equal(pausedAway.status, 'auto_approved');
  const ownerApproved = await propose(ownerOrg, 'caremetric-intel', 'outreach:4');
  await admin.query("update private.agent_actions set status='proposed' where id=$1", [ownerApproved.action]);
  await approve(ownerApproved.action);
  await admin.query("update private.agents set status='paused' where key='marketing_manager'");
  try {
    assert.deepEqual(await claim(pausedAway), { send: false, status: 'outreach_off' });
    assert.equal(await messageStatus(pausedAway.id), 'cancelled');
    await assert.rejects(claim(ownerApproved), refused('42501'), 'an owner-approved message from a paused agent is refused as before');
  } finally {
    await admin.query("update private.agents set status='active' where key='marketing_manager'");
  }
  const observed = await propose(ownerOrg, 'caremetric-intel', 'outreach:5');
  assert.equal(observed.status, 'auto_approved');
  await admin.query("update private.agents set autonomy='observe' where key='marketing_manager'");
  try {
    assert.deepEqual(await claim(observed), { send: false, status: 'outreach_off' });
  } finally {
    await admin.query("update private.agents set autonomy='act' where key='marketing_manager'");
  }
  await step('sales_followups', 'hold');

  // ---- 9. At most ten cold emails a day, across both products, however each was approved -------------------------------------------
  const already = (await row("select count(*)::integer as n from private.growth_messages m join private.growth_contacts c on c.id=m.contact_id where c.source_kind='role_address' and m.purpose='marketing' and m.attempted_at>=private.agent_day_start()")).n;
  assert.equal(already, 1);
  const bulk = Array.from({ length: 10 }, (_, i) => domainOf(`cold-bulk-${i}`));
  await store.discover('carebase', bulk.map(d => discovered(d)));
  for (const d of bulk) { await store.recordContact(await orgId(d), `hello@${d}`, `https://www.${d}/contact`); await assess(d); }
  await store.autoQualify(100);
  const outcomes = [];
  for (const d of bulk) {
    const message = await propose(d);
    await approve(message.action);
    outcomes.push((await claim(message)).status ?? 'sending');
  }
  assert.deepEqual(outcomes, [...Array(9).fill('sending'), 'daily_limit'], 'the tenth business of the day waits for tomorrow');

  // ---- 10. The gate declares the feature again as it is, and refuses drift ---------------------------------------------------------
  const client = await admin.connect();
  const rewrite = (signature, from, to) => `do $d$ begin execute replace(pg_get_functiondef('${signature}'::regprocedure), '${from.replaceAll("'", "''")}', '${to.replaceAll("'", "''")}'); end $d$`;
  try {
    await client.query('begin'); await client.query(gate); await client.query(gate); await client.query('rollback');
    for (const drift of [
      'grant execute on function private.growth_record_contact(uuid,text,text) to authenticated',
      'revoke execute on function private.growth_auto_qualify(integer) from hub_app_server',
      'alter table private.growth_contacts drop constraint growth_contacts_role_address_check',
      'alter table private.growth_qualification_rules disable row level security',
      "delete from private.agent_autonomy_steps where category='cold_email'",
      "delete from private.agent_schedules where agent_key='marketing_manager' and task_kind='growth.evaluate'",
      rewrite('private.growth_claim_message(uuid,uuid)', 'where key=a.agent_key for share', 'where key=a.agent_key'),
      rewrite('private.growth_claim_message(uuid,uuid)', 'v_cold_sent >= 10 then', 'v_cold_sent >= 99 then'),
      rewrite('private.growth_claim_message(uuid,uuid)', 'not m.model_generated and not v_cold', 'true'),
      rewrite('private.growth_propose(uuid,uuid)', "v_agent.autonomy='act'", 'true'),
      rewrite('private.growth_propose(uuid,uuid)', "m.model_generated or v_class='growth.cold_email'", 'm.model_generated'),
      rewrite('hub.growth_manage(text,jsonb)', "v<>'growth.message'", "v<>'growth.other'"),
      rewrite('private.growth_record_contact(uuid,text,text)', 'email_suppressions', 'growth_contacts'),
      rewrite('private.growth_claim_message(uuid,uuid)', "set status='cancelled',withdrawn_at=now()", "set status='cancelled'"),
      rewrite('private.growth_draft(uuid,uuid,jsonb)', 'where withdrawn_at is null do nothing', 'do nothing'),
      'drop index private.growth_messages_draft_key',
    ]) {
      await client.query('begin');
      try { await client.query(drift); await assert.rejects(client.query(gate), refused('55000'), drift); }
      finally { await client.query('rollback'); }
    }
  } finally { client.release(); }

  console.log('Sales follow-ups and cold email integration passed: role addresses only from the business\'s own site (robots honoured, personal and off-domain addresses refused, unsubscribes kept), qualification by versioned rules, a policy that adds or removes only its own value, trusted/supervised/withdrawn hand-overs for both steps, the daily evaluation, cold email never through the product policy, one business contacted once, ten cold emails a day, and gate drift. No email left the machine.');
} finally {
  for (const domain of domains) {
    const org = (await row('select id from private.growth_organizations where domain=$1', [domain]))?.id;
    if (!org) continue;
    await admin.query('delete from private.growth_delivery_events where message_id in(select m.id from private.growth_messages m join private.growth_opportunities o on o.id=m.opportunity_id where o.organization_id=$1)', [org]);
    await admin.query('delete from private.growth_messages where opportunity_id in(select id from private.growth_opportunities where organization_id=$1)', [org]);
    await admin.query('delete from private.customer_success_plans where opportunity_id in(select id from private.growth_opportunities where organization_id=$1)', [org]);
    await admin.query('delete from private.growth_evidence where opportunity_id in(select id from private.growth_opportunities where organization_id=$1)', [org]);
    await admin.query('delete from private.customer_activity_events where organization_id=$1', [org]);
    await admin.query('delete from private.growth_opportunities where organization_id=$1', [org]);
    await admin.query('delete from private.growth_contacts where organization_id=$1', [org]);
    await admin.query("delete from private.audit_events where action like 'growth.%' and entity_id=$1", [org]);
    await admin.query('delete from private.growth_organizations where id=$1', [org]);
  }
  await admin.query('delete from private.email_suppressions where email_hash=any($1::text[])', [suppressed]);
  await admin.query("delete from private.audit_events where entity_type='agent_action' and entity_id in (select id from private.agent_actions where task_id=any($1::uuid[]))", [tasks]);
  await admin.query('delete from private.agent_actions where task_id=any($1::uuid[])', [tasks]);
  await admin.query('delete from private.agent_tasks where id=any($1::uuid[])', [tasks]);
  await admin.query("delete from private.agent_evaluations where created_at>=$1", [runStart]);
  await admin.query("delete from private.audit_events where (action='agent.autonomy_step' and metadata->>'source'=$1) or actor_id=$2 or (action='growth.auto_qualified' and created_at>=$3)", [source, owner, runStart]);
  for (const s of seedSteps) {
    await admin.query('update private.agent_autonomy_steps set status=$2,supervised_since=$3,automatic_at=$4,announce_pending=$5,changed_at=$6,changed_by=$7 where category=$1',
      [s.category, s.status, s.supervised_since, s.automatic_at, s.announce_pending, s.changed_at, s.changed_by]);
  }
  for (const a of seedAgents) await admin.query('update private.agents set status=$2,autonomy=$3,config=$4 where key=$1', [a.key, a.status, a.autonomy, a.config]);
  for (const p of seedPolicies) await admin.query('update private.growth_policies set enabled=$2,auto_send=$3,daily_limit=$4,min_gap_hours=$5,max_touches=$6,booking_url=$7,approved_claim=$8,version=$9 where product=$1', [p.product, p.enabled, p.auto_send, p.daily_limit, p.min_gap_hours, p.max_touches, p.booking_url, p.approved_claim, p.version]);
  await admin.query('delete from private.sms_sessions where user_id=$1', [owner]);
  await admin.query('delete from private.sms_identities where user_id=$1', [owner]);
  await admin.query('delete from private.staff_permissions where user_id=$1', [owner]);
  await admin.query('delete from hub.profiles where id=$1', [owner]);
  await admin.query('delete from auth.users where id=$1', [owner]);
  await pool.end(); await admin.end();
}
