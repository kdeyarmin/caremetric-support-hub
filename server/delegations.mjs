import { Readable } from 'node:stream';
import { digest, token, transaction, withSession, HttpError } from './sms-auth.mjs';
import { parsePortfolioRequest, parsePortfolioEnvelope } from '../supabase/functions/_shared/portfolioProtocol.ts';
import { isOperationalRead } from '../supabase/functions/_shared/operationsProtocol.ts';
import { adminRegistry } from '../supabase/functions/_shared/adminRegistry.ts';
import { advisorsCommandEndpoint, isAdvisorCommand, parseAdvisorCommand, parseAdvisorCommandResult } from '../supabase/functions/_shared/advisorsCommands.ts';
import { parseAppCommand, parsePortfolioCommand, parseCommandEnvelope } from '../supabase/functions/_shared/adminCommandProtocol.ts';
import { tenantLifecycleOperation, tenantLifecycleCapabilities } from '../src/admin/tenantLifecycleProtocol.ts';
import { tenantLifecycle } from './tenant-lifecycle.mjs';
import { callNativeAdmin } from './admin-transport.mjs';
import { publicationId, publicationPart } from '../src/imports/publicationProtocol.ts';
import { publicationRange } from './publication-assets.mjs';
import { nativeLearningOperationSchema } from '../src/learning/receiptProtocol.ts';
import { learningReceipts } from './learning-receipts.mjs';
import { nativeAuthoringOperationSchema } from '../src/learning/authoringProtocol.ts';
import { learningAuthoring } from './learning-authoring.mjs';
import { nativeCreationOperationSchema } from '../src/learning/creationProtocol.ts';
import { learningCreation } from './learning-creation.mjs';
import { nativePackageOperationSchema } from '../src/learning/packageProtocol.ts';
import { learningPackages } from './learning-packages.mjs';
import { nativeDistributionOperationSchema } from '../src/learning/distributionProtocol.ts';
import { learningDistribution } from './learning-distribution.mjs';
import { catalogOperationSchema } from '../src/learning/catalogProtocol.ts';
import { learningCatalog } from './learning-catalog.mjs';
import { generationOperationSchema } from '../src/learning/generationProtocol.ts';
import { learningGeneration } from './learning-generation.mjs';
import { boundedSession } from './bounded-session.mjs';
import { providerOperationSchema } from '../src/learning/providerPolicyProtocol.ts';
import { learningProvider } from './learning-provider.mjs';
import { nativeMediaOperationSchema } from '../src/learning/mediaProtocol.ts';
import { learningMedia } from './learning-media.mjs';
import { partKey, partUploads } from './upload-parts.mjs';
import { supportIdentityOperation } from '../src/support/onboardingProtocol.ts';
import { supportOnboarding } from './support-onboarding.mjs';
import { supportRegistration } from './support-registration.mjs';
import {parseConfigurationOperation} from '../supabase/functions/_shared/operationalConfiguration.ts';
import {operationalConfiguration} from './operational-configuration.mjs';
import {parseTrainingOperation} from '../supabase/functions/_shared/trainingProtocol.ts';
import {trainingAdministration} from './training.mjs';
import { pennsyncNativeOperation } from '../src/imports/pennsyncLearningSource.ts';
import { pennsyncLearningMigration } from './pennsync-learning-migration.mjs';

const prefix = 'cmh_';
export const validDelegation = value => typeof value==='string' && /^cmh_[A-Za-z0-9_-]{43}$/.test(value);
const mediaPath = /^learning\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/(video\.mp4|captions\.vtt|transcript\.txt)$/;
export function validateMedia(path,operation) {
  if (!mediaPath.test(path || '') || !['upload','download','sign'].includes(operation)) throw new HttpError(400,'Invalid media request.');
}
// Each application's own command endpoint, audience and header. CareBase's predates the others and keeps its own route.
const commandTargets={
  carebase:{endpoint:'https://cmcarebase.com/api/platform-admin/command',audience:'carebase.command',header:'Authorization'},
  intel:{endpoint:'https://www.caremetricintel.com/functions/centralAdminCommand',audience:'intel.command',header:'X-CareMetric-Hub-Authorization'},
};
// Breathe and Intel changes need platform.admin.app-commands.v1 (20261117110100_app_command_audiences_contract.sql). Without it the
// capabilities those applications advertise for them are not passed to the browser.
const appCommandCapabilities=new Set([...tenantLifecycleCapabilities,'commands.preview','commands.apply']);
async function authorize(db,audience,payload,{appCommands=false}={}) {
  if (['pennsync','caremetric-emr','caremetric-go'].includes(audience)) throw new HttpError(403,'Application disconnected.');
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
  if (['carebase','breathe','caremetric-emr','pennsync','caremetric-go','intel','advisors'].includes(audience)) {
    if(payload?.operation==='learning.source.snapshot') {
      if(audience!=='pennsync')throw new HttpError(403,'Unsupported learning source.');
      pennsyncNativeOperation.parse(payload);
      await db.query('select hub.authorize_app_command()');
      return (await db.query('select hub.authorize_app_admin() as actor')).rows[0].actor;
    }
    if(payload?.operation==='support.identity.resolve') {
      supportIdentityOperation.parse(payload);
      await db.query('select hub.authorize_app_command()');
      return (await db.query('select hub.authorize_app_admin() as actor')).rows[0].actor;
    }
    // The owner's changes to a Healthcare Advisors consultation request carry command authority, not read authority.
    if (audience==='advisors' && isAdvisorCommand(payload)) {
      parseAdvisorCommand(payload);
      return (await db.query('select hub.authorize_app_command() as actor')).rows[0].actor;
    }
    parsePortfolioRequest({product:audience,...payload});
    // Operational metadata requires the original, bounded SMS assurance window.
    // Keep the read audience: session fields must never grant a command capability.
    if (audience==='carebase' && isOperationalRead(payload.operation)) {
      return (await db.query('select hub.authorize_app_command() as actor')).rows[0].actor;
    }
    return (await db.query('select hub.authorize_app_admin() as actor')).rows[0].actor;
  }
  if (audience==='breathe.command' || audience==='intel.command') {
    if (!appCommands) throw new HttpError(403,'Unsupported authorization audience.');
    if (audience==='breathe.command') tenantLifecycleOperation.parse(payload);
    else parseAppCommand({product:'intel',...payload});
    return (await db.query('select hub.authorize_app_command() as actor')).rows[0].actor;
  }
  if (audience==='carebase.command') {
    if(payload?.domain==='training.v1')parseTrainingOperation(payload);
    else if(payload?.domain==='operations.config.v1')parseConfigurationOperation(payload);
    else parsePortfolioCommand({product:'carebase',...payload});
    return (await db.query('select hub.authorize_app_command() as actor')).rows[0].actor;
  }
  if (audience==='carebase.learning') {
    nativeLearningOperationSchema.or(nativeAuthoringOperationSchema).or(nativeCreationOperationSchema).or(nativePackageOperationSchema).or(nativeDistributionOperationSchema).or(providerOperationSchema).or(nativeMediaOperationSchema).or(catalogOperationSchema).or(generationOperationSchema).parse(payload);
    return (await db.query('select hub.authorize_app_command() as actor')).rows[0].actor;
  }
  if (audience!=='media') throw new HttpError(403,'Unsupported authorization audience.');
  validateMedia(payload.path,payload.operation);
  if (!(await db.query('select hub.authorize_learning_object($1,$2) as allowed',[payload.path,payload.operation])).rows[0].allowed) throw new HttpError(403,'Media access denied.');
  return payload;
}
// mediaParts: two 256 MB lesson videos at once.
export function delegations({pool,storageUrl,provider,fetchImpl=fetch,observer,legacyDistributionOptIn=false,mediaParts=partUploads({budget:2*268435456}),appCommands=false}) {
  const options={appCommands};
  const issue = async (sessionToken,audience,payload,signal) => {
    const authorizeSession=work=>signal?boundedSession(pool,sessionToken,signal,work):withSession(pool,sessionToken,work);
    return authorizeSession(async(db,session) => {
      await authorize(db,audience,payload,options);
      const capability=prefix+token();
      // Return to the dedicated connection role only after relational authorization.
      await db.query('reset role');
      await db.query(`insert into private.app_delegations(token_hash,session_id,audience,payload,expires_at)
        values($1,$2,$3,$4::jsonb,now()+interval '30 seconds')`,[digest(capability),session.id,audience,JSON.stringify(payload)]);
      return capability;
    });
  };
  const media=async(sessionToken,path,operation,body,contentType)=>{
    validateMedia(path,operation);
    const capability=await issue(sessionToken,'media',{path,operation});
    return fetchImpl(`${storageUrl}/functions/v1/app-media`,{
      method:'POST',headers:{Authorization:`Bearer ${capability}`,'Content-Type':contentType || 'application/json'},
      body:body || '{}', ...(body ? {duplex:'half'} : {}), signal:AbortSignal.timeout(120000),redirect:'manual',
    });
  };
  return {
    training:trainingAdministration({pool,issue,fetchImpl}),
    configuration:operationalConfiguration({pool,issue,fetchImpl}),
    learning: learningReceipts({pool,issue,fetchImpl}),
    authoring: learningAuthoring({pool,issue,fetchImpl}),
    creation: learningCreation({pool,issue,fetchImpl}),
    package: learningPackages({pool,issue,fetchImpl}),
    distribution: learningDistribution({pool,issue,fetchImpl,observer,legacyOptInAllowed:legacyDistributionOptIn}),
    provider: learningProvider({pool,issue,fetchImpl}),
    catalog: learningCatalog({pool,issue,fetchImpl}),
    generation: learningGeneration({pool,issue,fetchImpl}),
    courseMedia: learningMedia({pool,issue,fetchImpl}),
    onboarding: supportOnboarding({pool,issue,fetchImpl}),
    registration: supportRegistration({pool,issue,provider,fetchImpl}),
    pennsyncMigration: pennsyncLearningMigration({pool,issue,fetchImpl}),
    tenantLifecycle: tenantLifecycle({pool,issue,fetchImpl,enabled:appCommands}),
    async consume(capability,audience) {
      if (['pennsync','caremetric-emr','caremetric-go'].includes(audience)) throw new HttpError(403,'Application disconnected.');
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
        const authorized=await authorize(db,audience,delegation.payload,options);
        return ['media','publication'].includes(audience) ? authorized : { ...authorized, operation:delegation.payload };
      });
    },
    async admin(sessionToken,input) {
      let request;
      try { request=parsePortfolioRequest(input); } catch { throw new HttpError(400,'Invalid administrator request.'); }
      const entry=adminRegistry[request.product];
      if (!entry.endpoint || !['carebase','breathe','caremetric-emr','pennsync','caremetric-go','intel','advisors'].includes(request.product)) throw new HttpError(503,'This application has not connected its administrator session.','unconfigured');
      const operation=request.operation;
      const capability=await issue(sessionToken,request.product,operation);
      let result;
      try { result=await callNativeAdmin(fetchImpl,entry.endpoint,entry.authorizationHeader ?? 'Authorization',capability,operation,value=>parsePortfolioEnvelope(value,request)); }
      catch (error) {
        // Capabilities and the overview name no record, so a 404 means the application's administration endpoint is not there.
        if (error instanceof HttpError && error.status===404 && ['capabilities','overview'].includes(operation.operation)) throw new HttpError(503,'This application has not connected its administrator session.','unconfigured');
        throw error;
      }
      // A logout, revocation or role change while the native read was in flight
      // must prevent the response from reaching the browser.
      await withSession(pool,sessionToken,db=>authorize(db,request.product,operation,options));
      // Breathe and Intel may advertise access changes before the Hub's database declares them: hide those until it does, and
      // never offer CareBase's command names for an application without a command endpoint of its own.
      if (operation.operation==='capabilities') {
        const offered=name=>!appCommandCapabilities.has(name) || request.product==='carebase'
          || (appCommands && (request.product==='breathe' ? name.startsWith('organizations.lifecycle.') : Object.hasOwn(commandTargets,request.product) && name.startsWith('commands.')));
        return {...result,data:{...result.data,operations:result.data.operations.filter(offered)}};
      }
      return result;
    },
    /** The owner's changes to a Healthcare Advisors consultation request: its status and notes, or deleting it. */
    async advisorsCommand(sessionToken,input) {
      let command;
      try { command=parseAdvisorCommand(input); } catch { throw new HttpError(400,'Review the change and try again.','invalid_request'); }
      const capability=await issue(sessionToken,'advisors',command);
      let result;
      try { result=await callNativeAdmin(fetchImpl,advisorsCommandEndpoint,'X-CareMetric-Hub-Authorization',capability,command,value=>parseAdvisorCommandResult(value,command),true); }
      catch (error) {
        if (error instanceof HttpError && error.status===409) throw new HttpError(409,'This request changed in Advisors since it was loaded. Reload it, then try again.','conflict');
        if (error instanceof HttpError && error.status===404) throw new HttpError(404,'This request no longer exists in Advisors.','notfound');
        throw error;
      }
      // A logout or revocation while Advisors was answering keeps the answer from the browser.
      await withSession(pool,sessionToken,db=>authorize(db,'advisors',command));
      return result;
    },
    async command(sessionToken,input) {
      let request;
      try { request=parseAppCommand(input); } catch { throw new HttpError(400,'Invalid administrator command.','invalid_request'); }
      if (request.product!=='carebase' && !appCommands) throw new HttpError(503,'Access changes for this application are not switched on yet.','unconfigured');
      const target=commandTargets[request.product];
      const capability=await issue(sessionToken,target.audience,request.command);
      const result=await callNativeAdmin(fetchImpl,target.endpoint,target.header,capability,request.command,value=>parseCommandEnvelope(value,request),true);
      // A logout or revocation while the application was answering keeps the before-and-after values from the browser.
      await withSession(pool,sessionToken,db=>authorize(db,target.audience,request.command,options));
      return result;
    },
    media,
    /**
     * One part of a lesson's video, captions or transcript (server/upload-parts.mjs), so a large video does not have to arrive in
     * one request. Every part is authorized for this session and object; once the whole file has arrived it is stored through the
     * Storage function exactly as a single upload is. The answer is {received} while bytes remain, then {result: {uploaded: true}}.
     */
    async mediaPart(sessionToken,path,upload,body,contentType,limit) {
      validateMedia(path,'upload');
      if(upload.total>limit) throw new HttpError(413,'Media is too large.');
      await withSession(pool,sessionToken,db=>authorize(db,'media',{path,operation:'upload'}));
      return mediaParts.receive(partKey(sessionToken,`media:${path}`),upload,body,async file=>{
        const response=await media(sessionToken,path,'upload',Readable.toWeb(file.stream()),contentType);
        await response.body?.cancel();
        if(!response.ok) throw new HttpError(response.status===409?409:503,'Media transfer could not complete.');
        return {uploaded:true};
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
