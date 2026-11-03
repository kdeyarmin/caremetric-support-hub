import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { growthPost, growthMutation, workspaceSchema, detailSchema } from './growthClient';
import type { GrowthOpportunity, GrowthPolicy } from './growthClient';
import type { z } from 'zod';
import './admin.css';
const names={carebase:'CareBase','caremetric-intel':'CareMetric Intel'};
const stages=['identified','researched','qualified','contacted','engaged','demo','trial','activated','paying','retained','nurture','lost','churned','disqualified'];
const value=(form:FormData,key:string)=>String(form.get(key)??'').trim();
const iso=(input:string)=>input?new Date(input).toISOString():'';
const local=(input:string|null)=>input?new Date(new Date(input).getTime()-new Date(input).getTimezoneOffset()*60000).toISOString().slice(0,16):'';
function OpportunityEditor({item,onSave}:{item:GrowthOpportunity;onSave:(op:string,data:unknown)=>Promise<void>}) {
 return <form onSubmit={event=>{event.preventDefault();const f=new FormData(event.currentTarget);void onSave('opportunity',{id:item.id,version:item.version,internal:f.has('internal'),tenantId:value(f,'tenantId'),stage:value(f,'stage'),goal:value(f,'goal'),nextAction:value(f,'nextAction'),nextAt:iso(value(f,'nextAt')),trialEnd:iso(value(f,'trialEnd')),renewalAt:iso(value(f,'renewalAt')),memory:{promises:value(f,'promises'),blockers:value(f,'blockers'),objections:value(f,'objections'),lossReason:value(f,'lossReason')}});}}>
 <label>Stage<select name="stage" defaultValue={item.stage}>{stages.map(s=><option key={s}>{s}</option>)}</select></label>
 <label>Hub tenant ID<input name="tenantId" defaultValue={item.tenant_id??''}/></label>
 <label><input name="internal" type="checkbox" defaultChecked={item.internal}/> Internal account; exclude from outreach</label>
 <label>Customer goal<textarea name="goal" defaultValue={item.goal} maxLength={2000}/></label>
 <label>Next action<input name="nextAction" defaultValue={item.next_action} maxLength={500} required/></label>
 <label>Due<input type="datetime-local" name="nextAt" defaultValue={local(item.next_at)} required/></label>
 <label>Trial ends<input type="datetime-local" name="trialEnd" defaultValue={local(item.trial_end)}/></label>
 <label>Renews<input type="datetime-local" name="renewalAt" defaultValue={local(item.renewal_at)}/></label>
 {['promises','blockers','objections','lossReason'].map(key=><label key={key}>{key==='lossReason'?'Loss or churn reason':key}<textarea name={key} defaultValue={String(item.memory[key]??'')} maxLength={2000}/></label>)}
 <button className="button button-primary">Save next steps</button></form>;
}
function PolicyEditor({policy,onSave}:{policy:GrowthPolicy;onSave:(op:string,data:unknown)=>Promise<void>}) {
 return <details className="panel"><summary>{names[policy.product]} campaign policy · {policy.enabled?'Enabled':'Paused'}</summary>
 <form onSubmit={event=>{event.preventDefault();const f=new FormData(event.currentTarget);void onSave('policy',{product:policy.product,version:policy.version,enabled:f.has('enabled'),autoSend:f.has('autoSend'),experimentEnabled:f.has('experimentEnabled'),dailyLimit:Number(f.get('dailyLimit')),minGapHours:Number(f.get('minGapHours')),maxTouches:Number(f.get('maxTouches')),bookingUrl:value(f,'bookingUrl'),approvedClaim:value(f,'approvedClaim')});}}>
 <label>Approved product benefit<textarea name="approvedClaim" defaultValue={policy.approved_claim} maxLength={1000}/></label>
 <label>Booking link<input name="bookingUrl" type="url" defaultValue={policy.booking_url}/></label>
 <label>Maximum messages per day<input name="dailyLimit" type="number" min={1} max={100} defaultValue={policy.daily_limit}/></label>
 <label>Minimum hours between contact across products<input name="minGapHours" type="number" min={24} max={720} defaultValue={policy.min_gap_hours}/></label>
 <label>Maximum prospect touches<input name="maxTouches" type="number" min={1} max={3} defaultValue={policy.max_touches}/></label>
 <label><input type="checkbox" name="enabled" defaultChecked={policy.enabled}/> Enable this product’s reviewed outreach</label>
 <label><input type="checkbox" name="autoSend" defaultChecked={policy.auto_send}/> Allow approved templates when the agent is in Act mode</label>
 <label><input type="checkbox" name="experimentEnabled" defaultChecked={policy.experiment_enabled}/> Compare standard and concise messages using stable organization groups</label>
 <p>Model-written messages always need individual review. Changes invalidate older drafts.</p>
 <button className="button">Save policy</button></form></details>;
}
export function Growth() {
 const [data,setData]=useState<z.infer<typeof workspaceSchema>|null>(null),[offset,setOffset]=useState(0),[revision,setRevision]=useState(0),[error,setError]=useState(''),[busy,setBusy]=useState(false),[selected,setSelected]=useState<string|null>(null),[detail,setDetail]=useState<z.infer<typeof detailSchema>|null>(null);
 useEffect(()=>{const c=new AbortController();void growthPost('workspace',{offset},workspaceSchema,c.signal).then(setData).catch(e=>{if(!c.signal.aborted)setError(e.message);});return()=>c.abort();},[offset,revision]);
 useEffect(()=>{if(!selected)return;const c=new AbortController();void growthPost('detail',{id:selected},detailSchema,c.signal).then(setDetail).catch(e=>{if(!c.signal.aborted)setError(e.message);});return()=>c.abort();},[selected,revision]);
 const save=useCallback(async(op:string,input:unknown)=>{setBusy(true);setError('');try{await growthMutation(op,input);setRevision(n=>n+1);}catch(e){setError(e instanceof Error?e.message:'Result unconfirmed. Refresh before retrying.');}finally{setBusy(false);}},[]);
 const item=data?.items.find(i=>i.id===selected);
 return <div className="admin-workspace growth-workspace"><header className="admin-page-header"><h1>Customer growth</h1><p>Acquire, activate and retain CareBase and CareMetric Intel customers. Breathe is deferred.</p><Link to="/admin/team">Review message approvals and agent controls</Link></header>
 {error&&<p role="alert">{error}</p>}{!data&&!error&&<p role="status">Loading customer growth…</p>}
 <button className="button" onClick={()=>setRevision(n=>n+1)}>Refresh</button>
 {data&&<><section className="panel"><h2>Readiness</h2><p>Sending: {data.services.sending?'enabled':'disabled'} · Research: {data.services.research?'ready':'not configured'} · Unsubscribe signing: {data.services.signing?'ready':'not configured'} · Sender address: {data.services.postalAddress?'ready':'needed'}</p><p>Sending also requires an active agent, a reviewed policy and an eligible verified contact.</p></section>
 <fieldset disabled={busy} style={{border:0,padding:0}}>
 <details className="panel"><summary>Add a prospect or customer</summary><form onSubmit={e=>{e.preventDefault();const f=new FormData(e.currentTarget);void save('create',{name:value(f,'name'),domain:value(f,'domain').toLowerCase(),product:value(f,'product'),email:value(f,'email'),contactName:value(f,'contactName'),role:value(f,'role'),goal:value(f,'goal'),...(value(f,'tenantId')?{tenantId:value(f,'tenantId')}:{}),internal:f.has('internal')});}}>
 <label>Organization<input name="name" maxLength={200} required/></label><label>Business domain<input name="domain" placeholder="example.org" required/></label>
 <label>Product<select name="product"><option value="carebase">CareBase</option><option value="caremetric-intel">CareMetric Intel</option></select></label>
 <label>Business email<input name="email" type="email"/></label><label>Contact name<input name="contactName" maxLength={200}/></label><label>Role<input name="role" maxLength={200}/></label>
 <label>Customer goal<textarea name="goal" maxLength={2000}/></label><label>Existing Hub tenant ID, if applicable<input name="tenantId"/></label>
 <label><input type="checkbox" name="internal"/> Internal account; exclude from outreach</label><button className="button button-primary">Add to pipeline</button></form></details>
 <section className="panel"><h2>Pipeline · {data.total} opportunities</h2><table><thead><tr><th>Organization</th><th>Product</th><th>Stage</th><th>Next action</th><th>Due</th></tr></thead><tbody>{data.items.map(o=><tr key={o.id}><td><button onClick={()=>{setDetail(null);setSelected(o.id);}}>{o.name}</button>{o.internal?' (internal)':''}</td><td>{names[o.product]}</td><td>{o.stage}</td><td>{o.next_action}</td><td>{new Date(o.next_at).toLocaleString()}</td></tr>)}</tbody></table>
 {!data.items.length&&<p>Add organizations or enable reviewed discovery to build the pipeline.</p>}
 <button disabled={!offset} onClick={()=>setOffset(Math.max(0,offset-50))}>Previous</button><button disabled={offset+50>=data.total} onClick={()=>setOffset(offset+50)}>Next</button></section>
 {item&&<section className="panel" key={`${item.id}:${item.version}`}><h2>{item.name} · {names[item.product]}</h2><p>Contact: {item.email??'Missing'} · {item.eligibility??'Needs a contact'} · Owner: {item.owner_agent.replaceAll('_',' ')}</p>
 <p>Evidence-based fit: {item.fit??"Not assessed"} · Observed intent: {item.intent??"Unknown"}</p><p>{String(item.memory.researchRationale??"")}</p>
 <OpportunityEditor item={item} onSave={save}/><button className="button" onClick={()=>void save('research',{id:item.id})}>Research this organization</button>
 {item.contact_id&&<form onSubmit={e=>{e.preventDefault();const f=new FormData(e.currentTarget);void save('contact',{id:item.contact_id,version:item.contact_version,eligibility:value(f,'eligibility'),verified:f.has('verified'),sourceUrl:value(f,'sourceUrl')});}}>
 <h3>Contact eligibility</h3><select name="eligibility" defaultValue={item.eligibility??'review'}><option value="review">Needs review</option><option value="permitted">Outreach permitted</option><option value="opted_out">Do not contact</option></select>
 <label>Verification source<input name="sourceUrl" type="url"/></label><label><input type="checkbox" name="verified" defaultChecked={Boolean(item.verified_at)}/> Business contact and channel eligibility verified</label><button>Save contact review</button></form>}
 <h3>Evidence</h3>{detail?.evidence.map(e=><p key={e.id}><a href={e.source_url} target="_blank" rel="noreferrer">Source</a> · {e.confidence} · {new Date(e.observed_at).toLocaleDateString()} · {e.claim}</p>)}
 <form onSubmit={e=>{e.preventDefault();const f=new FormData(e.currentTarget);void save('evidence',{opportunityId:item.id,sourceUrl:value(f,'sourceUrl'),claim:value(f,'claim'),confidence:value(f,'confidence'),observedAt:new Date().toISOString()});}}><label>Source URL<input name="sourceUrl" type="url" required/></label><label>Verified fact<textarea name="claim" maxLength={4000} required/></label><select name="confidence"><option>low</option><option>medium</option><option>high</option></select><button>Add evidence</button></form>
 <h3>Message history</h3>{detail?.messages.map(m=><details key={m.id}><summary>{m.subject} · {m.status}</summary><p style={{whiteSpace:'pre-wrap'}}>{m.body}</p><p>{m.model_generated?'Model draft — individual approval required':'Approved-template draft'}</p>{m.status==='unknown'&&<form onSubmit={e=>{e.preventDefault();const f=new FormData(e.currentTarget);void save('reconcile',{id:m.id,status:value(f,'status'),reference:value(f,'reference')});}}><label>Verified provider outcome<select name="status"><option value="delivered">Delivered</option><option value="failed">Failed</option></select></label><label>Provider log or support reference<input name="reference" minLength={3} maxLength={500} required/></label><button>Record verified outcome</button></form>}</details>)}
 <h3>Verified activity</h3>{detail?.events.map((e,i)=><p key={i}>{e.kind} · {new Date(e.occurred_at).toLocaleString()}</p>)}
 </section>}
 <section className="panel"><h2>Customer success and follow-up</h2>{!data.work.length&&<p>No open follow-ups.</p>}{data.work.map(w=><details key={w.id}><summary>{w.name} · {w.kind} · due {new Date(w.due_at).toLocaleString()}</summary><p>{w.action}</p><p>Success: {w.success_criterion}</p><form onSubmit={e=>{e.preventDefault();void save('resolve',{id:w.id,outcome:value(new FormData(e.currentTarget),'outcome')});}}><label>Observed outcome<textarea name="outcome" required maxLength={2000}/></label><button>Record resolution</button></form></details>)}</section>
 {data.policies.map(p=><PolicyEditor key={`${p.product}:${p.version}`} policy={p} onSave={save}/>)}
 </fieldset>
 <section className="panel"><h2>Search and content proposals</h2><p>Review briefs in Team, then use the approved brief in the existing publishing workflow. Search results do not establish search volume.</p>{data.content.map(c=><details key={c.id}><summary>{c.campaign} · {c.status}</summary><p style={{whiteSpace:'pre-wrap'}}>{c.preview}</p></details>)}</section>
 <section className="panel"><h2>Outcomes by product and cohort</h2><p>Retention counts include only customers old enough to measure. Provider acceptance is separate from delivery.</p>
 <table><thead><tr><th>Product / cohort / source / stage</th><th>Accounts</th><th>Replies / meetings / trials</th><th>Activated / paid</th><th>Overdue</th><th>30 / 60 / 90 day retention</th></tr></thead><tbody>{data.metrics.map((m,i)=><tr key={i}><td>{m.product} / {m.cohort.slice(0,7)} / {m.source} / {m.stage}</td><td>{m.accounts}</td><td>{m.positive_replies} / {m.meetings} / {m.trials}</td><td>{m.activated} / {m.paid}</td><td>{m.overdue}</td><td>{m.retained_30d}/{m.eligible_30d} · {m.retained_60d}/{m.eligible_60d} · {m.retained_90d}/{m.eligible_90d}</td></tr>)}</tbody></table>
 <ul>{data.deliveries.map((d,i)=><li key={i}>{d.product} · {d.variant} · {d.status}: {d.count}</li>)}</ul></section>
 </>}
 </div>;
}
