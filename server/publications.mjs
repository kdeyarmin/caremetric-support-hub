import { randomUUID } from 'node:crypto';
import { withSession, transaction, HttpError, digest, token } from './sms-auth.mjs';
import {
  parsePublicationStageRequest, parsePublicationStage, publicationId, publicationPart, publicationCommitSchema,
  publicationPartRules, publicationParts, publicationReceiptSchema,
} from '../src/imports/publicationProtocol.ts';
import { previewPublicationImportWithVerifier } from '../src/imports/publicationImportPreview.ts';
import { spoolPublicationAsset, checkedPublicationAsset, publicationRange } from './publication-assets.mjs';
import { partKey, partUploads } from './upload-parts.mjs';
import { directTransferMs, storageDuplicate, storageToken, storedMatches } from './direct-storage.mjs';

const codes={P4040:404,P4090:409,P4130:413,P4290:429,'22023':400,'23505':409,'28000':401,'42501':403};
// Each way of the direct transfer (server/direct-storage.mjs). private.keep_publication_import_open leaves at least 30 minutes, and
// cleanup waits 5 more, so a transfer started after it cannot outlive its import (20261117130000_publication_import_window.sql).
const transferMs=directTransferMs;

/**
 * directStorage (knowledge.publications.direct-storage.v1): keep an import open as its parts arrive, and send a checked file to
 * Storage from this server rather than through the publication-media function, whose request time and CPU limits a large video
 * outgrows. Without it, files stream through that function as before.
 */
// Two 512 MiB videos at once, as with whole-file uploads.
export function publications({pool,delegations,storageUrl,fetchImpl=fetch,parts=partUploads({budget:2*536870912}),directStorage=false}) {
  const direct=typeof directStorage==='function'?directStorage:()=>directStorage;
  async function dbCall(session,name,args=[],required=true) {
    // Names are constants in this module, never caller-selected RPC names.
    try {
      return await withSession(pool,session,async db=>{
        await db.query('reset role');
        const values=args.map((_,i)=>`$${i+1}`).join(',');
        return (await db.query(`select private.${name}(${values}) as result`,args)).rows[0].result;
      },required);
    } catch(error) {
      if(codes[error.code]) throw new HttpError(codes[error.code],'The publication operation could not complete.');
      throw error;
    }
  }
  async function mediaRead(session,kind,args) {
    const statements=kind==='info'
      ? ['select private.publication_media_info($1) as result','select private.publication_public_media_info($1) as result']
      : ["select private.publication_object($1,$2,'download') as result",'select private.publication_public_object($1,$2) as result'];
    try {
      return await withSession(pool,session,async(db,current)=>{
        await db.query('reset role');
        let data;
        try { data=(await db.query(statements[current?0:1],args)).rows[0].result; }
        catch(error) {
          if(session && !current && error.code==='42501') throw new HttpError(401,'Sign in to access this publication.');
          throw error;
        }
        return {data,isPublic:!current};
      },false);
    } catch(error) {
      if(codes[error.code]) throw new HttpError(codes[error.code],'Publication access is unavailable.');
      throw error;
    }
  }
  const get=(session,id)=>dbCall(session,'get_publication_import',[publicationId.parse(id)]).then(parsePublicationStage);
  let uploads=0;
  // At least 30 more minutes for this import, up to four hours after it was staged (private.keep_publication_import_open).
  async function keepOpen(session,id) {
    try { await dbCall(session,'keep_publication_import_open',[id]); }
    catch(error) {
      if(error instanceof HttpError && error.status===409) throw new HttpError(409,'This import has been open too long to finish. Start it again.');
      throw error;
    }
  }
  // A one-time Storage token from the publication-media function: an upload address (sign) or a read address (check).
  async function storageAddress(session,id,part,operation) {
    let response;
    try { response=await delegations.publication(session,id,part,operation); }
    catch(error) {
      if(error instanceof HttpError) throw error;
      throw new HttpError(503,'Publication storage was unavailable. Retry the same file.');
    }
    if(!response.ok) { await response.body?.cancel(); throw new HttpError(503,'Publication storage did not accept the asset.'); }
    const answer=await response.json().catch(()=>null);
    const keys=answer && typeof answer==='object' ? Object.keys(answer).join(',') : '';
    if(operation==='sign' && keys==='stored' && answer.stored===true) return null;
    if(keys!=='token' || typeof answer.token!=='string' || !storageToken.test(answer.token)) throw new HttpError(503,'Publication storage verification failed.');
    return answer.token;
  }
  // The direct transfer: keep the import open, send the checked file to the signed upload address (never overwriting an object),
  // then read the object back and hash it. A retry after a lost answer finds the object stored and goes straight to the check.
  async function storeDirect(session,id,part,asset) {
    await keepOpen(session,id);
    const object=`hub-publications/publications/${id}/${part}`;
    const upload=await storageAddress(session,id,part,'sign');
    if(upload!==null) {
      let response;
      try {
        response=await fetchImpl(`${storageUrl}/storage/v1/object/upload/sign/${object}?token=${encodeURIComponent(upload)}`,{
          method:'PUT',headers:{'Content-Type':asset.contentType,'x-upsert':'false'},body:await asset.blob(),redirect:'error',signal:AbortSignal.timeout(transferMs),
        });
      } catch { throw new HttpError(503,'Publication storage did not confirm the upload. Retry the same file.'); }
      if(response.status===413) { await response.body?.cancel().catch(()=>{}); throw new HttpError(413,'Storage refused a file this large: its upload limit is lower than this file.'); }
      if(!response.ok && !await storageDuplicate(response)) { await response.body?.cancel().catch(()=>{}); throw new HttpError(503,'Publication storage did not accept the asset.'); }
      await response.body?.cancel().catch(()=>{});
    }
    const read=await storageAddress(session,id,part,'check');
    let matches=false;
    try {
      const response=await fetchImpl(`${storageUrl}/storage/v1/object/sign/${object}?token=${encodeURIComponent(read)}`,{
        headers:{'Accept-Encoding':'identity'},redirect:'error',signal:AbortSignal.timeout(transferMs),
      });
      try { matches=await storedMatches(response,asset); }
      finally { await response.body?.cancel().catch(()=>{}); }
    } catch { throw new HttpError(503,'Publication storage could not be read back. Retry the same file.'); }
    if(!matches) throw new HttpError(503,'Publication storage verification failed.');
  }
  // Stores a checked asset in Storage, then records it once Storage confirms the same bytes.
  const store=(session,id,part)=>async asset=>{
    if(direct()) {
      await storeDirect(session,id,part,asset);
      await dbCall(session,'verify_publication_asset',[id,part,asset.sha256,asset.byteLength,asset.bodyText]);
      return get(session,id);
    }
    let response;
    try { response=await delegations.publication(session,id,part,'upload',asset.stream(),asset.contentType); }
    catch(error) {
      if(error instanceof HttpError) throw error;
      throw new HttpError(503,'Publication transfer confirmation was unavailable. Retry the same file.');
    }
    if(!response.ok) throw new HttpError(response.status===409?409:503,'Publication storage did not accept the asset.');
    const stored=await response.json();
    if(!stored || Object.keys(stored).sort().join(',')!=='byteLength,sha256,uploaded' || stored.uploaded!==true || stored.sha256!==asset.sha256 || stored.byteLength!==asset.byteLength) throw new HttpError(503,'Publication storage verification failed.');
    await dbCall(session,'verify_publication_asset',[id,part,asset.sha256,asset.byteLength,asset.bodyText]);
    return get(session,id);
  };
  return {
    access: session=>dbCall(session,'publication_import_access'),
    async stage(session,input) {
      let request; try { request=parsePublicationStageRequest(input); } catch { throw new HttpError(400,'Invalid approved publication manifest.'); }
      const id=randomUUID();
      await dbCall(session,'stage_publication_import',[id,JSON.stringify(request.manifest)]);
      return get(session,id);
    },
    get,
    mediaInfo: (session,id)=>mediaRead(session,'info',[publicationId.parse(id)]).then(result=>result.data),
    async upload(session,id,part,source,contentType) {
      try { publicationPart.parse(part); publicationId.parse(id); } catch { throw new HttpError(400,'Invalid publication asset.'); }
      const stage=await get(session,id);
      if(stage.uploadedParts.includes(part)) return stage;
      const expected=publicationPartRules(stage.manifest,part);
      if(contentType?.split(';')[0]!==expected.contentType) throw new HttpError(415,'Invalid publication asset media type.');
      // Configured deployment limit was enforced before the intent was created.
      // At most two local spools are live per server, regardless of slow clients.
      if(uploads>=2) throw new HttpError(429,'Publication transfer capacity reached.');
      uploads++;
      try { return await spoolPublicationAsset(stage.manifest,part,source,store(session,id,part)); }
      finally { uploads--; }
    },
    /**
     * One part of an asset (server/upload-parts.mjs), so a large video does not have to arrive in one request. Every part is
     * authorized again for this session and import; the last part runs the same checks and storage as upload() over the whole file.
     * The answer is {received} while bytes remain and {result: stage} once the asset is stored.
     */
    async uploadPart(session,id,part,upload,body,contentType) {
      try { publicationPart.parse(part); publicationId.parse(id); } catch { throw new HttpError(400,'Invalid publication asset.'); }
      const stage=await get(session,id);
      if(stage.uploadedParts.includes(part)) return {result:stage};
      const expected=publicationPartRules(stage.manifest,part);
      if(contentType?.split(';')[0]!==expected.contentType) throw new HttpError(415,'Invalid publication asset media type.');
      if(upload.total>expected.maxBytes || (expected.byteLength!==null && upload.total!==expected.byteLength)) throw new HttpError(413,'Publication file exceeds its declared limit.');
      // Each part keeps the import open for 30 more minutes, so a slow upload of a large video does not outlast it.
      if(direct()) await keepOpen(session,id);
      return parts.receive(partKey(session,`publication:${id}:${part}`),upload,body,file=>checkedPublicationAsset(stage.manifest,part,file,store(session,id,part)));
    },
    async preview(session,id) {
      publicationId.parse(id);
      const context=await dbCall(session,'get_publication_import_context',[id]);
      let plan;
      try {
        plan=await previewPublicationImportWithVerifier({manifest:context.manifest,existing:context.existing},async manifest=>{
          // These records can only be written by the byte-checking server after
          // an immutable Storage upload succeeds. HTTP evidence is never used.
          const declared=publicationParts(manifest);
          if(!Array.isArray(context.assets) || context.assets.length!==declared.length || new Set(context.assets.map(asset=>asset.part)).size!==declared.length || context.assets.some(asset=>!declared.includes(asset.part))) throw new Error('Missing verified assets.');
          for(const asset of context.assets) {
            const rules=publicationPartRules(manifest,asset.part);
            if(!asset.verified || asset.sha256!==rules.sha256 || !Number.isSafeInteger(asset.byteLength) || asset.byteLength<1 || asset.byteLength>rules.maxBytes || (rules.byteLength!==null && asset.byteLength!==rules.byteLength)) throw new Error('Unverified asset.');
          }
        });
      } catch { throw new HttpError(422,'Publication package cannot produce a valid catalog revision.'); }
      await dbCall(session,'store_publication_preview',[id,JSON.stringify(plan)]);
      return get(session,id);
    },
    async commit(session,id,input) {
      let request; try { publicationId.parse(id); request=publicationCommitSchema.parse(input); } catch { throw new HttpError(400,'Invalid publication commit.'); }
      // SQL checks exact confirmations on both first commit and replay. Avoid a
      // separate read here: a successful prior receipt must remain retryable.
      return publicationReceiptSchema.parse(await dbCall(session,'commit_publication_import',[id,JSON.stringify(request)]));
    },
    async media(session,id,part,rangeHeader,head=false) {
      try { publicationId.parse(id); publicationPart.parse(part); } catch { throw new HttpError(404,'Publication unavailable.'); }
      const {data:asset,isPublic}=await mediaRead(session,'object',[id,part]);
      const range=publicationRange(rangeHeader,asset.byteLength);
      if(head) return {asset,range,response:null};
      let response;
      if(isPublic) {
        const capability='cmh_'+token();
        await dbCall(null,'issue_publication_public_download',[digest(capability),id,part,range?.header ?? null],false);
        response=await fetchImpl(`${storageUrl}/functions/v1/publication-media`,{
          method:'POST',headers:{Authorization:`Bearer ${capability}`,'X-CareMetric-Publication-Mode':'public','Content-Type':'application/json'},
          body:'{}',redirect:'error',signal:AbortSignal.timeout(120000),
        });
      } else response=await delegations.publication(session,id,part,'download',undefined,undefined,range?.header ?? null);
      if(!response.ok || response.status!==(range?206:200)) throw new HttpError(503,'Publication media is unavailable.');
      const length=range?.length ?? asset.byteLength;
      if(response.headers.get('content-type')?.split(';')[0]!==asset.contentType || response.headers.get('content-length')!==String(length)
        || (range && response.headers.get('content-range')!==`bytes ${range.start}-${range.end}/${asset.byteLength}`)) {
        await response.body?.cancel(); throw new HttpError(503,'Publication media response is invalid.');
      }
      return {asset,range,response};
    },
    async consumePublicDownload(capability) {
      if(typeof capability!=='string' || !/^cmh_[A-Za-z0-9_-]{43}$/.test(capability)) throw new HttpError(401,'Invalid public download authorization.');
      return dbCall(null,'consume_publication_public_download',[digest(capability)],false);
    },
    async consumeCleanup(capability) {
      if(typeof capability!=='string' || !/^cmh_[A-Za-z0-9_-]{43}$/.test(capability)) throw new HttpError(401,'Invalid cleanup authorization.');
      return transaction(pool,async db=>(await db.query('select private.consume_publication_cleanup($1) as result',[digest(capability)])).rows[0].result);
    },
    async cleanupExpired() {
      // Bounded maintenance; no request controls a path, age, limit or bucket.
      for(let i=0;i<20;i++) {
        const capability='cmh_'+token();
        const id=await transaction(pool,async db=>(await db.query('select private.issue_publication_cleanup($1) as result',[digest(capability)])).rows[0].result);
        if(!id) break;
        const response=await fetchImpl(`${storageUrl}/functions/v1/publication-media`,{method:'POST',headers:{Authorization:`Bearer ${capability}`,'X-CareMetric-Publication-Mode':'cleanup','Content-Type':'application/json'},body:'{}',redirect:'error',signal:AbortSignal.timeout(30000)});
        if(!response.ok) break;
        const result=await response.json();
        if(result?.cleaned!==true || Object.keys(result).length!==1) break;
        await transaction(pool,db=>db.query('select private.finish_publication_cleanup($1)',[id]));
      }
    },
  };
}
