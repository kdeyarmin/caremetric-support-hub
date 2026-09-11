import {randomUUID,timingSafeEqual} from 'node:crypto';
import {Readable} from 'node:stream';
import {z} from 'zod';
import {withSession,transaction,HttpError,digest,token} from './sms-auth.mjs';
import {id,sha,commandSchema,applySchema,assetSchema} from '../src/docstudio/protocol.ts';
import {parseRenderManifest,renderSidecars,RENDER_PROTOCOL} from './docstudio-render-contract.mjs';
import {spoolDocStudioAsset} from './docstudio-assets.mjs';
import {publicationParts,publicationPartRules} from '../src/imports/publicationProtocol.ts';
const storageOrigin='https://xgauehtwksmnoqhgqegm.supabase.co';
const opaque=z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const part=z.enum(['primary','captions','transcript']);
const common={workerId:id,sourceRevision:z.string().regex(/^[a-f0-9]{40}$/)};
const leased={jobId:id,leaseToken:opaque};
const output=z.object({kind:part,sha256:sha,byteLength:z.number().int().min(1).max(268435456),mediaType:z.enum(['video/mp4','text/vtt','text/plain'])}).strict();
const workerRequest=z.discriminatedUnion('operation',[
 z.object({operation:z.literal('heartbeat'),...common,protocol:z.literal(RENDER_PROTOCOL)}).strict(),
 z.object({operation:z.literal('claim'),...common}).strict(),
 z.object({operation:z.literal('renew'),...common,...leased,progress:z.number().int().min(0).max(98)}).strict(),
 z.object({operation:z.literal('fail'),...common,...leased,reason:z.literal('render_failed')}).strict(),
 z.object({operation:z.literal('complete'),...common,...leased,durationMs:z.number().int().min(3000).max(3600000),width:z.literal(1920),height:z.literal(1080),fps:z.literal(30),hasAudio:z.boolean(),artifacts:z.array(output).length(3)}).strict(),
]);
const errors={P4040:[404,'This draft or media is unavailable.'],P4090:[409,'The draft, review, or render changed. Reload and review again.'],P4130:[413,'The file exceeds the configured limit.'],P4290:[429,'DocStudio is at its current capacity. Try again later.'],P5030:[503,'The render worker is unavailable.'],22023:[400,'The DocStudio request is invalid.'],23505:[409,'This operation already exists. Reload its result.'],28000:[401,'Sign in with an SMS code to continue.'],42501:[403,'Content editor permission is required for every affected product.']};
const parse=(schema,value)=>{try{return schema.parse(value);}catch{throw new HttpError(400,'Invalid DocStudio request.');}};

export function docstudio({pool,publications,workerToken,fetchImpl=fetch,onDatabaseError=()=>{}}) {
  async function dbCall(session,name,args=[],worker=false) {
    try {
      const call=async db=>(await db.query(`select private.${name}(${args.map((_,index)=>`$${index+1}`).join(',')}) as result`,args)).rows[0].result;
      return worker?await transaction(pool,call):await withSession(pool,session,async db=>{await db.query('reset role');return call(db);});
    } catch(error) { if(errors[error.code]) throw new HttpError(...errors[error.code]); onDatabaseError(error); throw error; }
  }
  function authorizeWorker(authorization) {
    if(!workerToken || !opaque.safeParse(workerToken).success || typeof authorization!=='string' || !/^Bearer [A-Za-z0-9_-]{43}$/.test(authorization)
      || !timingSafeEqual(Buffer.from(authorization.slice(7)),Buffer.from(workerToken))) throw new HttpError(401,'Worker authorization required.');
  }
  const get=(session,project)=>dbCall(session,'docstudio_project',[parse(id,project)]);
  async function media(session,resource,operation,body,contentType) {
    const capability='cmh_'+token();
    const descriptor=await dbCall(session,'docstudio_issue_media',[digest(capability),JSON.stringify(resource),operation],!!resource.leaseHash);
    const response=await fetchImpl(`${storageOrigin}/functions/v1/docstudio-media`,{method:'POST',headers:{Authorization:`Bearer ${capability}`,'Content-Type':contentType||'application/json'},
      body:body||'{}',redirect:'error',signal:AbortSignal.timeout(120000),...(body?{duplex:'half'}:{})});
    if(!response.ok) {await response.body?.cancel();throw new HttpError(503,'Private DocStudio media transfer was not confirmed. Retry the same file.');}
    if(operation==='download' && (response.headers.get('content-length')!==String(descriptor.byteLength) || response.headers.get('content-type')?.split(';')[0]!==descriptor.contentType)) {
      await response.body?.cancel();throw new HttpError(503,'Private media metadata is invalid.');
    }
    return {descriptor,response};
  }
  let uploads=0;
  async function upload(session,resource,expected,source,contentType) {
    if(contentType?.split(';')[0]!==expected.contentType) throw new HttpError(415,'The media type does not match the saved asset.');
    if(uploads>=2) throw new HttpError(429,'Media transfer capacity reached.');
    uploads++;
    try {
      return await spoolDocStudioAsset(expected,source,async stream=>{
        const {response}=await media(session,resource,'upload',stream(),expected.contentType);
        const result=await response.json();
        if(result?.uploaded!==true || result.sha256!==expected.sha256 || result.byteLength!==expected.byteLength || Object.keys(result).length!==3) throw new HttpError(503,'Stored media could not be verified.');
        return dbCall(session,'docstudio_verify_media',[JSON.stringify(resource)],!!resource.leaseHash);
      });
    } finally {uploads--;}
  }
  return {
    get,
    async read(session,input={cursor:null}) {const request=parse(z.object({cursor:z.object({updatedAt:z.iso.datetime({offset:true}),id}).strict().nullable()}).strict(),input);const result=await dbCall(session,'docstudio_read',[request.cursor?JSON.stringify(request.cursor):null]);return {...result,workerReady:!!workerToken && result.workerReady};},
    preview:(session,input)=>dbCall(session,'docstudio_preview',[randomUUID(),JSON.stringify(parse(commandSchema,input))]),
    apply(session,input) {const request=parse(applySchema,input);return dbCall(session,'docstudio_apply',[request.intentId,request.requestId,request.reviewConfirmed,request.phiConfirmed]);},
    async stageAsset(session,project,input) {return dbCall(session,'docstudio_stage_asset',[parse(id,project),JSON.stringify(parse(assetSchema,input))]);},
    async uploadAsset(session,project,asset,source,contentType) {
      const resource={projectId:parse(id,project),assetId:parse(id,asset)};
      // Issue checks authorization and derives exact metadata without exposing a capability.
      const capability='cmh_'+token();
      const expected=await dbCall(session,'docstudio_issue_media',[digest(capability),JSON.stringify(resource),'upload']);
      return upload(session,resource,expected,source,contentType);
    },
    media:(session,resource)=>media(session,resource,'download'),
    async consumeMedia(capability) {
      if(typeof capability!=='string' || !/^cmh_[A-Za-z0-9_-]{43}$/.test(capability)) throw new HttpError(401,'Media authorization required.');
      return dbCall(null,'docstudio_consume_media',[digest(capability)],true);
    },
    async cleanupExpired() {
      for(let count=0;count<20;count++) {
        const capability='cmh_'+token();const id=await dbCall(null,'docstudio_issue_cleanup',[digest(capability)],true);
        if(!id)break;
        const response=await fetchImpl(`${storageOrigin}/functions/v1/docstudio-media`,{method:'POST',headers:{Authorization:`Bearer ${capability}`,'X-CareMetric-Publication-Mode':'cleanup','Content-Type':'application/json'},body:'{}',redirect:'error',signal:AbortSignal.timeout(30000)});
        if(!response.ok)break;const result=await response.json();if(result?.cleaned!==true || Object.keys(result).length!==1)break;
        await dbCall(null,'docstudio_finish_cleanup',[id],true);
      }
    },
    async worker(authorization,input) {
      authorizeWorker(authorization);const request=parse(workerRequest,input);
      const {operation,workerId,sourceRevision,leaseToken,...body}=request;
      if(leaseToken) body.leaseHash=digest(leaseToken);
      let lease;
      if(operation==='claim') {lease=token();body.leaseHash=digest(lease);}
      const result=await dbCall(null,'docstudio_worker',[operation,workerId,sourceRevision,JSON.stringify(body)],true);
      if(operation==='claim' && result.job) return {job:{...result.job,manifest:parseRenderManifest(result.job.manifest),leaseToken:lease}};
      return result;
    },
    async workerSource(authorization,job,asset,leaseToken) {
      authorizeWorker(authorization);
      return media(null,{jobId:parse(id,job),assetId:parse(id,asset),leaseHash:digest(parse(opaque,leaseToken))},'download');
    },
    async workerOutput(authorization,job,kind,leaseToken,source,headers) {
      authorizeWorker(authorization);
      const resource={jobId:parse(id,job),part:parse(part,kind),leaseHash:digest(parse(opaque,leaseToken))};
      const expected=parse(output,{kind,sha256:headers['x-caremetric-asset-sha256'],byteLength:Number(headers['content-length']),mediaType:headers['content-type']});
      if(kind!=='primary') {
        // Sidecars must equal the exact reviewed scenes, not arbitrary worker text.
        const context=await dbCall(null,'docstudio_worker_manifest',[resource.jobId,resource.leaseHash],true);
        const sidecars=renderSidecars(context); const bytes=Buffer.from(kind==='captions'?sidecars.captions:sidecars.transcript);
        if(digest(bytes)!==expected.sha256 || bytes.length!==expected.byteLength) throw new HttpError(422,'Rendered text does not match the reviewed scenes.');
      }
      await dbCall(null,'docstudio_prepare_output',[resource.jobId,resource.leaseHash,kind,expected.sha256,expected.byteLength,expected.mediaType],true);
      return upload(null,resource,{...expected,contentType:expected.mediaType},source,headers['content-type']);
    },
    async export(session,input) {
      const request=parse(z.object({projectId:id,expectedRevision:z.number().int().min(1).max(100),requestId:id,reviewConfirmed:z.literal(true)}).strict(),input);
      const context=await dbCall(session,'docstudio_stage_export',[request.projectId,request.expectedRevision,request.requestId]);
      let stage=await publications.get(session,context.importId);
      for(const part of publicationParts(stage.manifest)) {
        if(stage.uploadedParts.includes(part))continue;
        const rule=publicationPartRules(stage.manifest,part);
        const source=context.markdown!==null?Readable.from([Buffer.from(context.markdown)]):Readable.fromWeb((await media(session,{jobId:context.jobId,part},'download')).response.body);
        stage=await publications.upload(session,stage.id,part,source,rule.contentType);
      }
      return publications.preview(session,stage.id);
    },
  };
}
