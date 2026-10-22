import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { withSession, HttpError } from './sms-auth.mjs';
import { PACKAGE_MAX_BYTES, PACKAGE_RESPONSE_BYTES, nativePackageOperationSchema, packageOperationSchema, packageContextSchema,
  packageContextViewSchema, packageStatusSchema, packageStageSchema, packageDependenciesSchema, packageResolutionSchema, projectPackageResponse,
  verifyPackageReceipt } from '../src/learning/packageProtocol.ts';

const target='https://cmcarebase.com/api/learning-admin/package';
const fail=(status,code)=>new HttpError(status,'Course package request could not be completed.',code);
async function boundedJson(response,limit,signal) {
  if(!response.body)throw fail(503,'upstream');
  const reader=response.body.getReader(),chunks=[];let size=0;
  const cancel=()=>{void reader.cancel().catch(()=>{});};signal.addEventListener('abort',cancel,{once:true});
  try {
    for(;;){signal.throwIfAborted();const {done,value}=await reader.read();if(done)break;
      size+=value.byteLength;if(size>limit){await reader.cancel();throw fail(503,'upstream');}chunks.push(Buffer.from(value));}
    signal.throwIfAborted();return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks,size)));
  } finally{signal.removeEventListener('abort',cancel);reader.releaseLock();}
}
export function parsePackageUploadHeader(header) {
  if(typeof header!=='string'||header.length>8192||!/^[A-Za-z0-9_-]+$/.test(header))throw fail(400,'invalid_request');
  try {
    const bytes=Buffer.from(header,'base64url');
    if(bytes.toString('base64url')!==header)throw fail(400,'invalid_request');
    const op=packageOperationSchema.parse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));
    if(op.operation!=='upload')throw fail(400,'invalid_request');
    return op;
  } catch {throw fail(400,'invalid_request');}
}
/** Streaming forwarding with backpressure. No complete ZIP is buffered or unpacked by the Hub. */
export function checkedPackageStream(body,operation,signal) {
  let complete=false;
  const stream=Readable.from((async function*(){
    const hash=createHash('sha256');let length=0;
    for await(const chunk of body){
      signal.throwIfAborted();length+=chunk.length;
      if(length>operation.sourceBytes||length>PACKAGE_MAX_BYTES)throw fail(413,'payload_too_large');
      hash.update(chunk);yield chunk;
    }
    signal.throwIfAborted();
    if(length!==operation.sourceBytes||hash.digest('hex')!==operation.sourceSha256)throw fail(409,'artifact_mismatch');
    complete=true;
  })());
  const abort=()=>{
    // The incoming HTTP body can be stalled while the iterator waits for its
    // next chunk. Release that socket as well as the outbound stream.
    body.destroy?.();
    stream.destroy(signal.reason instanceof Error?signal.reason:new Error('Package upload aborted'));
  };
  signal.addEventListener('abort',abort,{once:true});
  stream.once('close',()=>signal.removeEventListener('abort',abort));
  if(signal.aborted)abort();
  // A refused native request can return before consuming any bytes; the caller
  // must not interpret that response as evidence of a completed upload.
  return {stream,completed:()=>complete};
}
export function learningPackages({pool,issue,fetchImpl=fetch}) {
  return async(sessionToken,input,{body,contentLength,signal:requestSignal}={})=>{
    let op;
    try{op=packageOperationSchema.parse(input);}catch{throw fail(400,'invalid_request');}
    if(op.operation==='upload'){
      if(!body)throw fail(400,'invalid_request');
      if(contentLength!==undefined&&(!/^(0|[1-9][0-9]*)$/.test(contentLength)||Number(contentLength)!==op.sourceBytes))throw fail(400,'invalid_request');
    } else if(body)throw fail(400,'invalid_request');
    const signal=AbortSignal.any([...(requestSignal?[requestSignal]:[]),AbortSignal.timeout(120000)]);
    const local=work=>withSession(pool,sessionToken,async db=>{
      signal.throwIfAborted();await db.query('select hub.authorize_app_command()');signal.throwIfAborted();return work(db);
    });
    const head=async db=>{
      const rows=(await db.query('select hub.list_learning_source_heads() as value')).rows[0].value;
      return rows.find(row=>row.sourceCourseId.toLowerCase()===op.courseId)?.sourceRevision??null;
    };
    const requireHead=async expected=>local(async db=>{if(await head(db)!==expected)throw fail(409,'conflict');});
    const native=async(request,uploadBody)=>{
      const metadata=nativePackageOperationSchema.parse(request);
      signal.throwIfAborted();const capability=await issue(sessionToken,'carebase.learning',metadata);signal.throwIfAborted();
      let streamed;
      if(uploadBody)streamed=checkedPackageStream(uploadBody,metadata,signal);
      const headers={Authorization:'Bearer '+capability,'Content-Type':uploadBody?'application/zip':'application/json'};
      if(uploadBody)headers['x-caremetric-package-request']=Buffer.from(JSON.stringify(metadata),'utf8').toString('base64url');
      try{
        const response=await fetchImpl(target,{method:'POST',headers,body:streamed?.stream??JSON.stringify(metadata),
          ...(streamed?{duplex:'half'}:{}),signal,redirect:'error',cache:'no-store'});
        if(!response.ok){
          let code;try{code=(await boundedJson(response,4096,signal))?.error?.code;}catch{/* No native error bodies are exposed. */}
          const status=response.status;
          if(status===401||status===403)throw fail(status,status===401?'unauthenticated':'forbidden');
          if(status===404)throw fail(404,'notfound');
          if(status===409)throw fail(409,'conflict');
          if(status===413)throw fail(413,'payload_too_large');
          if(status===400||status===415||status===422)throw fail(400,'invalid_request');
          throw fail(503,['unconfigured','busy'].includes(code)?code:'upstream');
        }
        const value=projectPackageResponse(await boundedJson(response,PACKAGE_RESPONSE_BYTES,signal),metadata);
        if(streamed&&!streamed.completed()){
          // A committed retry may return its original immutable receipt without
          // reading another ZIP. No unverified new stage can use this exception.
          if(value?.state!=='committed')throw fail(503,'upstream');
        }
        return value;
      } finally {streamed?.stream.destroy();}
    };
    const context=async packageId=>{
      const value=packageContextSchema.parse(await native({operation:'context',versionId:packageId?null:op.versionId,packageId:packageId??null}));
      if(value.courseId!==op.courseId||value.versionId!==op.versionId)throw fail(409,'conflict');
      return value;
    };
    const run=async()=>{
      await local(async()=>{});
      if(op.operation==='context'){
        const value=await context(op.packageId);
        return local(async db=>{const revision=await head(db);return packageContextViewSchema.parse({...value,headRevision:revision,sourcePreserved:revision===value.sourceRevision});});
      }
      if(op.operation==='status'){
        // Status remains observable when the current source has moved. Its
        // immutable receipt never advances the Hub's preserved source head.
        await context(null);
        const value=packageStatusSchema.parse(await native({operation:'status',requestId:op.requestId}));
        if(value&&value.versionId!==op.versionId)throw fail(409,'conflict');
        await local(async()=>{});return value;
      }
      if(op.operation==='dependencies'||op.operation==='resolve'){
        // Pin the draft to this course before reading or changing what it depends on.
        await context(null);
        if(op.operation==='dependencies')return packageDependenciesSchema.parse(await native({operation:'dependencies',versionId:op.versionId}));
        const value=packageResolutionSchema.parse(await native({operation:'resolve',versionId:op.versionId,sourcePackageId:op.sourcePackageId,replacementPackageId:op.replacementPackageId}));
        await local(async()=>{});return value;
      }
      if(op.operation==='finish'){
        const value=await context(null),intent=value.intents.items.find(row=>row.requestId===op.requestId&&row.operationId===op.operationId);
        if(!intent)throw fail(409,'conflict');
        await requireHead(intent.sourceRevision);
        if(!intent.result&&!intent.canFinishThisSession)throw fail(409,'conflict');
        // A fresh native finish is always required, including receipt retries:
        // context visibility across sessions does not authorize replay.
        const result=verifyPackageReceipt(await native({operation:'finish',operationId:op.operationId}),intent);
        await local(async()=>{});return result;
      }
      await requireHead(op.sourceRevision);
      const value=await context(op.operation==='accept'?op.packageId:null);
      if(op.operation==='accept'&&value.package?.standard==='lti_1_3')throw fail(400,'invalid_request');
      // Request IDs can repeat across native sessions. A receipt observed in
      // context cannot make a stale stage eligible; use status or exact finish
      // recovery for an already committed operation instead.
      if(value.sourceRevision!==op.sourceRevision)throw fail(409,'conflict');
      const metadata=op.operation==='upload'
        ? {operation:op.operation,requestId:op.requestId,versionId:op.versionId,sourceRevision:op.sourceRevision,reason:op.reason,standard:op.standard,sourceSha256:op.sourceSha256,sourceBytes:op.sourceBytes}
        : {operation:op.operation,requestId:op.requestId,packageId:op.packageId,sourceRevision:op.sourceRevision,reason:op.reason,entryPoint:op.entryPoint};
      const staged=packageStageSchema.parse(await native(metadata,body));
      if(staged.state==='staged'&&staged.versionId!==op.versionId||staged.state==='committed'&&staged.result.versionId!==op.versionId)throw fail(409,'conflict');
      // Re-enter authority after native byte verification. Nothing here commits
      // a package or grants an acceptance; the user must explicitly finish.
      await requireHead(op.sourceRevision);
      return staged;
    };
    try{return await run();}
    catch(error){
      if(error instanceof HttpError)throw error;
      const code=({42501:'forbidden',28000:'unauthenticated',40001:'conflict',22023:'invalid_request'})[error.code]??'upstream';
      throw fail(code==='forbidden'?403:code==='unauthenticated'?401:code==='conflict'?409:code==='invalid_request'?400:503,code);
    }
  };
}
