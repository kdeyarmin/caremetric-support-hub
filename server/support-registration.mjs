import { randomUUID } from 'node:crypto';
import { digest,token,transaction,withSession,HttpError } from './sms-auth.mjs';
import { callNativeAdmin } from './admin-transport.mjs';
import { adminRegistry } from '../supabase/functions/_shared/adminRegistry.ts';
import { supportIdentityOperation } from '../src/support/onboardingProtocol.ts';
import { registrationAdminRequest,registrationPreview,registrationInvitation,registrationList,registrationStart,registrationVerify,projectRegistrationIdentity } from '../src/support/registrationProtocol.ts';

const fields={prepare_support_registration:{p_identity:'jsonb',p_phone:'text',p_display_name:'text',p_tenant_name:'text'},
  inspect_support_registration:{p_review_id:'uuid',p_proof_digest:'text'},
  issue_support_registration:{p_review_id:'uuid',p_proof_digest:'text',p_request_id:'uuid',p_token_hash:'text',p_identity:'jsonb',p_reviewed:'boolean'},
  list_support_registrations:{p_offset:'integer'},revoke_support_registration:{p_invitation_id:'uuid',p_reviewed:'boolean'}};
function failure(error) {
  if(error instanceof HttpError)return error;
  const status=({42501:403,28000:401,40001:409,23505:409,22023:400,P0429:429})[error.code]??503;
  return new HttpError(status,status===429?'Please wait before requesting another code.':status===409?'The invitation or account changed. Refresh and review it again.':'The registration could not be completed.');
}
export function supportRegistration({pool,issue,provider,fetchImpl=fetch}) {
  return {
    async admin(sessionToken,input,requestSignal) {
      const parsed=registrationAdminRequest.safeParse(input);
      if(!parsed.success)throw new HttpError(400,'Check the account details and review confirmation.');
      const op=parsed.data,signal=AbortSignal.any([...(requestSignal?[requestSignal]:[]),AbortSignal.timeout(12000)]);
      const hub=(name,args)=>withSession(pool,sessionToken,async db=>{
        signal.throwIfAborted();const actor=(await db.query('select hub.authorize_app_command() as actor')).rows[0].actor;
        await db.query('reset role');
        const values=[actor.user_id,actor.session_id],params=['p_actor_id=>$1::uuid','p_session_id=>$2::uuid'];
        for(const [key,type] of Object.entries(fields[name])){values.push(type==='jsonb'?JSON.stringify(args[key]):args[key]);params.push(`${key}=>$${values.length}::${type}`);}
        const result=(await db.query(`select hub.${name}(${params.join(',')}) as result`,values)).rows[0].result;
        signal.throwIfAborted();return result;
      });
      const native=async(product,sourceUserId,sourceAccountId)=>{
        const operation=supportIdentityOperation.parse({operation:'support.identity.resolve',sourceUserId,sourceAccountId});
        const entry=adminRegistry[product];if(!entry?.endpoint)throw new HttpError(503,'Connect the application first.');
        const capability=await issue(sessionToken,product,operation);
        return callNativeAdmin(fetchImpl,entry.endpoint,entry.authorizationHeader??'Authorization',capability,operation,value=>projectRegistrationIdentity(value,product,operation),false,signal,8192);
      };
      try {
        if(op.operation==='list')return registrationList.parse(await hub('list_support_registrations',{p_offset:op.offset}));
        if(op.operation==='revoke')return registrationInvitation.parse(await hub('revoke_support_registration',{p_invitation_id:op.invitationId,p_reviewed:op.reviewed}));
        if(op.operation==='preview'){
          const identity=await native(op.product,op.sourceUserId,op.sourceAccountId);
          return registrationPreview.parse(await hub('prepare_support_registration',{p_identity:identity,p_phone:op.phone,p_display_name:op.displayName,p_tenant_name:op.tenantName}));
        }
        const args={p_review_id:op.reviewId,p_proof_digest:op.proofDigest};
        const preview=registrationPreview.parse(await hub('inspect_support_registration',args));
        const identity=await native(preview.identity.product,preview.identity.sourceUserId,preview.identity.sourceAccountId);
        return registrationInvitation.parse(await hub('issue_support_registration',{...args,p_request_id:op.requestId,p_token_hash:digest(op.claimCode),p_identity:identity,p_reviewed:op.reviewed}));
      }catch(error){throw failure(error);}
    },
    async start(input,clientAddress){
      const parsed=registrationStart.safeParse(input);if(!parsed.success)throw new HttpError(400,'Enter your invitation code and mobile number, and confirm you want a verification text.');
      const {claimCode,phone}=parsed.data,id=randomUUID(),browserToken=token();
      try{return await transaction(pool,async db=>{
        const value=(await db.query('select private.start_registration_challenge($1,$2,$3,$4,$5) as result',[digest(claimCode),phone,digest(clientAddress||'unknown'),digest(browserToken),id])).rows[0].result;
        if(value.phone){
          try{const providerId=await provider.send(value.phone);await db.query('update private.sms_challenges set provider_id=$2 where id=$1',[id,providerId]);}
          catch{return {id,browserToken,unavailable:true};}
        }
        return {id,browserToken,unavailable:false};
      });}catch(error){throw failure(error);}
    },
    async verify(input,browserToken,previousSession){
      const parsed=registrationVerify.safeParse(input);
      if(!parsed.success||!browserToken)throw new HttpError(400,'The code could not be verified. Request a new code.');
      const {challengeId,code}=parsed.data;
      try{
        const result=await transaction(pool,async db=>{
          const challenge=(await db.query('select private.inspect_registration_challenge($1,$2) as result',[challengeId,digest(browserToken)])).rows[0].result;
          if(!challenge?.providerId||!challenge.phone)return null;
          let accepted=false;try{accepted=(await provider.verify(challenge.providerId,challenge.phone,code))===true;}catch{/* Preserve the failed attempt without exposing provider details. */}
          if(!accepted)return null;
          const identity=(await db.query('select private.complete_support_registration($1,$2) as result',[challengeId,digest(browserToken)])).rows[0].result;
          const sessionToken=token();
          await db.query("insert into private.sms_sessions(id,token_hash,user_id,identity_version,expires_at) values($1,$2,$3,$4,now()+interval '8 hours')",[randomUUID(),digest(sessionToken),identity.userId,identity.identityVersion]);
          if(previousSession)await db.query('update private.sms_sessions set revoked_at=now() where token_hash=$1',[digest(previousSession)]);
          return sessionToken;
        });
        if(!result)throw new HttpError(401,'The code or invitation is incorrect, expired, or already used.');
        return result;
      }catch(error){throw failure(error);}
    },
  };
}
