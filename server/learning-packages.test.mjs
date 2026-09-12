import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { PassThrough, Readable } from 'node:stream';
import { createServer, request } from 'node:http';
import { checkedPackageStream, parsePackageUploadHeader } from './learning-packages.mjs';
const uuid='c2000000-0000-4000-8000-000000000001';
const bytes=Buffer.from('synthetic archive bytes only');
const sha=value=>createHash('sha256').update(value).digest('hex');
const operation={operation:'upload',courseId:uuid,versionId:uuid,requestId:uuid,sourceRevision:'a'.repeat(64),reason:'Reviewed archive',standard:'xapi',sourceSha256:sha(bytes),sourceBytes:bytes.length};
describe('package streaming boundary',()=>{
  it('parses canonical closed UTF8 metadata only',()=>{
    const header=Buffer.from(JSON.stringify(operation)).toString('base64url');
    expect(parsePackageUploadHeader(header)).toEqual(operation);
    for(const value of [header+'=',header+', '+header,'not-json',Buffer.from(JSON.stringify({...operation,url:'https://evil.test'})).toString('base64url'),Buffer.from([255,254]).toString('base64url')])expect(()=>parsePackageUploadHeader(value)).toThrow();
  });
  it('forwards exact chunks with backpressure and only marks complete after the digest',async()=>{
    const {stream,completed}=checkedPackageStream(Readable.from([bytes.subarray(0,5),bytes.subarray(5)]),operation,new AbortController().signal);
    expect(completed()).toBe(false);const chunks=[];for await(const chunk of stream)chunks.push(chunk);
    expect(Buffer.concat(chunks)).toEqual(bytes);expect(completed()).toBe(true);
  });
  it.each([{sourceBytes:bytes.length-1},{sourceBytes:bytes.length+1},{sourceSha256:'b'.repeat(64)}])('rejects mismatched length or hash %j',async change=>{
    const {stream,completed}=checkedPackageStream(Readable.from([bytes]),{...operation,...change},new AbortController().signal);
    await expect(async()=>{for await(const chunk of stream)void chunk;}).rejects.toThrow();
    expect(completed()).toBe(false);
  });
  it('aborts an upload without reporting a completed stage',async()=>{
    const controller=new AbortController();controller.abort();
    const {stream,completed}=checkedPackageStream(Readable.from([bytes]),operation,controller.signal);
    await expect(async()=>{for await(const chunk of stream)void chunk;}).rejects.toThrow();
    expect(completed()).toBe(false);
  });
  it('releases an actual stalled HTTP input when its upload deadline expires',async()=>{
    let finish;const finished=new Promise(resolve=>{finish=resolve;});
    const server=createServer(async(req,res)=>{
      const checked=checkedPackageStream(req,operation,AbortSignal.timeout(50));
      try{for await(const chunk of checked.stream)void chunk;finish(new Error('Unexpected completion'));}
      catch{finish({destroyed:req.destroyed,completed:checked.completed()});}
      finally{res.destroy();}
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const client=request({hostname:'127.0.0.1',port:server.address().port,method:'POST',headers:{'content-length':bytes.length}});
    client.on('error',()=>{});client.write(bytes.subarray(0,2)); // Deliberately never ends the request.
    try{expect(await finished).toEqual({destroyed:true,completed:false});}
    finally{client.destroy();await new Promise(resolve=>server.close(resolve));}
  });
  it('releases a stalled stream immediately on client cancellation',async()=>{
    const body=new PassThrough(),controller=new AbortController();
    const checked=checkedPackageStream(body,operation,controller.signal);
    const reading=(async()=>{for await(const chunk of checked.stream)void chunk;})();
    controller.abort();await expect(reading).rejects.toThrow();expect(body.destroyed).toBe(true);expect(checked.completed()).toBe(false);
  });
});
