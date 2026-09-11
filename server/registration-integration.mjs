// Disposable PostgreSQL and actual HTTP routes. No vendor call or real SMS.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { smsAuth,digest,token,sessionCookie,challengeCookie,withSession } from './sms-auth.mjs';
import { gateway } from './gateway.mjs';
import { delegations } from './delegations.mjs';
import { appServer } from './http.mjs';
import { adminRegistry } from '../supabase/functions/_shared/adminRegistry.ts';
const local=new URL(process.env.HUB_TEST_DATABASE_URL);assert.equal(local.hostname,'127.0.0.1');assert.equal(local.port,'54322');
const admin=new pg.Pool({connectionString:local.href});
await admin.query("alter role hub_app_server login password 'ephemeral-test-only'");
local.username='hub_app_server';local.password='ephemeral-test-only';const pool=new pg.Pool({connectionString:local.href});
const owner=randomUUID(),outsider=randomUUID(),ownerSession=randomUUID(),otherSession=randomUUID(),ownerToken=token(),otherToken=token();
const claimed=[],tenants=[],sent=[],verified=[];let nativeAllowed=true,nativeRevision='a'.repeat(64),providerAccepts=true,providerFails=false,bridge;
const provider={send:async phone=>{if(providerFails)throw new Error('Synthetic provider outage');sent.push(phone);return randomUUID();},
  verify:async(id,phone,code)=>{verified.push({id,phone});return providerAccepts&&code==='123456';}};
const fetchImpl=async(url,options)=>{
  const product=Object.entries(adminRegistry).find(([,entry])=>entry.endpoint===url)?.[0];assert.ok(product);
  assert.equal(options.redirect,'error');const op=JSON.parse(options.body);
  const capability=new Headers(options.headers).get(adminRegistry[product].authorizationHeader??'Authorization').slice(7);
  const actor=await bridge.consume(capability,product);assert.equal(actor.method,'sms');assert.equal(actor.user_id,owner);assert.deepEqual(actor.operation,op);
  await assert.rejects(bridge.consume(capability,product));
  if(!nativeAllowed)return Response.json({error:'synthetic native denial'},{status:403});
  return Response.json({contractVersion:1,product,operation:op.operation,generatedAt:new Date().toISOString(),data:{product,
    sourceUserId:op.sourceUserId,sourceAccountId:op.sourceAccountId,accountKind:product==='intel'?'individual':product==='pennsync'?'agency':'organization',
    relationship:product==='intel'?'individual_owner':product==='pennsync'?'agency_member':'organization_member',revision:nativeRevision}});
};
bridge=delegations({pool,provider,storageUrl:'https://storage.invalid',fetchImpl});
const auth=smsAuth({pool,provider});const server=appServer({auth,gateway:gateway(pool),delegations:bridge,origins:['https://hub.fixture.invalid']});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}/api/`;
const ownerJar={[sessionCookie]:ownerToken},otherJar={[sessionCookie]:otherToken};
async function call(path,body,{jar=ownerJar,headers={}}={}){
  const response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{Origin:'https://hub.fixture.invalid','Content-Type':'application/json',
    Cookie:Object.entries(jar).map(([k,v])=>`${k}=${v}`).join('; '),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
  for(const value of response.headers.getSetCookie()){const [key,val]=value.split(';')[0].split('=');jar[key]=val;assert.match(value,/HttpOnly/);assert.match(value,/Secure/);assert.match(value,/SameSite=Strict/);}
  assert.equal(response.headers.get('cache-control'),'no-store');return {status:response.status,body:await response.json()};
}
let phoneCounter=10;
function input(product='breathe'){
  const native=()=>['intel','pennsync'].includes(product)?randomUUID().replaceAll('-','').slice(0,24):randomUUID();
  const sourceUserId=native();return {operation:'preview',product,sourceUserId,sourceAccountId:product==='intel'?sourceUserId:native(),
    phone:`+120255509${String(phoneCounter++).padStart(2,'0')}`,displayName:'Synthetic invited customer',tenantName:'Synthetic customer account'};
}
async function prepare(fields=input()){
  const result=await call('admin/registration',fields);assert.equal(result.status,200);return {fields,preview:result.body};
}
async function issue(prepared,extra={}){
  const op={operation:'issue',reviewId:prepared.preview.reviewId,proofDigest:prepared.preview.proofDigest,requestId:randomUUID(),claimCode:token(),reviewed:true,...extra};
  return {op,result:await call('admin/registration',op)};
}
async function invite(product='breathe'){const prepared=await prepare(input(product)),issued=await issue(prepared);assert.equal(issued.result.status,200);return {...prepared,...issued};}
const start=(inv,jar={},extra={})=>call('auth/invitation/start',{claimCode:inv.op.claimCode,phone:inv.fields.phone,consent:true,...extra},{jar});
const verify=(challenge,jar,code='123456')=>call('auth/invitation/verify',{challengeId:challenge.body.challengeId,code},{jar});
try {
  await admin.query("insert into auth.users(id,email,is_anonymous) values($1,'registration-owner@test.invalid',false),($2,'registration-other@test.invalid',false)",[owner,outsider]);
  await admin.query("insert into private.staff_permissions(user_id,permission) values($1,'platform.admin')",[owner]);
  await admin.query("insert into private.sms_identities(user_id,phone_e164,verified_at) values($1,'+12025550901',now()),($2,'+12025550902',now())",[owner,outsider]);
  for(const [id,uid,value] of [[ownerSession,owner,ownerToken],[otherSession,outsider,otherToken]])await admin.query("insert into private.sms_sessions(id,token_hash,user_id,identity_version,expires_at) select $1,$2,user_id,identity_version,now()+interval '1 hour' from private.sms_identities where user_id=$3",[id,digest(value),uid]);
  assert.equal((await call('admin/registration',input(),{jar:{}})).status,401);
  assert.equal((await call('admin/registration',input(),{jar:otherJar})).status,403);
  assert.equal((await call('admin/registration',input(),{headers:{Origin:'https://external.invalid'}})).status,403);
  await assert.rejects(withSession(pool,ownerToken,db=>db.query('select hub.prepare_support_registration($1,$2,$3,$4,$5,$6)',[owner,ownerSession,'{}','+12025550903','Denied','Denied'])));
  assert.equal((await call('rpc/complete_support_registration',{p_challenge_id:randomUUID()})).status,400);
  const staged=await prepare();assert.equal(sent.length,0);
  assert.equal((await admin.query('select count(*) from private.support_registration_invitations where actor_id=$1',[owner])).rows[0].count,'0');
  nativeRevision='b'.repeat(64);assert.equal((await issue(staged)).result.status,409);nativeRevision='a'.repeat(64);
  nativeAllowed=false;assert.equal((await issue(staged)).result.status,403);nativeAllowed=true;
  assert.equal((await issue(staged,{reviewed:false})).result.status,400);
  const issued=await issue(staged);assert.equal(issued.result.status,200);
  assert.equal((await call('admin/registration',issued.op)).status,200,'same reviewed request is idempotent');
  const invitation={...staged,...issued},jar={};
  assert.equal((await start(invitation,jar,{consent:false})).status,400);
  const wrongNumber=await start(invitation,{}, {phone:'+12025550999'});assert.equal(wrongNumber.status,200);assert.equal(sent.length,0);
  const challenge=await start(invitation,jar);assert.equal(challenge.status,200);assert.deepEqual(sent,[staged.fields.phone]);
  assert.equal((await start(invitation,{})).status,429,'persisted shared resend limit');
  assert.equal((await verify(challenge,{})).status,400,'browser cookie required');
  assert.equal((await verify(challenge,{[challengeCookie]:token()})).status,401,'challenge bound to the initiating browser');
  assert.equal((await verify(challenge,jar,'000000')).status,401);assert.equal((await verify(challenge,jar)).status,200);
  const list=(await call('admin/registration',{operation:'list',offset:0})).body;
  const row=list.rows.find(r=>r.invitationId===issued.op.requestId);assert.equal(row.state,'claimed');claimed.push(row.hubUserId);
  assert.ok(!JSON.stringify(list).includes(issued.op.claimCode));assert.ok(!JSON.stringify(list).includes(staged.fields.phone));
  assert.equal((await call('auth/session',undefined,{jar})).body.authenticated,true);
  assert.equal((await call('auth/invitation/verify',{challengeId:challenge.body.challengeId,code:'123456'},{jar})).status,400,'used browser challenge is cleared');
  assert.equal((await admin.query('select count(*) from hub.tenant_product_memberships where user_id=$1',[row.hubUserId])).rows[0].count,'0');
  assert.equal((await admin.query('select count(*) from private.staff_permissions where user_id=$1',[row.hubUserId])).rows[0].count,'0');
  assert.equal((await call('admin/registration',input(),{jar})).status,403);
  // App access is a distinct review with a fresh native relationship.
  const pairing=await bridge.onboarding(ownerToken,{operation:'preview',product:staged.fields.product,sourceUserId:staged.fields.sourceUserId,
    sourceAccountId:staged.fields.sourceAccountId,hubUserId:row.hubUserId,tenantName:staged.fields.tenantName});
  tenants.push(pairing.hubTenantId);nativeAllowed=false;
  await assert.rejects(bridge.onboarding(ownerToken,{operation:'apply',intentId:pairing.intentId,proofDigest:pairing.proofDigest,requestId:randomUUID(),reviewed:true}));nativeAllowed=true;
  const linked=await bridge.onboarding(ownerToken,{operation:'apply',intentId:pairing.intentId,proofDigest:pairing.proofDigest,requestId:randomUUID(),reviewed:true});assert.equal(linked.intakeEnabled,false);
  for(const product of ['carebase','caremetric-emr','caremetric-go','pennsync','intel']){
    const inv=await invite(product),customerJar={},started=await start(inv,customerJar);assert.equal(started.status,200);assert.equal((await verify(started,customerJar)).status,200);
    const uid=(await admin.query('select claimed_user_id from private.support_registration_invitations where id=$1',[inv.op.requestId])).rows[0].claimed_user_id;
    claimed.push(uid);assert.equal((await admin.query('select count(*) from hub.tenant_product_memberships where user_id=$1',[uid])).rows[0].count,'0');
  }
  const revoked=await invite();assert.equal((await call('admin/registration',{operation:'revoke',invitationId:revoked.op.requestId,reviewed:true})).status,200);
  const beforeRevoke=sent.length;assert.equal((await start(revoked)).status,200);assert.equal(sent.length,beforeRevoke);
  const expiring=await invite();await admin.query("update private.support_registration_invitations set expires_at=now()-interval '1 second' where id=$1",[expiring.op.requestId]);
  await start(expiring);assert.equal(sent.length,beforeRevoke);
  const locked=await invite(),lockedJar={},lockedChallenge=await start(locked,lockedJar);
  for(let n=0;n<5;n++)assert.equal((await verify(lockedChallenge,lockedJar,'000000')).status,401);
  const attempts=verified.length;assert.equal((await verify(lockedChallenge,lockedJar)).status,401);assert.equal(verified.length,attempts,'provider is not called after five failures');
  const outage=await invite();providerFails=true;assert.equal((await start(outage)).status,503);providerFails=false;assert.equal((await start(outage)).status,429);
  const demoted=await invite(),demotedJar={},demotedChallenge=await start(demoted,demotedJar);
  await admin.query('update private.staff_permissions set revoked_at=now() where user_id=$1',[owner]);
  assert.equal((await verify(demotedChallenge,demotedJar)).status,401,'issuing administrator must still be authorized');
  await admin.query('update private.staff_permissions set revoked_at=null where user_id=$1',[owner]);
  await admin.query('update private.sms_sessions set revoked_at=now() where id=$1',[ownerSession]);
  assert.equal((await verify(demotedChallenge,demotedJar)).status,401,'issuing session revocation invalidates unclaimed invites');
  console.log('First-use registration: all six native proofs, exact phone and browser, SMS consent, bounded retries, revocation, private token hashes, no grants at claim, and fresh reviewed app pairing passed.');
} finally {
  const users=[owner,outsider,...claimed];
  await admin.query('delete from private.audit_events where actor_id=any($1::uuid[])',[users]);
  await admin.query('delete from private.sms_challenges where registration_invitation_id in(select id from private.support_registration_invitations where actor_id=$1)',[owner]);
  await admin.query('delete from private.sms_challenges where phone_hash=any($1::text[])',[[...sent,'+12025550999'].map(digest)]);
  await admin.query('delete from private.support_registration_invitations where actor_id=$1',[owner]);
  await admin.query('delete from private.support_registration_reviews where actor_id=$1',[owner]);
  await admin.query('delete from private.support_onboarding_intents where actor_id=$1',[owner]);
  await admin.query('delete from private.federated_principals where hub_user_id=any($1::uuid[])',[users]);
  await admin.query('delete from private.federated_tenants where hub_tenant_id=any($1::uuid[])',[tenants]);
  await admin.query('delete from hub.tenants where id=any($1::uuid[])',[tenants]);
  await admin.query('delete from private.app_delegations where session_id in(select id from private.sms_sessions where user_id=any($1::uuid[]))',[users]);
  await admin.query('delete from private.sms_sessions where user_id=any($1::uuid[])',[users]);
  await admin.query('delete from private.sms_identities where user_id=any($1::uuid[])',[users]);
  await admin.query('delete from auth.users where id=any($1::uuid[])',[users]);
  await new Promise(resolve=>server.close(resolve));await pool.end();await admin.end();
}
