import { hasGrowthPriority } from './priority.mjs';
import { live } from '../live.mjs';
import { contentBrief } from './content.mjs';
import { weekStart } from '../agents/accounts/week.mjs';
import { assessProspect } from './assessment.mjs';
import { planOpportunity, products } from './policy.mjs';
import { marketedNow, markets } from '../agents/marketing.mjs';
import { draftMessage, outdatedWords } from './draft.mjs';
import { growthBriefFeature } from './brief.mjs';
import { growthReportViewsFeature } from './views.mjs';
import { growthLearningFeature } from './learning.mjs';
import { renderEmail, themeFor } from '../email-layout.mjs';
import { evaluateGrowth } from './evaluation.mjs';
import { enrichProspects } from './enrichment.mjs';
import { discoveryQueries, linkablePages, playbookFor, senderFor } from './playbook.mjs';
import { founder } from '../agents/content/facts.mjs';
import { campaignBlocks, campaignEyebrow, campaignProduct, readCampaign } from './campaign.mjs';
import { searchResultLimit } from './research.mjs';
import { untaggedUrl } from '../agents/links.mjs';
import { chooseSite, confirmsSite, phoneCandidates, phoneQuery, rankTarget, resolutionQuery, rosterLookupsPerRun, rosterPagesPerRun, rosterRefreshMs, rosterRow, rosterStates } from './roster.mjs';
// Why it waits goes with it: the send claim's status ('daily_limit', 'outside_hours', ...), read by private.growth_defer_action.
const deferred=(reason=null)=>Object.assign(new Error('Action is deferred'),{code:'action_deferred',...(reason?{reason}:{})});
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
/** Addresses checked before the first email, and the bounce guard (20261116100000_growth_address_check.sql; verify.mjs). */
export const growthAddressCheckFeature='platform.agents.growth-address-check.v1';
/** Why an address check got no answer, and the reader's review of each first email (20261117160000_growth_diagnostics.sql). */
export const growthDiagnosticsFeature='platform.agents.growth-diagnostics.v1';
// Colleague emails recorded and proposed on one sweep at most: a few touches' worth, so a sweep never spends its time on them.
export const colleagueLimit=20;
/** Prospects who went quiet after a reply, read once a sweep (private.growth_quiet_candidates). */
export const quietLimit=10;
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
// How long a first email to an Intel agency waits for its account brief, from its last assessment, while briefs are on.
export const briefWaitMs=24*3_600_000;
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
  // Team review 2026-11-17, stage 5 (platform.agents.support-truth.v1): a self-service trial nobody may write to is covered by the
  // Account Manager's customer emails, so its onboarding, activation and trial work is not planned to pile up open.
  const supportTruth=features instanceof Set?features.has('platform.agents.support-truth.v1'):Array.isArray(features)&&features.includes('platform.agents.support-truth.v1');
  const colleagues=(features instanceof Set?features.has(growthColleaguesFeature):Array.isArray(features)&&features.includes(growthColleaguesFeature))
    &&typeof growth.store.colleagueCandidates==='function';
  // The owner-approved learning memo (learning.mjs), while Settings → Customer growth → "Write from what is working" is on.
  const learning=(features instanceof Set?features.has(growthLearningFeature):Array.isArray(features)&&features.includes(growthLearningFeature))
    &&typeof growth.store.learningActive==='function';
  // An account brief for each Intel agency's first email (brief.mjs; Settings → Customer growth).
  const briefing=(features instanceof Set?features.has(growthBriefFeature):Array.isArray(features)&&features.includes(growthBriefFeature))
    &&typeof growth.store.briefWriter==='function';
  // A second email that follows whether the agency opened its report (views.mjs; Settings → Customer growth).
  const viewing=features instanceof Set?features.has(growthReportViewsFeature):Array.isArray(features)&&features.includes(growthReportViewsFeature);
  // First emails wait for their address's check, and cold email for a tripped bounce guard (Settings → Customer growth).
  const holding=(features instanceof Set?features.has(growthAddressCheckFeature):Array.isArray(features)&&features.includes(growthAddressCheckFeature))
    &&typeof growth.store.draftHold==='function';
  // Stage 2 of the 2026-11-17 review (priority.mjs; Settings → Customer growth): each first email keeps its priority band, and a
  // prospect who replied and went quiet gets at most two follow-ups while "Follow up when a prospect who replied goes quiet" is on.
  // (Its "Test a short first email" is retired: every first email built around a market report is that form now, draft.mjs.)
  const prioritized=hasGrowthPriority(features);
  const quieting=prioritized&&typeof growth.store.quietCandidates==='function';
  // The reader's review of each first email is recorded beside it, to judge the rewrite by.
  const diagnosing=(features instanceof Set?features.has(growthDiagnosticsFeature):Array.isArray(features)&&features.includes(growthDiagnosticsFeature))
    &&typeof growth.store.reviewRecord==='function';
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
    const owner=task.kind==='growth.success'?'account_manager':'marketing_manager'; let inspected=0,planned=0,drafted=0,offset=0,total=1,assessed=0,undrafted=0,reengaged=0,unreviewed=0;
    // Why drafts were not kept, by check (draft.mjs codes), so the run shows which rule throws good openings away.
    const rejected={};
    // First emails not drafted yet because they wait (an address not yet checked, the bounce guard, a brief), by reason.
    const held={};
    // First emails written on the quality tier this sweep: one at most, started early, so the sweep ends inside the scheduler's limit.
    let topDrafts=0;
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
    // The opportunities this sweep read, for the quiet follow-ups after the pipeline.
    const read=new Map();
    // Researched prospects that meet the qualification rules move to qualified before the pipeline is read (nothing is sent here).
    if(prospecting&&reengaging&&typeof growth.store.reengage==='function')reengaged=(await growth.store.reengage(50))?.reengaged??0;
    if(prospecting)await growth.store.autoQualify(qualifyLimit);
    while(offset<total) {
      signal?.throwIfAborted(); const page=await growth.store.snapshot(offset);total=page.total;offset+=page.items.length;if(!page.items.length)break;
      for(const o of page.items) {
        signal?.throwIfAborted(); if(o.owner_agent!==owner)continue; inspected++; read.set(o.id,o);
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
          if(supportTruth&&!existing&&o.owner_agent==='account_manager'&&o.eligibility!=='permitted'&&['onboarding','activation','trial'].includes(work.kind))continue;
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
          // A first email waits for its address's check, and cold email for a tripped bounce guard (verify.mjs): no model call is paid
          // for an email that could not be sent.
          if(holding&&work.kind==='outreach'&&o.contact_id) {
            const hold=await growth.store.draftHold(o.contact_id);
            if(hold){held[hold]=(held[hold]??0)+1;continue;}
          }
          // The agency's account brief, for its first cold email: while briefs are on, that email waits up to a day for one.
          let brief=null,quality=false;
          const critic=briefing&&live(growth.briefs?.critic)===true;
          if(briefing&&work.kind==='outreach'&&o.product==='caremetric-intel'&&Number(o.touches??0)===0&&!o.memory?.reengagedAt&&!o.memory?.lead) {
            brief=await growth.store.briefWriter(o.id);
            if(!brief&&live(growth.briefs?.enabled)===true&&now().getTime()-Date.parse(o.assessed_at??0)<briefWaitMs){held.brief_pending=(held.brief_pending??0)+1;continue;}
            quality=Boolean(brief)&&live(growth.briefs?.qualityWriter)===true;
            if(quality&&(topDrafts>=1||clock()-started>45_000)){held.top_model_later=(held.top_model_later??0)+1;continue;}
          }
          const memo=work.kind==='outreach'?await memoFor(o.product):null;
          // The agency's own report, only once Intel has opened it (report-link.mjs checkedLinkFor); otherwise the review page.
          const report=work.kind==='outreach'&&growth.reports?(growth.reports.checkedLinkFor?await growth.reports.checkedLinkFor(o,{signal}):growth.reports.linkFor?.(o))??null:null;
          if(quality)topDrafts++;
          const views=viewing&&live(growth.views?.enabled)===true;
          const draft=await oneAnswer(()=>draftMessage({opportunity:o,work,task,model,signal,memo,report,brief,quality,critic,views,onReject:code=>{rejected[code]=(rejected[code]??0)+1;}}),signal);
          if(!draft){if(model?.configured){unanswered.set(wanted,clock());undrafted++;}continue;}
          signal?.throwIfAborted();
          const {review,...message}=draft;
          let saved;
          try {
            // The email's priority band (1 to 4, private.growth_priority_band) is kept with its arms, so the memo can compare bands.
            const arms={...(message.arms??{}),...(prioritized&&work.kind==='outreach'&&[1,2,3,4].includes(Number(o.priority_band))?{band:String(o.priority_band)}:{})};
            saved=await growth.store.draft(o.id,id,{...message,version:o.version,contactVersion:o.contact_version,policyVersion:o.policy.version,purpose:work.kind==='outreach'?'marketing':'success',unsubscribeHash:growth.hash(growth.unsubscribeToken(id)),variant:draft.variant??'control',arms});
          } catch (error) {
            // An owner edit during drafting invalidates this output. The next sweep reads fresh context.
            if(error?.code==='40001')continue;
            throw error;
          }
          if(saved.status==='draft')await growth.store.propose(task.id,saved.id);drafted++;
          // A review that cannot be recorded never holds the email: it is counted, and the email goes on as proposed.
          if(review&&diagnosing&&saved?.id) {
            try {await growth.store.reviewRecord(saved.id,review);}
            catch(error) {if(signal?.aborted)throw error; unreviewed++;}
          }
        }
      }
    }
    // A prospect who replied with interest or a question, was answered and has gone quiet: at most two short follow-ups (Settings →
    // Customer growth → Follow up when a prospect who replied goes quiet; private.growth_quiet_candidates), drafted, checked, claimed and
    // opted out of like every growth email. A customer email (purpose 'success'), so it is the Sales follow-ups step's to hand over.
    let quietFollowups=0;
    if(quieting&&prospecting&&growth.signingReady&&live(growth.priority?.quietFollowup)===true&&!spent()) {
      for(const item of await growth.store.quietCandidates(quietLimit)) {
        signal?.throwIfAborted(); if(spent())break;
        const o=read.get(item.opportunityId);
        if(!o||!markets(marketedList,o.product)||o.eligibility!=='permitted'||![1,2].includes(Number(item.step)))continue;
        const asked=`quiet:${o.id}:${item.key}:${o.version??''}:${o.contact_version??''}:${o.policy?.version??''}`;
        if(clock()-(unanswered.get(asked)??-Infinity)<assessRetryMs)continue;
        const plan={key:String(item.key),kind:'reply',owner:'marketing_manager',dueAt:now().toISOString(),success:'The prospect answers, asks for the next step or declines.',
          action:Number(item.step)===1?'Follow up once on our answer to the prospect\'s reply.':'Send a last short note after the follow-up went unanswered.'};
        const id=await growth.store.plan(o.id,plan);planned++;
        const draft=await oneAnswer(()=>draftMessage({opportunity:o,work:{...plan,quiet:{step:Number(item.step)}},task,model,signal,onReject:code=>{rejected[code]=(rejected[code]??0)+1;}}),signal);
        if(!draft){if(model?.configured)unanswered.set(asked,clock());continue;}
        signal?.throwIfAborted();
        let saved;
        try {
          saved=await growth.store.draft(o.id,id,{...draft,version:o.version,contactVersion:o.contact_version,policyVersion:o.policy.version,purpose:'success',
            unsubscribeHash:growth.hash(growth.unsubscribeToken(id)),variant:draft.variant??'control',arms:{...(draft.arms??{}),quiet:String(item.step)}});
        } catch (error) {
          if(error?.code==='40001')continue;
          throw error;
        }
        if(saved?.status==='draft'){await growth.store.propose(task.id,saved.id);quietFollowups++;}
      }
    }
    // The touches sent since the last sweep go to the organization's other decision-makers too.
    let colleagueEmails=0;
    if(prospecting&&colleagues&&growth.signingReady&&!spent())colleagueEmails=(await prepareColleagues(task,marketedList,{signal})).proposed;
    // A few more discovered businesses' websites are read on every sweep, so a day's discoveries all get a contact search and a home
    // page summary the same day. No search provider is called here: only the business's own site is read.
    let contacts=null;
    if(prospecting&&growth.contacts?.configured&&typeof growth.store.contactCandidates==='function'&&!spent())contacts=await findContacts(sweepContactLimit,productsByDomain,{signal,spent});
    // Told once a day, and only when an email was written: re-saving the open work items on every sweep is not news (email review
    // 2026-11-17: this notice came eleven times in a week, at midnight, with "312 follow-up tasks reviewed; 0 message drafts prepared").
    const written=drafted+quietFollowups+colleagueEmails;
    const count=(n,one,many)=>`${n} ${n===1?one:many}`;
    if(written && notifier)await notifier.send({severity:'info',subject:owner==='account_manager'?'Customer emails are ready on Growth':'Prospect emails are ready on Growth',
      body:`${count(drafted+quietFollowups,'email','emails')} written${colleagueEmails?`, and ${count(colleagueEmails,'copy','copies')} for other people at the same organizations`:''}. Open Growth to approve ${written===1?'it':'them'}, unless you handed that kind of email over on the AI team page.`,
      dedupeKey:`growth:${owner}:${growthDay(now())}`,agentKey:owner,taskId:task.id});
    return {result:{inspected,planned,drafted,...(undrafted?{undrafted}:{}),...(Object.keys(rejected).length?{rejected}:{}),...(Object.keys(held).length?{held}:{}),...(reengaged?{reengaged}:{}),...(unreviewed?{unreviewed}:{}),...(colleagueEmails?{colleagues:colleagueEmails}:{}),...(quietFollowups?{quietFollowups}:{}),...(contacts?.searched?{contacts}:{})}};
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
    const read={pages:0,rows:0,facts:0};
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
        const items=answer.items.filter(item=>item.state&&item.name);
        // Each open agency's HHVBP payment adjustment and Hospice Care Index, for the rank only (stage 3, under pressure first).
        const pressure=await agencyPressure(items,{signal,spent,read,now});
        const rows=items.map(item=>rosterRow(item,answer.period,now(),pressure.get(item.ccn)??null));
        if(rows.length)await growth.store.rosterUpsert(answer.period,rows);
        read.pages++;read.rows+=rows.length;
        await growth.store.rosterSyncSave({period:answer.period,states,cursor:answer.next_cursor??'',complete:!answer.next_cursor,pages:1,rows:rows.length,restart});
        restart=false;cursor=answer.next_cursor;
        if(!cursor)break;
      }
    }
    // 2. Look up the day's best agencies. Without a search provider nothing is claimed, so no agency waits a week for nothing.
    const looked={looked:0,graduated:0,unresolved:0,contacts:0,byPhone:0};
    const daily=Number.isInteger(live(roster.daily))?live(roster.daily):25;
    if(growth.research?.configured&&growth.contacts?.configured&&daily>0&&!stopped) {
      for(let n=0;n<rosterLookupsPerRun;n++) {
        signal?.throwIfAborted(); if(spent())break;
        const [target]=await growth.store.rosterNext(1,daily);
        if(!target)break;
        looked.looked++;
        const outcome=await lookUp(target,{signal});
        if(outcome.graduated){looked.graduated++;if(outcome.contact)looked.contacts++;if(outcome.byPhone)looked.byPhone++;}else looked.unresolved++;
        if(outcome.retry)break;
        await pause(Number(growth.research.paceMs)||0,signal);
      }
    }
    const {byPhone,...counts}=looked;
    const {facts:factCalls,factsStopped,...pagesRead}=read;
    return {result:{period,states:states.length,...(read.pages?{read:{...pagesRead,...(factCalls?{facts:factCalls}:{}),...(factsStopped?{factsStopped}:{})}}:{}),...(stopped?{stopped}:{}),...counts,...(byPhone?{byPhone}:{})}};
  }
  /**
   * The open agencies of one roster page with their `agency_facts` entry (HHVBP payment adjustment, Hospice Care Index), read 25 at a
   * time at the feed's pace while the run has time. They only rank (roster.mjs pressureWeights); a feed that refuses or fails leaves the
   * rest of the page ranked without them, and the next weekly read tries again.
   */
  async function agencyPressure(items,{signal,spent,read,now}) {
    const found=new Map(), feed=growth.roster?.feed;
    if(typeof feed?.agencyFacts!=='function')return found;
    const ccns=items.filter(item=>!rankTarget(item,now()).excluded).map(item=>item.ccn);
    for(let at=0;at<ccns.length&&!read.factsStopped;at+=25) {
      signal?.throwIfAborted(); if(spent()){read.factsStopped='time';break;}
      await pause(feed.paceMs,signal);
      try {
        const answer=await feed.agencyFacts({ccns:ccns.slice(at,at+25),signal});
        read.facts++;
        for(const agency of answer?.agencies??[])found.set(agency.ccn,agency);
      } catch(error) {
        if(signal?.aborted)throw error;
        read.factsStopped=error?.code??'feed_unavailable';
      }
    }
    return found;
  }
  /**
   * One roster agency: find its own website, confirm it, and graduate it into the pipeline with its public record as evidence. The search
   * by its name and place comes first; when it finds no site that confirms, one search by its CMS telephone number, whose results are
   * accepted only when the site itself shows that number (2026-11-16: the name search left 35 of the first 44 agencies unresolved).
   */
  async function lookUp(target,{signal}) {
    let rows;
    try {rows=await growth.research.search('caremetric-intel',{query:resolutionQuery(target),count:10,signal});}
    catch(error) {if(signal?.aborted)throw error; await growth.store.rosterResolved(target.ccn,{outcome:'unresolved',reason:'retry'}); return {graduated:false,retry:true};}
    let choice=chooseSite(target,rows),found=null,confirmation=null,byPhone=false;
    const reason=choice?'not_confirmed':'no_site', tried=new Set();
    if(choice) {
      tried.add(choice.domain);
      try {found=await growth.contacts.find(choice.domain,{signal,phone:target.facts?.phone??null});}
      catch(error) {if(signal?.aborted)throw error; await growth.store.rosterResolved(target.ccn,{outcome:'unresolved',reason:'retry'}); return {graduated:false};}
      confirmation=confirmsSite(target,found,choice);
    }
    const phone=phoneQuery(target);
    if(!confirmation&&phone) {
      let phoneRows=[];
      try {await pause(Number(growth.research.paceMs)||0,signal); phoneRows=await growth.research.search('caremetric-intel',{query:phone,count:10,signal});}
      catch(error) {if(signal?.aborted)throw error;}
      for(const candidate of phoneCandidates(target,phoneRows,tried)) {
        let read;
        try {read=await growth.contacts.find(candidate.domain,{signal,phone:target.facts.phone});} catch(error) {if(signal?.aborted)throw error; continue;}
        if(read?.phoneSeen===true){choice=candidate;found=read;confirmation='phone';byPhone=true;break;}
      }
    }
    if(!confirmation){await growth.store.rosterResolved(target.ccn,{outcome:'unresolved',reason});return {graduated:false,phoneSearched:Boolean(phone)};}
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
    return {graduated:true,contact,byPhone};
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
/** Product pages (including campaign tags), plus authentic Intel report tokens already isolated by the draft's exact-link check. */
export function messageLinks(product,words,reports=null) {
  const pages=new Set(linkablePages(product).map(page=>page.url));
  const tagged=(String(words??'').match(/https:\/\/[^\s<>"]+/g)??[]).map(url=>url.replace(linkTrailing,'')).filter(url=>pages.has(untaggedUrl(url))||(product==='caremetric-intel'&&reports?.accepts?.(url)===true));
  return [...pages,...new Set(tagged)];
}
/**
 * What a link on a line of its own is called in the HTML part, by its address as written (email review 2026-11-17: a report link was
 * shown as its whole address, some 300 characters of token and campaign tags, which reads as unsafe to click). The agency's own report,
 * the product's next step (its free trial), the page where an agency gets its report, then any other product page by its own label.
 * The plain-text part keeps the address.
 */
export function linkLabels(product,words,reports=null) {
  const pages=new Map(linkablePages(product).map(page=>[page.url,page.label]));
  const next=playbookFor(product)?.nextStep??null;
  const labels={};
  for(const line of String(words??'').split('\n')) {
    const url=line.trim();
    if(!/^https:\/\/[^\s<>"]+$/.test(url))continue;
    // A link written without campaign tags is its own page.
    const page=untaggedUrl(url)??url;
    if(product==='caremetric-intel'&&reports?.accepts?.(url)===true)labels[url]='Open your agency\'s market report (PDF)';
    else if(next?.url===page)labels[url]=next.label;
    else if(pages.has(page))labels[url]=/\/market-review\/?$/.test(page)?'Get your agency\'s free market report':pages.get(page);
  }
  return labels;
}
// A full stop after one of these does not end a sentence: an agency's own name often carries one ("St. Luke's Home Health, Inc.").
const abbreviated=/(?:\b(?:St|Ste|Dr|Mr|Mrs|Ms|Mt|Ft|Inc|Co|Corp|Ltd|Jr|Sr|No|vs)|\b[A-Z])\.$/;
/** The first sentence of a line, for the inbox preview: up to the first full stop, question mark or exclamation mark that ends one. */
export function firstSentence(line) {
  const text=String(line??'');
  for(const match of text.matchAll(/[.?!](?=\s|$)/g)) {
    const sentence=text.slice(0,match.index+1);
    if(match[0]==='.'&&abbreviated.test(sentence))continue;
    return sentence;
  }
  return '';
}
/** The first name to greet a named contact by ("Jane" from "Jane Doe"), or null for a role address or a name that is not plainly one. */
export function greetingName(name,sourceKind) {
  if(!['enriched','imported','inbound','owner'].includes(sourceKind))return null;
  const first=String(name??'').trim().split(/\s+/)[0]??'';
  return /^[A-Za-z][A-Za-z'’-]{1,29}$/.test(first)?first[0].toUpperCase()+first.slice(1):null;
}
export function growthEmail({product,purpose=null,quiet=false,subject,body,postalAddress,unsubscribeUrl,greeting=null,reports=null}) {
  // A quiet follow-up goes to a prospect, from the founder's sending address like the rest of their emails, so it is the founder's letter
  // too, though it is drafted as a 'success' email for the Sales follow-ups hand-over (email review 2026-11-17).
  const sender=senderFor(product,quiet?'marketing':purpose);
  const words=String(body??'').trim();
  const preheader=firstSentence(words.split(/\n/).find(line=>line.trim()&&!/^https:\/\//.test(line.trim()))??'');
  const address=String(postalAddress??'').trim();
  // The company's name once: the postal address often begins with it.
  const footer=[...(/^caremetric\b/i.test(address)?[]:['CareMetric']),...(address?[address]:[]),{label:growthOptOutLabel,url:unsubscribeUrl}];
  const signature=[...(sender.signer??[sender.team]),...(sender.site?[sender.site]:[])];
  const letter=renderEmail({layout:'letter',theme:themeFor(product),title:subject,preheader:preheader.slice(0,150),
    blocks:[{type:'message',text:`Hello${greeting?` ${greeting}`:''},\n\n${words}`,links:messageLinks(product,words,reports),labels:linkLabels(product,words,reports)}],
    signature,footer});
  // A marketing email to a CareMetric Intel agency (campaign.mjs; email review 2026-11-17: the plain letter read as something to throw
  // away). Its words are the writer's opening and the sections code added when it was drafted; here they are laid out in Intel's own
  // look: the subject as the headline, the opening, the report's card and button, what the software does, the founder's words, the
  // offer and the trial. The plain-text part is the letter, word for word as approved. Any other email, and one whose sections were
  // edited, stays a letter.
  const campaign=product===campaignProduct&&purpose==='marketing'?readCampaign(words,{reports}):null;
  if(!campaign)return letter;
  const designed=renderEmail({layout:'branded',theme:themeFor(product),title:subject,preheader:preheader.slice(0,150),
    eyebrow:campaignEyebrow(campaign.touch),heading:subject,greeting:`Hello${greeting?` ${greeting}`:''},`,
    blocks:campaignBlocks(campaign,{links:messageLinks(product,campaign.opening,reports)}).filter(Boolean),
    // The first email carries the founder's words as a signed quote, so it needs no second sign-off under its closing panel.
    signature:campaign.touch===1?[]:signature,footer});
  return {html:designed.html,text:letter.text};
}
export function growthExecutors({growth,mail,publicOrigin,postalAddress,features=null}) {
  if(!growth)return {};
  const holding=(features instanceof Set?features.has(growthAddressCheckFeature):Array.isArray(features)&&features.includes(growthAddressCheckFeature))
    &&typeof growth.store.sendHold==='function';
  return {'growth.content':async()=>({recorded:true,published:false}),'growth.message':async execution=>{
    if(!growth.configured()||!mail?.configured)throw deferred();
    // A cold email waits (tried again in 15 minutes) while the bounce guard holds cold email, and a first email until its address was
    // checked. The send claim below still decides everything else.
    if(holding&&await growth.store.sendHold(execution.input.messageId))throw deferred();
    const claimed=await growth.store.claim(execution.input.messageId,execution.id);
    if(!claimed.send){
      // Over the cap, outside the send hours (20261117190000_growth_priority.sql) or waiting on another email: tried again later.
      if(['frequency_limited','daily_limit','evaluation_required','delivery_unresolved','outside_hours'].includes(claimed.status))throw deferred(claimed.status);
      if(finalRefusals.has(claimed.status))throw Object.assign(new Error('The message was not sent.'),{code:claimed.status});
      return {delivery:claimed.status};
    }
    // An email can wait days for its turn under the caps and send hours. Words a rule added since it was written no longer allows (an
    // Intel trial with "no credit card", as if we saw a report opened, Intel's "the book") never go out: the email is withdrawn, and the
    // next sweep writes that work again under today's rules (20261117220000_email_review.sql). A database without the withdrawal marks it
    // failed instead, for the owner to see.
    const outdated=outdatedWords({product:claimed.product,subject:claimed.subject,body:claimed.body,purpose:claimed.purpose});
    if(outdated) {
      let withdrawn=false;
      try {withdrawn=typeof growth.store.withdraw==='function'&&await growth.store.withdraw(claimed.id,outdated)===true;}
      catch(error) {if(error?.code!=='42883')throw error;}
      if(withdrawn)return {delivery:'withdrawn',reason:outdated};
      await growth.store.finish(claimed.id,'failed',null);
      throw Object.assign(new Error('The message was not sent.'),{code:'outdated_words'});
    }
    // The work ID (with a colleague's own person, `unsubscribeKey`) is read from the claim, so the exact link is stable across retries.
    const token=growth.unsubscribeToken(claimed.unsubscribeKey??claimed.workId);
    if(claimed.unsubscribeHash && growth.hash(token)!==claimed.unsubscribeHash){await growth.store.finish(claimed.id,'failed',null);throw Object.assign(new Error('Regenerate the message after signing configuration changed'),{code:'unsubscribe_key_changed'});}
    const link=`${publicOrigin.replace(/\/+$/,'')}${growthOptOutPath}${token}`;
    const email=growthEmail({product:claimed.product,purpose:claimed.purpose,quiet:claimed.quiet===true,subject:claimed.subject,body:claimed.body,postalAddress:live(postalAddress),unsubscribeUrl:link,
      reports:growth.reports,greeting:greetingName(claimed.contactName,claimed.sourceKind)});
    let outcome;
    // A founder-signed email (the same rule as its signature, growthEmail) arrives from the founder's name, unless a display name is
    // set in Settings → Email, which the sender then keeps (owner decision 2026-11-17).
    const founderSigned=claimed.purpose==='marketing'||claimed.quiet===true;
    try {outcome=await mail.send({to:claimed.to,subject:claimed.subject,text:email.text,html:email.html,unsubscribeUrl:link,messageId:claimed.id,...(founderSigned?{fromName:founder.fromName}:{})});}
    catch {outcome={delivery:'unknown',id:null};}
    const status=outcome.delivery==='sent'?'accepted':outcome.delivery==='failed'?'failed':'unknown';
    await growth.store.finish(claimed.id,status,outcome.id);
    if(status==='failed'||status==='unknown')throw Object.assign(new Error('Delivery needs review'),{code:status==='failed'?'delivery_failed':'delivery_unknown'});
    return {delivery:status};
  }};
}
