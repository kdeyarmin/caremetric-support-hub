// Real PostgreSQL/session tests. Never run against a hosted database.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {digest} from './sms-auth.mjs';
import {gateway} from './gateway.mjs';
const databaseUrl=process.env.HUB_TEST_DATABASE_URL;
const local=new URL(databaseUrl);assert.equal(local.hostname,'127.0.0.1');assert.equal(local.port,'54322');
const admin=new pg.Pool({connectionString:databaseUrl});
await admin.query("alter role hub_app_server login password 'ephemeral-test-only'");
const appUrl=new URL(databaseUrl);appUrl.username='hub_app_server';appUrl.password='ephemeral-test-only';
const pool=new pg.Pool({connectionString:appUrl.href});const api=gateway(pool);
const owner=randomUUID(),customer=randomUUID(),ownerToken='phones-owner-'+randomUUID(),customerToken='phones-customer-'+randomUUID();
const ownerSession=randomUUID(),customerSession=randomUUID();
let recordId;
const rpc=(name,args={},token=ownerToken)=>api.rpc(name,args,token);
const record={number:'+12025550881',label:'Synthetic support line',provider:'Test provider',account:'Test account',purpose:'Synthetic registry test',apps:'Test app',owner:'Test team',lifecycle:'active',usage_status:'unknown',voice_status:'unknown',voice_routing:'',sms_status:'unknown',sms_routing:'',last_used_on:'',reviewed_on:'',evidence:'',notes:''};
const save=(value=record,id=null,version=0,token=ownerToken)=>rpc('save_phone_number',{p_id:id,p_record:value,p_expected_version:version},token);
try{
  await admin.query("insert into auth.users(id,email,is_anonymous) values($1,'phone-owner@test.invalid',false),($2,'phone-customer@test.invalid',false)",[owner,customer]);
  await admin.query("insert into private.staff_permissions(user_id,permission) values($1,'platform.admin')",[owner]);
  await admin.query("insert into private.sms_identities(user_id,phone_e164,verified_at) values($1,'+12025550882',now()),($2,'+12025550883',now())",[owner,customer]);
  for(const [id,user,token] of [[ownerSession,owner,ownerToken],[customerSession,customer,customerToken]])
    await admin.query("insert into private.sms_sessions(id,token_hash,user_id,identity_version,expires_at) select $1,$2,user_id,identity_version,now()+interval '1 hour' from private.sms_identities where user_id=$3",[id,digest(token),user]);
  await assert.rejects(rpc('list_phone_numbers',{},null));
  await assert.rejects(rpc('list_phone_numbers',{},customerToken));
  await assert.rejects(save(record,null,0,customerToken));
  await assert.rejects(pool.query('select * from private.phone_numbers'),'app server has no direct table access');
  const initial=await rpc('list_phone_numbers');
  assert.equal(initial.rows.length,4);
  assert.ok(initial.rows.some(row=>row.number==='+18775212890'&&row.sms_status==='pending'));
  assert.equal(initial.rows.filter(row=>row.usage_status==='unknown').length,3);
  for(const invalid of [{...record,number:'not a number'},{...record,role:'platform_admin'},{...record,notes:'a'.repeat(2001)},{...record,notes:null},{...record,label:' '},{...record,lifecycle:'released'},{...record,usage_status:'observed'},{...record,reviewed_on:'9999-01-01'},{...record,reviewed_on:'2026-02-31'}])
    await assert.rejects(save(invalid));
  const created=await save();recordId=created.id;assert.equal(created.version,1);
  await assert.rejects(save(),'duplicate numbers do not create another record');
  const updated=await save({...record,lifecycle:'retired',notes:'Keep for history'},created.id,1);
  assert.equal(updated.version,2);assert.equal(updated.lifecycle,'retired');
  await assert.rejects(save(record,created.id,1),'stale changes cannot overwrite');
  await assert.rejects(save({...record,number:'+12025550884'},created.id,2),'cannot rename an existing number');
  assert.ok((await rpc('list_phone_numbers')).rows.some(row=>row.id===created.id&&row.lifecycle==='retired'));
  await admin.query('update private.staff_permissions set revoked_at=now() where user_id=$1',[owner]);
  await assert.rejects(rpc('list_phone_numbers'));await assert.rejects(save(record,created.id,2));
  await admin.query('update private.staff_permissions set revoked_at=null where user_id=$1',[owner]);
  await admin.query("update auth.users set banned_until=now()+interval '1 hour' where id=$1",[owner]);
  await assert.rejects(rpc('list_phone_numbers'));await assert.rejects(save(record,created.id,2));
  await admin.query('update auth.users set banned_until=null where id=$1',[owner]);
  await admin.query('update private.sms_sessions set revoked_at=now() where id=$1',[ownerSession]);
  await assert.rejects(rpc('list_phone_numbers'));
  const audit=(await admin.query("select action,metadata from private.audit_events where actor_id=$1 order by id",[owner])).rows;
  assert.deepEqual(audit.map(row=>row.action),['phone_registry.add','phone_registry.update']);
  assert.deepEqual(audit.map(row=>row.metadata),[{version:1},{version:2}]);
  assert.equal((await admin.query("select relrowsecurity from pg_class where oid='private.phone_numbers'::regclass")).rows[0].relrowsecurity,true);
  console.log('Phone registry: real administrator session, customer denial, revocation, input validation, duplicates, version conflicts, retirement and bounded audit passed.');
}finally{
  if(recordId)await admin.query('delete from private.phone_numbers where id=$1',[recordId]);
  await admin.query('delete from private.audit_events where actor_id in ($1,$2)',[owner,customer]);
  await admin.query('delete from private.sms_sessions where user_id in ($1,$2)',[owner,customer]);
  await admin.query('delete from private.sms_identities where user_id in ($1,$2)',[owner,customer]);
  await admin.query('delete from auth.users where id in ($1,$2)',[owner,customer]);
  await pool.end();await admin.end();
}
