// Disposable actual PostgreSQL, app SMS sessions, HTTP, one-use native transport.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {smsAuth,sessionCookie,digest,withSession} from './sms-auth.mjs';
import {gateway} from './gateway.mjs';
import {delegations} from './delegations.mjs';
import {appServer} from './http.mjs';
const databaseUrl=process.env.HUB_TEST_DATABASE_URL,local=new URL(databaseUrl);
assert.equal(local.hostname,'127.0.0.1');assert.equal(local.port,'54322');
const admin=new pg.Pool({connectionString:databaseUrl});
await admin.query("alter role hub_app_server login password 'ephemeral-test-only'");
const appUrl=new URL(databaseUrl);appUrl.username='hub_app_server';appUrl.password='ephemeral-test-only';
const pool=new pg.Pool({connectionString:appUrl.href}),owner=randomUUID(),phone='+12025550731';
const source=JSON.parse(readFileSync(new URL('../src/imports/fixtures/pennsyncLearningSource.json',import.meta.url)));
let payload=JSON.stringify(source),nativeRevoked=false,revokeAfterRead=false,nativeCalls=0;
await admin.query("insert into auth.users(id,email,is_anonymous) values($1,'pennsync-source-owner@test.invalid',false)",[owner]);
await admin.query("insert into private.staff_permissions(user_id,permission) values($1,'platform.admin')",[owner]);
await admin.query('insert into private.sms_identities(user_id,phone_e164) values($1,$2)',[owner,phone]);
const provider={send:async()=>randomUUID(),verify:async(_id,_phone,code)=>code==='123456'};
const auth=smsAuth({pool,provider});
const caps=delegations({pool,storageUrl:'https://storage.test',fetchImpl:async(url,options)=>{
 nativeCalls++;assert.match(url,/centralAdminRead$/);assert.equal(options.redirect,'error');
 assert.deepEqual(Object.keys(options.headers).sort(),['Content-Type','X-CareMetric-Hub-Authorization']);
 const ticket=options.headers['X-CareMetric-Hub-Authorization'].slice(7),op=JSON.parse(options.body);
 assert.deepEqual(op,{operation:'learning.source.snapshot'});
 await assert.rejects(caps.consume(ticket,'carebase'));
 const authority=await caps.consume(ticket,'pennsync');assert.equal(authority.user_id,owner);assert.equal(authority.method,'sms');assert.deepEqual(authority.operation,op);
 await assert.rejects(caps.consume(ticket,'pennsync'));
 if(nativeRevoked)return Response.json({error:{code:'forbidden'}},{status:403});
 if(revokeAfterRead)await admin.query('update private.staff_permissions set revoked_at=now() where user_id=$1',[owner]);
 return Response.json({contractVersion:1,product:'pennsync',operation:op.operation,generatedAt:new Date().toISOString(),data:{payload,sourceRevision:digest(payload)}});
}});
const server=appServer({auth,gateway:gateway(pool),delegations:caps,origins:['https://hub.test']});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`,jar={};
async function call(path,body,headers={}){
 const response=await fetch(origin+'/api/'+path,{method:'POST',headers:{Origin:'https://hub.test','Content-Type':'application/json',Cookie:Object.entries(jar).map(([k,v])=>`${k}=${v}`).join('; '),...headers},body:JSON.stringify(body)});
 assert.equal(response.headers.get('cache-control'),'no-store');
 for(const value of response.headers.getSetCookie()){const [pair]=value.split(';'),i=pair.indexOf('=');jar[pair.slice(0,i)]=pair.slice(i+1);}
 return {status:response.status,body:await response.json()};
}
const migrate=body=>call('admin/pennsync-migration',body),inspect=()=>migrate({operation:'inspect'});
const snapshotCount=async()=>Number((await admin.query('select count(*) from private.pennsync_learning_snapshots where staged_by=$1',[owner])).rows[0].count);
try{
 assert.equal((await inspect()).status,401);assert.equal(nativeCalls,0);
 const challenge=await call('auth/sms/start',{phone});assert.equal(challenge.status,200);
 assert.equal((await call('auth/sms/verify',{challengeId:challenge.body.challengeId,code:'123456'})).status,200);
 assert.equal((await call('admin/pennsync-migration',{operation:'inspect'},{Origin:'https://other.test'})).status,403);
 const preview=await inspect();assert.equal(preview.status,200,JSON.stringify(preview.body));
 assert.equal(preview.body.summary.unmatchedLegacyLearners,1);assert.equal(preview.body.summary.standaloneModules,1);
 assert.equal(JSON.stringify(preview.body).includes('unmatched@example.test'),false);assert.equal(preview.body.payload,undefined);
 const preserve={operation:'preserve',sourceRevision:preview.body.sourceRevision,expectedHeadRevision:preview.body.headRevision,reviewed:true};
 assert.equal((await migrate({...preserve,reviewed:false})).status,400);
 const original=payload;payload+=' ';assert.equal((await migrate(preserve)).status,409);payload=original;
 assert.equal(await snapshotCount(),0);
 const first=await migrate(preserve);assert.equal(first.status,200,JSON.stringify(first.body));assert.equal(first.body.replayed,false);
 const concurrent=await Promise.all([migrate(preserve),migrate(preserve)]);assert.ok(concurrent.every(row=>row.status===200&&row.body.replayed));assert.equal(await snapshotCount(),1);
 const stored=(await admin.query('select source_payload from private.pennsync_learning_snapshots where id=$1',[first.body.snapshotId])).rows[0].source_payload;
 assert.equal(stored,payload);assert.equal(JSON.parse(stored).records.TrainingCompletion[0].fields.nurse_email,'unmatched@example.test');
 const originalDrafts=Number((await admin.query('select count(*) from private.learning_courses')).rows[0].count);
 payload=JSON.stringify({...source,records:{...source.records,TrainingCourse:[{...source.records.TrainingCourse[0],fields:{...source.records.TrainingCourse[0].fields,title:'Updated fixture'}}]}});
 const next=await inspect();const nextOp={operation:'preserve',sourceRevision:next.body.sourceRevision,expectedHeadRevision:first.body.sourceRevision,reviewed:true};
 assert.equal((await migrate({...nextOp,expectedHeadRevision:null})).status,409);assert.equal(await snapshotCount(),1);
 const second=await migrate(nextOp);assert.equal(second.status,200);assert.equal(await snapshotCount(),2);
 payload=original;const replay=await migrate(preserve);assert.equal(replay.status,200);assert.equal(replay.body.snapshotId,first.body.snapshotId);assert.equal(replay.body.headRevision,second.body.sourceRevision);
 assert.equal(Number((await admin.query('select count(*) from private.learning_courses')).rows[0].count),originalDrafts);
 assert.equal(Number((await admin.query('select count(*) from private.learning_enrollments where user_id=$1',[owner])).rows[0].count),0);
 await assert.rejects(withSession(pool,jar[sessionCookie],db=>db.query('select private.pennsync_learning_head()')),error=>error.code==='42501');
 for(const role of ['anon','authenticated','service_role','hub_app_server']){
  assert.equal((await admin.query("select has_table_privilege($1,'private.pennsync_learning_snapshots','SELECT,INSERT,UPDATE,DELETE') allowed",[role])).rows[0].allowed,false);
 }
 for(const role of ['anon','authenticated','service_role'])assert.equal((await admin.query("select has_function_privilege($1,'private.pennsync_learning_preserve(text,text,text,jsonb)','EXECUTE') allowed",[role])).rows[0].allowed,false);
 nativeRevoked=true;assert.equal((await migrate(preserve)).status,403);nativeRevoked=false;
 revokeAfterRead=true;assert.equal((await migrate(preserve)).status,401);revokeAfterRead=false;
 await admin.query('update private.staff_permissions set revoked_at=null where user_id=$1',[owner]);
 await admin.query('update private.sms_identities set revoked_at=now() where user_id=$1',[owner]);assert.equal((await inspect()).status,401);
 assert.equal(await snapshotCount(),2);
 console.log('PennSync migration PostgreSQL/HTTP passed: private exact source/history preservation, current SMS/native authority, replay, concurrency, stale revisions, no learner grants or publication, one-use capabilities and direct-role denial.');
}finally{await new Promise(resolve=>server.close(resolve));await pool.end();await admin.end();}
