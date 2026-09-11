// Real disposable PostgreSQL, SMS sessions, delegation consumption and HTTP.
// Only downstream native/provider observations are synthetic. The native repo
// separately verifies organization-wide reservations and provider HTTP behavior.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { smsAuth,sessionCookie,digest,withSession } from './sms-auth.mjs';
import { gateway } from './gateway.mjs';
import { delegations } from './delegations.mjs';
import { appServer } from './http.mjs';
import { nativeCheckoutCommandSchema,checkoutResultMetadata } from '../supabase/functions/_shared/checkoutCommandProtocol.ts';

const databaseUrl=process.env.HUB_TEST_DATABASE_URL,local=new URL(databaseUrl);
assert.equal(local.hostname,'127.0.0.1');assert.equal(local.port,'54322');
const admin=new pg.Pool({connectionString:databaseUrl});
await admin.query("alter role hub_app_server login password 'ephemeral-test-only'");
const appUrl=new URL(databaseUrl);appUrl.username='hub_app_server';appUrl.password='ephemeral-test-only';
let databaseFailure=null;
class FixtureClient extends pg.Client {
  query(...args) { const result=super.query(...args);return result?.catch?result.catch(error=>{databaseFailure={code:error.code,message:error.message};throw error;}):result; }
}
const pool=new pg.Pool({connectionString:appUrl.href,Client:FixtureClient});
const owner=randomUUID(),other=randomUUID(),organization=randomUUID(),packageId=randomUUID(),phone='+12025550701',otherPhone='+12025550702';
await admin.query("insert into auth.users(id,email,is_anonymous) values($1,'checkout-owner@test.invalid',false),($2,'checkout-other@test.invalid',false)",[owner,other]);
await admin.query("insert into private.staff_permissions(user_id,permission) values($1,'platform.admin'),($2,'platform.admin')",[owner,other]);
await admin.query('insert into private.sms_identities(user_id,phone_e164) values($1,$2),($3,$4)',[owner,phone,other,otherPhone]);
const records=new Map(),sessionId='cs_test_SyntheticOriginal',checkoutUrl=`https://checkout.stripe.com/c/pay/${sessionId}#synthetic%2Ffixture`;
let nativeRevoked=false,dropPreview=true,dropOpen=false,pending=true,tamper=false,revokeAfterNative=false,calls=0,providerWrites=0;
let terminal=null,released=false,stopBeforeProvider=false,recoverExpired=false,holdObservation=null;
let dropRecovery=false,noReservation=false;
const provider={send:async()=>randomUUID(),verify:async(_id,_phone,code)=>code==='123456'};
const auth=smsAuth({pool,provider});
const caps=delegations({pool,storageUrl:'https://storage.test',fetchImpl:async(url,options)=>{
  calls++;assert.equal(url,'https://cmcarebase.com/api/platform-admin/billing/command');
  assert.equal(options.redirect,'error');assert.equal(options.cache,'no-store');
  assert.deepEqual(Object.keys(options.headers).sort(),['Authorization','Content-Type']);
  const command=nativeCheckoutCommandSchema.parse(JSON.parse(options.body)),ticket=options.headers.Authorization.slice(7);
  const actor=await caps.consume(ticket,'carebase.command');
  assert.ok([owner,other].includes(actor.user_id));assert.equal(actor.method,'sms');assert.deepEqual(actor.operation,command);
  assert.ok(Date.parse(actor.assurance_expires_at)>Date.now());await assert.rejects(caps.consume(ticket,'carebase.command'));
  if(nativeRevoked)return Response.json({error:{code:'forbidden'}},{status:403});
  let data;
  if(command.operation==='preview') {
    let record=records.get(command.requestId);
    if(!record) {
      record={preview:{commandId:randomUUID(),action:command.action,targetId:command.targetId,reason:command.reason,
        expiresAt:new Date(Date.now()+240000).toISOString(),previewDigest:digest(JSON.stringify(command)),
        summary:{kind:'checkout',organizationName:'Synthetic organization',packageId,billingInterval:'month',intervalCount:3,currency:'usd',
          billingMetric:'flat',quantity:1,providerPriceId:'price_Synthetic',providerCustomerId:null,trialDays:14}},session:null};
      records.set(command.requestId,record);
    }
    if(dropPreview){dropPreview=false;throw new Error('Simulated lost preview response');}data=record.preview;
  } else if(command.operation==='recover') {
    if(noReservation) data={targetId:command.targetId,preview:null,result:null,canStartNewCheckout:released};
    else {
      let record=records.get(command.requestId);
      if(!record) {
        const original=records.get(request.requestId);
        record={preview:{...original.preview,commandId:randomUUID(),action:command.action,reason:command.reason,
          expiresAt:new Date(Date.now()+240000).toISOString(),previewDigest:digest(JSON.stringify(command))},
          session:original.session,readonly:true};records.set(command.requestId,record);
      }
      const result={commandId:record.preview.commandId,action:command.action,targetId:command.targetId,replayed:true,
        outcome:pending?'pending':'open',checkedAt:pending?null:new Date().toISOString(),providerStatus:pending?null:'open',
        availability:pending?'unavailable':'available',canStartNewCheckout:false,retryAfterSeconds:pending?30:null,session:pending?null:record.session};
      data={targetId:command.targetId,preview:record.preview,result,canStartNewCheckout:false};
      if(dropRecovery){dropRecovery=false;throw new Error('Simulated lost recovery response');}
    }
    if(holdObservation) {const held=holdObservation;holdObservation=null;held.started();await held.release;}
  } else {
    const record=[...records.values()].find(value=>value.preview.commandId===command.commandId);
    assert.ok(record);assert.equal(command.expectedDigest,record.preview.previewDigest);
    if(stopBeforeProvider){stopBeforeProvider=false;throw new Error('Dispatch stopped before native provider work');}
    if(record.readonly)assert.equal(command.operation,'check');
    const base={commandId:command.commandId,action:command.action,targetId:record.preview.targetId,replayed:true};
    if(!record.session && command.operation==='apply') {
      providerWrites++;record.session={kind:'checkout',id:sessionId,url:checkoutUrl,expiresAt:new Date(Date.now()+3600000).toISOString(),livemode:false};
    }
    if(recoverExpired) {
      assert.equal(command.operation,'check');assert.equal(record.session,null);assert.ok(Date.parse(record.preview.expiresAt)<=Date.now());
      data={...base,outcome:'failed',checkedAt:new Date().toISOString(),providerStatus:null,availability:'available',canStartNewCheckout:true,retryAfterSeconds:null,session:null};
    } else if(!record.session && command.operation==='check') {
      assert.ok(Date.parse(record.preview.expiresAt)>Date.now());
      return Response.json({error:{code:'conflict'}},{status:409});
    } else if(terminal) {
      data={...base,outcome:terminal,checkedAt:new Date().toISOString(),providerStatus:terminal,availability:'available',canStartNewCheckout:released,retryAfterSeconds:null,session:null};
    } else if(pending) {
      data={...base,outcome:'pending',checkedAt:null,providerStatus:null,availability:'unavailable',canStartNewCheckout:false,retryAfterSeconds:30,session:null};
    } else {
      assert.ok(record.session,'GET-only check cannot manufacture a native session');
      data={...base,outcome:'open',checkedAt:new Date().toISOString(),providerStatus:'open',availability:'available',canStartNewCheckout:false,retryAfterSeconds:null,session:record.session};
      if(tamper)data={...data,session:{...data.session,id:'cs_test_Changed',url:'https://checkout.stripe.com/c/pay/cs_test_Changed'}};
      if(dropOpen){dropOpen=false;throw new Error('Simulated lost open observation');}
    }
    if(holdObservation) {const held=holdObservation;holdObservation=null;held.started();await held.release;}
    if(revokeAfterNative){revokeAfterNative=false;await admin.query("delete from private.staff_permissions where user_id=$1 and permission='platform.admin'",[owner]);}
  }
  return Response.json({contractVersion:1,product:'carebase',operation:command.operation,generatedAt:new Date().toISOString(),data});
}});
const server=appServer({auth,gateway:gateway(pool),delegations:caps,origins:['https://hub.test']});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`;
const jar={},otherJar={},newSessionJar={};
async function call(path,body,cookies=jar,headers={}) {
  const response=await fetch(origin+'/api/'+path,{method:'POST',headers:{Origin:'https://hub.test','Content-Type':'application/json',Cookie:Object.entries(cookies).map(([k,v])=>`${k}=${v}`).join('; '),...headers},body:JSON.stringify(body)});
  assert.equal(response.headers.get('cache-control'),'no-store');
  for(const value of response.headers.getSetCookie()){const [pair]=value.split(';'),i=pair.indexOf('=');cookies[pair.slice(0,i)]=pair.slice(i+1);}
  return {status:response.status,body:await response.json()};
}
async function login(cookies,number) {
  const start=await call('auth/sms/start',{phone:number},cookies);assert.equal(start.status,200);
  assert.equal((await call('auth/sms/verify',{challengeId:start.body.challengeId,code:'123456'},cookies)).status,200);
}
const checkout=(body,cookies=jar,headers={})=>call('admin/checkout-command',body,cookies,headers);
const resume=()=>checkout({operation:'resume',targetId:organization});
const request={operation:'preview',requestId:randomUUID(),action:'billing.checkout.create',targetId:organization,parameters:{packageId,billingInterval:'month'},reason:'Review synthetic organization subscription checkout'};
const identity=(preview,operation='apply')=>({operation,action:preview.action,commandId:preview.commandId,expectedDigest:preview.previewDigest});
try {
  assert.equal((await resume()).status,401);await login(jar,phone);await login(otherJar,otherPhone);
  assert.equal((await checkout(request,jar,{Origin:'https://untrusted.test'})).status,403);
  assert.equal((await checkout({...request,parameters:{...request.parameters,priceId:'price_Arbitrary'}})).status,400);assert.equal(calls,0);
  assert.equal((await checkout(request)).status,503);assert.equal(calls,1,JSON.stringify(databaseFailure));
  let saved=await resume();assert.equal(saved.status,200);assert.equal(saved.body.preview,null);assert.ok(saved.body.previewDispatchedAt);assert.deepEqual(saved.body.request,request);
  assert.equal((await checkout({operation:'discard',requestId:request.requestId})).status,409);
  assert.equal((await checkout({...request,requestId:randomUUID()})).status,409);
  assert.equal((await checkout({...request,reason:'Changed reviewed request under the same key'})).status,409);
  const preview=await checkout(request);assert.equal(preview.status,200,JSON.stringify(databaseFailure));assert.equal(records.size,1);
  const apply=identity(preview.body.preview),check=identity(preview.body.preview,'check');
  const beforeClaim=calls;assert.equal((await checkout(check)).status,409);assert.equal(calls,beforeClaim);
  assert.equal((await checkout(apply,otherJar)).status,403);assert.equal(calls,beforeClaim);
  let result=await checkout(apply);assert.equal(result.status,200,JSON.stringify(databaseFailure));assert.equal(result.body.outcome,'pending');assert.equal(providerWrites,1);
  saved=await resume();assert.equal(saved.body.result.outcome,'pending');assert.ok(saved.body.dispatchedAt);assert.ok(saved.body.retryAt);
  assert.equal((await checkout({...request,requestId:randomUUID()})).status,409);
  pending=false;dropOpen=true;assert.equal((await checkout(check)).status,503);assert.equal(providerWrites,1);
  result=await checkout(check);assert.equal(result.status,200,JSON.stringify(databaseFailure));assert.equal(result.body.session.url,checkoutUrl);assert.equal(providerWrites,1);
  saved=await resume();assert.equal(saved.body.result.session.url,undefined);
  const stored=await admin.query('select request::text,preview::text,result::text from private.billing_checkout_intents where request_id=$1',[request.requestId]);
  assert.equal(JSON.stringify(stored.rows).includes(checkoutUrl),false);
  assert.equal((await admin.query("select count(*)::int as count from private.audit_events where actor_id=$1 and metadata::text like '%checkout.stripe.com%'",[owner])).rows[0].count,0);
  const claim=await withSession(pool,jar[sessionCookie],async db=>{await db.query('reset role');return (await db.query('select private.claim_billing_checkout($1,$2,true) as value',[apply.commandId,apply.expectedDigest])).rows[0].value;});
  await assert.rejects(withSession(pool,jar[sessionCookie],async db=>{await db.query('reset role');return db.query('select private.record_billing_checkout_result($1,$2,$3::jsonb)',[apply.commandId,claim.observationId,JSON.stringify(result.body)]);}),error=>error.code==='22023');
  pending=true;assert.equal((await checkout(check)).status,200);pending=false;tamper=true;
  assert.equal((await checkout(check)).status,409,'Session identity survives an intervening pending observation');tamper=false;
  // Hold an earlier open observation while a later completed check commits.
  let release,started;const start=new Promise(resolve=>{started=resolve;});
  holdObservation={started,release:new Promise(resolve=>{release=resolve;})};
  const older=checkout(check);await start;terminal='complete';
  const newer=await checkout(check);assert.equal(newer.status,200,JSON.stringify(databaseFailure));assert.equal(newer.body.outcome,'complete');
  release();const stale=await older;assert.equal(stale.status,409);assert.equal(JSON.stringify(stale.body).includes(checkoutUrl),false);
  saved=await resume();assert.equal(saved.body.result.outcome,'complete');assert.equal(saved.body.result.canStartNewCheckout,false);
  assert.equal((await checkout({...request,requestId:randomUUID()})).status,409);
  nativeRevoked=true;assert.equal((await checkout(check)).status,403);nativeRevoked=false;
  revokeAfterNative=true;assert.equal((await checkout(check)).status,401);
  const deniedCalls=calls;assert.equal((await checkout(check)).status,401);assert.equal(calls,deniedCalls);
  await admin.query("insert into private.staff_permissions(user_id,permission) values($1,'platform.admin')",[owner]);
  released=true;assert.equal((await checkout(check)).body.canStartNewCheckout,true);assert.equal(providerWrites,1);
  // A new review is possible only after the native result released the prior one.
  const nextRequest={...request,requestId:randomUUID()},next=await checkout(nextRequest);assert.equal(next.status,200,JSON.stringify(databaseFailure));
  terminal=null;stopBeforeProvider=true;assert.equal((await checkout(identity(next.body.preview))).status,503);assert.equal(providerWrites,1);
  assert.equal((await checkout(identity(next.body.preview,'check'))).status,409,'An unexpired never-dispatched native preview is not released');
  await admin.query("update private.billing_checkout_intents set preview_expires_at=clock_timestamp()-interval '1 second' where request_id=$1",[nextRequest.requestId]);
  records.get(nextRequest.requestId).preview.expiresAt=new Date(Date.now()-1000).toISOString();
  recoverExpired=true;const recovered=await checkout(identity(next.body.preview,'check'));assert.equal(recovered.status,200,JSON.stringify(databaseFailure));
  assert.equal(recovered.body.outcome,'failed');assert.equal(recovered.body.canStartNewCheckout,true);assert.equal(providerWrites,1);recoverExpired=false;
  const expiringRequest={...request,requestId:randomUUID()},expiring=await checkout(expiringRequest);assert.equal(expiring.status,200);
  await admin.query("update private.billing_checkout_intents set preview_expires_at=clock_timestamp()-interval '1 second' where request_id=$1",[expiringRequest.requestId]);
  const beforeExpiry=calls;assert.equal((await checkout(identity(expiring.body.preview))).status,409);assert.equal(calls,beforeExpiry);
  await admin.query("update private.sms_challenges set created_at=now()-interval '2 minutes' where user_id=$1",[owner]);await login(newSessionJar,phone);
  assert.equal((await checkout(check,newSessionJar)).status,403);
  assert.equal((await checkout({operation:'resume',targetId:organization},newSessionJar)).body,null);
  // A fresh real SMS session recovers the organization reservation without a
  // new native price lookup or any inheritance of the old creation capability.
  await admin.query('update private.sms_sessions set revoked_at=now() where token_hash=$1',[digest(jar[sessionCookie])]);
  pending=false;terminal=null;released=false;
  const recovery={operation:'recover',action:'billing.checkout.recover',requestId:randomUUID(),targetId:organization,reason:'Inspect prior session original checkout terms'};
  dropRecovery=true;assert.equal((await checkout(recovery,newSessionJar)).status,503);
  const uncertain=await checkout({operation:'resume',targetId:organization},newSessionJar);
  assert.equal(uncertain.body.request.action,'billing.checkout.recover');assert.equal(uncertain.body.preview,null);assert.ok(uncertain.body.dispatchedAt);
  const originalRecovery=await checkout(recovery,newSessionJar);assert.equal(originalRecovery.status,200,JSON.stringify(databaseFailure));
  assert.deepEqual(originalRecovery.body.preview.summary,preview.body.preview.summary);assert.notEqual(originalRecovery.body.preview.commandId,apply.commandId);
  assert.equal(originalRecovery.body.result.session.url,undefined);assert.equal(providerWrites,1);
  const recoveredCheck=identity(originalRecovery.body.preview,'check');
  assert.equal((await checkout(identity(originalRecovery.body.preview),newSessionJar)).status,400,'HTTP recovery apply is outside the closed union');
  assert.equal((await checkout({...identity(originalRecovery.body.preview),action:'billing.checkout.create'},newSessionJar)).status,403,'Relabelling a recovery command cannot obtain creation authority');
  await assert.rejects(withSession(pool,newSessionJar[sessionCookie],async db=>{await db.query('reset role');return db.query('select private.claim_billing_checkout($1,$2,false)',[recoveredCheck.commandId,recoveredCheck.expectedDigest]);}),error=>error.code==='42501');
  await admin.query("update private.billing_checkout_intents set preview_expires_at=clock_timestamp()-interval '1 minute' where request_id=$1",[recovery.requestId]);
  const current=await checkout(recoveredCheck,newSessionJar);assert.equal(current.status,200,JSON.stringify(databaseFailure));assert.equal(current.body.session.url,checkoutUrl);assert.equal(providerWrites,1);
  let releaseRecovery,startedRecovery;const recoveryStarted=new Promise(resolve=>{startedRecovery=resolve;});
  holdObservation={started:startedRecovery,release:new Promise(resolve=>{releaseRecovery=resolve;})};
  const oldRecovery=checkout(recovery,newSessionJar);await recoveryStarted;pending=true;
  assert.equal((await checkout(recoveredCheck,newSessionJar)).body.outcome,'pending');
  releaseRecovery();const supersededRecovery=await oldRecovery;assert.equal(supersededRecovery.status,409);
  assert.equal(JSON.stringify(supersededRecovery.body).includes(checkoutUrl),false);pending=false;
  assert.equal((await checkout({operation:'resume',targetId:organization},newSessionJar)).body.result.outcome,'pending');
  assert.equal((await checkout(recoveredCheck,otherJar)).status,403);
  const otherRecovery=await checkout({...recovery,requestId:randomUUID()},otherJar);assert.equal(otherRecovery.status,200,JSON.stringify(databaseFailure));
  assert.equal((await admin.query("select count(*)::int as count from private.audit_events where actor_id=$1 and action='billing.checkout.result'",[other])).rows[0].count,1,'Recovery observation belongs to current inspecting actor');
  noReservation=true;released=false;
  const noneRequest={...recovery,requestId:randomUUID()},none=await checkout(noneRequest,newSessionJar);assert.equal(none.status,200,JSON.stringify(databaseFailure));
  assert.equal(none.body.preview,null);assert.equal(none.body.result,null);assert.equal(none.body.recovery.canStartNewCheckout,false);
  assert.equal((await checkout({...request,requestId:randomUUID()},newSessionJar)).status,409);
  released=true;assert.equal((await checkout(noneRequest,newSessionJar)).body.recovery.canStartNewCheckout,true);assert.equal(providerWrites,1);
  assert.equal((await checkout({...request,requestId:randomUUID()},newSessionJar)).status,200,'Latest native recovery release supersedes an older cached hold');
  assert.equal(JSON.stringify(checkoutResultMetadata(result.body)).includes(checkoutUrl),false);
  console.log('Checkout PostgreSQL/HTTP integration passed: exact durable request, GET-only recovery, observation race, immutable session identity, release evidence, current Hub/native authority and URL-free metadata.');
} finally {
  await new Promise(resolve=>server.close(resolve));
  await admin.query('delete from private.billing_checkout_intents where actor_id=any($1::uuid[])',[[owner,other]]);
  await admin.query('delete from private.app_delegations where session_id in(select id from private.sms_sessions where user_id=any($1::uuid[]))',[[owner,other]]);
  await admin.query('delete from private.sms_sessions where user_id=any($1::uuid[])',[[owner,other]]);
  await admin.query('delete from private.sms_challenges where user_id=any($1::uuid[])',[[owner,other]]);
  await admin.query('delete from private.sms_identities where user_id=any($1::uuid[])',[[owner,other]]);
  await admin.query('delete from auth.users where id=any($1::uuid[])',[[owner,other]]);
  await pool.end();await admin.end();
}
