// Run only against the disposable local Supabase stack, never a live project.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { smsAuth,sessionCookie,digest,transaction,withSession,token } from './sms-auth.mjs';
import { gateway } from './gateway.mjs';
import { delegations } from './delegations.mjs';
import { parseAdvisorChangeResult } from '../supabase/functions/_shared/advisorsCommands.ts';
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
const nativeCalls=[];
const intelCalls=[];
const advisorsCalls=[];
const advisorsCommands=[];
const nativeCommandId=randomUUID();
const caps=delegations({pool,storageUrl:'https://storage.test',fetchImpl:async(url,options)=>{
  if(url==='https://caremetricadvisors.com/api/hub/admin-command') {
    const command=JSON.parse(options.body);
    assert.equal(options.redirect,'error');
    assert.equal(Object.keys(options.headers).length,2);
    const ticket=options.headers['X-CareMetric-Hub-Authorization'].slice(7);
    const authority=await caps.consume(ticket,'advisors');
    assert.equal(authority.user_id,editor);assert.equal(authority.role,'platform_admin');assert.equal(authority.method,'sms');
    assert.deepEqual(authority.operation,command,'authority covers exactly this change');await assert.rejects(caps.consume(ticket,'advisors'));
    advisorsCommands.push(command);
    // Advisors refuses a change whose snapshot no longer matches; 'stale' stands in for an edit made in its /admin inbox.
    if(command.expected.notes==='stale') return new Response('{"error":"changed"}',{status:409});
    const data=command.operation==='inquiries.delete'?{id:command.id,deleted:true}
      :{item:{id:command.id,createdAt:new Date().toISOString(),name:'Synthetic requester',email:'requester@test.invalid',organization:'Synthetic agency',phone:'',sector:'Home Health',service:'strategy',message:'Synthetic consultation request.',status:command.status,notes:command.notes}};
    return Response.json({contractVersion:1,product:'advisors',operation:command.operation,generatedAt:new Date().toISOString(),data});
  }
  if(url==='https://caremetricadvisors.com/api/hub/admin-read') {
    const operation=JSON.parse(options.body);
    assert.equal(options.redirect,'error');
    assert.equal(Object.keys(options.headers).length,2);
    assert.equal(options.headers.Authorization,undefined);
    const ticket=options.headers['X-CareMetric-Hub-Authorization'].slice(7);
    const authority=await caps.consume(ticket,'advisors');
    assert.equal(authority.user_id,editor);assert.equal(authority.method,'sms');
    assert.deepEqual(authority.operation,operation);await assert.rejects(caps.consume(ticket,'advisors'));
    advisorsCalls.push(operation);
    const data=operation.operation==='overview'?{organizationCount:null,activeUserCount:null,inquiryCount:3,openInquiryCount:1}
      :{items:[{id:'CM-0A1B2C3D4E5F',createdAt:new Date().toISOString(),name:'Synthetic requester',email:'requester@test.invalid',organization:'Synthetic agency',phone:'',sector:'Home Health',service:'strategy',message:'Synthetic consultation request.',status:'new',notes:'',form_digest:'private'}],total:1,limit:operation.limit,offset:operation.offset};
    return Response.json({contractVersion:1,product:'advisors',operation:operation.operation,generatedAt:new Date().toISOString(),data});
  }
  if(url==='https://www.caremetricintel.com/functions/centralAdminRead') {
    const operation=JSON.parse(options.body);
    assert.equal(options.redirect,'error');
    assert.equal(Object.keys(options.headers).length,2);
    assert.equal(options.headers.Authorization,undefined);
    const ticket=options.headers['X-CareMetric-Hub-Authorization'].slice(7);
    const authority=await caps.consume(ticket,'intel');
    assert.equal(authority.user_id,editor);assert.equal(authority.method,'sms');
    assert.deepEqual(authority.operation,operation);await assert.rejects(caps.consume(ticket,'intel'));
    intelCalls.push(operation);
    return Response.json({contractVersion:1,product:'intel',operation:operation.operation,generatedAt:new Date().toISOString(),data:{organizationCount:null,activeUserCount:null,registeredUserCount:2}});
  }
  assert.equal(url,'https://cmcarebase.com/api/platform-admin/command','only the fixed native command adapter is called');
  assert.equal(Object.keys(options.headers).length,2,'no browser cookies or provider credentials are forwarded');
  assert.equal(options.redirect,'error');
  const operation=JSON.parse(options.body);
  const authority=await caps.consume(options.headers.Authorization.slice(7),'carebase.command');
  assert.equal(authority.user_id,editor); assert.equal(authority.method,'sms');
  assert.deepEqual(authority.operation,operation,'native command exactly matches single-use authorization');
  nativeCalls.push({operation,authority});
  const generatedAt=new Date().toISOString();
  return Response.json({contractVersion:1,product:'carebase',operation:'preview',generatedAt,data:{
    commandId:nativeCommandId,action:operation.action,targetId:operation.targetId,reason:operation.reason,
    expiresAt:new Date(Date.now()+300000).toISOString(),previewDigest:'a'.repeat(64),
    changes:[{field:'active',before:'true',after:'false'}],
  }});
}});
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
  await assert.rejects(caps.consume(capability,'breathe'));
  assert.deepEqual(await caps.consume(capability,'carebase'),{user_id:editor,role:'platform_admin',method:'sms',operation:{operation:'overview'}});
  await assert.rejects(caps.consume(capability,'carebase'));
  const breatheCapability='cmh_'+'b'.repeat(43);
  await admin.query("insert into private.app_delegations(token_hash,session_id,audience,payload,expires_at) values($1,$2,'breathe','{\"operation\":\"capabilities\"}',now()+interval '30 seconds')",[digest(breatheCapability),session]);
  await assert.rejects(caps.consume(breatheCapability,'carebase'));
  assert.deepEqual(await caps.consume(breatheCapability,'breathe'),{user_id:editor,role:'platform_admin',method:'sms',operation:{operation:'capabilities'}});
  await assert.rejects(caps.consume(breatheCapability,'breathe'));
  const goCapability='cmh_'+'g'.repeat(43);
  await admin.query("insert into private.app_delegations(token_hash,session_id,audience,payload,expires_at) values($1,$2,'caremetric-go','{\"operation\":\"overview\"}',now()+interval '30 seconds')",[digest(goCapability),session]);
  await assert.rejects(caps.consume(goCapability,'caremetric-emr'));
  await assert.rejects(caps.consume(goCapability,'carebase'));
  await assert.rejects(caps.consume(goCapability,'caremetric-go'),{status:403});
  await assert.rejects(caps.consume(goCapability,'caremetric-go'));
  const emrCapability='cmh_'+'e'.repeat(43);
  await admin.query("insert into private.app_delegations(token_hash,session_id,audience,payload,expires_at) values($1,$2,'caremetric-emr','{\"operation\":\"capabilities\"}',now()+interval '30 seconds')",[digest(emrCapability),session]);
  await assert.rejects(caps.consume(emrCapability,'caremetric-go'));
  await assert.rejects(caps.consume(emrCapability,'caremetric-emr'),{status:403});
  const commandOperation={operation:'preview',requestId:randomUUID(),action:'users.setActive',targetId:learner,parameters:{active:false},reason:'Synthetic session integration'};
  const intelCapability='cmh_'+'i'.repeat(43);
  await admin.query("insert into private.app_delegations(token_hash,session_id,audience,payload,expires_at) values($1,$2,'intel','{\"operation\":\"overview\"}',now()+interval '30 seconds')",[digest(intelCapability),session]);
  for(const audience of ['pennsync','caremetric-go','carebase','media'])await assert.rejects(caps.consume(intelCapability,audience));
  assert.deepEqual(await caps.consume(intelCapability,'intel'),{user_id:editor,role:'platform_admin',method:'sms',operation:{operation:'overview'}});
  await assert.rejects(caps.consume(intelCapability,'intel'));
  const intelOverview=await caps.admin(editorToken,{product:'intel',operation:'overview'});
  assert.deepEqual(intelOverview.data,{organizationCount:null,activeUserCount:null,registeredUserCount:2});assert.equal(intelCalls.length,1);
  const advisorsCapability='cmh_'+'v'.repeat(43);
  await admin.query("insert into private.app_delegations(token_hash,session_id,audience,payload,expires_at) values($1,$2,'advisors','{\"operation\":\"overview\"}',now()+interval '30 seconds')",[digest(advisorsCapability),session]);
  for(const audience of ['intel','breathe','carebase','media'])await assert.rejects(caps.consume(advisorsCapability,audience));
  assert.deepEqual(await caps.consume(advisorsCapability,'advisors'),{user_id:editor,role:'platform_admin',method:'sms',operation:{operation:'overview'}});
  await assert.rejects(caps.consume(advisorsCapability,'advisors'));
  assert.deepEqual((await caps.admin(editorToken,{product:'advisors',operation:'overview'})).data,{organizationCount:null,activeUserCount:null,inquiryCount:3,openInquiryCount:1});
  const advisorsPage=await caps.admin(editorToken,{product:'advisors',operation:'inquiries.list',limit:20,offset:0});
  assert.equal(advisorsPage.data.items[0].form_digest,undefined,'unreviewed Advisors fields never reach the browser');
  assert.equal(advisorsPage.data.items[0].phone,null);
  await assert.rejects(caps.admin(editorToken,{product:'advisors',operation:'users.list'}),'Advisors exposes only its consultation inbox');
  await assert.rejects(caps.admin(editorToken,{product:'advisors',operation:'inquiries.update',id:'CM-0A1B2C3D4E5F',status:'closed',notes:'',expected:{status:'new',notes:''}}),'reads never carry a change');
  assert.equal(advisorsCalls.length,2);
  // The owner manages consultation requests: each change carries command authority for exactly that change.
  const advisorUpdate={operation:'inquiries.update',id:'CM-0A1B2C3D4E5F',status:'in-progress',notes:'Called back on Tuesday.',expected:{status:'new',notes:''}};
  const updated=await caps.advisorsCommand(editorToken,advisorUpdate);
  assert.deepEqual([updated.item.id,updated.item.status,updated.item.notes,updated.item.phone],['CM-0A1B2C3D4E5F','in-progress','Called back on Tuesday.',null]);
  assert.deepEqual(await caps.advisorsCommand(editorToken,{operation:'inquiries.delete',id:'CM-0A1B2C3D4E5F',expected:{status:'in-progress',notes:'Called back on Tuesday.'}}),{id:'CM-0A1B2C3D4E5F',deleted:true});
  await assert.rejects(caps.advisorsCommand(editorToken,{...advisorUpdate,expected:{status:'new',notes:'stale'}}),error=>error.status===409&&/changed in Advisors/.test(error.message));
  await assert.rejects(caps.advisorsCommand(editorToken,{...advisorUpdate,extra:true}),{status:400});
  const learnerToken=token();
  const {rows:[learnerIdentity]}=await admin.query('select identity_version from private.sms_identities where user_id=$1',[learner]);
  await admin.query("insert into private.sms_sessions(id,token_hash,user_id,identity_version,expires_at) values($1,$2,$3,$4,now()+interval '1 hour')",[randomUUID(),digest(learnerToken),learner,learnerIdentity.identity_version]);
  await assert.rejects(caps.advisorsCommand(learnerToken,advisorUpdate),'only the platform administrator manages Advisors requests');
  assert.equal(advisorsCommands.length,3,'malformed changes and other people never reach Advisors');
  assert.equal((await call('admin/advisors-command',advisorUpdate,{Origin:'https://evil.test'})).status,403);
  assert.equal(advisorsCommands.length,3);
  // Through the browser route: the largest permitted change (two 3,000-character notes, 3 bytes per character) fits,
  // and its answer is exactly what the browser checks.
  const largestChange={...advisorUpdate,notes:'\u20ac'.repeat(3000),expected:{status:'new',notes:'\u2014'.repeat(3000)}};
  const routed=await call('admin/advisors-command',largestChange);
  assert.equal(routed.status,200);
  assert.deepEqual(parseAdvisorChangeResult(routed.body,largestChange),routed.body);
  assert.equal(advisorsCommands.length,4);
  assert.equal((await call('admin/command',{product:'carebase',...commandOperation},{Origin:'https://evil.test'})).status,403);
  assert.equal(nativeCalls.length,0);
  const httpPreview=await call('admin/command',{product:'carebase',...commandOperation});
  assert.equal(httpPreview.status,200); assert.equal(httpPreview.body.data.commandId,nativeCommandId);
  assert.equal(nativeCalls.length,1,'one explicit preview sends exactly one native command');
  assert.equal((await call('admin/command',{product:'breathe',...commandOperation})).status,400);
  assert.equal(nativeCalls.length,1,'unsupported applications never receive a command or capability');
  const commandCapability='cmh_'+'c'.repeat(43);
  await admin.query("insert into private.app_delegations(token_hash,session_id,audience,payload,expires_at) values($1,$2,'carebase.command',$3::jsonb,now()+interval '30 seconds')",[digest(commandCapability),session,JSON.stringify(commandOperation)]);
  await assert.rejects(caps.consume(commandCapability,'carebase'),'a command authorization cannot be used for a read');
  const commandActor=await caps.consume(commandCapability,'carebase.command');
  assert.equal(commandActor.method,'sms'); assert.equal(commandActor.aal,undefined);
  assert.equal(commandActor.session_id,session); assert.equal(commandActor.user_id,editor);
  assert.deepEqual(commandActor.operation,commandOperation);
  assert.equal(Date.parse(commandActor.assurance_expires_at)-Date.parse(commandActor.session_started_at),8*60*60*1000);
  await assert.rejects(caps.consume(commandCapability,'carebase.command'),'command authorization is single use');
  // Breathe's and Intel's change endpoints redeem their own command audiences (20261117100000_app_command_audiences.sql).
  const appCaps=delegations({pool,storageUrl:'https://storage.test',fetchImpl:async()=>{throw new Error('No native call is expected.');},appCommands:true});
  const lifecycleOperation={domain:'tenant.lifecycle.v1',operation:'context',targetId:'5b0c5a0e-2f4e-4d7a-9a3b-0a6c1e2d3f40'};
  const breatheChangeCapability='cmh_'+'h'.repeat(43);
  await admin.query("insert into private.app_delegations(token_hash,session_id,audience,payload,expires_at) values($1,$2,'breathe.command',$3::jsonb,now()+interval '30 seconds')",[digest(breatheChangeCapability),session,JSON.stringify(lifecycleOperation)]);
  await assert.rejects(appCaps.consume(breatheChangeCapability,'breathe'),'a Breathe change capability cannot be used for a Breathe read');
  await assert.rejects(caps.consume(breatheChangeCapability,'breathe.command'),'Breathe changes are refused until the database declares them');
  const breatheActor=await appCaps.consume(breatheChangeCapability,'breathe.command');
  assert.deepEqual(Object.keys(breatheActor).sort(),['assurance_expires_at','method','operation','role','session_id','session_started_at','user_id'],'Breathe receives exactly the proof it checks');
  assert.deepEqual(breatheActor.operation,lifecycleOperation); assert.equal(breatheActor.role,'platform_admin');
  await assert.rejects(appCaps.consume(breatheChangeCapability,'breathe.command'),'a Breathe change capability is single use');
  const intelOperation={operation:'preview',requestId:'7d3c1b2a-4e5f-4a6b-8c7d-9e0f1a2b3c4d',action:'users.setActive',targetId:'00000000000000000000002a',parameters:{active:false},reason:'Left the agency last week'};
  const intelChangeCapability='cmh_'+'f'.repeat(43);
  await admin.query("insert into private.app_delegations(token_hash,session_id,audience,payload,expires_at) values($1,$2,'intel.command',$3::jsonb,now()+interval '30 seconds')",[digest(intelChangeCapability),session,JSON.stringify(intelOperation)]);
  await assert.rejects(appCaps.consume(intelChangeCapability,'intel'),'an Intel change capability cannot be used for an Intel read');
  await assert.rejects(appCaps.consume(intelChangeCapability,'carebase.command'),'an Intel change capability cannot authorize a CareBase change');
  const intelActor=await appCaps.consume(intelChangeCapability,'intel.command');
  assert.deepEqual(intelActor.operation,intelOperation); assert.equal(intelActor.session_id,session);
  // The Advisors check replays an earlier migration whose audience constraint predates these two; leave no rows that it would refuse.
  await admin.query("delete from private.app_delegations where audience in ('breathe.command','intel.command')");
  const commandAuthority=()=>withSession(pool,editorToken,async db=>(await db.query('select hub.authorize_app_command() as actor')).rows[0].actor);
  const recordedTimes=(await admin.query('select created_at,expires_at from private.sms_sessions where id=$1',[session])).rows[0];
  await admin.query("update private.sms_sessions set created_at=now()-interval '8 hours 1 second',expires_at=now()+interval '1 hour' where id=$1",[session]);
  await assert.rejects(commandAuthority,/Current administrator session/,'extending expiry cannot refresh original eight-hour assurance');
  await admin.query("update private.sms_sessions set created_at=now()+interval '6 minutes' where id=$1",[session]);
  await assert.rejects(commandAuthority,/Current administrator session/,'future-dated sessions cannot authorize commands');
  await admin.query('update private.sms_sessions set created_at=$2,expires_at=$3 where id=$1',[session,recordedTimes.created_at,recordedTimes.expires_at]);
  assert.equal((await commandAuthority()).method,'sms');
  const sessionBoundCapability='cmh_'+'d'.repeat(43);
  await admin.query("insert into private.app_delegations(token_hash,session_id,audience,payload,expires_at) values($1,$2,'carebase.command',$3::jsonb,now()+interval '30 seconds')",[digest(sessionBoundCapability),session,JSON.stringify(commandOperation)]);
  await admin.query('update private.sms_sessions set revoked_at=now() where id=$1',[session]);
  await assert.rejects(caps.consume(sessionBoundCapability,'carebase.command'),'logout revokes already-issued command capability');
  await admin.query('update private.sms_sessions set revoked_at=null where id=$1',[session]);
  await admin.query("update auth.users set banned_until=now()+interval '1 day' where id=$1",[editor]);
  assert.equal((await call('rpc/get_learning_editor_access',{})).body,false,'banned users lose permissions');
  await admin.query('update auth.users set banned_until=null where id=$1',[editor]);
  await admin.query("update private.sms_sessions set expires_at=now()-interval '1 second' where id=$1",[session]);
  assert.equal((await call('rpc/list_learning_drafts',{})).status,401,'expired sessions are rejected');
  await admin.query("update private.sms_sessions set expires_at=now()+interval '1 hour' where id=$1",[session]);
  await admin.query('update private.staff_permissions set revoked_at=now() where user_id=$1',[editor]);
  await assert.rejects(commandAuthority,/Current administrator session/,'permission removal blocks commands immediately');
  assert.equal((await call('rpc/get_learning_editor_access',{})).body,false);
  assert.equal((await call('rpc/list_learning_drafts',{})).status,403);
  await call('auth/logout',{});
  assert.equal((await call('auth/session',undefined,{Cookie:`${sessionCookie}=${editorToken}`})).body.authenticated,false);
  await admin.query('update private.sms_sessions set revoked_at=null where id=$1',[session]);
  await admin.query("update private.sms_identities set phone_e164='+12025550109' where user_id=$1",[editor]);
  assert.equal((await call('auth/session',undefined,{Cookie:`${sessionCookie}=${editorToken}`})).body.authenticated,false,'number changes invalidate existing sessions');
  const next=await call('auth/sms/start',{phone:learnerPhone}); assert.equal(next.status,200);
  for(let i=0;i<5;i++) assert.equal((await call('auth/sms/verify',{challengeId:next.body.challengeId,code:'000000'})).status,401);
  assert.equal((await call('auth/sms/verify',{challengeId:next.body.challengeId,code:'123456'})).status,401,'a sixth attempt cannot succeed');
  const unknown=await call('auth/sms/start',{phone:'+12025550103'}); assert.equal(unknown.status,200); assert.equal(sent.length,2);
  assert.equal((await call('auth/sms/verify',{challengeId:unknown.body.challengeId,code:'123456'})).status,401);
  console.log('App SMS integration passed: actual PostgreSQL permissions, browser binding, rate limits, attempts, replay, roles, course creation, delegation and logout.');
} finally { await new Promise(resolve=>server.close(resolve)); await pool.end(); await admin.end(); }
