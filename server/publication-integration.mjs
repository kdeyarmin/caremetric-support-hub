// Real PostgreSQL + SMS HTTP + Edge handler; only external Storage is synthetic.
// This file refuses every non-local database target.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {smsAuth,sessionCookie,digest,token,withSession} from './sms-auth.mjs';
import {gateway} from './gateway.mjs';
import {delegations} from './delegations.mjs';
import {publications} from './publications.mjs';
import {appServer} from './http.mjs';
import {fixtureManifest,articleBytes,videoBytes,captionBytes,transcriptBytes} from '../src/imports/publicationFixtures.ts';
import {publicationConfirmationIds,publicationPartRules} from '../src/imports/publicationProtocol.ts';
import {createPublicationMediaHandler} from '../supabase/functions/publication-media/handler.ts';
const databaseUrl=process.env.HUB_TEST_DATABASE_URL;
const target=new URL(databaseUrl); assert.equal(target.hostname,'127.0.0.1'); assert.equal(target.port,'54322');
const admin=new pg.Pool({connectionString:databaseUrl});
await admin.query("alter role hub_app_server login password 'ephemeral-test-only'");
const appUrl=new URL(databaseUrl); appUrl.username='hub_app_server'; appUrl.password='ephemeral-test-only';
const pool=new pg.Pool({connectionString:appUrl.href});
const owner=randomUUID(),scoped=randomUUID(),learner=randomUUID();
await admin.query(`insert into auth.users(id,email,raw_user_meta_data,is_anonymous) values
  ($1,'publication-owner@test.invalid','{"display_name":"Publication owner"}',false),
  ($2,'publication-scoped@test.invalid','{"display_name":"Publication editor"}',false),
  ($3,'publication-learner@test.invalid','{"display_name":"Publication learner"}',false)`,[owner,scoped,learner]);
const products=(await admin.query("select id,slug from hub.products where slug in ('carebase','breathe')")).rows;
const carebase=products.find(p=>p.slug==='carebase').id;
await admin.query("insert into private.staff_permissions(user_id,permission,product_id) values($1,'platform.admin',null),($2,'content.write',$3)",[owner,scoped,carebase]);
await admin.query("insert into private.sms_identities(user_id,phone_e164) values($1,'+12025550181'),($2,'+12025550182'),($3,'+12025550183')",[owner,scoped,learner]);
const provider={send:async()=>randomUUID(),verify:async(_id,_phone,code)=>code==='123456'};
const auth=smsAuth({pool,provider}), api=gateway(pool), objects=new Map();
let baseUrl,storageWrites=0,lastCapability,loseUploadResponse=false;
const edge=createPublicationMediaHandler({serviceKey:'synthetic-storage-only',fetchImpl:async(url,options)=>{
  if(url.startsWith('https://support-hub-web-production.up.railway.app/api/internal/publications/')) {
    return fetch(baseUrl+new URL(url).pathname,options);
  }
  const base='https://xgauehtwksmnoqhgqegm.supabase.co/storage/v1/object/';
  assert.ok(url.startsWith(base),'only fixed Hub authority or Storage may be called');
  const headers=new Headers(options.headers);
  assert.equal(headers.get('Authorization'),'Bearer synthetic-storage-only');
  assert.equal(options.redirect,'error');
  if(options.method==='DELETE') {
    assert.equal(url,base+'hub-publications');
    for(const path of JSON.parse(options.body).prefixes) objects.delete(path);
    return Response.json([]);
  }
  if(options.method==='POST') {
    const path=url.slice((base+'hub-publications/').length); assert.equal(headers.get('x-upsert'),'false');
    if(objects.has(path)) return new Response('{}',{status:409});
    const bytes=new Uint8Array(await new Response(options.body).arrayBuffer());
    objects.set(path,{bytes,type:headers.get('Content-Type')}); storageWrites++;
    return Response.json({Key:path});
  }
  const path=url.slice((base+'authenticated/hub-publications/').length); const object=objects.get(path);
  if(!object) return new Response('{}',{status:404});
  let bytes=object.bytes,status=200; const responseHeaders={'Content-Type':object.type};
  if(headers.has('Range')) {
    const [,start,end]=/^bytes=(\d+)-(\d+)$/.exec(headers.get('Range')); status=206;
    bytes=bytes.slice(Number(start),Number(end)+1); responseHeaders['Content-Range']=`bytes ${start}-${end}/${object.bytes.length}`;
  }
  responseHeaders['Content-Length']=String(bytes.length); return new Response(bytes,{status,headers:responseHeaders});
}});
const nativeFetch=async(url,options)=>{
  assert.equal(url,'https://xgauehtwksmnoqhgqegm.supabase.co/functions/v1/publication-media');
  lastCapability=options.headers.Authorization;
  const response=await edge(new Request(url,{...options,duplex:'half'}));
  if(loseUploadResponse && response.ok) { loseUploadResponse=false; throw new Error('Synthetic lost upload response'); }
  return response;
};
const caps=delegations({pool,storageUrl:'https://xgauehtwksmnoqhgqegm.supabase.co',fetchImpl:nativeFetch});
const service=publications({pool,delegations:caps,storageUrl:'https://xgauehtwksmnoqhgqegm.supabase.co',fetchImpl:nativeFetch});
const server=appServer({auth,gateway:api,delegations:caps,publications:service,origins:['https://hub.test']});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve)); baseUrl=`http://127.0.0.1:${server.address().port}`;
let jar={};
async function call(path,body,extra={},method=body===undefined?'GET':'POST') {
  const response=await fetch(baseUrl+'/api/'+path,{method,headers:{Origin:'https://hub.test','Content-Type':'application/json',Cookie:Object.entries(jar).map(([key,value])=>`${key}=${value}`).join('; '),...extra},body:body===undefined?undefined:JSON.stringify(body)});
  for(const value of response.headers.getSetCookie()) { const [pair]=value.split(';'); const i=pair.indexOf('='); jar[pair.slice(0,i)]=pair.slice(i+1); }
  return {status:response.status,body:method==='HEAD'?null:await response.json(),response};
}
async function login(phone) {
  jar={}; const started=await call('auth/sms/start',{phone}); assert.equal(started.status,200);
  assert.equal((await call('auth/sms/verify',{challengeId:started.body.challengeId,code:'123456'})).status,200);
  return {...jar};
}
async function upload(stage,bytes,part='primary') {
  const response=await fetch(`${baseUrl}/api/publications/imports/${stage.id}/assets/${part}`,{method:'POST',headers:{Origin:'https://hub.test','Content-Type':publicationPartRules(stage.manifest,part).contentType,Cookie:`${sessionCookie}=${jar[sessionCookie]}`},body:bytes});
  return {status:response.status,body:await response.json()};
}
async function stage(manifest) {
  const result=await call('publications/imports/stage',{manifest,sourceReviewConfirmed:true}); assert.equal(result.status,200,JSON.stringify(result.body)); return result.body;
}
async function prepared(manifest,bytes=articleBytes) {
  const value=await stage(manifest); const uploaded=await upload(value,bytes); assert.equal(uploaded.status,200,JSON.stringify(uploaded.body));
  if(manifest.content.kind==='video') {
    assert.equal((await upload(value,captionBytes,'captions')).status,200);
    assert.equal((await upload(value,transcriptBytes,'transcript')).status,200);
  }
  const preview=await call(`publications/imports/${value.id}/preview`,{}); assert.equal(preview.status,200,JSON.stringify(preview.body)); return preview.body;
}
const request=stage=>({planIdentity:stage.plan.planIdentity,idempotencyKey:randomUUID(),confirmedActions:publicationConfirmationIds(stage.plan),reviewConfirmed:true});
async function expireUncommitted() {
  await admin.query("update private.publication_imports set created_at=now()-interval '2 hours',expires_at=now()-interval '1 hour' where receipt is null and actor_id=$1",[owner]);
}
try {
  assert.equal((await call('publications/access')).status,401);
  const ownerJar=await login('+12025550181');
  assert.deepEqual((await call('publications/access')).body,{canImport:true,maxVideoBytes:26214400});
  const manifest=await fixtureManifest(); manifest.source.content_key='integration-guide';
  assert.equal((await call('publications/imports/stage',{manifest,sourceReviewConfirmed:true},{Origin:'https://evil.test'})).status,403);
  assert.equal((await call('publications/imports/stage',{manifest,sourceReviewConfirmed:true,role:'platform_admin'})).status,400);
  assert.equal((await call('rpc/commit_publication_import',{})).status,400);
  await assert.rejects(pool.query('select * from private.publication_import_assets'),/permission denied/);
  const first=await stage(manifest);
  assert.equal((await upload(first,new Uint8Array(articleBytes.length))).status,422); assert.equal(storageWrites,0);
  loseUploadResponse=true;
  assert.equal((await upload(first,articleBytes)).status,503,'a lost transfer response does not attest SQL verification');
  assert.equal((await admin.query("select verified_at from private.publication_import_assets where import_id=$1 and part='primary'",[first.id])).rows[0].verified_at,null);
  assert.ok(objects.has(`publications/${first.id}/primary`),'the immutable object survived the lost response');
  assert.equal((await upload(first,articleBytes)).status,200);
  assert.equal(storageWrites,1,'retry hashes the original immutable object without a replacement write');
  assert.equal((await caps.consume(lastCapability.slice(7),'publication').then(()=>200,()=>401)),401,'consumed upload capability cannot be reused');
  assert.equal((await admin.query('select count(*) from hub.content_items where content_key=$1',[manifest.source.content_key])).rows[0].count,'0','staging never publishes');
  assert.equal((await call(`publications/media/${first.id}`)).status,404,'a staged import ID cannot read media');
  const preview=await call(`publications/imports/${first.id}/preview`,{}); assert.equal(preview.status,200,JSON.stringify(preview.body));
  const commit=request(preview.body);
  const results=await Promise.all([call(`publications/imports/${first.id}/commit`,commit),call(`publications/imports/${first.id}/commit`,commit)]);
  assert.equal(results[0].status,200,JSON.stringify(results[0].body)); assert.deepEqual(results[0].body,results[1].body,'concurrent identical commits return one receipt');
  const receipt=results[0].body;
  assert.equal((await call(`publications/imports/${first.id}/commit`,{...commit,idempotencyKey:randomUUID()})).status,409);
  assert.equal((await admin.query('select count(*) from hub.content_revisions where item_id=$1',[receipt.itemId])).rows[0].count,'1');
  assert.equal((await call('rpc/list_published_content',{})).body.find(item=>item.id===receipt.revisionId).body_markdown,new TextDecoder().decode(articleBytes));
  await assert.rejects(admin.query("update hub.content_revisions set title='Changed source' where id=$1",[receipt.revisionId]),/immutable/);
  const moved=structuredClone(manifest); moved.placements=[{product_slug:'breathe',audience:['all'],route_pattern:null}];
  const placement=await prepared(moved); assert.ok(placement.plan.actions.some(action=>action.type==='retire_preview'));
  const placementCommit=request(placement);
  assert.equal((await call(`publications/imports/${placement.id}/commit`,{...placementCommit,confirmedActions:[]})).status,400);
  assert.equal((await call(`publications/imports/${placement.id}/commit`,placementCommit)).status,200);
  assert.equal((await admin.query('select count(*) from hub.content_revisions where item_id=$1',[receipt.itemId])).rows[0].count,'1','placement change reuses immutable revision');
  const changed=structuredClone(moved); changed.content.title='Changed workspace title';
  const changedStage=await stage(changed); assert.equal((await upload(changedStage,articleBytes)).status,200);
  assert.equal((await call(`publications/imports/${changedStage.id}/preview`,{})).status,422,'same source version cannot change content');
  await expireUncommitted();
  const next=structuredClone(moved); next.source.version='docstudio-v2'; next.content.title='Updated workspace guide';
  const a=await prepared(next),b=await prepared(next);
  assert.equal((await call(`publications/imports/${a.id}/commit`,request(a))).status,200);
  assert.equal((await call(`publications/imports/${b.id}/commit`,request(b))).status,409,'stale peer preview cannot overwrite the catalog');
  const third=structuredClone(next); third.source.version='docstudio-v3';
  const revocation=await prepared(third);
  await admin.query('update private.staff_permissions set revoked_at=now() where user_id=$1',[owner]);
  assert.equal((await call(`publications/imports/${revocation.id}/commit`,request(revocation))).status,403);
  assert.equal((await call(`publications/imports/${first.id}/commit`,commit)).status,403,'current permission is required even for a receipt replay');
  await admin.query('update private.staff_permissions set revoked_at=null where user_id=$1',[owner]);
  await expireUncommitted();
  const video=await fixtureManifest('video'); video.source.content_key='integration-video';
  const videoStage=await prepared(video,videoBytes); const videoResult=await call(`publications/imports/${videoStage.id}/commit`,request(videoStage)); assert.equal(videoResult.status,200,JSON.stringify(videoResult.body));
  const videoId=videoResult.body.revisionId;
  assert.deepEqual((await call(`publications/media/${videoId}`)).body,{contentType:'video/mp4',hasCaptions:true,hasTranscript:true});
  const mediaPath=`${baseUrl}/api/publications/media/${videoId}/primary`;
  const mediaHeaders={Cookie:`${sessionCookie}=${jar[sessionCookie]}`};
  for(const range of ['bytes=1-3','bytes=-3','bytes=21-']) {
    const response=await fetch(mediaPath,{headers:{...mediaHeaders,Range:range}}); assert.equal(response.status,206); assert.equal((await response.arrayBuffer()).byteLength,3);
  }
  const head=await fetch(mediaPath,{method:'HEAD',headers:mediaHeaders}); assert.equal(head.status,200); assert.equal(head.headers.get('Content-Length'),'24');
  assert.equal((await fetch(mediaPath,{headers:{...mediaHeaders,Range:'bytes=0-1,4-5'}})).status,416);
  jar=await login('+12025550182');
  assert.equal((await call('publications/imports/stage',{manifest:third,sourceReviewConfirmed:true})).status,403,'product editor cannot retire another product placement');
  jar=await login('+12025550183');
  const learnerJar={...jar};
  assert.equal((await call('publications/access')).status,403);
  assert.equal((await fetch(mediaPath,{headers:{Cookie:`${sessionCookie}=${jar[sessionCookie]}`,Range:'bytes=0-1'}})).status,403,'staff video is private to authorized viewers');
  assert.equal((await fetch(mediaPath)).status,403,'anonymous caller cannot read a staff video');
  assert.equal((await fetch(`${baseUrl}/api/publications/media/${videoStage.id}/primary`)).status,404,'public download cannot use a staging identifier');
  jar=ownerJar;
  const publicVideo=structuredClone(video); publicVideo.source.content_key='integration-public-video'; publicVideo.content.access_level='public';
  const publicStage=await prepared(publicVideo,videoBytes); const publicResult=await call(`publications/imports/${publicStage.id}/commit`,request(publicStage));
  assert.equal(publicResult.status,200,JSON.stringify(publicResult.body));
  const publicId=publicResult.body.revisionId;
  const publicPath=`${baseUrl}/api/publications/media/${publicId}`;
  const publicInfo=await fetch(publicPath); assert.equal(publicInfo.status,200);
  assert.deepEqual(await publicInfo.json(),{contentType:'video/mp4',hasCaptions:true,hasTranscript:true});
  for(const [part,expected] of [['primary',videoBytes],['captions',captionBytes],['transcript',transcriptBytes]]) {
    const result=await fetch(`${publicPath}/${part}`); assert.equal(result.status,200); assert.deepEqual(new Uint8Array(await result.arrayBuffer()),expected);
  }
  for(const range of ['bytes=1-3','bytes=-3','bytes=21-']) {
    const result=await fetch(`${publicPath}/primary`,{headers:{Range:range}}); assert.equal(result.status,206); assert.equal((await result.arrayBuffer()).byteLength,3);
  }
  assert.equal((await fetch(`${publicPath}/primary`,{method:'HEAD'})).status,200);
  assert.equal((await fetch(`${publicPath}/primary`,{headers:{Range:'bytes=0-1,4-5'}})).status,416);
  const publicTicket=async(id=publicId)=>{
    const value='cmh_'+token();
    await pool.query('select private.issue_publication_public_download($1,$2,$3,$4)',[digest(value),id,'primary','bytes=0-1']);
    return value;
  };
  const consumePublic=value=>fetch(`${baseUrl}/api/internal/publications/public/authorize`,{method:'POST',headers:{Authorization:`Bearer ${value}`,'Content-Type':'application/json'},body:'{}'});
  const singleUse=await publicTicket(); assert.equal((await consumePublic(singleUse)).status,200); assert.equal((await consumePublic(singleUse)).status,401);
  const expired=await publicTicket(); await admin.query("update private.publication_public_downloads set expires_at=now()-interval '1 second' where token_hash=$1",[digest(expired)]);
  assert.equal((await consumePublic(expired)).status,401);
  await assert.rejects(publicTicket(videoId),/Public publication access denied/,'the public issuer cannot grant staff media');
  await assert.rejects(withSession(pool,ownerJar[sessionCookie],async db=>{
    await db.query('reset role');
    await db.query('select private.publication_public_object($1,$2)',[videoId,'primary']);
  }),/Public publication access denied/,'public policy strips even real staff authority');
  const retirement=await publicTicket();
  await admin.query("update hub.content_publications set expires_at=now()-interval '1 second' where revision_id=$1",[publicId]);
  assert.equal((await consumePublic(retirement)).status,403,'public policy rechecks a retirement after issue');
  assert.equal((await fetch(`${publicPath}/primary`,{method:'HEAD'})).status,403);
  await admin.query('update hub.content_publications set expires_at=null where revision_id=$1',[publicId]);
  const restriction=await publicTicket();
  await admin.query("update hub.content_items set access_level='customer' where id=$1",[publicResult.body.itemId]);
  assert.equal((await consumePublic(restriction)).status,403,'public policy rechecks an access restriction after issue');
  assert.equal((await fetch(publicPath)).status,403);
  await admin.query("update hub.content_items set access_level='public' where id=$1",[publicResult.body.itemId]);
  await admin.query("update hub.products set support_enabled=false where id=$1",[carebase]);
  assert.equal((await fetch(`${publicPath}/primary`,{method:'HEAD'})).status,403,'public media obeys current product support status');
  await admin.query('update hub.products set support_enabled=true where id=$1',[carebase]);
  const bomBytes=new Uint8Array(articleBytes.length+3); bomBytes.set([239,187,191]); bomBytes.set(articleBytes,3);
  const bomManifest=await fixtureManifest(); bomManifest.source.content_key='integration-bom'; bomManifest.artifact.byte_length=bomBytes.length; bomManifest.artifact.sha256=digest(bomBytes);
  const bomStage=await prepared(bomManifest,bomBytes); const bomResult=await call(`publications/imports/${bomStage.id}/commit`,request(bomStage));
  assert.equal(bomResult.status,200,JSON.stringify(bomResult.body));
  const storedArticle=(await admin.query('select body_markdown from hub.content_revisions where id=$1',[bomResult.body.revisionId])).rows[0].body_markdown;
  assert.deepEqual(new TextEncoder().encode(storedArticle),bomBytes,'SQL article preserves exact BOM bytes');
  const customerVideo=structuredClone(video); customerVideo.source.content_key='integration-customer-video'; customerVideo.content.access_level='customer';
  const customerStage=await prepared(customerVideo,videoBytes); const customerResult=await call(`publications/imports/${customerStage.id}/commit`,request(customerStage)); assert.equal(customerResult.status,200,JSON.stringify(customerResult.body));
  const tenant=randomUUID();
  await admin.query("insert into hub.tenants(id,slug,name) values($1,'publication-customer-fixture','Publication customer fixture')",[tenant]);
  await admin.query('insert into hub.tenant_products(tenant_id,product_id) values($1,$2)',[tenant,carebase]);
  await admin.query('insert into hub.tenant_product_memberships(tenant_id,product_id,user_id) values($1,$2,$3)',[tenant,carebase,learner]);
  const customerPath=`${baseUrl}/api/publications/media/${customerResult.body.revisionId}/primary`;
  assert.equal((await fetch(customerPath)).status,403,'public transport cannot read customer media');
  const learnerHeaders={Cookie:`${sessionCookie}=${learnerJar[sessionCookie]}`,Range:'bytes=0-1'};
  const allowedCustomer=await fetch(customerPath,{headers:learnerHeaders}); assert.equal(allowedCustomer.status,206); await allowedCustomer.arrayBuffer();
  await admin.query("update hub.tenant_products set status='suspended' where tenant_id=$1 and product_id=$2",[tenant,carebase]);
  assert.equal((await fetch(customerPath,{method:'HEAD',headers:learnerHeaders})).status,403,'revoked product entitlement denies the next media HEAD');
  await service.cleanupExpired();
  assert.equal((await admin.query('select count(*) from private.publication_imports where id=$1',[b.id])).rows[0].count,'0','expired unused stages are cleaned');
  assert.ok(objects.has(`publications/${videoStage.id}/primary`),'cleanup preserves published bytes');
  await admin.query('update private.sms_sessions set revoked_at=now() where token_hash=$1',[digest(jar[sessionCookie])]);
  assert.equal((await fetch(mediaPath,{method:'HEAD',headers:mediaHeaders})).status,401,'HEAD requires the current unrevoked session');
  console.log('Publication HTTP/PostgreSQL/Edge integration passed: actual SMS, immutable upload recovery and revision, concurrent/replayed commit, explicit placement retirement, stale preview, current product permission, public and private range/HEAD, actor-free public ticket replay/expiry/revocation, bounded cleanup, and session revocation.');
} finally { await new Promise(resolve=>server.close(resolve)); await pool.end(); await admin.end(); }
