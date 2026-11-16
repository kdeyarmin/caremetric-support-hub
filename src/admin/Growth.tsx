import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { growthPost, growthMutation, workspaceSchema, detailSchema, rosterSchema, peopleSchema, learningSchema, sendGuardSchema, briefSchema, companiesSchema, companyListCsv, importRows } from './growthClient';
import type { GrowthOpportunity, GrowthPolicy } from './growthClient';
import type { z } from 'zod';
import './admin.css';
const names={carebase:'CareBase','caremetric-intel':'CareMetric Intel'};
const stages=['identified','researched','qualified','contacted','engaged','demo','trial','activated','paying','retained','nurture','lost','churned','disqualified'];
const value=(form:FormData,key:string)=>String(form.get(key)??'').trim();
const iso=(input:string)=>input?new Date(input).toISOString():'';
const local=(input:string|null)=>input?new Date(new Date(input).getTime()-new Date(input).getTimezoneOffset()*60000).toISOString().slice(0,16):'';
/** Records the provider's verified outcome of a send that may or may not have gone out. */
function ReconcileForm({id,onSave}:{id:string;onSave:(op:string,data:unknown)=>Promise<void>}) {
 return <form onSubmit={e=>{e.preventDefault();const f=new FormData(e.currentTarget);void onSave('reconcile',{id,status:value(f,'status'),reference:value(f,'reference')});}}><label>Verified provider outcome<select name="status"><option value="delivered">Delivered</option><option value="failed">Failed</option></select></label><label>Provider log or support reference<input name="reference" minLength={3} maxLength={500} required/></label><button>Record verified outcome</button></form>;
}
/** Who one touch went to: its contact, then the other decision-makers at the business, each with the state of their own email. */
function Recipients({message,onSave}:{message:z.infer<typeof detailSchema>['messages'][number];onSave:(op:string,data:unknown)=>Promise<void>}) {
 if(message.recipients.length<2)return null;
 return <><p>Sent as separate emails to {message.recipients.length} people:</p><ul>{message.recipients.map(r=><li key={r.id}>{r.name||r.role||r.email}{r.name&&r.role&&` (${r.role})`} · {r.email} · {r.status}{r.primary?' · first contact':''}
  {!r.primary&&r.status==='unknown'&&<ReconcileForm id={r.id} onSave={onSave}/>}</li>)}</ul></>;
}
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
 <form onSubmit={event=>{event.preventDefault();const f=new FormData(event.currentTarget);void onSave('policy',{product:policy.product,version:policy.version,enabled:f.has('enabled'),autoSend:f.has('autoSend'),experimentEnabled:f.has('experimentEnabled'),dailyLimit:Number(f.get('dailyLimit')),minGapHours:Number(f.get('minGapHours')),maxTouches:Number(f.get('maxTouches')),bookingUrl:'',approvedClaim:value(f,'approvedClaim')});}}>
 <label>Approved product benefit<textarea name="approvedClaim" defaultValue={policy.approved_claim} maxLength={1000}/></label>
 <label>Maximum messages per day<input name="dailyLimit" type="number" min={1} max={100} defaultValue={policy.daily_limit}/></label>
 <label>Minimum hours between contact across products<input name="minGapHours" type="number" min={24} max={720} defaultValue={policy.min_gap_hours}/></label>
 <label>Maximum prospect touches<input name="maxTouches" type="number" min={1} max={3} defaultValue={policy.max_touches}/></label>
 <label><input type="checkbox" name="enabled" defaultChecked={policy.enabled}/> Enable this product’s reviewed outreach</label>
 <label><input type="checkbox" name="autoSend" defaultChecked={policy.auto_send}/> Allow approved templates when the agent is in Act mode</label>
 <label><input type="checkbox" name="experimentEnabled" defaultChecked={policy.experiment_enabled}/> Compare standard and concise messages using stable organization groups</label>
 <p>Model-written messages always need individual review. Changes invalidate older drafts.</p>
 <button className="button">Save policy</button></form></details>;
}
const rosterStatus:Record<string,string>={new:'Waiting',resolving:'Looking up',unresolved:'Not found yet',excluded:'Excluded',graduated:'In the pipeline'};
const rosterReason:Record<string,string>={no_site:'no website matched',not_confirmed:'website not confirmed as theirs',retry:'search unavailable; retrying',shared_host:'website shared with other agencies',closed:'closed in the CMS roster',invalid_site:'website refused'};
/** The Medicare roster from Intel's feed (Settings → Customer growth): where the read is, and the best-ranked agencies. */
function RosterPanel({revision}:{revision:number}) {
 const [entry,setEntry]=useState<{revision:number;offset:number;data:z.infer<typeof rosterSchema>}|null>(null),[failure,setFailure]=useState(''),[offset,setOffset]=useState(0);
 useEffect(()=>{const c=new AbortController();void growthPost('roster',{offset},rosterSchema,c.signal).then(data=>{if(!c.signal.aborted){setEntry({revision,offset,data});setFailure('');}}).catch(e=>{if(!c.signal.aborted)setFailure(e instanceof Error?e.message:'The Medicare roster could not be loaded.');});return()=>c.abort();},[revision,offset]);
 const data=entry?.data;
 if(failure)return <section className="panel"><h2>Medicare roster</h2><p>{failure}</p></section>;
 if(!data)return <section className="panel"><h2>Medicare roster</h2><p role="status">Loading the Medicare roster…</p></section>;
 const feed=data.services.feed;
 const missing=[!feed.declared&&'apply the roster database migration',!feed.enabled&&'turn on Settings → Customer growth → Find prospects from the Medicare roster',!data.services.states.length&&'choose Settings → Customer growth → States to prospect in',!feed.signing&&'set HUB_INTEL_FEED_SECRET in Railway to Intel\'s HUB_MARKETING_FEED_SECRET',!data.services.research&&'set the search key (HUB_GROWTH_SEARCH_API_KEY)'].filter(Boolean);
 return <section className="panel" aria-labelledby="growth-roster-title"><h2 id="growth-roster-title">Medicare roster · {data.total} agencies</h2>
  <p>Every Medicare-certified home health agency and hospice in {data.services.states.length?data.services.states.join(', '):'your chosen states'}, from Intel's marketing feed. The Marketing Manager looks up the best-ranked ones' own websites, up to {data.services.daily} a day, and adds those it confirms to the pipeline below.</p>
  {missing.length>0&&<p role="status">To start: {missing.join('; ')}.</p>}
  <p>Roster {data.sync.period??'not read yet'}{data.sync.syncedAt?` · read ${new Date(data.sync.syncedAt).toLocaleDateString()}`:''}{data.sync.period&&!data.sync.complete?' · reading':''} · {Object.entries(rosterStatus).map(([key,label])=>`${label}: ${data.counts[key]??0}`).join(' · ')}</p>
  {data.items.length>0&&<table><thead><tr><th>Agency</th><th>Place</th><th>Rank</th><th>Status</th><th>Website</th></tr></thead><tbody>{data.items.map(t=><tr key={t.ccn}><td>{t.name}<br/><small>{t.setting==='hospice'?'Hospice':'Home health'} · CCN {t.ccn}</small></td><td>{[t.city,t.state].filter(Boolean).join(', ')}</td><td>{t.rank}{t.reasons.length>0&&<><br/><small>{t.reasons.join('; ')}</small></>}</td><td>{rosterStatus[t.status]??t.status}{t.reason&&<><br/><small>{rosterReason[t.reason]??t.reason}{t.resolveAfter?` · again ${new Date(t.resolveAfter).toLocaleDateString()}`:''}</small></>}</td><td>{t.domain??''}{t.confirmation&&<><br/><small>confirmed by {t.confirmation==='phone'?'its CMS telephone number':'its name and place'}</small></>}</td></tr>)}</tbody></table>}
  {data.total>50&&<><button disabled={!offset} onClick={()=>setOffset(Math.max(0,offset-50))}>Previous agencies</button><button disabled={offset+50>=data.total} onClick={()=>setOffset(offset+50)}>Next agencies</button></>}
  {data.services.companyList&&data.total>0&&<p><button className="button" onClick={()=>{void growthPost('rosterCompanies',{},companiesSchema).then(answer=>{
   const url=URL.createObjectURL(new Blob([companyListCsv(answer.companies)],{type:'text/csv'}));const link=document.createElement('a');link.href=url;link.download='caremetric-roster-companies.csv';link.click();URL.revokeObjectURL(url);
  }).catch(e=>setFailure(e instanceof Error?e.message:'The company list could not be built.'));}}>Download the LinkedIn company list</button>
   <br/><small>Every roster agency in LinkedIn's company-list format. Upload it in Campaign Manager → Audiences to show LinkedIn ads to people who work there.</small></p>}
 </section>;
}
/** What the Hub does about people's addresses, as the owner chose on the Settings page. */
function addressNote(data:z.infer<typeof peopleSchema>):string {
 if(!data.services.finder)return 'Only the CMS owners file is read until the people finder\'s database update is released.';
 if(data.services.mode==='none')return 'Names only: no address is looked for (Settings → Customer growth → Finding people\'s addresses).';
 if(data.services.mode==='published')return 'Addresses are kept only when a business publishes them on its own website.';
 return `Addresses a business publishes are kept, and others are checked with its mail server: ${data.creditsToday} of ${data.creditCap} checks used today.`;
}
/** How a waiting address was found, with the page that publishes it. */
function foundHow(p:z.infer<typeof peopleSchema>['items'][number]) {
 if(p.source==='imported')return 'Imported';
 if(p.found==='published'&&p.sourceUrl?.startsWith('https://'))return <a href={p.sourceUrl} target="_blank" rel="noopener noreferrer">Published on its website</a>;
 if(p.found==='mail_server')return 'Confirmed by its mail server';
 if(p.found==='apollo')return 'Apollo';
 return 'Found';
}
/** Decision-makers the team found or the owner imported, waiting for the owner before anything is sent to them. */
function PeoplePanel({revision,onSave}:{revision:number;onSave:(op:string,data:unknown)=>Promise<void>}) {
 const [data,setData]=useState<z.infer<typeof peopleSchema>|null>(null),[failure,setFailure]=useState(''),[chosen,setChosen]=useState<string[]>([]),[csv,setCsv]=useState(''),[note,setNote]=useState('');
 useEffect(()=>{const c=new AbortController();void growthPost('people',{offset:0},peopleSchema,c.signal).then(d=>{if(!c.signal.aborted){setData(d);setFailure('');setChosen([]);}}).catch(e=>{if(!c.signal.aborted)setFailure(e instanceof Error?e.message:'Found people could not be loaded.');});return()=>c.abort();},[revision]);
 const decide=(decision:'permit'|'refuse',ids:string[])=>{if(ids.length)void onSave('peopleDecide',{ids,decision});};
 const parsed=csv.trim()?importRows(csv):null;
 return <section className="panel" aria-labelledby="growth-people-title"><h2 id="growth-people-title">Decision-makers to review{data?` · ${data.waiting}`:''}</h2>
  {failure&&<p>{failure}</p>}{!data&&!failure&&<p role="status">Loading found people…</p>}
  {data&&<><p>People the Marketing Manager found at its best prospects (from the CMS owners file, the NPI registry and their own websites), or that you imported. Nothing is sent to anyone until you permit them. {addressNote(data)}</p>
  {data.services.mode==='verify'&&data.services.mailServer==='unreachable'&&<p role="status">Businesses' mail servers cannot be reached from the Hub, so no address is being checked. Railway allows outbound mail connections (port 25) on its Pro plan only: upgrade the plan, or choose Settings → Customer growth → Finding people's addresses → Addresses businesses publish on their own websites.</p>}
  {data.items.length>0?<><table><thead><tr><th><span className="sr-only">Choose</span></th><th>Person</th><th>Business</th><th>Address</th><th>Source</th></tr></thead><tbody>{data.items.map(p=><tr key={p.id}>
   <td><input type="checkbox" aria-label={`Choose ${p.name}`} checked={chosen.includes(p.id)} onChange={e=>setChosen(e.target.checked?[...chosen,p.id]:chosen.filter(id=>id!==p.id))}/></td>
   <td>{p.name}{p.role&&<><br/><small>{p.role}</small></>}</td><td>{p.organization}<br/><small>{p.domain}</small></td><td>{p.email}</td><td>{foundHow(p)}</td></tr>)}</tbody></table>
   <button className="button button-primary" disabled={!chosen.length} onClick={()=>decide('permit',chosen)}>Permit chosen</button>
   <button className="button" disabled={!chosen.length} onClick={()=>decide('refuse',chosen)}>Do not contact chosen</button>
   <button className="button" onClick={()=>decide('permit',data.items.map(p=>p.id))}>Permit all {data.items.length}</button></>:<p>Nobody is waiting for review.</p>}</>}
  <details><summary>Import a list of prospects</summary>
   <p>A CSV with a header row: name and domain (the business's own website), and optionally product, email (a work address on that domain), contactName and role. Addresses wait for your review here; anyone who unsubscribed is skipped.</p>
   <label htmlFor="growth-import-csv">Prospects (CSV)</label>
   <textarea id="growth-import-csv" aria-labelledby="growth-import-csv" rows={6} value={csv} onChange={e=>setCsv(e.target.value)} placeholder={'name,domain,email,contactName,role\nValley Hospice,valleyhospice.org,jane@valleyhospice.org,Jane Doe,Administrator'}/>
   {parsed?.error&&<p role="alert">{parsed.error}</p>}{note&&<p role="status">{note}</p>}
   <button className="button" disabled={!parsed||Boolean(parsed.error)} onClick={()=>{if(parsed&&!parsed.error){void onSave('import',{rows:parsed.rows}).then(()=>{setNote(`Imported ${parsed.rows.length} rows.`);setCsv('');});}}}>Import {parsed&&!parsed.error?parsed.rows.length:''} prospects</button>
  </details>
 </section>;
}
const memoStatus:Record<string,string>={proposed:'Waiting for you',active:'In use',retired:'Replaced',rejected:'Turned down'};
/** The weekly "what is working" memos: written by code from the team's own counts, used in drafts only after the owner chooses one. */
function LearningPanel({revision,onSave}:{revision:number;onSave:(op:string,data:unknown)=>Promise<void>}) {
 const [data,setData]=useState<z.infer<typeof learningSchema>|null>(null),[failure,setFailure]=useState('');
 useEffect(()=>{const c=new AbortController();void growthPost('learning',{},learningSchema,c.signal).then(d=>{if(!c.signal.aborted){setData(d);setFailure('');}}).catch(e=>{if(!c.signal.aborted)setFailure(e instanceof Error?e.message:'The memos could not be loaded.');});return()=>c.abort();},[revision]);
 return <section className="panel" aria-labelledby="growth-learning-title"><h2 id="growth-learning-title">What is working</h2>
  {failure&&<p>{failure}</p>}{!data&&!failure&&<p role="status">Loading the memos…</p>}
  {data&&<><p>Each Monday the Marketing Manager writes a short memo from 90 days of its own counts: replies by message type, the objections replies raised, the checks drafts failed and your notes on drafts you turned down. A memo shapes new outreach drafts only after you choose to use it, or as soon as it is written once you hand the learning memo over on the AI team page.</p>
  {!data.services.enabled&&<p role="status">To start: turn on Settings → Customer growth → Write from what is working.</p>}
  {data.memos.length?data.memos.map(m=><article key={m.id}><h3>{names[m.product]} · memo {m.version} · {memoStatus[m.status]??m.status}</h3>
   <p><small>Written {new Date(m.createdAt).toLocaleDateString()} from {m.stats.sent??0} emails and {m.stats.replied??0} replies</small></p>
   <pre style={{whiteSpace:'pre-wrap'}}>{m.memo}</pre>
   {m.status==='proposed'&&<><button className="button button-primary" onClick={()=>void onSave('learningDecide',{id:m.id,decision:'activate'})}>Use this memo</button>
    <button className="button" onClick={()=>void onSave('learningDecide',{id:m.id,decision:'reject'})}>Turn down</button></>}
  </article>):<p>No memo yet. One is written when there is something worth saying: at least 20 emails of each kind compared, an objection raised three times, or a note on a draft you turned down.</p>}</>}
 </section>;
}
function BriefPanel({id,revision}:{id:string;revision:number}) {
 const [entry,setEntry]=useState<{id:string;revision:number;data:z.infer<typeof briefSchema>}|null>(null),[failure,setFailure]=useState('');
 useEffect(()=>{const c=new AbortController();void growthPost('brief',{id},briefSchema,c.signal).then(data=>{if(!c.signal.aborted){setEntry({id,revision,data});setFailure('');}}).catch(e=>{if(!c.signal.aborted)setFailure(e instanceof Error?e.message:'The account brief could not be loaded.');});return()=>c.abort();},[id,revision]);
 const brief=entry?.id===id?entry.data.brief:null;
 return <section aria-labelledby="growth-brief-title"><h3 id="growth-brief-title">Account brief</h3>
  {failure&&<p>{failure}</p>}{!entry&&!failure&&<p role="status">Loading the account brief…</p>}
  {entry?.id===id&&!brief&&<p>No brief yet. Agencies about to be written to are briefed first.</p>}
  {brief&&<><p>{brief.writer.summary}{brief.writer.serviceArea?` Serves ${brief.writer.serviceArea}.`:''}{brief.writer.ownership?` ${brief.writer.ownership}.`:''}</p>
   {brief.writer.triggers.length>0&&<><p>Why now:</p><ul>{brief.writer.triggers.map(t=><li key={t.sourceUrl+t.fact}>{t.fact}{t.date?` (${t.date})`:''} <a href={t.sourceUrl} target="_blank" rel="noreferrer">source</a></li>)}</ul></>}
   {brief.writer.hook&&<p>Opening: {brief.writer.hook.sentence}</p>}
   {brief.writer.countyFact&&<p>County figure: {brief.writer.countyFact.claim}</p>}
   {brief.writer.pains.length>0&&<><p>Questions to ask:</p><ul>{brief.writer.pains.map(p=><li key={p.question}>{p.question}{p.capability?` (${p.capability})`:''}</li>)}</ul></>}
   <p>Lead with: {String(brief.writer.angle??'').replaceAll('_',' ')}{brief.research.angleReason?` · ${brief.research.angleReason}`:''}</p>
   <p>Brief's fit: {brief.research.fit??'—'}{brief.research.fitReasons.length?` · ${brief.research.fitReasons.join('; ')}`:''}</p>
   {brief.research.leaders.length>0&&<p>Leaders: {brief.research.leaders.map(l=>`${l.name} (${l.title})`).join(', ')}</p>}
   {brief.research.questions.length>0&&<p>Still to learn: {brief.research.questions.join(' ')}</p>}
   <p><small>Version {brief.version}, written {new Date(brief.updatedAt).toLocaleString()}. Emails never state the agency's own share, rank or ratings.</small></p></>}
 </section>;
}
const checkModes:Record<string,string>={off:'Off',check:'On: never write to a mailbox that does not exist',strict:'Strict: also hold an address no server answered for'};
function SendGuardPanel({revision,onSave}:{revision:number;onSave:(op:string,data:unknown)=>Promise<void>}) {
 const [data,setData]=useState<z.infer<typeof sendGuardSchema>|null>(null),[failure,setFailure]=useState('');
 useEffect(()=>{const c=new AbortController();void growthPost('sendGuard',{},sendGuardSchema,c.signal).then(d=>{if(!c.signal.aborted){setData(d);setFailure('');}}).catch(e=>{if(!c.signal.aborted)setFailure(e instanceof Error?e.message:'The send guard could not be loaded.');});return()=>c.abort();},[revision]);
 return <section className="panel" aria-labelledby="growth-guard-title"><h2 id="growth-guard-title">Send guard</h2>
  {failure&&<p>{failure}</p>}{!data&&!failure&&<p role="status">Loading the send guard…</p>}
  {data&&<><p>Checking addresses before the first email: {checkModes[data.mode]}. Checked so far: {data.addresses.verified} confirmed, {data.addresses.catchAll} on servers that accept any address, {data.addresses.undeliverable} that do not exist, {data.addresses.unanswered} not answered yet, {data.addresses.unchecked} waiting.</p>
  {!data.on&&<p role="status">The bounce guard is off. To have cold email pause itself when it bounces, set Settings → Customer growth → Pause cold email at this bounce rate.</p>}
  {data.on&&<p role={data.tripped?'alert':undefined}>{data.tripped?'Cold email is paused. ':'Cold email is going out. '}Since {data.since?new Date(data.since).toLocaleDateString():'—'}: {data.sent??0} cold emails, {data.bounced??0} bounced for good, {data.complaints??0} marked as spam (limit {data.percent}%, counted from 20 emails).</p>}
  {data.on&&data.tripped&&<button className="button button-primary" onClick={()=>void onSave('sendGuardResume',{})}>Resume cold email</button>}</>}
 </section>;
}
export function Growth() {
 const [workspace,setWorkspace]=useState<{offset:number;data:z.infer<typeof workspaceSchema>}|null>(null),[offset,setOffset]=useState(0),[revision,setRevision]=useState(0),[error,setError]=useState(''),[busy,setBusy]=useState(false),[selected,setSelected]=useState<string|null>(null);
 const [detailEntry,setDetail]=useState<{id:string;revision:number;data:z.infer<typeof detailSchema>}|null>(null);
 const [workspaceFailure,setWorkspaceFailure]=useState<{offset:number;revision:number;message:string}|null>(null);
 const [detailFailure,setDetailFailure]=useState<{id:string;revision:number;message:string}|null>(null);
 const data=workspace?.offset===offset?workspace.data:null;
 const detail=detailEntry?.id===selected&&detailEntry?.revision===revision?detailEntry.data:null;
 const workspaceError=workspaceFailure?.offset===offset&&workspaceFailure.revision===revision?workspaceFailure.message:'';
 const detailError=detailFailure?.id===selected&&detailFailure?.revision===revision?detailFailure.message:'';
 useEffect(()=>{const c=new AbortController();void growthPost('workspace',{offset},workspaceSchema,c.signal).then(data=>{if(!c.signal.aborted){setWorkspace({offset,data});setWorkspaceFailure(null);}}).catch(e=>{if(!c.signal.aborted)setWorkspaceFailure({offset,revision,message:e instanceof Error?e.message:'Customer growth could not be loaded.'});});return()=>c.abort();},[offset,revision]);
 useEffect(()=>{if(!selected)return;const c=new AbortController();void growthPost('detail',{id:selected},detailSchema,c.signal).then(data=>{if(!c.signal.aborted){setDetail({id:selected,revision,data});setDetailFailure(null);}}).catch(e=>{if(!c.signal.aborted)setDetailFailure({id:selected,revision,message:e instanceof Error?e.message:'Organization details could not be loaded.'});});return()=>c.abort();},[selected,revision]);
 const save=useCallback(async(op:string,input:unknown)=>{setBusy(true);setError('');try{await growthMutation(op,input);setRevision(n=>n+1);}catch(e){setError(e instanceof Error?e.message:'Result unconfirmed. Refresh before retrying.');}finally{setBusy(false);}},[]);
 const item=data?.items.find(i=>i.id===selected);
 return <div className="admin-workspace growth-workspace"><header className="admin-page-header"><h1>Customer growth</h1><p>Acquire, activate and retain CareBase and CareMetric Intel customers. Breathe is deferred.</p><Link to="/admin/team">Review message approvals and agent controls</Link></header>
 {error&&<p role="alert">{error}</p>}{workspaceError&&<p role="alert">{workspaceError}</p>}{!data&&!workspaceError&&<p role="status">Loading customer growth…</p>}
 <button className="button" onClick={()=>setRevision(n=>n+1)}>Refresh</button>
 {data&&<><section className="panel"><h2>Readiness</h2><p>Sending: {data.services.sending?'enabled':'disabled'} · Research: {data.services.research?'ready':'not configured'} · Unsubscribe signing: {data.services.signing?'ready':'not configured'} · Sender address: {data.services.postalAddress?'ready':'needed'}</p><p>Sending also requires an active agent, a reviewed policy and an eligible verified contact.</p></section>
 {data.services.roster&&<RosterPanel revision={revision}/>}
 {data.services.people&&<PeoplePanel revision={revision} onSave={save}/>}
 {data.services.addressCheck&&<SendGuardPanel revision={revision} onSave={save}/>}
 {data.services.learning&&<LearningPanel revision={revision} onSave={save}/>}
 <fieldset disabled={busy} style={{border:0,padding:0}}>
 <details className="panel"><summary>Add a prospect or customer</summary><form onSubmit={e=>{e.preventDefault();const f=new FormData(e.currentTarget);void save('create',{name:value(f,'name'),domain:value(f,'domain').toLowerCase(),product:value(f,'product'),email:value(f,'email'),contactName:value(f,'contactName'),role:value(f,'role'),goal:value(f,'goal'),...(value(f,'tenantId')?{tenantId:value(f,'tenantId')}:{}),internal:f.has('internal')});}}>
 <label>Organization<input name="name" maxLength={200} required/></label><label>Business domain<input name="domain" placeholder="example.org" required/></label>
 <label>Product<select name="product"><option value="carebase">CareBase</option><option value="caremetric-intel">CareMetric Intel</option></select></label>
 <label>Business email<input name="email" type="email"/></label><label>Contact name<input name="contactName" maxLength={200}/></label><label>Role<input name="role" maxLength={200}/></label>
 <label>Customer goal<textarea name="goal" maxLength={2000}/></label><label>Existing Hub tenant ID, if applicable<input name="tenantId"/></label>
 <label><input type="checkbox" name="internal"/> Internal account; exclude from outreach</label><button className="button button-primary">Add to pipeline</button></form></details>
 <section className="panel"><h2>Pipeline · {data.total} opportunities</h2><table><thead><tr><th>Organization</th><th>Product</th><th>Stage</th><th>Next action</th><th>Due</th></tr></thead><tbody>{data.items.map(o=><tr key={o.id}><td><button onClick={()=>{if(selected!==o.id){setDetail(null);setSelected(o.id);}}}>{o.name}</button>{o.internal?' (internal)':''}</td><td>{names[o.product]}</td><td>{o.stage}</td><td>{o.next_action}</td><td>{new Date(o.next_at).toLocaleString()}</td></tr>)}</tbody></table>
 {!data.items.length&&<p>Add organizations or enable reviewed discovery to build the pipeline.</p>}
 <button disabled={!offset} onClick={()=>setOffset(Math.max(0,offset-50))}>Previous</button><button disabled={offset+50>=data.total} onClick={()=>setOffset(offset+50)}>Next</button></section>
 {item&&<section className="panel" key={`${item.id}:${item.version}`}><h2>{item.name} · {names[item.product]}</h2><p>Contact: {item.email??'Missing'} · {item.eligibility??'Needs a contact'} · Owner: {item.owner_agent.replaceAll('_',' ')}</p>
 {detailError&&<p role="alert">{detailError}</p>}{!detail&&!detailError&&<p role="status">Loading organization details…</p>}
 <p>Evidence-based fit: {item.fit??"Not assessed"} · Observed intent: {item.intent??"Unknown"}</p><p>{String(item.memory.researchRationale??"")}</p>
 {data.services.briefs&&item.product==='caremetric-intel'&&<BriefPanel id={item.id} revision={revision}/>}
 <OpportunityEditor item={item} onSave={save}/><button className="button" onClick={()=>void save('research',{id:item.id})}>Research this organization</button>
 {item.contact_id&&<form onSubmit={e=>{e.preventDefault();const f=new FormData(e.currentTarget);void save('contact',{id:item.contact_id,version:item.contact_version,eligibility:value(f,'eligibility'),verified:f.has('verified'),sourceUrl:value(f,'sourceUrl')});}}>
 <h3>Contact eligibility</h3><select aria-label="Contact eligibility" name="eligibility" defaultValue={item.eligibility??'review'}><option value="review">Needs review</option><option value="permitted">Outreach permitted</option><option value="opted_out">Do not contact</option><option value="undeliverable">Mailbox does not exist</option></select>
 <label>Verification source<input name="sourceUrl" type="url"/></label><label><input type="checkbox" name="verified" defaultChecked={Boolean(item.verified_at)}/> Business contact and channel eligibility verified</label><button>Save contact review</button></form>}
 <h3>Evidence</h3>{detail?.evidence.map(e=><p key={e.id}><a href={e.source_url} target="_blank" rel="noreferrer">Source</a> · {e.confidence} · {new Date(e.observed_at).toLocaleDateString()} · {e.claim}</p>)}
 <form onSubmit={e=>{e.preventDefault();const f=new FormData(e.currentTarget);void save('evidence',{opportunityId:item.id,sourceUrl:value(f,'sourceUrl'),claim:value(f,'claim'),confidence:value(f,'confidence'),observedAt:new Date().toISOString()});}}><label>Source URL<input name="sourceUrl" type="url" required/></label><label>Verified fact<textarea name="claim" maxLength={4000} required/></label><select aria-label="Evidence confidence" name="confidence"><option>low</option><option>medium</option><option>high</option></select><button>Add evidence</button></form>
 <h3>Message history</h3>{detail?.messages.map(m=><details key={m.id}><summary>{m.subject} · {m.status}{m.recipients.length>1?` · ${m.recipients.length} people`:''}</summary><p style={{whiteSpace:'pre-wrap'}}>{m.body}</p><p>{m.model_generated?'Model draft — individual approval required':'Approved-template draft'}</p><Recipients message={m} onSave={save}/>{m.status==='unknown'&&<ReconcileForm id={m.id} onSave={save}/>}</details>)}
 <h3>Verified activity</h3>{detail?.events.map((e,i)=><p key={i}>{e.kind} · {new Date(e.occurred_at).toLocaleString()}</p>)}
 </section>}
 <section className="panel"><h2>Customer success and follow-up</h2>{!data.work.length&&<p>No open follow-ups.</p>}{data.work.map(w=><details key={w.id}><summary>{w.name} · {w.kind} · due {new Date(w.due_at).toLocaleString()}</summary><p>{w.action}</p><p>Success: {w.success_criterion}</p><form onSubmit={e=>{e.preventDefault();void save('resolve',{id:w.id,outcome:value(new FormData(e.currentTarget),'outcome')});}}><label>Observed outcome<textarea name="outcome" required maxLength={2000}/></label><button>Record resolution</button></form></details>)}</section>
 {data.policies.map(p=><PolicyEditor key={`${p.product}:${p.version}`} policy={p} onSave={save}/>)}
 </fieldset>
 <section className="panel"><h2>Search and content proposals</h2><p>Review briefs in Team, then use the approved brief in the existing publishing workflow. Search results do not establish search volume.</p>{data.content.map(c=><details key={c.id}><summary>{c.campaign} · {c.status}</summary><p style={{whiteSpace:'pre-wrap'}}>{c.preview}</p></details>)}</section>
 <section className="panel" tabIndex={0} aria-labelledby="growth-outcomes-title"><h2 id="growth-outcomes-title">Outcomes by product and cohort</h2><p>Retention counts include only customers old enough to measure. Provider acceptance is separate from delivery.</p>
 <table><thead><tr><th>Product / cohort / source / stage</th><th>Accounts</th><th>Replies / meetings / trials</th><th>Activated / paid</th><th>Overdue</th><th>30 / 60 / 90 day retention</th></tr></thead><tbody>{data.metrics.map((m,i)=><tr key={i}><td>{m.product} / {m.cohort.slice(0,7)} / {m.source} / {m.stage}</td><td>{m.accounts}</td><td>{m.positive_replies} / {m.meetings} / {m.trials}</td><td>{m.activated} / {m.paid}</td><td>{m.overdue}</td><td>{m.retained_30d}/{m.eligible_30d} · {m.retained_60d}/{m.eligible_60d} · {m.retained_90d}/{m.eligible_90d}</td></tr>)}</tbody></table>
 <ul>{data.deliveries.map((d,i)=><li key={i}>{d.product} · {d.variant} · {d.status}: {d.count}</li>)}</ul></section>
 </>}
 </div>;
}
