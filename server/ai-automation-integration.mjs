// The AI auto-resolution loop through the actual Hub server role, on disposable
// local fixtures only. The loop's pool logs in as hub_app_server exactly like
// production: it reaches cases only through the private.ai_automation_* operations,
// and a new portal case receives the AI reply. Anthropic is never called: the real
// provider client runs with a fixture key against a synthetic Messages API.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { digest } from './sms-auth.mjs';
import { gateway } from './gateway.mjs';
import { aiAssistance } from './ai-assistance.mjs';
import { aiAssistantUserId, aiAutomation, sqlAutomationStore } from './ai-automation.mjs';
import { goLiveReadiness } from './go-live-readiness.mjs';

const databaseUrl=process.env.HUB_TEST_DATABASE_URL;
const local=new URL(databaseUrl);assert.equal(local.hostname,'127.0.0.1');assert.equal(local.port,'54322');
const admin=new pg.Pool({connectionString:databaseUrl});
await admin.query("alter role hub_app_server login password 'ephemeral-test-only'");
const appUrl=new URL(databaseUrl);appUrl.username='hub_app_server';appUrl.password='ephemeral-test-only';
const pool=new pg.Pool({connectionString:appUrl.href});const api=gateway(pool);
const contractMigration=await readFile(new URL('../supabase/migrations/20261020120100_ai_automation_server_contract.sql',import.meta.url),'utf8');

const owner=randomUUID(),customer=randomUUID(),tenant=randomUUID();
const ownerToken='automation-owner-'+randomUUID(),customerToken='automation-customer-'+randomUUID();
const guideItem=randomUUID(),guideRevision=randomUUID(),staffItem=randomUUID(),staffRevision=randomUUID();
const product=(await admin.query("select id from hub.products where slug='caremetric-go'")).rows[0].id;
const rpc=(name,args,token)=>api.rpc(name,args,token);
const fixtureCases=new Set();
const hour=60*60*1000;

// Synthetic Anthropic Messages API: answers by request kind and records each prompt.
const requests=[];
const anthropic=async(url,init)=>{
  assert.equal(url,'https://api.anthropic.com/v1/messages');
  assert.equal(init.headers['x-api-key'],'sk-ant-integration-fixture');
  const request=JSON.parse(init.body);
  const prompt=request.messages[0].content;
  let kind,text;
  if(request.system.includes('Draft a support reply')) {
    kind='draft';text=`Synthetic automated attempt ${requests.filter(entry=>entry.kind==='draft').length+1}: open Reports, choose a single month, then export again. Did that fix the problem? — CareMetric AI Assistant (automated reply)`;
  } else if(request.system.includes('Classify their reply')) {
    kind='classify';text=JSON.stringify({outcome:/works now/i.test(prompt)?'fixed':/still/i.test(prompt)?'not_fixed':'unclear'});
  } else if(request.system.includes('taking it over')) {
    kind='summary';text='Synthetic escalation summary: two automated suggestions did not fix the export.';
  } else throw new Error('Unexpected AI request');
  requests.push({kind,prompt});
  return new Response(JSON.stringify({content:[{type:'text',text}],stop_reason:'end_turn',usage:{input_tokens:1,output_tokens:1}}),{status:200});
};

// The production wiring from main.mjs: enabled only by the exact toggle, and only
// with a configured key. The one test-only change scopes candidate lists to this
// file's fixture cases, so the sweep never touches another test's data.
const env={ANTHROPIC_API_KEY:'sk-ant-integration-fixture',HUB_AI_AUTOMATION_ENABLED:'true'};
const ai=aiAssistance({apiKey:env.ANTHROPIC_API_KEY,fetchImpl:anthropic,log:()=>{}});
const store=sqlAutomationStore(pool);
const scoped={
  ...store,
  findNewEligibleCaseIds:async()=>(await store.findNewEligibleCaseIds()).filter(id=>fixtureCases.has(id)),
  findActiveCaseIds:async()=>(await store.findActiveCaseIds()).filter(id=>fixtureCases.has(id)),
};
const failures=[];
let clock=Date.now();
const loop=aiAutomation({ai,store:scoped,enabled:env.HUB_AI_AUTOMATION_ENABLED==='true',followUpDelayMs:24*hour,now:()=>new Date(clock),log:line=>failures.push(line)});
const tick=async()=>{const result=await loop.tick();assert.deepEqual(failures,[],'every automation step succeeds through the server role');return result;};

const createCase=async subject=>{
  const created=await rpc('create_support_case',{p_tenant_id:tenant,p_product_id:product,p_subject:subject,p_category:'technical_issue',p_priority:'normal',
    p_body:'Synthetic nonclinical fixture: the export never finishes.',p_app_version:null,p_route:null,p_contains_phi:false,p_request_key:randomUUID()},customerToken);
  fixtureCases.add(created.id);
  return created.id;
};
const customerReply=(caseId,body)=>rpc('reply_to_support_case',{p_case_id:caseId,p_body:body,p_visibility:'customer',p_request_key:randomUUID()},customerToken);
const messages=async caseId=>(await admin.query('select id,author_id,author_display_name,author_role,body from hub.case_messages where case_id=$1 order by created_at,id',[caseId])).rows;
const supportCase=async caseId=>(await admin.query('select status,priority,resolved_at from hub.support_cases where id=$1',[caseId])).rows[0];
const automation=async caseId=>(await admin.query('select * from hub.case_ai_automation where case_id=$1',[caseId])).rows[0];
const aiMessages=async caseId=>(await messages(caseId)).filter(message=>message.author_role==='ai_assistant');

try {
  await admin.query(`insert into auth.users(id,email,is_anonymous) values($1,'automation-owner@test.invalid',false),($2,'automation-customer@test.invalid',false)`,[owner,customer]);
  await admin.query("insert into private.staff_permissions(user_id,permission) values($1,'platform.admin')",[owner]);
  await admin.query("insert into private.sms_identities(user_id,phone_e164,verified_at) values($1,'+12025550501',now()),($2,'+12025550502',now())",[owner,customer]);
  for(const [user,sessionToken] of [[owner,ownerToken],[customer,customerToken]]) {
    await admin.query("insert into private.sms_sessions(id,token_hash,user_id,identity_version,expires_at) select $1,$2,user_id,identity_version,now()+interval '1 hour' from private.sms_identities where user_id=$3",[randomUUID(),digest(sessionToken),user]);
  }
  await admin.query("insert into hub.tenants(id,slug,name) values($1,$2,'AI automation integration customer')",[tenant,'automation-'+tenant]);
  await admin.query('insert into hub.tenant_products(tenant_id,product_id) values($1,$2)',[tenant,product]);
  await admin.query('insert into hub.tenant_product_memberships(tenant_id,product_id,user_id) values($1,$2,$3)',[tenant,product,customer]);
  await admin.query('insert into private.case_intake_settings(tenant_id,product_id,enabled,activated_at,activated_by) values($1,$2,true,now(),$3)',[tenant,product,owner]);
  // One customer-safe guide the automated reply may use, one staff-only guide it must never see.
  for(const [item,revision,access,title] of [[guideItem,guideRevision,'customer','Synthetic export troubleshooting guide'],[staffItem,staffRevision,'staff','Synthetic export staff escalation runbook']]) {
    await admin.query(`insert into hub.content_items(id,content_key,kind,status,access_level) values($1,$2,'article','published',$3)`,[item,'fixture.automation-'+item,access]);
    await admin.query(`insert into hub.content_revisions(id,item_id,revision_no,title,summary,body_markdown,review_state,approved_by,approved_at) values($1,$2,1,$3,'Synthetic export guidance.','Split the export by month.','approved',$4,now())`,[revision,item,title,owner]);
    await admin.query('insert into hub.content_publications(item_id,revision_id,product_id) values($1,$2,$3)',[item,revision,product]);
  }

  // The server role still has no direct path to support data, and the operations
  // refuse every session user other than the Hub server.
  await assert.rejects(pool.query('select count(*) from hub.support_cases'),error=>error.code==='42501');
  await assert.rejects(pool.query('select count(*) from hub.case_ai_automation'),error=>error.code==='42501');
  await assert.rejects(admin.query('select * from private.ai_automation_eligible_cases()'),error=>error.code==='42501' && /Application server required/.test(error.message));
  assert.ok(loop.active(),'automation is active with the toggle and a configured key');

  // A new portal case receives the AI reply through the server role in one tick.
  const caseA=await createCase('Synthetic export never finishes');
  const [original]=await messages(caseA);
  assert.ok((await store.findNewEligibleCaseIds()).includes(caseA));
  // The tick claims the case, then revisits it in the same sweep's active pass.
  assert.deepEqual(await tick(),{processed:2,skipped:false});
  const [reply]=await aiMessages(caseA);
  assert.equal(reply.author_id,aiAssistantUserId);
  assert.equal(reply.author_display_name,'CareMetric AI Assistant');
  assert.match(reply.body,/^Synthetic automated attempt 1: .*CareMetric AI Assistant \(automated reply\)$/);
  assert.equal((await supportCase(caseA)).status,'waiting_on_customer');
  let state=await automation(caseA);
  assert.equal(state.stage,'awaiting_response');assert.equal(state.attempts,1);
  assert.equal(state.last_ai_message_id,reply.id);assert.equal(state.last_seen_customer_message_id,original.id);
  assert.equal(state.follow_up_due_at.getTime(),clock+24*hour);
  const draft=requests.find(entry=>entry.kind==='draft');
  assert.match(draft.prompt,/Synthetic export troubleshooting guide/,'the reply drew on the customer-safe guide');
  assert.doesNotMatch(draft.prompt,/staff escalation runbook/,'staff-only content never reaches an automated reply');
  const customerThread=await rpc('get_support_case_thread',{p_case_id:caseA},customerToken);
  assert.ok(customerThread.some(entry=>entry.id===reply.id && entry.author_role==='ai_assistant' && entry.visibility==='customer'),'the customer sees the AI reply');
  assert.equal((await admin.query('select ai_stage from hub.support_case_queue where id=$1',[caseA])).rows[0].ai_stage,'awaiting_response');

  // Nothing new and the follow-up not yet due: the tick posts nothing.
  await tick();
  assert.equal((await aiMessages(caseA)).length,1);
  // A day later with no answer: one follow-up nudge, then nothing more.
  clock+=25*hour;
  await tick();await tick();
  const afterNudge=await aiMessages(caseA);
  assert.equal(afterNudge.length,2);assert.match(afterNudge[1].body,/^Just checking in/);
  assert.ok((await automation(caseA)).follow_up_sent_at);

  // "Still failing": classified not fixed, so the second and final attempt follows.
  await customerReply(caseA,'I tried that and it is still failing on the export.');
  await tick();
  const secondAttempt=await aiMessages(caseA);
  assert.equal(secondAttempt.length,3);assert.match(secondAttempt[2].body,/^Synthetic automated attempt 2:/);
  state=await automation(caseA);
  assert.equal(state.stage,'awaiting_response');assert.equal(state.attempts,2);assert.equal(state.response_source,'classification');
  assert.match(state.last_customer_response,/still failing/);
  assert.match(requests.filter(entry=>entry.kind==='draft')[1].prompt,/still failing/);

  // Still not fixed after two attempts: escalate to staff, permanently.
  await customerReply(caseA,'Still not working, same problem.');
  await tick();
  state=await automation(caseA);
  assert.equal(state.stage,'exhausted');assert.ok(state.escalated_at);
  assert.deepEqual(await supportCase(caseA),{status:'in_progress',priority:'high',resolved_at:null});
  const notes=(await admin.query('select author_id,author_role,body from private.case_notes where case_id=$1',[caseA])).rows;
  assert.equal(notes.length,1);assert.equal(notes[0].author_id,aiAssistantUserId);assert.equal(notes[0].author_role,'ai_assistant');
  assert.match(notes[0].body,/^ESCALATED — AI attempts exhausted\.[\s\S]*Synthetic escalation summary/);
  assert.ok(!(await rpc('get_support_case_thread',{p_case_id:caseA},customerToken)).some(entry=>entry.visibility==='internal'),'the escalation note stays internal');
  assert.ok((await rpc('get_support_case_thread',{p_case_id:caseA},ownerToken)).some(entry=>entry.visibility==='internal' && entry.author_role==='ai_assistant'));
  assert.deepEqual((await admin.query("select changed_columns from private.audit_events where case_id=$1 and actor_id=$2 and action='case.updated'",[caseA,aiAssistantUserId])).rows,[{changed_columns:['status','priority']}]);
  // A finished case is final: no further sweep, reply, or state change reaches it.
  await tick();
  assert.equal((await aiMessages(caseA)).length,3);
  await assert.rejects(store.postAiMessage(caseA,'Another reply'),error=>error.code==='P0001');
  await assert.rejects(store.saveState(caseA,{stage:'attempt_due'}),error=>error.code==='P0001');

  // "Works now": classified fixed, so the case is resolved for the customer.
  const caseB=await createCase('Synthetic export fixed by the first answer');
  await tick();
  assert.equal((await aiMessages(caseB)).length,1);
  await customerReply(caseB,'Yes, that works now. Thank you!');
  await tick();
  state=await automation(caseB);
  assert.equal(state.stage,'resolved');assert.equal(state.response_source,'classification');
  const resolved=await supportCase(caseB);
  assert.equal(resolved.status,'resolved');assert.ok(resolved.resolved_at);
  assert.equal((await admin.query("select count(*)::int as count from private.audit_events where case_id=$1 and actor_id=$2 and action='case.ai_auto_resolved'",[caseB,aiAssistantUserId])).rows[0].count,1);

  // A case staff already answered is never claimed, even when the server asks directly.
  const caseC=await createCase('Synthetic export already answered by staff');
  await admin.query("insert into hub.case_messages(case_id,author_id,author_display_name,author_role,body) values($1,$2,'Synthetic Staff','support_agent','Staff reply fixture')",[caseC,owner]);
  assert.ok(!(await store.findNewEligibleCaseIds()).includes(caseC));
  assert.equal(await store.claimCase(caseC),false);
  await tick();
  assert.equal(await automation(caseC),undefined);
  assert.equal((await aiMessages(caseC)).length,0);
  // Only the named loop fields can change, and attempts never decrease.
  const caseD=await createCase('Synthetic export state rules');
  assert.equal(await store.claimCase(caseD),true);assert.equal(await store.claimCase(caseD),false);
  await assert.rejects(store.saveState(caseD,{stage:'awaiting_response',createdAt:new Date()}),error=>error.code==='22023');
  await store.saveState(caseD,{attempts:1});
  await assert.rejects(store.saveState(caseD,{attempts:0}),error=>error.code==='22023');
  await assert.rejects(store.saveState(caseD,{lastAiMessageId:reply.id}),error=>error.code==='22023','a message from another case is refused');
  await assert.rejects(store.resolveCase(caseD),error=>error.code==='P0001','resolution needs an awaited answer');

  // The go-live readiness panel evaluates through the same server role.
  const readiness=goLiveReadiness({pool,rpc,env,lookup:async()=>['fixture.invalid']});
  const report=await readiness.handle(ownerToken);
  assert.deepEqual(report.migrations.items.map(item=>[item.version,item.applied]),[['20261015120000',true],['20261015120100',true],['20261020120000',true],['20261020120100',true]]);
  assert.equal(report.migrations.complete,true);

  // The contract gate refuses to declare a widened or incomplete boundary.
  const client=await admin.connect();
  try {
    for(const [sql,error] of [
      ['grant select on hub.support_cases to hub_app_server',/direct privileges on hub.support_cases/],
      ['grant execute on function private.ai_automation_claim(uuid) to authenticated',/exposed beyond the Hub server/],
      ['grant execute on function private.ai_automation_case_eligible(uuid) to hub_app_server',/must stay internal/],
      ['alter function private.ai_automation_work(uuid) security invoker',/pinned security definer/],
      ['alter function private.ai_automation_resolve(uuid) rename to fixture_missing_resolve',/missing private.ai_automation_resolve/],
    ]) {
      await client.query('begin');
      try {
        await client.query(sql);
        await assert.rejects(client.query(contractMigration),rejection=>rejection.code==='55000' && error.test(rejection.message));
      } finally { await client.query('rollback'); }
    }
  } finally { client.release(); }
  console.log('AI automation: a new portal case received the AI reply through hub_app_server; follow-up, second attempt, escalation, classified resolution, eligibility, state rules, readiness and the contract gate passed.');
} finally {
  await admin.query('delete from hub.content_publications where item_id in ($1,$2)',[guideItem,staffItem]);
  await admin.query('delete from hub.content_items where id in ($1,$2)',[guideItem,staffItem]);
  await admin.query('delete from private.audit_events where case_id = any($1::uuid[]) or actor_id in ($2,$3)',[[...fixtureCases],owner,customer]);
  await admin.query('delete from hub.support_cases where tenant_id=$1',[tenant]);
  await admin.query('delete from hub.tenants where id=$1',[tenant]);
  await admin.query('delete from private.sms_sessions where user_id in ($1,$2)',[owner,customer]);
  await admin.query('delete from private.sms_identities where user_id in ($1,$2)',[owner,customer]);
  await admin.query('delete from auth.users where id in ($1,$2)',[owner,customer]);
  await pool.end();await admin.end();
}
