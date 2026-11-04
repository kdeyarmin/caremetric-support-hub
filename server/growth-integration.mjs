// Real server-role/session, concurrency and lifecycle checks. Disposable loopback database only; no mail is sent.
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { digest, withSession } from './sms-auth.mjs';
import { growthStore } from './growth/store.mjs';
import { sqlAgentStore } from './agents/store.mjs';
import { evaluateGrowth } from './growth/evaluation.mjs';
import { growthHandlers, growthExecutors } from './growth/worker.mjs';
import { planOpportunity } from './growth/policy.mjs';
import { actionExecutor, recordOnlyExecutors } from './agents/actions.mjs';
import { lifecycleInput, lifecyclePreview } from './agents/accounts/lifecycle.mjs';

const databaseUrl = process.env.HUB_TEST_DATABASE_URL;
const local = new URL(databaseUrl);
assert.equal(local.hostname, '127.0.0.1'); assert.equal(local.port, '54322');
const admin = new pg.Pool({ connectionString: databaseUrl });
await admin.query("alter role hub_app_server login password 'ephemeral-test-only'");
const appUrl = new URL(databaseUrl); appUrl.username = 'hub_app_server'; appUrl.password = 'ephemeral-test-only';
const pool = new pg.Pool({ connectionString: appUrl.href });
const store = growthStore(pool), agents = sqlAgentStore(pool, { fenced: true, growth: true });
const owner = randomUUID(), tenant = randomUUID(), token = `growth-${randomUUID()}`, run = randomUUID().slice(0, 8);
const domain = `growth-${run}.example.org`, email = `buyer@${domain}`;
const row = async (sql, values = []) => (await admin.query(sql, values)).rows[0];
const call = async (fn, values = []) => (await pool.query(`select ${fn}(${values.map((_, i) => `$${i + 1}`).join(',')}) as r`, values)).rows[0].r;
const ownerCall = (fn, values) => withSession(pool, token, async db => (await db.query(`select ${fn}(${values.map((_, i) => `$${i + 1}`).join(',')}) as r`, values)).rows[0].r);
const gate = await readFile(new URL('../supabase/migrations/20261103150102_customer_growth_contract.sql', import.meta.url), 'utf8');
const seedAgents = (await admin.query('select key,status,autonomy,daily_budget_cents,config from private.agents')).rows;
const seedPolicies = (await admin.query('select * from private.growth_policies')).rows;
const seedBillingMode = (await row('select livemode from private.billing_settings')).livemode;
let organization, communication;
const regressionOrganizations = [], regressionTenants = [], regressionCommunications = [], chatClients = [], regressionSuppressions = [];
const tasks = [];
const task = async (agent='marketing_manager') => {
  const id = (await row("insert into private.agent_tasks(agent_key,kind,request_key,status,attempts,lease_until) values($1,$2,$3,'running',1,now()+interval '10 minutes') returning id", [agent,agent==='account_manager'?'growth.success':'growth.pipeline',`growth:${run}:${randomUUID()}`])).id;
  tasks.push(id); return id;
};
const opportunity = id => row('select * from private.growth_opportunities where id=$1', [id]);
const message = id => row('select * from private.growth_messages where id=$1', [id]);
const draftVersions = id => row('select o.version,c.version as "contactVersion",p.version as "policyVersion" from private.growth_opportunities o join private.growth_contacts c on c.id=o.contact_id join private.growth_policies p on p.product=o.product where o.id=$1',[id]);
const prepare = async (id, key, purpose='marketing') => {
  const versions = await draftVersions(id);
  const ownerAgent=purpose==='success'?'account_manager':'marketing_manager';
  const work = await store.plan(id, { key, kind: purpose==='success'?'onboarding':'outreach', action: 'Offer a conversation.', success: 'Qualified reply.', owner: ownerAgent, dueAt: new Date().toISOString() });
  const draft = await store.draft(id, work, { ...versions, purpose, subject: 'Product workflow', body: 'Would a conversation be useful?', citations: (await store.detail(token,id)).evidence.map(e=>e.id), unsubscribeHash: digest(work), modelGenerated: true });
  const action = await store.propose(await task(ownerAgent), draft.id);
  await ownerCall('hub.decide_agent_action', [action.id, 'approve', 'Reviewed synthetic message.']);
  await agents.beginExecution(action.id);
  return { id: draft.id, action: action.id, work };
};
const regressionFixture = async (product='carebase') => {
  const tenantId=randomUUID(),fixtureDomain=`growth-regression-${randomUUID()}.example.org`;
  await admin.query('insert into hub.tenants(id,slug,name) values($1,$2,$3)',[tenantId,`regression-${tenantId}`,'Synthetic regression organization']);
  regressionTenants.push(tenantId);
  const {id}=await store.manage(token,'create',{name:'Synthetic regression organization',domain:fixtureDomain,product,email:`buyer@${fixtureDomain}`,tenantId});
  const o=await opportunity(id);regressionOrganizations.push(o.organization_id);
  await store.manage(token,'opportunity',{id,version:o.version,stage:'qualified',goal:'Evaluate the workflow.',nextAction:'Offer a conversation',nextAt:new Date().toISOString(),trialEnd:'',renewalAt:'',memory:{}});
  await store.manage(token,'contact',{id:o.contact_id,version:1,eligibility:'permitted',verified:true,sourceUrl:`https://${fixtureDomain}/team`});
  await store.manage(token,'evidence',{opportunityId:id,sourceUrl:`https://${fixtureDomain}/about`,claim:'Verified care operator.',confidence:'high',observedAt:new Date().toISOString()});
  return {id,tenantId,product,contactId:o.contact_id};
};
const changePolicy = async (claim) => {
  const p=await row("select * from private.growth_policies where product='carebase'");
  await store.manage(token,'policy',{product:p.product,version:p.version,enabled:true,autoSend:false,dailyLimit:p.daily_limit,minGapHours:p.min_gap_hours,maxTouches:p.max_touches,bookingUrl:'',approvedClaim:claim});
};
const fixtureSnapshot = async id => (await store.snapshot(0)).items.find(o=>o.id===id);

try {
  await admin.query('insert into auth.users(id,email,is_anonymous) values($1,$2,false)', [owner, `growth-owner-${run}@test.invalid`]);
  await admin.query("insert into private.staff_permissions(user_id,permission) values($1,'platform.admin')", [owner]);
  await admin.query("insert into private.sms_identities(user_id,phone_e164,verified_at) values($1,'+12025550971',now())", [owner]);
  await admin.query("insert into private.sms_sessions(id,token_hash,user_id,identity_version,expires_at) select $1,$2,user_id,identity_version,now()+interval '1 hour' from private.sms_identities where user_id=$3", [randomUUID(), digest(token), owner]);
  await admin.query('insert into hub.tenants(id,slug,name) values($1,$2,$3)', [tenant, `growth-${run}`, 'Synthetic Growth Organization']);
  await admin.query("update private.agents set status='active',autonomy='propose',daily_budget_cents=100 where key in ('marketing_manager','account_manager')");
  await assert.rejects(store.workspace(null), e => e.status === 401 || ['28000','42501'].includes(e.code));
  await assert.rejects(pool.query('select * from private.growth_contacts'), e => e.code === '42501');
  await assert.rejects(admin.query('select private.growth_snapshot(0)'), e => e.code === '42501');
  for (const product of ['carebase','caremetric-intel']) {
    await store.manage(token, 'policy', { product, version: 1, enabled: true, autoSend: false, dailyLimit: 10, minGapHours: 72, maxTouches: 3, bookingUrl: '', approvedClaim: 'Discuss the product workflow.' });
    await store.manage(token, 'create', { name: 'Synthetic Growth Organization', domain, product, email, contactName: 'Buyer', role: 'Administrator', goal: 'Evaluate the workflow.', tenantId: tenant });
  }
  const workspace = await store.workspace(token);
  const carebase = workspace.items.find(o => o.domain === domain && o.product === 'carebase');
  const intel = workspace.items.find(o => o.domain === domain && o.product === 'caremetric-intel');
  organization = carebase.organization_id;
  assert.equal(carebase.contact_id, intel.contact_id, 'one verified contact across products');
  for (const o of [carebase, intel]) await store.manage(token, 'opportunity', { id: o.id, version: o.version, stage: 'qualified', goal: o.goal, nextAction: 'Offer a conversation', nextAt: new Date().toISOString(), trialEnd: '', renewalAt: '', memory: {} });
  for(const o of [carebase,intel]) {
    const fact={opportunityId:o.id,sourceUrl:`https://${domain}/about`,claim:'Verified care business organization.',confidence:'high'};
    await store.manage(token,'evidence',{...fact,observedAt:new Date(Date.now()-31*86400000).toISOString()});
    await store.manage(token,'evidence',{...fact,observedAt:new Date().toISOString()});
    const detail=await store.detail(token,o.id);assert.equal(detail.evidence.length,1);assert.ok(Date.now()-Date.parse(detail.evidence[0].observed_at)<60000,'owner verification refreshes a fact without duplicating it');
  }
  await store.manage(token, 'contact', { id: carebase.contact_id, version: 1, eligibility: 'permitted', verified: true, sourceUrl: `https://${domain}/team` });
  await assert.rejects(store.manage(token, 'contact', { id: carebase.contact_id, version: 1, eligibility: 'opted_out', verified: true, sourceUrl: '' }), e => e.code === '40001');

  // Two processes race the same send, then a second product: exactly one contact attempt is admitted.
  const first = await prepare(carebase.id, 'outreach:0');
  const raced = await Promise.all([store.claim(first.id, first.action), store.claim(first.id, first.action)]);
  assert.equal(raced.filter(r => r.send).length, 1);
  const second = await prepare(intel.id, 'outreach:0');
  assert.deepEqual(await store.claim(second.id, second.action), { send: false, status: 'delivery_unresolved' });
  // A delivery webhook can arrive before the provider request returns; acceptance cannot undo it.
  await store.delivery(`delivered:${run}`, first.id, 'delivered', new Date().toISOString());
  await store.finish(first.id, 'accepted', 'synthetic-provider');
  assert.equal((await message(first.id)).status, 'delivered');
  assert.equal((await opportunity(carebase.id)).stage, 'contacted');
  assert.deepEqual(await store.claim(second.id, second.action), { send: false, status: 'frequency_limited' });

  // Public chat's claimed address cannot opt out a real contact or mutate either product's history.
  const chatHash=digest(`growth-chat:${run}`),clientHash=digest(`growth-chat-client:${run}`);
  chatClients.push(clientHash);
  const beforeChat=await row('select eligibility,version from private.growth_contacts where id=$1',[carebase.contact_id]);
  const chat=await call('private.start_chat',[chatHash,clientHash,'Visitor',email,null,'Unsubscribe and remove me.']);
  const chatId=(await row('select id from private.communications where reference=$1',[chat.reference])).id;
  regressionCommunications.push(chatId);
  await call('private.post_chat_message',[chatHash,clientHash,'I want to cancel my account.']);
  assert.deepEqual(await row('select eligibility,version from private.growth_contacts where id=$1',[carebase.contact_id]),beforeChat);
  assert.equal((await row('select count(*)::integer as n from private.email_suppressions where email_hash=$1',[digest(email)])).n,0);
  assert.equal((await row('select count(*)::integer as n from private.customer_activity_events where organization_id=$1',[organization])).n,0);
  assert.equal((await message(second.id)).status,'proposed');
  assert.equal(await store.inquiry((await row('select id from private.communication_messages where communication_id=$1 order by created_at desc limit 1',[chatId])).id),0);

  // Actual email inbox ingestion synchronously cancels the other product's pending message; no transcript copied to growth.
  const incoming = await call('private.ingest_inbound_communication', ['email', `growth:${run}`, `growth-reply:${run}`, null, 'carebase', 'Re: Product workflow', 'I am interested. Can we book a demo?', 'Buyer', email, null]);
  communication = incoming.id;
  assert.equal((await message(second.id)).status, 'cancelled');
  assert.equal((await opportunity(carebase.id)).stage, 'engaged');
  assert.equal((await opportunity(intel.id)).stage, 'engaged');
  const detail = await store.detail(token, carebase.id);
  assert.ok(detail.events.some(e => e.kind === 'positive_reply'));
  assert.ok(!JSON.stringify(detail.events).includes('Can we book'), 'event memory is metadata only');

  // Authenticated product lifecycle: stable keys, content-aware replay, no regression from late business events.
  const at = new Date(), event = (key, kind, date = at) => ({ tenantId: tenant, eventKey: `growth:${run}:${key}`, kind, occurredAt: date.toISOString(), facts: {} });
  const trial = event('trial', 'trial_started'); trial.facts.trialEnd = new Date(at.getTime() + 7 * 86400000).toISOString();
  assert.equal((await store.event('carebase', trial)).replay, false);
  assert.equal((await store.event('carebase', trial)).replay, true);
  await assert.rejects(store.event('carebase', { ...trial, kind: 'paid' }), e => e.code === '22023');
  await store.event('carebase', event('value', 'first_value', new Date(+at + 1000)));
  await store.event('carebase', event('later-reply','reply',new Date(+at+3000)));
  await store.event('carebase', event('paid', 'paid', new Date(+at + 2000)));
  await store.event('carebase', event('late-trial', 'trial_started', new Date(+at - 1000)));
  assert.equal((await opportunity(carebase.id)).stage, 'paying');
  assert.equal((await opportunity(carebase.id)).owner_agent, 'account_manager');
  assert.equal(new Date((await opportunity(carebase.id)).trial_end).toISOString(), trial.facts.trialEnd);
  await store.event('carebase',event('active','active',new Date(+at-3600000)));
  const activity=(await row('select private.growth_account_activity($1) as data',[tenant])).data;
  assert.equal(activity[0].metric,'active_days');assert.equal(activity[0].latest,1);assert.equal(activity[0].baselineAt,null,'a partial baseline is not compared');
  await assert.rejects(pool.query('select private.growth_account_activity($1)',[tenant]),e=>e.code==='42501');
  await assert.rejects(store.event('breathe', trial), e => e.code === '22023');

  // A changed policy can replace a cancelled draft for the same work without breaking unsubscribe idempotency.
  const old = await message(second.id);
  const replacement = await store.draft(intel.id, second.work, { ...await draftVersions(intel.id), purpose: 'success', subject: 'Next step', body: 'How can we help?', citations: [], unsubscribeHash: old.unsubscribe_hash });
  assert.notEqual(replacement.id, second.id);
  assert.equal(await store.unsubscribe(old.unsubscribe_hash), true);
  assert.equal((await message(replacement.id)).status, 'cancelled');
  assert.equal((await row('select eligibility from private.growth_contacts where id=$1', [carebase.contact_id])).eligibility, 'opted_out');
  const emailHash = createHash('sha256').update(email).digest('hex');
  assert.ok(await row('select 1 from private.email_suppressions where email_hash=$1', [emailHash]));

  // Shared budget reservations hold across independent calls and are released after confirmed accounting.
  const budgetTask = await task();
  const reservations = await Promise.all([agents.reserveBudget(budgetTask, 70), agents.reserveBudget(budgetTask, 70)]);
  assert.equal(reservations.filter(Boolean).length, 1);
  await agents.releaseBudget(reservations.find(Boolean));
  const next = await agents.reserveBudget(budgetTask, 70); assert.ok(next); await agents.releaseBudget(next);
  const contentTask=await task();
  const brief=await store.proposeContent(contentTask,'carebase',{title:'Training reporting',keyword:'staff training',outline:['Business problem','Verified workflow','Next step'],citations:[`https://${domain}/about`],campaign:'growth:carebase:synthetic'});
  assert.equal((await row('select status from private.agent_actions where id=$1',[brief.id])).status,'proposed');
  await admin.query("update private.agent_tasks set kind='growth.content',result=$2 where id=$1",[contentTask,{contentWeek:'synthetic',proposals:1}]);
  assert.equal((await store.contentContext('synthetic')).planned,true);
  for (const report of await evaluateGrowth()) assert.equal(report.passed, true);
  assert.ok((await call('private.agent_accounts_page', [1, 0])).accounts);

  // Review regression: a model/fallback result cannot be relabelled with a policy or contact edited after its snapshot.
  const drafting = await regressionFixture();
  const staleVersions = await draftVersions(drafting.id);
  const draftingWork = await store.plan(drafting.id, { key:'outreach:0', kind:'outreach', action:'Offer a conversation.', success:'A qualified reply.', owner:'marketing_manager', dueAt:new Date().toISOString() });
  const staleDraft = { ...staleVersions, purpose:'marketing', subject:'Old claim', body:'Old reviewed claim.', citations:[], unsubscribeHash:digest(draftingWork) };
  await changePolicy('New reviewed training capability.');
  await assert.rejects(store.draft(drafting.id,draftingWork,staleDraft),e=>e.code==='40001');
  const beforeContactEdit = await draftVersions(drafting.id);
  await store.manage(token,'contact',{id:drafting.contactId,version:beforeContactEdit.contactVersion,eligibility:'permitted',verified:true,sourceUrl:'https://example.org/verified-team'});
  await assert.rejects(store.draft(drafting.id,draftingWork,{...staleDraft,...beforeContactEdit}),e=>e.code==='40001');
  await assert.rejects(store.draft(drafting.id,draftingWork,{...staleDraft,...await draftVersions(drafting.id),policyVersion:undefined}),e=>e.code==='40001');
  assert.equal((await row('select count(*)::int as n from private.growth_messages where opportunity_id=$1',[drafting.id])).n,0);

  // Run the real worker: pending drafts are replaced after a context edit and the old approval is expired.
  const growth={store:{...store,snapshot:async()=>({total:1,items:[await fixtureSnapshot(drafting.id)]})},signingReady:true,hash:digest,unsubscribeToken:digest};
  const sweep=growthHandlers({growth})['growth.pipeline'];
  const runSweep=async()=>sweep({id:await task(),kind:'growth.pipeline',agent:{autonomy:'propose'}});
  const latestDraft=()=>row('select * from private.growth_messages where opportunity_id=$1 order by created_at desc,id desc limit 1',[drafting.id]);
  await runSweep();
  const initialDraft=await latestDraft();
  assert.ok(initialDraft.body.includes('New reviewed training capability.'));
  await changePolicy('Corrected reviewed training capability.');
  await runSweep();
  const refreshedDraft=await latestDraft();
  assert.notEqual(refreshedDraft.id,initialDraft.id);
  assert.equal((await message(initialDraft.id)).status,'cancelled');
  assert.equal((await row('select status from private.agent_actions where id=$1',[initialDraft.action_id])).status,'expired');
  assert.ok(refreshedDraft.body.includes('Corrected reviewed training capability.'));
  assert.equal(refreshedDraft.policy_version,(await draftVersions(drafting.id)).policyVersion);
  assert.equal(await agents.beginExecution(initialDraft.action_id),null,'an obsolete approval cannot start');
  const currentContact=(await draftVersions(drafting.id)).contactVersion;
  await store.manage(token,'contact',{id:drafting.contactId,version:currentContact,eligibility:'permitted',verified:true,sourceUrl:'https://example.org/reverified-team'});
  await runSweep();
  const contactDraft=await latestDraft();assert.notEqual(contactDraft.id,refreshedDraft.id);
  assert.equal((await message(refreshedDraft.id)).status,'cancelled');
  assert.equal(contactDraft.contact_version,currentContact+1);
  await ownerCall('hub.decide_agent_action',[contactDraft.action_id,'reject','Revise the claim before proposing again.']);
  await runSweep();assert.equal((await latestDraft()).id,contactDraft.id,'an unchanged rejection must not be repeatedly proposed');
  await changePolicy('Revised reviewed training capability.');
  await runSweep();assert.notEqual((await latestDraft()).id,contactDraft.id,'a revised policy can replace a rejected draft');
  // Never cancel an accepted or uncertain delivery merely because its context changes.
  const attempted=await latestDraft();
  for(const status of ['accepted','unknown']) {
    await admin.query('update private.growth_messages set status=$2,attempted_at=now() where id=$1',[attempted.id,status]);
    await changePolicy(`Reviewed training capability after ${status}.`);
    await store.maintenance();assert.equal((await message(attempted.id)).status,status);
  }

  // Review regression: historic milestones are independent of the newest lifecycle state.
  const activeCustomer=await regressionFixture();
  const timeAgo=hours=>new Date(Date.now()-hours*3600000).toISOString();
  const report=(o,key,kind,occurredAt)=>store.event(o.product,{tenantId:o.tenantId,eventKey:`regression:${run}:${key}`,kind,occurredAt,facts:{}});
  const firstValueAt=timeAgo(2),paidAt=timeAgo(1);
  await report(activeCustomer,'trial','trial_started',timeAgo(72));
  await report(activeCustomer,'paid','paid',paidAt);
  await report(activeCustomer,'late-value','first_value',firstValueAt);
  const activeSnapshot=await fixtureSnapshot(activeCustomer.id);
  assert.equal(activeSnapshot.stage,'paying');assert.equal(new Date(activeSnapshot.activated_at).toISOString(),firstValueAt);
  assert.ok(!planOpportunity(activeSnapshot).some(w=>['onboarding','activation'].includes(w.kind)),'late activation does not restart onboarding');
  const formerCustomer=await regressionFixture('caremetric-intel');
  const churnAt=timeAgo(24),earlierChurnAt=timeAgo(36),historicPaidAt=timeAgo(35*24);
  await report(formerCustomer,'churn','churned',churnAt);
  await report(formerCustomer,'late-paid','paid',historicPaidAt);
  assert.equal((await opportunity(formerCustomer.id)).stage,'churned');
  assert.equal(new Date((await opportunity(formerCustomer.id)).paid_at).toISOString(),historicPaidAt);
  await report(formerCustomer,'renewed','renewed',timeAgo(1));
  await report(formerCustomer,'earlier-churn','churned',earlierChurnAt);
  const returned=await opportunity(formerCustomer.id);
  assert.equal(returned.stage,'retained');assert.equal(new Date(returned.churned_at).toISOString(),earlierChurnAt);
  const beforeReplay=returned.version;
  assert.equal((await report(formerCustomer,'earlier-churn','churned',earlierChurnAt)).replay,true);
  assert.equal((await opportunity(formerCustomer.id)).version,beforeReplay);
  const cohorts=(await store.workspace(token)).metrics.filter(m=>m.product==='caremetric-intel'&&m.stage==='retained');
  assert.equal(cohorts.reduce((sum,m)=>sum+m.eligible_30d,0),1,'the late payment contributes to retention eligibility');
  assert.equal(cohorts.reduce((sum,m)=>sum+m.retained_30d,0),1);

  // A new product opportunity gets only the lifecycle state supported by its first event.
  for(const [kind,stage,ownerAgent] of [
    ['heartbeat','identified','marketing_manager'],['active','identified','marketing_manager'],['reply','identified','marketing_manager'],
    ['meeting_booked','demo','marketing_manager'],['positive_reply','engaged','marketing_manager'],
    ['signup','trial','account_manager'],['trial_started','trial','account_manager'],['first_value','activated','account_manager'],
    ['paid','paying','account_manager'],['renewed','retained','account_manager'],['churned','churned','account_manager'],
  ]) {
    const mapped=await regressionFixture();
    await store.event('caremetric-intel',{tenantId:mapped.tenantId,eventKey:`first:${run}:${kind}`,kind,occurredAt:timeAgo(1),facts:{}});
    const created=await row('select o.* from private.growth_opportunities o join private.growth_organizations g on g.id=o.organization_id where g.tenant_id=$1 and o.product=$2',[mapped.tenantId,'caremetric-intel']);
    assert.deepEqual([created.stage,created.owner_agent],[stage,ownerAgent],kind);
    if(ownerAgent==='marketing_manager') assert.ok(!planOpportunity(await fixtureSnapshot(created.id)).some(w=>['onboarding','activation','trial'].includes(w.kind)),`${kind} does not invent trial onboarding`);
  }

  // An existing thread's timestamp is updated after its message trigger: use the individual message time.
  const cancellation=await regressionFixture();
  const cancellationEmail=(await row('select email from private.growth_contacts where id=$1',[cancellation.contactId])).email;
  const cancelThread=await call('private.ingest_inbound_communication',['email',`cancel:${run}`,`cancel-first:${run}`,null,'carebase','Product question','Hello.','Buyer',cancellationEmail,null]);
  regressionCommunications.push(cancelThread.id);
  await admin.query('update private.communications set last_message_at=$2 where id=$1',[cancelThread.id,timeAgo(72)]);
  await report(cancellation,'renewed-before-reply','renewed',timeAgo(1));
  await call('private.ingest_inbound_communication',['email',`cancel-reply:${run}`,`cancel-now:${run}`,cancelThread.reference,'carebase','Re: Product question','I want to cancel my account.','Buyer',cancellationEmail,null]);
  const received=await row("select id,created_at from private.communication_messages where provider_message_id=$1",[`email:cancel-now:${run}`]);
  const cancellationEvent=await row("select occurred_at from private.customer_activity_events where event_key=$1 and product='carebase'",[`inquiry:${received.id}`]);
  assert.equal(+cancellationEvent.occurred_at,+received.created_at,'the reply is not backdated to the previous thread activity');
  assert.ok(planOpportunity(await fixtureSnapshot(cancellation.id)).some(w=>w.kind==='recovery'),'a cancellation after renewal still requires recovery');

  // Growth capture never decides whether a customer's email is kept. A sales email from a domain the growth records cannot
  // hold (a one-letter host, which the inbox accepts) used to abort the inbox insert; it is now saved and the miss audited.
  const auditedMiss=async id=>(await row("select metadata from private.audit_events where action='growth.inquiry_failed' and entity_id=$1",[id]))?.metadata;
  const oddSender=`buyer-${run}@q.example`;
  const oddThread=await call('private.ingest_inbound_communication',['email',`odd:${run}`,`odd-first:${run}`,null,'carebase','Pricing','What is your pricing? Can we book a demo?','Buyer',oddSender,null]);
  regressionCommunications.push(oddThread.id);
  const oddMessage=await row('select id from private.communication_messages where provider_message_id=$1',[`email:odd-first:${run}`]);
  assert.ok(oddMessage,'the email is saved although growth could not record its sender');
  assert.equal((await row("select count(*)::integer as n from private.growth_organizations where domain='q.example'")).n,0);
  const oddMiss=await auditedMiss(oddMessage.id);
  assert.deepEqual(oddMiss,{communicationId:oddThread.id,sqlstate:'23514'},'the audit row holds the error code and ids only, never the address or text');

  // Any other failure inside growth capture: the reply is saved, nothing is half-written, and the fallback still honours the
  // contact's unsubscribe request (a webhook retry would skip the saved message) and stops queued outreach.
  const failing=await regressionFixture();
  const failingEmail=(await row('select email from private.growth_contacts where id=$1',[failing.contactId])).email;
  regressionSuppressions.push(digest(failingEmail));
  const failingWork=await store.plan(failing.id,{key:'outreach:failsafe',kind:'outreach',action:'Offer a conversation.',success:'Qualified reply.',owner:'marketing_manager',dueAt:new Date().toISOString()});
  const queued=await store.draft(failing.id,failingWork,{...await draftVersions(failing.id),purpose:'marketing',subject:'Product workflow',body:'Would a conversation be useful?',citations:(await store.detail(token,failing.id)).evidence.map(e=>e.id),unsubscribeHash:digest(failingWork),modelGenerated:true});
  await store.propose(await task(),queued.id);
  assert.equal((await message(queued.id)).status,'proposed');
  const injected=`growth_failsafe_${run}`;
  await admin.query(`alter table private.customer_activity_events add constraint ${injected} check (event_key not like 'inquiry:%') not valid`);
  try {
    regressionCommunications.push((await call('private.ingest_inbound_communication',['email',`failsafe:${run}`,`failsafe-first:${run}`,null,'carebase','Re: Product workflow','Thanks, but please remove me from this list.','Buyer',failingEmail,null])).id);
  } finally { await admin.query(`alter table private.customer_activity_events drop constraint ${injected}`); }
  const failedReply=await row('select id from private.communication_messages where provider_message_id=$1',[`email:failsafe-first:${run}`]);
  assert.ok(failedReply,'the reply is saved although growth capture failed');
  assert.equal((await message(queued.id)).status,'cancelled','the reply still stops queued outreach to its sender');
  assert.equal((await row('select eligibility from private.growth_contacts where id=$1',[failing.contactId])).eligibility,'opted_out','the opt-out is kept');
  assert.ok(await row('select 1 from private.email_suppressions where email_hash=$1',[digest(failingEmail)]),'the address is suppressed for every sender');
  assert.equal((await row('select count(*)::integer as n from private.customer_activity_events where event_key=$1',[`inquiry:${failedReply.id}`])).n,0);
  assert.equal((await opportunity(failing.id)).stage,'qualified','the failed capture left no partial update');
  assert.equal((await auditedMiss(failedReply.id))?.sqlstate,'23514');

  // The growth lock is held until the inbox commits even when capture fails: a send claim queued behind the reply runs after
  // the fallback and finds the message cancelled, instead of claiming it in the moment between capture's rollback and the fallback.
  const lockKey="hashtextextended('growth.workflow',0)";
  const queuedOnLock=async n=>{ for(let i=0;i<300;i++){ if((await row("select count(*)::integer as n from pg_locks where locktype='advisory' and not granted")).n>=n) return; await new Promise(r=>setTimeout(r,10)); } throw new Error('lock queue never formed'); };
  const settle=p=>p.then(value=>({value}),error=>({error}));
  const racing=await regressionFixture();
  const racingEmail=(await row('select email from private.growth_contacts where id=$1',[racing.contactId])).email;
  const racedSend=await prepare(racing.id,'outreach:race');
  const holder=await admin.connect();
  await admin.query(`alter table private.customer_activity_events add constraint ${injected} check (event_key not like 'inquiry:%') not valid`);
  try {
    await holder.query('begin'); await holder.query(`select pg_advisory_xact_lock(${lockKey})`);
    const replying=settle(call('private.ingest_inbound_communication',['email',`race:${run}`,`race-first:${run}`,null,'carebase','Re: Product workflow','Thanks for the note.','Buyer',racingEmail,null]));
    await queuedOnLock(1);
    const claiming=settle(store.claim(racedSend.id,racedSend.action));
    await queuedOnLock(2);
    await holder.query('rollback');
    const [reply,claimed]=await Promise.all([replying,claiming]);
    assert.ok(reply.value,'the reply is saved');
    regressionCommunications.push(reply.value.id);
    assert.deepEqual(claimed.value,{send:false,status:'cancelled'},'the queued send cannot slip in between capture rollback and fallback');
  } finally {
    holder.release();
    await admin.query(`alter table private.customer_activity_events drop constraint ${injected}`);
  }

  // A growth lock held past the trigger's lock timeout cannot run the webhook's 12-second statement into a rollback: capture is
  // skipped, the email is saved, the opt-out is still kept and the miss is audited as lock_not_available.
  const busy=await regressionFixture();
  const busyEmail=(await row('select email from private.growth_contacts where id=$1',[busy.contactId])).email;
  regressionSuppressions.push(digest(busyEmail));
  const busyHolder=await admin.connect(), webhook=await pool.connect();
  try {
    await busyHolder.query('begin'); await busyHolder.query(`select pg_advisory_xact_lock(${lockKey})`);
    await webhook.query('begin'); await webhook.query("set local statement_timeout='12s'");
    const busyThread=(await webhook.query('select private.ingest_inbound_communication($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) as r',['email',`busy:${run}`,`busy-first:${run}`,null,'carebase','Re: Product workflow','Please remove me from this list.','Buyer',busyEmail,null])).rows[0].r;
    await webhook.query('commit');
    regressionCommunications.push(busyThread.id);
  } finally {
    await webhook.query('rollback').catch(()=>{}); webhook.release();
    await busyHolder.query('rollback'); busyHolder.release();
  }
  const busyReply=await row('select id from private.communication_messages where provider_message_id=$1',[`email:busy-first:${run}`]);
  assert.ok(busyReply,'the email is saved while the growth lock is busy');
  assert.equal((await auditedMiss(busyReply.id))?.sqlstate,'55P03');
  assert.equal((await row('select eligibility from private.growth_contacts where id=$1',[busy.contactId])).eligibility,'opted_out');
  assert.ok(await row('select 1 from private.email_suppressions where email_hash=$1',[digest(busyEmail)]));

  // Late signup/trial history that leaves current context unchanged must preserve an existing approval.
  const pendingCustomer=await regressionFixture();
  await report(pendingCustomer,'paid-before-history','paid',timeAgo(1));
  const customerGrowth={store:{...store,snapshot:async()=>({total:1,items:[await fixtureSnapshot(pendingCustomer.id)]})},signingReady:true,hash:digest,unsubscribeToken:digest};
  const successSweep=growthHandlers({growth:customerGrowth})['growth.success'];
  const runSuccess=async()=>successSweep({id:await task('account_manager'),kind:'growth.success',agent:{autonomy:'propose'}});
  await runSuccess();
  const pendingDraft=await row("select * from private.growth_messages where opportunity_id=$1 order by created_at desc,id desc limit 1",[pendingCustomer.id]);
  assert.equal(pendingDraft.status,'proposed');
  const pendingVersion=(await opportunity(pendingCustomer.id)).version;
  for(const kind of ['signup','trial_started']) {
    await report(pendingCustomer,`late-history-${kind}`,kind,timeAgo(24));
    assert.equal((await opportunity(pendingCustomer.id)).version,pendingVersion);
    assert.equal((await message(pendingDraft.id)).status,'proposed');
  }
  await runSuccess();
  assert.equal((await row('select count(*)::integer as n from private.growth_messages where opportunity_id=$1',[pendingCustomer.id])).n,1);
  await ownerCall('hub.decide_agent_action',[pendingDraft.action_id,'approve','Current onboarding context remains valid.']);
  const pendingExecution=await agents.beginExecution(pendingDraft.action_id);
  assert.ok(pendingExecution);
  assert.equal((await store.claim(pendingDraft.id,pendingDraft.action_id)).send,true);
  await store.finish(pendingDraft.id,'failed',null); // Recording provider only: no network send.

  // An explicitly cleared tenant mapping can be moved; omission still preserves an existing mapping.
  const mappingA=await regressionFixture(),mappingB=await regressionFixture();
  const editMapping=async(fixture,extra={})=>{
    const current=await opportunity(fixture.id);
    return store.manage(token,'opportunity',{id:fixture.id,version:current.version,stage:current.stage,goal:current.goal,nextAction:current.next_action,nextAt:new Date().toISOString(),trialEnd:'',renewalAt:'',...extra});
  };
  const mappedTenant=async fixture=>(await row('select g.tenant_id from private.growth_organizations g join private.growth_opportunities o on o.organization_id=g.id where o.id=$1',[fixture.id])).tenant_id;
  await editMapping(mappingA);
  assert.equal(await mappedTenant(mappingA),mappingA.tenantId);
  await editMapping(mappingA,{tenantId:''});
  assert.equal(await mappedTenant(mappingA),null);
  await editMapping(mappingB,{tenantId:mappingA.tenantId});
  assert.equal(await mappedTenant(mappingB),mappingA.tenantId);
  await store.event('carebase',{tenantId:mappingA.tenantId,eventKey:`remapped:${run}`,kind:'meeting_booked',occurredAt:timeAgo(1),facts:{}});
  assert.equal((await opportunity(mappingA.id)).stage,'qualified');
  assert.equal((await opportunity(mappingB.id)).stage,'demo');

  // Native lifecycle and growth share recipient frequency, including when two replicas claim at the same time.
  await admin.query('update private.billing_settings set livemode=true');
  for(const order of ['growth-first','lifecycle-first','concurrent']) {
    const shared=await regressionFixture();
    await report(shared,`shared-trial-${order}`,'trial_started',timeAgo(1));
    const sharedEmail=(await row('select email from private.growth_contacts where id=$1',[shared.contactId])).email;
    const sharedTenant=(await row('select slug from hub.tenants where id=$1',[shared.tenantId])).slug;
    await admin.query("insert into private.billing_customers(tenant_id,stripe_customer_id,email,name,livemode,seen_at) values($1,$2,$3,'Synthetic shared contact',true,now())",[shared.tenantId,`cus_growth${randomUUID().replaceAll('-','')}`,sharedEmail]);
    const growthSend=await prepare(shared.id,'shared-onboarding','success');
    const input=lifecycleInput({tenant:sharedTenant,tenantName:'Synthetic shared account',product:'carebase',productName:'CareBase'},'welcome');
    const native=await agents.proposeAction({taskId:await task('account_manager'),kind:'email.send',targetKind:'billing_account',targetId:sharedTenant,preview:lifecyclePreview(input),input});
    await ownerCall('hub.decide_agent_action',[native.id,'approve','Synthetic cross-workflow check.']);
    const nativeExecution=await agents.beginExecution(native.id);
    const claimNative=()=>agents.lifecycleBeginSend({actionId:native.id,execution:nativeExecution.execution,unsubscribeHash:digest(native.id)});
    const claimGrowth=()=>store.claim(growthSend.id,growthSend.action);
    let nativeResult,growthResult;
    if(order==='growth-first'){growthResult=await claimGrowth();nativeResult=await claimNative();}
    else if(order==='lifecycle-first'){nativeResult=await claimNative();growthResult=await claimGrowth();}
    else [growthResult,nativeResult]=await Promise.all([claimGrowth(),claimNative()]);
    assert.equal(Number(growthResult.send===true)+Number(nativeResult.state==='ready'),1,`${order}: exactly one workflow reserves the recipient`);
    if(growthResult.send) {
      assert.equal(nativeResult.state,'frequency_limited');
      assert.equal((await row('select count(*)::integer as n from private.agent_lifecycle_emails where action_id=$1',[native.id])).n,0);
      await store.finish(growthSend.id,'accepted',`recording-${order}`);
      assert.equal((await claimNative()).state,'frequency_limited');
      await admin.query("update private.growth_messages set attempted_at=now()-interval '31 days' where id=$1",[growthSend.id]);
      assert.equal((await claimNative()).state,'ready','an elapsed contact gap permits the next distinct email');
    } else {
      assert.equal(growthResult.status,'frequency_limited');
      await agents.lifecycleFinishSend({actionId:native.id,delivery:'sent',providerMessageId:`recording-${order}`});
      assert.equal((await claimGrowth()).status,'frequency_limited');
      await admin.query("update private.agent_lifecycle_emails set created_at=now()-interval '31 days' where action_id=$1",[native.id]);
      assert.equal((await claimGrowth()).send,true,'an elapsed contact gap permits the next distinct email');
    }
  }
  await admin.query('update private.billing_settings set livemode=$1',[seedBillingMode]);

  // Review regression: fifty deferred messages cannot monopolize subsequent ticks or bypass the persisted delay.
  const deferredActions=[];
  for(let i=0;i<50;i++) {
    const queued=await agents.proposeAction({taskId:await task(),kind:'growth.message',targetKind:'growth_message',targetId:randomUUID(),preview:'Synthetic queue check.',input:{}});
    await ownerCall('hub.decide_agent_action',[queued.id,'approve','Synthetic queue check.']);
    await admin.query("update private.agent_actions set created_at=now()-interval '2 hours'+$2*interval '1 second' where id=$1",[queued.id,i]);
    deferredActions.push(queued.id);
  }
  const incident=await agents.proposeAction({taskId:await task(),kind:'incident.open',targetKind:'probe_target',targetId:`growth-queue:${run}`,preview:'Synthetic incident record.',input:{}});
  await ownerCall('hub.decide_agent_action',[incident.id,'approve','Synthetic incident check.']);
  const queue=actionExecutor({store:agents,executors:{...recordOnlyExecutors,...growthExecutors({growth:{configured:()=>false}})},log:()=>{}});
  assert.equal((await queue.executeReady()).executed,0);
  assert.equal((await row('select count(*)::int as n from private.agent_actions where id=any($1::uuid[]) and not_before>now() and status=$2',[deferredActions,'approved'])).n,50);
  assert.equal(await agents.beginExecution(deferredActions[0]),null,'direct execution also respects the retry time');
  assert.equal((await queue.executeReady()).executed,1);
  assert.equal((await row('select status from private.agent_actions where id=$1',[incident.id])).status,'executed');
  await admin.query("update private.agent_actions set not_before=now()-interval '1 second' where id=$1",[deferredActions[0]]);
  const restarted=await agents.beginExecution(deferredActions[0]);assert.ok(restarted);
  assert.equal(await agents.deferExecution(restarted.id,restarted.execution-1),false,'a stale worker cannot defer the newer execution');
  assert.equal(await agents.deferExecution(restarted.id,restarted.execution),true);
  assert.equal(await agents.deferExecution(restarted.id,restarted.execution),false,'a deferral is applied only once');
  assert.equal(await agents.deferExecution(restarted.id,null),false,'a deferral requires an execution number');

  // Deployment declaration catches missing functions, grants, owner checks, and disabled RLS.
  const client = await admin.connect();
  try {
    for (const sql of [
      'drop function private.growth_assess(uuid,jsonb)',
      'drop function private.growth_defer_action(uuid,integer)',
      'alter table private.agent_actions drop column not_before',
      'alter function private.growth_claim_message(uuid,uuid) reset search_path',
      'grant execute on function private.growth_record_event(text,jsonb) to authenticated',
      'alter table private.agent_budget_reservations disable row level security',
      'alter function private.agent_lifecycle_begin_send(uuid,integer,text) reset search_path',
      'grant update(email) on private.growth_contacts to hub_app_server',
      'revoke execute on function hub.growth_manage(text,jsonb) from authenticated',
    ]) {
      await client.query('begin');
      try { await client.query(sql); await assert.rejects(client.query(gate), e => e.code === '55000', sql); }
      finally { await client.query('rollback'); }
    }
  } finally { client.release(); }
  console.log('Growth integration passed: session boundaries, unverified-chat exclusion, message chronology, event-based initialization, late milestones and draft preservation, tenant remapping, shared lifecycle/growth recipient claims, reply stop, inbox saved and opt-outs kept when growth capture fails or its lock is busy, send claims serialized behind a failed capture, stale proposal replacement, deferred queue fairness, opt-out, shared budgets, and fail-closed deployment gates. No email sent.');
} finally {
  if (!organization) organization = (await row('select id from private.growth_organizations where domain=$1', [domain]))?.id;
  for(const organizationId of [...(organization?[organization]:[]),...regressionOrganizations]) {
    await admin.query('delete from private.growth_delivery_events where message_id in(select m.id from private.growth_messages m join private.growth_opportunities o on o.id=m.opportunity_id where o.organization_id=$1)', [organizationId]);
    await admin.query('delete from private.growth_messages where opportunity_id in(select id from private.growth_opportunities where organization_id=$1)', [organizationId]);
    await admin.query('delete from private.customer_success_plans where opportunity_id in(select id from private.growth_opportunities where organization_id=$1)', [organizationId]);
    await admin.query('delete from private.growth_evidence where opportunity_id in(select id from private.growth_opportunities where organization_id=$1)', [organizationId]);
    await admin.query('delete from private.customer_activity_events where organization_id=$1', [organizationId]);
    await admin.query('delete from private.growth_opportunities where organization_id=$1', [organizationId]);
    await admin.query('delete from private.growth_contacts where organization_id=$1', [organizationId]);
    await admin.query('delete from private.growth_organizations where id=$1', [organizationId]);
  }
  await admin.query('delete from private.email_suppressions where email_hash=$1', [digest(email)]);
  await admin.query('delete from private.email_suppressions where email_hash=any($1::text[])', [regressionSuppressions]);
  await admin.query('delete from private.agent_budget_reservations where task_id=any($1::uuid[])', [tasks]);
  await admin.query('delete from private.agent_actions where task_id=any($1::uuid[])', [tasks]);
  await admin.query('delete from private.agent_tasks where id=any($1::uuid[]) or source_ref=$2', [tasks, communication ?? null]);
  if (communication) await admin.query('delete from private.communications where id=$1', [communication]);
  await admin.query('delete from private.communications where id=any($1::uuid[])',[regressionCommunications]);
  await admin.query('delete from private.communication_rate_events where client_hash=any($1::text[])',[chatClients]);
  await admin.query("delete from private.audit_events where actor_id=$1 or action like 'growth.%'", [owner]);
  for (const a of seedAgents) await admin.query('update private.agents set status=$2,autonomy=$3,daily_budget_cents=$4,config=$5 where key=$1', [a.key,a.status,a.autonomy,a.daily_budget_cents,a.config]);
  for (const p of seedPolicies) await admin.query('update private.growth_policies set enabled=$2,auto_send=$3,daily_limit=$4,min_gap_hours=$5,max_touches=$6,booking_url=$7,approved_claim=$8,version=$9 where product=$1', [p.product,p.enabled,p.auto_send,p.daily_limit,p.min_gap_hours,p.max_touches,p.booking_url,p.approved_claim,p.version]);
  await admin.query('delete from private.sms_sessions where user_id=$1', [owner]);
  await admin.query('delete from private.sms_identities where user_id=$1', [owner]);
  await admin.query('delete from private.staff_permissions where user_id=$1', [owner]);
  await admin.query('delete from hub.profiles where id=$1', [owner]);
  await admin.query('delete from auth.users where id=$1', [owner]);
  await admin.query('delete from hub.tenants where id=$1', [tenant]);
  await admin.query('delete from private.billing_customers where tenant_id=any($1::uuid[])',[regressionTenants]);
  await admin.query('delete from hub.tenants where id=any($1::uuid[])', [regressionTenants]);
  await admin.query('update private.billing_settings set livemode=$1',[seedBillingMode]);
  await pool.end(); await admin.end();
}
