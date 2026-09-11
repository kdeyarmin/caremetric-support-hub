import { withSession, HttpError } from './sms-auth.mjs';
import { callNativeAdmin } from './admin-transport.mjs';
import { adminRegistry } from '../supabase/functions/_shared/adminRegistry.ts';
import { onboardingRequest, onboardingPreview, onboardingResult, supportIdentityOperation, projectSupportIdentity } from '../src/support/onboardingProtocol.ts';

const fields={prepare_support_onboarding:{p_identity:'jsonb',p_hub_user_id:'uuid',p_tenant_name:'text'},
  inspect_support_onboarding:{p_intent_id:'uuid',p_proof_digest:'text',p_request_id:'uuid'},
  apply_support_onboarding:{p_intent_id:'uuid',p_proof_digest:'text',p_request_id:'uuid',p_identity:'jsonb',p_reviewed:'boolean'}};
export function supportOnboarding({pool,issue,fetchImpl=fetch}) {
  return async(sessionToken,input,requestSignal)=>{
    const parsed=onboardingRequest.safeParse(input);
    if(!parsed.success) throw new HttpError(400,'Check the account identifiers and review confirmation.','invalid_request');
    const op=parsed.data;
    const signal=AbortSignal.any([...(requestSignal?[requestSignal]:[]),AbortSignal.timeout(12000)]);
    const hub=(name,args)=>withSession(pool,sessionToken,async db=>{
      signal.throwIfAborted();
      const actor=(await db.query('select hub.authorize_app_command() as actor')).rows[0].actor;
      await db.query('reset role');
      const values=[actor.user_id,actor.session_id],params=['p_actor_id=>$1::uuid','p_session_id=>$2::uuid'];
      for(const [key,type] of Object.entries(fields[name])) {values.push(type==='jsonb'?JSON.stringify(args[key]):args[key]);params.push(`${key}=>$${values.length}::${type}`);}
      const result=(await db.query(`select hub.${name}(${params.join(',')}) as result`,values)).rows[0].result;
      signal.throwIfAborted();return result;
    });
    const native=async(product,sourceUserId,sourceAccountId)=>{
      const operation=supportIdentityOperation.parse({operation:'support.identity.resolve',sourceUserId,sourceAccountId});
      const entry=adminRegistry[product];
      if(!entry?.endpoint)throw new HttpError(503,'The application must connect its support account verification first.','unconfigured');
      const capability=await issue(sessionToken,product,operation);
      return callNativeAdmin(fetchImpl,entry.endpoint,entry.authorizationHeader??'Authorization',capability,operation,value=>projectSupportIdentity(value,product,operation),false,signal,8192);
    };
    try {
      if(op.operation==='preview') {
        const identity=await native(op.product,op.sourceUserId,op.sourceAccountId);
        return onboardingPreview.parse(await hub('prepare_support_onboarding',{p_identity:identity,p_hub_user_id:op.hubUserId,p_tenant_name:op.tenantName}));
      }
      const args={p_intent_id:op.intentId,p_proof_digest:op.proofDigest,p_request_id:op.requestId};
      const preview=onboardingPreview.parse(await hub('inspect_support_onboarding',args));
      // Re-resolve even on an idempotent retry; no stale authority is accepted.
      const identity=await native(preview.identity.product,preview.identity.sourceUserId,preview.identity.sourceAccountId);
      return onboardingResult.parse(await hub('apply_support_onboarding',{...args,p_identity:identity,p_reviewed:op.reviewed}));
    } catch(error) {
      if(error instanceof HttpError)throw error;
      const code=({42501:'forbidden',28000:'unauthenticated',40001:'conflict',22023:'invalid_request'})[error.code]??'upstream';
      throw new HttpError(({forbidden:403,unauthenticated:401,conflict:409,invalid_request:400})[code]??503,
        code==='conflict'?'The account or review changed. Load a new preview.':'The account could not be linked.',code);
    }
  };
}
