// Real PostgreSQL/session tests. Never run against a hosted database.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import pg from 'pg';
import {digest} from './sms-auth.mjs';
import {gateway} from './gateway.mjs';
const databaseUrl=process.env.HUB_TEST_DATABASE_URL;
const local=new URL(databaseUrl);assert.equal(local.hostname,'127.0.0.1');assert.equal(local.port,'54322');
const admin=new pg.Pool({connectionString:databaseUrl});
await admin.query("alter role hub_app_server login password 'ephemeral-test-only'");
const appUrl=new URL(databaseUrl);appUrl.username='hub_app_server';appUrl.password='ephemeral-test-only';
const pool=new pg.Pool({connectionString:appUrl.href});const api=gateway(pool);
const owner=randomUUID(),customer=randomUUID(),ownerToken='tenants-owner-'+randomUUID(),customerToken='tenants-customer-'+randomUUID(),staleToken='tenants-stale-'+randomUUID();
const ownerSession=randomUUID(),customerSession=randomUUID(),staleSession=randomUUID(),onboardedTenant=randomUUID();
const suffix=randomUUID().slice(0,8);
const tenantIds=[onboardedTenant];
const rpc=(name,args={},token=ownerToken)=>api.rpc(name,args,token);
const product=async slug=>(await admin.query('select id from hub.products where slug=$1',[slug])).rows[0].id;
const paid={access_status:'active',plan_name:'Agency',price_cents:49900,billing_interval:'month',complimentary:false,complimentary_reason:'',complimentary_until:'',notes:'Signed order form'};
const future=new Date(Date.now()+90*86400000).toISOString().slice(0,10);
const yesterday=new Date(Date.now()-86400000).toISOString().slice(0,10);
const free={...paid,plan_name:'Pilot',price_cents:9900,billing_interval:'year',complimentary:true,complimentary_reason:'Launch partner',complimentary_until:future,notes:''};
const create=(record,token=ownerToken)=>rpc('create_tenant',{p_record:record},token);
const saveTenant=(id,record,expected,token=ownerToken)=>rpc('save_tenant',{p_tenant_id:id,p_record:record,p_expected_updated_at:expected},token);
const saveSubscription=(id,productId,record,version,token=ownerToken)=>rpc('save_tenant_subscription',{p_tenant_id:id,p_product_id:productId,p_record:record,p_expected_version:version},token);
const contractMigration=await readFile(new URL('../supabase/migrations/20261021140100_tenant_subscriptions_contract.sql',import.meta.url),'utf8');
try{
  const contractConnection=await admin.connect();
  try{
    const current=(await contractConnection.query('select hub.get_backend_contract() as data')).rows[0].data;
    assert.ok(current.features.includes('platform.admin.tenants.v1'));
    await contractConnection.query(contractMigration);
    assert.deepEqual((await contractConnection.query('select hub.get_backend_contract() as data')).rows[0].data,current,'declaration is idempotent');
    for(const change of [
      'alter table private.tenant_subscriptions rename to fixture_missing_tenant_subscriptions',
      'alter table private.tenant_subscriptions disable row level security',
      'grant select on private.tenant_subscriptions to authenticated',
      'grant select on private.tenant_subscriptions to hub_app_server',
      'grant execute on function private.tenant_account(uuid) to authenticated',
      'alter function hub.list_tenant_accounts() rename to fixture_missing_tenant_list',
      'grant execute on function hub.list_tenant_accounts() to anon',
      'grant execute on function hub.create_tenant(jsonb) to anon',
      "create or replace function hub.save_tenant(p_tenant_id uuid,p_record jsonb,p_expected_updated_at timestamptz) returns jsonb language plpgsql security definer set search_path='' as $$ begin perform hub.authorize_app_admin(); return null; end $$",
    ]){
      await contractConnection.query('begin');
      try{await contractConnection.query(change);await assert.rejects(contractConnection.query(contractMigration),error=>error.code==='55000');}
      finally{await contractConnection.query('rollback');}
    }
  }finally{contractConnection.release();}
  const [carebase,breathe,pennsync]=[await product('carebase'),await product('breathe'),await product('pennsync')];
  await admin.query("insert into auth.users(id,email,is_anonymous) values($1,'tenant-owner@test.invalid',false),($2,'tenant-customer@test.invalid',false)",[owner,customer]);
  await admin.query("insert into private.staff_permissions(user_id,permission) values($1,'platform.admin')",[owner]);
  await admin.query("insert into private.sms_identities(user_id,phone_e164,verified_at) values($1,'+12025550891',now()),($2,'+12025550892',now())",[owner,customer]);
  for(const [id,user,token,started] of [[ownerSession,owner,ownerToken,'0'],[customerSession,customer,customerToken,'0'],[staleSession,owner,staleToken,'9']])
    await admin.query("insert into private.sms_sessions(id,token_hash,user_id,identity_version,created_at,expires_at) select $1,$2,user_id,identity_version,now()-make_interval(hours=>$4::int),now()+interval '1 hour' from private.sms_identities where user_id=$3",[id,digest(token),user,started]);
  // A tenant created by app onboarding has access but no recorded pricing yet.
  await admin.query("insert into hub.tenants(id,slug,name) values($1,$2,'Onboarded Fixture Agency')",[onboardedTenant,'support-'+onboardedTenant]);
  await admin.query('insert into hub.tenant_products(tenant_id,product_id) values($1,$2)',[onboardedTenant,breathe]);

  const record={name:'Synthetic Home Health '+suffix,slug:'synthetic-home-health-'+suffix,industry:'Home health',subscriptions:[{product_id:carebase,...paid},{product_id:breathe,...free}]};
  await assert.rejects(rpc('list_tenant_accounts',{},null));
  await assert.rejects(rpc('list_tenant_accounts',{},customerToken));
  await assert.rejects(create(record,customerToken));
  await assert.rejects(pool.query('select * from private.tenant_subscriptions'),'app server has no direct table access');
  await assert.rejects(create(record,staleToken),'changes need a command session started within eight hours');
  assert.ok(Array.isArray((await rpc('list_tenant_accounts',{},staleToken)).tenants),'an older session can still read');

  for(const invalid of [
    {...record,role:'platform_admin'},{...record,name:' '},{...record,name:'x'.repeat(181)},{...record,industry:'x'.repeat(121)},{...record,subscriptions:null},
    {...record,slug:'Not A Slug'},{...record,slug:'double--hyphen'},{...record,slug:'carebase-12'},{...record,slug:'support-'+suffix},
    {...record,subscriptions:[{product_id:carebase,...paid},{product_id:carebase,...paid}]},
    {...record,subscriptions:[{product_id:'not-a-uuid',...paid}]},
    {...record,subscriptions:[{product_id:randomUUID(),...paid}]},
    {...record,subscriptions:[{product_id:carebase,...paid,price_cents:0}]},
    {...record,subscriptions:[{product_id:carebase,...paid,price_cents:-100}]},
    {...record,subscriptions:[{product_id:carebase,...paid,price_cents:10.5}]},
    {...record,subscriptions:[{product_id:carebase,...paid,price_cents:'49900'}]},
    {...record,subscriptions:[{product_id:carebase,...paid,price_cents:100000001}]},
    {...record,subscriptions:[{product_id:carebase,...paid,billing_interval:'week'}]},
    {...record,subscriptions:[{product_id:carebase,...paid,access_status:'trial'}]},
    {...record,subscriptions:[{product_id:carebase,...paid,complimentary_reason:'Not free'}]},
    {...record,subscriptions:[{product_id:carebase,...paid,stripe_price:'price_123'}]},
    {...record,subscriptions:[{product_id:carebase,...free,complimentary_reason:' '}]},
    {...record,subscriptions:[{product_id:carebase,...free,price_cents:0}]},
    {...record,subscriptions:[{product_id:carebase,...free,complimentary_until:yesterday}]},
    {...record,subscriptions:[{product_id:carebase,...free,complimentary_until:'2026-02-31'}]},
    {...record,subscriptions:[{product_id:carebase,...paid,notes:'x'.repeat(1001)}]},
    {...record,subscriptions:[{product_id:carebase,...paid,plan_name:'tab\tname'}]},
  ]) await assert.rejects(create(invalid),JSON.stringify(invalid).slice(0,160));

  const created=await create(record);tenantIds.push(created.id);
  assert.equal(created.slug,record.slug);assert.equal(created.status,'active');assert.equal(created.linked,false);assert.equal(created.member_count,0);
  assert.deepEqual(created.subscriptions.map(item=>[item.product_slug,item.access_status,item.pricing.price_cents,item.pricing.billing_interval,item.pricing.complimentary,item.pricing.version]),
    [['breathe','active',9900,'year',true,1],['carebase','active',49900,'month',false,1]],'applications are listed by name');
  assert.equal(created.subscriptions[0].pricing.complimentary_until,future);
  await assert.rejects(create({...record,name:'Another agency'}),'duplicate slugs never create another tenant');

  // A complimentary subscription without an end date can carry no price.
  const freeForever=await create({name:'Free Forever '+suffix,slug:'free-forever-'+suffix,industry:'',subscriptions:[{product_id:pennsync,...free,price_cents:0,complimentary_until:''}]});tenantIds.push(freeForever.id);
  assert.equal(freeForever.subscriptions[0].pricing.price_cents,0);assert.equal(freeForever.industry,'');

  await assert.rejects(saveTenant(created.id,{name:'Renamed',industry:'',status:'suspended'},'2000-01-01T00:00:00Z'),'stale tenant edits cannot overwrite');
  await assert.rejects(saveTenant(created.id,{name:'Renamed',industry:'',status:'suspended',slug:'renamed'},created.updated_at),'the slug never changes');
  await assert.rejects(saveTenant(created.id,{name:'Renamed',industry:'',status:'deleted'},created.updated_at));
  await assert.rejects(saveTenant(created.id,{name:'Renamed',industry:'',status:'suspended'},created.updated_at,staleToken));
  const renamed=await saveTenant(created.id,{name:'Renamed Agency '+suffix,industry:'Hospice',status:'suspended'},created.updated_at);
  assert.equal(renamed.name,'Renamed Agency '+suffix);assert.equal(renamed.status,'suspended');assert.equal(renamed.slug,record.slug);assert.equal(renamed.industry,'Hospice');
  await assert.rejects(saveTenant(created.id,{name:'Again',industry:'',status:'active'},created.updated_at),'the earlier revision is stale');

  // Edit pricing: make the paid subscription free, then paid again at a new price.
  await assert.rejects(saveSubscription(created.id,carebase,{...paid,price_cents:59900},0),'an existing subscription needs its version');
  await assert.rejects(saveSubscription(created.id,carebase,{...paid,price_cents:59900},2),'a future version is stale');
  const comped=await saveSubscription(created.id,carebase,{...paid,complimentary:true,complimentary_reason:'Service credit',complimentary_until:''},1);
  const compedCarebase=comped.subscriptions.find(item=>item.product_id===carebase).pricing;
  assert.deepEqual([compedCarebase.complimentary,compedCarebase.complimentary_reason,compedCarebase.price_cents,compedCarebase.version],[true,'Service credit',49900,2]);
  const repriced=await saveSubscription(created.id,carebase,{...paid,price_cents:59900,billing_interval:'year',access_status:'suspended'},2);
  const repricedCarebase=repriced.subscriptions.find(item=>item.product_id===carebase);
  assert.deepEqual([repricedCarebase.access_status,repricedCarebase.pricing.price_cents,repricedCarebase.pricing.billing_interval,repricedCarebase.pricing.complimentary,repricedCarebase.pricing.version],['suspended',59900,'year',false,3]);
  await assert.rejects(saveSubscription(created.id,pennsync,{...paid},1),'a new application starts at version zero');
  const added=await saveSubscription(created.id,pennsync,{...paid,plan_name:'Sync'},0);
  assert.deepEqual(added.subscriptions.map(item=>item.product_slug),['breathe','carebase','pennsync']);
  await assert.rejects(saveSubscription(created.id,pennsync,{...paid},0),'an application is added once');
  await assert.rejects(saveSubscription(randomUUID(),pennsync,{...paid},0),'unknown tenants are refused');
  await assert.rejects(saveSubscription(created.id,breathe,{...free,complimentary_until:yesterday},1),'a new end date cannot be in the past');

  // Pricing an onboarded tenant's existing access keeps its access row.
  const listed=await rpc('list_tenant_accounts');
  const onboarded=listed.tenants.find(tenant=>tenant.id===onboardedTenant);
  assert.equal(onboarded.subscriptions.length,1);assert.equal(onboarded.subscriptions[0].pricing,null);
  assert.ok(listed.products.some(item=>item.slug==='advisors')&&listed.products.every(item=>item.status!=='retired'));
  const priced=await saveSubscription(onboardedTenant,breathe,{...paid,access_status:'active'},0);
  assert.equal(priced.subscriptions[0].pricing.version,1);
  assert.equal((await admin.query('select count(*)::int as n from hub.tenant_products where tenant_id=$1',[onboardedTenant])).rows[0].n,1);

  // The audit trail carries actions, states and amounts, never plan names, reasons or notes.
  const audit=(await admin.query("select action,product_id,metadata from private.audit_events where actor_id=$1 order by id",[owner])).rows;
  assert.deepEqual(audit.map(row=>row.action),['tenant.create','tenant_subscription.add','tenant_subscription.add','tenant.create','tenant_subscription.add','tenant.update','tenant_subscription.update','tenant_subscription.update','tenant_subscription.add','tenant_subscription.add']);
  assert.deepEqual(audit[7].metadata,{version:3,access_status:'suspended',price_cents:59900,billing_interval:'year',complimentary:false,complimentary_until:null});
  const auditText=JSON.stringify(audit);
  for(const text of ['Service credit','Launch partner','Signed order form','Agency','Hospice']) assert.equal(auditText.includes(text),false,text);

  await admin.query('update private.staff_permissions set revoked_at=now() where user_id=$1',[owner]);
  await assert.rejects(rpc('list_tenant_accounts'));await assert.rejects(saveTenant(created.id,{name:'X Agency',industry:'',status:'active'},renamed.updated_at));
  await admin.query('update private.staff_permissions set revoked_at=null where user_id=$1',[owner]);
  await admin.query("update auth.users set banned_until=now()+interval '1 hour' where id=$1",[owner]);
  await assert.rejects(rpc('list_tenant_accounts'));
  await admin.query('update auth.users set banned_until=null where id=$1',[owner]);
  await admin.query('update private.sms_sessions set revoked_at=now() where id=$1',[ownerSession]);
  await assert.rejects(rpc('list_tenant_accounts'));
  assert.equal((await admin.query("select relrowsecurity from pg_class where oid='private.tenant_subscriptions'::regclass")).rows[0].relrowsecurity,true);
  console.log('Tenant setup: real administrator and command sessions, customer denial, revocation, validation, reserved slugs, duplicates, version conflicts, complimentary pricing and bounded audit passed.');
}finally{
  await admin.query('delete from hub.tenants where id=any($1::uuid[])',[tenantIds]);
  await admin.query('delete from private.audit_events where actor_id in ($1,$2)',[owner,customer]);
  await admin.query('delete from private.sms_sessions where user_id in ($1,$2)',[owner,customer]);
  await admin.query('delete from private.sms_identities where user_id in ($1,$2)',[owner,customer]);
  await admin.query('delete from private.staff_permissions where user_id in ($1,$2)',[owner,customer]);
  await admin.query('delete from auth.users where id in ($1,$2)',[owner,customer]);
  await pool.end();await admin.end();
}
