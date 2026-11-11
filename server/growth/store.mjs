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
  };
}
