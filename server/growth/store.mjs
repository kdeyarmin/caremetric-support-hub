import { transaction, withSession } from '../sms-auth.mjs';
export function growthStore(pool) {
  const run=(client,fn,args)=>client.query(`select ${fn}(${args.map((_,i)=>`$${i+1}`).join(',')}) as result`,args).then(r=>r.rows[0].result);
  const server=(fn,args=[])=>transaction(pool,db=>run(db,fn,args));
  return {
    contentContext:week=>server('private.growth_content_context',[week]),
    proposeContent:(task,product,data)=>server('private.growth_propose_content',[task,product,data]),
    assess:(id,data)=>server('private.growth_assess',[id,data]),
    maintenance:()=>server('private.growth_maintenance'),
    // node-pg sends a JavaScript array as a Postgres array, not JSON: jsonb arguments that can be arrays are sent as JSON text.
    evaluate:(product,version,passed,results)=>server('private.growth_evaluate',[product,version,passed,JSON.stringify(results)]),
    // The Monday live writing evaluation (20261117210000_growth_reach.sql; live-evaluation.mjs reads it with the feature): each case's
    // grade as it is written, the run's state with the Intel policy, and the latest result for the scorecard.
    liveEvalState:run=>server('private.growth_live_eval_state',[run]),
    liveEvalRecord:(run,key,result)=>server('private.growth_live_eval_record',[run,key,JSON.stringify(result)]),
    liveEvaluationLatest:since=>server('private.growth_live_evaluation_latest',[since]),
    workspace:(token,offset=0)=>withSession(pool,token,db=>run(db,'hub.growth_workspace',[offset])),
    detail:(token,id)=>withSession(pool,token,db=>run(db,'hub.growth_detail',[id])),
    researchTarget:(token,id)=>withSession(pool,token,db=>run(db,'hub.growth_research_target',[id])),
    discover:(product,rows)=>server('private.growth_discover',[product,JSON.stringify(rows)]),
    contactCandidates:limit=>server('private.growth_contact_candidates',[limit]),
    recordContact:(id,email,sourceUrl)=>server('private.growth_record_contact',[id,email,sourceUrl]),
    autoQualify:limit=>server('private.growth_auto_qualify',[limit]),
    // One re-ask after not now or a silent sequence (20261113172000_growth_reengage.sql).
    reengage:limit=>server('private.growth_reengage',[limit]),
    // Each cold touch also to the organization's other decision-makers (20261115230000_growth_colleagues.sql).
    colleagueCandidates:limit=>server('private.growth_colleague_candidates',[limit]),
    colleagueDraft:(primaryId,contactId,unsubscribeHash)=>server('private.growth_colleague_draft',[primaryId,contactId,unsubscribeHash]),
    manage:(token,operation,data)=>withSession(pool,token,db=>run(db,'hub.growth_manage',[operation,data])),
    snapshot:(offset=0)=>server('private.growth_snapshot',[offset]),
    event:(product,data)=>server('private.growth_record_event',[product,data]),
    appEvent:(keyHash,data)=>server('private.growth_app_event',[keyHash,data]),
    plan:(id,data)=>server('private.growth_plan',[id,data]),
    draft:(id,work,data)=>server('private.growth_draft',[id,work,data]),
    // Prospects who replied, were answered and went quiet (20261117190000_growth_priority.sql; the worker reads it only with the feature).
    quietCandidates:(limit=10)=>server('private.growth_quiet_candidates',[limit]),
    propose:(taskId,messageId)=>server('private.growth_propose',[taskId,messageId]),
    claim:(id,action)=>server('private.growth_claim_message',[id,action]),
    finish:(id,status,provider)=>server('private.growth_finish_message',[id,status,provider]),
    // A claimed email the server will not send (its words broke a rule added after it was written): cancelled and freed to be redrafted.
    withdraw:(id,reason)=>server('private.growth_withdraw_message',[id,reason]),
    delivery:(event,id,kind,at,suppress=true)=>server('private.growth_delivery_event',[event,id,kind,at,...(suppress === false ? [false] : [])]),
    unsubscribe:hash=>server('private.growth_unsubscribe',[hash]),
    inquiry:(messageId)=>server('private.growth_inquiry',[messageId]),
    // The Medicare roster (20261113170500_growth_roster.sql).
    rosterSyncState:()=>server('private.growth_roster_sync_state'),
    rosterSyncSave:data=>server('private.growth_roster_sync_save',[data]),
    rosterUpsert:(period,rows)=>server('private.growth_roster_upsert',[period,JSON.stringify(rows)]),
    rosterNext:(limit,daily)=>server('private.growth_roster_next',[limit,daily]),
    rosterResolved:(ccn,data)=>server('private.growth_roster_resolved',[ccn,data]),
    // A web search for the agencies the lookups did not find (20261117210000_growth_reach.sql; site-search.mjs reads it with the feature).
    rosterSiteNext:(limit,daily)=>server('private.growth_roster_site_next',[limit,daily]),
    rosterSiteRecord:(ccn,data)=>server('private.growth_roster_site_record',[ccn,data]),
    roster:(token,offset=0)=>withSession(pool,token,db=>run(db,'hub.growth_roster',[offset])),
    // The owner's "Use this site" for a site the web search suggested (20261125161000_first_replies_sites.sql).
    rosterUseSite:(token,ccn,domain)=>withSession(pool,token,db=>run(db,'hub.growth_roster_use_site',[ccn,domain])),
    // Web-found prospects matched to their Medicare record (20261115233000_growth_roster_match.sql). node-pg sends the outcome object
    // as JSON.
    matchNext:(limit,daily)=>server('private.growth_roster_match_next',[limit,daily]),
    matchRecord:(org,data)=>server('private.growth_roster_match_record',[org,data]),
    // The roster's agencies for LinkedIn's company list (20261113230000_ads_buildout.sql).
    rosterCompanies:token=>withSession(pool,token,db=>run(db,'hub.growth_roster_companies',[])),
    // Decision-makers and imported lists (20261113180000_growth_people.sql).
    peopleCandidates:limit=>server('private.growth_people_candidates',[limit]),
    peopleRecord:(org,people)=>server('private.growth_people_record',[org,JSON.stringify(people)]),
    enrichmentReserve:credits=>server('private.growth_enrichment_reserve',[credits]),
    // The verification service's checks today (20261117233000_growth_address_service.sql): false once the owner's daily number is used.
    addressServiceReserve:checks=>server('private.growth_address_service_reserve',[checks]),
    // Hunter's lookups for the owners' batches (20261127230000_growth_hunter.sql): the agencies, a reserved lookup (null once the day's number
    // is used or the setting is off) and its answer.
    hunterNext:limit=>server('private.growth_hunter_next',[limit]),
    hunterBegin:(org,person)=>server('private.growth_hunter_begin',[org,person]),
    hunterFinish:(id,result)=>server('private.growth_hunter_finish',[id,result]),
    enrichedContact:(person,email,name)=>server('private.growth_enriched_contact',[person,email,name??null]),
    // A found address and how: 'published' with its page on the business's own site, or 'mail_server' (20261113290000_growth_people_finder.sql).
    personAddress:(person,email,name,found,sourceUrl)=>server('private.growth_person_address',[person,email,name??null,found,sourceUrl??null]),
    importServer:rows=>server('private.growth_import_server',[JSON.stringify(rows)]),
    // Which agencies opened their market report (20261116120000_growth_report_views.sql).
    reportViewsCursor:()=>server('private.growth_report_views_cursor'),
    reportViewsRecord:(views,next)=>server('private.growth_report_views_record',[JSON.stringify(views),next]),
    // An account brief per agency before its first email (20261116110000_growth_brief.sql).
    briefNext:daily=>server('private.growth_brief_next',[daily]),
    briefSave:(opportunity,brief)=>server('private.growth_brief_save',[opportunity,JSON.stringify(brief)]),
    briefWriter:opportunity=>server('private.growth_brief_writer',[opportunity]),
    brief:(token,opportunity)=>withSession(pool,token,db=>run(db,'hub.growth_brief',[opportunity])),
    // Addresses checked before the first email, and the bounce guard (20261116100000_growth_address_check.sql).
    sendHold:messageId=>server('private.growth_send_hold',[messageId]),
    draftHold:contactId=>server('private.growth_draft_hold',[contactId]),
    mailboxCandidates:limit=>server('private.growth_mailbox_candidates',[limit]),
    // With a reason (20261117160000_growth_diagnostics.sql), also why the server gave no answer.
    mailboxRecord:(contactId,result,reason)=>server('private.growth_mailbox_record',reason===undefined?[contactId,result]:[contactId,result,reason]),
    reviewRecord:(messageId,review)=>server('private.growth_review_record',[messageId,JSON.stringify(review)]),
    sendGuardState:()=>server('private.growth_send_guard_state'),
    sendGuard:token=>withSession(pool,token,db=>run(db,'hub.growth_send_guard',[])),
    sendGuardResume:token=>withSession(pool,token,db=>run(db,'hub.growth_send_guard_resume',[])),
    // Deeper research with web tools (20261113190000_growth_research.sql).
    researchNext:daily=>server('private.growth_research_next',[daily]),
    // What is working (20261113200000_growth_learning.sql).
    learningFacts:(product,days)=>server('private.growth_learning_facts',[product,days]),
    learningPropose:(product,memo,stats)=>server('private.growth_learning_propose',[product,memo,JSON.stringify(stats)]),
    learningActive:product=>server('private.growth_learning_active',[product]),
    learning:token=>withSession(pool,token,db=>run(db,'hub.growth_learning',[6])),
    learningDecide:(token,id,decision)=>withSession(pool,token,db=>run(db,'hub.growth_learning_decide',[id,decision])),
    people:(token,offset=0)=>withSession(pool,token,db=>run(db,'hub.growth_people',[offset])),
    peopleDecide:(token,ids,decision)=>withSession(pool,token,db=>run(db,'hub.growth_people_decide',[ids,decision])),
    importList:(token,rows)=>withSession(pool,token,db=>run(db,'hub.growth_import',[JSON.stringify(rows)])),
  };
}

/** The owner's own email sequences (20261127150000_owner_sequences.sql; owner-sequence.mjs). */
export function ownerSequenceStore(pool) {
  const run=(client,fn,args)=>client.query(`select ${fn}(${args.map((_,i)=>`$${i+1}`).join(',')}) as result`,args).then(r=>r.rows[0].result);
  const server=(fn,args=[])=>transaction(pool,db=>run(db,fn,args));
  const owner=(token,fn,args=[])=>withSession(pool,token,db=>run(db,fn,args));
  return {
    list:token=>owner(token,'hub.owner_sequences_list'),
    detail:(token,id)=>owner(token,'hub.owner_sequence_detail',[id]),
    // node-pg sends a JavaScript array as a Postgres array: jsonb arguments are sent as JSON text.
    check:(token,people)=>owner(token,'hub.owner_sequence_check',[JSON.stringify(people)]),
    create:(token,record)=>owner(token,'hub.owner_sequence_create',[JSON.stringify(record)]),
    approve:(token,id,version)=>owner(token,'hub.owner_sequence_approve',[id,version]),
    stop:(token,id,recipient=null)=>owner(token,'hub.owner_sequence_stop',[id,recipient]),
    discard:(token,id)=>owner(token,'hub.owner_sequence_discard',[id]),
    claim:()=>server('private.owner_sequence_claim'),
    finish:(id,status,provider)=>server('private.owner_sequence_finish',[id,status,provider]),
    review:()=>server('private.owner_sequence_review'),
    delivery:(event,id,kind,at,suppress=true)=>server('private.owner_sequence_delivery',[event,id,kind,at,suppress]),
    unsubscribe:hash=>server('private.owner_sequence_unsubscribe',[hash]),
    views:views=>server('private.owner_sequence_views',[JSON.stringify(views)]),
    // Requests an operator queued for the owner (20261127200000_owner_sequence_requests.sql).
    requestNext:()=>server('private.owner_sequence_request_next'),
    requestCheck:(id,people)=>server('private.owner_sequence_request_check',[id,JSON.stringify(people)]),
    requestFinish:(id,record,problems,error)=>server('private.owner_sequence_request_finish',[id,record?JSON.stringify(record):null,JSON.stringify(problems??[]),error??null]),
    batchPlan:limit=>server('private.owner_sequence_batch_plan',[limit]),
    batchQueue:payload=>server('private.owner_sequence_batch_queue',[JSON.stringify(payload)]),
  };
}
