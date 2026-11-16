// Actual disposable Hub PostgreSQL, opaque SMS cookies and one-use capabilities.
// The fixture stands in for CareBase's generation route, which relays to its edge
// functions and re-verifies the administrator again when an AI result is saved.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {smsAuth} from './sms-auth.mjs';
import {gateway} from './gateway.mjs';
import {delegations} from './delegations.mjs';
import {appServer} from './http.mjs';
import { removeTestIdentities, testPhones } from './test-phones.mjs';
const phones = testPhones(import.meta.url);
const local=new URL(process.env.HUB_TEST_DATABASE_URL);assert.equal(local.hostname,'127.0.0.1');assert.equal(local.port,'54322');
const admin=new pg.Pool({connectionString:local.href});
await admin.query("alter role hub_app_server login password 'ephemeral-test-only'");
const appUrl=new URL(local);appUrl.username='hub_app_server';appUrl.password='ephemeral-test-only';
const pool=new pg.Pool({connectionString:appUrl.href}),owner=randomUUID(),phone=phones.owner;
await admin.query("insert into auth.users(id,email,is_anonymous) values($1,$2,false)",[owner,`generation-sms-owner-${owner}@test.invalid`]);
await admin.query("insert into private.staff_permissions(user_id,permission) values($1,'platform.admin')",[owner]);
await admin.query('insert into private.sms_identities(user_id,phone_e164) values($1,$2)',[owner,phone]);
const attempts=new Map();let calls=0,aiDisabled=false,revokeDuringRun=false;
const auth=smsAuth({pool,provider:{send:async()=>randomUUID(),verify:async(_id,_phone,code)=>code==='123456'}});
const caps=delegations({pool,storageUrl:'https://storage.test',fetchImpl:async(url,options)=>{
  calls++;assert.equal(url,'https://cmcarebase.com/api/learning-generation/run');assert.equal(options.redirect,'error');assert.equal(options.cache,'no-store');
  const operation=JSON.parse(options.body),ticket=options.headers.Authorization.slice(7);
  const actor=await caps.consume(ticket,'carebase.learning');assert.equal(actor.user_id,owner);assert.deepEqual(actor.operation,operation);
  await assert.rejects(caps.consume(ticket,'carebase.learning'),/Invalid authorization/);
  const reply=result=>Response.json({operation:operation.operation,result});
  if(operation.operation==='ai.generateCourse') {
    if(aiDisabled)return Response.json({error:{code:'forbidden',message:'AI course generation is currently disabled by the platform administrator.'}},{status:403});
    if(revokeDuringRun)await admin.query('update private.staff_permissions set revoked_at=now() where user_id=$1',[owner]);
    return reply({success:true,course_id:randomUUID(),course_version_id:randomUUID(),generation_id:randomUUID()});
  }
  if(operation.operation==='video.generate') {
    const prior=attempts.get(operation.request.request_id);
    if(prior)return reply({success:true,attempt_id:prior,video_id:'v1',status:'processing',reused:true});
    const attempt=randomUUID();attempts.set(operation.request.request_id,attempt);
    return reply({success:true,attempt_id:attempt,video_id:'v1',status:'processing'});
  }
  return Response.json({error:{code:'conflict',message:'Detach or replace the reviewed course media before regenerating this video script.',detail:'private-code'}},{status:409});
}});
const server=appServer({auth,gateway:gateway(pool),delegations:caps,origins:['https://hub.test']});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`,jar={};
async function call(path,body,headers={}){
  const response=await fetch(origin+'/api/'+path,{method:'POST',headers:{Origin:'https://hub.test','Content-Type':'application/json',Cookie:Object.entries(jar).map(([k,v])=>`${k}=${v}`).join('; '),...headers},body:JSON.stringify(body)});
  assert.equal(response.headers.get('cache-control'),'no-store');
  for(const value of response.headers.getSetCookie()){const [pair]=value.split(';'),i=pair.indexOf('=');jar[pair.slice(0,i)]=pair.slice(i+1);}
  return {status:response.status,body:await response.json()};
}
const run=body=>call('admin/learning-generation',body);
const draft={operation:'ai.generateCourse',request:{generation_mode:'course',title_hint:'Fire safety',source_material:'Source paragraph. '.repeat(5000)}};
try{
  assert.equal((await run(draft)).status,401);
  const challenge=await call('auth/sms/start',{phone});assert.equal(challenge.status,200);
  assert.equal((await call('auth/sms/verify',{challengeId:challenge.body.challengeId,code:'123456'})).status,200);
  assert.ok(Buffer.byteLength(JSON.stringify(draft))>32768); // larger than the other learning routes accept
  const created=await run(draft);assert.equal(created.status,200,JSON.stringify(created.body));assert.match(created.body.courseId,/^[0-9a-f-]{36}$/);
  const beforeInvalid=calls;
  for(const op of [{operation:'ai.generateCourse',request:{generation_mode:'training_plan',organization_id:randomUUID(),plan_name:'Onboarding'}},
    {...draft,actor:owner},{operation:'video.generate',request:{course_block_id:randomUUID(),request_id:randomUUID(),avatar_id:'a',voice_id:'v',script:'Hello',expected_video_url:'https://cdn.invalid/v.mp4'}}])
    assert.equal((await run(op)).status,400);
  assert.equal(calls,beforeInvalid);
  aiDisabled=true;const refused=await run(draft);aiDisabled=false;
  assert.deepEqual(refused,{status:403,body:{error:{code:'forbidden',message:'AI course generation is currently disabled by the platform administrator.'}}});
  const conflict=await run({operation:'ai.regenerateBlock',request:{course_block_id:randomUUID(),feedback:'Shorter.'}});
  assert.deepEqual(conflict,{status:409,body:{error:{code:'conflict',message:'Detach or replace the reviewed course media before regenerating this video script.'}}});
  const render={operation:'video.generate',request:{course_block_id:randomUUID(),request_id:randomUUID(),avatar_id:'twin',voice_id:'calm',script:'Welcome.',expected_video_url:null,expected_media_asset_id:null}};
  const first=await run(render),again=await run(render);assert.equal(first.status,200,JSON.stringify(first.body));
  assert.equal(again.body.attemptId,first.body.attemptId);assert.equal(again.body.reused,true);
  revokeDuringRun=true;const lost=await run(draft);revokeDuringRun=false;assert.ok([401,403].includes(lost.status),JSON.stringify(lost));
  console.log('Generation HTTP integration passed: exact tickets, large drafts, refused plans before CareBase, administrator messages, reused video attempts and revocation during a run.');
}finally{await new Promise(resolve=>server.close(resolve));await removeTestIdentities(admin,[owner]);await pool.end();await admin.end();}
