// Run only against the disposable local Supabase stack, never a live project.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { smsAuth,sessionCookie,digest,transaction } from './sms-auth.mjs';
import { gateway } from './gateway.mjs';
import { delegations } from './delegations.mjs';
import { appServer } from './http.mjs';
const databaseUrl=process.env.HUB_TEST_DATABASE_URL;
const local=new URL(databaseUrl);
assert.equal(local.hostname,'127.0.0.1'); assert.equal(local.port,'54322');
const admin=new pg.Pool({connectionString:databaseUrl});
await admin.query("alter role hub_app_server login password 'ephemeral-test-only'");
const appUrl=new URL(databaseUrl); appUrl.username='hub_app_server'; appUrl.password='ephemeral-test-only';
const pool=new pg.Pool({connectionString:appUrl.href});
const editor=randomUUID(), learner=randomUUID(), ownerPhone='+12025550101', learnerPhone='+12025550102';
await admin.query(`insert into auth.users(id,email,raw_user_meta_data,is_anonymous) values($1,'sms-editor@test.invalid','{"display_name":"SMS editor"}',false),($2,'sms-learner@test.invalid','{"display_name":"SMS learner"}',false)`,[editor,learner]);
await admin.query("insert into private.staff_permissions(user_id,permission,granted_by) values($1,'platform.admin',$1)",[editor]);
await admin.query('insert into private.sms_identities(user_id,phone_e164) values($1,$2),($3,$4)',[editor,ownerPhone,learner,learnerPhone]);
const sent=[];
const provider={send:async phone=>{sent.push(phone);return randomUUID();},verify:async(_id,_phone,code)=>code==='123456'};
const auth=smsAuth({pool,provider}), api=gateway(pool);
const caps=delegations({pool,storageUrl:'https://storage.test',fetchImpl:async()=>{throw new Error('No external traffic in this test');}});
const server=appServer({auth,gateway:api,delegations:caps,origins:['https://hub.test']});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
const jar={};
async function call(path,body,headers={}) {
  const response=await fetch(origin+'/api/'+path,{method:body===undefined?'GET':'POST',headers:{Origin:'https://hub.test','Content-Type':'application/json',Cookie:Object.entries(jar).map(([k,v])=>`${k}=${v}`).join('; '),...headers},body:body===undefined?undefined:JSON.stringify(body)});
  for(const value of response.headers.getSetCookie()) {const [pair]=value.split(';');const index=pair.indexOf('=');jar[pair.slice(0,index)]=pair.slice(index+1);}
  return {status:response.status,body:await response.json()};
}
try {
  assert.equal((await call('auth/sms/start',{phone:ownerPhone},{Origin:'https://evil.test'})).status,403);
  assert.equal((await call('rpc/list_learning_drafts',{})).status,401);
  const started=await call('auth/sms/start',{phone:ownerPhone}); assert.equal(started.status,200); assert.equal(sent.length,1);
  assert.equal((await call('auth/sms/start',{phone:ownerPhone})).status,429);
  const challenge=started.body.challengeId;
  assert.equal((await call('auth/sms/verify',{challengeId:challenge,code:'123456'},{Cookie:''})).status,400);
  assert.equal((await call('auth/sms/verify',{challengeId:challenge,code:'000000'})).status,401);
  assert.equal((await call('auth/sms/verify',{challengeId:challenge,code:'123456'})).status,200);
  const editorToken=jar[sessionCookie];
  assert.equal((await call('auth/sms/verify',{challengeId:challenge,code:'123456'})).status,400);
  assert.equal((await call('auth/session')).body.authenticated,true);
  assert.equal((await call('rpc/get_learning_editor_access',{})).body,true);
  assert.deepEqual((await call('rpc/list_learning_drafts',{})).body,[]);
  assert.ok(Array.isArray((await call('rpc/list_published_content',{})).body));
  assert.equal((await call('rpc/execute_sql',{sql:'select 1'})).status,400);
  const product=(await call('rows/products')).body[0].id;
  const document={title:'Disposable SMS test',summary:'Test fixture only',category:'Test',accessLevel:'public',durationMinutes:1,productIds:[product],units:[{id:randomUUID(),type:'text',title:'Lesson',body:'Fixture lesson'}]};
  const saved=await call('rpc/save_learning_draft',{p_item_id:null,p_document:document,p_expected_version:0}); assert.equal(saved.status,200);
  assert.equal((await call('rpc/list_learning_drafts',{})).body.length,1);
  const session=(await admin.query('select id from private.sms_sessions where token_hash=$1',[digest(editorToken)])).rows[0].id;
  await transaction(admin,async db=>{
    await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:editor,sms_session_id:session})]);
    assert.equal((await db.query('select private.current_app_session_verified() as allowed')).rows[0].allowed,false,'knowing a session UUID does not authorize a different database caller');
  });
  await assert.rejects(pool.query('select * from auth.users'),/permission denied/);
  await assert.rejects(pool.query("update private.sms_identities set phone_e164='+12025550199'"),/permission denied/);
  const capability='cmh_'+'a'.repeat(43);
  await admin.query("insert into private.app_delegations(token_hash,session_id,audience,payload,expires_at) values($1,$2,'carebase','{\"operation\":\"overview\"}',now()+interval '30 seconds')",[digest(capability),session]);
  await assert.rejects(caps.consume(capability,'media'));
  assert.deepEqual(await caps.consume(capability,'carebase'),{user_id:editor,role:'platform_admin',method:'sms',operation:{operation:'overview'}});
  await assert.rejects(caps.consume(capability,'carebase'));
  await admin.query('update private.staff_permissions set revoked_at=now() where user_id=$1',[editor]);
  assert.equal((await call('rpc/get_learning_editor_access',{})).body,false);
  assert.equal((await call('rpc/list_learning_drafts',{})).status,403);
  await call('auth/logout',{});
  assert.equal((await call('auth/session',undefined,{Cookie:`${sessionCookie}=${editorToken}`})).body.authenticated,false);
  const next=await call('auth/sms/start',{phone:learnerPhone}); assert.equal(next.status,200);
  for(let i=0;i<5;i++) assert.equal((await call('auth/sms/verify',{challengeId:next.body.challengeId,code:'000000'})).status,401);
  assert.equal((await call('auth/sms/verify',{challengeId:next.body.challengeId,code:'123456'})).status,401,'a sixth attempt cannot succeed');
  const unknown=await call('auth/sms/start',{phone:'+12025550103'}); assert.equal(unknown.status,200); assert.equal(sent.length,2);
  assert.equal((await call('auth/sms/verify',{challengeId:unknown.body.challengeId,code:'123456'})).status,401);
  console.log('App SMS integration passed: actual PostgreSQL permissions, browser binding, rate limits, attempts, replay, roles, course creation, delegation and logout.');
} finally { await new Promise(resolve=>server.close(resolve)); await pool.end(); await admin.end(); }
