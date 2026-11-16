// Disposable local PostgreSQL + real HttpOnly SMS transport; synthetic identities only.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { smsAuth,sessionCookie,digest,transaction,withSession } from './sms-auth.mjs';
import { gateway } from './gateway.mjs';
import { delegations } from './delegations.mjs';
import { appServer } from './http.mjs';
import { removeTestIdentities, testPhones } from './test-phones.mjs';
const phones = testPhones(import.meta.url);
const databaseUrl=process.env.HUB_TEST_DATABASE_URL;const local=new URL(databaseUrl);
assert.equal(local.hostname,'127.0.0.1');assert.equal(local.port,'54322');
const admin=new pg.Pool({connectionString:databaseUrl});
await admin.query("alter role hub_app_server login password 'ephemeral-test-only'");
const appUrl=new URL(databaseUrl);appUrl.username='hub_app_server';appUrl.password='ephemeral-test-only';
const pool=new pg.Pool({connectionString:appUrl.href});
const owner=randomUUID(),learner=randomUUID(),phone=phones.owner,org=randomUUID(),employee=randomUUID(),profile=randomUUID(),tenant=randomUUID(),mapping=randomUUID(),snapshot=randomUUID(),item=randomUUID(),course=randomUUID(),version=randomUUID(),assignment=randomUUID();
await admin.query(`insert into auth.users(id,email,is_anonymous) values($1,'receipt-sms-owner@test.invalid',false),($2,'receipt-sms-learner@test.invalid',false)`,[owner,learner]);
await admin.query("insert into private.staff_permissions(user_id,permission) values($1,'platform.admin')",[owner]);
await admin.query('insert into private.sms_identities(user_id,phone_e164) values($1,$2)',[owner,phone]);
await admin.query("insert into hub.content_items(id,content_key,kind,status,access_level,source_system) values($1,$2,'course','published','public','penntrain')",[item,'receipt.integration.'+item]);
await admin.query(`insert into private.learning_source_snapshots(id,item_id,source_course_id,source_version_id,source_revision,sequence,publication_state,source_payload,staged_by)
 values($1,$2,$3,$4,$5,1,'published',$6,$7)`,[snapshot,item,course,version,'a'.repeat(64),JSON.stringify({course:{title:'Receipt fixture'}}),owner]);
let pending=[];const events=[];
const provider={send:async()=>randomUUID(),verify:async(_id,_phone,code)=>code==='123456'};
const auth=smsAuth({pool,provider});
const caps=delegations({pool,storageUrl:'https://storage.test',fetchImpl:async(url,options)=>{
  assert.equal(url,'https://cmcarebase.com/api/learning-admin/receipt');assert.equal(options.redirect,'error');
  assert.equal(Object.keys(options.headers).length,2);assert.ok(options.signal instanceof AbortSignal);
  const op=JSON.parse(options.body),ticket=options.headers.Authorization.slice(7);
  const authority=await caps.consume(ticket,'carebase.learning');
  assert.equal(authority.user_id,owner);assert.equal(authority.method,'sms');assert.equal(authority.aal,undefined);
  assert.deepEqual(authority.operation,op);assert.ok(authority.session_id);assert.ok(Date.parse(authority.assurance_expires_at)>Date.now());
  await assert.rejects(caps.consume(ticket,'carebase.learning'),/Invalid authorization/);
  events.push(op.operation);
  if(op.operation==='resolve_identity') return Response.json({organizationId:org,employeeId:employee,profileId:profile});
  if(op.operation==='provision') return Response.json({mappingId:op.mappingId,sourceRevision:op.sourceRevision,active:true});
  if(op.operation==='list') return Response.json(pending);
  if(op.operation==='acknowledge') {pending=[];return Response.json({success:true});}
  return Response.json({success:true});
}});
const server=appServer({auth,gateway:gateway(pool),delegations:caps,origins:['https://hub.test']});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`;const jar={};
async function call(path,body,headers={}) {
  const response=await fetch(origin+'/api/'+path,{method:'POST',headers:{Origin:'https://hub.test','Content-Type':'application/json',Cookie:Object.entries(jar).map(([k,v])=>`${k}=${v}`).join('; '),...headers},body:JSON.stringify(body)});
  for(const value of response.headers.getSetCookie()){const [pair]=value.split(';');const i=pair.indexOf('=');jar[pair.slice(0,i)]=pair.slice(i+1);}
  return {status:response.status,body:await response.json()};
}
try {
  assert.equal((await call('admin/learning',{operation:'status'})).status,401);
  const challenge=await call('auth/sms/start',{phone});assert.equal(challenge.status,200);
  assert.equal((await call('auth/sms/verify',{challengeId:challenge.body.challengeId,code:'123456'})).status,200);
  assert.equal((await call('admin/learning',{operation:'status'},{Origin:'https://evil.test'})).status,403);
  const access=await call('admin/learning',{operation:'provision_access',nativeOrganizationId:org,nativeEmployeeId:employee,hubTenantId:tenant,tenantName:'Receipt integration tenant',hubUserId:learner});
  assert.equal(access.status,200,JSON.stringify(access.body));assert.equal(access.body.hubTenantId,tenant);
  assert.equal((await admin.query('select enabled from private.case_intake_settings where tenant_id=$1',[tenant])).rows[0].enabled,false);
  assert.equal((await admin.query('select enabled from private.federation_issuers where issuer=$1',['https://xsqobvvreaovwibxwyvv.supabase.co/auth/v1'])).rows[0].enabled,false);
  const bind=await call('admin/learning',{operation:'provision',mappingId:mapping,sourceSnapshotId:snapshot,nativeOrganizationId:org,nativeEmployeeId:employee,hubTenantId:tenant,hubUserId:learner});
  assert.equal(bind.status,200,JSON.stringify(bind.body));
  const session=(await admin.query('select id from private.sms_sessions where token_hash=$1',[digest(jar[sessionCookie])])).rows[0].id;
  await assert.rejects(withSession(pool,jar[sessionCookie],async db=>{await db.query('reset role');await db.query('select hub.get_learning_receipt_status($1,$2)',[learner,session]);}),/Current administrator command session required/);
  await assert.rejects(transaction(admin,async db=>{await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:owner,sms_session_id:session})]);await db.query('select hub.get_learning_receipt_status($1,$2)',[owner,session]);}),/Current administrator command session required/);
  const receipt={contract:'caremetric.learning-receipt.v1',source:'carebase',eventId:randomUUID(),kind:'completed',sequence:1,mappingId:mapping,assignmentId:assignment,sourceCourseId:course,sourceVersionId:version,mappingRevision:'a'.repeat(64),assignmentRevision:'a'.repeat(64),completionRevision:'a'.repeat(64),hubTenantId:tenant,hubUserId:learner,completedAt:'2026-09-11T15:00:00Z',evidenceSha256:'b'.repeat(64),finalExamScore:90,certificate:{id:randomUUID(),issuedAt:'2026-09-11T15:00:00Z',expiresAt:null,providerEvidenceSha256:'c'.repeat(64)},credits:[],attestations:[],quizEvidenceSha256:'d'.repeat(64),renewalEvidenceSha256:'e'.repeat(64)};
  const envelope=value=>({eventId:value.eventId,payload:JSON.stringify(value),sourceDigest:digest(JSON.stringify(value)),state:'pending',reason:null});
  pending=[envelope(receipt)];const completion=await call('admin/learning',{operation:'reconcile',limit:10});assert.equal(completion.status,200,JSON.stringify(completion.body));assert.equal(completion.body.accepted,1);
  pending=[envelope(receipt)];assert.equal((await call('admin/learning',{operation:'reconcile',limit:10})).body.accepted,1);
  assert.equal(Number((await admin.query('select count(*) from private.learning_receipt_inbox where assignment_id=$1',[assignment])).rows[0].count),1);
  assert.equal(Number((await admin.query('select count(*) from private.learning_enrollments where user_id=$1',[learner])).rows[0].count),0);
  await admin.query('update private.federated_principals set revoked_at=now() where hub_user_id=$1',[learner]);
  pending=[envelope({...receipt,eventId:randomUUID(),assignmentId:randomUUID()})];assert.equal((await call('admin/learning',{operation:'reconcile',limit:10})).status,403);
  await admin.query('update private.federated_principals set revoked_at=null where hub_user_id=$1',[learner]);
  pending=[envelope({...receipt,eventId:randomUUID(),kind:'retracted',sequence:2})];assert.equal((await call('admin/learning',{operation:'reconcile',limit:10})).body.accepted,1);
  const status=await call('admin/learning',{operation:'status'});assert.equal(status.body.receipts.find(r=>r.assignmentId===assignment).kind,'retracted');
  await admin.query('update private.staff_permissions set revoked_at=now() where user_id=$1',[owner]);assert.equal((await call('admin/learning',{operation:'status'})).status,401);
  await admin.query('update private.staff_permissions set revoked_at=null where user_id=$1',[owner]);
  await admin.query("update private.sms_sessions set created_at=now()-interval '9 hours' where id=$1",[session]);assert.equal((await call('admin/learning',{operation:'status'})).status,401);
  await admin.query("update private.sms_sessions set created_at=now() where id=$1",[session]);
  await admin.query('update private.sms_identities set revoked_at=now() where user_id=$1',[owner]);assert.equal((await call('admin/learning',{operation:'status'})).status,401);
  assert.ok(events.includes('acknowledge'));
  console.log('Learning SMS HTTP/PostgreSQL integration passed: explicit canonical access, operation-bound authority, exact receipts, replay, withdrawal, no duplicate writer, principal/session/actor revocation.');
} finally {await new Promise(resolve=>server.close(resolve));await removeTestIdentities(admin,[owner,learner],{also:['delete from private.learning_receipt_inbox where mapping_id in (select id from private.learning_receipt_mappings where created_by = any($1::uuid[]))','delete from private.learning_receipt_mappings where created_by = any($1::uuid[])','delete from private.learning_source_snapshots where staged_by = any($1::uuid[])']});await pool.end();await admin.end();}
