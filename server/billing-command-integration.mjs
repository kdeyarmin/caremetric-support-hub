// Disposable PostgreSQL + real SMS cookies, authorization, delegation and HTTP.
// Native/Stripe observations are deterministic fixtures; the native repository
// separately verifies its own ledger and the actual producer-to-Hub composition.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { smsAuth,sessionCookie,digest,withSession } from './sms-auth.mjs';
import { gateway } from './gateway.mjs';
import { delegations } from './delegations.mjs';
import { appServer } from './http.mjs';
import { billingResultMetadata, nativeBillingCommandSchema } from '../supabase/functions/_shared/billingCommandProtocol.ts';

const databaseUrl=process.env.HUB_TEST_DATABASE_URL,local=new URL(databaseUrl);
assert.equal(local.hostname,'127.0.0.1');assert.equal(local.port,'54322');
const admin=new pg.Pool({connectionString:databaseUrl});
await admin.query("alter role hub_app_server login password 'ephemeral-test-only'");
const appUrl=new URL(databaseUrl);appUrl.username='hub_app_server';appUrl.password='ephemeral-test-only';
const pool=new pg.Pool({connectionString:appUrl.href});
const owner=randomUUID(),other=randomUUID(),organization=randomUUID(),phone='+12025550601',otherPhone='+12025550602';
await admin.query("insert into auth.users(id,email,is_anonymous) values($1,'billing-owner@test.invalid',false),($2,'billing-other@test.invalid',false)",[owner,other]);
await admin.query("insert into private.staff_permissions(user_id,permission) values($1,'platform.admin'),($2,'platform.admin')",[owner,other]);
await admin.query('insert into private.sms_identities(user_id,phone_e164) values($1,$2),($3,$4)',[owner,phone,other,otherPhone]);
let nativeRevoked=false,customerDrift=false,dropPreview=true,dropCreated=false,pending=true,tamper=false,revokeAfterNative=false,calls=0,providerWrites=0;
const records=new Map(),portalUrl='https://billing.stripe.com/p/session?secret=test_private_fixture';
const provider={send:async()=>randomUUID(),verify:async(_id,_phone,code)=>code==='123456'};
const auth=smsAuth({pool,provider});
const caps=delegations({pool,storageUrl:'https://storage.test',fetchImpl:async(url,options)=>{
  calls++;assert.equal(url,'https://cmcarebase.com/api/platform-admin/billing/command');
  assert.equal(options.redirect,'error');assert.equal(options.cache,'no-store');
  assert.deepEqual(Object.keys(options.headers).sort(),['Authorization','Content-Type']);
  const command=nativeBillingCommandSchema.parse(JSON.parse(options.body)),ticket=options.headers.Authorization.slice(7);
  const actor=await caps.consume(ticket,'carebase.command');
  assert.equal(actor.user_id,owner);assert.equal(actor.method,'sms');assert.deepEqual(actor.operation,command);
  assert.ok(Date.parse(actor.assurance_expires_at)>Date.now());
  await assert.rejects(caps.consume(ticket,'carebase.command'));
  if(nativeRevoked)return Response.json({error:{code:'forbidden'}},{status:403});
  if(customerDrift)return Response.json({error:{code:'conflict'}},{status:409});
  let data;
  if(command.operation==='preview') {
    let record=records.get(command.requestId);
    if(!record) {
      record={preview:{commandId:randomUUID(),action:command.action,targetId:command.targetId,reason:command.reason,
        expiresAt:new Date(Date.now()+240000).toISOString(),previewDigest:digest(JSON.stringify(command)),
        summary:{kind:'portal',organizationName:'Synthetic organization',providerCustomerId:'cus_Test',providerConfigurationId:'bpc_Test',returnPath:'/admin/enterprise'}},result:null};
      records.set(command.requestId,record);
    }
    if(dropPreview){dropPreview=false;throw new Error('Simulated lost native preview response');}
    data=record.preview;
  } else {
    const record=[...records.values()].find(value=>value.preview.commandId===command.commandId);
    assert.ok(record);assert.equal(command.expectedDigest,record.preview.previewDigest);
    if(!record.result) {
      providerWrites++;
      record.result={commandId:command.commandId,action:'billing.portal.create',targetId:record.preview.targetId,outcome:'created',replayed:false,
        completedAt:new Date().toISOString(),retryAfterSeconds:null,session:{kind:'portal',id:'bps_Test',url:portalUrl,expiresAt:null,livemode:false}};
    }
    data=pending?{commandId:command.commandId,action:'billing.portal.create',targetId:record.preview.targetId,outcome:'pending',replayed:true,completedAt:null,retryAfterSeconds:30,session:null}
      :{...record.result,replayed:true};
    if(dropCreated&&!pending){dropCreated=false;throw new Error('Simulated lost native result response');}
    if(tamper&&!pending)data={...data,session:{...data.session,id:'bps_Different'}};
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
  const verified=await call('auth/sms/verify',{challengeId:start.body.challengeId,code:'123456'},cookies);assert.equal(verified.status,200);
}
const billing=(body,cookies=jar,headers={})=>call('admin/billing-command',body,cookies,headers);
const resume=()=>billing({operation:'resume',targetId:organization});
const request={operation:'preview',requestId:randomUUID(),action:'billing.portal.create',targetId:organization,parameters:{},reason:'Review synthetic organization billing options'};
try {
  assert.equal((await resume()).status,401);await login(jar,phone);await login(otherJar,otherPhone);
  assert.equal((await billing(request,jar,{Origin:'https://untrusted.test'})).status,403);
  assert.equal((await billing({...request,parameters:{returnUrl:'https://untrusted.test'}})).status,400);
  assert.equal(calls,0);
  assert.equal((await billing(request)).status,503);
  let saved=await resume();assert.equal(saved.status,200);assert.equal(saved.body.preview,null);assert.ok(saved.body.previewDispatchedAt);
  assert.deepEqual(saved.body.request,request);
  assert.equal((await billing({operation:'discard',requestId:request.requestId})).status,409);
  assert.equal((await billing({...request,requestId:randomUUID()})).status,409);
  assert.equal((await billing({...request,reason:'Changed reason under an existing request key'})).status,409);
  const preview=await billing(request);assert.equal(preview.status,200);assert.equal(records.size,1);
  assert.deepEqual(preview.body.request,request);assert.ok(preview.body.preview);
  const apply={operation:'apply',commandId:preview.body.preview.commandId,expectedDigest:preview.body.preview.previewDigest};
  const beforeOther=calls;
  assert.equal((await billing(apply,otherJar)).status,403);assert.equal(calls,beforeOther);
  assert.equal((await billing({operation:'resume',targetId:organization},otherJar)).body,null);
  let applied=await billing(apply);assert.equal(applied.status,200);assert.equal(applied.body.outcome,'pending');assert.equal(applied.body.retryAfterSeconds,30);
  assert.equal(providerWrites,1);assert.equal((await billing({...request,requestId:randomUUID()})).status,409);
  saved=await resume();assert.equal(saved.body.result.outcome,'pending');assert.ok(saved.body.dispatchedAt);assert.ok(saved.body.retryAt);
  assert.equal((await billing({operation:'discard',requestId:request.requestId})).status,409);
  pending=false;dropCreated=true;assert.equal((await billing(apply)).status,503);assert.equal(providerWrites,1);
  applied=await billing(apply);assert.equal(applied.status,200);assert.equal(applied.body.outcome,'created');assert.equal(applied.body.session.url,portalUrl);
  assert.equal(providerWrites,1);
  saved=await resume();assert.equal(saved.body.result.outcome,'created');assert.equal(saved.body.result.session.url,undefined);
  const stored=await admin.query('select request::text,preview::text,result::text from private.billing_portal_intents where request_id=$1',[request.requestId]);
  assert.equal(JSON.stringify(stored.rows).includes(portalUrl),false);
  assert.equal((await admin.query("select count(*)::int as count from private.audit_events where actor_id=$1 and metadata::text like '%billing.stripe.com%'",[owner])).rows[0].count,0);
  await assert.rejects(withSession(pool,jar[sessionCookie],async db=>{await db.query('reset role');return db.query('select private.record_billing_portal_result($1,$2::jsonb)',[apply.commandId,JSON.stringify(applied.body)]);}),error=>error.code==='22023');
  const stalePending={...applied.body,outcome:'pending',completedAt:null,retryAfterSeconds:30,session:null};
  const preserved=await withSession(pool,jar[sessionCookie],async db=>{await db.query('reset role');return (await db.query('select private.record_billing_portal_result($1,$2::jsonb) as result',[apply.commandId,JSON.stringify(stalePending)])).rows[0].result;});
  assert.equal(preserved.result.outcome,'created');
  nativeRevoked=true;assert.equal((await billing(apply)).status,403);nativeRevoked=false;
  customerDrift=true;assert.equal((await billing(apply)).status,409);customerDrift=false;
  tamper=true;assert.equal((await billing(apply)).status,409);tamper=false;
  revokeAfterNative=true;const revokedResponse=await billing(apply);assert.equal(revokedResponse.status,403);assert.equal(JSON.stringify(revokedResponse.body).includes(portalUrl),false);
  const afterRevocation=calls;assert.equal((await resume()).status,403);assert.equal((await billing(apply)).status,403);assert.equal(calls,afterRevocation);
  await admin.query("insert into private.staff_permissions(user_id,permission) values($1,'platform.admin')",[owner]);
  assert.equal((await billing(apply)).status,200);assert.equal(providerWrites,1);
  const expiringRequest={...request,requestId:randomUUID()};const expiring=await billing(expiringRequest);assert.equal(expiring.status,200);
  await admin.query("update private.billing_portal_intents set preview_expires_at=clock_timestamp()-interval '1 second' where request_id=$1",[expiringRequest.requestId]);
  const beforeExpiry=calls;
  assert.equal((await billing({operation:'apply',commandId:expiring.body.preview.commandId,expectedDigest:expiring.body.preview.previewDigest})).status,409);assert.equal(calls,beforeExpiry);
  // A distinct current SMS session for the same person still cannot inherit the
  // original session's saved portal capability. Both sessions are real records.
  await admin.query("update private.sms_challenges set created_at=now()-interval '2 minutes' where user_id=$1",[owner]);
  await login(newSessionJar,phone);
  assert.equal((await billing(apply,newSessionJar)).status,403);
  assert.equal((await billing({operation:'resume',targetId:organization},newSessionJar)).body,null);
  assert.deepEqual(saved.body.result,billingResultMetadata({...applied.body,replayed:true}));
  console.log('Billing portal PostgreSQL/HTTP integration passed: lost-preview reservation, exact retry identity, pending recovery, fresh native/Hub/session authority, URL-free durable metadata, terminal immutability and expired-preview denial.');
} finally {
  await new Promise(resolve=>server.close(resolve));
  await admin.query('delete from private.billing_portal_intents where actor_id=any($1::uuid[])',[[owner,other]]);
  await admin.query('delete from private.app_delegations where session_id in(select id from private.sms_sessions where user_id=any($1::uuid[]))',[[owner,other]]);
  await admin.query('delete from private.sms_sessions where user_id=any($1::uuid[])',[[owner,other]]);
  await admin.query('delete from private.sms_challenges where user_id=any($1::uuid[])',[[owner,other]]);
  await admin.query('delete from private.sms_identities where user_id=any($1::uuid[])',[[owner,other]]);
  await admin.query('delete from auth.users where id=any($1::uuid[])',[[owner,other]]);
  await pool.end();await admin.end();
}
