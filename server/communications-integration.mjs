// Real PostgreSQL tests for unified communications. Never run against a hosted database.
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import pg from 'pg';
import { digest } from './sms-auth.mjs';
import { communications, twilioSignature } from './communications.mjs';
const databaseUrl=process.env.HUB_TEST_DATABASE_URL;
const local=new URL(databaseUrl);assert.equal(local.hostname,'127.0.0.1');assert.equal(local.port,'54322');
const admin=new pg.Pool({connectionString:databaseUrl});
await admin.query("alter role hub_app_server login password 'ephemeral-test-only'");
const appUrl=new URL(databaseUrl);appUrl.username='hub_app_server';appUrl.password='ephemeral-test-only';
const pool=new pg.Pool({connectionString:appUrl.href});
const owner=randomUUID(),agent=randomUUID(),customer=randomUUID();
const ownerToken='comms-owner-'+randomUUID(),agentToken='comms-agent-'+randomUUID(),customerToken='comms-customer-'+randomUUID();
const breathe=(await admin.query("select id from hub.products where slug='breathe'")).rows[0].id;
const otherProduct=(await admin.query("select id from hub.products where slug='carebase'")).rows[0].id;
const advisors=(await admin.query("select id from hub.products where slug='advisors'")).rows[0].id;
const origin='https://support-hub-web-production.up.railway.app';
const {privateKey,publicKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
const sent={sms:[],email:[]};let smsOutcome='sent';
const phonePage={items:[{id:'99000000-0000-4000-8000-0000000000a1',contactName:'Caller One',companyName:'Agency One',phone:'(202) 555-0171',email:'caller@agency.test',message:'Please call about billing.',status:'new',createdAt:'2026-10-18T12:00:00.000Z',product:'pennfit',requestType:'customer_service'}],total:1,limit:50,offset:0};
const inquiryPage={items:[{id:'CM-0A1B2C3D4E5F',createdAt:'2026-10-17T12:00:00.000Z',name:'Requester',email:'requester@agency.test',organization:'Agency Two',phone:null,sector:'Hospice',service:'Strategic Planning & Operations',message:'Operations review.',status:'closed',notes:''}],total:1,limit:50,offset:0};
const adminReads=[];
const service=communications({pool,publicOrigin:origin,chatEnabled:true,twilioAuthToken:'twilio-test-token',sendgridInboundPublicKey:publicKey.export({format:'der',type:'spki'}).toString('base64'),
  delegations:{admin:async(token,input)=>{adminReads.push(input);await pool.query('select 1');return {data:input.product==='breathe'?phonePage:inquiryPage};}},
  sms:{configured:true,send:async(to,body)=>{sent.sms.push({to,body});return {delivery:smsOutcome,id:smsOutcome==='sent'?'SM'+'c'.repeat(32):null};}},
  email:{configured:true,send:async(to,subject,body)=>{sent.email.push({to,subject,body});return {delivery:'sent',id:'sg-'+sent.email.length};}}});
const request=(body,headers)=>Object.assign(Readable.from([Buffer.from(body)]),{headers});
async function text(from,body,sid){
  const params=new URLSearchParams({From:from,To:'+18775212890',Body:body,MessageSid:sid,NumMedia:'0'});
  return service.smsWebhook(request(params.toString(),{'content-type':'application/x-www-form-urlencoded','x-twilio-signature':twilioSignature('twilio-test-token',`${origin}/api/channels/sms/twilio`,params)}));
}
async function email(fields){
  const form=new FormData();for(const [key,value] of Object.entries(fields))form.append(key,value);
  const encoded=new Request('https://hub.test/',{method:'POST',body:form});const payload=Buffer.from(await encoded.arrayBuffer());
  const timestamp=String(Math.floor(Date.now()/1000));
  return service.emailWebhook(request(payload,{'content-type':encoded.headers.get('content-type'),'x-twilio-email-event-webhook-timestamp':timestamp,
    'x-twilio-email-event-webhook-signature':sign('sha256',Buffer.concat([Buffer.from(timestamp),payload]),privateKey).toString('base64')}));
}
const list=(token=ownerToken,input={})=>service.list(token,input);
const find=async(predicate,token=ownerToken)=>(await list(token,{limit:50})).items.find(predicate);
const contractMigration=await readFile(new URL('../supabase/migrations/20261020163100_unified_communications_contract.sql',import.meta.url),'utf8');
let created=[];
try {
  const contract=await admin.connect();
  try {
    const current=(await contract.query('select hub.get_backend_contract() as data')).rows[0].data;
    assert.ok(current.features.includes('support.communications.v1'));
    await contract.query(contractMigration);
    assert.deepEqual((await contract.query('select hub.get_backend_contract() as data')).rows[0].data,current,'declaration is idempotent');
    for(const change of ['alter table private.communications disable row level security','grant select on private.communication_messages to authenticated',
      'grant execute on function private.start_chat(text,text,text,text,text,text) to anon','grant execute on function hub.get_communication(uuid) to anon',
      'revoke execute on function private.ingest_inbound_communication(text,text,text,bigint,text,text,text,text,text,text) from hub_app_server',
      "create or replace function hub.import_communications(p_source_system text,p_items jsonb) returns jsonb language sql security definer set search_path='' as $$ select '{}'::jsonb $$"]){
      await contract.query('begin');
      try{await contract.query(change);await assert.rejects(contract.query(contractMigration),error=>error.code==='55000');}
      finally{await contract.query('rollback');}
    }
  } finally { contract.release(); }
  await admin.query("insert into auth.users(id,email,is_anonymous) values($1,'comms-owner@test.invalid',false),($2,'comms-agent@test.invalid',false),($3,'comms-customer@test.invalid',false)",[owner,agent,customer]);
  await admin.query("insert into hub.profiles(id,display_name) values($1,'Owner'),($2,'Breathe Agent'),($3,'Customer') on conflict (id) do update set display_name=excluded.display_name",[owner,agent,customer]);
  await admin.query("insert into private.staff_permissions(user_id,permission,product_id) values($1,'platform.admin',null),($2,'case.write',$3)",[owner,agent,breathe]);
  await admin.query("insert into private.sms_identities(user_id,phone_e164,verified_at) values($1,'+12025550161',now()),($2,'+12025550162',now()),($3,'+12025550163',now())",[owner,agent,customer]);
  for(const [user,token] of [[owner,ownerToken],[agent,agentToken],[customer,customerToken]])
    await admin.query("insert into private.sms_sessions(id,token_hash,user_id,identity_version,expires_at) select $1,$2,user_id,identity_version,now()+interval '1 hour' from private.sms_identities where user_id=$3",[randomUUID(),digest(token),user]);

  // SMS: signed, deduplicated, and threaded by sender.
  await text('+12025550144','I cannot sign in to Breathe.','SM'+'1'.repeat(32));
  await text('+12025550144','I cannot sign in to Breathe.','SM'+'1'.repeat(32));
  await text('+12025550144','It says my code expired.','SM'+'2'.repeat(32));
  const sms=await find(item=>item.contactPhone==='+12025550144');created.push(sms.id);
  assert.equal(sms.channel,'sms');assert.equal(sms.status,'new');assert.equal(sms.messageCount,2,'a Twilio retry is stored once');assert.equal(sms.productId,null);
  // Two first texts from a new number, ingested at the same moment, share one conversation: the second waits for the first
  // instead of failing on the thread's unique key (Twilio does not retry a failed message webhook).
  {
    const ingest='select private.ingest_inbound_communication($1,$2,$3,null,null,null,$4,null,null,$5) as result';
    const first=await pool.connect(),second=await pool.connect();
    try {
      await first.query('begin');
      await first.query(ingest,['sms','+12025550145','SM'+'4'.repeat(32),'Hi.','+12025550145']);
      await second.query('begin');
      const pending=second.query(ingest,['sms','+12025550145','SM'+'5'.repeat(32),'My code expired.','+12025550145']).then(result=>result,error=>error);
      await new Promise(resolve=>setTimeout(resolve,300));
      await first.query('commit');
      const outcome=await pending;
      assert.ok(!(outcome instanceof Error),`the second first text is stored (${outcome?.code ?? ''})`);
      await second.query('commit');
    } finally { await first.query('rollback').catch(()=>{}); await second.query('rollback').catch(()=>{}); first.release(); second.release(); }
    const burst=await find(item=>item.contactPhone==='+12025550145');created.push(burst.id);
    assert.equal(burst.messageCount,2,'simultaneous first texts share one conversation');
  }
  await assert.rejects(pool.query('select * from private.communications'),/permission denied/,'the server role has no direct table access');
  await assert.rejects(list(customerToken),error=>error.status===403,'customers cannot read the inbox');
  await assert.rejects(list(null),error=>error.status===401);
  assert.equal(await find(item=>item.id===sms.id,agentToken),undefined,'an unassigned application is visible only to portfolio staff');
  await assert.rejects(service.update(agentToken,{id:sms.id,changeProduct:true,productId:breathe,expectedUpdatedAt:sms.updatedAt}),error=>error.status===403);
  const triaged=await service.update(ownerToken,{id:sms.id,changeProduct:true,productId:breathe,status:'open',inquiryType:'technical_support',changeAssignment:true,assignedTo:agent,expectedUpdatedAt:sms.updatedAt});
  assert.equal(triaged.productId,breathe);assert.equal(triaged.assignedToName,'Breathe Agent');assert.equal(triaged.status,'open');
  await assert.rejects(service.update(ownerToken,{id:sms.id,status:'closed',expectedUpdatedAt:sms.updatedAt}),error=>error.status===409,'a stale screen cannot overwrite triage');
  assert.ok(await find(item=>item.id===sms.id,agentToken),'the Breathe agent now sees the Breathe conversation');
  await assert.rejects(service.update(agentToken,{id:sms.id,changeProduct:true,productId:otherProduct,expectedUpdatedAt:triaged.updatedAt}),error=>error.status===403,'scoped staff cannot move work outside their application');
  await assert.rejects(service.update(ownerToken,{id:sms.id,changeAssignment:true,assignedTo:customer,expectedUpdatedAt:triaged.updatedAt}),error=>error.status===403,'customers cannot be assigned');

  // Notes stay internal; replies are recorded before sending and never sent twice.
  const noteKey=randomUUID();
  await service.note(agentToken,{id:sms.id,body:'Checked: account is active.',requestKey:noteKey});
  const noted=await service.note(agentToken,{id:sms.id,body:'Checked: account is active.',requestKey:noteKey});
  assert.equal(noted.messages.filter(message=>message.direction==='note').length,1);
  // A key replays only the exact text it first carried; edited text after an uncertain outcome needs a new key.
  await assert.rejects(service.note(agentToken,{id:sms.id,body:'Checked: account is locked.',requestKey:noteKey}),error=>error.status===400&&/different message/.test(error.message));
  const replyKey=randomUUID();
  assert.deepEqual(await service.reply(agentToken,{id:sms.id,body:'Please request a new code.',requestKey:replyKey}),{delivery:'sent',deliveryChannel:'sms',replay:false});
  assert.deepEqual(await service.reply(agentToken,{id:sms.id,body:'Please request a new code.',requestKey:replyKey}),{delivery:'sent',deliveryChannel:'sms',replay:true});
  await assert.rejects(service.reply(agentToken,{id:sms.id,body:'Please call us instead.',requestKey:replyKey}),error=>error.status===400&&/different message/.test(error.message));
  await assert.rejects(service.reply(agentToken,{id:sms.id,body:'Checked: account is active.',requestKey:noteKey}),error=>error.status===400&&/different message/.test(error.message));
  assert.deepEqual(sent.sms,[{to:'+12025550144',body:'Please request a new code.'}]);
  smsOutcome='unknown';
  assert.equal((await service.reply(agentToken,{id:sms.id,body:'Following up.',requestKey:randomUUID()})).delivery,'unknown');
  const thread=await service.get(agentToken,{id:sms.id});
  assert.equal(thread.status,'waiting');
  assert.deepEqual(thread.messages.map(message=>[message.direction,message.delivery]),[['inbound','received'],['inbound','received'],['note','recorded'],['outbound','sent'],['outbound','unknown']]);
  await text('+12025550144','That worked, thanks!','SM'+'3'.repeat(32));
  assert.equal((await service.get(agentToken,{id:sms.id})).status,'open','a customer reply reopens a waiting conversation');

  // Email: signed, product from plus-address, joins a thread only from the same sender.
  await email({from:'Pat Smith <pat@agency.test>',to:'support+penntrain@caremetric.ai',subject:'Course certificate missing',text:'My certificate did not appear.',headers:'Message-ID: <first@agency.test>',envelope:JSON.stringify({to:['support+penntrain@caremetric.ai'],from:'pat@agency.test'}),attachments:'0'});
  const mail=await find(item=>item.contactEmail==='pat@agency.test');created.push(mail.id);
  assert.equal(mail.productId,(await admin.query("select id from hub.products where slug='carebase'")).rows[0].id,'PennTrain mail routes to CareBase');
  await service.reply(ownerToken,{id:mail.id,body:'We reissued it.',requestKey:randomUUID()});
  assert.match(sent.email[0].subject,new RegExp(`\\[CM-${mail.reference}\\]`));assert.equal(sent.email[0].to,'pat@agency.test');
  await email({from:'pat@agency.test',to:'support@caremetric.ai',subject:`Re: Course certificate missing [CM-${mail.reference}]`,text:'Got it.',headers:'Message-ID: <second@agency.test>',dkim:'{@agency.test : pass}'});
  await email({from:'someone@else.test',to:'support@caremetric.ai',subject:`Re: [CM-${mail.reference}]`,text:'Injected?',headers:'Message-ID: <third@else.test>',dkim:'{@else.test : pass}'});
  // The same address without SendGrid confirming its domain: anyone can write that From header.
  await email({from:'pat@agency.test',to:'support@caremetric.ai',subject:`Re: [CM-${mail.reference}]`,text:'Change my address.',headers:'Message-ID: <forged@attacker.test>',SPF:'fail'});
  assert.equal((await service.get(ownerToken,{id:mail.id})).messageCount,3,'only the original, authenticated sender joins by reference');
  const other=await find(item=>item.contactEmail==='someone@else.test');created.push(other.id);
  assert.notEqual(other.id,mail.id);
  const forged=await find(item=>item.contactEmail==='pat@agency.test'&&item.id!==mail.id);created.push(forged.id);
  assert.notEqual(forged.id,mail.id,'a forged sender starts its own conversation');

  // Chat: an opaque token, internal notes hidden, staff replies visible, abuse limits.
  const chat=await service.startChat({name:'Visitor',email:'visitor@agency.test',product:'carebase',message:'How do I export OASIS data?',noPhi:true},'203.0.113.10');
  await assert.rejects(service.startChat({name:'Visitor',email:'visitor@agency.test',message:'Hi',noPhi:false},'203.0.113.10'),error=>error.status===400);
  await assert.rejects(communications({pool,delegations:{}}).startChat({name:'Visitor',email:'visitor@agency.test',message:'Hi',noPhi:true},'203.0.113.12'),error=>error.status===503,'chat stays off unless enabled');
  const chatRow=await find(item=>item.channel==='chat'&&item.contactEmail==='visitor@agency.test');created.push(chatRow.id);
  assert.equal(chatRow.productId,(await admin.query("select id from hub.products where slug='carebase'")).rows[0].id);
  await service.note(ownerToken,{id:chatRow.id,body:'Internal: route to CareBase team.',requestKey:randomUUID()});
  await service.reply(ownerToken,{id:chatRow.id,body:'Open Reports, then Export.',requestKey:randomUUID()});
  let visitorView=await service.readChat(chat.token);
  assert.deepEqual(visitorView.messages.map(message=>[message.from,message.body]),[['visitor','How do I export OASIS data?'],['support','Open Reports, then Export.']]);
  assert.ok(!JSON.stringify(visitorView).includes('Internal'),'visitors never see internal notes');
  visitorView=await service.postChat(chat.token,{message:'Thanks!'},'203.0.113.10');
  assert.equal(visitorView.messages.length,3);
  await assert.rejects(service.readChat('x'.repeat(43)),error=>error.status===403);
  await service.startChat({name:'V2',email:'v2@agency.test',message:'Second chat',noPhi:true},'203.0.113.10');
  await service.startChat({name:'V3',email:'v3@agency.test',message:'Third chat',noPhi:true},'203.0.113.10');
  await assert.rejects(service.startChat({name:'V4',email:'v4@agency.test',message:'Fourth chat',noPhi:true},'203.0.113.10'),error=>error.status===429,'one visitor cannot flood the inbox');
  for(const extra of (await list(ownerToken,{channel:'chat',limit:50})).items) if(!created.includes(extra.id)) created.push(extra.id);
  const closed=await service.get(ownerToken,{id:chatRow.id});
  await service.update(ownerToken,{id:chatRow.id,status:'closed',expectedUpdatedAt:closed.updatedAt});
  await assert.rejects(service.postChat(chat.token,{message:'Again'},'203.0.113.11'),error=>error.status===409);

  // Imports from the Breathe phone line and the Advisors form: once each, administrator only.
  await assert.rejects(service.sync(agentToken,{source:'breathe.phone'}),error=>error.status===401||error.status===403);
  assert.deepEqual(await service.sync(ownerToken,{source:'breathe.phone'}),{source:'breathe.phone',read:1,created:1,skipped:0,nextOffset:null});
  assert.deepEqual(await service.sync(ownerToken,{source:'advisors.web'}),{source:'advisors.web',read:1,created:1,skipped:0,nextOffset:null});
  const consult=await find(item=>item.channel==='web_form');created.push(consult.id);
  assert.equal(consult.productId,advisors);assert.equal(consult.status,'closed','a request already closed in Advisors does not reopen');
  const call=await find(item=>item.channel==='phone');created.push(call.id);
  assert.equal(call.productId,breathe,'PennFit calls route to Breathe');assert.equal(call.contactPhone,'+12025550171');assert.equal(call.inquiryType,'customer_service');
  await service.update(ownerToken,{id:call.id,status:'closed',expectedUpdatedAt:call.updatedAt});
  assert.deepEqual(await service.sync(ownerToken,{source:'breathe.phone'}),{source:'breathe.phone',read:1,created:0,skipped:1,nextOffset:null});
  assert.equal((await service.get(ownerToken,{id:call.id})).status,'closed','re-syncing never overwrites staff work');
  assert.deepEqual(adminReads.map(read=>read.operation),['phone.messages.list','inquiries.list','phone.messages.list']);
  assert.equal((await service.reply(ownerToken,{id:call.id,body:'Called back and resolved.',requestKey:randomUUID()})).deliveryChannel,'email','phone messages with an email reply by email');
  assert.equal(sent.email.at(-1).subject,`Re: Your phone message to CareMetric [CM-${call.reference}]`,'the caller sees a subject written for them');
  smsOutcome='sent';
  assert.equal((await list(ownerToken,{status:'active',search:'agency one',limit:50})).items[0]?.id,call.id,'search covers organizations');

  // Configuration: replies fail closed when a channel has no provider.
  const unconfigured=communications({pool,delegations:{},sms:{configured:false},email:{configured:false}});
  await assert.rejects(unconfigured.reply(ownerToken,{id:sms.id,body:'Hello',requestKey:randomUUID()}),error=>error.status===409&&/not configured/.test(error.message));
  assert.deepEqual(await unconfigured.channels(ownerToken),{sms:{inbound:false,replies:false},email:{inbound:false,replies:false},chat:{enabled:false},phone:{sync:true},webForm:{sync:true}});

  // Audit metadata never contains message text.
  const audit=(await admin.query("select action,metadata::text as metadata from private.audit_events where entity_type in ('communication','communication_source') and actor_id in ($1,$2)",[owner,agent])).rows;
  assert.ok(audit.length>=8);
  for(const row of audit) for(const secret of ['sign in','certificate','Reports','Checked','billing']) assert.ok(!row.metadata.toLowerCase().includes(secret.toLowerCase()),row.action);
  console.log('Unified communications: signed SMS and email, threading, scoped visibility, triage, notes, single-send replies, chat limits, imports and audit hygiene passed.');
} finally {
  const ids=(await admin.query("select id from private.communications where id=any($1::uuid[]) or contact_email in ('pat@agency.test','someone@else.test','visitor@agency.test','v2@agency.test','v3@agency.test','caller@agency.test','requester@agency.test') or contact_phone in ('+12025550144','+12025550145')",[created])).rows.map(row=>row.id);
  await admin.query('delete from private.communications where id=any($1::uuid[])',[ids]);
  await admin.query("delete from private.communication_rate_events");
  await admin.query('delete from private.audit_events where actor_id in ($1,$2,$3)',[owner,agent,customer]);
  await admin.query('delete from private.sms_sessions where user_id in ($1,$2,$3)',[owner,agent,customer]);
  await admin.query('delete from private.sms_identities where user_id in ($1,$2,$3)',[owner,agent,customer]);
  await admin.query('delete from private.staff_permissions where user_id in ($1,$2,$3)',[owner,agent,customer]);
  await admin.query('delete from hub.profiles where id in ($1,$2,$3)',[owner,agent,customer]);
  await admin.query('delete from auth.users where id in ($1,$2,$3)',[owner,agent,customer]);
  await pool.end();await admin.end();
}
