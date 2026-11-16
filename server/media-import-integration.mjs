// Bulk lesson-media import against actual disposable PostgreSQL, local Supabase Storage, HTTP and SMS sessions.
// The app-media Edge Function is emulated exactly: it consumes the one-use media capability, then writes the
// private hub-learning bucket with x-upsert false. Only the HeyGen source is a synthetic fixture.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import pg from 'pg';
import { smsAuth } from './sms-auth.mjs';
import { gateway } from './gateway.mjs';
import { delegations } from './delegations.mjs';
import { appServer } from './http.mjs';
import { learningMediaImport } from './learning-media-import.mjs';
import { learningSourceId } from '../src/imports/pennsyncCourseImport.ts';
import { removeTestIdentities, testPhones } from './test-phones.mjs';

const database=new URL(process.env.HUB_TEST_DATABASE_URL);assert.equal(database.hostname,'127.0.0.1');assert.equal(database.port,'54322');
let config;
try{config=JSON.parse((await promisify(execFile)('npx',['supabase','status','--output','json'],{timeout:30000,maxBuffer:1000000})).stdout);}
catch{throw new Error('Could not inspect the disposable Supabase runtime');}
assert.ok(config.API_URL==='http://127.0.0.1:54321'&&config.DB_URL===database.href.replace(/\/$/,''),'CLI must identify the exact disposable project');
const storageApi=config.API_URL+'/storage/v1',serviceKey=config.SERVICE_ROLE_KEY;config=null;
const admin=new pg.Pool({connectionString:database.href});await admin.query("alter role hub_app_server login password 'ephemeral-test-only'");
const appUrl=new URL(database);appUrl.username='hub_app_server';appUrl.password='ephemeral-test-only';
const pool=new pg.Pool({connectionString:appUrl.href});
const editor=randomUUID(),learner=randomUUID(),run=randomBytes(4).toString('hex');
const phones=testPhones(import.meta.url);
await admin.query("insert into auth.users(id,email,is_anonymous) values($1,$3,false),($2,$4,false)",[editor,learner,`media-import-${run}@test.invalid`,`media-learner-${run}@test.invalid`]);
// Shared-course editing is the platform administrator's (20261015130000); content permission alone is refused.
await admin.query("insert into private.staff_permissions(user_id,permission) values($1,'platform.admin'),($2,'content.write')",[editor,learner]);
await admin.query('insert into private.sms_identities(user_id,phone_e164) values($1,$2),($3,$4)',[editor,phones.editor,learner,phones.learner]);
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const mp4=label=>Buffer.concat([Buffer.from([0,0,0,24]),Buffer.from('ftypisom'),Buffer.from([0,0,2,0]),Buffer.from('isommp41'),randomBytes(4096),Buffer.from(label)]);
const captions='WEBVTT\n\n00:00.000 --> 00:01.500\nWelcome to the lesson.\n',transcript='Welcome to the lesson.\n';

// Synthetic HeyGen asset host.
const sources=new Map();let sourceFetches=0;
const heygen=async url=>{sourceFetches++;const bytes=sources.get(url);
  return bytes?new Response(bytes,{status:200,headers:{'Content-Type':'video/mp4','Content-Length':String(bytes.length)}}):new Response('missing',{status:404});};
// app-media, exactly: consume the capability for the 'media' audience, then the private bucket with no upsert.
const stored=new Set();let tamper=null,duplicates=0;
const caps=delegations({pool,storageUrl:'https://storage.test',fetchImpl:async(url,options)=>{
  assert.equal(url,'https://storage.test/functions/v1/app-media');assert.equal(options.redirect,'manual');
  const {path,operation}=await caps.consume(options.headers.Authorization.slice(7),'media');
  await assert.rejects(caps.consume(options.headers.Authorization.slice(7),'media'),/Invalid authorization/);
  const headers={apikey:serviceKey,Authorization:`Bearer ${serviceKey}`};
  if(operation==='upload'){
    const response=await fetch(`${storageApi}/object/hub-learning/${path}`,{method:'POST',headers:{...headers,'Content-Type':options.headers['Content-Type'],'x-upsert':'false'},
      body:options.body,duplex:'half',redirect:'manual'});
    await response.body?.cancel();
    if(response.ok){stored.add(path);return Response.json({uploaded:true});}
    // Exactly app-media's mapping: Storage's 400 "Duplicate" answer reaches the Hub as 503.
    duplicates++;return Response.json({error:'Upload failed'},{status:response.status===409?409:503});
  }
  assert.equal(operation,'download');
  const response=await fetch(`${storageApi}/object/authenticated/hub-learning/${path}`,{headers,redirect:'manual'});
  if(!response.ok)return Response.json({error:'Media unavailable'},{status:response.status===404?404:503});
  const bytes=Buffer.from(await response.arrayBuffer());
  return new Response(tamper&&path.endsWith(tamper)?Buffer.concat([bytes.subarray(0,-1),Buffer.from('!')]):bytes);
}});
const importer=learningMediaImport({pool,hosts:['resource2.heygen.ai'],fetchImpl:heygen,
  storage:{upload:(token,path,body,type)=>caps.media(token,path,'upload',body,type),download:(token,path)=>caps.media(token,path,'download')}});
const auth=smsAuth({pool,provider:{send:async()=>randomUUID(),verify:async(_id,_phone,code)=>code==='123456'}});
const server=appServer({auth,gateway:gateway(pool),delegations:caps,mediaImport:importer,origins:['https://hub.test']});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`;
let jar={};
const cookie=()=>Object.entries(jar).map(([k,v])=>`${k}=${v}`).join('; ');
async function call(path,body){
  const response=await fetch(origin+'/api/'+path,{method:'POST',headers:{Origin:'https://hub.test','Content-Type':'application/json',Cookie:cookie()},body:JSON.stringify(body)});
  for(const value of response.headers.getSetCookie()){const [pair]=value.split(';'),index=pair.indexOf('=');jar[pair.slice(0,index)]=pair.slice(index+1);}
  return {status:response.status,body:await response.json()};
}
async function login(phone){jar={};const challenge=await call('auth/sms/start',{phone});assert.equal(challenge.status,200);
  assert.equal((await call('auth/sms/verify',{challengeId:challenge.body.challengeId,code:'123456'})).status,200);}
const media=body=>call('admin/learning-media-import',body);
const manifestSha256=sha(Buffer.from(`synthetic manifest ${run}`));
const carebase=(await admin.query("select id from hub.products where slug='carebase'")).rows[0].id;
const moduleId=randomBytes(12).toString('hex'),unknownModule=randomBytes(12).toString('hex');
const pennsyncUnit=await learningSourceId('lesson',moduleId);
const draftDoc=(title,units)=>({title,summary:'Synthetic',overview:'',category:'Test',durationMinutes:10,accessLevel:'staff',productIds:[carebase],units:[...units,
  {id:randomUUID(),type:'quiz',title:'Post-test',body:'',passingScore:80,maxAttempts:3,questions:[{id:randomUUID(),prompt:'Pick one',points:1,correctOptionId:'00000000-0000-4000-8000-000000000001',
    options:[{id:'00000000-0000-4000-8000-000000000001',text:'Yes'},{id:'00000000-0000-4000-8000-000000000002',text:'No'}]}]}]});
const row=(n,overrides={})=>({product:'carebase',courseTitle:'Fire safety for PCH',lessonTitle:`Lesson ${n}`,sourceRecord:randomUUID(),durationSeconds:2,
  mp4Url:`https://resource2.heygen.ai/${run}/${n}.mp4`,posterUrl:null,captionsFile:`${n}.vtt`,transcriptFile:`${n}.txt`,heygenVideoId:`r${run}${n}`,...overrides});
const stage=(r,extra={})=>media({operation:'stage',manifestSha256,row:r,captions,transcript,...extra});
const draftOf=async itemId=>(await admin.query('select draft,draft_version from private.learning_courses where item_id=$1',[itemId])).rows[0];
// A lesson video sent in parts (server/upload-parts.mjs), as the library's upload form sends it.
const lessonVideo=mp4(`parts ${run}`),lessonPath=`learning/${randomUUID()}/video.mp4`;
async function sendPart(offset,bytes){
  const response=await fetch(`${origin}/api/media/${lessonPath}`,{method:'POST',body:bytes,headers:{Origin:'https://hub.test','Content-Type':'video/mp4',Cookie:cookie(),
    'Upload-Offset':String(offset),'Upload-Length':String(lessonVideo.length)}});
  return {status:response.status,body:await response.json()};
}
try{
  assert.equal((await media({operation:'list'})).status,401,'signed-out callers are refused');
  assert.equal((await sendPart(0,lessonVideo.subarray(0,2048))).status,401,'a signed-out caller cannot start an upload in parts');
  await login(phones.learner);
  assert.equal((await media({operation:'list'})).status,403,'a content writer without shared-course editor authority is refused');
  await login(phones.editor);
  assert.equal((await media({operation:'list'})).status,200);
  assert.deepEqual(await sendPart(0,lessonVideo.subarray(0,2048)),{status:202,body:{received:2048}});
  assert.deepEqual(await sendPart(0,lessonVideo.subarray(0,2048)),{status:202,body:{received:2048}},'a repeated part is not written twice');
  assert.equal(stored.has(lessonPath),false,'nothing is stored before the whole file has arrived');
  assert.deepEqual(await sendPart(2048,lessonVideo.subarray(2048)),{status:200,body:{uploaded:true}});
  const lessonCopy=await fetch(`${origin}/api/media/${lessonPath}`,{headers:{Cookie:cookie()}});
  assert.equal(lessonCopy.status,200);assert.equal(sha(Buffer.from(await lessonCopy.arrayBuffer())),sha(lessonVideo),'Storage holds exactly the file sent in parts');

  // Two drafts: a Hub course naming its video lesson by title, and a PennSync-converted course whose lesson id comes from its module.
  const named=await call('rpc/save_learning_draft',{p_item_id:randomUUID(),p_expected_version:0,p_document:draftDoc('Fire safety for PCH',[
    {id:randomUUID(),type:'text',title:'Before you begin',body:'Read this.'},{id:randomUUID(),type:'video',title:'Lesson 1',body:transcript,mediaAssetId:null}])});
  assert.equal(named.status,200,JSON.stringify(named));
  const converted=await call('rpc/save_learning_draft',{p_item_id:randomUUID(),p_expected_version:0,p_document:draftDoc('Infection control',[
    {id:pennsyncUnit,type:'video',title:'Hand hygiene',body:transcript,mediaAssetId:null}])});
  assert.equal(converted.status,200,JSON.stringify(converted));
  const namedRow=row(1,{sourceRecord:named.body.itemId});
  const pennsyncRow=row(2,{product:'pennsync',sourceRecord:moduleId,lessonTitle:'Hand hygiene',courseTitle:'Infection control'});
  const unmappedRow=row(3,{product:'pennsync',sourceRecord:unknownModule});
  const failingRow=row(4),tamperedRow=row(5);
  for(const [n,r] of [[1,namedRow],[2,pennsyncRow],[3,unmappedRow],[5,tamperedRow]])sources.set(r.mp4Url,mp4(`video ${n}`));

  // Host allowlisting: refused before anything is recorded or fetched.
  const before=sourceFetches;
  const refused=await stage(row(9,{mp4Url:'https://videos.example.com/9.mp4'}));
  assert.equal(refused.status,422);assert.equal(refused.body.error.code,'host_not_allowed');assert.equal(sourceFetches,before);
  assert.equal((await admin.query('select count(*)::int as n from private.learning_media_imports where heygen_video_id=$1',[`r${run}9`])).rows[0].n,0);

  // Partial failure: each row stands alone.
  const results=[];
  for(const r of [namedRow,pennsyncRow,failingRow,unmappedRow])results.push(await stage(r));
  assert.deepEqual(results.map(r=>r.status),[200,200,200,200],JSON.stringify(results));
  assert.deepEqual(results.map(r=>[r.body.item.state,r.body.item.failureCode]),[['staged',null],['staged',null],['failed','source_unavailable'],['staged',null]]);
  assert.deepEqual(results.map(r=>r.body.item.target.state),['ready','ready','missing_draft','missing_draft']);
  assert.equal(results[0].body.item.target.unitId,named.body.document.units[1].id);
  assert.equal(results[1].body.item.target.unitId,pennsyncUnit,'a PennSync module id maps to the converted lesson id');
  const staged=results[0].body.item;
  assert.equal(staged.sourceSha256,sha(sources.get(namedRow.mp4Url)));
  for(const name of ['video.mp4','captions.vtt','transcript.txt'])assert.ok(stored.has(`learning/${staged.mediaId}/${name}`));

  // Hash mismatch: the stored copy differs from the source, so the row fails and nothing stages.
  tamper='video.mp4';const mismatch=await stage(tamperedRow);tamper=null;
  assert.equal(mismatch.status,200);assert.equal(mismatch.body.item.state,'failed');assert.equal(mismatch.body.item.failureCode,'hash_mismatch');
  assert.equal((await media({operation:'register',mediaId:mismatch.body.item.mediaId,reviewed:true})).status,409,'a failed row cannot be approved');
  // Retry with an honest store: the same bytes reuse the same prefix; the bucket's no-upsert answer is verified, not trusted.
  const refusedBefore=duplicates;const retried=await stage(tamperedRow);
  assert.equal(retried.body.item.state,'staged');assert.equal(retried.body.item.mediaId,mismatch.body.item.mediaId);assert.equal(retried.body.item.attempts,2);
  assert.equal(duplicates-refusedBefore,3,'every upload of the retry met an existing object and was refused as app-media refuses it');

  // Retry identity: identical content is not fetched or stored again.
  const fetches=sourceFetches,objects=stored.size;
  const replay=await stage(namedRow);
  assert.equal(replay.status,200);assert.equal(replay.body.replayed,true);assert.equal(replay.body.item.mediaId,staged.mediaId);
  assert.equal(sourceFetches,fetches);assert.equal(stored.size,objects);
  // A failed source can be retried in place once available.
  sources.set(failingRow.mp4Url,mp4('video 4'));
  const recovered=await stage(failingRow);assert.equal(recovered.body.item.state,'staged');assert.equal(recovered.body.item.attempts,2);

  // Nothing is approved, attached or published by staging.
  assert.equal((await admin.query('select count(*)::int as n from private.learning_media where id=$1',[staged.mediaId])).rows[0].n,0);
  assert.equal((await draftOf(named.body.itemId)).draft.units[1].mediaAssetId,null);

  // Approval uses register_learning_media with the server-verified checksum, then attaches through the draft save.
  assert.equal((await media({operation:'register',mediaId:staged.mediaId,reviewed:false})).status,400);
  const approved=await media({operation:'register',mediaId:staged.mediaId,reviewed:true});
  assert.equal(approved.status,200,JSON.stringify(approved));assert.equal(approved.body.item.state,'registered');assert.equal(approved.body.item.target.state,'attached');
  const registered=(await admin.query('select title,sha256,uploaded_by from private.learning_media where id=$1',[staged.mediaId])).rows[0];
  assert.deepEqual(registered,{title:'Lesson 1',sha256:staged.sourceSha256,uploaded_by:editor});
  const attachedDraft=await draftOf(named.body.itemId);
  assert.equal(attachedDraft.draft.units[1].mediaAssetId,staged.mediaId);assert.equal(attachedDraft.draft_version,2);
  assert.equal(attachedDraft.draft.units[1].body,transcript,'attaching changes only the media reference');
  const audit=(await admin.query("select action from private.audit_events where actor_id=$1 and action like 'learning.media%' order by id",[editor])).rows.map(r=>r.action);
  for(const action of ['learning.media.import.staged','learning.media.import.failed','learning.media.approved','learning.media.import.registered','learning.media.import.attached'])
    assert.ok(audit.includes(action),`audit records ${action}`);
  const again=await media({operation:'register',mediaId:staged.mediaId,reviewed:true});
  assert.equal(again.body.replayed,true);assert.equal((await draftOf(named.body.itemId)).draft_version,2,'a repeated approval does not save the draft again');
  // Approved media is immutable: identical content replays, changed content is refused.
  assert.equal((await stage(namedRow)).body.replayed,true);
  const changed=await stage(namedRow,{captions:captions.replace('Welcome','Hello')});
  assert.equal(changed.status,409);

  // A draft edited between staging and approval keeps its edit: the lesson already has another video.
  const pennsyncItem=results[1].body.item,other=retried.body.item;
  const occupiedDraft=await draftOf(converted.body.itemId);occupiedDraft.draft.units[0].mediaAssetId=staged.mediaId;
  assert.equal((await call('rpc/save_learning_draft',{p_item_id:converted.body.itemId,p_expected_version:occupiedDraft.draft_version,p_document:occupiedDraft.draft})).status,200);
  const occupied=await media({operation:'register',mediaId:pennsyncItem.mediaId,reviewed:true});
  assert.equal(occupied.body.item.state,'registered');assert.equal(occupied.body.item.target.state,'occupied');
  assert.equal((await draftOf(converted.body.itemId)).draft.units[0].mediaAssetId,staged.mediaId);
  // A save that lands while approval is attaching is never overwritten: attachment decides from the locked draft.
  const racedDraft=await call('rpc/save_learning_draft',{p_item_id:randomUUID(),p_expected_version:0,p_document:draftDoc('Emergency preparedness',[
    {id:randomUUID(),type:'video',title:'Lesson 6',body:transcript,mediaAssetId:null}])});
  assert.equal(racedDraft.status,200,JSON.stringify(racedDraft));
  const racedRow=row(6,{sourceRecord:racedDraft.body.itemId});sources.set(racedRow.mp4Url,mp4('video 6'));
  const racedItem=(await stage(racedRow)).body.item;assert.equal(racedItem.target.state,'ready');
  const holder=await admin.connect();
  try{
    await holder.query('begin');
    await holder.query('select 1 from private.learning_courses where item_id=$1 for update',[racedDraft.body.itemId]);
    const approving=media({operation:'register',mediaId:racedItem.mediaId,reviewed:true});
    await new Promise(resolve=>setTimeout(resolve,750));
    await holder.query("update private.learning_courses set draft=jsonb_set(draft,'{units,0,mediaAssetId}',to_jsonb($2::text)),draft_version=draft_version+1 where item_id=$1",
      [racedDraft.body.itemId,staged.mediaId]);
    await holder.query('commit');
    const raced=await approving;
    assert.equal(raced.status,200,JSON.stringify(raced));assert.equal(raced.body.item.state,'registered');assert.equal(raced.body.item.target.state,'occupied');
    const kept=await draftOf(racedDraft.body.itemId);
    assert.equal(kept.draft.units[0].mediaAssetId,staged.mediaId,'the concurrent save keeps its video');assert.equal(kept.draft_version,2);
  }finally{await holder.query('rollback').catch(()=>{});holder.release();}
  // An approved row with no draft yet stays unattached until the draft exists.
  const unmapped=await media({operation:'register',mediaId:results[3].body.item.mediaId,reviewed:true});
  assert.equal(unmapped.body.item.target.state,'missing_draft');
  assert.equal((await media({operation:'attach',mediaId:other.mediaId})).status,409,'only an approved video can be attached');

  const listed=await media({operation:'list'});
  const mine=listed.body.items.filter(item=>item.heygenVideoId.startsWith(`r${run}`));
  assert.deepEqual(mine.map(item=>item.state).sort(),['registered','registered','registered','registered','staged','staged']);
  assert.equal((await admin.query("select count(*)::int as n from hub.content_items where id = any($1::uuid[]) and status='published'",[[named.body.itemId,converted.body.itemId,racedDraft.body.itemId]])).rows[0].n,0,'nothing publishes');

  // The editor's permission is rechecked on every call.
  await admin.query('update private.staff_permissions set revoked_at=now() where user_id=$1',[editor]);
  assert.equal((await media({operation:'register',mediaId:other.mediaId,reviewed:true})).status,403);
  console.log('Media import actual PostgreSQL/Storage/SMS/HTTP passed: host allowlist, partial failure, hash mismatch, retry identity, reviewed approval, guarded attach, no publication.');
}finally{
  await new Promise(resolve=>server.close(resolve));
  for(const path of stored)await fetch(`${storageApi}/object/hub-learning/${path}`,{method:'DELETE',headers:{apikey:serviceKey,Authorization:`Bearer ${serviceKey}`}}).catch(()=>{});
  await removeTestIdentities(admin,[editor,learner],{also:['update private.learning_courses set updated_by = null where updated_by = any($1::uuid[])','delete from private.learning_media_imports where created_by = any($1::uuid[]) or updated_by = any($1::uuid[]) or registered_by = any($1::uuid[])','delete from private.learning_media where uploaded_by = any($1::uuid[])']});
  await pool.end();await admin.end();
}
