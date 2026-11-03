/** Product policy, lifecycle planning and metrics stay deterministic. No patient-level activity is accepted. */
export const products = ['carebase', 'caremetric-intel'];
export const stages = ['identified','researched','qualified','contacted','engaged','demo','trial','activated','paying','retained','nurture','lost','churned','disqualified'];
export const eventKinds = ['signup','heartbeat','active','first_value','trial_started','paid','renewed','cancel_requested','churned','support_blocked','support_resolved','expansion_interest','meeting_booked','positive_reply','reply','negative_reply','not_now'];
export const playbooks = Object.freeze({
  carebase: { name: 'CareBase', audience: 'assisted living and personal care operators, operations and training leaders',
    milestone: 'Complete organization setup, assign appropriate staff training, and review the first completion report.',
    query: 'assisted living personal care operator staff training organization' },
  'caremetric-intel': { name: 'CareMetric Intel', audience: 'home health, hospice and post-acute business development leaders',
    milestone: 'Define a territory, build a relevant provider list, and record the outcome of a verified-contact outreach.',
    query: 'home health hospice agency business development organization' },
});
const day = 86400000;
const time = value => { const at = Date.parse(value ?? ''); return Number.isFinite(at) ? at : null; };
const latest = (o, kinds) => (o.events ?? []).filter(e => kinds.includes(e.kind)).sort((a,b) => time(b.occurred_at)-time(a.occurred_at))[0];
export function planOpportunity(o, now = new Date()) {
  if (!products.includes(o.product) || o.internal || ['lost','churned','disqualified'].includes(o.stage)) return [];
  const at = now.getTime(), plans = [];
  const add = (key, kind, action, success, owner = o.owner_agent) => plans.push({ key, kind, action, success, owner, dueAt: now.toISOString() });
  if (o.owner_agent === 'marketing_manager') {
    if (o.stage === 'identified') add('research','research','Verify organization fit, business contact and source evidence.','Fit and intent documented with dated sources.');
    if (['qualified','contacted'].includes(o.stage) && time(o.next_at)<=at && Number(o.touches ?? 0)<(o.policy?.max_touches ?? 3)) {
      const replied = latest(o,['reply','positive_reply','negative_reply','not_now','meeting_booked','trial_started']);
      if (!replied) add(`outreach:${o.touches ?? 0}`,'outreach','Offer one relevant next step based on verified product fit.','A qualified reply, meeting, trial or explicit disposition is recorded.');
    }
    if (['engaged','demo'].includes(o.stage) && time(o.next_at)<=at) add(`followup:${o.version}`,'reply','Resolve the prospect question and agree a dated next step.','Meeting, trial, nurture or loss reason confirmed.');
    return plans;
  }
  const milestone = playbooks[o.product].milestone;
  if (!o.activated_at && ['trial','activated','paying','retained'].includes(o.stage)) {
    add('onboarding','onboarding',`Agree the customer goal. ${milestone}`,'First-value event or customer-confirmed goal reached.','account_manager');
    if (at-time(latest(o,['trial_started','signup'])?.occurred_at??o.created_at)>=2*day) add('activation','activation',`Identify the setup blocker. ${milestone}`,'First-value event received.','account_manager');
  }
  const trial = time(o.trial_end);
  if (o.stage==='trial' && trial!==null && trial-at<=7*day) add(`trial:${trial}:${trial<at?'expired':trial-at<=2*day?'2':'7'}`,'trial',trial<at?'Confirm the expired trial outcome and agree conversion, nurture or a loss reason.':'Review trial progress and resolve the next blocker before expiry.','Paid conversion or an explicit, recorded trial decision.','account_manager');
  const heartbeat = latest(o,['heartbeat','active','first_value']);
  const active = latest(o,['active','first_value']);
  const fresh = heartbeat && at-time(heartbeat.occurred_at)<=2*day;
  if (['activated','paying','retained'].includes(o.stage)) {
    if (!fresh) add(`telemetry:${heartbeat?.occurred_at??'none'}`,'telemetry','Check the product activity feed; adoption is unknown.','Fresh authenticated telemetry received.','account_manager');
    else if (!active || at-time(active.occurred_at)>=7*day) add(`adoption:${active?.occurred_at??'none'}`,'adoption','Ask the champion about the stalled workflow and resolve the blocker.','Meaningful product activity resumes and persists.','account_manager');
  }
  const blocked=latest(o,['support_blocked','support_resolved']);
  if (blocked?.kind==='support_blocked') add(`support:${blocked.occurred_at}`,'support','Coordinate resolution with support before proposing expansion.','Support resolved and customer outcome confirmed.','account_manager');
  const cancel=latest(o,['cancel_requested','renewed']);
  if (cancel?.kind==='cancel_requested') add(`recovery:${cancel.occurred_at}`,'recovery','Contact the champion to understand cancellation and agree a recovery plan.','Customer decision and subsequent adoption recorded.','account_manager');
  const renewal=time(o.renewal_at);
  if (renewal!==null && renewal>=at && renewal-at<=30*day) add(`renewal:${renewal}`,'renewal','Review goals achieved and unresolved issues with the buyer.','Renewal decision recorded.','account_manager');
  const expansion=latest(o,['expansion_interest']);
  if (expansion && fresh && active && at-time(active.occurred_at)<7*day && blocked?.kind!=='support_blocked' && cancel?.kind!=='cancel_requested') add(`expansion:${expansion.occurred_at}`,'expansion','Discuss the additional need the customer expressed.','Qualified expansion outcome recorded.','account_manager');
  return plans;
}
export function qualify(evidence, now = new Date()) {
  const fresh=(evidence??[]).filter(e=>time(e.observed_at)!==null && time(e.observed_at)<=now.getTime() && now-time(e.observed_at)<30*day && /^https:\/\//.test(e.source_url??''));
  // Evidence coverage, not an invented buying probability. Intent requires an actual reply/event.
  return { evidenceCount:fresh.length, fitConfidence:fresh.some(e=>e.confidence==='high')?'high':fresh.length?'medium':'unknown', canDraft:fresh.length>0 };
}
