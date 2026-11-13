// Real scoped app authentication and billing-trigger lifecycle behavior. Disposable loopback database only; no network calls.
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import pg from 'pg';
import { growthService } from './growth/service.mjs';
import { growthStore } from './growth/store.mjs';
const local = new URL(process.env.HUB_TEST_DATABASE_URL);
assert.equal(local.hostname, '127.0.0.1'); assert.equal(local.port, '54322');
const admin = new pg.Pool({ connectionString: local.href });
await admin.query("alter role hub_app_server login password 'ephemeral-test-only'");
local.username = 'hub_app_server'; local.password = 'ephemeral-test-only';
const pool = new pg.Pool({ connectionString: local.href });
const run = randomUUID().replaceAll('-', '').slice(0, 12);
const tenants = [], prospects = [];
const row = async (sql, args = []) => (await admin.query(sql, args)).rows[0];
const call = async (sql, args = []) => (await pool.query(sql, args)).rows[0];
const product = (await row("select id from hub.products where slug='caremetric-intel'")).id;
const service = growthService({ store: growthStore(pool), features: new Set(['platform.agents.customer-growth.v1','platform.agents.app-growth.v1']) });
const appKey = 'cmb_' + 'x'.repeat(43);
const keyHash = createHash('sha256').update(appKey).digest('hex');
const subId = suffix => `sub_lifecycle${run}${suffix}`;
const invoiceId = suffix => `in_lifecycle${run}${suffix}`;
const customer = async (suffix, email = '') => {
 const id = randomUUID(); tenants.push(id);
 await admin.query('insert into hub.tenants(id,slug,name) values($1,$2,$3)', [id,`lifecycle-${run}-${suffix.toLowerCase()}`,'Synthetic lifecycle customer']);
 const stripe = `cus_lifecycle${run}${suffix}`;
 await admin.query('insert into private.billing_customers(tenant_id,stripe_customer_id,email,livemode,seen_at) values($1,$2,$3,true,now())',[id,stripe,email]);
 return {id,stripe};
};
const subscription = async (buyer, suffix, {trial=false,old=false,live=true}={}) => {
 await admin.query(`insert into private.billing_subscriptions(stripe_subscription_id,tenant_id,stripe_customer_id,product_id,status,collection_method,livemode,stripe_created,seen_at,trial_start,trial_end)
 values($1,$2,$3,$4,$5,'charge_automatically',$6,case when $7 then now()-interval '60 days' else clock_timestamp() end,clock_timestamp(),
 case when $8 then clock_timestamp() else null end,case when $8 then clock_timestamp()+interval '14 days' else null end)`,[subId(suffix),buyer.id,buyer.stripe,product,trial?'trialing':'active',live,old,trial]);
};
const invoice = async (buyer, suffix, sub, {paid=true,old=false,live=true,unresolved=false}={}) => {
 await admin.query(`insert into private.billing_invoices(stripe_invoice_id,tenant_id,stripe_customer_id,stripe_subscription_id,product_id,status,currency,total,subtotal,amount_due,amount_paid,amount_remaining,livemode,stripe_created,seen_at)
 values($1,$2,$3,$4,$5,$6,'usd',100,100,100,$7,$8,$9,case when $10 then now()-interval '40 days' else clock_timestamp() end,clock_timestamp())`,
 [invoiceId(suffix),buyer.id,buyer.stripe,subId(sub),unresolved?null:product,paid?'paid':'open',paid?100:0,paid?0:100,live,old]);
};
const queued = async (buyer, kind) => Number((await row('select count(*) as n from private.growth_billing_outbox where tenant_id=$1 and kind=$2',[buyer.id,kind])).n);
try {
 await admin.query('insert into private.billing_app_keys(product_id,key_hash,key_hint) values($1,$2,$3)',[product,keyHash,run.slice(0,4)]);
 const linked=await customer('linked');
 const issuer=(await row('select private.billing_issuer($1) as id',[product])).id;
 const account='000000000000'+run;
 await admin.query('insert into private.federated_tenants(issuer_id,external_tenant_hash,hub_tenant_id) values($1,private.support_identity_hash($2),$3)',[issuer,account,linked.id]);
 const body={account,eventKey:randomUUID(),kind:'first_value',occurredAt:new Date().toISOString(),facts:{metric:'provider_lists',count:1}};
 await service.appActivity('Bearer '+appKey,{...body,kind:'heartbeat',eventKey:randomUUID(),facts:{}});
 await admin.query("update private.growth_opportunities set owner_agent='marketing_manager',stage='qualified' where organization_id in(select id from private.growth_organizations where tenant_id=$1)",[linked.id]);
 await service.appActivity('Bearer '+appKey,{...body,kind:'heartbeat',eventKey:randomUUID(),facts:{}});
 assert.deepEqual(await row("select o.owner_agent,o.stage from private.growth_opportunities o join private.growth_organizations g on g.id=o.organization_id where g.tenant_id=$1",[linked.id]),{owner_agent:'account_manager',stage:'nurture'},'an existing linked prospect leaves cold outreach on its first customer heartbeat');
 assert.equal((await service.appActivity('Bearer '+appKey,body)).replay,false);
 assert.deepEqual(await service.appActivity('Bearer '+appKey,body),{replay:true});
 const org=await row('select id,domain from private.growth_organizations where tenant_id=$1',[linked.id]);
 assert.equal(org.domain,`customer-${linked.id}.invalid`);
 assert.equal((await row('select stage from private.growth_opportunities where organization_id=$1 and product=$2',[org.id,'caremetric-intel'])).stage,'activated');
 await assert.rejects(service.appActivity('Bearer '+appKey,{...body,account:'ffffffffffffffffffffffff',eventKey:randomUUID()}),error=>error.status===503);
 await admin.query('update private.billing_app_keys set revoked_at=now() where key_hash=$1',[keyHash]);
 await assert.rejects(service.appActivity('Bearer '+appKey,body),error=>error.status===401);
 await admin.query('update private.billing_app_keys set revoked_at=null where key_hash=$1',[keyHash]);

 const fresh=await customer('fresh');await subscription(fresh,'fresh',{trial:true});
 assert.equal(await queued(fresh,'trial_started'),1,'authoritative trial is captured');
 await invoice(fresh,'fresh','fresh',{paid:false});assert.equal(await queued(fresh,'paid'),0,'open invoice is not a purchase');
 await admin.query("update private.billing_invoices set status='paid',amount_paid=100,amount_remaining=0,seen_at=clock_timestamp() where stripe_invoice_id=$1",[invoiceId('fresh')]);
 assert.equal(await queued(fresh,'paid'),1,'failed/open payment recovery creates a verified purchase');
 await admin.query('update private.billing_invoices set seen_at=clock_timestamp() where stripe_invoice_id=$1',[invoiceId('fresh')]);
 await invoice(fresh,'renewal','fresh');assert.equal(await queued(fresh,'paid'),1,'retries and renewals do not create new buyers');
 const legacy=await customer('old');await subscription(legacy,'old',{old:true});await invoice(legacy,'old','old');
 assert.equal(await queued(legacy,'paid'),0,'old active subscription with unknown invoice history is not called new');
 const previous=await customer('previous');await subscription(previous,'previous',{old:true});await invoice(previous,'previous','previous',{old:true});
 await subscription(previous,'second');await invoice(previous,'second','second');assert.equal(await queued(previous,'paid'),0,'prior tenant purchase excludes another subscription');
 const delayed=await customer('delayed');await subscription(delayed,'delayed');await invoice(delayed,'delayed','delayed',{unresolved:true});
 assert.equal(await queued(delayed,'paid'),1,'subscription product resolves invoice without metadata');await admin.query('update private.billing_invoices set product_id=$1 where stripe_invoice_id=$2',[product,invoiceId('delayed')]);
 assert.equal(await queued(delayed,'paid'),1,'later invoice metadata cannot duplicate payment');
 const reordered=await customer('reordered');await invoice(reordered,'reordered','reordered',{unresolved:true});
 assert.equal(await queued(reordered,'paid'),0);await subscription(reordered,'reordered');
 assert.equal(await queued(reordered,'paid'),1,'invoice before subscription is reconciled when subscription arrives');
 const reorderedPair=await customer('reorderedPair');await invoice(reorderedPair,'reorderedPair1','reorderedPair',{unresolved:true});await invoice(reorderedPair,'reorderedPair2','reorderedPair',{unresolved:true});
 await subscription(reorderedPair,'reorderedPair');assert.equal(await queued(reorderedPair,'paid'),1,'initial payment plus proration before subscription still counts one conversion');
 const test=await customer('test');await subscription(test,'test',{trial:true,live:false});await invoice(test,'test','test',{live:false});
 assert.equal(await queued(test,'paid'),0);assert.equal(await queued(test,'trial_started'),0,'test mode does not report conversions');

 // A prospect who starts a trial keeps the prospect's organization: the trial lands on its opportunity and queued cold email stops.
 const prospectDomain=`prospect-${run}.example`;
 const prospectOrg=(await row('insert into private.growth_organizations(name,domain) values($1,$2) returning id',['Synthetic prospect',prospectDomain])).id;prospects.push(prospectOrg);
 const prospectContact=(await row("insert into private.growth_contacts(organization_id,email,eligibility) values($1,$2,'permitted') returning id",[prospectOrg,`owner@${prospectDomain}`])).id;
 const prospectOpportunity=(await row("insert into private.growth_opportunities(organization_id,product,contact_id,stage) values($1,'caremetric-intel',$2,'contacted') returning id",[prospectOrg,prospectContact])).id;
 const coldDraft=(await row(`insert into private.growth_messages(opportunity_id,contact_id,purpose,subject,body,opportunity_version,contact_version,policy_version,unsubscribe_hash,status)
  values($1,$2,'marketing','A question','Which counties do you cover?',1,1,1,$3,'proposed') returning id`,[prospectOpportunity,prospectContact,'u'.repeat(64)])).id;
 const converted=await customer('converted',`Owner@${prospectDomain}`);await subscription(converted,'converted',{trial:true});
 assert.equal(await queued(converted,'trial_started'),1);

 // Held checkouts ahead of valid rows must not consume the entire batch. Expired rows must not poison retries.
 await admin.query(`insert into private.billing_subscriptions(stripe_subscription_id,tenant_id,stripe_customer_id,product_id,status,collection_method,livemode,stripe_created,seen_at)
 select $1||n,$2,$3,$4,'active','charge_automatically',true,now(),now() from generate_series(1,101) n`,[subId('hold'),linked.id,linked.stripe,product]);
 await admin.query("insert into private.customer_checkout_holds(stripe_subscription_id) select stripe_subscription_id from private.billing_subscriptions where stripe_subscription_id like $1",[subId('hold')+'%']);
 await admin.query(`insert into private.growth_billing_outbox(event_key,tenant_id,product,kind,subscription_id,occurred_at,created_at)
 select 'held:'||stripe_subscription_id,tenant_id,'caremetric-intel','paid',stripe_subscription_id,now(),now()-interval '1 hour' from private.billing_subscriptions where stripe_subscription_id like $1`,[subId('hold')+'%']);
 await admin.query("insert into private.growth_billing_outbox(event_key,tenant_id,product,kind,subscription_id,occurred_at) values($1,$2,'caremetric-intel','paid',$3,now()-interval '90 days')",['expired:'+run,linked.id,subId('fresh')]);
 const result=await call('select private.growth_drain_billing() as n');assert.ok(result.n>=3,'valid rows are drained behind more than 100 held records');
 assert.equal((await row('select expired_at is not null as expired from private.growth_billing_outbox where event_key=$1',['expired:'+run])).expired,true);
 assert.equal((await call('select private.growth_drain_billing() as n')).n,0,'drain replays no events');
 assert.equal((await row('select tenant_id from private.growth_organizations where id=$1',[prospectOrg])).tenant_id,converted.id,'the trial is linked to the prospect it came from');
 assert.equal((await row("select count(*)::integer as n from private.growth_organizations where domain=$1",[`customer-${converted.id}.invalid`])).n,0,'no second organization');
 assert.deepEqual(await row('select stage,owner_agent,contact_id from private.growth_opportunities where id=$1',[prospectOpportunity]),{stage:'trial',owner_agent:'account_manager',contact_id:prospectContact});
 assert.equal((await row('select status from private.growth_messages where id=$1',[coldDraft])).status,'cancelled','queued cold email to a business in trial stops');
 assert.deepEqual((await row("select metadata from private.audit_events where action='growth.customer_linked' and entity_id=$1",[prospectOrg])).metadata,{product:'caremetric-intel',match:'contact'});
 // Found again by discovery, the customer's real domain is not prospected for the other product.
 assert.equal((await call('select private.growth_discover($1,$2::jsonb) as n',['carebase',JSON.stringify([{name:'Synthetic prospect',domain:prospectDomain,url:`https://${prospectDomain}/about`,claim:'Home care agency.'}])])).n,0);
 assert.equal((await row("select count(*)::integer as n from private.growth_opportunities where organization_id=$1 and product='carebase'",[prospectOrg])).n,0);
 const facts=(await call("select private.agent_scorecard_facts(now()-interval '1 day',now()+interval '1 minute') as value")).value;
 assert.ok(facts.lifecycleStartedAt);
 const intel=facts.products.find(p=>p.product==='caremetric-intel');assert.ok(intel.verifiedPaid>=2);assert.ok(intel.verifiedTrialStarts>=1);
 console.log('Application activity, authoritative trials/payments, renewal exclusions, retries and scorecard coverage passed.');
} finally {
 await admin.query('delete from private.billing_app_keys where key_hash=$1',[keyHash]);
 await admin.query('delete from private.growth_billing_outbox where tenant_id=any($1::uuid[])',[tenants]);
 const orgs=(await admin.query('select id from private.growth_organizations where tenant_id=any($1::uuid[]) or id=any($2::uuid[])',[tenants,prospects])).rows.map(r=>r.id);
 await admin.query('delete from private.growth_messages where opportunity_id in(select id from private.growth_opportunities where organization_id=any($1::uuid[]))',[orgs]);
 await admin.query('delete from private.customer_success_plans where opportunity_id in(select id from private.growth_opportunities where organization_id=any($1::uuid[]))',[orgs]);
 await admin.query("delete from private.audit_events where action='growth.customer_linked' and entity_id=any($1::uuid[])",[orgs]);
 await admin.query('delete from private.customer_activity_events where organization_id in(select id from private.growth_organizations where tenant_id=any($1::uuid[]))',[tenants]);
 await admin.query('delete from private.growth_opportunities where organization_id in(select id from private.growth_organizations where tenant_id=any($1::uuid[]))',[tenants]);
 await admin.query('delete from private.customer_activity_events where organization_id=any($1::uuid[])',[orgs]);
 await admin.query('delete from private.growth_opportunities where organization_id=any($1::uuid[])',[orgs]);
 await admin.query('delete from private.growth_contacts where organization_id=any($1::uuid[])',[orgs]);
 await admin.query('delete from private.growth_organizations where id=any($1::uuid[])',[orgs]);
 await admin.query('delete from private.customer_checkout_holds where stripe_subscription_id like $1',[`sub_lifecycle${run}%`]);
 await admin.query('delete from private.billing_invoices where tenant_id=any($1::uuid[])',[tenants]);
 await admin.query('delete from private.billing_subscriptions where tenant_id=any($1::uuid[])',[tenants]);
 await admin.query('delete from private.billing_customers where tenant_id=any($1::uuid[])',[tenants]);
 await admin.query('delete from private.federated_tenants where hub_tenant_id=any($1::uuid[])',[tenants]);
 await admin.query('delete from hub.tenants where id=any($1::uuid[])',[tenants]);
 await pool.end();await admin.end();
}
