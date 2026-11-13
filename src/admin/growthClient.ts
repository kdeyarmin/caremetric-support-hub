import { z } from 'zod';
import { sessionEvent } from '../lib/appSession';
import { config } from '../lib/config';
const id=z.string();
export const opportunitySchema=z.object({id,organization_id:id,product:z.enum(['carebase','caremetric-intel']),name:z.string(),domain:z.string(),internal:z.boolean(),tenant_id:id.nullable(),contact_id:id.nullable(),email:z.string().nullable(),contact_name:z.string().nullable(),eligibility:z.string().nullable(),verified_at:z.string().nullable(),contact_version:z.number().nullable(),stage:z.string(),goal:z.string(),memory:z.record(z.string(),z.unknown()),next_action:z.string(),next_at:z.string(),trial_end:z.string().nullable(),renewal_at:z.string().nullable(),owner_agent:z.string(),fit:z.number().nullable(),intent:z.number().nullable(),version:z.number()});
export type GrowthOpportunity=z.infer<typeof opportunitySchema>;
export const policySchema=z.object({product:z.enum(['carebase','caremetric-intel']),enabled:z.boolean(),auto_send:z.boolean(),experiment_enabled:z.boolean().default(false),daily_limit:z.number(),min_gap_hours:z.number(),max_touches:z.number(),booking_url:z.string(),approved_claim:z.string(),version:z.number()});
export type GrowthPolicy=z.infer<typeof policySchema>;
export const workspaceSchema=z.object({content:z.array(z.object({id,status:z.string(),preview:z.string(),campaign:z.string().nullable()})).default([]),total:z.number(),items:z.array(opportunitySchema),policies:z.array(policySchema),work:z.array(z.object({id,opportunity_id:id,name:z.string(),product:z.string(),kind:z.string(),action:z.string(),success_criterion:z.string(),due_at:z.string(),owner_agent:z.string()})),metrics:z.array(z.object({product:z.string(),stage:z.string(),source:z.string(),cohort:z.string(),accounts:z.number(),trials:z.number(),positive_replies:z.number(),meetings:z.number(),activated:z.number(),paid:z.number(),churned:z.number(),overdue:z.number(),hours_to_value:z.number().nullable(),eligible_30d:z.number(),retained_30d:z.number(),eligible_60d:z.number(),retained_60d:z.number(),eligible_90d:z.number(),retained_90d:z.number()})),deliveries:z.array(z.object({product:z.string(),variant:z.string(),status:z.string(),count:z.number()})),services:z.object({sending:z.boolean(),signing:z.boolean(),postalAddress:z.boolean(),research:z.boolean(),roster:z.boolean().default(false),people:z.boolean().default(false),learning:z.boolean().default(false)})});
export const detailSchema=z.object({evidence:z.array(z.object({id,source_url:z.string(),claim:z.string(),confidence:z.string(),observed_at:z.string()})),messages:z.array(z.object({id,subject:z.string(),body:z.string(),status:z.string(),model_generated:z.boolean(),variant:z.string()})),events:z.array(z.object({kind:z.string(),occurred_at:z.string(),facts:z.record(z.string(),z.unknown())}))});
export const rosterSchema=z.object({sync:z.object({period:z.string().nullable(),states:z.array(z.string()),complete:z.boolean(),syncedAt:z.string().nullable(),rows:z.number()}),counts:z.record(z.string(),z.number()),total:z.number(),
 items:z.array(z.object({ccn:z.string(),name:z.string(),setting:z.string(),city:z.string().nullable(),state:z.string(),rank:z.number(),reasons:z.array(z.string()),status:z.string(),reason:z.string().nullable(),attempts:z.number(),resolveAfter:z.string().nullable(),confirmation:z.string().nullable(),domain:z.string().nullable(),organizationId:z.string().nullable()})),
 services:z.object({feed:z.object({declared:z.boolean(),enabled:z.boolean(),signing:z.boolean()}),states:z.array(z.string()),daily:z.number(),research:z.boolean()})});
export const peopleSchema=z.object({waiting:z.number(),creditsToday:z.number(),creditCap:z.number(),
 items:z.array(z.object({id:z.string(),name:z.string(),role:z.string(),email:z.string(),source:z.string(),organization:z.string(),domain:z.string(),foundAt:z.string().nullable()})),
 services:z.object({provider:z.string().nullable(),configured:z.boolean()})});
export const learningSchema=z.object({memos:z.array(z.object({id:z.string(),product:z.enum(['carebase','caremetric-intel']),version:z.number(),memo:z.string(),status:z.string(),createdAt:z.string(),
 stats:z.object({sent:z.number().nullable().optional(),replied:z.number().nullable().optional()})})),services:z.object({enabled:z.boolean()})});
/** A CSV of prospects as import rows: a header row naming name, domain and optionally product, email, contactName and role. */
export function importRows(csv:string):{rows:Record<string,string>[];error:string|null} {
 const lines:string[][]=[];let field='',row:string[]=[],quoted=false;
 for(let i=0;i<csv.length;i++){const c=csv[i];
  if(quoted){if(c==='"'&&csv[i+1]==='"'){field+='"';i++;}else if(c==='"')quoted=false;else field+=c;continue;}
  if(c==='"')quoted=true;else if(c===','){row.push(field);field='';}else if(c==='\n'||c==='\r'){if(c==='\r'&&csv[i+1]==='\n')i++;row.push(field);if(row.some(v=>v.trim()))lines.push(row);row=[];field='';}else field+=c;}
 row.push(field);if(row.some(v=>v.trim()))lines.push(row);
 if(lines.length<2)return {rows:[],error:'Add a header row and at least one prospect.'};
 const known:Record<string,string>={name:'name',organization:'name',domain:'domain',website:'domain',product:'product',email:'email',contactname:'contactName',contact:'contactName',role:'role',title:'role'};
 const header=lines[0].map(h=>known[h.trim().toLowerCase().replace(/[^a-z]/g,'')]??'');
 if(!header.includes('name')||!header.includes('domain'))return {rows:[],error:'The header row must name the name and domain columns.'};
 if(lines.length>501)return {rows:[],error:'Import at most 500 prospects at a time.'};
 const rows=lines.slice(1).map(cells=>Object.fromEntries(header.map((key,i)=>[key,(cells[i]??'').trim()]).filter(([key,value])=>key&&value)));
 return {rows:rows.map(r=>({...r,...(r.product&&!['carebase','caremetric-intel'].includes(r.product)?{product:'caremetric-intel'}:{})})),error:null};
}
export async function growthPost<S extends z.ZodType>(operation:string,data:unknown,schema:S,signal?:AbortSignal):Promise<z.infer<S>> {
 if(config.demoMode)throw new Error('Customer growth is not available in the preview.');
 const response=await fetch('/api/admin/growth',{method:'POST',credentials:'same-origin',cache:'no-store',redirect:'error',headers:{'Content-Type':'application/json'},body:JSON.stringify({operation,data}),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(30000)]):AbortSignal.timeout(30000)});
 const result:unknown=await response.json().catch(()=>null);
 if(!response.ok){if(response.status===401)window.dispatchEvent(new Event(sessionEvent));throw new Error(result&&typeof result==='object'&&'error'in result&&typeof result.error==='string'?result.error:'The request could not be confirmed. Refresh before retrying.');}
 return schema.parse(result);
}
export const growthMutation=(operation:string,data:unknown)=>growthPost(operation,data,z.unknown());
