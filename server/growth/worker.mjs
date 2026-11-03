import { contentBrief } from './content.mjs';
import { weekStart } from '../agents/accounts/week.mjs';
import { assessProspect } from './assessment.mjs';
import { planOpportunity, products } from './policy.mjs';
import { draftMessage } from './draft.mjs';
import { renderEmail } from '../email-layout.mjs';
const deferred=()=>Object.assign(new Error('Action is deferred'),{code:'action_deferred'});
export function growthHandlers({growth,model,notifier}) {
  if(!growth)return {};
  async function sweep(task,{signal,now=()=>new Date()}={}) {
    await growth.store.maintenance?.();
    const owner=task.kind==='growth.success'?'account_manager':'marketing_manager'; let inspected=0,planned=0,drafted=0,offset=0,total=1;
    while(offset<total) {
      signal?.throwIfAborted(); const page=await growth.store.snapshot(offset);total=page.total;offset+=page.items.length;if(!page.items.length)break;
      for(const o of page.items) {
        signal?.throwIfAborted(); if(o.owner_agent!==owner)continue; inspected++;
        const plans=planOpportunity(o,now());
        if(task.agent?.autonomy==='observe')continue;
        if(owner==='marketing_manager' && ['identified','researched'].includes(o.stage) && (!o.assessed_at || (o.evidence??[]).some(e=>Date.parse(e.observed_at)>Date.parse(o.assessed_at)))) {
          const assessment=await assessProspect(o,task,model,signal);
          signal?.throwIfAborted();
          if(assessment) {await growth.store.assess(o.id,assessment);continue;}
        }
        for(const work of plans) {
          signal?.throwIfAborted(); const existing=(o.work??[]).find(w=>w.trigger_key===work.key);
          if(existing?.status==='resolved'||existing?.status==='cancelled')continue;
          const id=await growth.store.plan(o.id,work);planned++;
          if(!['outreach','onboarding','activation','trial','adoption','renewal','expansion','support','recovery'].includes(work.kind)||o.eligibility!=='permitted'||!growth.signingReady)continue;
          if(existing?.message_id && existing.message_status!=='cancelled') {if(existing.message_status==='draft')await growth.store.propose(task.id,existing.message_id);continue;}
          const draft=await draftMessage({opportunity:o,work,task,model,signal});if(!draft)continue;
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
    if(planned && notifier)await notifier.send({severity:'info',subject:'Customer growth work is ready',body:`${planned} follow-up tasks reviewed; ${drafted} message drafts prepared. Open Growth to review next actions.`,dedupeKey:`growth:${owner}:${now().toISOString().slice(0,10)}`,agentKey:owner,taskId:task.id});
    return {result:{inspected,planned,drafted}};
  }
  async function discover(task,{signal}={}) {
    if(!growth.research?.configured)return {result:{skipped:'research_not_configured'}};
    if(task.agent?.autonomy==='observe')return {result:{skipped:'observe_only'}};
    let candidates=0;
    for(const product of products){signal?.throwIfAborted(); const rows=await growth.research.search(product,{signal});signal?.throwIfAborted();candidates+=await growth.store.discover(product,rows);}
    return {result:{candidates}};
  }
  async function content(task,{signal,now=()=>new Date()}={}) {
    if(task.agent?.autonomy==='observe'||!growth.research?.configured)return {result:{skipped:'content_research_not_enabled'}};
    const week=weekStart(now()),context=await growth.store.contentContext(week);
    if(context.planned && task.sourceKind!=='owner')return {result:{skipped:'already_planned',contentWeek:week}};
    let proposals=0;
    for(const policy of context.policies) {
      signal?.throwIfAborted(); if(!policy.approved_claim.trim())continue;
      const sources=await growth.research.search(policy.product,{topic:policy.product==='carebase'?'staff training reporting questions':'provider referral development questions',signal});
      const brief=await contentBrief({product:policy.product,claim:policy.approved_claim,bookingUrl:policy.booking_url,sources,task,model,signal});
      signal?.throwIfAborted(); if(!brief)continue;
      await growth.store.proposeContent(task.id,policy.product,{...brief,campaign:`growth:${policy.product}:${week}`});proposals++;
    }
    return {status:proposals?'awaiting_approval':'done',result:{contentWeek:week,proposals}};
  }
  return {'growth.pipeline':sweep,'growth.success':sweep,'growth.discovery':discover,'growth.content':content};
}
export function growthExecutors({growth,mail,publicOrigin,postalAddress}) {
  if(!growth)return {};
  return {'growth.content':async()=>({recorded:true,published:false}),'growth.message':async execution=>{
    if(!growth.configured()||!mail?.configured)throw deferred();
    const claimed=await growth.store.claim(execution.input.messageId,execution.id);
    if(!claimed.send){if(['frequency_limited','daily_limit','evaluation_required','delivery_unresolved'].includes(claimed.status))throw deferred();return {delivery:claimed.status};}
    // The work ID is read from the claim, so the exact link is stable across retries.
    const token=growth.unsubscribeToken(claimed.workId);
    if(claimed.unsubscribeHash && growth.hash(token)!==claimed.unsubscribeHash){await growth.store.finish(claimed.id,'failed',null);throw Object.assign(new Error('Regenerate the message after signing configuration changed'),{code:'unsubscribe_key_changed'});}
    const link=`${publicOrigin.replace(/\/+$/,'')}/api/growth/unsubscribe/${token}`;
    const footer=['CareMetric',postalAddress,{label:'Unsubscribe from growth messages',url:link}];
    const text=`${claimed.body}\n\n${footer.map(line=>typeof line==='string'?line:`${line.label}: ${line.url}`).join('\n')}`;
    let outcome;
    try {outcome=await mail.send({to:claimed.to,subject:claimed.subject,text,html:renderEmail({layout:'personal',title:claimed.subject,signature:[],blocks:[{type:'message',text:claimed.body}],footer}).html,unsubscribeUrl:link,messageId:claimed.id});}
    catch {outcome={delivery:'unknown',id:null};}
    const status=outcome.delivery==='sent'?'accepted':outcome.delivery==='failed'?'failed':'unknown';
    await growth.store.finish(claimed.id,status,outcome.id);
    if(status==='failed'||status==='unknown')throw Object.assign(new Error('Delivery needs review'),{code:status==='failed'?'delivery_failed':'delivery_unknown'});
    return {delivery:status};
  }};
}
