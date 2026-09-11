// Real disposable PostgreSQL, SMS cookies, fixed Hub delegation and HTTP routes.
// Native course writes use a deterministic contract fixture; CareBase's own CI
// separately exercises its clone/publish functions against native PostgreSQL.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { smsAuth,sessionCookie,digest,transaction,withSession } from './sms-auth.mjs';
import { gateway } from './gateway.mjs';
import { delegations } from './delegations.mjs';
import { appServer } from './http.mjs';
const databaseUrl=process.env.HUB_TEST_DATABASE_URL,local=new URL(databaseUrl);
assert.equal(local.hostname,'127.0.0.1');assert.equal(local.port,'54322');
const admin=new pg.Pool({connectionString:databaseUrl});
await admin.query("alter role hub_app_server login password 'ephemeral-test-only'");
const appUrl=new URL(databaseUrl);appUrl.username='hub_app_server';appUrl.password='ephemeral-test-only';
const pool=new pg.Pool({connectionString:appUrl.href});
const owner=randomUUID(),item=randomUUID(),phone='+12025550401';
const source=JSON.parse(readFileSync(new URL('../src/imports/fixtures/governedCourse.json',import.meta.url)));
source.sourceCourseId=randomUUID();source.sourceVersionId=randomUUID();
const course=source.sourceCourseId,version=source.sourceVersionId;
let payload=JSON.stringify(source),nativeRevoked=false,writes=0,calls=0,tamperOutcome=false;
const revision=()=>digest(payload),commands=new Map();
await admin.query("insert into auth.users(id,email,is_anonymous) values($1,'authoring-sms-owner@test.invalid',false)",[owner]);
await admin.query("insert into private.staff_permissions(user_id,permission) values($1,'platform.admin')",[owner]);
await admin.query('insert into private.sms_identities(user_id,phone_e164) values($1,$2)',[owner,phone]);
await admin.query("insert into hub.content_items(id,content_key,kind,status,access_level,source_system) values($1,$2,'course','published','public','penntrain')",[item,'authoring.integration.'+item]);
await admin.query('insert into hub.course_links(content_item_id,penntrain_course_id,source_version,launch_path) values($1,$2,$3,$4)',[item,course,version,'/app/courses/'+course]);
const provider={send:async()=>randomUUID(),verify:async(_id,_phone,code)=>code==='123456'};
const auth=smsAuth({pool,provider});
const caps=delegations({pool,storageUrl:'https://storage.test',fetchImpl:async(url,options)=>{
  calls++;assert.equal(url,'https://cmcarebase.com/api/learning-admin/authoring');assert.equal(options.redirect,'error');
  assert.deepEqual(Object.keys(options.headers).sort(),['Authorization','Content-Type']);
  const op=JSON.parse(options.body),ticket=options.headers.Authorization.slice(7);
  const authority=await caps.consume(ticket,'carebase.learning');
  assert.equal(authority.user_id,owner);assert.equal(authority.method,'sms');assert.equal(authority.aal,undefined);
  assert.deepEqual(authority.operation,op);assert.ok(Date.parse(authority.assurance_expires_at)>Date.now());
  await assert.rejects(caps.consume(ticket,'carebase.learning'),/Invalid authorization/);
  if(nativeRevoked)return Response.json({error:{code:'forbidden'}},{status:403});
  if(op.operation==='source')return Response.json({courseId:course,versionId:version,payload,sourceRevision:revision()});
  if(op.operation==='preview') {
    if(op.parameters.sourceRevision!==revision())return Response.json({error:{code:'conflict'}},{status:409});
    let row=commands.get(op.requestId);
    if(!row){row={commandId:randomUUID(),courseId:course,action:op.action,reason:op.reason,previewDigest:digest(JSON.stringify(op)),expiresAt:new Date(Date.now()+240000).toISOString(),
      before:{courseId:course,versionId:version,currentVersionId:version,sourceRevision:revision(),status:'published',versionNumber:2,title:source.version.title},
      after:{status:'draft',versionNumber:3,title:op.parameters.title,aiReviewRequired:false,sourceVersionId:version}};commands.set(op.requestId,row);}
    return Response.json(row);
  }
  assert.equal(op.operation,'apply');const preview=[...commands.values()].find(row=>row.commandId===op.commandId);
  if(!preview||preview.previewDigest!==op.expectedDigest)return Response.json({error:{code:'conflict'}},{status:409});
  if(preview.result)return Response.json({...preview.result,replayed:true});
  if(preview.before.sourceRevision!==revision())return Response.json({error:{code:'conflict'}},{status:409});
  const result={commandId:preview.commandId,courseId:course,action:preview.action,versionId:randomUUID(),versionNumber:3,status:'draft',appliedAt:new Date().toISOString(),replayed:false};
  if(tamperOutcome)return Response.json({...result,versionNumber:99});
  writes++;Object.defineProperty(preview,'result',{value:result,enumerable:false});return Response.json(result);
}});
const server=appServer({auth,gateway:gateway(pool),delegations:caps,origins:['https://hub.test']});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`,jar={};
async function call(path,body,headers={}) {
  const response=await fetch(origin+'/api/'+path,{method:'POST',headers:{Origin:'https://hub.test','Content-Type':'application/json',Cookie:Object.entries(jar).map(([k,v])=>`${k}=${v}`).join('; '),...headers},body:JSON.stringify(body)});
  assert.equal(response.headers.get('cache-control'),'no-store');
  for(const value of response.headers.getSetCookie()){const [pair]=value.split(';'),i=pair.indexOf('=');jar[pair.slice(0,i)]=pair.slice(i+1);}
  return {status:response.status,body:await response.json()};
}
const author=body=>call('admin/authoring',body);
const sourceOp={operation:'source',courseId:course,versionId:version};
const previewOp=()=>({operation:'preview',requestId:randomUUID(),action:'learning.cloneVersion',courseId:course,parameters:{versionId:version,sourceRevision:revision(),title:'Synthetic next draft'},reason:'Reviewed source for a controlled revision'});
try {
  assert.equal((await author(sourceOp)).status,401);
  const challenge=await call('auth/sms/start',{phone});assert.equal(challenge.status,200);
  assert.equal((await call('auth/sms/verify',{challengeId:challenge.body.challengeId,code:'123456'})).status,200);
  assert.equal((await call('admin/authoring',sourceOp,{Origin:'https://evil.test'})).status,403);
  const noSource=previewOp(),beforeCalls=calls;
  assert.equal((await author(noSource)).status,409);assert.equal(calls,beforeCalls);
  const loaded=await author(sourceOp);assert.equal(loaded.status,200,JSON.stringify(loaded.body));assert.equal(loaded.body.payload,payload);assert.equal(loaded.body.headRevision,null);
  const preserve={operation:'preserve_source',courseId:course,versionId:version,sourceRevision:revision(),expectedHeadRevision:null,reviewed:true};
  assert.equal((await author({...preserve,reviewed:false})).status,400);
  const originalPayload=payload;payload+=' ';assert.equal((await author(preserve)).status,409);payload=originalPayload;
  const staged=await author(preserve);assert.equal(staged.status,200,JSON.stringify(staged.body));
  for(const key of ['playbackToken','signedUrl','token','api_key','clientSecret','secretKey','signing_secret']) {
    const bad=structuredClone(source);bad.blocks[0].body={[key]:'synthetic-only'};const raw=JSON.stringify(bad);
    await assert.rejects(withSession(pool,jar[sessionCookie],db=>db.query('select hub.stage_learning_source($1,$2,$3)',[raw,digest(raw),preserve.sourceRevision])),/credentials/);
  }
  assert.equal((await author(preserve)).body.replayed,true);
  const command=previewOp(),preview=await author(command);assert.equal(preview.status,200,JSON.stringify(preview.body));
  assert.equal((await author(command)).body.commandId,preview.body.commandId);
  assert.equal(Number((await admin.query('select count(*) from private.learning_authoring_intents where actor_id=$1',[owner])).rows[0].count),1);
  const apply={operation:'apply',commandId:preview.body.commandId,expectedDigest:preview.body.previewDigest};
  assert.equal((await author({...apply,expectedDigest:'0'.repeat(64)})).status,409);assert.equal(writes,0);
  tamperOutcome=true;assert.equal((await author(apply)).status,503);tamperOutcome=false;assert.equal(writes,0);
  const result=await author(apply);assert.equal(result.status,200,JSON.stringify(result.body));assert.equal(writes,1);
  const replay=await author(apply);assert.equal(replay.status,200,JSON.stringify(replay.body));assert.equal(replay.body.replayed,true);assert.equal(writes,1);
  nativeRevoked=true;assert.equal((await author(apply)).status,403);nativeRevoked=false;
  const session=(await admin.query('select id from private.sms_sessions where token_hash=$1',[digest(jar[sessionCookie])])).rows[0].id;
  await assert.rejects(withSession(pool,jar[sessionCookie],db=>db.query('select * from private.learning_authoring_intents')),/permission denied/);
  await assert.rejects(transaction(admin,async db=>{await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:owner,sms_session_id:session})]);await db.query('select hub.get_learning_authoring_intent($1,$2)',[apply.commandId,apply.expectedDigest]);}),/administrator|Administrator|session|Session/);
  const driftPreview=await author(previewOp());assert.equal(driftPreview.status,200,JSON.stringify(driftPreview.body));
  payload+=' ';assert.equal((await author({operation:'apply',commandId:driftPreview.body.commandId,expectedDigest:driftPreview.body.previewDigest})).status,409);
  const next=await author({...preserve,sourceRevision:revision(),expectedHeadRevision:preserve.sourceRevision});assert.equal(next.status,200,JSON.stringify(next.body));
  assert.equal((await author(apply)).status,200);assert.equal(writes,1); // preserved head advances without invalidating a completed native receipt
  await admin.query('update private.staff_permissions set revoked_at=now() where user_id=$1',[owner]);assert.equal((await author(apply)).status,401);
  await admin.query('update private.staff_permissions set revoked_at=null where user_id=$1',[owner]);
  await admin.query('update private.sms_identities set revoked_at=now() where user_id=$1',[owner]);assert.equal((await author(apply)).status,401);
  assert.equal(Number((await admin.query("select count(*) from private.audit_events where actor_id=$1 and action='learning.authoring.applied'",[owner])).rows[0].count),1);
  console.log('Authoring PostgreSQL/HTTP integration passed: exact source review, private snapshot pin, preview recovery, native outcome validation, single write, current native/Hub revocation and replay after head advancement.');
} finally {await new Promise(resolve=>server.close(resolve));await pool.end();await admin.end();}
