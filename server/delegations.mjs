import { digest, token, transaction, withSession, HttpError } from './sms-auth.mjs';
import { parsePortfolioRequest, parsePortfolioEnvelope } from '../supabase/functions/_shared/portfolioProtocol.ts';
import { isOperationalRead } from '../supabase/functions/_shared/operationsProtocol.ts';
import { adminRegistry } from '../supabase/functions/_shared/adminRegistry.ts';
import { parsePortfolioCommand, parseCommandEnvelope } from '../supabase/functions/_shared/adminCommandProtocol.ts';
import { callNativeAdmin } from './admin-transport.mjs';
import { publicationId, publicationPart } from '../src/imports/publicationProtocol.ts';
import { publicationRange } from './publication-assets.mjs';
import { nativeLearningOperationSchema } from '../src/learning/receiptProtocol.ts';
import { learningReceipts } from './learning-receipts.mjs';
import { nativeAuthoringOperationSchema } from '../src/learning/authoringProtocol.ts';
import { learningAuthoring } from './learning-authoring.mjs';
import { nativeCreationOperationSchema } from '../src/learning/creationProtocol.ts';
import { learningCreation } from './learning-creation.mjs';
import { supportIdentityOperation } from '../src/support/onboardingProtocol.ts';
import { supportOnboarding } from './support-onboarding.mjs';
import { supportRegistration } from './support-registration.mjs';
import { nativeBillingCommandSchema } from '../supabase/functions/_shared/billingCommandProtocol.ts';
import { billingCommands } from './billing-commands.mjs';
import { nativeCheckoutCommandSchema } from '../supabase/functions/_shared/checkoutCommandProtocol.ts';
import { checkoutCommands } from './checkout-commands.mjs';

const prefix = 'cmh_';
export const validDelegation = value => typeof value==='string' && /^cmh_[A-Za-z0-9_-]{43}$/.test(value);
const mediaPath = /^learning\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/(video\.mp4|captions\.vtt|transcript\.txt)$/;
export function validateMedia(path,operation) {
  if (!mediaPath.test(path || '') || !['upload','download','sign'].includes(operation)) throw new HttpError(400,'Invalid media request.');
}
async function authorize(db,audience,payload) {
  if(audience==='publication') {
    if(!payload || Object.keys(payload).sort().join(',')!=='id,operation,part,range'
      || !['upload','download'].includes(payload.operation) || (payload.operation==='upload' && payload.range!==null)) throw new HttpError(400,'Invalid publication capability.');
    publicationId.parse(payload.id); publicationPart.parse(payload.part);
    await db.query('reset role');
    const asset=(await db.query('select private.publication_object($1,$2,$3) as result',[payload.id,payload.part,payload.operation])).rows[0].result;
    await db.query('set local role authenticated');
    const range=payload.operation==='download'?publicationRange(payload.range,asset.byteLength):null;
    return {...asset,range:range?.header ?? null};
  }
  if (['carebase','breathe','caremetric-emr','pennsync','caremetric-go','intel'].includes(audience)) {
    if(payload?.operation==='support.identity.resolve') {
      supportIdentityOperation.parse(payload);
      await db.query('select hub.authorize_app_command()');
      return (await db.query('select hub.authorize_app_admin() as actor')).rows[0].actor;
    }
    parsePortfolioRequest({product:audience,...payload});
    // Operational metadata requires the original, bounded SMS assurance window.
    // Keep the read audience: session fields must never grant a command capability.
    if (audience==='carebase' && isOperationalRead(payload.operation)) {
      return (await db.query('select hub.authorize_app_command() as actor')).rows[0].actor;
    }
    return (await db.query('select hub.authorize_app_admin() as actor')).rows[0].actor;
  }
  if (audience==='carebase.command') {
    if (!nativeBillingCommandSchema.safeParse(payload).success && !nativeCheckoutCommandSchema.safeParse(payload).success) parsePortfolioCommand({product:'carebase',...payload});
    return (await db.query('select hub.authorize_app_command() as actor')).rows[0].actor;
  }
  if (audience==='carebase.learning') {
    nativeLearningOperationSchema.or(nativeAuthoringOperationSchema).or(nativeCreationOperationSchema).parse(payload);
    return (await db.query('select hub.authorize_app_command() as actor')).rows[0].actor;
  }
  if (audience!=='media') throw new HttpError(403,'Unsupported authorization audience.');
  validateMedia(payload.path,payload.operation);
  if (!(await db.query('select hub.authorize_learning_object($1,$2) as allowed',[payload.path,payload.operation])).rows[0].allowed) throw new HttpError(403,'Media access denied.');
  return payload;
}
export function delegations({pool,storageUrl,provider,fetchImpl=fetch}) {
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
    authoring: learningAuthoring({pool,issue,fetchImpl}),
    creation: learningCreation({pool,issue,fetchImpl}),
    onboarding: supportOnboarding({pool,issue,fetchImpl}),
    registration: supportRegistration({pool,issue,provider,fetchImpl}),
    billingCommand: billingCommands({pool,issue,fetchImpl}),
    checkoutCommand: checkoutCommands({pool,issue,fetchImpl}),
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
        return ['media','publication'].includes(audience) ? authorized : { ...authorized, operation:delegation.payload };
      });
    },
    async admin(sessionToken,input) {
      let request;
      try { request=parsePortfolioRequest(input); } catch { throw new HttpError(400,'Invalid administrator request.'); }
      const entry=adminRegistry[request.product];
      if (!entry.endpoint || !['carebase','breathe','caremetric-emr','pennsync','caremetric-go','intel'].includes(request.product)) throw new HttpError(503,'This application has not connected its administrator session.','unconfigured');
      const operation=request.operation;
      const capability=await issue(sessionToken,request.product,operation);
      const result=await callNativeAdmin(fetchImpl,entry.endpoint,entry.authorizationHeader ?? 'Authorization',capability,operation,value=>parsePortfolioEnvelope(value,request));
      // A logout, revocation or role change while the native read was in flight
      // must prevent the response from reaching the browser.
      await withSession(pool,sessionToken,db=>authorize(db,request.product,operation));
      return result;
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
    async publication(sessionToken,id,part,operation,body,contentType,range=null) {
      const capability=await issue(sessionToken,'publication',{id,part,operation,range});
      return fetchImpl(`${storageUrl}/functions/v1/publication-media`,{
        method:'POST',headers:{Authorization:`Bearer ${capability}`,'Content-Type':contentType || 'application/json'},
        body:body || '{}',...(body?{duplex:'half'}:{}),signal:AbortSignal.timeout(120000),redirect:'error',
      });
    },
  };
}
