import { createHash } from 'node:crypto';
import { PassThrough, Readable } from 'node:stream';
import { expect,it,vi } from 'vitest';
import { learningMedia,checkedMediaStream,mediaRange,parseMediaUploadHeader } from './learning-media.mjs';
import { mediaBase,mediaFixture,mediaRevision } from '../src/learning/testFixtures/media.ts';
const token='x'.repeat(43),bytes=Buffer.from('%PDF-1.7');
function setup(){
  const f=mediaFixture();f.receipt.contentSha256=f.intent.contentSha256=f.upload.sourceSha256=createHash('sha256').update(bytes).digest('hex');
  const {headRevision:unused,sourcePreserved:ignored,...context}=f.context;void unused;void ignored;
  let head=mediaRevision,revoked=false,writes=0,earlyStage=false,tamper=false,afterWrite=false;
  const query=vi.fn(async sql=>{
    if(sql.includes('select s.id,s.user_id'))return {rows:[{id:mediaBase.courseId,user_id:mediaBase.courseId}]};
    if(sql==='select hub.authorize_app_command()'&&revoked)throw Object.assign(new Error('private'),{code:'42501'});
    if(sql==='select hub.list_learning_source_heads() as value')return {rows:[{value:[{sourceCourseId:mediaBase.courseId,sourceRevision:head}]}]};
    return {rows:[]};
  });
  const issue=vi.fn(async()=> 'cmh_'+token);
  const fetchImpl=vi.fn(async(url,options)=>{
    const op=options.headers['x-caremetric-media-request']?JSON.parse(Buffer.from(options.headers['x-caremetric-media-request'],'base64url')):JSON.parse(options.body);
    let data;
    if(op.operation==='media.context')data=context;
    if(op.operation==='media.status')data=f.intent;
    if(op.operation==='media.upload'){
      if(!earlyStage)for await(const chunk of options.body)expect(chunk.length).toBeGreaterThan(0);
      data={state:'staged',operationId:f.intent.operationId,assetId:f.intent.assetId,versionId:f.intent.versionId,blockId:f.intent.blockId,
        contentSha256:f.intent.contentSha256,mimeType:f.intent.mimeType,byteSize:f.intent.byteSize,fileName:f.intent.fileName};
    }
    if(op.operation==='media.finish'){writes++;data=f.receipt;f.intent.result=f.receipt;f.intent.state='committed';f.intent.canFinishThisSession=false;if(afterWrite)revoked=true;}
    if(op.operation==='media.read'){
      const range=op.range,start=range?.start??0,end=range?.end??7;
      return new Response(bytes.subarray(start,end+1),{status:range?206:200,headers:{'Content-Type':f.receipt.mimeType,'Content-Length':String(end-start+1),
        'x-caremetric-media-asset':f.receipt.assetId,'x-caremetric-media-sha256':tamper?'0'.repeat(64):f.receipt.contentSha256,'x-caremetric-media-size':'8',
        'Cache-Control':'private, no-store',...(range?{'Content-Range':`bytes ${start}-${end}/8`}:{})}});
    }
    return Response.json({contractVersion:1,product:'carebase',operation:op.operation,generatedAt:new Date().toISOString(),data});
  });
  return {...f,query,issue,fetchImpl,run:learningMedia({pool:{connect:async()=>({query,release:vi.fn()})},issue,fetchImpl}),
    moveHead:()=>{head='f'.repeat(64);},revokeAfterWrite:()=>{afterWrite=true;},restore:()=>{revoked=false;},writes:()=>writes,
    early:()=>{earlyStage=true;},tamper:()=>{tamper=true;},attach:()=>{context.block.mediaAsset={id:f.receipt.assetId,contentSha256:f.receipt.contentSha256,mimeType:f.receipt.mimeType,byteSize:8,fileName:f.receipt.fileName};}};
}
it('binds fixed native origin and exact byte stream to a preserved source; staging does not attach',async()=>{
  const f=setup();await f.run(token,f.upload,{body:Readable.from([bytes]),contentType:'application/pdf',contentLength:'8'});
  expect(f.writes()).toBe(0);expect(f.fetchImpl.mock.calls.every(([url,options])=>url==='https://cmcarebase.com/api/learning-admin/media'&&options.redirect==='error')).toBe(true);
  expect(f.issue.mock.calls.every(([,audience,op])=>audience==='carebase.learning'&&!('courseId'in op))).toBe(true);
  f.moveHead();await expect(f.run(token,f.upload,{body:Readable.from([bytes]),contentType:'application/pdf'})).rejects.toMatchObject({status:409});
});
it('rejects unconsumed, truncated, oversized and wrong-hash uploads',async()=>{
  for(const contents of [Buffer.from('bad'),Buffer.alloc(9),Buffer.from('abcdefgh')]){
    const f=setup();await expect(f.run(token,f.upload,{body:Readable.from([contents]),contentType:'application/pdf'})).rejects.toHaveProperty('status');
  }
  const f=setup();f.early();await expect(f.run(token,f.upload,{body:Readable.from([bytes]),contentType:'application/pdf'})).rejects.toMatchObject({status:503});
});
it('recovers exact committed receipt after Hub revocation and moved source without a second native write',async()=>{
  const f=setup(),op={...mediaBase,operation:'media.finish',operationId:f.intent.operationId};
  f.revokeAfterWrite();await expect(f.run(token,op)).rejects.toMatchObject({status:403});expect(f.writes()).toBe(1);
  f.restore();f.moveHead();expect(await f.run(token,op)).toEqual(f.receipt);expect(f.writes()).toBe(1);
});
it('rejects another session write while retaining status observation',async()=>{
  const f=setup();f.intent.canFinishThisSession=false;
  expect(await f.run(token,{...mediaBase,operation:'media.status',operationId:f.intent.operationId})).toHaveProperty('canFinishThisSession',false);
  await expect(f.run(token,{...mediaBase,operation:'media.finish',operationId:f.intent.operationId})).rejects.toMatchObject({status:409});expect(f.writes()).toBe(0);
});
it('binds native range bytes and integrity headers to authorized context, with a current role recheck',async()=>{
  const f=setup();f.attach();const op={...mediaBase,operation:'media.read',assetId:f.receipt.assetId,range:null};
  const result=await f.run(token,op,{rangeHeader:'bytes=1-3'});const chunks=[];for await(const chunk of result.body)chunks.push(chunk);
  expect(Buffer.concat(chunks).toString()).toBe('PDF');expect(result.range).toEqual({start:1,end:3});
  f.tamper();await expect(f.run(token,op)).rejects.toMatchObject({status:503});
  await expect(f.run(token,{...op,assetId:mediaBase.courseId})).rejects.toMatchObject({status:404});
});
it('normalizes bounded single ranges and rejects multipart and invalid suffixes',()=>{
  expect(mediaRange('bytes=-3',8)).toEqual({start:5,end:7});expect(mediaRange('bytes=3-',8)).toEqual({start:3,end:7});
  for(const input of ['bytes=0-1,4-5','bytes=-0','bytes=8-','bytes=4-2'])expect(()=>mediaRange(input,8)).toThrow();
});
it('rejects ambiguous metadata and cancels stalled incoming streams',async()=>{
  const f=setup();const header=Buffer.from(JSON.stringify(f.upload)).toString('base64url');expect(parseMediaUploadHeader(header)).toEqual(f.upload);
  expect(()=>parseMediaUploadHeader(header+'=')).toThrow();expect(()=>parseMediaUploadHeader(Buffer.from(JSON.stringify({...f.upload,actorId:mediaBase.courseId})).toString('base64url'))).toThrow();
  const body=new PassThrough(),controller=new AbortController(),checked=checkedMediaStream(body,f.upload,controller.signal);
  const consume=(async()=>{for await(const chunk of checked.stream)void chunk;})();body.write(bytes.subarray(0,2));controller.abort();
  await expect(consume).rejects.toThrow();expect(body.destroyed).toBe(true);expect(checked.completed()).toBe(false);
});
