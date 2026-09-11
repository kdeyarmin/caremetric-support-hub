// Real isolated Hub PostgreSQL and SMS/HTTP authority; native Storage/CAS is a
// deterministic fixture here and is independently exercised in CareBase CI.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { smsAuth,sessionCookie,digest,withSession } from './sms-auth.mjs';
import { gateway } from './gateway.mjs';
import { delegations } from './delegations.mjs';
import { appServer } from './http.mjs';
const databaseUrl=process.env.HUB_TEST_DATABASE_URL,local=new URL(databaseUrl);
assert.equal(local.hostname,'127.0.0.1');assert.equal(local.port,'54322');
const admin=new pg.Pool({connectionString:databaseUrl});
await admin.query("alter role hub_app_server login password 'ephemeral-test-only'");
const appUrl=new URL(databaseUrl);appUrl.username='hub_app_server';appUrl.password='ephemeral-test-only';
const pool=new pg.Pool({connectionString:appUrl.href}),owner=randomUUID(),item=randomUUID(),phone='+12025550921';
const source=JSON.parse(readFileSync(new URL('../src/imports/fixtures/governedCourse.json',import.meta.url)));
source.sourceCourseId=randomUUID();source.sourceVersionId=randomUUID();source.sourceVersionState='draft';
const course=source.sourceCourseId,version=source.sourceVersionId;
let payload=JSON.stringify(source),head=null,calls=0,stages=0,commits=0,lostStage=false,lostFinish=false,nativeRevoked=false,postAction=null,tamper=false;
const revision=()=>digest(payload),rows=[],packages=new Map(),archive=Buffer.from('Synthetic archive fixture; real ZIP validation lives in native CI.');
await admin.query("insert into auth.users(id,email,is_anonymous) values($1,'package-sms-owner@test.invalid',false)",[owner]);
await admin.query("insert into private.staff_permissions(user_id,permission) values($1,'platform.admin')",[owner]);
await admin.query('insert into private.sms_identities(user_id,phone_e164) values($1,$2)',[owner,phone]);
await admin.query("insert into hub.content_items(id,content_key,kind,status,access_level,source_system) values($1,$2,'course','published','public','penntrain')",[item,'package.integration.'+item]);
await admin.query('insert into hub.course_links(content_item_id,penntrain_course_id,source_version,launch_path) values($1,$2,$3,$4)',[item,course,version,'/app/courses/'+course]);
const auth=smsAuth({pool,provider:{send:async()=>randomUUID(),verify:async(_id,_phone,code)=>code==='123456'}});
const response=(op,data)=>Response.json({contractVersion:1,product:'carebase',operation:op.operation,generatedAt:new Date().toISOString(),data});
const denied=(status=409)=>Response.json({error:{code:status===403?'forbidden':'conflict'}},{status});
const publicIntent=(row,actor)=>({requestId:row.request.requestId,operationId:row.operationId,operation:row.request.operation,packageId:row.packageId,
  versionId:version,sourceRevision:row.request.sourceRevision,sourceSha256:row.sourceSha256,runtimeSha256:row.runtimeSha256,entryPoint:row.entryPoint,
  createdAt:row.createdAt,expiresAt:row.expiresAt,state:row.result?'committed':Date.parse(row.expiresAt)<=Date.now()?'expired':row.state,
  canFinishThisSession:!row.result&&row.state==='staged'&&row.session===actor.session_id&&Date.parse(row.expiresAt)>Date.now()&&row.request.sourceRevision===revision(),result:row.result});
const caps=delegations({pool,storageUrl:'https://storage.test',fetchImpl:async(url,options)=>{
  calls++;assert.equal(url,'https://cmcarebase.com/api/learning-admin/package');assert.equal(options.redirect,'error');assert.equal(options.headers.Origin,undefined);assert.equal(options.headers.Cookie,undefined);
  const upload=options.headers['Content-Type']==='application/zip';
  const op=upload?JSON.parse(Buffer.from(options.headers['x-caremetric-package-request'],'base64url').toString()):JSON.parse(options.body);
  const ticket=options.headers.Authorization.slice(7);
  await assert.rejects(caps.consume(ticket,'carebase'),/Invalid authorization/);
  const actor=await caps.consume(ticket,'carebase.learning');
  assert.equal(actor.user_id,owner);assert.equal(actor.method,'sms');assert.ok(actor.session_id);assert.ok(Date.parse(actor.assurance_expires_at)>Date.now());assert.deepEqual(actor.operation,op);
  await assert.rejects(caps.consume(ticket,'carebase.learning'),/Invalid authorization/);
  if(nativeRevoked)return denied(403);
  const done=async data=>{if(postAction?.operation===op.operation){const hook=postAction;postAction=null;await hook.run();}return response(op,data);};
  if(op.operation==='context'){
    if(op.versionId!==null&&op.versionId!==version)return denied();
    const selected=op.packageId===null?null:packages.get(op.packageId);if(op.packageId!==null&&!selected)return denied(404);
    const intents=rows.filter(row=>op.packageId===null||row.packageId===op.packageId).slice(-20).reverse().map(row=>publicIntent(row,actor));
    return done({courseId:course,versionId:version,sourceRevision:revision(),package:selected,intents:{items:intents,hasMore:rows.length>20}});
  }
  if(op.operation==='status'){
    const row=rows.findLast(value=>value.request.requestId===op.requestId);if(!row)return done(null);
    return done({requestId:op.requestId,operation:row.request.operation,packageId:row.packageId,versionId:version,sourceRevision:row.request.sourceRevision,expiresAt:row.expiresAt,
      status:row.result?'committed':Date.parse(row.expiresAt)<=Date.now()?'expired':'pending',result:row.result});
  }
  if(op.operation==='finish'){
    const row=rows.find(value=>value.operationId===op.operationId);if(!row||row.session!==actor.session_id)return denied();
    if(!row.result){
      if(!publicIntent(row,actor).canFinishThisSession)return denied();
      commits++;source.version.label='Synthetic package commit '+commits;payload=JSON.stringify(source);
      row.result={operationId:row.operationId,packageId:row.packageId,versionId:version,sourceRevision:revision(),status:row.request.operation==='upload'?'pending':'accepted',
        sourceSha256:row.sourceSha256,runtimeSha256:row.runtimeSha256,entryPoint:row.entryPoint};
      packages.set(row.packageId,{id:row.packageId,status:row.result.status,contentSha256:row.sourceSha256,entryPoint:row.entryPoint,standard:'scorm_1_2'});
    }
    if(lostFinish){lostFinish=false;throw new Error('Synthetic response lost after native commit');}
    return done(tamper?{...row.result,sourceSha256:'f'.repeat(64)}:row.result);
  }
  assert.ok(['upload','accept'].includes(op.operation));
  let row=rows.find(value=>value.session===actor.session_id&&value.request.requestId===op.requestId);
  if(row&&JSON.stringify(row.request)!==JSON.stringify(op))return denied();
  if(row?.result)return done({state:'committed',result:row.result});
  if(op.sourceRevision!==revision())return denied();
  if(op.operation==='upload'){
    assert.equal(options.duplex,'half');let bytes=0;const chunks=[];
    for await(const chunk of options.body){bytes+=chunk.length;chunks.push(chunk);}
    assert.equal(bytes,op.sourceBytes);assert.equal(digest(Buffer.concat(chunks)),op.sourceSha256);
  } else if(!packages.has(op.packageId))return denied(404);
  if(!row){row={request:op,operationId:randomUUID(),packageId:op.operation==='upload'?randomUUID():op.packageId,session:actor.session_id,
    sourceSha256:op.operation==='upload'?op.sourceSha256:packages.get(op.packageId).contentSha256,runtimeSha256:op.operation==='upload'?null:digest('Reviewed derived runtime'),
    entryPoint:op.operation==='upload'?null:op.entryPoint??'index.html',state:'staged',createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+900000).toISOString(),result:null};rows.push(row);stages++;}
  if(lostStage){lostStage=false;throw new Error('Synthetic response lost after native staging');}
  return done({state:'staged',operationId:row.operationId,packageId:row.packageId,versionId:version,sourceSha256:row.sourceSha256,runtimeSha256:row.runtimeSha256,entryPoint:row.entryPoint});
}});
const server=appServer({auth,gateway:gateway(pool),delegations:caps,origins:['https://hub.test']});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`,jar={};
async function call(path,body,headers={},raw=false){
  const result=await fetch(origin+'/api/'+path,{method:'POST',headers:{Origin:'https://hub.test','Content-Type':raw?'application/zip':'application/json',Cookie:Object.entries(jar).map(([k,v])=>`${k}=${v}`).join('; '),...headers},body:raw?body:JSON.stringify(body)});
  assert.equal(result.headers.get('cache-control'),'no-store');for(const value of result.headers.getSetCookie()){const [pair]=value.split(';'),index=pair.indexOf('=');jar[pair.slice(0,index)]=pair.slice(index+1);}
  return {status:result.status,body:await result.json()};
}
const command=op=>call('admin/packages',op),ctx={operation:'context',courseId:course,versionId:version,packageId:null};
const upload=()=>({operation:'upload',courseId:course,versionId:version,requestId:randomUUID(),sourceRevision:revision(),reason:'Review exact original authored archive',standard:'scorm_1_2',sourceSha256:digest(archive),sourceBytes:archive.length});
const stage=(op,bytes=archive)=>call('admin/packages',bytes,{'x-caremetric-package-request':Buffer.from(JSON.stringify(op)).toString('base64url')},true);
const finish=row=>command({operation:'finish',courseId:course,versionId:version,requestId:row.request.requestId,operationId:row.operationId});
async function preserve(){await withSession(pool,jar[sessionCookie],db=>db.query('select hub.stage_learning_source($1,$2,$3)',[payload,revision(),head]));head=revision();}
async function login(){const started=await call('auth/sms/start',{phone});assert.equal(started.status,200,JSON.stringify(started.body));assert.equal((await call('auth/sms/verify',{challengeId:started.body.challengeId,code:'123456'})).status,200);}
const expectStatus=(result,status)=>assert.equal(result.status,status,JSON.stringify(result.body));
try{
  expectStatus(await command(ctx),401);assert.equal(calls,0);await login();
  expectStatus(await call('admin/packages',ctx,{Origin:'https://evil.test'}),403);
  expectStatus(await call('admin/packages?target=https://evil.test',ctx),400);
  expectStatus(await call('admin/packages',ctx,{'x-caremetric-package-request':'e30'}),400);
  expectStatus(await call('admin/packages',ctx,{'Content-Encoding':'gzip'}),415);
  expectStatus(await command({...ctx,targetUrl:'https://evil.test'}),400);
  expectStatus(await call('admin/packages',archive,{'x-caremetric-package-request':'not+canonical'},true),400);
  const before=calls;expectStatus(await stage(upload()),409);assert.equal(calls,before);
  const unloaded=await command(ctx);expectStatus(unloaded,200);assert.equal(unloaded.body.headRevision,null);assert.equal(unloaded.body.sourcePreserved,false);
  await preserve();expectStatus(await command({...ctx,courseId:randomUUID()}),409);
  const first=upload();lostStage=true;expectStatus(await stage(first),503);assert.equal(stages,1);assert.equal(commits,0);
  const recovered=await command(ctx);expectStatus(recovered,200);assert.equal(recovered.body.intents.items[0].canFinishThisSession,true);
  expectStatus(await stage(first),200);assert.equal(stages,1);assert.equal(commits,0);
  expectStatus(await stage({...first,reason:'A changed reason with the same request'}),409);
  const row=rows[0];
  expectStatus(await command({operation:'finish',courseId:course,versionId:version,requestId:first.requestId,operationId:randomUUID()}),409);assert.equal(commits,0);
  lostFinish=true;expectStatus(await finish(row),503);assert.equal(commits,1);
  const committed=await command(ctx);expectStatus(committed,200);assert.equal(committed.body.sourcePreserved,false);assert.equal(committed.body.intents.items[0].sourceRevision,first.sourceRevision);
  assert.equal(committed.body.intents.items[0].result.sourceRevision,revision());
  expectStatus(await finish(row),200);assert.equal(commits,1);
  const receipt=structuredClone(row.result);source.version.title='A later unrelated native edit';payload=JSON.stringify(source);
  const old=await finish(row);expectStatus(old,200);assert.deepEqual(old.body,receipt);assert.notEqual(old.body.sourceRevision,revision());
  const staleCalls=stages;expectStatus(await stage(first),409);assert.equal(stages,staleCalls);
  const status=await command({operation:'status',courseId:course,versionId:version,requestId:first.requestId});expectStatus(status,200);assert.deepEqual(status.body.result,receipt);
  expectStatus(await command({operation:'status',courseId:course,versionId:version,requestId:randomUUID()}),200);
  await preserve();expectStatus(await finish(row),409); // an immutable receipt never rewrites a later preserved head
  const accept={operation:'accept',courseId:course,versionId:version,requestId:randomUUID(),packageId:row.packageId,sourceRevision:revision(),reason:'Accept reviewed separate runtime artifact',entryPoint:'content/index.html'};
  expectStatus(await command({...accept,entryPoint:'../unsafe.html'}),400);
  expectStatus(await command({...accept,packageId:randomUUID()}),404);
  const acceptedStage=await command(accept);expectStatus(acceptedStage,200);assert.equal(commits,1);
  const acceptRow=rows[1];tamper=true;expectStatus(await finish(acceptRow),503);tamper=false;assert.equal(commits,2);
  expectStatus(await finish(acceptRow),200);assert.equal(commits,2);await preserve();
  // Current authority is re-entered after a successful remote response.
  postAction={operation:'context',run:()=>admin.query('update private.staff_permissions set revoked_at=now() where user_id=$1',[owner])};
  expectStatus(await command(ctx),401);await admin.query('update private.staff_permissions set revoked_at=null where user_id=$1',[owner]);
  const next=upload();postAction={operation:'upload',run:()=>admin.query('update private.sms_identities set revoked_at=now() where user_id=$1',[owner])};
  expectStatus(await stage(next),401);assert.equal(commits,2);await admin.query('update private.sms_identities set revoked_at=null where user_id=$1',[owner]);
  expectStatus(await command(ctx),200);const nextRow=rows[2];
  postAction={operation:'finish',run:()=>admin.query('update private.staff_permissions set revoked_at=now() where user_id=$1',[owner])};
  expectStatus(await finish(nextRow),401);assert.equal(commits,3);await admin.query('update private.staff_permissions set revoked_at=null where user_id=$1',[owner]);
  expectStatus(await finish(nextRow),200);assert.equal(commits,3);await preserve();
  nativeRevoked=true;expectStatus(await command(ctx),403);nativeRevoked=false;
  const abandoned=upload();expectStatus(await stage(abandoned),200);const abandonedRow=rows[3];
  abandonedRow.expiresAt=new Date(Date.now()-1).toISOString();expectStatus(await finish(abandonedRow),409);abandonedRow.expiresAt=new Date(Date.now()+900000).toISOString();
  // A second real SMS login does not acquire the previous session's finish grant.
  await admin.query("update private.sms_challenges set created_at=now()-interval '2 minutes' where user_id=$1",[owner]);
  await login();const otherSession=await command(ctx);expectStatus(otherSession,200);assert.equal(otherSession.body.intents.items[0].canFinishThisSession,false);expectStatus(await finish(abandonedRow),409);
  const repeated={...abandoned,sourceRevision:revision()};expectStatus(await stage(repeated),200);assert.equal(rows[4].request.requestId,abandonedRow.request.requestId);assert.notEqual(rows[4].operationId,abandonedRow.operationId);
  expectStatus(await command(ctx),200);expectStatus(await finish(rows[4]),200);assert.equal(commits,4);
  await preserve();
  const racing=upload();postAction={operation:'upload',run:async()=>{source.version.label='Concurrently preserved source';payload=JSON.stringify(source);await preserve();}};
  expectStatus(await stage(racing),409);assert.equal(commits,4);expectStatus(await finish(rows.at(-1)),409);
  const session=(await admin.query('select id from private.sms_sessions where token_hash=$1',[digest(jar[sessionCookie])])).rows[0].id;
  await admin.query("update private.sms_sessions set created_at=now()-interval '9 hours',expires_at=now()+interval '1 hour' where id=$1",[session]);
  const agedCalls=calls;expectStatus(await command(ctx),401);assert.equal(calls,agedCalls);
  console.log('Package PostgreSQL/HTTP integration passed: closed streaming route, original SMS tickets, one-use/audience binding, explicit stage/finish, lost replies, immutable pre/post receipts, preserved-head CAS, tampered result denial, native/current Hub revocation, expiry and distinct same-request operations across real sessions.');
}finally{await new Promise(resolve=>server.close(resolve));await pool.end();await admin.end();}
