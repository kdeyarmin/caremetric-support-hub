// Actual disposable Hub PostgreSQL, opaque SMS cookies and one-use capabilities.
// Native provider writes are a deterministic transport fixture; CareBase's SQL
// gate separately exercises CAS, signature timestamps, audit and issued records.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {smsAuth,sessionCookie,digest} from './sms-auth.mjs';
import {gateway} from './gateway.mjs';
import {delegations} from './delegations.mjs';
import {appServer} from './http.mjs';
import {providerContext,providerPreview,providerResult} from '../src/learning/testFixtures/provider.ts';
const local=new URL(process.env.HUB_TEST_DATABASE_URL);assert.equal(local.hostname,'127.0.0.1');assert.equal(local.port,'54322');
const admin=new pg.Pool({connectionString:local.href});
await admin.query("alter role hub_app_server login password 'ephemeral-test-only'");
const appUrl=new URL(local);appUrl.username='hub_app_server';appUrl.password='ephemeral-test-only';
const pool=new pg.Pool({connectionString:appUrl.href}),owner=randomUUID(),phone='+12025550821';
await admin.query("insert into auth.users(id,email,is_anonymous) values($1,'provider-sms-owner@test.invalid',false)",[owner]);
await admin.query("insert into private.staff_permissions(user_id,permission) values($1,'platform.admin')",[owner]);
await admin.query('insert into private.sms_identities(user_id,phone_e164) values($1,$2)',[owner,phone]);
const course=randomUUID(),profile=randomUUID(),context={...providerContext,courseId:course,profile:{...providerContext.profile,id:profile}};
const commands=new Map();let calls=0,writes=0,nativeRevoked=false,revokeAfterWrite=false,tamper=false;
const domain='course.provider.v1';
const auth=smsAuth({pool,provider:{send:async()=>randomUUID(),verify:async(_id,_phone,code)=>code==='123456'}});
const caps=delegations({pool,storageUrl:'https://storage.test',fetchImpl:async(url,options)=>{
  calls++;assert.equal(url,'https://cmcarebase.com/api/learning-admin/provider');assert.equal(options.redirect,'error');assert.equal(options.cache,'no-store');
  assert.deepEqual(Object.keys(options.headers).sort(),['Authorization','Content-Type']);
  const operation=JSON.parse(options.body),ticket=options.headers.Authorization.slice(7);
  const actor=await caps.consume(ticket,'carebase.learning');assert.equal(actor.user_id,owner);assert.equal(actor.method,'sms');assert.equal(actor.aal,undefined);
  assert.equal(actor.operation.domain,domain);assert.deepEqual(actor.operation,operation);
  await assert.rejects(caps.consume(ticket,'carebase.learning'),/Invalid authorization/);
  if(nativeRevoked)return Response.json({error:{code:'forbidden',privateDetail:'must not leak'}},{status:403});
  if(operation.operation==='context')return Response.json(tamper?{...context,providerContextRevision:'broken'}:context);
  if(operation.operation==='commands')return Response.json({items:[...commands.values()].filter(row=>row.owner===actor.user_id).slice(operation.offset,operation.offset+20).map(row=>({commandId:row.preview.commandId,expectedDigest:row.preview.previewDigest,expiresAt:row.preview.expiresAt,appliedAt:row.result?.appliedAt??null})),nextOffset:null});
  if(operation.operation==='preview'){
    if(operation.providerContextRevision!==context.providerContextRevision)return Response.json({error:{code:'conflict'}},{status:409});
    let row=commands.get(operation.requestId);
    if(!row){row={owner:actor.user_id,session:actor.session_id,preview:{...providerPreview,commandId:randomUUID(),courseId:course,providerContextRevision:context.providerContextRevision,
      reason:operation.reason,previewDigest:digest(JSON.stringify(operation)),changes:Object.entries(operation.patch).filter(([field,after])=>context.profile[field]!==after).map(([field,after])=>({field,before:context.profile[field],after})),impact:context.impact},result:null};commands.set(operation.requestId,row);}
    return Response.json(row.preview);
  }
  const row=[...commands.values()].find(entry=>entry.preview.commandId===operation.commandId);
  if(!row||row.owner!==actor.user_id||row.preview.previewDigest!==operation.expectedDigest)return Response.json({error:{code:'conflict'}},{status:409});
  if(operation.operation==='status')return Response.json({preview:row.preview,result:row.result,canApplyThisSession:row.result===null&&row.session===actor.session_id});
  assert.equal(operation.operation,'apply');
  if(row.session!==actor.session_id)return Response.json({error:{code:'forbidden'}},{status:403});
  if(row.result)return Response.json({...row.result,replayed:true});
  if(row.preview.providerContextRevision!==context.providerContextRevision)return Response.json({error:{code:'conflict'}},{status:409});
  for(const change of row.preview.changes)context.profile[change.field]=change.after;
  context.providerContextRevision=digest(JSON.stringify(context.profile));
  row.result={...providerResult,commandId:row.preview.commandId,courseId:course,providerId:profile,providerContextRevision:context.providerContextRevision};writes++;
  if(revokeAfterWrite)await admin.query('update private.staff_permissions set revoked_at=now() where user_id=$1',[owner]);
  return Response.json(row.result);
}});
const server=appServer({auth,gateway:gateway(pool),delegations:caps,origins:['https://hub.test']});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`,jar={};
async function call(path,body,headers={}){
  const response=await fetch(origin+'/api/'+path,{method:'POST',headers:{Origin:'https://hub.test','Content-Type':'application/json',Cookie:Object.entries(jar).map(([k,v])=>`${k}=${v}`).join('; '),...headers},body:JSON.stringify(body)});
  assert.equal(response.headers.get('cache-control'),'no-store');
  for(const value of response.headers.getSetCookie()){const [pair]=value.split(';'),i=pair.indexOf('=');jar[pair.slice(0,i)]=pair.slice(i+1);}
  return {status:response.status,body:await response.json()};
}
const run=body=>call('admin/provider',body),contextOp={domain,operation:'context',courseId:course};
async function login(){const challenge=await call('auth/sms/start',{phone});assert.equal(challenge.status,200);assert.equal((await call('auth/sms/verify',{challengeId:challenge.body.challengeId,code:'123456'})).status,200);assert.match(jar[sessionCookie],/^[A-Za-z0-9_-]{43}$/);}
try{
  assert.equal((await run(contextOp)).status,401);await login();
  assert.equal((await call('admin/provider',contextOp,{Origin:'https://evil.test'})).status,403);
  const initial=await run(contextOp);assert.equal(initial.status,200,JSON.stringify(initial.body));assert.equal(initial.body.impact.legacyFallbackCertificates,'9007199254740995');
  assert.ok(initial.body.profile.reviewNotes.length>12000);
  const beforeInvalid=calls;
  for(const op of [{operation:'context',courseId:course},{...contextOp,actor:owner},{domain,operation:'commands',courseId:course,offset:-1},
    {domain,operation:'preview',requestId:randomUUID(),courseId:course,providerContextRevision:context.providerContextRevision,patch:{reviewNotes:'{"token":"hidden"}'},reason:providerPreview.reason}])assert.equal((await run(op)).status,400);
  assert.equal(calls,beforeInvalid);
  const previewOp={domain,operation:'preview',requestId:randomUUID(),courseId:course,providerContextRevision:context.providerContextRevision,patch:{providerFullName:'Updated provider'},reason:providerPreview.reason};
  const preview=await run(previewOp);assert.equal(preview.status,200,JSON.stringify(preview.body));assert.deepEqual((await run(previewOp)).body,preview.body);assert.equal(writes,0);
  const apply={domain,operation:'apply',commandId:preview.body.commandId,expectedDigest:preview.body.previewDigest},status={...apply,operation:'status'};
  const beforeWrongRoute=calls;assert.equal((await call('admin/authoring',apply)).status,400);assert.equal((await call('admin/course-creation',apply)).status,400);assert.equal(calls,beforeWrongRoute);
  revokeAfterWrite=true;const lost=await run(apply);assert.ok([401,403].includes(lost.status),JSON.stringify(lost));assert.equal(writes,1);assert.equal(JSON.stringify(lost.body).includes('privateDetail'),false);
  revokeAfterWrite=false;await admin.query('update private.staff_permissions set revoked_at=null where user_id=$1',[owner]);
  const recovered=await run(status);assert.equal(recovered.status,200,JSON.stringify(recovered.body));assert.equal(recovered.body.result.commandId,apply.commandId);assert.equal(recovered.body.canApplyThisSession,false);
  assert.equal((await run(apply)).body.replayed,true);assert.equal(writes,1);
  const page=await run({domain,operation:'commands',courseId:course,offset:0});assert.equal(page.status,200);assert.equal(page.body.items[0].commandId,apply.commandId);
  nativeRevoked=true;assert.equal((await run(status)).status,403);nativeRevoked=false;
  tamper=true;assert.equal((await run(contextOp)).status,503);tamper=false;
  const pending=await run({...previewOp,requestId:randomUUID(),providerContextRevision:context.providerContextRevision,patch:{courseAuthor:'Reviewed author'}});assert.equal(pending.status,200);
  const pendingStatus={domain,operation:'status',commandId:pending.body.commandId,expectedDigest:pending.body.previewDigest};assert.equal((await run(pendingStatus)).body.canApplyThisSession,true);
  const oldToken=jar[sessionCookie];
  // Advance only the disposable send-quota event, then issue a genuine new SMS session.
  await admin.query("update private.sms_challenges set created_at=now()-interval '61 seconds' where phone_hash=$1",[digest(phone)]);await login();assert.notEqual(jar[sessionCookie],oldToken);
  const readOnly=await run(pendingStatus);assert.equal(readOnly.status,200,JSON.stringify(readOnly.body));assert.equal(readOnly.body.canApplyThisSession,false);assert.equal(readOnly.body.result,null);
  assert.equal((await run({...pendingStatus,operation:'apply'})).status,403);assert.equal(writes,1);
  assert.equal((await run(status)).body.result.commandId,apply.commandId);
  await admin.query('update private.sms_identities set revoked_at=now() where user_id=$1',[owner]);assert.equal((await run(status)).status,401);
  console.log('Provider PostgreSQL/SMS/HTTP passed: closed domain, current one-use authority, exact impact, uncertain-write recovery, new-session read-only status, native and Hub revocation, and no duplicate writes.');
}finally{await new Promise(resolve=>server.close(resolve));await pool.end();await admin.end();}
