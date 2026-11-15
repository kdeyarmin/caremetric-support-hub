import { live } from '../live.mjs';
import { contentBrief } from './content.mjs';
import { weekStart } from '../agents/accounts/week.mjs';
import { assessProspect } from './assessment.mjs';
import { planOpportunity, products } from './policy.mjs';
import { marketedNow, markets } from '../agents/marketing.mjs';
import { draftMessage } from './draft.mjs';
import { growthLearningFeature } from './learning.mjs';
import { renderEmail, themeFor } from '../email-layout.mjs';
import { evaluateGrowth } from './evaluation.mjs';
import { enrichProspects } from './enrichment.mjs';
import { discoveryQueries, linkablePages, senderFor } from './playbook.mjs';
import { searchResultLimit } from './research.mjs';
import { untaggedUrl } from '../agents/links.mjs';
import { chooseSite, confirmsSite, resolutionQuery, rosterLookupsPerRun, rosterPagesPerRun, rosterRefreshMs, rosterRow, rosterStates } from './roster.mjs';
const deferred=()=>Object.assign(new Error('Action is deferred'),{code:'action_deferred'});
const easternDay=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'});
/** The calendar day in America/New_York, matching every other send cap and notice. */
export const growthDay=instant=>easternDay.format(instant);
/** Every opportunity in the pipeline, read a page at a time; null when the store cannot list them. */
async function pipelineItems(growth,signal) {
  if(typeof growth.store.snapshot!=='function')return null;
  const items=[]; let offset=0,total=1;
  while(offset<total) {
    signal?.throwIfAborted(); const page=await growth.store.snapshot(offset); signal?.throwIfAborted();
    if(!page.items.length)break;
    items.push(...page.items); offset+=page.items.length; total=page.total;
  }
  return items;
}
/** Sales follow-ups and capped cold email (20261105150000_growth_autonomy.sql): the contact finder, qualification and the daily evaluation. */
export const growthAutonomyFeature='platform.agents.growth-autonomy.v1';
/** One re-ask and the experiment arms (20261113172000_growth_reengage.sql). */
export const growthReengageFeature='platform.agents.growth-reengage.v1';
/** Each cold touch also to the other decision-makers at the organization (20261115230000_growth_colleagues.sql). */
export const growthColleaguesFeature='platform.agents.growth-colleagues.v1';
// Colleague emails recorded and proposed on one sweep at most: a few touches' worth, so a sweep never spends its time on them.
export const colleagueLimit=20;
/**
 * What a colleague's own opt-out link is signed for: its touch's work and its person, so each person's link is their own and stays the
 * same across retries. The claim returns the same text as `unsubscribeKey` (a primary contact's is the work alone, as before).
 */
export const colleagueUnsubscribeKey=(workId,contactId)=>`${workId}:${contactId}`;
// Businesses the contact finder reads per discovery run (the most the database hands out at once), how many it reads at the same
// time (each is a different business's website), how many more it reads on each fifteen-minute pipeline sweep so a day's
// discoveries are all read the same day, and opportunities qualified per pass.
export const contactSearchLimit=20;
export const contactSearchConcurrency=4;
export const sweepContactLimit=4;
export const qualifyLimit=100;
// Fit assessments per pipeline sweep. A day's discoveries are assessed over the next few sweeps instead of in one that outruns the
// scheduler's four minutes; an assessment the model could not give is not asked for again for six hours.
export const assessLimit=20;
export const assessRetryMs=6*3_600_000;
// A sweep or a discovery run stops starting new model calls, searches and website reads this long after it began, and leaves the
// rest for the next run, so it always ends inside the scheduler's four minutes.
export const workBudgetMs=150_000;
// The database takes at most ten discovered rows in one call (private.growth_discover).
const discoverBatch=10;
const batches=(rows,size)=>Array.from({length:Math.ceil(rows.length/size)},(_,index)=>rows.slice(index*size,(index+1)*size));
const pause=(ms,signal)=>ms>0?new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{signal?.removeEventListener('abort',stop);resolve();},ms);
  const stop=()=>{clearTimeout(timer);reject(signal.reason);};
  signal?.addEventListener('abort',stop,{once:true});
}):Promise.resolve();
const declared=features=>features instanceof Set?features.has(growthAutonomyFeature):Array.isArray(features)&&features.includes(growthAutonomyFeature);
/** Whether a work item's last message was cancelled (not withdrawn) under exactly the opportunity, contact and policy it would be drafted against now. */
export const unchangedSinceCancelled=(existing,o)=>existing?.message_status==='cancelled' && existing.message_withdrawn===false
  && Number.isInteger(existing.message_opportunity_version) && existing.message_opportunity_version===o.version
  && existing.message_contact_version===o.contact_version && existing.message_policy_version===o.policy?.version;
// Claim outcomes that mean "never send this one": the hand-over was withdrawn, or the business was already contacted once.
const finalRefusals=new Set(['outreach_off','business_contacted']);
// A model answer that is cut off, invalid or refused for one opportunity's input says nothing about the others: skip that one and
// carry on, as the concierge does. A transient failure (rate limit, outage, the task's own deadline) and a failure of the model
// account itself still stop the sweep, so the scheduler retries it or reports it.
const perOpportunityModelCodes=new Set(['output_truncated','output_invalid','request_rejected']);
async function oneAnswer(call,signal) {
  try { return await call(); }
  catch(error) { if(signal?.aborted||error?.transient===true||!perOpportunityModelCodes.has(error?.code))throw error; return null; }
}

// `marketed` (agents/marketing.mjs): the products the Marketing Manager may find, research and email prospects for, read from the
// owner's switches when each task starts. A prospect of another product (CareBase while it is in its pilot) gets no research, no plan
// and no email; customers' work is not affected.
export function growthHandlers({growth,model,notifier,features=null,marketed=null,clock=()=>Date.now()}) {
  if(!growth)return {};
  const autonomy=declared(features);
  const reengaging=features instanceof Set?features.has(growthReengageFeature):Array.isArray(features)&&features.includes(growthReengageFeature);
  const colleagues=(features instanceof Set?features.has(growthColleaguesFeature):Array.isArray(features)&&features.includes(growthColleaguesFeature))
    &&typeof growth.store.colleagueCandidates==='function';
  // The owner-approved learning memo (learning.mjs), while Settings → Customer growth → "Write from what is working" is on.
  const learning=(features instanceof Set?features.has(growthLearningFeature):Array.isArray(features)&&features.includes(growthLearningFeature))
    &&typeof growth.store.learningActive==='function';
  // Assessments and drafts the model could not give, by opportunity and what it was asked about, and when: kept in this process
  // only, so a restart asks once more. Without it every fifteen-minute sweep would pay for the same unanswerable request again.
  const unanswered=new Map();
  /**
   * Reads up to `limit` discovered businesses' own websites, a few at a time, for one public role address each and for what the home
   * page says the business is. The address is recorded as the business's one contact; the home page summary becomes dated evidence
   * for each product the business is already a prospect of (`productsByDomain`), so the next sweep can reassess its fit from its own
   * words. Stops early once the run's time is spent. Only counts are returned: never an address or page text.
   */
  async function findContacts(limit,productsByDomain,{signal,spent}) {
    const counts={searched:0,found:0,none:0,described:0};
    const targets=await growth.store.contactCandidates(limit);
    for(const group of batches(targets,contactSearchConcurrency)) {
      signal?.throwIfAborted(); if(spent())break;
      const answers=await Promise.all(group.map(async target=>{
        try {return await growth.contacts.find(target.domain,{signal});} catch(error) {if(signal?.aborted)throw error;return {email:null};}
      }));
      signal?.throwIfAborted();
      for(const [index,target] of group.entries()) {
        const found=answers[index]??{email:null}; counts.searched++;
        let recorded=null;
        try {recorded=await growth.store.recordContact(target.id,found.email??null,found.email?found.sourceUrl:null);}
        catch(error) {if(error?.code!=='22023')throw error; recorded=await growth.store.recordContact(target.id,null,null);}
        if(recorded?.found)counts.found++; else counts.none++;
        const site=found.site;
        if(!site?.claim||!/^https:\/\//.test(site.url??''))continue;
        for(const product of productsByDomain?.get(target.domain)??[]) {
          try {await growth.store.discover(product,[{name:target.domain,domain:target.domain,url:String(site.url).slice(0,2000),claim:String(site.claim).slice(0,4000)}]);counts.described++;}
          catch(error) {if(error?.code!=='22023')throw error;}
        }
      }
    }
    return counts;
  }
  /**
   * The same touch to the other decision-makers at each organization a cold touch reached in the last 48 hours: the database chooses
   * them (permitted named people there, best role first, within Settings → Customer growth → Most people to email at one organization,
   * and after touch 1 only those who received the touch before) and records each as its own email, a copy of the touch's approved words.
   * Each is proposed like any message, so the cold-email hand-over decides whether it waits for the owner, and the send claim checks
   * each person again. Only counts are returned: never an address.
   */
  async function prepareColleagues(task,marketedList,{signal}) {
    const counts={proposed:0,skipped:0};
    for(const item of await growth.store.colleagueCandidates(colleagueLimit)) {
      signal?.throwIfAborted();
      if(!markets(marketedList,item.product)){counts.skipped++;continue;}
      let saved;
      try {saved=await growth.store.colleagueDraft(item.primaryId,item.contactId,growth.hash(growth.unsubscribeToken(colleagueUnsubscribeKey(item.workId,item.contactId))));}
      catch(error) {if(error?.code!=='22023'&&error?.code!=='40001')throw error; counts.skipped++; continue;}
      if(saved?.id&&saved.status==='draft'&&!saved.actionId){await growth.store.propose(task.id,saved.id);counts.proposed++;}
      else counts.skipped++;
    }
    return counts;
  }
  const productsOf=(map,o)=>{if(!o?.domain||!products.includes(o.product))return;const known=map.get(o.domain)??new Set();known.add(o.product);map.set(o.domain,known);};
  async function sweep(task,{signal,now=()=>new Date()}={}) {
    await growth.store.maintenance?.();
    const started=clock(),spent=()=>clock()-started>=workBudgetMs;
    const owner=task.kind==='growth.success'?'account_manager':'marketing_manager'; let inspected=0,planned=0,drafted=0,offset=0,total=1,assessed=0,undrafted=0,reengaged=0;
    // Why drafts were not kept, by check (draft.mjs codes), so the run shows which rule throws good openings away.
    const rejected={};
    // Each product's active memo, read once a sweep.
    const memos=new Map();
    const memoFor=async product=>{
      if(!learning||live(growth.learning?.enabled)!==true)return null;
      if(!memos.has(product))memos.set(product,await growth.store.learningActive(product)??null);
      return memos.get(product);
    };
    const marketedList=owner==='marketing_manager'?await marketedNow(marketed):null;
    const prospecting=autonomy&&owner==='marketing_manager'&&task.agent?.autonomy!=='observe';
    const productsByDomain=new Map();
    // Researched prospects that meet the qualification rules move to qualified before the pipeline is read (nothing is sent here).
    if(prospecting&&reengaging&&typeof growth.store.reengage==='function')reengaged=(await growth.store.reengage(50))?.reengaged??0;
    if(prospecting)await growth.store.autoQualify(qualifyLimit);
    while(offset<total) {
      signal?.throwIfAborted(); const page=await growth.store.snapshot(offset);total=page.total;offset+=page.items.length;if(!page.items.length)break;
      for(const o of page.items) {
        signal?.throwIfAborted(); if(o.owner_agent!==owner)continue; inspected++;
        if(owner==='marketing_manager' && !markets(marketedList,o.product))continue;
        if(prospecting && ['identified','researched','qualified'].includes(o.stage))productsOf(productsByDomain,o);
        const plans=planOpportunity(o,now());
        if(task.agent?.autonomy==='observe')continue;
        if(owner==='marketing_manager' && ['identified','researched'].includes(o.stage) && (!o.assessed_at || (o.evidence??[]).some(e=>Date.parse(e.observed_at)>Date.parse(o.assessed_at)))) {
          const asked=`${o.id}:${o.version??''}:${(o.evidence??[]).length}`;
          const waiting=clock()-(unanswered.get(asked)??-Infinity)<assessRetryMs;
          if(!waiting&&assessed<assessLimit&&!spent()) {
            assessed++;
            const assessment=await oneAnswer(()=>assessProspect(o,task,model,signal),signal);
            signal?.throwIfAborted();
            if(assessment) {unanswered.delete(asked);await growth.store.assess(o.id,assessment);continue;}
            if(model?.configured)unanswered.set(asked,clock());
          }
        }
        for(const work of plans) {
          signal?.throwIfAborted(); const existing=(o.work??[]).find(w=>w.trigger_key===work.key);
          if(existing?.status==='resolved'||existing?.status==='cancelled')continue;
          const id=await growth.store.plan(o.id,work);planned++;
          if(!['outreach','onboarding','activation','trial','adoption','renewal','expansion','support','recovery'].includes(work.kind)||o.eligibility!=='permitted'||!growth.signingReady)continue;
          if(existing?.message_id && existing.message_status!=='cancelled') {if(existing.message_status==='draft')await growth.store.propose(task.id,existing.message_id);continue;}
          // Cancelled for a lasting reason (the contact unsubscribed, the business replied, the business was already contacted) with
          // nothing changed since: a new draft would pay for a model call and get that same cancelled message back, every sweep. Only a
          // withdrawn message (the owner took the hand-over back), or a change of the opportunity, contact or policy, opens the work
          // again. A database that does not report these fields yet keeps the old behaviour.
          if(unchangedSinceCancelled(existing,o))continue;
          // Out of time: the work is planned, and the next sweep writes its message.
          if(spent())continue;
          // A draft the model could not give, or that failed its checks, under exactly this opportunity, contact and policy: not paid
          // for again for six hours. One such prospect, retried every sweep, would otherwise spend the day's whole budget.
          const wanted=`draft:${o.id}:${work.key}:${o.version??''}:${o.contact_version??''}:${o.policy?.version??''}`;
          if(clock()-(unanswered.get(wanted)??-Infinity)<assessRetryMs)continue;
          const memo=work.kind==='outreach'?await memoFor(o.product):null;
          const report=work.kind==='outreach'?growth.reports?.linkFor?.(o)??null:null;
          const draft=await oneAnswer(()=>draftMessage({opportunity:o,work,task,model,signal,memo,report,onReject:code=>{rejected[code]=(rejected[code]??0)+1;}}),signal);
          if(!draft){if(model?.configured){unanswered.set(wanted,clock());undrafted++;}continue;}
          signal?.throwIfAborted();
          let saved;
          try {
            saved=await growth.store.draft(o.id,id,{...draft,version:o.version,contactVersion:o.contact_version,policyVersion:o.policy.version,purpose:work.kind==='outreach'?'marketing':'success',unsubscribeHash:growth.hash(growth.unsubscribeToken(id)),variant:draft.variant??'control',arms:draft.arms??{}});
          } catch (error) {
            // An owner edit during drafting invalidates this output. The next sweep reads fresh context.
            if(error?.code==='40001')continue;
            throw error;
          }
          if(saved.status==='draft')await growth.store.propose(task.id,saved.id);drafted++;
        }
      }
    }
    // The touches sent since the last sweep go to the organization's other decision-makers too.
    let colleagueEmails=0;
    if(prospecting&&colleagues&&growth.signingReady&&!spent())colleagueEmails=(await prepareColleagues(task,marketedList,{signal})).proposed;
    // A few more discovered businesses' websites are read on every sweep, so a day's discoveries all get a contact search and a home
    // page summary the same day. No search provider is called here: only the business's own site is read.
    let contacts=null;
    if(prospecting&&growth.contacts?.configured&&typeof growth.store.contactCandidates==='function'&&!spent())contacts=await findContacts(sweepContactLimit,productsByDomain,{signal,spent});
    if(planned && notifier)await notifier.send({severity:'info',subject:'Customer growth work is ready',body:`${planned} follow-up tasks reviewed; ${drafted} message drafts prepared. Open Growth to review next actions.`,dedupeKey:`growth:${owner}:${growthDay(now())}`,agentKey:owner,taskId:task.id});
    return {result:{inspected,planned,drafted,...(undrafted?{undrafted}:{}),...(Object.keys(rejected).length?{rejected}:{}),...(reengaged?{reengaged}:{}),...(colleagueEmails?{colleagues:colleagueEmails}:{}),...(contacts?.searched?{contacts}:{})}};
  }
  async function discover(task,{signal,now=()=>new Date()}={}) {
    if(!growth.research?.configured)return {result:{skipped:'research_not_configured'}};
    if(task.agent?.autonomy==='observe')return {result:{skipped:'observe_only'}};
    const started=clock(),spent=()=>clock()-started>=workBudgetMs;
    let candidates=0,searches=0,stopped=null;
    const marketedList=await marketedNow(marketed);
    const searched=products.filter(product=>markets(marketedList,product));
    if(!searched.length)return {result:{skipped:'no_marketed_product'}};
    // The search provider's own pacing between calls (research.mjs), so several searches a day stay inside its rate limit.
    const pace=Number(growth.research.paceMs)||0;
    // Several different segment-and-place searches each day (playbook.mjs), twenty results each, so discovery keeps finding new
    // organizations; CareBase stays in Pennsylvania. The first search failing fails the run, so the scheduler retries it; a later one
    // failing (a rate limit, an outage) ends the day's searching and keeps what was found.
    search: for(const product of searched) {
      for(const {query,offset} of discoveryQueries(product,now())) {
        signal?.throwIfAborted(); if(spent()){stopped='time';break search;}
        if(searches)await pause(pace,signal);
        let rows;
        try {rows=await growth.research.search(product,{query,offset,count:searchResultLimit,signal});}
        catch(error) {if(signal?.aborted||!searches)throw error; stopped='search_unavailable';break search;}
        signal?.throwIfAborted(); searches++;
        for(const batch of batches(rows,discoverBatch))candidates+=await growth.store.discover(product,batch);
      }
    }
    // Search the organization's own pages where the first discovery snippet did not establish fit. New dated evidence lets the
    // next pipeline sweep reassess the prospect; it never lowers the qualification threshold or changes contact permissions.
    const items=await pipelineItems(growth,signal);
    let enrichment=null;
    // The same time limit as the discovery searches: enrichment starts no search once the run's time is spent.
    if(!stopped)try {enrichment=await enrichProspects({growth,marketed:marketedList,moment:now(),signal,items,pace,spent});}
    catch(error) {if(signal?.aborted)throw error; stopped='search_unavailable';}
    if(!stopped&&spent())stopped='time';
    // What the search provider says the key may still use this month (research.mjs `searchAllowance`), so the run's result on the Team
    // screen shows whether the plan covers the day's searches. Absent when the provider does not say.
    const allowance=growth.research.allowance?.()??null;
    const researched={searches,...(stopped?{stopped}:{}),...(enrichment?{enrichment}:{}),...(allowance?{searchAllowance:allowance}:{})};
    if(!autonomy||!growth.contacts?.configured)return {result:{candidates,...researched}};
    // The contact finder reads each new business's own website for one public role address and for what its home page says it is; a
    // business with no address stays without a contact (and is not read again for 90 days). Only the counts are kept here: never an
    // address. What this run does not reach, the pipeline sweeps read through the day.
    const productsByDomain=new Map();
    for(const o of items??[])if(o.owner_agent==='marketing_manager'&&markets(marketedList,o.product)&&['identified','researched','qualified'].includes(o.stage))productsOf(productsByDomain,o);
    const contacts=await findContacts(contactSearchLimit,productsByDomain,{signal,spent});
    const qualified=(await growth.store.autoQualify(qualifyLimit))?.qualified??0;
    return {result:{candidates,contacts,qualified,...researched}};
  }
  /**
   * The Medicare roster (Intel's marketing feed; 20261113170500_growth_roster.sql). Each run reads up to eight pages of the roster when
   * a read is due (a new set of states, an unfinished read, or a week since the last complete one), then looks up the best-ranked
   * agencies' own websites, within the owner's daily number: one search for the agency, the contact finder on the chosen site (which
   * also checks for the agency's CMS telephone number), and the agency graduates into the pipeline only when the site is confirmed
   * as its own. Everything after that (fit, qualification, drafting, approval, the send caps) is the existing pipeline's.
   */
  async function rosterRun(task,{signal,now=()=>new Date()}={}) {
    const roster=growth.roster, feed=roster?.feed;
    if(!feed?.configured||typeof growth.store.rosterSyncState!=='function')return {result:{skipped:'roster_not_configured'}};
    if(task.agent?.autonomy==='observe')return {result:{skipped:'observe_only'}};
    if(!markets(await marketedNow(marketed),'caremetric-intel'))return {result:{skipped:'not_marketed'}};
    const states=rosterStates(live(roster.states));
    if(!states.length)return {result:{skipped:'no_states'}};
    const started=clock(),spent=()=>clock()-started>=workBudgetMs;
    // 1. Read the roster when a read is due.
    const state=await growth.store.rosterSyncState();
    const sameStates=JSON.stringify([...(state?.states??[])].sort())===JSON.stringify([...states].sort());
    const fresh=state?.complete&&state.syncedAt&&Date.parse(state.syncedAt)>now().getTime()-rosterRefreshMs;
    const read={pages:0,rows:0};
    let stopped=null,period=state?.period??null;
    if(!(sameStates&&fresh)) {
      let restart=!sameStates||Boolean(state?.complete), cursor=restart?null:state?.cursor??null;
      for(let page=0;page<rosterPagesPerRun;page++) {
        signal?.throwIfAborted(); if(spent()){stopped='time';break;}
        if(page)await pause(feed.paceMs,signal);
        let answer;
        try {answer=await feed.roster({states,cursor,signal});}
        catch(error) {if(signal?.aborted||(!error?.transient&&!read.pages))throw error; stopped=error?.code??'feed_unavailable';break;}
        if(!answer.period){stopped='roster_not_loaded';break;}
        // CMS published a new quarter part-way through a read: start the read again on it.
        if(!restart&&period&&answer.period!==period&&cursor){restart=true;cursor=null;period=answer.period;continue;}
        period=answer.period;
        const rows=answer.items.filter(item=>item.state&&item.name).map(item=>rosterRow(item,answer.period,now()));
        if(rows.length)await growth.store.rosterUpsert(answer.period,rows);
        read.pages++;read.rows+=rows.length;
        await growth.store.rosterSyncSave({period:answer.period,states,cursor:answer.next_cursor??'',complete:!answer.next_cursor,pages:1,rows:rows.length,restart});
        restart=false;cursor=answer.next_cursor;
        if(!cursor)break;
      }
    }
    // 2. Look up the day's best agencies. Without a search provider nothing is claimed, so no agency waits a week for nothing.
    const looked={looked:0,graduated:0,unresolved:0,contacts:0};
    const daily=Number.isInteger(live(roster.daily))?live(roster.daily):25;
    if(growth.research?.configured&&growth.contacts?.configured&&daily>0&&!stopped) {
      for(let n=0;n<rosterLookupsPerRun;n++) {
        signal?.throwIfAborted(); if(spent())break;
        const [target]=await growth.store.rosterNext(1,daily);
        if(!target)break;
        looked.looked++;
        const outcome=await lookUp(target,{signal});
        if(outcome.graduated){looked.graduated++;if(outcome.contact)looked.contacts++;}else looked.unresolved++;
        if(outcome.retry)break;
        await pause(Number(growth.research.paceMs)||0,signal);
      }
    }
    return {result:{period,states:states.length,...(read.pages?{read}:{}),...(stopped?{stopped}:{}),...looked}};
  }
  /** One roster agency: find its own website, confirm it, and graduate it into the pipeline with its public record as evidence. */
  async function lookUp(target,{signal}) {
    let rows;
    try {rows=await growth.research.search('caremetric-intel',{query:resolutionQuery(target),count:10,signal});}
    catch(error) {if(signal?.aborted)throw error; await growth.store.rosterResolved(target.ccn,{outcome:'unresolved',reason:'retry'}); return {graduated:false,retry:true};}
    const choice=chooseSite(target,rows);
    if(!choice){await growth.store.rosterResolved(target.ccn,{outcome:'unresolved',reason:'no_site'});return {graduated:false};}
    let found;
    try {found=await growth.contacts.find(choice.domain,{signal,phone:target.facts?.phone??null});}
    catch(error) {if(signal?.aborted)throw error; await growth.store.rosterResolved(target.ccn,{outcome:'unresolved',reason:'retry'}); return {graduated:false};}
    const confirmation=confirmsSite(target,found,choice);
    if(!confirmation){await growth.store.rosterResolved(target.ccn,{outcome:'unresolved',reason:'not_confirmed'});return {graduated:false};}
    const site=found.site;
    const evidence=site?.claim&&/^https:\/\//.test(site.url??'')?[{url:String(site.url).slice(0,2000),claim:String(site.claim).slice(0,4000)}]:[];
    let resolved;
    try {resolved=await growth.store.rosterResolved(target.ccn,{outcome:'graduated',domain:choice.domain,confirmation,evidence});}
    catch(error) {if(error?.code!=='22023')throw error; await growth.store.rosterResolved(target.ccn,{outcome:'unresolved',reason:'invalid_site'}).catch(()=>{}); return {graduated:false};}
    if(!resolved?.graduated)return {graduated:false};
    let contact=false;
    if(resolved.contactReady) {
      // The address the finder read on the agency's own site becomes its one contact, exactly as for a business found by search.
      let recorded=null;
      try {recorded=await growth.store.recordContact(resolved.organizationId,found.email??null,found.email?found.sourceUrl:null);}
      catch(error) {if(error?.code!=='22023')throw error; recorded=await growth.store.recordContact(resolved.organizationId,null,null);}
      contact=Boolean(recorded?.found);
    }
    return {graduated:true,contact};
  }
  // The guardrail check that messages nobody approved need (growth.1, within 30 days). Synthetic cases only: no model, no customer data.
  async function evaluate(task,{now=()=>new Date()}={}) {
    const reports=await evaluateGrowth(now());
    for(const report of reports)await growth.store.evaluate(report.product,report.version,report.passed,report.results);
    const failed=reports.filter(report=>!report.passed).map(report=>report.product);
    if(failed.length&&notifier)await notifier.send({severity:'warning',subject:'Outreach guardrail check failed',
      body:`The daily outreach guardrail check failed for ${failed.join(' and ')}. Until it passes, no outreach email goes out on its own; emails you approve still go.`,
      dedupeKey:`growth:evaluate:${growthDay(now())}`,agentKey:task.agentKey,taskId:task.id});
    return {result:{evaluated:reports.length,passed:reports.filter(report=>report.passed).map(report=>report.product),failed}};
  }
  async function content(task,{signal,now=()=>new Date()}={}) {
    if(task.agent?.autonomy==='observe'||!growth.research?.configured)return {result:{skipped:'content_research_not_enabled'}};
    const week=weekStart(now()),context=await growth.store.contentContext(week);
    if(context.planned && task.sourceKind!=='owner')return {result:{skipped:'already_planned',contentWeek:week}};
    let proposals=0;
    const marketedList=await marketedNow(marketed);
    for(const policy of context.policies) {
      signal?.throwIfAborted(); if(!policy.approved_claim.trim()||!markets(marketedList,policy.product))continue;
      const sources=await growth.research.search(policy.product,{topic:policy.product==='carebase'?'staff training reporting questions':'provider referral development questions',signal});
      const brief=await contentBrief({product:policy.product,claim:policy.approved_claim,sources,task,model,signal});
      signal?.throwIfAborted(); if(!brief)continue;
      await growth.store.proposeContent(task.id,policy.product,{...brief,campaign:`growth:${policy.product}:${week}`});proposals++;
    }
    return {status:proposals?'awaiting_approval':'done',result:{contentWeek:week,proposals}};
  }
  return {'growth.pipeline':sweep,'growth.success':sweep,'growth.discovery':discover,'growth.content':content,...(autonomy?{'growth.evaluate':evaluate,'growth.roster':rosterRun}:{})};
}
/**
 * A growth message as it is sent, in the theme of the product's app (Intel's Emberline for Intel): a letter (it reads like an email a
 * person typed, so it is not filed as a promotion), opening with
 * "Hello,", the approved words, the sign-off (the founder's name and title on prospect outreach, the product team's on a customer
 * message) and the product's website, then the company, its postal address and the opt-out link.
 * The inbox preview is the message's first sentence. Only the product's own pages become links.
 */
const linkTrailing=/[.,;:!?)\]]+$/;
/**
 * The opt-out line and address a growth email carries. Neither contains the word "unsubscribe": most mail programs quote the
 * original message under a reply, and the database read that word anywhere in an inbound message as a request to stop. With the
 * old footer ("Unsubscribe from these emails: .../api/growth/unsubscribe/..."), a prospect who simply replied "Yes, tell me more"
 * was opted out and suppressed by their own quoted footer. The database now reads only the sender's own words, leaving quoted
 * lines and this footer line out (private.growth_reply_reading); the footer still avoids the words it reads as a request to stop,
 * in case a mail program quotes it in a way the reading does not recognise. The old address still works.
 */
export const growthOptOutLabel='Opt out of these emails';
export const growthOptOutPath='/api/growth/preferences/';
/** The addresses in a message that may be links: the product's own pages, as written or with well-formed campaign tags (links.mjs). */
export function messageLinks(product,words) {
  const pages=new Set(linkablePages(product).map(page=>page.url));
  const tagged=(String(words??'').match(/https:\/\/[^\s<>"]+/g)??[]).map(url=>url.replace(linkTrailing,'')).filter(url=>pages.has(untaggedUrl(url)));
  return [...pages,...new Set(tagged)];
}
/** The first name to greet a named contact by ("Jane" from "Jane Doe"), or null for a role address or a name that is not plainly one. */
export function greetingName(name,sourceKind) {
  if(!['enriched','imported','inbound','owner'].includes(sourceKind))return null;
  const first=String(name??'').trim().split(/\s+/)[0]??'';
  return /^[A-Za-z][A-Za-z'’-]{1,29}$/.test(first)?first[0].toUpperCase()+first.slice(1):null;
}
export function growthEmail({product,purpose=null,subject,body,postalAddress,unsubscribeUrl,greeting=null}) {
  const sender=senderFor(product,purpose);
  const words=String(body??'').trim();
  const preheader=(words.split(/\n/).find(line=>line.trim()&&!/^https:\/\//.test(line.trim()))??'').match(/^.*?[.?!](?=\s|$)/)?.[0]??'';
  const address=String(postalAddress??'').trim();
  // The company's name once: the postal address often begins with it.
  const footer=[...(/^caremetric\b/i.test(address)?[]:['CareMetric']),...(address?[address]:[]),{label:growthOptOutLabel,url:unsubscribeUrl}];
  return renderEmail({layout:'letter',theme:themeFor(product),title:subject,preheader:preheader.slice(0,150),
    blocks:[{type:'message',text:`Hello${greeting?` ${greeting}`:''},\n\n${words}`,links:messageLinks(product,words)}],
    signature:[...(sender.signer??[sender.team]),...(sender.site?[sender.site]:[])],footer});
}
export function growthExecutors({growth,mail,publicOrigin,postalAddress}) {
  if(!growth)return {};
  return {'growth.content':async()=>({recorded:true,published:false}),'growth.message':async execution=>{
    if(!growth.configured()||!mail?.configured)throw deferred();
    const claimed=await growth.store.claim(execution.input.messageId,execution.id);
    if(!claimed.send){
      if(['frequency_limited','daily_limit','evaluation_required','delivery_unresolved'].includes(claimed.status))throw deferred();
      if(finalRefusals.has(claimed.status))throw Object.assign(new Error('The message was not sent.'),{code:claimed.status});
      return {delivery:claimed.status};
    }
    // The work ID (with a colleague's own person, `unsubscribeKey`) is read from the claim, so the exact link is stable across retries.
    const token=growth.unsubscribeToken(claimed.unsubscribeKey??claimed.workId);
    if(claimed.unsubscribeHash && growth.hash(token)!==claimed.unsubscribeHash){await growth.store.finish(claimed.id,'failed',null);throw Object.assign(new Error('Regenerate the message after signing configuration changed'),{code:'unsubscribe_key_changed'});}
    const link=`${publicOrigin.replace(/\/+$/,'')}${growthOptOutPath}${token}`;
    const email=growthEmail({product:claimed.product,purpose:claimed.purpose,subject:claimed.subject,body:claimed.body,postalAddress:live(postalAddress),unsubscribeUrl:link,
      greeting:greetingName(claimed.contactName,claimed.sourceKind)});
    let outcome;
    try {outcome=await mail.send({to:claimed.to,subject:claimed.subject,text:email.text,html:email.html,unsubscribeUrl:link,messageId:claimed.id});}
    catch {outcome={delivery:'unknown',id:null};}
    const status=outcome.delivery==='sent'?'accepted':outcome.delivery==='failed'?'failed':'unknown';
    await growth.store.finish(claimed.id,status,outcome.id);
    if(status==='failed'||status==='unknown')throw Object.assign(new Error('Delivery needs review'),{code:status==='failed'?'delivery_failed':'delivery_unknown'});
    return {delivery:status};
  }};
}
