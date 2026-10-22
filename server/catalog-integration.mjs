// Actual disposable Hub PostgreSQL, opaque SMS cookies and one-use capabilities.
// Training library records live in CareBase; this fixture stands in for its
// route, which separately exercises record checks, replay receipts and paging.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {smsAuth} from './sms-auth.mjs';
import {gateway} from './gateway.mjs';
import {delegations} from './delegations.mjs';
import {appServer} from './http.mjs';
const local=new URL(process.env.HUB_TEST_DATABASE_URL);assert.equal(local.hostname,'127.0.0.1');assert.equal(local.port,'54322');
const admin=new pg.Pool({connectionString:local.href});
await admin.query("alter role hub_app_server login password 'ephemeral-test-only'");
const appUrl=new URL(local);appUrl.username='hub_app_server';appUrl.password='ephemeral-test-only';
const pool=new pg.Pool({connectionString:appUrl.href}),owner=randomUUID(),phone='+12025550861',course=randomUUID();
await admin.query("insert into auth.users(id,email,is_anonymous) values($1,$2,false)",[owner,`catalog-sms-owner-${owner}@test.invalid`]);
await admin.query("insert into private.staff_permissions(user_id,permission) values($1,'platform.admin')",[owner]);
await admin.query('insert into private.sms_identities(user_id,phone_e164) values($1,$2)',[owner,phone]);
const kits=new Map(),receipts=new Map();let calls=0,nativeRevoked=false,revokeAfterSave=false;
const auth=smsAuth({pool,provider:{send:async()=>randomUUID(),verify:async(_id,_phone,code)=>code==='123456'}});
const caps=delegations({pool,storageUrl:'https://storage.test',fetchImpl:async(url,options)=>{
  calls++;assert.equal(url,'https://cmcarebase.com/api/learning-admin/catalog');assert.equal(options.redirect,'error');assert.equal(options.cache,'no-store');
  assert.deepEqual(Object.keys(options.headers).sort(),['Authorization','Content-Type']);
  const operation=JSON.parse(options.body),ticket=options.headers.Authorization.slice(7);
  const actor=await caps.consume(ticket,'carebase.learning');assert.equal(actor.user_id,owner);assert.equal(actor.method,'sms');assert.deepEqual(actor.operation,operation);
  await assert.rejects(caps.consume(ticket,'carebase.learning'),/Invalid authorization/);
  if(nativeRevoked)return Response.json({error:{code:'forbidden'}},{status:403});
  if(operation.operation==='catalog.read') {
    const items=[...kits.values()].sort((a,b)=>a.id.localeCompare(b.id)).filter(kit=>operation.after===null||kit.id>operation.after);
    const page=items.slice(0,1);return Response.json({section:'starterKits',items:page,nextAfter:items.length>1?page[0].id:null});
  }
  assert.equal(operation.operation,'starterKits.save');
  const prior=receipts.get(operation.requestId);
  if(prior)return prior.body===options.body?Response.json(prior.result):Response.json({error:{code:'conflict'}},{status:409});
  if(!operation.kit.items.every(item=>item.courseId===course))return Response.json({error:{code:'invalid_request'}},{status:400});
  const current=kits.get(operation.kit.id);
  if((current?.revision??null)!==operation.kit.revision)return Response.json({error:{code:'conflict'}},{status:409});
  const kit={...operation.kit,revision:(current?.revision??0)+1,updatedAt:new Date().toISOString()};kits.set(kit.id,kit);
  const result={kit};receipts.set(operation.requestId,{body:options.body,result});
  if(revokeAfterSave)await admin.query('update private.staff_permissions set revoked_at=now() where user_id=$1',[owner]);
  return Response.json(result);
}});
const server=appServer({auth,gateway:gateway(pool),delegations:caps,origins:['https://hub.test']});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`,jar={};
async function call(path,body,headers={}){
  const response=await fetch(origin+'/api/'+path,{method:'POST',headers:{Origin:'https://hub.test','Content-Type':'application/json',Cookie:Object.entries(jar).map(([k,v])=>`${k}=${v}`).join('; '),...headers},body:JSON.stringify(body)});
  assert.equal(response.headers.get('cache-control'),'no-store');
  for(const value of response.headers.getSetCookie()){const [pair]=value.split(';'),i=pair.indexOf('=');jar[pair.slice(0,i)]=pair.slice(i+1);}
  return {status:response.status,body:await response.json()};
}
const run=body=>call('admin/learning-catalog',body);
const kit=(id,revision,name)=>({id,revision,name,description:'First 30 days',items:[{courseId:course,isRequired:true}],published:true});
try{
  const read={operation:'catalog.read',section:'starterKits',after:null};
  assert.equal((await run(read)).status,401);
  const challenge=await call('auth/sms/start',{phone});assert.equal(challenge.status,200);
  assert.equal((await call('auth/sms/verify',{challengeId:challenge.body.challengeId,code:'123456'})).status,200);
  assert.equal((await call('admin/learning-catalog',read,{Origin:'https://evil.test'})).status,403);
  const beforeInvalid=calls;
  for(const op of [{...read,section:'users'},{...read,actor:owner},{operation:'starterKits.save',requestId:randomUUID(),kit:{...kit(randomUUID(),null,'Empty'),items:[],published:true}},
    {operation:'starterKits.save',requestId:randomUUID(),kit:{...kit(randomUUID(),null,'Leaky'),description:'https://cdn.invalid/a.mp4?token=abc'}}])assert.equal((await run(op)).status,400);
  assert.equal(calls,beforeInvalid);
  const [first,second]=[randomUUID(),randomUUID()].sort();
  const save={operation:'starterKits.save',requestId:randomUUID(),kit:kit(first,null,'New PCH hire')};
  const saved=await run(save);assert.equal(saved.status,200,JSON.stringify(saved.body));assert.equal(saved.body.kit.revision,1);
  assert.deepEqual((await run(save)).body,saved.body); // a retry returns CareBase's first result
  assert.equal((await run({...save,kit:{...save.kit,name:'Changed inputs'}})).status,409);
  assert.equal((await run({operation:'starterKits.save',requestId:randomUUID(),kit:kit(first,null,'Stale')})).status,409);
  assert.equal((await run({operation:'starterKits.save',requestId:randomUUID(),kit:{...kit(second,null,'Other course'),items:[{courseId:randomUUID(),isRequired:false}]}})).status,400);
  assert.equal((await run({operation:'starterKits.save',requestId:randomUUID(),kit:kit(second,null,'Second kit')})).status,200);
  const page=await run(read);assert.equal(page.status,200,JSON.stringify(page.body));assert.deepEqual(page.body.items.map(row=>row.id),[first]);assert.equal(page.body.nextAfter,first);
  const next=await run({...read,after:first});assert.deepEqual(next.body.items.map(row=>row.id),[second]);assert.equal(next.body.nextAfter,null);
  revokeAfterSave=true;const lost=await run({operation:'starterKits.save',requestId:randomUUID(),kit:kit(first,1,'Renamed')});assert.ok([401,403].includes(lost.status),JSON.stringify(lost));
  revokeAfterSave=false;await admin.query('update private.staff_permissions set revoked_at=null where user_id=$1',[owner]);
  nativeRevoked=true;assert.equal((await run(read)).status,403);nativeRevoked=false;
  await admin.query('update private.staff_permissions set revoked_at=now() where user_id=$1',[owner]);
  const beforeRevoked=calls;assert.equal((await run(read)).status,401);assert.equal(calls,beforeRevoked);
  console.log('Training library HTTP integration passed: exact tickets, refused records before CareBase, replayed saves, stale revisions, keyed paging and post-save revocation.');
}finally{await new Promise(resolve=>server.close(resolve));await pool.end();await admin.end();}
