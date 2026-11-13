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
    workspace:(token,offset=0)=>withSession(pool,token,db=>run(db,'hub.growth_workspace',[offset])),
    detail:(token,id)=>withSession(pool,token,db=>run(db,'hub.growth_detail',[id])),
    researchTarget:(token,id)=>withSession(pool,token,db=>run(db,'hub.growth_research_target',[id])),
    discover:(product,rows)=>server('private.growth_discover',[product,JSON.stringify(rows)]),
    contactCandidates:limit=>server('private.growth_contact_candidates',[limit]),
    recordContact:(id,email,sourceUrl)=>server('private.growth_record_contact',[id,email,sourceUrl]),
    autoQualify:limit=>server('private.growth_auto_qualify',[limit]),
    // One re-ask after not now or a silent sequence (20261113172000_growth_reengage.sql).
    reengage:limit=>server('private.growth_reengage',[limit]),
    manage:(token,operation,data)=>withSession(pool,token,db=>run(db,'hub.growth_manage',[operation,data])),
    snapshot:(offset=0)=>server('private.growth_snapshot',[offset]),
    event:(product,data)=>server('private.growth_record_event',[product,data]),
    appEvent:(keyHash,data)=>server('private.growth_app_event',[keyHash,data]),
    plan:(id,data)=>server('private.growth_plan',[id,data]),
    draft:(id,work,data)=>server('private.growth_draft',[id,work,data]),
    propose:(taskId,messageId)=>server('private.growth_propose',[taskId,messageId]),
    claim:(id,action)=>server('private.growth_claim_message',[id,action]),
    finish:(id,status,provider)=>server('private.growth_finish_message',[id,status,provider]),
    delivery:(event,id,kind,at)=>server('private.growth_delivery_event',[event,id,kind,at]),
    unsubscribe:hash=>server('private.growth_unsubscribe',[hash]),
    inquiry:(messageId)=>server('private.growth_inquiry',[messageId]),
    // The Medicare roster (20261113170500_growth_roster.sql).
    rosterSyncState:()=>server('private.growth_roster_sync_state'),
    rosterSyncSave:data=>server('private.growth_roster_sync_save',[data]),
    rosterUpsert:(period,rows)=>server('private.growth_roster_upsert',[period,JSON.stringify(rows)]),
    rosterNext:(limit,daily)=>server('private.growth_roster_next',[limit,daily]),
    rosterResolved:(ccn,data)=>server('private.growth_roster_resolved',[ccn,data]),
    roster:(token,offset=0)=>withSession(pool,token,db=>run(db,'hub.growth_roster',[offset])),
    // The roster's agencies for LinkedIn's company list (20261113230000_ads_buildout.sql).
    rosterCompanies:token=>withSession(pool,token,db=>run(db,'hub.growth_roster_companies',[])),
    // Decision-makers and imported lists (20261113180000_growth_people.sql).
    peopleCandidates:limit=>server('private.growth_people_candidates',[limit]),
    peopleRecord:(org,people)=>server('private.growth_people_record',[org,JSON.stringify(people)]),
    enrichmentReserve:credits=>server('private.growth_enrichment_reserve',[credits]),
    enrichedContact:(person,email,name)=>server('private.growth_enriched_contact',[person,email,name??null]),
    // A found address and how: 'published' with its page on the business's own site, or 'mail_server' (20261113280000_growth_people_finder.sql).
    personAddress:(person,email,name,found,sourceUrl)=>server('private.growth_person_address',[person,email,name??null,found,sourceUrl??null]),
    importServer:rows=>server('private.growth_import_server',[JSON.stringify(rows)]),
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
