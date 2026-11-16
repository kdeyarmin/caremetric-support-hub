// Real disposable Hub PostgreSQL, SMS session cookies and one-use delegation.
// Native records are a deterministic transport fixture; CareBase CI tests its actual SQL writers.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {smsAuth,sessionCookie,digest} from './sms-auth.mjs';
import {gateway} from './gateway.mjs';
import {delegations} from './delegations.mjs';
import {appServer} from './http.mjs';
import { testPhones } from './test-phones.mjs';
const phones = testPhones(import.meta.url);

const local=new URL(process.env.HUB_TEST_DATABASE_URL);
assert.equal(local.hostname,'127.0.0.1');assert.equal(local.port,'54322');
const admin=new pg.Pool({connectionString:local.href});
await admin.query("alter role hub_app_server login password 'ephemeral-test-only'");
const appUrl=new URL(local);appUrl.username='hub_app_server';appUrl.password='ephemeral-test-only';
const pool=new pg.Pool({connectionString:appUrl.href}),owner=randomUUID(),phone=phones.owner;
const organizationId=randomUUID(),facilityId=randomUUID(),employeeId=randomUUID(),courseId=randomUUID(),assignmentId=randomUUID();
const domain='training.v1',commands=new Map();
let calls=0,writes=0,revokeAfterWrite=false,nativeRevoked=false,tamper=false,oversized=false;
const auth=smsAuth({pool,provider:{send:async()=>randomUUID(),verify:async(_id,_phone,code)=>code==='123456'}});
const caps=delegations({pool,storageUrl:'https://storage.test',fetchImpl:async(url,options)=>{
  calls++;assert.equal(url,'https://cmcarebase.com/api/platform-admin/training');
  assert.equal(options.redirect,'error');assert.equal(options.cache,'no-store');assert.ok(options.signal instanceof AbortSignal);
  const operation=JSON.parse(options.body),ticket=options.headers.Authorization.slice(7);
  await assert.rejects(caps.consume(ticket,'carebase'));
  const actor=await caps.consume(ticket,'carebase.command');
  assert.equal(actor.user_id,owner);assert.equal(actor.method,'sms');assert.deepEqual(actor.operation,operation);
  assert.ok(Date.parse(actor.assurance_expires_at)>Date.now());await assert.rejects(caps.consume(ticket,'carebase.command'));
  if(nativeRevoked)return Response.json({error:{privateDetail:'never expose'}},{status:403});
  if(oversized)return Response.json({error:{privateDetail:'never expose'}},{status:413});
  if(operation.operation==='facilities.list')return Response.json({items:[{id:facilityId,name:'Fixture facility',facilityType:'PCH',isActive:true}],total:tamper?2:1,limit:operation.limit,offset:operation.offset});
  if(operation.operation==='enrollments.report')return Response.json({organization_name:'Fixture organization',facility_name:'Fixture facility',generated_at:new Date().toISOString(),date_basis:operation.dateBasis,
    limit:operation.limit,offset:operation.offset,total:1,students:1,completed:0,in_progress:1,not_started:0,canceled:0,completion_denominator:1,certificates:0,
    rows:[{id:assignmentId,employee_id:employeeId,student:'Fixture learner',facility_id:facilityId,facility:'Fixture facility',course_id:courseId,course:'Fixture course',status:'in_progress',assigned_at:'2026-09-25T01:00:00Z',due_date:null,completed_at:null,percent_complete:50,certificate_id:null,credential_number:null,certificate_issued_at:null,certificate_pdf_status:null,privateDetail:'stripped'}]});
  assert.equal(operation.operation,'apply');
  const previous=commands.get(operation.requestId);
  if(previous){
    if(previous.actor!==actor.user_id||JSON.stringify(previous.operation)!==JSON.stringify(operation))return Response.json({error:{code:'conflict'}},{status:409});
    return Response.json({...previous.result,replayed:true});
  }
  const result={requestId:operation.requestId,action:operation.action,organizationId,replayed:false,result:{organizationId,facilityId}};
  commands.set(operation.requestId,{actor:actor.user_id,operation,result});writes++;
  if(revokeAfterWrite)await admin.query('update private.staff_permissions set revoked_at=now() where user_id=$1',[owner]);
  return Response.json(result);
}});
const server=appServer({auth,gateway:gateway(pool),delegations:caps,origins:['https://hub.test']});
let origin;const jar={};
async function call(path,body,headers={}){
  const response=await fetch(origin+'/api/'+path,{method:'POST',headers:{Origin:'https://hub.test','Content-Type':'application/json',Cookie:Object.entries(jar).map(([k,v])=>`${k}=${v}`).join('; '),...headers},body:JSON.stringify(body)});
  assert.equal(response.headers.get('cache-control'),'no-store');
  for(const value of response.headers.getSetCookie()){const [pair]=value.split(';'),index=pair.indexOf('=');jar[pair.slice(0,index)]=pair.slice(index+1);}
  return {status:response.status,body:await response.json()};
}
const run=body=>call('admin/training',body),list={domain,operation:'facilities.list',organizationId,limit:20,offset:0,search:''};
try {
  await admin.query("insert into auth.users(id,email,is_anonymous) values($1,'training-hub-owner@test.invalid',false)",[owner]);
  await admin.query("insert into private.staff_permissions(user_id,permission) values($1,'platform.admin')",[owner]);
  await admin.query('insert into private.sms_identities(user_id,phone_e164) values($1,$2)',[owner,phone]);
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{server.off('error',reject);resolve();});});
  origin=`http://127.0.0.1:${server.address().port}`;
  assert.equal((await run(list)).status,401);
  const challenge=await call('auth/sms/start',{phone});assert.equal(challenge.status,200);
  assert.equal((await call('auth/sms/verify',{challengeId:challenge.body.challengeId,code:'123456'})).status,200);
  assert.match(jar[sessionCookie],/^[A-Za-z0-9_-]{43}$/);
  assert.equal((await call('admin/training',list,{Origin:'https://evil.test'})).status,403);
  assert.equal((await call('admin/training?organizationId='+organizationId,list)).status,400);
  const initial=await run(list);assert.equal(initial.status,200,JSON.stringify(initial));assert.equal(initial.body.items[0].id,facilityId);
  const beforeInvalid=calls;
  for(const request of [{...list,actor:owner},{...list,domain:'operations.config.v1'},{...list,organizationId:null},{...list,limit:101}])assert.equal((await run(request)).status,400);
  assert.equal(calls,beforeInvalid);
  const command={domain,operation:'apply',requestId:randomUUID(),action:'facilities.provision',organizationId:null,parameters:{organizationName:'Fixture organization',facilityName:'Fixture facility',facilityType:'PCH'},reason:'Reviewed fixture training facility'};
  assert.equal((await call('admin/command',command)).status,400);
  revokeAfterWrite=true;const uncertain=await run(command);assert.ok([401,403].includes(uncertain.status));assert.equal(writes,1);
  revokeAfterWrite=false;await admin.query('update private.staff_permissions set revoked_at=null where user_id=$1',[owner]);
  const recovered=await run(command);assert.equal(recovered.status,200,JSON.stringify(recovered));assert.equal(recovered.body.replayed,true);assert.equal(writes,1);
  assert.equal((await run({...command,reason:'Different reason cannot reuse request'})).status,409);assert.equal(writes,1);
  const report={domain,operation:'enrollments.report',organizationId,facilityId,courseSearch:'',status:'all',dateBasis:'assigned',dateFrom:null,dateThrough:null,limit:10000,offset:0};
  const beforeReport=calls,exported=await run(report);assert.equal(exported.status,200,JSON.stringify(exported));assert.equal(calls,beforeReport+1);
  assert.equal(exported.body.rows.length,exported.body.total);assert.equal(exported.body.rows[0].percent_complete,50);assert.equal(JSON.stringify(exported).includes('privateDetail'),false);
  oversized=true;const capped=await run(report);assert.equal(capped.status,413);assert.equal(capped.body.error.code,'report_too_large');oversized=false;
  tamper=true;assert.equal((await run(list)).status,503);tamper=false;
  nativeRevoked=true;const denied=await run(list);assert.equal(denied.status,403);assert.equal(JSON.stringify(denied).includes('privateDetail'),false);nativeRevoked=false;
  await admin.query("update private.sms_sessions set created_at=now()-interval '9 hours' where token_hash=$1",[digest(jar[sessionCookie])]);
  const beforeExpired=calls;assert.ok([401,403].includes((await run(report)).status));assert.equal(calls,beforeExpired);
  await admin.query('update private.sms_identities set revoked_at=now() where user_id=$1',[owner]);assert.equal((await run(list)).status,401);
  console.log('Training Hub PostgreSQL/SMS/HTTP passed: fresh owner, same-origin boundary, exact one-use command audience, projected scoped report, same-request recovery, export cap, current authority and bounded assurance. Native writes are fixtures.');
} finally {
  try {
    if(server.listening)await new Promise(resolve=>server.close(resolve));
    await admin.query('delete from private.app_delegations where session_id in(select id from private.sms_sessions where user_id=$1)',[owner]);
    await admin.query('delete from private.sms_challenges where user_id=$1 or phone_hash=$2',[owner,digest(phone)]);
    await admin.query('delete from private.sms_sessions where user_id=$1',[owner]);
    await admin.query('delete from private.sms_identities where user_id=$1',[owner]);
    await admin.query('delete from private.staff_permissions where user_id=$1',[owner]);
    await admin.query('delete from auth.users where id=$1',[owner]);
  } finally {await Promise.all([pool.end(),admin.end()]);}
}
