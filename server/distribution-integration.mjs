// Disposable PostgreSQL plus actual SMS cookies, one-use capabilities and HTTP.
// Source/provider fixtures contain only synthetic course material.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { smsAuth,sessionCookie,digest,token,withSession } from './sms-auth.mjs';
import { gateway } from './gateway.mjs';
import { delegations } from './delegations.mjs';
import { distributionObserver,observerQuery } from './distribution-observer.mjs';
import { appServer } from './http.mjs';
const local=new URL(process.env.HUB_TEST_DATABASE_URL);assert.equal(local.hostname,'127.0.0.1');assert.equal(local.port,'54322');
const admin=new pg.Pool({connectionString:local.href});await admin.query("alter role hub_app_server login password 'ephemeral-test-only'");
local.username='hub_app_server';local.password='ephemeral-test-only';const pool=new pg.Pool({connectionString:local.href});
const owner=randomUUID(),phone='+12025550941',sources=new Map(),machineToken=token();let bridge,nativeAllowed=true,machineUnavailable=false,machineChange=false,revokeAfterRead=false,holdHuman=null;
const sourceFixture=JSON.parse(readFileSync(new URL('../src/imports/fixtures/governedCourse.json',import.meta.url)));
const status=id=>{const source=sources.get(id);return source?{courseId:id,publicationState:source.publicationState,currentVersionId:source.sourceVersionId,
  currentVersionState:source.sourceVersionState,sourceRevision:source.publicationState==='published'&&source.sourceVersionState==='published'?digest(JSON.stringify(source)):null}:
  {courseId:id,publicationState:'missing',currentVersionId:null,currentVersionState:null,sourceRevision:null};};
const fetchImpl=async(url,options)=>{
  assert.equal(options.redirect,'error');assert.equal(new Headers(options.headers).get('Origin'),null);assert.equal(new Headers(options.headers).get('Cookie'),null);
  const op=JSON.parse(options.body);
  if(url==='https://cmcarebase.com/api/internal/learning/distribution-status'){
    assert.equal(new Headers(options.headers).get('Authorization'),'Bearer '+machineToken);assert.equal(op.domain,'course.distribution.status.v1');assert.equal(op.operation,'status');
    assert.ok(op.courseIds.length<=10);if(machineUnavailable)return Response.json({private:'never disclosed'},{status:503});
    const items=op.courseIds.map(status);if(machineChange)items[0]={...items[0],sourceRevision:'f'.repeat(64)};
    if(revokeAfterRead){revokeAfterRead=false;await admin.query('update private.staff_permissions set revoked_at=now() where user_id=$1',[owner]);}
    return Response.json({contractVersion:1,product:'carebase',domain:op.domain,operation:'status',generatedAt:new Date().toISOString(),data:{items:items.reverse()}});
  }
  if(url==='https://cmcarebase.com/api/platform-admin/read'){
    assert.deepEqual(op,{operation:'capabilities'});const cap=new Headers(options.headers).get('Authorization').slice(7);
    const actor=await bridge.consume(cap,'carebase');assert.equal(actor.user_id,owner);assert.deepEqual(actor.operation,op);await assert.rejects(bridge.consume(cap,'carebase'));
    if(!nativeAllowed)return Response.json({},{status:403});
    return Response.json({contractVersion:1,product:'carebase',operation:'capabilities',generatedAt:new Date().toISOString(),data:{apiVersion:1,operations:['learning.distribution.context'],sourceRevision:null}});
  }
  assert.equal(url,'https://cmcarebase.com/api/learning-admin/distribution');assert.equal(op.domain,'course.distribution.v1');assert.equal(op.operation,'context');
  const cap=new Headers(options.headers).get('Authorization').slice(7),actor=await bridge.consume(cap,'carebase.learning');assert.equal(actor.user_id,owner);assert.equal(actor.method,'sms');assert.ok(actor.session_id);assert.deepEqual(actor.operation,op);
  await assert.rejects(bridge.consume(cap,'carebase.learning'));if(!nativeAllowed)return Response.json({private:'withheld'},{status:403});
  const row=status(op.courseId),source=sources.get(op.courseId);if(!source)return Response.json({},{status:404});
  const data={courseId:op.courseId,publicationState:row.publicationState,currentVersionId:row.currentVersionId,currentVersionState:row.currentVersionState,
    source:row.sourceRevision?{payload:JSON.stringify(source),sourceRevision:row.sourceRevision}:null};
  if(holdHuman){const gate=holdHuman;holdHuman=null;gate.started();await gate.wait;}
  return Response.json({contractVersion:1,product:'carebase',domain:op.domain,operation:'context',generatedAt:new Date().toISOString(),data});
};
const observer=distributionObserver({pool,token:machineToken,fetchImpl});
const auth=smsAuth({pool,provider:{send:async()=>randomUUID(),verify:async(_id,_phone,code)=>code==='123456'}});
bridge=delegations({pool,storageUrl:'https://storage.invalid',observer,fetchImpl});
const server=appServer({auth,gateway:gateway(pool),delegations:bridge,origins:['https://hub.test']});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`,jar={};
async function call(path,body,headers={}){
  const response=await fetch(origin+'/api/'+path,{method:'POST',headers:{Origin:'https://hub.test','Content-Type':'application/json',Cookie:Object.entries(jar).map(([k,v])=>`${k}=${v}`).join('; '),...headers},body:JSON.stringify(body)});
  assert.equal(response.headers.get('cache-control'),'no-store');for(const value of response.headers.getSetCookie()){const [pair]=value.split(';'),i=pair.indexOf('=');jar[pair.slice(0,i)]=pair.slice(i+1);}
  return {status:response.status,body:await response.json()};
}
const run=(op,headers)=>call('admin/course-distribution',op,headers),ok=response=>{assert.equal(response.status,200,JSON.stringify(response.body));return response.body;};
const load=async courseId=>ok(await run({operation:'context',courseId}));
const preview=(context,patch={})=>({operation:'preview',requestId:randomUUID(),plan:{courseId:context.native.courseId,versionId:context.native.currentVersionId,sourceRevision:context.native.source.sourceRevision,
  expectedCatalogDigest:context.catalog.catalogDigest,metadata:{title:'Shared synthetic course',summary:'Reviewed safe catalog metadata',category:'Safety',durationMinutes:40},productIds:context.products.filter(p=>p.eligible).slice(0,2).map(p=>p.id).sort(),removedProductIds:[],
  accessLevel:'public',reason:'Reviewed current material for shared publication',reviewed:true,confirmReplacement:context.catalog.productIds.length>0,confirmRetirements:false,...patch}});
const commit=intent=>({operation:'commit',requestId:intent.requestId,expectedDigest:intent.previewDigest});
const visible=async itemId=>{
  const db=await admin.connect();try{await db.query('begin');await db.query('set local role anon');const rows=(await db.query('select * from hub.list_published_content() where id in(select $1::uuid)',[itemId])).rows;await db.query('rollback');return rows;}
  finally{db.release();}
};
async function registered({legacy=false}={}){
  const id=randomUUID(),item=randomUUID(),version=randomUUID(),source=structuredClone(sourceFixture);Object.assign(source,{sourceCourseId:id,sourceVersionId:version});sources.set(id,source);
  await admin.query("insert into hub.content_items(id,content_key,kind,status,access_level,source_system) values($1,$2,'course','draft','staff','penntrain')",[item,'distribution.synthetic.'+id]);
  await admin.query('insert into hub.course_links(content_item_id,penntrain_course_id,source_version,launch_path,duration_minutes) values($1,$2,$3,$4,40)',[item,id,version,'/app/courses/'+id]);
  if(!legacy){const session=(await admin.query('select id from private.sms_sessions where token_hash=$1',[digest(jar[sessionCookie])])).rows[0].id;
    await admin.query("insert into private.course_creation_intents(request_id,actor_id,session_id,course_id,version_id,request,result,registration) values($1,$2,$3,$4,$5,'{}','{}',$6)",[randomUUID(),owner,session,id,version,{itemId:item,snapshotId:null,sourceRevision:null}]);}
  return {id,item,version};
}
try{
  await admin.query("insert into auth.users(id,email,is_anonymous) values($1,'distribution-owner@test.invalid',false)",[owner]);
  await admin.query("insert into private.staff_permissions(user_id,permission) values($1,'platform.admin')",[owner]);await admin.query('insert into private.sms_identities(user_id,phone_e164) values($1,$2)',[owner,phone]);
  assert.equal((await run({operation:'context',courseId:randomUUID()})).status,401);
  const started=ok(await call('auth/sms/start',{phone}));ok(await call('auth/sms/verify',{challengeId:started.challengeId,code:'123456'}));
  const course=await registered(),context=await load(course.id);assert.equal(context.catalog.availability.managed,false);assert.equal(context.catalog.legacy,false);
  assert.equal((await run({operation:'context',courseId:course.id},{Origin:'https://evil.test'})).status,403);
  assert.equal((await call('admin/course-distribution?url=evil',{operation:'context',courseId:course.id})).status,400);
  assert.equal((await run({...preview(context),payload:'caller bytes'})).status,400);
  const legacy=await registered({legacy:true}),oldContext=await load(legacy.id);assert.equal(oldContext.catalog.legacy,true);assert.equal(oldContext.legacyOptInAllowed,false);
  assert.equal((await run(preview(oldContext))).status,403);
  assert.equal((await admin.query('select private.course_distribution_available($1,$2) as allowed',[legacy.item,randomUUID()])).rows[0].allowed,true,'untouched legacy remains governed by existing policy');
  const request=preview(context),review=ok(await run(request));assert.equal(review.result,null);assert.deepEqual(ok(await run(request)),review);
  assert.equal((await run({...request,plan:{...request.plan,reason:'Changed same request identity'}})).status,409);
  assert.equal((await admin.query('select count(*) from hub.content_publications where item_id=$1',[course.item])).rows[0].count,'0','preview grants no publication');
  await assert.rejects(withSession(pool,jar[sessionCookie],db=>db.query('select * from private.learning_distribution_intents')),/permission denied/);
  await assert.rejects(withSession(pool,jar[sessionCookie],db=>db.query('select private.commit_course_distribution($1,$2,$3,false)',[request.requestId,review.previewDigest,randomUUID()])),/permission denied/);
  machineUnavailable=true;assert.equal((await run(commit(review))).status,503);machineUnavailable=false;
  machineChange=true;assert.equal((await run(commit(review))).status,409);machineChange=false;
  const success=ok(await run(commit(review)));assert.ok(success.result);assert.equal(success.result.itemId,course.item);assert.deepEqual(success.result.productIds,request.plan.productIds);
  assert.deepEqual(ok(await run(commit(review))),success,'recovered response reuses exactly one revision');
  assert.equal((await admin.query('select count(*) from hub.content_revisions where item_id=$1',[course.item])).rows[0].count,'1');
  const publicRows=await visible(success.result.revisionId);assert.equal(publicRows.length,1);assert.equal(publicRows[0].placements.length,2,'one shared revision serves two selected app placements');
  assert.ok(!JSON.stringify(publicRows).includes('creditedDurationRationale'));assert.ok(!JSON.stringify(publicRows).includes('source_payload'));assert.ok(!JSON.stringify(publicRows).includes('correct'));
  await assert.rejects(admin.query("update hub.content_revisions set title='Changed immutable revision' where id=$1",[success.result.revisionId]),error=>error.code==='42501');
  await assert.rejects(admin.query('delete from private.learning_distribution_revisions where revision_id=$1',[success.result.revisionId]),error=>error.code==='42501');
  await assert.rejects(admin.query('update private.learning_distribution_intents set plan=plan where request_id=$1',[request.requestId]),error=>error.code==='42501');
  // A new authoring draft can be the preserved head; distribution of the current
  // published version must never rewind or adopt that separate draft.
  const draft=structuredClone(sources.get(course.id));draft.sourceVersionId=randomUUID();draft.sourceVersionState='draft';const draftPayload=JSON.stringify(draft);
  await withSession(pool,jar[sessionCookie],db=>db.query('select hub.stage_learning_source($1,$2,null)',[draftPayload,digest(draftPayload)]));
  const headBefore=(await admin.query('select id,source_revision,sequence from private.learning_source_snapshots where source_course_id=$1 order by sequence desc limit 1',[course.id])).rows;
  const replaceContext=await load(course.id),replacement=preview(replaceContext,{productIds:[success.result.productIds[0]],removedProductIds:[success.result.productIds[1]],confirmRetirements:true});
  assert.equal((await run({...replacement,plan:{...replacement.plan,confirmRetirements:false}})).status,400);
  const replacementReview=ok(await run(replacement));
  const second=ok(await run(commit(replacementReview)));assert.equal(second.result.itemId,course.item);assert.equal(second.result.revisionNumber,2);
  assert.deepEqual((await admin.query('select id,source_revision,sequence from private.learning_source_snapshots where source_course_id=$1 order by sequence desc limit 1',[course.id])).rows,headBefore);
  assert.equal((await visible(success.result.revisionId)).length,0,'the replaced revision is not current');assert.equal((await visible(second.result.revisionId))[0].placements.length,1);
  const before=(await admin.query('select before_catalog from private.learning_distribution_revisions where revision_id=$1',[second.result.revisionId])).rows[0].before_catalog;
  assert.equal(before.publications.length,2);assert.equal(before.revisions[0].id,success.result.revisionId);
  sources.get(course.id).publicationState='archived';await load(course.id);assert.equal((await visible(second.result.revisionId)).length,0);
  assert.deepEqual(ok(await run(commit(replacementReview))).result,second.result,'old receipt does not republish retired source');
  sources.get(course.id).publicationState='published';await load(course.id);assert.equal((await visible(second.result.revisionId)).length,1);
  await admin.query("update private.learning_distribution_observations set observed_at=now()-interval '16 minutes',attempted_at=now()-interval '6 minutes' where course_id=$1",[course.id]);
  assert.equal((await visible(second.result.revisionId)).length,0,'stale managed observations withhold availability');
  assert.equal((await observer.tick()).courses,1);assert.equal((await visible(second.result.revisionId)).length,1,'machine observer works without a human session');
  sources.get(course.id).version.description='Later material change';await admin.query("update private.learning_distribution_observations set attempted_at=now()-interval '6 minutes' where course_id=$1",[course.id]);
  await observer.tick();assert.equal((await visible(second.result.revisionId)).length,0,'hash mismatch never republishes implicitly');
  const changed=await load(course.id),staleReview=ok(await run(preview(changed,{removedProductIds:[],confirmReplacement:true})));
  await admin.query("update hub.content_items set owner_team='Later catalog edit' where id=$1",[course.item]);assert.equal((await run(commit(staleReview))).status,409);
  const fresh=await load(course.id),thirdReview=ok(await run(preview(fresh,{confirmReplacement:true})));const revisionsBefore=(await admin.query('select count(*) from hub.content_revisions where item_id=$1',[course.item])).rows[0].count;
  await admin.query(`create function private.fixture_distribution_audit_failure() returns trigger language plpgsql set search_path='' as $$begin if new.actor_id='${owner}' and new.action='learning.distribution.committed' then raise exception 'Synthetic rollback';end if;return new;end;$$`);
  await admin.query('create trigger fixture_distribution_audit_failure before insert on private.audit_events for each row execute function private.fixture_distribution_audit_failure()');
  try{assert.equal((await run(commit(thirdReview))).status,503);assert.equal((await admin.query('select count(*) from hub.content_revisions where item_id=$1',[course.item])).rows[0].count,revisionsBefore);}
  finally{await admin.query('drop trigger fixture_distribution_audit_failure on private.audit_events');await admin.query('drop function private.fixture_distribution_audit_failure()');}
  // A legitimate review may expire while waiting on a catalog lock. Seed a
  // short-lived private fixture with immutable source and a fresh request ID;
  // do not disable any authority or immutability trigger.
  const expiringId=randomUUID(),expiry=new Date(Date.now()+5000).toISOString();
  await admin.query(`insert into private.learning_distribution_intents(request_id,actor_id,session_id,course_id,item_id,plan,source_payload,source_revision,preview_digest,preview,created_at,expires_at)
    select $1,actor_id,session_id,course_id,item_id,plan,source_payload,source_revision,$3,
      preview||jsonb_build_object('requestId',$1::uuid,'previewDigest',$3::text,'createdAt',$4::timestamptz-interval '5 minutes','expiresAt',$4::timestamptz),
      $4::timestamptz-interval '5 minutes',$4::timestamptz from private.learning_distribution_intents where request_id=$2`,[expiringId,thirdReview.requestId,'9'.repeat(64),expiry]);
  const lock=await admin.connect();await lock.query('begin');await lock.query('select 1 from hub.content_items where id=$1 for update',[course.item]);
  try{
    const queued=run({operation:'commit',requestId:expiringId,expectedDigest:'9'.repeat(64)});let blocked=false;
    for(let n=0;n<80&&!blocked;n++){blocked=(await admin.query("select exists(select 1 from pg_stat_activity where usename='hub_app_server' and wait_event_type='Lock' and query like 'select private.commit_course_distribution%') as blocked")).rows[0].blocked;if(!blocked)await new Promise(resolve=>setTimeout(resolve,25));}
    assert.equal(blocked,true,'commit reached the held catalog lock before review expiry');
    await new Promise(resolve=>setTimeout(resolve,Math.max(0,Date.parse(expiry)-Date.now()+100)));await lock.query('rollback');
    assert.equal((await queued).status,409,'queued review cannot publish after expiry');
    assert.equal((await admin.query('select result from private.learning_distribution_intents where request_id=$1',[expiringId])).rows[0].result,null);
  }finally{await lock.query('rollback');lock.release();}
  let entered,release;const enteredPromise=new Promise(resolve=>{entered=resolve;}),wait=new Promise(resolve=>{release=resolve;});holdHuman={started:entered,wait};
  const older=run(commit(thirdReview));await enteredPromise;const winner=ok(await run(commit(thirdReview)));release();assert.equal((await older).status,409,'superseded native response cannot change catalog');
  assert.deepEqual(ok(await run({operation:'resume',requestId:thirdReview.requestId})).result,winner.result);
  const afterWinner=await load(course.id),revokedReview=ok(await run(preview(afterWinner,{confirmReplacement:true})));
  revokeAfterRead=true;assert.equal((await run(commit(revokedReview))).status,401);await admin.query('update private.staff_permissions set revoked_at=null where user_id=$1',[owner]);
  assert.equal((await admin.query('select result from private.learning_distribution_intents where request_id=$1',[revokedReview.requestId])).rows[0].result,null);
  nativeAllowed=false;assert.equal((await run({operation:'resume',requestId:thirdReview.requestId})).status,403);nativeAllowed=true;
  const originalToken=jar[sessionCookie],freshToken=token();await admin.query("insert into private.sms_sessions(id,token_hash,user_id,identity_version,expires_at) select $1,$2,user_id,identity_version,now()+interval '1 hour' from private.sms_identities where user_id=$3",[randomUUID(),digest(freshToken),owner]);
  jar[sessionCookie]=freshToken;assert.equal((await run(commit(revokedReview))).status,403);const resumedContext=await load(course.id);assert.ok(resumedContext.requests.length>0);assert.ok(resumedContext.requests.every(row=>!row.canCommitThisSession));
  assert.deepEqual(ok(await run({operation:'resume',requestId:thirdReview.requestId})).result,winner.result,'fresh same-actor session can read original history without applying');jar[sessionCookie]=originalToken;
  // Worker observations use exact course IDs and a lease, not array positions.
  const batchCourse=await registered();const batchReview=ok(await run(preview(await load(batchCourse.id))));const batchSuccess=ok(await run(commit(batchReview)));
  await admin.query("update private.learning_distribution_observations set attempted_at=now()-interval '6 minutes' where course_id=any($1::uuid[])",[[course.id,batchCourse.id]]);
  const lease=(await observerQuery(pool,'select private.claim_distribution_status_batch() as value',[])).rows[0].value;assert.equal(lease.courseIds.length,2);
  const claimedNonce=await withSession(pool,originalToken,async db=>{await db.query('reset role');return (await db.query('select private.claim_course_distribution_observation($1) as value',[course.id])).rows[0].value;});assert.ok(claimedNonce);
  await assert.rejects(observerQuery(pool,'select private.record_distribution_status_batch($1,$2,$3::jsonb)',[lease.leaseId,new Date().toISOString(),JSON.stringify(lease.courseIds.map(status).reverse())]),error=>error.code==='40001');
  await observerQuery(pool,'select private.release_distribution_status_batch($1)',[lease.leaseId]);
  sources.delete(batchCourse.id);const gone=await load(batchCourse.id);assert.equal(gone.native,null);assert.deepEqual(ok(await run({operation:'resume',requestId:batchReview.requestId})).result,batchSuccess.result);
  await admin.query("update private.learning_distribution_observations set attempted_at=now()-interval '6 minutes',lease_id=null,lease_until=null where course_id=$1",[batchCourse.id]);await observer.tick();assert.equal((await visible(batchSuccess.result.revisionId)).length,0,'missing source tombstone withholds publication');
  await admin.query('update private.sms_sessions set revoked_at=now() where token_hash=$1',[digest(originalToken)]);assert.equal((await run({operation:'context',courseId:course.id})).status,401);
  await admin.query("update private.learning_distribution_observations set attempted_at=now()-interval '6 minutes' where managed");await observer.tick();
  assert.equal((await admin.query('select count(*) from private.learning_distribution_revisions where item_id=$1',[course.item])).rows[0].count,'3');
  console.log('Distribution PostgreSQL/SMS/HTTP passed: exact published source, two-app shared catalog, immutable revisions, source-head preservation, replacement/retirement, retries, rollback, concurrent observation, current authority, machine freshness and legacy opt-in.');
}finally{await new Promise(resolve=>server.close(resolve));await pool.end();await admin.end();}
