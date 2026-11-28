import { z } from 'zod';
import { sessionEvent } from '../lib/appSession';
import { config } from '../lib/config';
const id=z.string();
export const opportunitySchema=z.object({id,organization_id:id,product:z.enum(['carebase','caremetric-intel']),name:z.string(),domain:z.string(),internal:z.boolean(),tenant_id:id.nullable(),contact_id:id.nullable(),email:z.string().nullable(),contact_name:z.string().nullable(),eligibility:z.string().nullable(),verified_at:z.string().nullable(),contact_version:z.number().nullable(),stage:z.string(),goal:z.string(),memory:z.record(z.string(),z.unknown()),next_action:z.string(),next_at:z.string(),trial_end:z.string().nullable(),renewal_at:z.string().nullable(),owner_agent:z.string(),fit:z.number().nullable(),intent:z.number().nullable(),version:z.number()});
export type GrowthOpportunity=z.infer<typeof opportunitySchema>;
export const policySchema=z.object({product:z.enum(['carebase','caremetric-intel']),enabled:z.boolean(),auto_send:z.boolean(),experiment_enabled:z.boolean().default(false),daily_limit:z.number(),min_gap_hours:z.number(),max_touches:z.number(),booking_url:z.string(),approved_claim:z.string(),version:z.number()});
export type GrowthPolicy=z.infer<typeof policySchema>;
export const workspaceSchema=z.object({content:z.array(z.object({id,status:z.string(),preview:z.string(),campaign:z.string().nullable()})).default([]),total:z.number(),items:z.array(opportunitySchema),policies:z.array(policySchema),work:z.array(z.object({id,opportunity_id:id,name:z.string(),product:z.string(),kind:z.string(),action:z.string(),success_criterion:z.string(),due_at:z.string(),owner_agent:z.string()})),metrics:z.array(z.object({product:z.string(),stage:z.string(),source:z.string(),cohort:z.string(),accounts:z.number(),trials:z.number(),positive_replies:z.number(),meetings:z.number(),activated:z.number(),paid:z.number(),churned:z.number(),overdue:z.number(),hours_to_value:z.number().nullable(),eligible_30d:z.number(),retained_30d:z.number(),eligible_60d:z.number(),retained_60d:z.number(),eligible_90d:z.number(),retained_90d:z.number()})),deliveries:z.array(z.object({product:z.string(),variant:z.string(),status:z.string(),count:z.number()})),services:z.object({sending:z.boolean(),signing:z.boolean(),postalAddress:z.boolean(),research:z.boolean(),roster:z.boolean().default(false),people:z.boolean().default(false),learning:z.boolean().default(false),addressCheck:z.boolean().default(false),briefs:z.boolean().default(false),sequences:z.boolean().default(false),launches:z.boolean().default(false)})});
export const detailSchema=z.object({evidence:z.array(z.object({id,source_url:z.string(),claim:z.string(),confidence:z.string(),observed_at:z.string()})),messages:z.array(z.object({id,subject:z.string(),body:z.string(),status:z.string(),model_generated:z.boolean(),variant:z.string(),
 // Everyone the touch went to: the opportunity's contact first, then the other decision-makers at the business (20261115230000).
 recipients:z.array(z.object({id,name:z.string(),role:z.string(),email:z.string(),status:z.string(),primary:z.boolean()})).default([])})),events:z.array(z.object({kind:z.string(),occurred_at:z.string(),facts:z.record(z.string(),z.unknown())}))});
export const rosterSchema=z.object({sync:z.object({period:z.string().nullable(),states:z.array(z.string()),complete:z.boolean(),syncedAt:z.string().nullable(),rows:z.number()}),counts:z.record(z.string(),z.number()),total:z.number(),
 items:z.array(z.object({ccn:z.string(),name:z.string(),setting:z.string(),city:z.string().nullable(),state:z.string(),rank:z.number(),reasons:z.array(z.string()),status:z.string(),reason:z.string().nullable(),attempts:z.number(),resolveAfter:z.string().nullable(),confirmation:z.string().nullable(),domain:z.string().nullable(),organizationId:z.string().nullable(),
  siteSearchedAt:z.string().nullable().optional(),suggested:z.array(z.string()).default([])})),
 services:z.object({feed:z.object({declared:z.boolean(),enabled:z.boolean(),signing:z.boolean()}),states:z.array(z.string()),daily:z.number(),research:z.boolean(),sites:z.boolean().default(false),companyList:z.boolean().default(false),useSite:z.boolean().default(false)})});
export const companiesSchema=z.object({companies:z.array(z.object({name:z.string(),domain:z.string().nullable(),city:z.string().nullable(),state:z.string(),zip:z.string().nullable()}))});
const csvCell=(value:string|null)=>{const raw=value??'';const safe=/^[=+@\-\t\r]/.test(raw)?`'${raw}`:raw;return /[",\n\r]/.test(safe)?`"${safe.replace(/"/g,'""')}"`:safe;};
/** The roster's agencies in LinkedIn's company-list template (Campaign Manager → Audiences → Upload a list → Company). */
export function companyListCsv(rows:z.infer<typeof companiesSchema>['companies']):string {
 const header=['companyname','companywebsite','companyemaildomain','city','state','zipcode','companycountry'];
 return [header.join(','),...rows.map(row=>[row.name,row.domain?`https://${row.domain}`:'',row.domain??'',row.city,row.state,row.zip,'US'].map(csvCell).join(','))].join('\n');
}
export const peopleSchema=z.object({waiting:z.number(),creditsToday:z.number(),creditCap:z.number(),
 items:z.array(z.object({id:z.string(),name:z.string(),role:z.string(),email:z.string(),source:z.string(),found:z.string().nullable().default(null),sourceUrl:z.string().nullable().default(null),
  organization:z.string(),domain:z.string(),foundAt:z.string().nullable()})),
 services:z.object({finder:z.boolean().default(false),mode:z.enum(['none','published','verify']).default('none'),mailServer:z.string().default('unknown')})});
// An opportunity's account brief (Settings → Customer growth → Write an account brief before the first email; 20261116110000_growth_brief.sql).
const briefText=z.string().nullable().optional();
export const briefSchema=z.object({brief:z.object({version:z.number(),model:z.string(),updatedAt:z.string(),
 writer:z.object({summary:briefText,serviceArea:briefText,ownership:briefText,angle:briefText,
  triggers:z.array(z.object({fact:z.string(),sourceUrl:z.string(),date:z.string().optional()})).default([]),
  pains:z.array(z.object({question:z.string(),capability:z.string().optional()})).default([]),
  hook:z.object({sentence:z.string(),sourceUrl:z.string()}).nullable().optional(),countyFact:z.object({claim:z.string()}).nullable().optional()}),
 research:z.object({fit:z.number().nullable().optional(),fitReasons:z.array(z.string()).default([]),angleReason:z.string().optional(),questions:z.array(z.string()).default([]),
  leaders:z.array(z.object({name:z.string(),title:z.string()})).default([])})}).nullable()});
// The bounce guard and the address checks (Settings → Customer growth; 20261116100000_growth_address_check.sql).
export const sendGuardSchema=z.object({on:z.boolean(),tripped:z.boolean(),percent:z.number().optional(),since:z.string().optional(),sent:z.number().optional(),
 bounced:z.number().optional(),complaints:z.number().optional(),mode:z.enum(['off','check','strict']),resumedAt:z.string().nullable(),
 addresses:z.object({verified:z.number(),catchAll:z.number(),undeliverable:z.number(),unanswered:z.number(),unchecked:z.number()})});
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
 if(rows.some(r=>!r.name||!r.domain))return {rows:[],error:'Every row must include a name and a domain.'};
 return {rows:rows.map(r=>({...r,...(r.product&&!['carebase','caremetric-intel'].includes(r.product)?{product:'caremetric-intel'}:{})})),error:null};
}
// `timeoutMs`: preparing an owner sequence reads Intel's feed for each person, a second apart, so it may take a few minutes.
export async function growthPost<S extends z.ZodType>(operation:string,data:unknown,schema:S,signal?:AbortSignal,timeoutMs=30000):Promise<z.infer<S>> {
 if(config.demoMode)throw new Error('Customer growth is not available in the preview.');
 const response=await fetch('/api/admin/growth',{method:'POST',credentials:'same-origin',cache:'no-store',redirect:'error',headers:{'Content-Type':'application/json'},body:JSON.stringify({operation,data}),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(timeoutMs)]):AbortSignal.timeout(timeoutMs)});
 const result:unknown=await response.json().catch(()=>null);
 if(!response.ok){if(response.status===401)window.dispatchEvent(new Event(sessionEvent));throw new Error(result&&typeof result==='object'&&'error'in result&&typeof result.error==='string'?result.error:'The request could not be confirmed. Refresh before retrying.');}
 return schema.parse(result);
}
export const growthMutation=(operation:string,data:unknown)=>growthPost(operation,data,z.unknown());

// The owner's own email sequences (docs/OWNER_SEQUENCES.md; 20261127150000_owner_sequences.sql).
const count=z.coerce.number();
export const sequenceListSchema=z.object({sequences:z.array(z.object({id,name:z.string(),template:z.string(),campaign:z.string(),sendDates:z.array(z.string()),status:z.string(),version:z.number(),
  dailyLimit:z.number(),windowStart:z.string(),windowEnd:z.string(),created_at:z.string(),approvedAt:z.string().nullable(),stoppedAt:z.string().nullable(),
  people:count,stopped:count,replied:count,opened:count,sent:count,scheduled:count})),
 templates:z.array(z.object({id:z.string(),label:z.string(),steps:z.number()})),
 services:z.object({declared:z.boolean(),enabled:z.boolean(),mail:z.boolean(),feed:z.boolean(),reports:z.boolean(),signing:z.boolean()})});
export const sequenceSchema=z.object({id,name:z.string(),template:z.string(),campaign:z.string(),sendDates:z.array(z.string()),windowStart:z.string(),windowEnd:z.string(),dailyLimit:z.number(),
 sender:z.record(z.string(),z.unknown()),status:z.string(),version:z.number(),createdAt:z.string(),approvedAt:z.string().nullable(),stoppedAt:z.string().nullable(),finishedAt:z.string().nullable(),
 people:z.array(z.object({id,ref:z.string(),email:z.string(),firstName:z.string().nullable(),agency:z.string(),county:z.string(),setting:z.string(),ccn:z.string().nullable(),reportUrl:z.string().nullable(),
  notes:z.record(z.string(),z.unknown()),status:z.string(),stopReason:z.string().nullable(),repliedAt:z.string().nullable(),stoppedAt:z.string().nullable(),openedAt:z.string().nullable(),blocked:z.string().nullable(),
  messages:z.array(z.object({id,step:z.number(),sendOn:z.string(),subject:z.string(),body:z.string(),status:z.string(),attemptedAt:z.string().nullable(),deliveredAt:z.string().nullable()}))}))});
export const sequencePrepareSchema=z.object({saved:z.object({id,version:z.number()}).nullable(),problems:z.array(z.object({row:z.number().nullable(),ref:z.string().nullable(),agency:z.string().nullable(),reason:z.string()}))});

// State launches (docs/STATE_LAUNCHES.md; 20261128100000_state_launches.sql): the owner picks a state; the AI team builds it in Instantly.
const launchCampaign=z.object({id:z.string(),name:z.string(),leads:z.coerce.number().default(0),started:z.boolean().optional()});
export const launchListSchema=z.object({enabled:z.boolean(),
 launches:z.array(z.object({id,state:z.string(),status:z.string(),stage:z.string(),progress:z.record(z.string(),z.unknown()),summary:z.record(z.string(),z.unknown()),
  campaigns:z.record(z.string(),launchCampaign),error:z.string().nullable(),createdAt:z.string(),readyAt:z.string().nullable(),launchedAt:z.string().nullable(),
  counts:z.record(z.string(),count)})),
 services:z.object({declared:z.boolean(),instantly:z.boolean(),hunter:z.boolean(),feed:z.boolean(),senders:z.number(),webhook:z.boolean(),subscribed:z.boolean()}),
 states:z.array(z.object({code:z.string(),name:z.string()}))});
export const launchDetailSchema=z.array(z.object({id,ccn:z.string(),setting:z.string(),name:z.string(),city:z.string().nullable(),county:z.string().nullable(),
 segment:z.string(),status:z.string(),note:z.string().nullable(),chainName:z.string().nullable(),personName:z.string().nullable(),title:z.string().nullable(),
 email:z.string().nullable(),domain:z.string().nullable()}));
