import { digest, token, transaction, withSession, HttpError } from './sms-auth.mjs';
import { parsePortfolioRequest, parsePortfolioEnvelope } from '../supabase/functions/_shared/portfolioProtocol.ts';
import { adminRegistry } from '../supabase/functions/_shared/adminRegistry.ts';
import { parsePortfolioCommand, parseCommandEnvelope } from '../supabase/functions/_shared/adminCommandProtocol.ts';
import { callNativeAdmin } from './admin-transport.mjs';
import { nativeLearningOperationSchema } from '../src/learning/receiptProtocol.ts';
import { learningReceipts } from './learning-receipts.mjs';

const prefix = 'cmh_';
export const validDelegation = value => typeof value==='string' && /^cmh_[A-Za-z0-9_-]{43}$/.test(value);
const mediaPath = /^learning\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/(video\.mp4|captions\.vtt|transcript\.txt)$/;
export function validateMedia(path,operation) {
  if (!mediaPath.test(path || '') || !['upload','download','sign'].includes(operation)) throw new HttpError(400,'Invalid media request.');
}
async function authorize(db,audience,payload) {
  if (['carebase','breathe','caremetric-emr','pennsync','caremetric-go','intel'].includes(audience)) {
    parsePortfolioRequest({product:audience,...payload});
    return (await db.query('select hub.authorize_app_admin() as actor')).rows[0].actor;
  }
  if (audience==='carebase.command') {
    parsePortfolioCommand({product:'carebase',...payload});
    return (await db.query('select hub.authorize_app_command() as actor')).rows[0].actor;
  }
  if (audience==='carebase.learning') {
    nativeLearningOperationSchema.parse(payload);
    return (await db.query('select hub.authorize_app_command() as actor')).rows[0].actor;
  }
  if (audience!=='media') throw new HttpError(403,'Unsupported authorization audience.');
  validateMedia(payload.path,payload.operation);
  if (!(await db.query('select hub.authorize_learning_object($1,$2) as allowed',[payload.path,payload.operation])).rows[0].allowed) throw new HttpError(403,'Media access denied.');
  return payload;
}
export function delegations({pool,storageUrl,fetchImpl=fetch}) {
  const issue = async (sessionToken,audience,payload) => {
    return withSession(pool,sessionToken,async(db,session) => {
      await authorize(db,audience,payload);
      const capability=prefix+token();
      // Return to the dedicated connection role only after relational authorization.
      await db.query('reset role');
      await db.query(`insert into private.app_delegations(token_hash,session_id,audience,payload,expires_at)
        values($1,$2,$3,$4::jsonb,now()+interval '30 seconds')`,[digest(capability),session.id,audience,JSON.stringify(payload)]);
      return capability;
    });
  };
  return {
    learning: learningReceipts({pool,issue,fetchImpl}),
    async consume(capability,audience) {
      if (!validDelegation(capability)) throw new HttpError(401,'Invalid authorization.');
      return transaction(pool,async db => {
        const {rows:[delegation]} = await db.query(`select d.payload,s.id,s.user_id from private.app_delegations d
          join private.sms_sessions s on s.id=d.session_id
          join private.sms_identities i on i.user_id=s.user_id and i.identity_version=s.identity_version
          where d.token_hash=$1 and d.audience=$2 and d.consumed_at is null and d.expires_at>now()
            and s.revoked_at is null and s.expires_at>now() and i.revoked_at is null for update of d`,[digest(capability),audience]);
        if (!delegation) throw new HttpError(401,'Invalid authorization.');
        await db.query('update private.app_delegations set consumed_at=now() where token_hash=$1',[digest(capability)]);
        await db.query('set local role authenticated');
        await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:delegation.user_id,role:'authenticated',sms_session_id:delegation.id})]);
        const authorized=await authorize(db,audience,delegation.payload);
        return audience==='media' ? authorized : { ...authorized, operation:delegation.payload };
      });
    },
    async admin(sessionToken,input) {
      let request;
      try { request=parsePortfolioRequest(input); } catch { throw new HttpError(400,'Invalid administrator request.'); }
      const entry=adminRegistry[request.product];
      if (!entry.endpoint || !['carebase','breathe','caremetric-emr','pennsync','caremetric-go','intel'].includes(request.product)) throw new HttpError(503,'This application has not connected its administrator session.','unconfigured');
      const operation=request.operation;
      const capability=await issue(sessionToken,request.product,operation);
      return callNativeAdmin(fetchImpl,entry.endpoint,entry.authorizationHeader ?? 'Authorization',capability,operation,value=>parsePortfolioEnvelope(value,request));
    },
    async command(sessionToken,input) {
      let request;
      try { request=parsePortfolioCommand(input); } catch { throw new HttpError(400,'Invalid administrator command.','invalid_request'); }
      const capability=await issue(sessionToken,'carebase.command',request.command);
      return callNativeAdmin(fetchImpl,'https://cmcarebase.com/api/platform-admin/command','Authorization',capability,request.command,value=>parseCommandEnvelope(value,request),true);
    },
    async media(sessionToken,path,operation,body,contentType) {
      validateMedia(path,operation);
      const capability=await issue(sessionToken,'media',{path,operation});
      return fetchImpl(`${storageUrl}/functions/v1/app-media`,{
        method:'POST',headers:{Authorization:`Bearer ${capability}`,'Content-Type':contentType || 'application/json'},
        body:body || '{}', ...(body ? {duplex:'half'} : {}), signal:AbortSignal.timeout(120000),redirect:'manual',
      });
    },
  };
}
