import { createHmac, createPublicKey, createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { HttpError } from '../sms-auth.mjs';
import { live } from '../live.mjs';
import { sendgridSignatureValid } from '../communications.mjs';
import { leadSignature } from '../leads.mjs';
import { sesGrowthEvents } from '../ses.mjs';
import { activitySchema, appActivitySchema } from './protocol.mjs';
import { products, stages } from './policy.mjs';
const uuid=z.uuid(), text=(n)=>z.string().max(n), instant=z.iso.datetime({offset:true});
const https=z.union([z.literal(''),z.url().refine(v=>new URL(v).protocol==='https:' && !new URL(v).username && !new URL(v).password)]);
export const growthSchemas={
 create:z.object({name:text(200).min(1),domain:text(253).regex(/^[a-z0-9][a-z0-9.-]+\.[a-z]{2,}$/),product:z.enum(products),email:z.union([z.literal(''),z.email()]),contactName:text(200),role:text(200),goal:text(2000),tenantId:uuid.optional(),internal:z.boolean().optional()}).strict(),
 opportunity:z.object({id:uuid,internal:z.boolean().optional(),tenantId:z.union([z.literal(''),uuid]).optional(),version:z.number().int().positive(),stage:z.enum(stages),goal:text(2000),nextAction:text(500).min(1),nextAt:instant,trialEnd:z.union([z.literal(''),instant]),renewalAt:z.union([z.literal(''),instant]),memory:z.object({promises:text(2000).optional(),blockers:text(2000).optional(),objections:text(2000).optional(),lossReason:text(2000).optional()}).strict()}).strict(),
 contact:z.object({id:uuid,version:z.number().int().positive(),eligibility:z.enum(['review','permitted','opted_out','undeliverable']),verified:z.boolean(),sourceUrl:https}).strict(),
 evidence:z.object({opportunityId:uuid,sourceUrl:z.url().refine(v=>new URL(v).protocol==='https:'),claim:text(4000).min(1),confidence:z.enum(['low','medium','high']),observedAt:instant}).strict(),
 policy:z.object({product:z.enum(products),version:z.number().int().positive(),enabled:z.boolean(),autoSend:z.boolean(),experimentEnabled:z.boolean().default(false),dailyLimit:z.number().int().min(1).max(100),minGapHours:z.number().int().min(24).max(720),maxTouches:z.number().int().min(1).max(3),bookingUrl:https,approvedClaim:text(1000)}).strict(),
 reconcile:z.object({id:uuid,status:z.enum(['delivered','failed']),reference:text(500).min(3)}).strict(),
 resolve:z.object({id:uuid,outcome:text(2000).min(1)}).strict(),
};
export { activitySchema } from './protocol.mjs';
/** One imported prospect: the business (name and its own domain), the product, and optionally a work address on that domain. */
export const importSchema=z.object({rows:z.array(z.object({name:text(200).min(1),domain:text(253).min(4),product:z.enum(products).optional(),email:z.union([z.literal(''),z.email().max(320)]).optional(),
  contactName:text(200).optional(),role:text(200).optional()}).strict()).min(1).max(500)}).strict();
const hash=value=>createHash('sha256').update(value).digest('hex');
const equal=(a,b)=>{const x=Buffer.from(String(a)),y=Buffer.from(String(b));return x.length===y.length&&timingSafeEqual(x,y);};
// A failure that must not opt the contact out (a transient or undetermined bounce, a reject) needs the five-argument delivery event
// (20261113280000_growth_soft_bounce_reporting.sql). Until its contract declares this feature such an event is not recorded, as before.
export const growthSoftBounceFeature='platform.agents.growth-soft-bounce.v1';
export function growthService({store,research,contacts=null,roster=null,people=null,deepResearch=null,learning=null,briefs=null,views=null,reports=null,importKey='',features,enabled=false,signingKey='',eventKeys={},webhookPublicKey='',sesEvents=null,sesEventsReady=()=>false,publicOrigin,postalAddress=''}) {
  // The sending switch and the footer's postal address are Hub settings; either may be a function, read on each use.
  const sending=()=>live(enabled)===true; const postal=()=>String(live(postalAddress)??'');
  // How far the people step goes for an address (Settings → Customer growth → Finding people's addresses), and whether the businesses'
  // mail servers can be reached from here. Before the finder's migration only CMS owners are recorded.
  const peopleServices=()=>{const finder=features?.has('platform.agents.growth-people-finder.v1')===true,mode=live(people?.mode);
    return {finder,mode:finder&&['none','published','verify'].includes(mode)?mode:'none',mailServer:people?.mailbox?.state?.()??'unknown'};};
  const ready=()=>{if(!features?.has('platform.agents.customer-growth.v1'))throw new HttpError(503,'Apply the growth database migration first.');};
  const safe=async work=>{try{return await work();}catch(e){if(e instanceof HttpError)throw e; if(['22023','22007','23514','23503','23505'].includes(e?.code))throw new HttpError(400,'Check the growth record and its references.'); if(e?.code==='40001')throw new HttpError(409,'This record changed. Refresh and review it again.'); if(e?.code==='28000')throw new HttpError(401,'Sign in again.'); if(e?.code==='42501')throw new HttpError(403,'Not permitted.'); throw e;}};
  const parse=(schema,input)=>{const parsed=schema.safeParse(input); if(!parsed.success)throw new HttpError(400,'Invalid growth request.');return parsed.data;};
  const unsubscribeToken=workId=>createHmac('sha256',signingKey).update(`growth:${workId}`).digest('hex');
  return {
    ready, store, research, contacts, roster, people, deepResearch, learning, briefs, views, reports, get enabled(){return sending();}, unsubscribeToken, hash, signingReady:signingKey.length>=32,
    // Configuration only: no provider request and no credential value leaves this service.
    readiness() {
      let deliveryFeedback = false;
      try { createPublicKey(webhookPublicKey.includes('BEGIN') ? webhookPublicKey : { key: Buffer.from(webhookPublicKey, 'base64'), format: 'der', type: 'spki' }); deliveryFeedback = true; } catch { /* Missing or invalid key. */ }
      // Amazon SES events (docs/AMAZON_SES.md) count too: either service's delivery feedback reaches the growth record.
      if (sesEventsReady() === true) deliveryFeedback = true;
      return { sending: sending(), signing: signingKey.length >= 32, postalAddress: Boolean(postal().trim()), publicOrigin: /^https:\/\//.test(publicOrigin ?? ''),
        research: research?.configured === true, deliveryFeedback, appEvents: features?.has('platform.agents.app-growth.v1') === true,
        events: Object.fromEntries(products.map(product => [product, typeof eventKeys[product] === 'string' && eventKeys[product].length >= 32])) };
    },
    configured:()=>sending()&&signingKey.length>=32&&postal().trim().length>0&&/^https:\/\//.test(publicOrigin??''),
    async admin(token,input) {
      ready(); const {operation,data}=parse(z.object({operation:z.string(),data:z.record(z.string(),z.unknown()).default({})}).strict(),input);
      if(operation==='workspace') {const {offset}=parse(z.object({offset:z.number().int().min(0).default(0)}).strict(),data);return safe(async()=>({...await store.workspace(token,offset),services:{sending:sending(),signing:signingKey.length>=32,postalAddress:Boolean(postal().trim()),research:Boolean(research?.configured),roster:features?.has('platform.agents.growth-roster.v1')===true,people:features?.has('platform.agents.growth-people.v1')===true,learning:features?.has('platform.agents.growth-learning.v1')===true,addressCheck:features?.has('platform.agents.growth-address-check.v1')===true,briefs:features?.has('platform.agents.growth-brief.v1')===true}}));}
      if(operation==='roster') {
        // The Medicare roster's progress (Settings → Customer growth → Find prospects from the Medicare roster).
        if(!features?.has('platform.agents.growth-roster.v1'))throw new HttpError(503,'Apply the roster database migration first.');
        const {offset}=parse(z.object({offset:z.number().int().min(0).max(100000).default(0)}).strict(),data);
        return safe(async()=>({...await store.roster(token,offset),services:{feed:roster?.feed?.readiness?.()??{declared:false,enabled:false,signing:false},
          states:(()=>{const value=live(roster?.states);return Array.isArray(value)?value:[];})(),daily:live(roster?.daily)??25,research:Boolean(research?.configured),
          companyList:features?.has('platform.agents.ads.v1')===true}}));
      }
      if(operation==='rosterCompanies') {
        // The roster's agencies as rows for LinkedIn's company-list template (Growth → Medicare roster → Download).
        if(!features?.has('platform.agents.ads.v1'))throw new HttpError(503,'Apply the paid ads database migration first.');
        parse(z.object({}).strict(),data);
        return safe(async()=>({companies:await store.rosterCompanies(token)}));
      }
      if(['people','peopleDecide','import'].includes(operation)) {
        if(!features?.has('platform.agents.growth-people.v1'))throw new HttpError(503,'Apply the people database migration first.');
        if(operation==='people')return safe(async()=>({...await store.people(token,parse(z.object({offset:z.number().int().min(0).max(100000).default(0)}).strict(),data).offset),
          services:peopleServices()}));
        if(operation==='peopleDecide'){const parsed=parse(z.object({ids:z.array(uuid).min(1).max(200),decision:z.enum(['permit','refuse'])}).strict(),data);return safe(async()=>({decided:await store.peopleDecide(token,parsed.ids,parsed.decision)}));}
        return safe(()=>store.importList(token,parse(importSchema,data).rows));
      }
      if(operation==='brief') {
        // An opportunity's account brief, both parts (Settings → Customer growth → Write an account brief before the first email).
        if(!features?.has('platform.agents.growth-brief.v1'))throw new HttpError(503,'Apply the account brief database migration first.');
        return safe(async()=>({brief:await store.brief(token,parse(z.object({id:uuid}).strict(),data).id)}));
      }
      if(['sendGuard','sendGuardResume'].includes(operation)) {
        // Addresses checked before the first email, and the bounce guard (Settings → Customer growth).
        if(!features?.has('platform.agents.growth-address-check.v1'))throw new HttpError(503,'Apply the address check database migration first.');
        parse(z.object({}).strict(),data);
        return safe(()=>operation==='sendGuard'?store.sendGuard(token):store.sendGuardResume(token));
      }
      if(['learning','learningDecide'].includes(operation)) {
        // What is working: the weekly memos (Settings → Customer growth → Write from what is working).
        if(!features?.has('platform.agents.growth-learning.v1'))throw new HttpError(503,'Apply the learning database migration first.');
        if(operation==='learning'){parse(z.object({}).strict(),data);return safe(async()=>({memos:await store.learning(token),services:{enabled:live(learning?.enabled)===true}}));}
        const parsed=parse(z.object({id:uuid,decision:z.enum(['activate','reject'])}).strict(),data);
        return safe(()=>store.learningDecide(token,parsed.id,parsed.decision));
      }
      if(operation==='detail')return safe(()=>store.detail(token,parse(z.object({id:uuid}).strict(),data).id));
      if(operation==='research') {
        const parsed=parse(z.object({id:uuid}).strict(),data);
        // Authorize and resolve the organization server-side; never fetch a browser-supplied URL.
        const target=await safe(()=>store.researchTarget(token,parsed.id));
        if(!research?.configured)throw new HttpError(503,'Configure the business research provider first.');
        const rows=await research.search(target.product,{domain:target.domain});
        for(const row of rows) await safe(()=>store.manage(token,'evidence',{opportunityId:parsed.id,sourceUrl:row.url,claim:row.claim,confidence:'low',observedAt:new Date().toISOString()}));
        return {count:rows.length};
      }
      if(!growthSchemas[operation])throw new HttpError(400,'Unsupported growth action.');
      return safe(()=>store.manage(token,operation,parse(growthSchemas[operation],data)));
    },
    async activity(product,raw,headers,now=Date.now()) {
      ready(); const key=eventKeys[product]; const stamp=headers['x-caremetric-timestamp'];
      if(!products.includes(product)||!key||key.length<32||!/^\d{10}$/.test(stamp??'')||Math.abs(now-Number(stamp)*1000)>300000)throw new HttpError(401,'Invalid event signature.');
      const expected=createHmac('sha256',key).update(`${stamp}.${product}.`).update(raw).digest('hex');
      if(!equal(headers['x-caremetric-signature'],expected))throw new HttpError(401,'Invalid event signature.');
      let input;try{input=JSON.parse(raw);}catch{throw new HttpError(400,'Invalid event.');}
      return safe(()=>store.event(product,parse(activitySchema,input)));
    },
    /** A list built elsewhere (a Claude session with a prospecting connector, a spreadsheet), signed like the lead forms. */
    async importSigned(raw,headers,now=Date.now()) {
      ready();
      if(!features?.has('platform.agents.growth-people.v1'))throw new HttpError(503,'List import is not available yet.');
      const stamp=headers['x-caremetric-timestamp'];
      if(typeof importKey!=='string'||importKey.length<32||!/^\d{10}$/.test(stamp??'')||Math.abs(now-Number(stamp)*1000)>300000)throw new HttpError(401,'Invalid import signature.');
      if(!equal(headers['x-caremetric-signature'],leadSignature(importKey,stamp,raw)))throw new HttpError(401,'Invalid import signature.');
      let input;try{input=JSON.parse(raw);}catch{throw new HttpError(400,'Invalid list.');}
      return safe(()=>store.importServer(parse(importSchema,input).rows));
    },
    async appActivity(authorization,input) {
      ready();
      if(!features?.has('platform.agents.app-growth.v1'))throw new HttpError(503,'Application activity is not available yet.');
      const match=typeof authorization==='string'&&/^Bearer (cmb_[A-Za-z0-9_-]{43})$/.exec(authorization);
      if(!match)throw new HttpError(401,'Application key required.');
      const data=parse(appActivitySchema,input);
      try { return await store.appEvent(hash(match[1]),data); }
      catch(error) {
        if(error?.code==='28000')throw new HttpError(401,'Application key required.');
        if(error?.code==='P0002')throw new HttpError(503,'The application account is not linked yet. Retry after billing connects it.');
        return safe(()=>{throw error;});
      }
    },
    async delivery(raw,headers,now=Date.now()) {
      ready(); const stamp=headers['x-twilio-email-event-webhook-timestamp'],signature=headers['x-twilio-email-event-webhook-signature'];
      let key;try{key=createPublicKey(webhookPublicKey.includes('BEGIN')?webhookPublicKey:{key:Buffer.from(webhookPublicKey,'base64'),format:'der',type:'spki'});}catch{throw new HttpError(503,'Email event verification is not configured.');}
      if(!/^\d{10}$/.test(stamp??'')||Math.abs(now-Number(stamp)*1000)>300000||!sendgridSignatureValid(key,signature,stamp,raw))throw new HttpError(401,'Invalid delivery signature.');
      let rows;try{rows=JSON.parse(raw);}catch{throw new HttpError(400,'Invalid events.');}
      if(!Array.isArray(rows)||rows.length>500)throw new HttpError(400,'Invalid events.');
      let accepted=0; const kinds={delivered:'delivered',bounce:'bounced',dropped:'bounced',spamreport:'complaint',unsubscribe:'unsubscribe',group_unsubscribe:'unsubscribe'};
      for(const row of rows) {if(!kinds[row.event]||!z.uuid().safeParse(row.growth_message_id).success||typeof row.sg_event_id!=='string'||row.sg_event_id.length>200||!Number.isFinite(row.timestamp))continue;
        // A block (bounce of type "blocked") is the receiving server refusing for now, for the sender's reputation or a spam filter, not a
        // bad address: like a soft SES bounce it is a bounce without the opt-out, once the database can record one (soft-bounce feature).
        const soft=row.event==='bounce'&&row.type==='blocked'&&features?.has(growthSoftBounceFeature);
        await store.delivery(...[row.sg_event_id,row.growth_message_id,kinds[row.event],new Date(row.timestamp*1000).toISOString(),...(soft?[false]:[])]); accepted++;
      }
      return {accepted};
    },
    /**
     * Amazon SES delivery, bounce and complaint events, as SNS notifications from the configuration set's event destination
     * (docs/AMAZON_SES.md). `sesEvents` checks the SNS signature and the topic, and confirms the subscription when SNS asks.
     */
    async sesDelivery(raw) {
      ready(); if(typeof sesEvents!=='function')throw new HttpError(503,'Amazon SES events are not configured.');
      let result;try{result=await sesEvents(raw);}catch(error){throw new HttpError(error?.status??400,error?.message??'Invalid notification.');}
      if(!result?.notification)return {accepted:0,...(result?.confirmed?{confirmed:true}:{})};
      let accepted=0;
      for(const event of sesGrowthEvents(result.notification)){if(!z.uuid().safeParse(event.messageId).success)continue; if(event.suppress===false&&!features?.has(growthSoftBounceFeature))continue; await store.delivery(event.id,event.messageId,event.kind,event.at,event.suppress??true); accepted++;}
      return {accepted};
    },
    async unsubscribe(token,confirm) {
      ready(); if(!/^[a-f0-9]{64}$/.test(token))throw new HttpError(400,'Invalid unsubscribe link.');
      if(confirm)await store.unsubscribe(hash(token));
      return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>CareMetric preferences</title><h1>${confirm?'Your preference is recorded':'CareMetric email preferences'}</h1>${confirm?'<p>You will receive no more messages from these growth campaigns.</p>':'<form method="post"><button>Unsubscribe from growth messages</button></form>'}</html>`;
    },
  };
}
