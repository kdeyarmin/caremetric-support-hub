// Disposable PostgreSQL, actual SMS cookies/HTTP/capabilities and deterministic
// native receipts. Native CI separately executes the common course writer.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { smsAuth,sessionCookie,digest,token,withSession } from './sms-auth.mjs';
import { gateway } from './gateway.mjs';
import { delegations } from './delegations.mjs';
import { appServer } from './http.mjs';
const local=new URL(process.env.HUB_TEST_DATABASE_URL);assert.equal(local.hostname,'127.0.0.1');assert.equal(local.port,'54322');
const admin=new pg.Pool({connectionString:local.href});
await admin.query("alter role hub_app_server login password 'ephemeral-test-only'");
local.username='hub_app_server';local.password='ephemeral-test-only';const pool=new pg.Pool({connectionString:local.href});
const owner=randomUUID(),phone='+12025550701',commands=new Map(),sources=new Map();
let bridge,nativeAllowed=true,loseApply=false,sourceUnavailable=false,revokeAtSource=false,writes=0;
const auth=smsAuth({pool,provider:{send:async()=>randomUUID(),verify:async(_id,_phone,code)=>code==='123456'}});
const fetchImpl=async(url,options)=>{
  assert.equal(url,'https://cmcarebase.com/api/learning-admin/authoring');assert.equal(options.redirect,'error');
  const op=JSON.parse(options.body),cap=new Headers(options.headers).get('Authorization').slice(7);
  const actor=await bridge.consume(cap,'carebase.learning');assert.equal(actor.user_id,owner);assert.equal(actor.method,'sms');assert.equal(actor.aal,undefined);assert.deepEqual(actor.operation,op);
  await assert.rejects(bridge.consume(cap,'carebase.learning'));if(!nativeAllowed)return Response.json({private:'withheld'},{status:403});
  if(op.operation==='creationOptions')return Response.json({trainingTypes:[],nextOffset:null});
  if(op.operation==='source'){
    if(sourceUnavailable)return Response.json({},{status:503});
    if(revokeAtSource)await admin.query('update private.staff_permissions set revoked_at=now() where user_id=$1',[owner]);
    const source=sources.get(op.courseId);return Response.json({courseId:op.courseId,versionId:op.versionId,payload:source,sourceRevision:digest(source)});
  }
  if(op.operation==='creationStatus'){
    const row=commands.get(op.requestId);if(!row?.result&&sources.has(op.courseId))return Response.json({},{status:409});
    return Response.json(row?.result?{status:'applied',result:row.result}:{status:'absent',result:null});
  }
  if(op.operation==='preview'){
    let row=commands.get(op.requestId);
    if(!row){
      const preview={commandId:randomUUID(),courseId:op.courseId,action:op.action,reason:op.reason,previewDigest:digest(JSON.stringify(op)),expiresAt:new Date(Date.now()+240000).toISOString(),
        before:{courseId:op.courseId,versionId:op.parameters.versionId,exists:false},after:{courseId:op.courseId,versionId:op.parameters.versionId,courseStatus:'draft',status:'draft',versionNumber:1,title:op.parameters.version.title,currentVersionId:null,aiReviewRequired:false,contentStandard:'comprehensive'}};
      row={op,preview,session:actor.session_id};commands.set(op.requestId,row);
    } else assert.deepEqual(row.op,op);
    return Response.json(row.preview);
  }
  assert.equal(op.operation,'apply');const row=[...commands.values()].find(r=>r.preview.commandId===op.commandId);
  assert.ok(row);assert.equal(row.session,actor.session_id);assert.equal(row.preview.previewDigest,op.expectedDigest);
  if(row.result)return Response.json({...row.result,replayed:true});
  if(sources.has(row.op.courseId))return Response.json({},{status:409});
  const source=JSON.parse(readFileSync(new URL('../src/imports/fixtures/governedCourse.json',import.meta.url)));
  source.sourceCourseId=row.op.courseId;source.sourceVersionId=row.op.parameters.versionId;source.sourceVersionNumber=1;source.publicationState='draft';source.sourceVersionState='draft';
  const c=row.op.parameters.course,v=row.op.parameters.version;
  Object.assign(source.course,{title:c.title,description:c.description,category:c.category,estimatedDurationMinutes:c.estimatedDurationMinutes,legacyTrainingTypeId:c.trainingTypeId});
  Object.assign(source.version,{title:v.title,description:v.description,label:null,contentStandard:'comprehensive',creditedDurationRationale:null,aiGenerated:false,aiReviewedAt:null});
  source.blocks=[];source.credits=[];source.packages=[];source.provider=null;
  const payload=JSON.stringify(source);sources.set(row.op.courseId,payload);writes++;
  row.result={commandId:row.preview.commandId,action:'learning.createCourse',courseId:row.op.courseId,versionId:row.op.parameters.versionId,versionNumber:1,status:'draft',courseStatus:'draft',currentVersionId:null,contentStandard:'comprehensive',sourceRevision:digest(payload),appliedAt:new Date().toISOString(),replayed:false};
  if(loseApply){loseApply=false;throw new Error('Synthetic lost native response');}return Response.json(row.result);
};
bridge=delegations({pool,storageUrl:'https://storage.invalid',fetchImpl});
const server=appServer({auth,gateway:gateway(pool),delegations:bridge,origins:['https://hub.test']});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`,jar={};
async function call(path,body,headers={}){
  const response=await fetch(origin+'/api/'+path,{method:'POST',headers:{Origin:'https://hub.test','Content-Type':'application/json',Cookie:Object.entries(jar).map(([k,v])=>`${k}=${v}`).join('; '),...headers},body:JSON.stringify(body)});
  assert.equal(response.headers.get('cache-control'),'no-store');
  for(const value of response.headers.getSetCookie()){const [pair]=value.split(';'),i=pair.indexOf('=');jar[pair.slice(0,i)]=pair.slice(i+1);}
  return {status:response.status,body:await response.json()};
}
const create=(op,headers)=>call('admin/course-creation',op,headers);
const request=()=>({operation:'preview',requestId:randomUUID(),action:'learning.createCourse',courseId:randomUUID(),reason:'Create a reviewed synthetic test draft',parameters:{versionId:randomUUID(),course:{title:'Synthetic governed course',description:'No customer data',category:null,estimatedDurationMinutes:30,trainingTypeId:null},version:{title:'Synthetic first version',description:'Draft description'}}});
const apply=intent=>({operation:'apply',commandId:intent.preview.commandId,expectedDigest:intent.preview.previewDigest});
const ok=response=>{assert.equal(response.status,200,JSON.stringify(response.body));return response.body;};
try {
  await admin.query("insert into auth.users(id,email,is_anonymous) values($1,'creation-sms-owner@test.invalid',false)",[owner]);
  await admin.query("insert into private.staff_permissions(user_id,permission) values($1,'platform.admin')",[owner]);
  await admin.query('insert into private.sms_identities(user_id,phone_e164) values($1,$2)',[owner,phone]);
  assert.equal((await create({operation:'resume'})).status,401);
  const started=ok(await call('auth/sms/start',{phone}));ok(await call('auth/sms/verify',{challengeId:started.challengeId,code:'123456'}));
  assert.equal((await create(request(),{Origin:'https://evil.test'})).status,403);
  assert.equal((await create({...request(),organizationId:randomUUID()})).status,400);
  assert.deepEqual(ok(await create({operation:'creationOptions',offset:0})),{trainingTypes:[],nextOffset:null});
  const original=request(),intent=ok(await create(original));
  assert.deepEqual(ok(await create(original)).preview,intent.preview);assert.equal(writes,0);
  assert.equal((await admin.query('select count(*) from hub.course_links where penntrain_course_id=$1',[original.courseId])).rows[0].count,'0');
  await assert.rejects(withSession(pool,jar[sessionCookie],db=>db.query('select * from private.course_creation_intents')),/permission denied/);
  await assert.rejects(withSession(pool,jar[sessionCookie],db=>db.query('select private.register_course_creation($1,$2,$3,$4)',[original.requestId,'{}',null,null])),/permission denied/);
  assert.equal((await create({...original,reason:'Changed original request reason'})).status,409);
  loseApply=true;assert.equal((await create(apply(intent))).status,503);assert.equal(writes,1);
  assert.equal((await create({operation:'discard',requestId:original.requestId})).status,409);
  const originalToken=jar[sessionCookie],nextSession=randomUUID(),nextToken=token();
  // A newly verified fixture session has a different identity, but the same owner.
  await admin.query("insert into private.sms_sessions(id,token_hash,user_id,identity_version,expires_at) select $1,$2,user_id,identity_version,now()+interval '1 hour' from private.sms_identities where user_id=$3",[nextSession,digest(nextToken),owner]);
  jar[sessionCookie]=nextToken;
  assert.equal((await create(apply(intent))).status,403,'new sessions cannot borrow original apply authority');
  const recovered=ok(await create({operation:'recover',requestId:original.requestId}));assert.equal(recovered.status,'applied');assert.equal(writes,1);
  assert.equal(recovered.intent.registration.sourceRevision,recovered.intent.result.sourceRevision);assert.ok(recovered.intent.registration.snapshotId);
  const item=recovered.intent.registration.itemId;
  assert.deepEqual((await admin.query('select status,access_level,source_system from hub.content_items where id=$1',[item])).rows,[{status:'draft',access_level:'staff',source_system:'penntrain'}]);
  assert.equal((await admin.query('select count(*) from hub.content_publications where item_id=$1',[item])).rows[0].count,'0');
  ok(await create({operation:'recover',requestId:original.requestId}));assert.equal(writes,1);
  nativeAllowed=false;assert.equal((await create({operation:'recover',requestId:original.requestId})).status,403);nativeAllowed=true;
  const second=request(),secondIntent=ok(await create(second));sourceUnavailable=true;
  assert.equal((await create(apply(secondIntent))).status,503);sourceUnavailable=false;assert.equal(writes,2);
  const edited=JSON.parse(sources.get(second.courseId));edited.version.description='A later native edit';sources.set(second.courseId,JSON.stringify(edited));
  const later=ok(await create({operation:'recover',requestId:second.requestId}));assert.equal(later.intent.registration.snapshotId,null);
  assert.equal((await admin.query('select count(*) from private.learning_source_snapshots where source_course_id=$1',[second.courseId])).rows[0].count,'0','never fabricate original snapshot from later edits');
  const staged=ok(await call('admin/authoring',{operation:'preserve_source',courseId:second.courseId,versionId:second.parameters.versionId,sourceRevision:digest(sources.get(second.courseId)),expectedHeadRevision:null,reviewed:true}));assert.ok(staged.snapshotId);
  const conflict=request(),conflictIntent=ok(await create(conflict));sourceUnavailable=true;assert.equal((await create(apply(conflictIntent))).status,503);sourceUnavailable=false;
  const occupied=randomUUID();await admin.query("insert into hub.content_items(id,content_key,kind,status,access_level,source_system) values($1,$2,'course','draft','staff','penntrain')",[occupied,'synthetic.conflict.'+occupied]);
  await admin.query('insert into hub.course_links(content_item_id,penntrain_course_id,launch_path) values($1,$2,$3)',[occupied,conflict.courseId,'/app/courses/'+conflict.courseId]);
  assert.equal((await create({operation:'recover',requestId:conflict.requestId})).status,409);
  assert.equal((await admin.query('select content_item_id from hub.course_links where penntrain_course_id=$1',[conflict.courseId])).rows[0].content_item_id,occupied);
  const revocation=request(),revocationIntent=ok(await create(revocation));revokeAtSource=true;
  assert.equal((await create(apply(revocationIntent))).status,401);revokeAtSource=false;
  assert.equal((await admin.query('select count(*) from hub.course_links where penntrain_course_id=$1',[revocation.courseId])).rows[0].count,'0','revocation after native response denies Hub registration');
  await admin.query('update private.staff_permissions set revoked_at=null where user_id=$1',[owner]);
  // Fresh fixture authorization is still current; recovery does not write a second native course.
  ok(await create({operation:'recover',requestId:revocation.requestId}));assert.equal(writes,4);
  const absent=request(),unused=ok(await create(absent));assert.equal(ok(await create({operation:'recover',requestId:absent.requestId})).status,'absent');
  ok(await create({operation:'discard',requestId:absent.requestId}));assert.equal((await create(apply(unused))).status,403);
  assert.ok(ok(await create({operation:'resume'})).rows.length>=4);
  const other=randomUUID(),otherToken=token();
  await admin.query("insert into auth.users(id,email,is_anonymous) values($1,'creation-other-admin@test.invalid',false)",[other]);
  await admin.query("insert into private.staff_permissions(user_id,permission) values($1,'platform.admin')",[other]);
  await admin.query("insert into private.sms_identities(user_id,phone_e164,verified_at) values($1,'+12025550702',now())",[other]);
  await admin.query("insert into private.sms_sessions(id,token_hash,user_id,identity_version,expires_at) select $1,$2,user_id,identity_version,now()+interval '1 hour' from private.sms_identities where user_id=$3",[randomUUID(),digest(otherToken),other]);
  const otherHeaders={Cookie:`${sessionCookie}=${otherToken}`};
  assert.deepEqual(ok(await create({operation:'resume'},otherHeaders)),{rows:[],nextOffset:null});
  assert.equal((await create({operation:'recover',requestId:original.requestId},otherHeaders)).status,403);
  assert.equal((await create({operation:'discard',requestId:original.requestId},otherHeaders)).status,403);
  const atomic=request(),atomicIntent=ok(await create(atomic));
  await admin.query(`create function private.fixture_fail_creation_audit() returns trigger language plpgsql set search_path='' as $$ begin
    if new.actor_id='${owner}'::uuid and new.action='learning.creation.registered' then raise exception 'Synthetic audit failure'; end if;return new;end;$$`);
  await admin.query('create trigger fixture_fail_creation_audit before insert on private.audit_events for each row execute function private.fixture_fail_creation_audit()');
  try {
    assert.equal((await create(apply(atomicIntent))).status,503);
    assert.equal((await admin.query('select count(*) from hub.course_links where penntrain_course_id=$1',[atomic.courseId])).rows[0].count,'0');
    assert.equal((await admin.query('select count(*) from private.learning_source_snapshots where source_course_id=$1',[atomic.courseId])).rows[0].count,'0');
    assert.equal((await admin.query('select result from private.course_creation_intents where request_id=$1',[atomic.requestId])).rows[0].result,null);
  }finally {await admin.query('drop trigger fixture_fail_creation_audit on private.audit_events');await admin.query('drop function private.fixture_fail_creation_audit()');}
  ok(await create({operation:'recover',requestId:atomic.requestId}));assert.equal(writes,5,'Hub rollback recovery never creates twice');
  const expired=request(),expiredIntent=ok(await create(expired));const expiry=new Date(Date.now()-10000).toISOString();
  commands.get(expired.requestId).preview.expiresAt=expiry;
  await admin.query("update private.course_creation_intents set preview=jsonb_set(preview,'{expiresAt}',to_jsonb($2::text)) where request_id=$1",[expired.requestId,expiry]);
  const thirdSession=randomUUID(),thirdToken=token();
  await admin.query("insert into private.sms_sessions(id,token_hash,user_id,identity_version,expires_at) select $1,$2,user_id,identity_version,now()+interval '1 hour' from private.sms_identities where user_id=$3",[thirdSession,digest(thirdToken),owner]);
  jar[sessionCookie]=thirdToken;assert.equal((await create(apply(expiredIntent))).status,403);
  assert.equal(ok(await create({operation:'recover',requestId:expired.requestId})).status,'absent');
  const replacement={...expired,requestId:randomUUID()},replacementIntent=ok(await create(replacement));
  const replaced=ok(await create(apply(replacementIntent)));assert.equal(replaced.result.courseId,expired.courseId);assert.equal(replaced.result.versionId,expired.parameters.versionId);assert.equal(writes,6);
  assert.equal((await create(apply(expiredIntent))).status,403);
  // Seed additional unresolved requests to prove completed work cannot hide a
  // pending request past the first page. These rows assert read pagination only.
  for(let index=0;index<21;index++){
    const pending=request();await admin.query('insert into private.course_creation_intents(request_id,actor_id,session_id,course_id,version_id,request) values($1,$2,$3,$4,$5,$6)',
      [pending.requestId,owner,thirdSession,pending.courseId,pending.parameters.versionId,pending]);
  }
  const firstPage=ok(await create({operation:'resume',offset:0}));assert.equal(firstPage.rows.length,20);assert.equal(firstPage.nextOffset,20);assert.ok(firstPage.rows.every(row=>row.result===null));
  const nextPage=ok(await create({operation:'resume',offset:20}));assert.ok(nextPage.rows.some(row=>row.request.requestId===conflict.requestId));
  await admin.query('update private.sms_sessions set revoked_at=now() where token_hash=$1',[digest(originalToken)]);
  assert.equal((await create({operation:'resume'},{Cookie:`${sessionCookie}=${originalToken}`})).status,401);
  console.log('Course creation PostgreSQL/SMS/HTTP passed: immutable identity, lost response, new-session recovery, exact empty snapshot, changed-source manual review, mapping conflict, private grants, Origin and current authority.');
} finally {await new Promise(resolve=>server.close(resolve));await pool.end();await admin.end();}
