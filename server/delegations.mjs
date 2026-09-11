import { digest, token, transaction, withSession, HttpError } from './sms-auth.mjs';
import { parseAdminOperation, parseAdminEnvelope } from '../supabase/functions/_shared/adminProtocol.ts';

const prefix = 'cmh_';
export const validDelegation = value => typeof value==='string' && /^cmh_[A-Za-z0-9_-]{43}$/.test(value);
const mediaPath = /^learning\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/(video\.mp4|captions\.vtt|transcript\.txt)$/;
export function validateMedia(path,operation) {
  if (!mediaPath.test(path || '') || !['upload','download','sign'].includes(operation)) throw new HttpError(400,'Invalid media request.');
}
async function authorize(db,audience,payload) {
  if (audience==='carebase') return (await db.query('select hub.authorize_app_admin() as actor')).rows[0].actor;
  validateMedia(payload.path,payload.operation);
  if (!(await db.query('select hub.authorize_learning_object($1,$2) as allowed',[payload.path,payload.operation])).rows[0].allowed) throw new HttpError(403,'Media access denied.');
  return payload;
}
export function delegations({pool,storageUrl,fetchImpl=fetch}) {
  const issue = async (sessionToken,audience,payload) => {
    const sessionId = await withSession(pool,sessionToken,async(db,session) => {
      await authorize(db,audience,payload); return session.id;
    });
    const capability=prefix+token();
    await pool.query(`insert into private.app_delegations(token_hash,session_id,audience,payload,expires_at)
      values($1,$2,$3,$4::jsonb,now()+interval '30 seconds')`,[digest(capability),sessionId,audience,JSON.stringify(payload)]);
    return capability;
  };
  return {
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
        return audience==='carebase' ? { ...authorized, operation:delegation.payload } : authorized;
      });
    },
    async admin(sessionToken,input) {
      let operation;
      try { operation=parseAdminOperation(input); } catch { throw new HttpError(400,'Invalid administrator request.'); }
      const capability=await issue(sessionToken,'carebase',operation);
      const response=await fetchImpl('https://cmcarebase.com/api/platform-admin/read',{
        method:'POST',headers:{Authorization:`Bearer ${capability}`,'Content-Type':'application/json'},body:JSON.stringify(operation),
        signal:AbortSignal.timeout(12000),redirect:'manual',
      });
      if (!response.ok) throw new HttpError(response.status===401 || response.status===403 ? response.status : 503,'Administrator connection is unavailable.');
      const raw=await response.text();
      if (raw.length>1000000) throw new HttpError(503,'Administrator response is too large.');
      return parseAdminEnvelope(JSON.parse(raw),operation);
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
