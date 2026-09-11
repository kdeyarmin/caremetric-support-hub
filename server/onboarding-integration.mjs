// Actual PostgreSQL + opaque SMS session + consumed native capabilities.
// Disposable local fixtures only. No vendor/customer requests or SMS sends.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { digest, withSession } from './sms-auth.mjs';
import { delegations } from './delegations.mjs';
import { adminRegistry } from '../supabase/functions/_shared/adminRegistry.ts';
const local=new URL(process.env.HUB_TEST_DATABASE_URL);assert.equal(local.hostname,'127.0.0.1');assert.equal(local.port,'54322');
const admin=new pg.Pool({connectionString:local.href});
await admin.query("alter role hub_app_server login password 'ephemeral-test-only'");
local.username='hub_app_server';local.password='ephemeral-test-only';const pool=new pg.Pool({connectionString:local.href});
const owner=randomUUID(),customer=randomUUID(),other=randomUUID(),ownerSession=randomUUID(),secondSession=randomUUID();
const ownerToken='onboard-owner-'+randomUUID(),secondToken='onboard-second-'+randomUUID(),customerToken='onboard-customer-'+randomUUID();
const userId=randomUUID(),accountId=randomUUID(),tenants=new Set();
let nativeRevision='a'.repeat(64),nativeAllowed=true,nativeCalls=0,bridge;
const fetchImpl=async(url,options)=>{
  const product=Object.entries(adminRegistry).find(([,entry])=>entry.endpoint===url)?.[0];
  assert.ok(['breathe','caremetric-emr','caremetric-go','pennsync','intel'].includes(product));
  assert.equal(options.redirect,'error');assert.equal(options.method,'POST');
  const headers=new Headers(options.headers);const auth=headers.get(adminRegistry[product].authorizationHeader??'Authorization');
  const actor=await bridge.consume(auth.slice(7),product);const op=JSON.parse(options.body);
  assert.deepEqual(actor.operation,op);assert.equal(actor.method,'sms');assert.equal(actor.role,'platform_admin');nativeCalls++;
  await assert.rejects(bridge.consume(auth.slice(7),product),'capabilities are single use');
  if(!nativeAllowed)return Response.json({private:'never return this'},{status:403});
  const accountKind=product==='intel'?'individual':product==='pennsync'?'agency':'organization';
  const relationship=product==='intel'?'individual_owner':product==='pennsync'?'agency_member':'organization_member';
  return Response.json({contractVersion:1,product,operation:op.operation,generatedAt:new Date().toISOString(),data:{product,sourceUserId:op.sourceUserId,sourceAccountId:op.sourceAccountId,accountKind,relationship,revision:nativeRevision}});
};
bridge=delegations({pool,storageUrl:'https://storage.invalid',fetchImpl});
const preview=async(extra={},token=ownerToken)=>{
  const value=await bridge.onboarding(token,{operation:'preview',product:'caremetric-go',sourceUserId:userId,sourceAccountId:accountId,hubUserId:customer,tenantName:'Synthetic support account',...extra});
  tenants.add(value.hubTenantId);return value;
};
const apply=(p,requestId=randomUUID(),token=ownerToken,extra={})=>bridge.onboarding(token,{operation:'apply',intentId:p.intentId,proofDigest:p.proofDigest,requestId,reviewed:true,...extra});
try {
  await admin.query("insert into auth.users(id,email,is_anonymous) values($1,'onboard-owner@test.invalid',false),($2,'onboard-customer@test.invalid',false),($3,'onboard-other@test.invalid',false)",[owner,customer,other]);
  await admin.query("insert into private.staff_permissions(user_id,permission) values($1,'platform.admin')",[owner]);
  await admin.query("insert into private.sms_identities(user_id,phone_e164,verified_at) values($1,'+12025550501',now()),($2,'+12025550502',now()),($3,'+12025550503',now())",[owner,customer,other]);
  for(const [id,user,token] of [[ownerSession,owner,ownerToken],[secondSession,owner,secondToken],[randomUUID(),customer,customerToken]]) {
    await admin.query("insert into private.sms_sessions(id,token_hash,user_id,identity_version,expires_at) select $1,$2,user_id,identity_version,now()+interval '1 hour' from private.sms_identities where user_id=$3",[id,digest(token),user]);
  }
  await assert.rejects(preview({},null));await assert.rejects(preview({},customerToken));
  await assert.rejects(preview({product:'carebase'}));
  await assert.rejects(withSession(pool,ownerToken,db=>db.query('select hub.prepare_support_onboarding($1,$2,$3,$4,$5)',[owner,ownerSession,'{}',customer,'Denied browser'])));
  await assert.rejects(preview({hubUserId:randomUUID()}));
  const staged=await preview();assert.equal(staged.intakeEnabled,false);assert.equal(staged.access,'customer');assert.equal(staged.caseScope,'own');
  assert.equal((await admin.query('select count(*) from hub.tenants where id=$1',[staged.hubTenantId])).rows[0].count,'0','preview grants nothing');
  await assert.rejects(apply(staged,randomUUID(),secondToken),'session-bound review');
  await assert.rejects(apply(staged,randomUUID(),ownerToken,{reviewed:false}));
  await assert.rejects(apply(staged,randomUUID(),ownerToken,{proofDigest:'b'.repeat(64)}));
  nativeRevision='b'.repeat(64);await assert.rejects(apply(staged));nativeRevision='a'.repeat(64);
  nativeAllowed=false;await assert.rejects(apply(staged));nativeAllowed=true;
  const request=randomUUID(),result=await apply(staged,request);assert.equal(result.replayed,false);
  assert.equal((await apply(staged,request)).replayed,true);await assert.rejects(apply(staged,randomUUID()));
  const rows=(await admin.query('select m.role,m.case_scope,m.can_manage_members,s.enabled from hub.tenant_product_memberships m join private.case_intake_settings s using(tenant_id,product_id) where m.tenant_id=$1',[result.hubTenantId])).rows;
  assert.deepEqual(rows,[{role:'customer',case_scope:'own',can_manage_members:false,enabled:false}]);
  assert.equal((await admin.query("select count(*) from private.staff_permissions where user_id=$1",[customer])).rows[0].count,'0');
  assert.equal((await admin.query("select count(*) from private.audit_events where actor_id=$1 and action='support.customer.link'",[owner])).rows[0].count,'1');
  const repoint=await preview({hubUserId:other});await assert.rejects(apply(repoint));
  const stale=await preview();await admin.query('update hub.tenants set name=$2 where id=$1',[result.hubTenantId,'Changed fixture name']);await assert.rejects(apply(stale));
  const expired=await preview();await admin.query("update private.support_onboarding_intents set expires_at=now()-interval '1 second' where id=$1",[expired.intentId]);await assert.rejects(apply(expired));
  const ban=await preview();await admin.query("update auth.users set banned_until=now()+interval '1 hour' where id=$1",[customer]);await assert.rejects(apply(ban));await admin.query('update auth.users set banned_until=null where id=$1',[customer]);
  const revoked=await preview();await admin.query('update private.sms_identities set revoked_at=now() where user_id=$1',[customer]);await assert.rejects(apply(revoked));await admin.query('update private.sms_identities set revoked_at=null where user_id=$1',[customer]);
  const concurrent=await Promise.all([preview(),preview()]);const sameRequest=randomUUID();
  const outcomes=await Promise.allSettled(concurrent.map(p=>apply(p,sameRequest)));assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1,'durable request key cannot apply two intents');
  const otherProduct=await preview({product:'caremetric-emr'});const emrResult=await apply(otherProduct);assert.notEqual(emrResult.hubTenantId,result.hubTenantId,'shared backend does not imply cross-product grants');
  const intel=await preview({product:'intel',sourceUserId:'a'.repeat(24),sourceAccountId:'a'.repeat(24)});assert.equal((await apply(intel)).product,'intel');
  const breathe=await preview({product:'breathe',sourceUserId:'CasePreserved_Legacy'});assert.equal((await apply(breathe)).product,'breathe');
  const penn=await preview({product:'pennsync',sourceUserId:'b'.repeat(24),sourceAccountId:'c'.repeat(24)});assert.equal((await apply(penn)).product,'pennsync');
  const demoted=await preview();await admin.query('update private.staff_permissions set revoked_at=now() where user_id=$1',[owner]);await assert.rejects(apply(demoted));await admin.query('update private.staff_permissions set revoked_at=null where user_id=$1',[owner]);
  await admin.query('update private.sms_sessions set revoked_at=now() where id=$1',[ownerSession]);await assert.rejects(apply(staged,request));
  assert.ok(nativeCalls>10);console.log('Customer onboarding: real SMS authority, one-use native proof, reviewed pairing, fresh recheck, CAS, durable retries, revocation and all five products passed.');
} catch(error) { console.error('Customer onboarding fixture failed:',error); throw error;
} finally {
  await admin.query('delete from private.audit_events where actor_id=$1',[owner]);
  await admin.query('delete from private.support_onboarding_intents where actor_id=$1',[owner]);
  await admin.query('delete from private.federated_principals where hub_user_id in ($1,$2)',[customer,other]);
  await admin.query('delete from private.federated_tenants where hub_tenant_id=any($1::uuid[])',[Array.from(tenants)]);
  await admin.query('delete from hub.tenants where id=any($1::uuid[])',[Array.from(tenants)]);
  await admin.query('delete from private.app_delegations where session_id in(select id from private.sms_sessions where user_id=any($1::uuid[]))',[[owner,customer,other]]);
  await admin.query('delete from private.sms_sessions where user_id=any($1::uuid[])',[[owner,customer,other]]);
  await admin.query('delete from private.sms_identities where user_id=any($1::uuid[])',[[owner,customer,other]]);
  await admin.query('delete from auth.users where id=any($1::uuid[])',[[owner,customer,other]]);
  await pool.end();await admin.end();
}
