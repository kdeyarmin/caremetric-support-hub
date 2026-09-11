// Real disposable PostgreSQL, app-owned SMS sessions, HTTP and the actual Edge
// handler. Only SMS delivery and external Storage transport are synthetic.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {smsAuth,sessionCookie,digest,token} from './sms-auth.mjs';
import {gateway} from './gateway.mjs';
import {delegations} from './delegations.mjs';
import {publications} from './publications.mjs';
import {docstudio} from './docstudio.mjs';
import {appServer} from './http.mjs';
import {createImmutableMediaHandler} from '../supabase/functions/publication-media/handler.ts';
import {renderSidecars} from './docstudio-render-contract.mjs';
import {PUBLICATION_PRODUCT_SLUGS} from '../src/imports/publicationImportPreview.ts';
import {publicationConfirmationIds} from '../src/imports/publicationProtocol.ts';
const target=new URL(process.env.HUB_TEST_DATABASE_URL);assert.equal(target.hostname,'127.0.0.1');assert.equal(target.port,'54322');
const admin=new pg.Pool({connectionString:target.href});
await admin.query("alter role hub_app_server login password 'ephemeral-test-only'");
target.username='hub_app_server';target.password='ephemeral-test-only';
const pool=new pg.Pool({connectionString:target.href});
const owner=randomUUID(),scoped=randomUUID(),learner=randomUUID(),workerToken=token(),workerId=randomUUID(),sourceRevision='7d86b15aa4facf2185e85f5f50fbbfa9691b5041';
await admin.query(`insert into auth.users(id,email,raw_user_meta_data,is_anonymous) values($1,'studio-owner@test.invalid','{"display_name":"Studio owner"}',false),($2,'studio-editor@test.invalid','{"display_name":"Studio editor"}',false),($3,'studio-learner@test.invalid','{"display_name":"Studio learner"}',false)`,[owner,scoped,learner]);
await admin.query("insert into private.staff_permissions(user_id,permission,product_id) values($1,'platform.admin',null),($2,'content.write',(select id from hub.products where slug='carebase'))",[owner,scoped]);
await admin.query("insert into private.sms_identities(user_id,phone_e164) values($1,'+12025550210'),($2,'+12025550211'),($3,'+12025550212')",[owner,scoped,learner]);
const provider={send:async()=>randomUUID(),verify:async(_id,_phone,code)=>code==='123456'};
const objects=new Map();let baseUrl,loseResponse=false,writeCount=0;
const storageFetch=async(url,options)=>{
 if(url.startsWith('https://support-hub-web-production.up.railway.app/api/internal/'))return fetch(baseUrl+new URL(url).pathname,options);
 const prefix='https://xgauehtwksmnoqhgqegm.supabase.co/storage/v1/object/';assert.ok(url.startsWith(prefix));
 const headers=new Headers(options.headers);assert.equal(headers.get('Authorization'),'Bearer synthetic-storage-only');assert.equal(options.redirect,'error');
 if(options.method==='DELETE') {assert.equal(url,prefix+'hub-docstudio');for(const path of JSON.parse(options.body).prefixes)objects.delete('hub-docstudio/'+path);return Response.json([]);}
 if(options.method==='POST') {
  const key=url.slice(prefix.length);assert.equal(headers.get('x-upsert'),'false');
  if(objects.has(key))return new Response('{}',{status:409});
  const bytes=new Uint8Array(await new Response(options.body).arrayBuffer());objects.set(key,{bytes,type:headers.get('content-type')});writeCount++;
  return Response.json({Key:key});
 }
 const key=url.slice((prefix+'authenticated/').length),object=objects.get(key);
 if(!object)return new Response('{}',{status:404});
 return new Response(object.bytes,{headers:{'Content-Type':object.type,'Content-Length':String(object.bytes.length)}});
};
const studioEdge=createImmutableMediaHandler({profile:'docstudio',serviceKey:'synthetic-storage-only',fetchImpl:storageFetch});
const publicationEdge=createImmutableMediaHandler({profile:'publication',serviceKey:'synthetic-storage-only',fetchImpl:storageFetch});
const remote=async(url,options)=>{
 const match=/^https:\/\/xgauehtwksmnoqhgqegm.supabase.co\/functions\/v1\/(docstudio-media|publication-media)$/.exec(url);assert.ok(match);
 const response=await (match[1]==='docstudio-media'?studioEdge:publicationEdge)(new Request(url,{...options,duplex:'half'}));
 if(loseResponse&&response.ok&&options.body instanceof ReadableStream){loseResponse=false;throw new Error('Synthetic lost media confirmation');}
 return response;
};
const caps=delegations({pool,storageUrl:'https://xgauehtwksmnoqhgqegm.supabase.co',fetchImpl:remote});
const publication=publications({pool,delegations:caps,storageUrl:'https://xgauehtwksmnoqhgqegm.supabase.co',fetchImpl:remote});
const studio=docstudio({pool,publications:publication,workerToken,fetchImpl:remote,onDatabaseError:error=>console.error('Disposable DocStudio SQL failure',{code:error.code,message:error.message,where:error.where})});
const server=appServer({auth:smsAuth({pool,provider}),gateway:gateway(pool),delegations:caps,publications:publication,docstudio:studio,origins:['https://hub.test']});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));baseUrl=`http://127.0.0.1:${server.address().port}`;
let jar={};
async function call(path,body,extra={},method=body===undefined?'GET':'POST'){
 const response=await fetch(baseUrl+'/api/'+path,{method,headers:{Origin:'https://hub.test','Content-Type':'application/json',Cookie:Object.entries(jar).map(([key,value])=>`${key}=${value}`).join('; '),...extra},body:body===undefined?undefined:JSON.stringify(body)});
 for(const value of response.headers.getSetCookie()){const [pair]=value.split(';'),i=pair.indexOf('=');jar[pair.slice(0,i)]=pair.slice(i+1);}
 return {status:response.status,body:await response.json()};
}
async function login(phone){jar={};const started=await call('auth/sms/start',{phone});assert.equal(started.status,200);assert.equal((await call('auth/sms/verify',{challengeId:started.body.challengeId,code:'123456'})).status,200);return {...jar};}
async function preview(command){const value=await call('docstudio/preview',command);assert.equal(value.status,200,JSON.stringify(value.body));return value.body;}
const applyBody=intent=>({intentId:intent.id,requestId:intent.requestId,reviewConfirmed:true,phiConfirmed:intent.operation==='approve'});
async function command(operation,projectId,expectedRevision,draft){
 const intent=await preview({operation,requestId:randomUUID(),projectId,expectedRevision,...(draft?{draft}:{})});
 const result=await call('docstudio/apply',applyBody(intent));assert.equal(result.status,200,JSON.stringify(result.body));return result.body;
}
async function worker(operation,input={},extra={}){
 const response=await fetch(baseUrl+'/api/internal/docstudio/worker',{method:'POST',headers:{Authorization:`Bearer ${workerToken}`,'Content-Type':'application/json',...extra},body:JSON.stringify({operation,workerId,sourceRevision,...input})});
 return {status:response.status,body:await response.json()};
}
const article={kind:'article',title:'Synthetic shared guide',summary:'Disposable content test',locale:'en-US',accessLevel:'customer',products:[...PUBLICATION_PRODUCT_SLUGS],markdown:'# Synthetic guide\n\nShared content test.\n',scenes:[],assets:[]};
const video={...article,kind:'video',title:'Synthetic tutorial',markdown:'',scenes:[{order:1,title:'Welcome',type:'intro',durationSeconds:3,narration:'This is a synthetic tutorial.',captionText:'Synthetic tutorial.'}]};
try {
 assert.equal((await call('docstudio')).status,401);
 const ownerJar=await login('+12025550210');
 const ready=await call('docstudio');assert.equal(ready.status,200,JSON.stringify(ready.body));assert.equal(ready.body.products.length,6);assert.equal(ready.body.workerReady,false);
 assert.equal((await call('docstudio/preview',{},{Origin:'https://evil.test'})).status,403);
 assert.equal((await call('docstudio/preview',{...article,sql:'select 1'})).status,400);
 for(const table of ['projects','revisions','approvals','intents','assets','workers','jobs','outputs','media_tokens','exports'])await assert.rejects(pool.query(`select * from private.docstudio_${table}`),/permission denied/);
 const grants=await admin.query("select bool_or(has_table_privilege(role,table_schema||'.'||table_name,'select,insert,update,delete')) bad from information_schema.tables cross join unnest(array['anon','authenticated','service_role','hub_app_server']) role where table_schema='private' and table_name like 'docstudio_%'");assert.equal(grants.rows[0].bad,false);
 const aid=randomUUID(),create={operation:'create',requestId:randomUUID(),projectId:aid,expectedRevision:0,draft:article};
 const intent=await preview(create);const applied=await call('docstudio/apply',applyBody(intent));assert.equal(applied.status,200,JSON.stringify(applied.body));
 assert.deepEqual((await call('docstudio/apply',applyBody(intent))).body,applied.body);
 assert.equal((await preview(create)).id,intent.id);
 assert.equal((await call('docstudio/preview',{...create,draft:{...article,title:'Changed request'}})).status,409);
 await command('submit',aid,1);const approval=await preview({operation:'approve',requestId:randomUUID(),projectId:aid,expectedRevision:1});
 assert.equal((await call('docstudio/apply',{...applyBody(approval),phiConfirmed:false})).status,400);
 assert.equal((await call('docstudio/apply',applyBody(approval))).status,200);
 await assert.rejects(admin.query("update private.docstudio_revisions set body='{}' where project_id=$1",[aid]),/immutable/);
 const exportRequest={projectId:aid,expectedRevision:1,requestId:randomUUID(),reviewConfirmed:true};
 const exported=await call('docstudio/export',exportRequest);assert.equal(exported.status,200,JSON.stringify(exported.body));assert.ok(exported.body.plan);
 assert.equal((await call('docstudio/export',exportRequest)).body.id,exported.body.id);
 const commit={planIdentity:exported.body.plan.planIdentity,idempotencyKey:randomUUID(),confirmedActions:publicationConfirmationIds(exported.body.plan),reviewConfirmed:true};
 const published=await call(`publications/imports/${exported.body.id}/commit`,commit);assert.equal(published.status,200,JSON.stringify(published.body));
 assert.equal((await admin.query('select body_markdown from hub.content_revisions where id=$1',[published.body.revisionId])).rows[0].body_markdown,article.markdown);
 const pending=await call('docstudio/export',{...exportRequest,requestId:randomUUID()});assert.equal(pending.status,200);
 await command('edit',aid,1,{...article,title:'Revised synthetic guide'});
 assert.equal((await call(`publications/imports/${pending.body.id}/commit`,{...commit,idempotencyKey:randomUUID(),planIdentity:pending.body.plan.planIdentity})).status,409,'editing invalidates a staged export');
 assert.equal((await call('docstudio/export',exportRequest)).status,409);
 jar=await login('+12025550211');assert.equal((await call(`docstudio/projects/${aid}`)).status,403,'scope covers every product');
 const scopedId=randomUUID();await command('create',scopedId,0,{...article,products:['carebase']});
 assert.equal((await call('docstudio/preview',{operation:'edit',requestId:randomUUID(),projectId:scopedId,expectedRevision:1,draft:article})).status,403);
 // Newer unauthorized drafts must not hide older authorized drafts. Page the
 // authorized cohort itself and prove all >100 older permitted rows reachable.
 for(const [count,products,age] of [[501,['breathe'],'0 days'],[105,['carebase'],'2 days']]) {
  const body={...article,products};
  await admin.query(`with inserted as (insert into private.docstudio_projects(id,content_key,revision,status,created_by,created_at,updated_at)
   select gen_random_uuid(),'pagination.'||replace(gen_random_uuid()::text,'-',''),1,'draft',$1,now()-interval '3 days',now()-$4::interval from generate_series(1,$2::integer) returning id)
   insert into private.docstudio_revisions(project_id,revision,body,body_hash,author_id) select id,1,$3::jsonb,encode(extensions.digest(($3::jsonb)::text,'sha256'),'hex'),$1 from inserted`,[owner,count,JSON.stringify(body),age]);
 }
 let page=(await call('docstudio')).body;const visible=[...page.projects];assert.equal(page.projects.length,100);assert.ok(page.nextCursor);
 while(page.nextCursor){page=(await call('docstudio/page',{cursor:page.nextCursor})).body;visible.push(...page.projects);}
 assert.equal(visible.length,106);assert.equal(new Set(visible.map(item=>item.id)).size,106);assert.ok(visible.some(item=>item.id===scopedId));
 jar=await login('+12025550212');assert.equal((await call('docstudio')).status,403);
 jar=ownerJar;
 assert.equal((await worker('heartbeat',{protocol:'caremetric.docstudio.render.v1'},{Origin:'https://hub.test'})).status,403);
 assert.equal((await worker('heartbeat',{protocol:'caremetric.docstudio.render.v1'},{Authorization:`Bearer ${token()}`})).status,401);
 assert.equal((await worker('heartbeat',{protocol:'caremetric.docstudio.render.v1'})).status,200);
 const assetsId=randomUUID();await command('create',assetsId,0,video);
 // A small synthetic PNG signature is enough for this transport/authorization
 // fixture; decoding and rendering real images are the renderer image tests.
 const imageBytes=Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]);
 const imageAsset={id:randomUUID(),sha256:digest(imageBytes),byteLength:imageBytes.length,mediaType:'image/png'};
 assert.equal((await call(`docstudio/projects/${assetsId}/assets`,imageAsset)).status,200);
 assert.equal((await call(`docstudio/projects/${assetsId}/assets`,{...imageAsset,sha256:'a'.repeat(64)})).status,409);
 const sourcePath=`${baseUrl}/api/docstudio/projects/${assetsId}/assets/${imageAsset.id}`;
 assert.equal((await fetch(sourcePath)).status,401);
 const imageUploaded=await fetch(sourcePath,{method:'POST',headers:{Origin:'https://hub.test',Cookie:`${sessionCookie}=${jar[sessionCookie]}`,'Content-Type':'image/png'},body:imageBytes});assert.equal(imageUploaded.status,200,await imageUploaded.text());
 const sourceRead=await fetch(sourcePath,{headers:{Cookie:`${sessionCookie}=${jar[sessionCookie]}`}});assert.equal(sourceRead.status,200);assert.deepEqual(Buffer.from(await sourceRead.arrayBuffer()),imageBytes);
 const withImage={...video,assets:[imageAsset],scenes:[{...video.scenes[0],screenshotAssetId:imageAsset.id}]};
 await command('edit',assetsId,1,withImage);await command('submit',assetsId,2);await command('approve',assetsId,2);await command('render',assetsId,2);
 const imageJob=(await worker('claim')).body.job;assert.ok(imageJob);
 const workerSource=`${baseUrl}/api/internal/docstudio/worker/jobs/${imageJob.manifest.jobId}/sources/`;
 const sourceHeaders={Authorization:`Bearer ${workerToken}`,'X-CareMetric-Job-Lease':imageJob.leaseToken};
 const source=await fetch(workerSource+imageAsset.id,{headers:sourceHeaders});assert.equal(source.status,200);assert.deepEqual(Buffer.from(await source.arrayBuffer()),imageBytes);
 assert.equal((await fetch(workerSource+randomUUID(),{headers:sourceHeaders})).status,404);
 await command('cancel',assetsId,2);
 assert.equal((await fetch(workerSource+imageAsset.id,{headers:sourceHeaders})).status,409);
 const unused={...imageAsset,id:randomUUID()};assert.equal((await call(`docstudio/projects/${assetsId}/assets`,unused)).status,200);
 const unusedUpload=await fetch(`${baseUrl}/api/docstudio/projects/${assetsId}/assets/${unused.id}`,{method:'POST',headers:{Origin:'https://hub.test',Cookie:`${sessionCookie}=${jar[sessionCookie]}`,'Content-Type':'image/png'},body:imageBytes});assert.equal(unusedUpload.status,200);
 await admin.query("update private.docstudio_assets set created_at=now()-interval '2 days' where project_id=$1",[assetsId]);
 await studio.cleanupExpired();
 assert.equal(objects.has(`hub-docstudio/assets/${assetsId}/${unused.id}`),false,'unused staged bytes are cleaned');
 assert.equal((await call(`docstudio/projects/${assetsId}/assets`,unused)).status,409,'cleaned identities cannot replace previous immutable objects');
 assert.equal(objects.has(`hub-docstudio/assets/${assetsId}/${imageAsset.id}`),true,'every immutable revision keeps its source bytes');
 const vid=randomUUID();await command('create',vid,0,video);await command('submit',vid,1);await command('approve',vid,1);
 const render=await command('render',vid,1);
 const claims=await Promise.all([worker('claim'),worker('claim')]);assert.ok(claims.every(result=>result.status===200));assert.equal(claims.filter(result=>result.body.job).length,1,'one durable lease per job');
 const lease=claims.find(result=>result.body.job).body.job;assert.equal(lease.manifest.jobId,render.jobId);
 assert.equal((await worker('renew',{jobId:render.jobId,leaseToken:token(),progress:1})).status,409);
 const media={width:1920,height:1080,fps:30,hasAudio:false,durationMs:3000};const sidecars=renderSidecars(lease.manifest);
 const primary=Buffer.alloc(24);primary.writeUInt32BE(24,0);primary.write('ftypisom',4);primary.write('isomiso2',16);
 const outputs=[['primary','video/mp4',primary],['captions','text/vtt',Buffer.from(sidecars.captions)],['transcript','text/plain',Buffer.from(sidecars.transcript)]].map(([kind,mediaType,bytes])=>({kind,mediaType,bytes,sha256:digest(bytes),byteLength:bytes.length}));
 const complete={jobId:render.jobId,leaseToken:lease.leaseToken,...media,artifacts:outputs.map(({bytes,...output})=>output)};
 assert.equal((await worker('complete',complete)).status,409,'worker cannot declare unverified completion');
 async function uploadOutput(output,bytes=output.bytes){const response=await fetch(`${baseUrl}/api/internal/docstudio/worker/jobs/${render.jobId}/outputs/${output.kind}`,{method:'POST',headers:{Authorization:`Bearer ${workerToken}`,'X-CareMetric-Job-Lease':lease.leaseToken,'Content-Type':output.mediaType,'X-CareMetric-Asset-SHA256':output.sha256,'Content-Length':String(bytes.length)},body:bytes});return {status:response.status,body:await response.json()};}
 assert.equal((await uploadOutput(outputs[0],Buffer.alloc(24))).status,422);
 loseResponse=true;assert.equal((await uploadOutput(outputs[0])).status,503);const writes=writeCount;
 assert.equal((await uploadOutput(outputs[0])).status,200);assert.equal(writeCount,writes,'retry reconciles exact immutable bytes');
 for(const output of outputs.slice(1)){const result=await uploadOutput(output);assert.equal(result.status,200,JSON.stringify(result.body));}
 assert.equal((await worker('complete',{...complete,durationMs:6000})).status,400);
 assert.equal((await worker('complete',complete)).status,200);assert.equal((await worker('complete',complete)).status,200,'completion retry returns prior result');
 assert.equal((await call('docstudio/export',{projectId:vid,expectedRevision:1,requestId:randomUUID(),reviewConfirmed:true})).status,200);
 await command('edit',vid,1,{...video,title:'New render revision'});await command('submit',vid,2);await command('approve',vid,2);await command('render',vid,2);
 const stale=(await worker('claim')).body.job;
 await admin.query("update private.docstudio_jobs set lease_expires_at=now()-interval '1 second' where id=$1",[stale.manifest.jobId]);
 const retried=(await worker('claim')).body.job;assert.notEqual(retried.leaseToken,stale.leaseToken);
 assert.equal((await worker('renew',{jobId:stale.manifest.jobId,leaseToken:stale.leaseToken,progress:1})).status,409);
 await command('cancel',vid,2);
 assert.equal((await worker('renew',{jobId:retried.manifest.jobId,leaseToken:retried.leaseToken,progress:1})).status,409);
 await command('render',vid,2);const revoked=(await worker('claim')).body.job;
 await admin.query('update private.staff_permissions set revoked_at=now() where user_id=$1',[owner]);
 assert.equal((await worker('renew',{jobId:revoked.manifest.jobId,leaseToken:revoked.leaseToken,progress:1})).status,409,'worker rechecks issuer permissions');
 assert.equal((await call('docstudio/apply',applyBody(intent))).status,403,'receipt replay requires current permissions');
 await admin.query('update private.staff_permissions set revoked_at=null where user_id=$1',[owner]);
 await admin.query('update private.sms_sessions set revoked_at=now() where user_id=$1',[owner]);
 assert.equal((await worker('renew',{jobId:revoked.manifest.jobId,leaseToken:revoked.leaseToken,progress:1})).status,409,'worker rechecks revoked SMS session');
 assert.equal((await call('docstudio')).status,401);
 console.log('DocStudio: actual SMS/HTTP/database checks passed for six-product scope, immutable revisions, explicit approval, publication invalidation, private bytes, concurrent claims, retries, cancellation and revocation.');
} finally {await new Promise(resolve=>server.close(resolve));await pool.end();await admin.end();}
