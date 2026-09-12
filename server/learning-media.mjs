import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { HttpError } from './sms-auth.mjs';
import { boundedSession } from './bounded-session.mjs';
import { MEDIA_METADATA_LIMIT, parseHubMediaOperation, nativeMediaOperation, projectMediaEnvelope,
  projectMediaContextView, verifyMediaReceipt } from '../src/learning/mediaProtocol.ts';

const target='https://cmcarebase.com/api/learning-admin/media';
const fail=(status,code)=>new HttpError(status,'Course media request could not be completed.',code);
export function parseMediaUploadHeader(header) {
  try {
    if(typeof header!=='string'||header.length>8192||!/^[A-Za-z0-9_-]+$/.test(header))throw Error();
    const bytes=Buffer.from(header,'base64url');if(bytes.toString('base64url')!==header)throw Error();
    const op=parseHubMediaOperation(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));
    if(op.operation!=='media.upload')throw Error();return op;
  }catch{throw fail(400,'invalid_request');}
}
export function checkedMediaStream(body,operation,signal) {
  let complete=false;
  const stream=Readable.from((async function*(){
    const hash=createHash('sha256');let length=0;
    for await(const chunk of body){signal.throwIfAborted();length+=chunk.length;
      if(length>operation.sourceBytes)throw fail(413,'payload_too_large');hash.update(chunk);yield chunk;}
    signal.throwIfAborted();
    if(length!==operation.sourceBytes||hash.digest('hex')!==operation.sourceSha256)throw fail(409,'artifact_mismatch');
    complete=true;
  })());
  const abort=()=>{body.destroy?.();stream.destroy(signal.reason instanceof Error?signal.reason:new Error('Media transfer aborted'));};
  signal.addEventListener('abort',abort,{once:true});stream.once('close',()=>signal.removeEventListener('abort',abort));if(signal.aborted)abort();
  return {stream,completed:()=>complete};
}
async function boundedJson(response,signal,maximum=MEDIA_METADATA_LIMIT) {
  if(!response.body)throw fail(503,'upstream');
  const reader=response.body.getReader(),chunks=[];let size=0;
  const cancel=()=>{void reader.cancel().catch(()=>{});};signal.addEventListener('abort',cancel,{once:true});
  try{for(;;){signal.throwIfAborted();const {done,value}=await reader.read();if(done)break;
    size+=value.byteLength;if(size>maximum){await reader.cancel();throw fail(503,'upstream');}chunks.push(Buffer.from(value));}
    signal.throwIfAborted();return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks,size)));
  }finally{signal.removeEventListener('abort',cancel);reader.releaseLock();}
}
/** Only one byte range, normalized against the current authorized immutable asset. */
export function mediaRange(value,size) {
  if(value===undefined||value===null)return null;
  if(typeof value!=='string')throw fail(416,'invalid_range');
  const match=/^bytes=(\d*)-(\d*)$/.exec(value);if(!match||!match[1]&&!match[2])throw fail(416,'invalid_range');
  let start,end;
  if(!match[1]){const suffix=Number(match[2]);if(!Number.isSafeInteger(suffix)||suffix<1)throw fail(416,'invalid_range');start=Math.max(0,size-suffix);end=size-1;}
  else{start=Number(match[1]);end=match[2]?Math.min(Number(match[2]),size-1):size-1;}
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>=size||end<start)throw fail(416,'invalid_range');
  return {start,end};
}
export function learningMedia({pool,issue,fetchImpl=fetch,timeoutMs=120000,metadataTimeoutMs=12000}) {
  return async(sessionToken,input,{body,contentType,contentLength,rangeHeader,headOnly=false,signal:requestSignal}={})=>{
    let op;try{op=parseHubMediaOperation(input);}catch{throw fail(400,'invalid_request');}
    if(op.operation==='media.upload'){
      if(!body||contentType!==op.mimeType)throw fail(400,'invalid_request');
      if(contentLength!==undefined&&(!/^(0|[1-9][0-9]*)$/.test(contentLength)||Number(contentLength)!==op.sourceBytes))throw fail(400,'invalid_request');
    }else if(body)throw fail(400,'invalid_request');
    const signal=AbortSignal.any([...(requestSignal?[requestSignal]:[]),AbortSignal.timeout(['media.upload','media.read'].includes(op.operation)?timeoutMs:metadataTimeoutMs)]);
    const local=work=>boundedSession(pool,sessionToken,signal,async db=>{
      signal.throwIfAborted();await db.query('select hub.authorize_app_command()');signal.throwIfAborted();return work(db);
    });
    const head=async db=>{
      const rows=(await db.query('select hub.list_learning_source_heads() as value')).rows[0].value;
      return rows.find(row=>row.sourceCourseId.toLowerCase()===op.courseId.toLowerCase())?.sourceRevision??null;
    };
    const requireHead=async expected=>local(async db=>{if(await head(db)!==expected)throw fail(409,'conflict');});
    const native=async(metadata,uploadBody)=>{
      signal.throwIfAborted();const capability=await issue(sessionToken,'carebase.learning',metadata,signal);signal.throwIfAborted();
      const streamed=uploadBody?checkedMediaStream(uploadBody,metadata,signal):null;
      const headers={Authorization:'Bearer '+capability,'Content-Type':streamed?metadata.mimeType:'application/json'};
      if(streamed)headers['x-caremetric-media-request']=Buffer.from(JSON.stringify(metadata),'utf8').toString('base64url');
      try{
        const response=await fetchImpl(target,{method:'POST',headers,body:streamed?.stream??JSON.stringify(metadata),
          ...(streamed?{duplex:'half'}:{}),signal,redirect:'error',cache:'no-store'});
        if(!response.ok){await response.body?.cancel();const status=response.status;
          throw fail([400,401,403,404,409,413,416].includes(status)?status:503,
            ({400:'invalid_request',401:'unauthenticated',403:'forbidden',404:'notfound',409:'conflict',413:'payload_too_large',416:'invalid_range'})[status]??'upstream');}
        if(metadata.operation==='media.read')return response;
        const result=projectMediaEnvelope(await boundedJson(response,signal),metadata);
        if(streamed&&!streamed.completed()&&result?.state!=='committed')throw fail(503,'upstream');
        return result;
      }finally{streamed?.stream.destroy();}
    };
    const context=async()=>{
      const value=await native({operation:'media.context',versionId:op.versionId,blockId:op.blockId});
      if(value.courseId!==op.courseId)throw fail(409,'conflict');return value;
    };
    const run=async()=>{
      await local(async()=>{});
      if(op.operation==='media.context'){const current=await context();return local(async db=>{
        const headRevision=await head(db);return projectMediaContextView({...current,headRevision,sourcePreserved:headRevision===current.sourceRevision},op);});}
      if(op.operation==='media.status'||op.operation==='media.finish'){
        // Exact operation IDs disambiguate request IDs reused in another session.
        const intent=await native({operation:'media.status',operationId:op.operationId});
        if(intent&&(intent.versionId!==op.versionId||intent.blockId!==op.blockId))throw fail(409,'conflict');
        if(op.operation==='media.status'){await local(async()=>{});return intent;}
        if(!intent)throw fail(404,'notfound');
        // A receipt is immutable observation, not permission to repeat attachment.
        if(intent.result){await local(async()=>{});return intent.result;}
        const current=await context();
        if(!intent.canFinishThisSession||intent.sourceRevision!==current.sourceRevision||current.block.generationState==='pending'
          ||(current.block.type==='pdf')!==(intent.mimeType==='application/pdf'))throw fail(409,'conflict');
        await requireHead(intent.sourceRevision);
        const result=verifyMediaReceipt(await native({operation:'media.finish',operationId:op.operationId}),intent);
        await local(async()=>{});return result;
      }
      const current=await context();
      if(op.operation==='media.upload'){
        if(current.sourceRevision!==op.sourceRevision||current.block.generationState==='pending'
          ||(current.block.type==='pdf')!==(op.mimeType==='application/pdf'))throw fail(409,'conflict');
        await requireHead(op.sourceRevision);
        const result=await native(nativeMediaOperation(op),body);
        // Upload does not attach media. Re-check the preserved source and actor.
        await requireHead(op.sourceRevision);return result;
      }
      const asset=current.block.mediaAsset;
      if(!asset||asset.id!==op.assetId)throw fail(404,'notfound');
      const range=rangeHeader!==undefined?mediaRange(rangeHeader,asset.byteSize):op.range;
      if(range&&(range.start>=asset.byteSize||range.end!==null&&range.end>=asset.byteSize))throw fail(416,'invalid_range');
      const normalized=range?{start:range.start,end:range.end??asset.byteSize-1}:null;
      const length=normalized?normalized.end-normalized.start+1:asset.byteSize;
      if(headOnly){await local(async()=>{});return {asset,range:normalized,length,body:null};}
      const response=await native({operation:'media.read',versionId:op.versionId,blockId:op.blockId,assetId:op.assetId,range:normalized});
      let accepted=false;
      try{
        const expected={'content-type':asset.mimeType,'content-length':String(length),'x-caremetric-media-asset':asset.id,
          'x-caremetric-media-sha256':asset.contentSha256,'x-caremetric-media-size':String(asset.byteSize),'cache-control':'private, no-store'};
        if(response.status!==(normalized?206:200)||!response.body)throw fail(503,'upstream');
        for(const [name,value]of Object.entries(expected))if(response.headers.get(name)!==value)throw fail(503,'upstream');
        if(response.headers.get('content-range')!==(normalized?`bytes ${normalized.start}-${normalized.end}/${asset.byteSize}`:null))throw fail(503,'upstream');
        await local(async()=>{});
        const reader=response.body.getReader();const cancel=()=>{void reader.cancel().catch(()=>{});};signal.addEventListener('abort',cancel,{once:true});
        const output=Readable.from((async function*(){let count=0;try{for(;;){signal.throwIfAborted();const {done,value}=await reader.read();if(done)break;
          count+=value.byteLength;if(count>length)throw fail(503,'upstream');yield value;}signal.throwIfAborted();if(count!==length)throw fail(503,'upstream');}
          finally{signal.removeEventListener('abort',cancel);await reader.cancel().catch(()=>{});reader.releaseLock();}})());
        output.once('close',cancel);accepted=true;return {asset,range:normalized,length,body:output};
      }finally{if(!accepted)await response.body?.cancel();}
    };
    try{return await run();}catch(error){
      if(error instanceof HttpError)throw error;
      const code=({42501:'forbidden',28000:'unauthenticated',40001:'conflict',22023:'invalid_request'})[error.code]??'upstream';
      throw fail(({forbidden:403,unauthenticated:401,conflict:409,invalid_request:400})[code]??503,code);
    }
  };
}
