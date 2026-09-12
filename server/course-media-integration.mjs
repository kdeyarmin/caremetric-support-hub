// Actual disposable Hub PostgreSQL, HTTP, SMS sessions and single-use tickets.
// Native media/Storage writes are a deterministic fixture; the native release
// separately tests its real immutable Storage, attachment and learner authority.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { smsAuth,sessionCookie,digest } from './sms-auth.mjs';
import { gateway } from './gateway.mjs';
import { delegations } from './delegations.mjs';
import { appServer } from './http.mjs';
import { parseMediaOperation } from '../supabase/functions/_shared/courseMediaProtocol.ts';

const database=new URL(process.env.HUB_TEST_DATABASE_URL);assert.equal(database.hostname,'127.0.0.1');assert.equal(database.port,'54322');
const admin=new pg.Pool({connectionString:database.href});await admin.query("alter role hub_app_server login password 'ephemeral-test-only'");
const appUrl=new URL(database);appUrl.username='hub_app_server';appUrl.password='ephemeral-test-only';
const pool=new pg.Pool({connectionString:appUrl.href}),owner=randomUUID(),phone='+12025550841';
await admin.query("insert into auth.users(id,email,is_anonymous) values($1,'media-sms-owner@test.invalid',false)",[owner]);
await admin.query("insert into private.staff_permissions(user_id,permission) values($1,'platform.admin'),($1,'content.write')",[owner]);
await admin.query('insert into private.sms_identities(user_id,phone_e164) values($1,$2)',[owner,phone]);
const material=JSON.parse(await readFile(new URL('../src/imports/fixtures/governedCourse.json',import.meta.url),'utf8'));
material.sourceCourseId=randomUUID();material.sourceVersionId=randomUUID();material.sourceVersionState='draft';
const block=material.blocks.find(row=>row.type==='pdf');block.documentId=null;
const base={courseId:material.sourceCourseId,versionId:material.sourceVersionId,blockId:block.id};
const item=randomUUID();await admin.query("insert into hub.content_items(id,content_key,kind,status,access_level,source_system) values($1,$2,'course','draft','staff','penntrain')",[item,'media.fixture.'+item]);
await admin.query('insert into hub.course_links(content_item_id,penntrain_course_id,source_version,launch_path) values($1,$2,$3,$4)',[item,base.courseId,base.versionId,'/app/courses/'+base.courseId]);
const bytes=Buffer.from('%PDF-1.7\nSynthetic fixture only\n'),hash=digest(bytes);
const source=()=>JSON.stringify(material),revision=()=>digest(source());
const intents=new Map();let calls=0,uploads=0,writes=0,revokeAfterWrite=false,nativeRevoked=false,tamper=false,removedBlock=false;
const auth=smsAuth({pool,provider:{send:async()=>randomUUID(),verify:async(_id,_phone,code)=>code==='123456'}});
const caps=delegations({pool,storageUrl:'https://storage.test',fetchImpl:async(url,options)=>{
  calls++;assert.equal(url,'https://cmcarebase.com/api/learning-admin/media');assert.equal(options.redirect,'error');assert.equal(options.cache,'no-store');
  const raw=options.headers['x-caremetric-media-request'];const operation=parseMediaOperation(raw?JSON.parse(Buffer.from(raw,'base64url')):JSON.parse(options.body));
  const ticket=options.headers.Authorization.slice(7);
  await assert.rejects(caps.consume(ticket,'carebase.command'),/Invalid authorization/);
  const actor=await caps.consume(ticket,'carebase.learning');assert.equal(actor.user_id,owner);assert.equal(actor.method,'sms');assert.equal(actor.aal,undefined);
  assert.deepEqual(actor.operation,operation);await assert.rejects(caps.consume(ticket,'carebase.learning'),/Invalid authorization/);
  if(nativeRevoked)return Response.json({error:{code:'forbidden',privateDetail:'never forward'}},{status:403});
  const view=row=>({...row.intent,canFinishThisSession:row.intent.state==='staged'&&row.session===actor.session_id&&row.intent.sourceRevision===revision()});
  let data;
  if(operation.operation==='media.context'&&removedBlock)return new Response(null,{status:404});
  if(operation.operation==='media.context')data={courseId:base.courseId,versionId:base.versionId,sourceRevision:revision(),block:{id:base.blockId,type:'pdf',title:block.title,mediaAsset:block.mediaAsset??null,
    legacyDocumentId:null,legacyVideoSha256:null,generationState:'none'},intents:{items:[...intents.values()].map(view),hasMore:false}};
  if(operation.operation==='media.upload'){
    assert.equal(options.headers['Content-Type'],'application/pdf');assert.equal(options.duplex,'half');
    if(operation.sourceRevision!==revision())return Response.json({error:{code:'conflict'}},{status:409});
    const chunks=[];for await(const chunk of options.body)chunks.push(Buffer.from(chunk));const transferred=Buffer.concat(chunks);
    assert.deepEqual(transferred,bytes);assert.equal(digest(transferred),operation.sourceSha256);uploads++;
    let row=[...intents.values()].find(entry=>entry.session===actor.session_id&&entry.intent.requestId===operation.requestId);
    if(!row){const operationId=randomUUID(),assetId=randomUUID();row={session:actor.session_id,intent:{requestId:operation.requestId,operationId,assetId,versionId:base.versionId,blockId:base.blockId,
      sourceRevision:operation.sourceRevision,contentSha256:hash,mimeType:'application/pdf',byteSize:bytes.length,fileName:operation.fileName,reason:operation.reason,
      createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+600000).toISOString(),state:'staged',canFinishThisSession:true,result:null}};intents.set(operationId,row);}
    data={state:'staged',operationId:row.intent.operationId,assetId:row.intent.assetId,versionId:base.versionId,blockId:base.blockId,contentSha256:hash,mimeType:'application/pdf',byteSize:bytes.length,fileName:operation.fileName};
  }
  if(operation.operation==='media.status')data=intents.has(operation.operationId)?view(intents.get(operation.operationId)):null;
  if(operation.operation==='media.finish'){
    const row=intents.get(operation.operationId);if(!row||row.session!==actor.session_id)return new Response(null,{status:403});
    if(row.intent.result)data=row.intent.result;
    else{if(row.intent.sourceRevision!==revision())return new Response(null,{status:409});
      block.mediaAsset={id:row.intent.assetId,contentSha256:hash,mimeType:'application/pdf',byteSize:bytes.length,fileName:row.intent.fileName};
      data={operationId:row.intent.operationId,assetId:row.intent.assetId,versionId:base.versionId,blockId:base.blockId,sourceRevision:revision(),contentSha256:hash,mimeType:'application/pdf',byteSize:bytes.length,fileName:row.intent.fileName,attachedAt:new Date().toISOString()};
      row.intent.result=data;row.intent.state='committed';row.intent.canFinishThisSession=false;writes++;
      if(revokeAfterWrite)await admin.query('update private.staff_permissions set revoked_at=now() where user_id=$1',[owner]);}
  }
  if(operation.operation==='media.read'){
    assert.equal(operation.assetId,block.mediaAsset.id);const start=operation.range?.start??0,end=operation.range?.end??bytes.length-1;
    return new Response(bytes.subarray(start,end+1),{status:operation.range?206:200,headers:{'Content-Type':'application/pdf','Content-Length':String(end-start+1),
      'x-caremetric-media-asset':block.mediaAsset.id,'x-caremetric-media-sha256':tamper?'f'.repeat(64):hash,'x-caremetric-media-size':String(bytes.length),'Cache-Control':'private, no-store',
      ...(operation.range?{'Content-Range':`bytes ${start}-${end}/${bytes.length}`}:{})}});
  }
  return Response.json({contractVersion:1,product:'carebase',operation:operation.operation,generatedAt:new Date().toISOString(),data});
}});
const server=appServer({auth,gateway:gateway(pool),delegations:caps,origins:['https://hub.test']});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`,jar={};
const cookie=()=>Object.entries(jar).map(([k,v])=>`${k}=${v}`).join('; ');
async function call(path,body,headers={}){
  const response=await fetch(origin+'/api/'+path,{method:'POST',headers:{Origin:'https://hub.test','Content-Type':'application/json',Cookie:cookie(),...headers},body:JSON.stringify(body)});
  for(const value of response.headers.getSetCookie()){const [pair]=value.split(';'),index=pair.indexOf('=');jar[pair.slice(0,index)]=pair.slice(index+1);}
  return {status:response.status,body:await response.json()};
}
const run=body=>call('course-media',body);
async function login(){const challenge=await call('auth/sms/start',{phone});assert.equal(challenge.status,200);assert.equal((await call('auth/sms/verify',{challengeId:challenge.body.challengeId,code:'123456'})).status,200);}
const preserve=expected=>call('rpc/stage_learning_source',{p_payload:source(),p_source_revision:revision(),p_expected_revision:expected});
const uploadOp=()=>({...base,operation:'media.upload',requestId:randomUUID(),sourceRevision:revision(),reason:'Reviewed synthetic media',fileName:'lesson.pdf',mimeType:'application/pdf',sourceSha256:hash,sourceBytes:bytes.length});
async function upload(op){const response=await fetch(origin+'/api/course-media/upload',{method:'POST',headers:{Origin:'https://hub.test',Cookie:cookie(),'Content-Type':'application/pdf','x-caremetric-media-request':Buffer.from(JSON.stringify(op)).toString('base64url')},body:bytes});return {status:response.status,body:await response.json()};}
try{
  assert.equal((await run({...base,operation:'media.context'})).status,401);await login();
  assert.equal((await preserve(null)).status,200);
  const initial=await run({...base,operation:'media.context'});assert.equal(initial.status,200,JSON.stringify(initial));assert.equal(initial.body.sourcePreserved,true);
  const invalidCalls=calls;assert.equal((await run({...base,operation:'apply',commandId:randomUUID(),expectedDigest:hash})).status,400);
  assert.equal((await run({...base,operation:'media.read',assetId:randomUUID(),range:null})).status,400);
  assert.equal((await call('course-media',{...base,operation:'media.context'},{Origin:'https://evil.test'})).status,403);assert.equal(calls,invalidCalls);
  const op=uploadOp(),staged=await upload(op);assert.equal(staged.status,200,JSON.stringify(staged));assert.equal(writes,0);assert.equal(uploads,1);
  assert.equal((await call('admin/authoring',{operation:'media.finish',operationId:staged.body.operationId})).status,400);
  const finish={...base,operation:'media.finish',operationId:staged.body.operationId};revokeAfterWrite=true;
  const lost=await run(finish);assert.ok([401,403].includes(lost.status),JSON.stringify(lost));assert.equal(writes,1);
  revokeAfterWrite=false;await admin.query('update private.staff_permissions set revoked_at=null where user_id=$1',[owner]);
  const recovered=await run(finish);assert.equal(recovered.status,200,JSON.stringify(recovered));assert.equal(recovered.body.sourceRevision,revision());assert.equal(writes,1);
  assert.equal((await run({...base,operation:'media.context'})).body.sourcePreserved,false,'Native commit never silently advances preserved Hub source');
  const path=origin+`/api/course-media/${base.courseId}/${base.versionId}/${base.blockId}/${block.mediaAsset.id}`;
  const range=await fetch(path,{headers:{Cookie:cookie(),Range:'bytes=1-3'}});assert.equal(range.status,206);assert.equal(range.headers.get('content-range'),`bytes 1-3/${bytes.length}`);assert.equal(await range.text(),'PDF');
  tamper=true;assert.equal((await fetch(path,{headers:{Cookie:cookie()}})).status,503);tamper=false;
  const head=await fetch(path,{method:'HEAD',headers:{Cookie:cookie()}});assert.equal(head.status,200);assert.equal(head.headers.get('content-length'),String(bytes.length));
  assert.equal((await fetch(path,{headers:{Cookie:cookie(),Range:'bytes=0-1,3-4'}})).status,416);
  assert.equal((await preserve(op.sourceRevision)).status,200);const pending=await upload(uploadOp());assert.equal(pending.status,200);
  const old=jar[sessionCookie];await admin.query("update private.sms_challenges set created_at=now()-interval '61 seconds' where phone_hash=$1",[digest(phone)]);await login();assert.notEqual(jar[sessionCookie],old);
  const observed=await run({...base,operation:'media.status',operationId:pending.body.operationId});assert.equal(observed.status,200);assert.equal(observed.body.canFinishThisSession,false);
  assert.equal((await run({...base,operation:'media.finish',operationId:pending.body.operationId})).status,409);assert.equal(writes,1);
  assert.equal((await run(finish)).body.assetId,block.mediaAsset.id);assert.equal(writes,1);
  removedBlock=true;const afterRemoval=await run({...finish,operation:'media.status'});assert.equal(afterRemoval.status,200);assert.equal(afterRemoval.body.result.assetId,block.mediaAsset.id);
  assert.equal((await run(finish)).body.assetId,block.mediaAsset.id);assert.equal(writes,1);
  nativeRevoked=true;assert.equal((await run(finish)).status,403);nativeRevoked=false;
  await admin.query("update private.sms_sessions set created_at=now()-interval '9 hours' where token_hash=$1",[digest(jar[sessionCookie])]);
  const beforeExpired=calls;assert.equal((await run(finish)).status,401);assert.equal(calls,beforeExpired);
  console.log('Course media actual PostgreSQL/SMS/HTTP passed: source preservation, raw bytes/ranges, exact one-use audience, separate attach, revoked-write recovery, new-session observation and eight-hour authority.');
}finally{await new Promise(resolve=>server.close(resolve));await pool.end();await admin.end();}
