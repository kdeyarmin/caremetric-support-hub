import { contentBrief } from './content.mjs';
import { weekStart } from '../agents/accounts/week.mjs';
import { assessProspect } from './assessment.mjs';
import { planOpportunity, products } from './policy.mjs';
import { marketedNow, markets } from '../agents/marketing.mjs';
import { draftMessage } from './draft.mjs';
import { renderEmail, themeFor } from '../email-layout.mjs';
import { evaluateGrowth } from './evaluation.mjs';
import { discoveryQuery, linkablePages, senderFor } from './playbook.mjs';
import { addressesIn, linkAllowed, productCode, taggedUrl, tagsOf } from '../agents/links.mjs';
const deferred=()=>Object.assign(new Error('Action is deferred'),{code:'action_deferred'});
const easternDay=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'});
/** The calendar day in America/New_York, matching every other send cap and notice. */
export const growthDay=instant=>easternDay.format(instant);
/** Sales follow-ups and capped cold email (20261105150000_growth_autonomy.sql): the contact finder, qualification and the daily evaluation. */
export const growthAutonomyFeature='platform.agents.growth-autonomy.v1';
// Businesses the contact finder reads per discovery run, and opportunities qualified per pass.
export const contactSearchLimit=10;
export const qualifyLimit=100;
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
export function growthHandlers({growth,model,notifier,features=null,marketed=null}) {
  if(!growth)return {};
  const autonomy=declared(features);
  async function sweep(task,{signal,now=()=>new Date()}={}) {
    await growth.store.maintenance?.();
    const owner=task.kind==='growth.success'?'account_manager':'marketing_manager'; let inspected=0,planned=0,drafted=0,offset=0,total=1;
    const marketedList=owner==='marketing_manager'?await marketedNow(marketed):null;
    // Researched prospects that meet the qualification rules move to qualified before the pipeline is read (nothing is sent here).
    if(autonomy&&owner==='marketing_manager'&&task.agent?.autonomy!=='observe')await growth.store.autoQualify(qualifyLimit);
    while(offset<total) {
      signal?.throwIfAborted(); const page=await growth.store.snapshot(offset);total=page.total;offset+=page.items.length;if(!page.items.length)break;
      for(const o of page.items) {
        signal?.throwIfAborted(); if(o.owner_agent!==owner)continue; inspected++;
        if(owner==='marketing_manager' && !markets(marketedList,o.product))continue;
        const plans=planOpportunity(o,now());
        if(task.agent?.autonomy==='observe')continue;
        if(owner==='marketing_manager' && ['identified','researched'].includes(o.stage) && (!o.assessed_at || (o.evidence??[]).some(e=>Date.parse(e.observed_at)>Date.parse(o.assessed_at)))) {
          const assessment=await oneAnswer(()=>assessProspect(o,task,model,signal),signal);
          signal?.throwIfAborted();
          if(assessment) {await growth.store.assess(o.id,assessment);continue;}
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
          const draft=await oneAnswer(()=>draftMessage({opportunity:o,work,task,model,signal}),signal);if(!draft)continue;
          signal?.throwIfAborted();
          let saved;
          try {
            saved=await growth.store.draft(o.id,id,{...draft,version:o.version,contactVersion:o.contact_version,policyVersion:o.policy.version,purpose:work.kind==='outreach'?'marketing':'success',unsubscribeHash:growth.hash(growth.unsubscribeToken(id)),variant:draft.variant??'control'});
          } catch (error) {
            // An owner edit during drafting invalidates this output. The next sweep reads fresh context.
            if(error?.code==='40001')continue;
            throw error;
          }
          if(saved.status==='draft')await growth.store.propose(task.id,saved.id);drafted++;
        }
      }
    }
    if(planned && notifier)await notifier.send({severity:'info',subject:'Customer growth work is ready',body:`${planned} follow-up tasks reviewed; ${drafted} message drafts prepared. Open Growth to review next actions.`,dedupeKey:`growth:${owner}:${growthDay(now())}`,agentKey:owner,taskId:task.id});
    return {result:{inspected,planned,drafted}};
  }
  async function discover(task,{signal,now=()=>new Date()}={}) {
    if(!growth.research?.configured)return {result:{skipped:'research_not_configured'}};
    if(task.agent?.autonomy==='observe')return {result:{skipped:'observe_only'}};
    let candidates=0;
    const marketedList=await marketedNow(marketed);
    const searched=products.filter(product=>markets(marketedList,product));
    if(!searched.length)return {result:{skipped:'no_marketed_product'}};
    // A different segment-and-place search each day (playbook.mjs), so discovery keeps finding new organizations; CareBase stays in Pennsylvania.
    for(const product of searched){signal?.throwIfAborted(); const rows=await growth.research.search(product,{query:discoveryQuery(product,now()),signal});signal?.throwIfAborted();candidates+=await growth.store.discover(product,rows);}
    if(!autonomy||!growth.contacts?.configured)return {result:{candidates}};
    // The contact finder reads each new business's own website for one public role address; a business with none stays without a
    // contact (and is not read again for 90 days). Only the counts are kept here: never an address.
    const contacts={searched:0,found:0,none:0};
    for(const target of await growth.store.contactCandidates(contactSearchLimit)) {
      signal?.throwIfAborted(); contacts.searched++;
      let found={email:null};
      try {found=await growth.contacts.find(target.domain,{signal});} catch(error) {if(signal?.aborted)throw error;}
      signal?.throwIfAborted();
      let recorded=null;
      try {recorded=await growth.store.recordContact(target.id,found.email??null,found.email?found.sourceUrl:null);}
      catch(error) {if(error?.code!=='22023')throw error; recorded=await growth.store.recordContact(target.id,null,null);}
      if(recorded?.found)contacts.found++; else contacts.none++;
    }
    const qualified=(await growth.store.autoQualify(qualifyLimit))?.qualified??0;
    return {result:{candidates,contacts,qualified}};
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
      const brief=await contentBrief({product:policy.product,claim:policy.approved_claim,bookingUrl:policy.booking_url,sources,task,model,signal});
      signal?.throwIfAborted(); if(!brief)continue;
      await growth.store.proposeContent(task.id,policy.product,{...brief,campaign:`growth:${policy.product}:${week}`});proposals++;
    }
    return {status:proposals?'awaiting_approval':'done',result:{contentWeek:week,proposals}};
  }
  return {'growth.pipeline':sweep,'growth.success':sweep,'growth.discovery':discover,'growth.content':content,...(autonomy?{'growth.evaluate':evaluate}:{})};
}
/**
 * A growth message as it is sent, in the theme of the product's app (Intel's Emberline for Intel): a letter (it reads like an email a
 * person typed, so it is not filed as a promotion), opening with
 * "Hello,", the approved words, the product team's sign-off and website, then the company, its postal address and the unsubscribe link.
 * The inbox preview is the message's first sentence. Only the product's own pages become links, with the campaign tags the draft
 * gave them (../agents/links.mjs). The website under the sign-off carries the message's own tags, or, for a message without a tagged
 * link, growth-<product> (outreach) or success-<product> (a customer email) by its `purpose`.
 */
export function growthEmail({product,subject,body,postalAddress,unsubscribeUrl,purpose=null}) {
  const sender=senderFor(product);
  const words=String(body??'').trim();
  const pages=linkablePages(product).map(page=>page.url);
  const found=addressesIn(words).filter(url=>linkAllowed(url,pages));
  const tags=found.map(tagsOf).find(Boolean)
    ??(['marketing','success'].includes(purpose)?{source:'caremetric',medium:'email',campaign:`${purpose==='marketing'?'growth':'success'}-${productCode(product)}`}:null);
  const site=sender.site?{...sender.site,url:tags?taggedUrl(sender.site.url,tags):sender.site.url}:null;
  const preheader=(words.split(/\n/).find(line=>line.trim()&&!/^https:\/\//.test(line.trim()))??'').match(/^.*?[.?!](?=\s|$)/)?.[0]??'';
  const address=String(postalAddress??'').trim();
  // The company's name once: the postal address often begins with it.
  const footer=[...(/^caremetric\b/i.test(address)?[]:['CareMetric']),...(address?[address]:[]),{label:'Unsubscribe from these emails',url:unsubscribeUrl}];
  return renderEmail({layout:'letter',theme:themeFor(product),title:subject,preheader:preheader.slice(0,150),
    blocks:[{type:'message',text:`Hello,\n\n${words}`,links:[...pages,...found]}],
    signature:[sender.team,...(site?[site]:[])],footer});
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
    // The work ID is read from the claim, so the exact link is stable across retries.
    const token=growth.unsubscribeToken(claimed.workId);
    if(claimed.unsubscribeHash && growth.hash(token)!==claimed.unsubscribeHash){await growth.store.finish(claimed.id,'failed',null);throw Object.assign(new Error('Regenerate the message after signing configuration changed'),{code:'unsubscribe_key_changed'});}
    const link=`${publicOrigin.replace(/\/+$/,'')}/api/growth/unsubscribe/${token}`;
    const email=growthEmail({product:claimed.product,subject:claimed.subject,body:claimed.body,postalAddress,unsubscribeUrl:link,purpose:claimed.purpose});
    let outcome;
    try {outcome=await mail.send({to:claimed.to,subject:claimed.subject,text:email.text,html:email.html,unsubscribeUrl:link,messageId:claimed.id});}
    catch {outcome={delivery:'unknown',id:null};}
    const status=outcome.delivery==='sent'?'accepted':outcome.delivery==='failed'?'failed':'unknown';
    await growth.store.finish(claimed.id,status,outcome.id);
    if(status==='failed'||status==='unknown')throw Object.assign(new Error('Delivery needs review'),{code:status==='failed'?'delivery_failed':'delivery_unknown'});
    return {delivery:status};
  }};
}
