// Real PostgreSQL/session tests with synthetic directories and a recording mail
// provider. Never run against a hosted database.
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import pg from 'pg';
import {digest} from './sms-auth.mjs';
import {bulkEmail} from './bulk-email.mjs';
const databaseUrl=process.env.HUB_TEST_DATABASE_URL;
const local=new URL(databaseUrl);assert.equal(local.hostname,'127.0.0.1');assert.equal(local.port,'54322');
const admin=new pg.Pool({connectionString:databaseUrl});
await admin.query("alter role hub_app_server login password 'ephemeral-test-only'");
const appUrl=new URL(databaseUrl);appUrl.username='hub_app_server';appUrl.password='ephemeral-test-only';
const pool=new pg.Pool({connectionString:appUrl.href});
const owner=randomUUID(),customer=randomUUID(),ownerToken='bulk-owner-'+randomUUID(),customerToken='bulk-customer-'+randomUUID(),staleToken='bulk-stale-'+randomUUID();
const ownerSession=randomUUID(),customerSession=randomUUID(),staleSession=randomUUID();
const suffix=randomUUID().slice(0,8),domain=`bulk-${suffix}.test`;
const hash=email=>createHash('sha256').update(email.toLowerCase()).digest('hex');

// CareBase: 620 users over 13 pages. Every seventh has no email, every tenth is
// disabled; roles rotate. Go: four users, one sharing a CareBase address in a
// different case and one with an address that cannot be delivered.
const roles=['org_admin','facility_manager','employee','trainer'];
const carebase=Array.from({length:620},(_,i)=>({id:randomUUID(),displayName:`User ${i}`,email:i%7===0?null:`user${i}@${domain}`,role:roles[i%4],status:i%10===0?'disabled':'active',createdAt:null}));
const go=[
  {id:randomUUID(),displayName:'Shared',email:`USER4@${domain}`,role:'nurse',status:'active',createdAt:null},
  {id:randomUUID(),displayName:'Go only',email:`go-only@${domain}`,role:'nurse',status:'active',createdAt:null},
  {id:randomUUID(),displayName:'Broken',email:'not an address',role:'scheduler',status:'active',createdAt:null},
  {id:randomUUID(),displayName:'Invited',email:`invited@${domain}`,role:'scheduler',status:'invited',createdAt:null},
];
const directories={carebase,'breathe':go};
const reads=[];
const delegations={admin:async(token,input)=>{
  reads.push(input);assert.equal(input.operation,'users.list');assert.equal(input.limit,50);
  const rows=directories[input.product];assert.ok(rows,'only chosen directories are read');
  return {data:{items:rows.slice(input.offset,input.offset+50),total:rows.length,limit:50,offset:input.offset}};
}};
const sent=[];let failNext=0,unknownNext=0;
const mail={configured:true,async send(message){
  sent.push(message);
  if(failNext){failNext--;return {delivery:'failed',id:null};}
  if(unknownNext){unknownNext--;return {delivery:'unknown',id:null};}
  return {delivery:'sent',id:'msg-'+sent.length};
}};
const service=bulkEmail({pool,delegations,mail,publicOrigin:'https://hub.example',postalAddress:'1 Main St, Altoona, PA'});
const contractMigration=await readFile(new URL('../supabase/migrations/20261021160100_bulk_email_contract.sql',import.meta.url),'utf8');
const campaigns=[];
const product=async slug=>(await admin.query('select id from hub.products where slug=$1',[slug])).rows[0].id;
const loadAll=async id=>{let result;for(let i=0;i<5;i++){result=await service.load(ownerToken,{id});if(result.status!=='loading')break;}return result;};
try{
  const contractConnection=await admin.connect();
  try{
    const current=(await contractConnection.query('select hub.get_backend_contract() as data')).rows[0].data;
    assert.ok(current.features.includes('support.bulk-email.v1'));
    await contractConnection.query(contractMigration);
    assert.deepEqual((await contractConnection.query('select hub.get_backend_contract() as data')).rows[0].data,current,'declaration is idempotent');
    for(const change of [
      'alter table private.email_recipients rename to fixture_missing_recipients',
      'alter table private.email_suppressions disable row level security',
      'grant select on private.email_audience_members to hub_app_server',
      'grant execute on function private.claim_email_batch(integer) to authenticated',
      'grant execute on function hub.list_email_campaigns() to anon',
      "create or replace function hub.queue_email_campaign(p_campaign_id uuid,p_expected_version integer,p_expected_recipients integer) returns jsonb language plpgsql security definer set search_path='' as $$ begin perform hub.authorize_app_admin(); return null; end $$",
    ]){
      await contractConnection.query('begin');
      try{await contractConnection.query(change);await assert.rejects(contractConnection.query(contractMigration),error=>error.code==='55000',change);}
      finally{await contractConnection.query('rollback');}
    }
  }finally{contractConnection.release();}
  const [carebaseId,goId,advisorsId]=[await product('carebase'),await product('breathe'),await product('advisors')];
  await admin.query("insert into auth.users(id,email,is_anonymous) values($1,$3,false),($2,$4,false)",[owner,customer,`owner@${domain}`,`customer@${domain}`]);
  await admin.query("insert into private.staff_permissions(user_id,permission) values($1,'platform.admin')",[owner]);
  await admin.query("insert into private.sms_identities(user_id,phone_e164,verified_at) values($1,'+12025550895',now()),($2,'+12025550896',now())",[owner,customer]);
  for(const [id,user,token,started] of [[ownerSession,owner,ownerToken,'0'],[customerSession,customer,customerToken,'0'],[staleSession,owner,staleToken,'9']])
    await admin.query("insert into private.sms_sessions(id,token_hash,user_id,identity_version,created_at,expires_at) select $1,$2,user_id,identity_version,now()-make_interval(hours=>$4::int),now()+interval '1 hour' from private.sms_identities where user_id=$3",[id,digest(token),user,started]);

  await assert.rejects(service.list(null,{}));
  await assert.rejects(service.list(customerToken,{}),error=>error.status===401||error.status===403);
  await assert.rejects(service.create(customerToken,{productIds:[carebaseId]}));
  await assert.rejects(pool.query('select * from private.email_recipients'),'app server has no direct table access');
  await assert.rejects(pool.query('select private.email_unsubscribe($1,false)',['0'.repeat(64)]).then(()=>admin.query("select private.claim_email_batch(1)")),'only the Hub server claims deliveries');
  for(const invalid of [[],[advisorsId],[randomUUID()],[carebaseId,carebaseId],['not-a-uuid']]) await assert.rejects(service.create(ownerToken,{productIds:invalid}),JSON.stringify(invalid));

  // Audience: read every page in order, resuming across requests.
  const created=await service.create(ownerToken,{productIds:[carebaseId,goId]});campaigns.push(created.id);
  assert.equal(created.status,'loading');
  await assert.rejects(service.load(customerToken,{id:created.id}));
  const firstLoad=await service.load(ownerToken,{id:created.id});
  assert.equal(firstLoad.status,'loading','ten pages per request leave CareBase partly read');
  const ready=await loadAll(created.id);
  assert.equal(ready.status,'ready');
  assert.deepEqual(reads.filter(read=>read.product==='carebase').map(read=>read.offset),Array.from({length:13},(_,i)=>i*50));
  const careSource=ready.sources.find(source=>source.productId===carebaseId),goSource=ready.sources.find(source=>source.productId===goId);
  assert.equal(careSource.read,620);assert.equal(careSource.total,620);assert.equal(careSource.truncated,false);
  assert.deepEqual(careSource.roles,[...roles].sort(),'every role starts selected');
  assert.deepEqual(careSource.statuses,['active'],'statuses that read as switched off start unselected');
  assert.deepEqual(goSource.statuses,['active','invited']);
  assert.equal(careSource.roleCounts.find(row=>row.value==='employee').users,155);
  assert.equal(goSource.roleCounts.find(row=>row.value==='scheduler').withEmail,1,'an undeliverable address counts as no email');
  const activeWithEmail=carebase.filter((user,i)=>user.email&&user.status==='active'&&i!==4).length;
  assert.equal(ready.audience.recipients,activeWithEmail+3,'the shared address counts once');

  // Narrow by role; only loaded values are accepted, and stale or malformed saves are refused.
  const selection={[carebaseId]:{roles:['org_admin','trainer'],statuses:['active']},[goId]:{roles:['nurse'],statuses:['active']}};
  const draft={id:created.id,subject:'Scheduled maintenance',body:'CareMetric will be unavailable Saturday 2–4 AM ET.\n\nThank you.',selection,version:ready.version};
  for(const invalid of [{...draft,selection:{...selection,[carebaseId]:{roles:['owner'],statuses:['active']}}},{...draft,selection:{[carebaseId]:selection[carebaseId]}},
    {...draft,subject:'Two\nlines'},{...draft,body:'x'.repeat(20001)},{...draft,version:ready.version-1},{...draft,extra:true}])
    await assert.rejects(service.save(ownerToken,invalid));
  const saved=await service.save(ownerToken,draft);
  const expected=new Set(carebase.filter(user=>user.email&&user.status==='active'&&['org_admin','trainer'].includes(user.role)).map(user=>user.email.toLowerCase()));
  for(const user of go.filter(user=>user.role==='nurse')) expected.add(user.email.toLowerCase());
  assert.equal(saved.audience.recipients,expected.size);
  // A previously unsubscribed address is left out.
  const unsubscribedEarlier=`user3@${domain}`;assert.ok(expected.has(unsubscribedEarlier));
  await admin.query('insert into private.email_suppressions(email_hash) values($1)',[hash(unsubscribedEarlier)]);
  const reviewed=await service.get(ownerToken,{id:created.id});
  assert.equal(reviewed.audience.unsubscribed,1);assert.equal(reviewed.audience.recipients,expected.size-1);

  // A test copy goes only to the typed address and needs the command session.
  await assert.rejects(service.test(staleToken,{id:created.id,to:`owner@${domain}`}));
  await assert.rejects(service.test(ownerToken,{id:created.id,to:'not an address'}));
  assert.deepEqual(await service.test(ownerToken,{id:created.id,to:`owner@${domain}`}),{delivery:'sent'});
  assert.equal(sent.length,1);assert.equal(sent[0].subject,'[Test] Scheduled maintenance');assert.equal(sent[0].unsubscribeUrl,null);
  assert.match(sent[0].text,/an account in CareMetric Breathe or CareMetric CareBase\./);
  assert.ok(sent[0].html.includes('data-caremetric-email="personal"')&&sent[0].html.includes('Unsubscribe link: included in each real message.')&&!/<a\s/i.test(sent[0].html),'a test copy has the layout and no unsubscribe link');

  // Sending: the reviewed count must match, the command session is required, and the audience copy is deleted.
  await assert.rejects(service.send(ownerToken,{id:created.id,version:saved.version,recipients:expected.size}),error=>error.status===409);
  await assert.rejects(service.send(staleToken,{id:created.id,version:saved.version,recipients:expected.size-1}));
  await assert.rejects(service.send(customerToken,{id:created.id,version:saved.version,recipients:expected.size-1}));
  failNext=1;unknownNext=1;
  const queued=await service.send(ownerToken,{id:created.id,version:saved.version,recipients:expected.size-1});
  assert.equal(queued.status,'sending');assert.equal(queued.recipientCount,expected.size-1);
  assert.equal((await admin.query('select count(*)::int as n from private.email_audience_members where campaign_id=$1',[created.id])).rows[0].n,0);
  await assert.rejects(service.save(ownerToken,{...draft,version:queued.version}),error=>error.status===409,'a sending email cannot be edited');
  // Someone unsubscribes through an earlier email's link while this one is still queued: they are not sent it.
  const lateUnsubscriber=[...expected].find(address=>address!==unsubscribedEarlier&&address!==`user4@${domain}`);
  await admin.query('insert into private.email_suppressions(email_hash) values($1)',[hash(lateUnsubscriber)]);
  await service.tick();
  const delivered=await service.get(ownerToken,{id:created.id});
  assert.equal(delivered.status,'sent');assert.ok(delivered.completedAt);
  assert.deepEqual(delivered.delivery,{queued:0,sending:0,sent:expected.size-4,failed:1,unknown:1,cancelled:1});
  const bulk=sent.slice(1);
  assert.equal(bulk.length,expected.size-2);
  assert.ok(!bulk.some(message=>message.to.toLowerCase()===lateUnsubscriber),'an address unsubscribed after queuing is not sent');
  assert.equal(new Set(bulk.map(message=>message.to.toLowerCase())).size,bulk.length,'one message per address');
  assert.ok(!bulk.some(message=>message.to===unsubscribedEarlier));
  const shared=bulk.find(message=>message.to.toLowerCase()===`user4@${domain}`);
  assert.match(shared.text,/an account in CareMetric Breathe or CareMetric CareBase\./);
  for(const message of bulk){
    assert.equal(message.subject,'Scheduled maintenance');
    assert.match(message.unsubscribeUrl,/^https:\/\/hub\.example\/api\/email\/unsubscribe\/[0-9a-f]{64}$/);
    assert.ok(message.text.startsWith('CareMetric will be unavailable')&&message.text.includes(message.unsubscribeUrl)&&message.text.includes('1 Main St, Altoona, PA'));
    assert.ok(message.html.includes('data-caremetric-email="personal"')&&message.html.includes(`href="${message.unsubscribeUrl}"`)&&message.html.includes('1 Main St, Altoona, PA'),'the HTML part is on the shared layout with the same footer');
  }
  assert.equal((await admin.query('select count(*)::int as n from private.email_recipients where campaign_id=$1 and (email is not null or unsubscribe_token is not null)',[created.id])).rows[0].n,0,'addresses and tokens are cleared after delivery');
  const sentAgain=sent.length;await service.tick();assert.equal(sent.length,sentAgain,'unknown and failed deliveries are never resent');

  // Unsubscribe: viewing changes nothing; confirming suppresses the address once.
  const link=shared.unsubscribeUrl.split('/').at(-1);
  assert.match(await service.unsubscribePage(link,false),/<button type="submit">Unsubscribe<\/button>/);
  assert.equal((await admin.query('select count(*)::int as n from private.email_suppressions where email_hash=$1',[hash(`user4@${domain}`)])).rows[0].n,0);
  assert.match(await service.unsubscribePage(link,true),/You are unsubscribed/);
  assert.match(await service.unsubscribePage(link,true),/You are unsubscribed/);
  assert.match(await service.unsubscribePage('f'.repeat(64),true),/Link not recognized/);
  assert.equal((await admin.query("select count(*)::int as n from private.audit_events where action='email_campaign.unsubscribe' and entity_id=$1",[created.id])).rows[0].n,1);
  const history=(await service.list(ownerToken,{})).campaigns.find(item=>item.id===created.id);
  assert.deepEqual([history.status,history.recipientCount,history.unsubscribed,history.applications],['sent',expected.size-1,1,['CareMetric Breathe','CareMetric CareBase']]);

  // Cancelling while queued stops every message not yet handed to SendGrid.
  const second=await service.create(ownerToken,{productIds:[goId]});campaigns.push(second.id);
  const secondReady=await loadAll(second.id);
  const secondSaved=await service.save(ownerToken,{id:second.id,subject:'Go update',body:'New features.',selection:{[goId]:{roles:['nurse','scheduler'],statuses:['active','invited']}},version:secondReady.version});
  assert.equal(secondSaved.audience.recipients,2,'the unsubscribed shared address is excluded');
  const secondQueued=await (async()=>{const realTick=service.tick;service.tick=()=>Promise.resolve();try{return await service.send(ownerToken,{id:second.id,version:secondSaved.version,recipients:2});}finally{service.tick=realTick;}})();
  assert.equal(secondQueued.status,'sending');
  const cancelled=await service.cancel(ownerToken,{id:second.id});
  assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.delivery.cancelled,2);
  const beforeCancelledTick=sent.length;await service.tick();assert.equal(sent.length,beforeCancelledTick);
  await assert.rejects(service.cancel(ownerToken,{id:second.id}),error=>error.status===409);

  // Housekeeping: an abandoned claim becomes unknown; a draft untouched for a day is cancelled and its audience deleted.
  const third=await service.create(ownerToken,{productIds:[goId]});campaigns.push(third.id);
  await loadAll(third.id);
  await admin.query("update private.email_campaigns set updated_at=now()-interval '2 days' where id=$1",[third.id]);
  const recipientId=randomUUID();
  await admin.query("insert into private.email_campaigns(id,status,subject,body,recipient_count,created_by,queued_at) values($1,'sending','Stuck','Body',1,$2,now())",[recipientId,owner]);campaigns.push(recipientId);
  await admin.query("insert into private.email_recipients(campaign_id,email_hash,email,unsubscribe_token,unsubscribe_hash,applications,status,claimed_at) values($1,$2,$3,$4,$5,'PennSync','sending',now()-interval '11 minutes')",
    [recipientId,hash(`stuck@${domain}`),`stuck@${domain}`,'1'.repeat(64),digest('1'.repeat(64))]);
  // Housekeeping runs even when SendGrid is not configured, so drafts never keep copied users.
  const beforeHousekeeping=sent.length;
  await bulkEmail({pool,delegations,mail:{configured:false},publicOrigin:'https://hub.example'}).tick();
  assert.equal(sent.length,beforeHousekeeping);
  assert.equal((await service.get(ownerToken,{id:third.id})).status,'cancelled');
  assert.equal((await admin.query('select count(*)::int as n from private.email_audience_members where campaign_id=$1',[third.id])).rows[0].n,0);
  const stuck=await service.get(ownerToken,{id:recipientId});
  assert.equal(stuck.status,'sent');assert.equal(stuck.delivery.unknown,1);

  // Audits carry counts and states, never addresses or message text.
  const audit=JSON.stringify((await admin.query('select action,metadata from private.audit_events where actor_id=$1 order by id',[owner])).rows);
  for(const text of [domain,'Scheduled maintenance','unavailable']) assert.equal(audit.includes(text),false,text);
  assert.match(audit,/email_campaign\.queue/);assert.match(audit,/email_campaign\.test/);

  await admin.query('update private.staff_permissions set revoked_at=now() where user_id=$1',[owner]);
  await assert.rejects(service.list(ownerToken,{}));
  await admin.query('update private.staff_permissions set revoked_at=null where user_id=$1',[owner]);
  await admin.query('update private.sms_sessions set revoked_at=now() where id=$1',[ownerSession]);
  await assert.rejects(service.list(ownerToken,{}));
  console.log('Bulk email: real administrator and command sessions, resumable directory reads, role and status selection, duplicate and unsubscribed addresses, confirmed counts, one-time delivery, unknown outcomes never resent, unsubscribe, cancellation, housekeeping and bounded audit passed.');
}finally{
  await admin.query('delete from private.email_campaigns where id=any($1::uuid[]) or created_by=$2',[campaigns,owner]);
  await admin.query("delete from private.email_suppressions where email_hash=any($1::text[])",[[...carebase,...go].filter(user=>user.email).map(user=>hash(user.email))]);
  await admin.query('delete from private.audit_events where actor_id in ($1,$2) or (action=$3 and entity_id=any($4::uuid[]))',[owner,customer,'email_campaign.unsubscribe',campaigns]);
  await admin.query('delete from private.sms_sessions where user_id in ($1,$2)',[owner,customer]);
  await admin.query('delete from private.sms_identities where user_id in ($1,$2)',[owner,customer]);
  await admin.query('delete from private.staff_permissions where user_id in ($1,$2)',[owner,customer]);
  await admin.query('delete from auth.users where id in ($1,$2)',[owner,customer]);
  await pool.end();await admin.end();
}
