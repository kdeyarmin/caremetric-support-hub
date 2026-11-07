import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { HttpError } from './sms-auth.mjs';
import { boundedSession } from './bounded-session.mjs';
import { MEDIA_IMPORT_FAILURES, MEDIA_IMPORT_LIMITS, mediaImportListSchema, mediaImportRequestSchema, mediaImportResultSchema,
  mediaImportUrl } from '../src/learning/mediaImportProtocol.ts';
import { validatePublicationMp4Header, validatePublicationText } from '../src/imports/publicationImportPreview.ts';

// Bulk lesson-media import (docs/MEDIA_IMPORT.md). The server fetches each MP4 itself, from an exact
// allowlisted host, and stores it through the same media capability as the single-file uploader.

export const mediaImportFeature='learning.media-import.v1';
/** HeyGen asset hosts. Exact names only; HUB_MEDIA_IMPORT_HOSTS replaces the list. */
export const DEFAULT_MEDIA_IMPORT_HOSTS=Object.freeze(['resource2.heygen.ai','files.heygen.ai','files2.heygen.ai']);
const hostName=/^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
/** Returns null for an unusable setting, so a typo disables imports instead of widening them. */
export function mediaImportHosts(value) {
  if(value===undefined||value===null||!String(value).trim())return DEFAULT_MEDIA_IMPORT_HOSTS;
  const hosts=String(value).split(',').map(host=>host.trim().toLowerCase()).filter(Boolean);
  return hosts.length&&hosts.every(host=>hostName.test(host))?Object.freeze([...new Set(hosts)]):null;
}
const mp4Types=new Set(['video/mp4','application/octet-stream','binary/octet-stream']);
const redirects=new Set([301,302,303,307,308]);
const maxRedirects=3;

class ImportFailure extends Error { constructor(code){super(MEDIA_IMPORT_FAILURES[code]);this.code=code;} }
const failure=code=>new ImportFailure(code);
const refuse=(status,code,message)=>Object.assign(new HttpError(status,'Media import request could not be completed.',code),message?{publicMessage:message}:{});
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');

/** Follow at most three redirects by hand; every hop must be https on an allowlisted host. */
export async function fetchAllowlisted(source,{hosts,fetchImpl,signal}) {
  let current=source;
  for(let hop=0;;hop++) {
    const url=mediaImportUrl(current);
    if(!url||!hosts.includes(url.hostname))throw failure(hop?'redirect_not_allowed':'host_not_allowed');
    let response;
    try{response=await fetchImpl(url.href,{method:'GET',redirect:'manual',cache:'no-store',credentials:'omit',signal,
      headers:{Accept:'video/mp4','Accept-Encoding':'identity'}});}
    catch{throw failure(signal.aborted?'timeout':'source_unavailable');}
    if(redirects.has(response.status)){
      const location=response.headers.get('location');await response.body?.cancel().catch(()=>{});
      if(!location||hop>=maxRedirects)throw failure('redirect_not_allowed');
      try{current=new URL(location,url).href;}catch{throw failure('redirect_not_allowed');}
      continue;
    }
    if(response.status!==200||!response.body){await response.body?.cancel().catch(()=>{});throw failure('source_unavailable');}
    return response;
  }
}

/** Stream the source to a private temporary file, hashing and bounding it on the way. */
export async function spoolSource(response,file,signal) {
  const type=(response.headers.get('content-type')??'').split(';')[0].trim().toLowerCase();
  const encoding=(response.headers.get('content-encoding')??'identity').trim().toLowerCase();
  if(!mp4Types.has(type)||encoding!=='identity'){await response.body.cancel().catch(()=>{});throw failure('invalid_type');}
  const declared=response.headers.get('content-length');
  if(declared!==null&&(!/^\d{1,12}$/.test(declared)||Number(declared)<1)){await response.body.cancel().catch(()=>{});throw failure('source_unavailable');}
  if(declared!==null&&Number(declared)>MEDIA_IMPORT_LIMITS.videoBytes){await response.body.cancel().catch(()=>{});throw failure('too_large');}
  const hash=createHash('sha256');let byteSize=0;
  const bounded=new Transform({transform(chunk,_encoding,done){
    byteSize+=chunk.length;if(byteSize>MEDIA_IMPORT_LIMITS.videoBytes)return done(failure('too_large'));
    hash.update(chunk);done(null,chunk);
  }});
  try{await pipeline(Readable.fromWeb(response.body),bounded,createWriteStream(file,{flags:'wx',mode:0o600}),{signal});}
  catch(error){if(error instanceof ImportFailure)throw error;throw failure(signal.aborted?'timeout':'source_unavailable');}
  if(!byteSize||(declared!==null&&Number(declared)!==byteSize))throw failure('size_mismatch');
  const handle=await open(file,'r');
  try{const prefix=Buffer.alloc(Math.min(65536,byteSize));await handle.read(prefix,0,prefix.length,0);validatePublicationMp4Header(prefix);}
  catch{throw failure('invalid_type');}
  finally{await handle.close();}
  return {sha256:hash.digest('hex'),byteSize};
}

/** Hash a stored copy as it downloads; anything longer than expected is a mismatch, not a truncation. */
async function storedDigest(response,expectedBytes,signal) {
  const reader=response.body.getReader(),hash=createHash('sha256');let size=0;
  try{for(;;){signal.throwIfAborted();const {done,value}=await reader.read();if(done)break;
    size+=value.byteLength;if(size>expectedBytes)return {sha256:null,size};hash.update(value);}}
  finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  return {sha256:hash.digest('hex'),size};
}

export function learningMediaImport({pool,storage,hosts,fetchImpl=fetch,enabled=true,deadlineMs=480000,metadataTimeoutMs=15000}) {
  const sql=(sessionToken,signal,text,values)=>boundedSession(pool,sessionToken,signal,async db=>{
    await db.query('reset role');return (await db.query(text,values)).rows[0].value;
  });
  const stage=async(sessionToken,op,signal)=>{
    const {row}=op,captions=Buffer.from(op.captions,'utf8'),transcript=Buffer.from(op.transcript,'utf8');
    if(captions.length>MEDIA_IMPORT_LIMITS.captionBytes||transcript.length>MEDIA_IMPORT_LIMITS.transcriptBytes)throw refuse(413,'payload_too_large');
    try{validatePublicationText(captions,'captions',Math.ceil(row.durationSeconds*1000)+MEDIA_IMPORT_LIMITS.captionToleranceMs);}
    catch(error){throw refuse(422,'invalid_captions',`${MEDIA_IMPORT_FAILURES.invalid_captions} ${String(error?.message??'').replace(/^assets\.captions:?\s*/,'').slice(0,200)}`.trim());}
    try{validatePublicationText(transcript,'transcript');}
    catch(error){throw refuse(422,'invalid_transcript',`${MEDIA_IMPORT_FAILURES.invalid_transcript} ${String(error?.message??'').replace(/^assets\.transcript:?\s*/,'').slice(0,200)}`.trim());}
    // A source host outside the allowlist is refused before anything is recorded or fetched.
    if(!hosts?.includes(mediaImportUrl(row.mp4Url)?.hostname))throw refuse(422,'host_not_allowed',MEDIA_IMPORT_FAILURES.host_not_allowed);
    const begun=await sql(sessionToken,signal,'select private.learning_media_import_begin($1::jsonb,$2,$3,$4,$5,$6) as value',
      [JSON.stringify(row),sha256(captions),captions.length,sha256(transcript),transcript.length,op.manifestSha256]);
    if(begun.action==='done')return {item:begun.item,replayed:true};
    const itemKey=`${row.product}:${row.sourceRecord}:${row.heygenVideoId}`,lease=begun.lease;
    let directory=null;
    try{
      const response=await fetchAllowlisted(row.mp4Url,{hosts,fetchImpl,signal});
      directory=await mkdtemp(join(tmpdir(),'caremetric-media-import-'));
      const file=join(directory,'video.mp4');
      const source=await spoolSource(response,file,signal);
      const mediaId=await sql(sessionToken,signal,'select private.learning_media_import_prepare($1,$2,$3,$4) as value',[itemKey,lease,source.sha256,source.byteSize]);
      const parts=[
        ['video.mp4','video/mp4',()=>Readable.toWeb(createReadStream(file)),source.sha256,source.byteSize],
        ['captions.vtt','text/vtt',()=>captions,sha256(captions),captions.length],
        ['transcript.txt','text/plain',()=>transcript,sha256(transcript),transcript.length],
      ];
      for(const [name,type,body] of parts){
        let stored;
        try{stored=await storage.upload(sessionToken,`learning/${mediaId}/${name}`,body(),type);}
        catch(error){if(error instanceof HttpError)throw error;throw failure(signal.aborted?'timeout':'storage_unavailable');}
        // A refused upload is not a verdict: the prefix follows the bytes, so an earlier attempt may already have
        // stored them, and app-media reports Storage's 400 "Duplicate" answer as 503. The stored-copy digest below
        // decides: a missing object fails as storage_unavailable, other bytes as hash_mismatch.
        await stored.body?.cancel().catch(()=>{});
      }
      for(const [name,,,expected,bytes] of parts){
        let stored;
        try{stored=await storage.download(sessionToken,`learning/${mediaId}/${name}`);}
        catch(error){if(error instanceof HttpError)throw error;throw failure(signal.aborted?'timeout':'storage_unavailable');}
        if(!stored.ok||!stored.body){await stored.body?.cancel().catch(()=>{});throw failure('storage_unavailable');}
        let digest;
        try{digest=await storedDigest(stored,bytes,signal);}catch{throw failure(signal.aborted?'timeout':'storage_unavailable');}
        if(digest.sha256!==expected||digest.size!==bytes)throw failure('hash_mismatch');
      }
      try{return {item:await sql(sessionToken,signal,'select private.learning_media_import_finish($1,$2) as value',[itemKey,lease]),replayed:false};}
      // 22023: the database's own check found stored objects of other sizes than the verified files.
      catch(error){if(error?.code==='22023')throw failure('hash_mismatch');throw error;}
    }catch(error){
      if(!(error instanceof ImportFailure))throw error;
      // Record the row's failure even when the request deadline caused it; other rows continue.
      const item=await sql(sessionToken,AbortSignal.timeout(metadataTimeoutMs),'select private.learning_media_import_fail($1,$2,$3) as value',[itemKey,lease,error.code]);
      return {item,replayed:false};
    }finally{if(directory)await rm(directory,{recursive:true,force:true});}
  };
  return async(sessionToken,input,requestSignal)=>{
    if(!enabled)throw refuse(503,'unavailable','Bulk media import needs the learning.media-import.v1 database release.');
    let op;try{op=mediaImportRequestSchema.parse(input);}catch{throw refuse(400,'invalid_request');}
    const signal=AbortSignal.any([...(requestSignal?[requestSignal]:[]),AbortSignal.timeout(op.operation==='stage'?deadlineMs:metadataTimeoutMs)]);
    try{
      if(op.operation==='list')return mediaImportListSchema.parse(await sql(sessionToken,signal,'select private.learning_media_import_list() as value',[]));
      if(op.operation==='register')return mediaImportResultSchema.parse(await sql(sessionToken,signal,'select private.learning_media_import_register($1,$2) as value',[op.mediaId,op.reviewed]));
      if(op.operation==='attach')return mediaImportResultSchema.parse(await sql(sessionToken,signal,'select private.learning_media_import_attach($1) as value',[op.mediaId]));
      return mediaImportResultSchema.parse(await stage(sessionToken,op,signal));
    }catch(error){
      if(error instanceof HttpError)throw error;
      const message=['40001','22023','P0002','55000'].includes(error?.code)&&typeof error.message==='string'&&error.message.length<=200?error.message:undefined;
      const code=({42501:'forbidden',28000:'unauthenticated',40001:'conflict',55000:'conflict',22023:'invalid_request',P0002:'notfound'})[error?.code]??'upstream';
      throw refuse(({forbidden:403,unauthenticated:401,conflict:409,invalid_request:400,notfound:404})[code]??503,code,message);
    }
  };
}
