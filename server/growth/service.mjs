import { createHmac, createPublicKey, createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { HttpError } from '../sms-auth.mjs';
import { sendgridSignatureValid } from '../communications.mjs';
import { activitySchema } from './protocol.mjs';
import { products, stages } from './policy.mjs';
const uuid=z.uuid(), text=(n)=>z.string().max(n), instant=z.iso.datetime({offset:true});
const https=z.union([z.literal(''),z.url().refine(v=>new URL(v).protocol==='https:' && !new URL(v).username && !new URL(v).password)]);
export const growthSchemas={
 create:z.object({name:text(200).min(1),domain:text(253).regex(/^[a-z0-9][a-z0-9.-]+\.[a-z]{2,}$/),product:z.enum(products),email:z.union([z.literal(''),z.email()]),contactName:text(200),role:text(200),goal:text(2000),tenantId:uuid.optional(),internal:z.boolean().optional()}).strict(),
 opportunity:z.object({id:uuid,internal:z.boolean().optional(),tenantId:z.union([z.literal(''),uuid]).optional(),version:z.number().int().positive(),stage:z.enum(stages),goal:text(2000),nextAction:text(500).min(1),nextAt:instant,trialEnd:z.union([z.literal(''),instant]),renewalAt:z.union([z.literal(''),instant]),memory:z.object({promises:text(2000).optional(),blockers:text(2000).optional(),objections:text(2000).optional(),lossReason:text(2000).optional()}).strict()}).strict(),
 contact:z.object({id:uuid,version:z.number().int().positive(),eligibility:z.enum(['review','permitted','opted_out']),verified:z.boolean(),sourceUrl:https}).strict(),
 evidence:z.object({opportunityId:uuid,sourceUrl:z.url().refine(v=>new URL(v).protocol==='https:'),claim:text(4000).min(1),confidence:z.enum(['low','medium','high']),observedAt:instant}).strict(),
 policy:z.object({product:z.enum(products),version:z.number().int().positive(),enabled:z.boolean(),autoSend:z.boolean(),experimentEnabled:z.boolean().default(false),dailyLimit:z.number().int().min(1).max(100),minGapHours:z.number().int().min(24).max(720),maxTouches:z.number().int().min(1).max(3),bookingUrl:https,approvedClaim:text(1000)}).strict(),
 reconcile:z.object({id:uuid,status:z.enum(['delivered','failed']),reference:text(500).min(3)}).strict(),
 resolve:z.object({id:uuid,outcome:text(2000).min(1)}).strict(),
};
export { activitySchema } from './protocol.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
const equal=(a,b)=>{const x=Buffer.from(String(a)),y=Buffer.from(String(b));return x.length===y.length&&timingSafeEqual(x,y);};
export function growthService({store,research,features,enabled=false,signingKey='',eventKeys={},webhookPublicKey='',publicOrigin,postalAddress=''}) {
  const ready=()=>{if(!features?.has('platform.agents.growth.v1'))throw new HttpError(503,'Apply the growth database migration first.');};
  const safe=async work=>{try{return await work();}catch(e){if(e instanceof HttpError)throw e; if(['22023','22007','23514','23503','23505'].includes(e?.code))throw new HttpError(400,'Check the growth record and its references.'); if(e?.code==='40001')throw new HttpError(409,'This record changed. Refresh and review it again.'); if(e?.code==='28000')throw new HttpError(401,'Sign in again.'); if(e?.code==='42501')throw new HttpError(403,'Not permitted.'); throw e;}};
  const parse=(schema,input)=>{const parsed=schema.safeParse(input); if(!parsed.success)throw new HttpError(400,'Invalid growth request.');return parsed.data;};
  const unsubscribeToken=workId=>createHmac('sha256',signingKey).update(`growth:${workId}`).digest('hex');
  return {
    ready, store, research, enabled, unsubscribeToken, hash, signingReady:signingKey.length>=32,
    configured:()=>enabled&&signingKey.length>=32&&postalAddress.trim().length>0&&/^https:\/\//.test(publicOrigin??''),
    async admin(token,input) {
      ready(); const {operation,data}=parse(z.object({operation:z.string(),data:z.record(z.string(),z.unknown()).default({})}).strict(),input);
      if(operation==='workspace') {const {offset}=parse(z.object({offset:z.number().int().min(0).default(0)}).strict(),data);return safe(async()=>({...await store.workspace(token,offset),services:{sending:enabled,signing:signingKey.length>=32,postalAddress:Boolean(postalAddress),research:Boolean(research?.configured)}}));}
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
    async delivery(raw,headers,now=Date.now()) {
      ready(); const stamp=headers['x-twilio-email-event-webhook-timestamp'],signature=headers['x-twilio-email-event-webhook-signature'];
      let key;try{key=createPublicKey(webhookPublicKey.includes('BEGIN')?webhookPublicKey:{key:Buffer.from(webhookPublicKey,'base64'),format:'der',type:'spki'});}catch{throw new HttpError(503,'Email event verification is not configured.');}
      if(!/^\d{10}$/.test(stamp??'')||Math.abs(now-Number(stamp)*1000)>300000||!sendgridSignatureValid(key,signature,stamp,raw))throw new HttpError(401,'Invalid delivery signature.');
      let rows;try{rows=JSON.parse(raw);}catch{throw new HttpError(400,'Invalid events.');}
      if(!Array.isArray(rows)||rows.length>500)throw new HttpError(400,'Invalid events.');
      let accepted=0; const kinds={delivered:'delivered',bounce:'bounced',dropped:'bounced',spamreport:'complaint',unsubscribe:'unsubscribe',group_unsubscribe:'unsubscribe'};
      for(const row of rows) {if(!kinds[row.event]||!z.uuid().safeParse(row.growth_message_id).success||typeof row.sg_event_id!=='string'||row.sg_event_id.length>200||!Number.isFinite(row.timestamp))continue;
        await store.delivery(row.sg_event_id,row.growth_message_id,kinds[row.event],new Date(row.timestamp*1000).toISOString()); accepted++;
      }
      return {accepted};
    },
    async unsubscribe(token,confirm) {
      ready(); if(!/^[a-f0-9]{64}$/.test(token))throw new HttpError(400,'Invalid unsubscribe link.');
      if(confirm)await store.unsubscribe(hash(token));
      return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>CareMetric preferences</title><h1>${confirm?'Your preference is recorded':'CareMetric email preferences'}</h1>${confirm?'<p>You will receive no more messages from these growth campaigns.</p>':'<form method="post"><button>Unsubscribe from growth messages</button></form>'}</html>`;
    },
  };
}
