// Real disposable PostgreSQL, SMS cookies, fixed Hub delegation and HTTP routes: an AI-written CareBase course joins the
// central catalog, after which its exact material can be preserved (and so reviewed and published).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import pg from 'pg';
import { smsAuth,digest } from './sms-auth.mjs';
import { gateway } from './gateway.mjs';
import { delegations } from './delegations.mjs';
import { appServer } from './http.mjs';
import { removeTestIdentities, testPhones } from './test-phones.mjs';
const phones = testPhones(import.meta.url);
const databaseUrl=process.env.HUB_TEST_DATABASE_URL,local=new URL(databaseUrl);
assert.equal(local.hostname,'127.0.0.1');assert.equal(local.port,'54322');
const admin=new pg.Pool({connectionString:databaseUrl});
await admin.query("alter role hub_app_server login password 'ephemeral-test-only'");
const appUrl=new URL(databaseUrl);appUrl.username='hub_app_server';appUrl.password='ephemeral-test-only';
const pool=new pg.Pool({connectionString:appUrl.href});
// Fresh identities each run, so the script can be rerun on the same database.
const owner=randomUUID(),phone=phones.owner;
const fixture=JSON.parse(readFileSync(new URL('../src/imports/fixtures/governedCourse.json',import.meta.url)));
// Exactly what CareBase's create_course_from_ai_draft_delegated writes: version 1 of a new course, a draft, AI-generated.
const aiDraft=()=>({...fixture,sourceCourseId:randomUUID(),sourceVersionId:randomUUID(),sourceVersionNumber:1,publicationState:'draft',sourceVersionState:'draft',
  version:{...fixture.version,aiGenerated:true,aiReviewedAt:null}});
const courses=new Map();
const put=doc=>{courses.set(doc.sourceCourseId,JSON.stringify(doc));return {courseId:doc.sourceCourseId,versionId:doc.sourceVersionId};};
await admin.query("insert into auth.users(id,email,is_anonymous) values($1,$2,false)",[owner,`generated-course-${owner}@test.invalid`]);
await admin.query("insert into private.staff_permissions(user_id,permission) values($1,'platform.admin')",[owner]);
await admin.query('insert into private.sms_identities(user_id,phone_e164) values($1,$2)',[owner,phone]);
const auth=smsAuth({pool,provider:{send:async()=>randomUUID(),verify:async(_id,_phone,code)=>code==='123456'}});
const caps=delegations({pool,storageUrl:'https://storage.test',fetchImpl:async(url,options)=>{
  assert.equal(url,'https://cmcarebase.com/api/learning-admin/authoring');
  const op=JSON.parse(options.body);
  assert.deepEqual((await caps.consume(options.headers.Authorization.slice(7),'carebase.learning')).operation,op);
  assert.equal(op.operation,'source','registration reads the material from CareBase, never from the browser');
  const payload=courses.get(op.courseId);
  return Response.json({courseId:op.courseId,versionId:op.versionId,payload,sourceRevision:digest(payload)});
}});
const server=appServer({auth,gateway:gateway(pool),delegations:caps,origins:['https://hub.test']});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`,jar={};
async function call(path,body,headers={}) {
  const response=await fetch(origin+'/api/'+path,{method:'POST',headers:{Origin:'https://hub.test','Content-Type':'application/json',Cookie:Object.entries(jar).map(([k,v])=>`${k}=${v}`).join('; '),...headers},body:JSON.stringify(body)});
  for(const value of response.headers.getSetCookie()){const [pair]=value.split(';'),i=pair.indexOf('=');jar[pair.slice(0,i)]=pair.slice(i+1);}
  return {status:response.status,body:await response.json()};
}
const author=body=>call('admin/authoring',body);
const register=ids=>author({operation:'register_generated',...ids});
const mapped=async courseId=>(await admin.query('select l.content_item_id,i.status,i.access_level,p.slug from hub.course_links l join hub.content_items i on i.id=l.content_item_id left join hub.products p on p.id=i.owner_product_id where l.penntrain_course_id=$1',[courseId])).rows;
try {
  const draft=put(aiDraft());
  assert.equal((await register(draft)).status,401);
  const challenge=await call('auth/sms/start',{phone});assert.equal(challenge.status,200);
  assert.equal((await call('auth/sms/verify',{challengeId:challenge.body.challengeId,code:'123456'})).status,200);
  assert.equal((await call('admin/authoring',{operation:'register_generated',...draft},{Origin:'https://evil.test'})).status,403);

  // Before registration, preserving the AI draft's material fails: this is what blocked publishing.
  const source=await author({operation:'source',...draft});assert.equal(source.status,200,JSON.stringify(source.body));
  const preserve={operation:'preserve_source',...draft,sourceRevision:source.body.sourceRevision,expectedHeadRevision:null,reviewed:true};
  assert.equal((await author(preserve)).status,400);

  const first=await register(draft);assert.equal(first.status,200,JSON.stringify(first.body));
  const item=createHash('md5').update('penntrain-course-item:'+draft.courseId).digest('hex').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/,'$1-$2-$3-$4-$5');
  assert.deepEqual(first.body,{itemId:item,registered:true});
  assert.deepEqual(await mapped(draft.courseId),[{content_item_id:item,status:'draft',access_level:'staff',slug:'carebase'}],'a staff-only draft catalog item owned by CareBase');
  assert.deepEqual((await register(draft)).body,{itemId:item,registered:false},'a repeat is acknowledged, not duplicated');
  assert.equal((await mapped(draft.courseId)).length,1);
  assert.equal(Number((await admin.query("select count(*) from private.audit_events where actor_id=$1 and action='learning.generation.registered'",[owner])).rows[0].count),1);

  // Now the exact material can be preserved, which review and publication require.
  const staged=await author(preserve);assert.equal(staged.status,200,JSON.stringify(staged.body));assert.equal(staged.body.sourceRevision,preserve.sourceRevision);

  // Only a fresh AI draft joins this way, and an existing different mapping is never overwritten.
  for(const change of [{publicationState:'published',sourceVersionState:'published'},{sourceVersionNumber:2},{version:{...fixture.version,aiGenerated:false,aiReviewedAt:null}}]) {
    const other=put({...aiDraft(),...change});
    assert.equal((await register(other)).status,400,JSON.stringify(change));assert.deepEqual(await mapped(other.courseId),[]);
  }
  const taken=put(aiDraft()),otherItem=randomUUID();
  await admin.query("insert into hub.content_items(id,content_key,kind,status,access_level,source_system) values($1,$2,'course','draft','staff','penntrain')",[otherItem,'generated.integration.'+otherItem]);
  await admin.query('insert into hub.course_links(content_item_id,penntrain_course_id,source_version,launch_path) values($1,$2,$3,$4)',[otherItem,taken.courseId,taken.versionId,'/app/courses/'+taken.courseId]);
  assert.equal((await register(taken)).status,409);assert.deepEqual((await mapped(taken.courseId)).map(row=>row.content_item_id),[otherItem]);

  // A revoked administrator cannot record courses.
  await admin.query('update private.staff_permissions set revoked_at=now() where user_id=$1',[owner]);
  assert.equal((await register(put(aiDraft()))).status,401);
  console.log('AI-written course registration passed: a fresh AI draft joins the catalog once, its material can then be preserved, and other courses, existing mappings and other people are refused.');
} finally {await new Promise(resolve=>server.close(resolve));await removeTestIdentities(admin,[owner],{also:['delete from private.learning_source_snapshots where staged_by = any($1::uuid[])']});await pool.end();await admin.end();}
