import { describe,it,expect,vi } from 'vitest';
import { createHash,randomUUID } from 'node:crypto';
import { createPublicationMediaHandler } from '../supabase/functions/publication-media/handler.ts';
const capabilityToken='Bearer cmh_'+'a'.repeat(43);
const bytes=new TextEncoder().encode('Workspace guide');
const base={path:`publications/${randomUUID()}/primary`,operation:'upload',contentType:'text/markdown',sha256:createHash('sha256').update(bytes).digest('hex'),byteLength:bytes.length,maxBytes:2097152,range:null};
const request=(headers={},body=bytes)=>new Request('https://native.test/functions/v1/publication-media',{method:'POST',headers:{Authorization:capabilityToken,'Content-Type':'text/markdown',...headers},body});
describe('publication Edge transport',()=>{
  it.each([{Origin:'https://hub.test'},{Cookie:'session=fake'},{Authorization:'Bearer forged'},{Authorization:'Bearer '+ 'x'.repeat(50)}])('rejects browser or forged requests before storage (%o)',async headers=>{
    const fetcher=vi.fn(); const handler=createPublicationMediaHandler({serviceKey:'synthetic-only',fetchImpl:fetcher});
    expect((await handler(request(headers))).status).toBeGreaterThanOrEqual(400); expect(fetcher).not.toHaveBeenCalled();
  });
  it('consumes a fixed live Hub capability, streams immutable bytes and returns only verification fields',async()=>{
    const calls=[];
    const handler=createPublicationMediaHandler({serviceKey:'synthetic-only',fetchImpl:async(url,options)=>{
      calls.push(url);
      if(calls.length===1) {
        expect(url).toBe('https://support-hub-web-production.up.railway.app/api/internal/publications/authorize');
        expect(options.body).toBe('{}'); expect(options.headers.Authorization).toBe(capabilityToken);
        return Response.json(base);
      }
      expect(url).toBe(`https://xgauehtwksmnoqhgqegm.supabase.co/storage/v1/object/hub-publications/${base.path}`);
      expect(options.headers['x-upsert']).toBe('false'); expect(options.redirect).toBe('error');
      expect(new Uint8Array(await new Response(options.body).arrayBuffer())).toEqual(bytes);
      return new Response('{}',{status:200});
    }});
    const response=await handler(request()); expect(response.status).toBe(200);
    expect(await response.json()).toEqual({uploaded:true,sha256:base.sha256,byteLength:bytes.length}); expect(calls).toHaveLength(2);
  });
  it.each([
    {...base,path:'publications/../../other/private'}, {...base,url:'https://caller.invalid'}, {...base,operation:'sign'},
    {...base,maxBytes:536870913}, {...base,range:'bytes=0-1'}, {...base,contentType:'text/html'},
  ])('fails closed for an invalid capability %#',async capability=>{
    const fetcher=vi.fn(async()=>Response.json(capability));
    const handler=createPublicationMediaHandler({serviceKey:'synthetic-only',fetchImpl:fetcher});
    expect((await handler(request())).status).toBeGreaterThanOrEqual(400); expect(fetcher).toHaveBeenCalledOnce();
  });
  it('cannot attest bytes with a mismatched digest or a partial upstream upload',async()=>{
    for(const partial of [false,true]) {
      let calls=0;
      const handler=createPublicationMediaHandler({serviceKey:'synthetic-only',fetchImpl:async(_url,options)=>{
        if(++calls===1) return Response.json({...base,sha256:partial?base.sha256:'f'.repeat(64)});
        if(!partial) await new Response(options.body).arrayBuffer();
        return new Response('{}');
      }});
      expect((await handler(request())).status).toBe(503);
    }
  });
  it('requires the upstream range and length to exactly match the authorized range',async()=>{
    for(const malformed of [false,true]) {
      let calls=0;
      const handler=createPublicationMediaHandler({serviceKey:'synthetic-only',fetchImpl:async(_url,options)=>{
        if(++calls===1) return Response.json({...base,operation:'download',range:'bytes=1-3'});
        expect(options.headers.Range).toBe('bytes=1-3');
        return new Response(bytes.slice(1,4),{status:206,headers:{'Content-Type':'text/markdown','Content-Length':'3','Content-Range':malformed?'bytes 0-2/15':`bytes 1-3/${bytes.length}`}});
      }});
      const response=await handler(request()); expect(response.status).toBe(malformed?503:206);
      if(!malformed) expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes.slice(1,4));
    }
  });
  it('cleans only one fixed expired import prefix with at most its three allowed parts',async()=>{
    let calls=0;
    const paths=[base.path,base.path.replace('/primary','/captions')];
    const handler=createPublicationMediaHandler({serviceKey:'synthetic-only',fetchImpl:async(url,options)=>{
      if(++calls===1) { expect(url).toContain('/publications/cleanup/authorize'); return Response.json({operation:'cleanup',paths}); }
      expect(url).toBe('https://xgauehtwksmnoqhgqegm.supabase.co/storage/v1/object/hub-publications');
      expect(options.method).toBe('DELETE'); expect(JSON.parse(options.body)).toEqual({prefixes:paths});
      return new Response('[]');
    }});
    expect(await (await handler(request({'X-CareMetric-Publication-Mode':'cleanup'}))).json()).toEqual({cleaned:true});
    const invalid=createPublicationMediaHandler({serviceKey:'synthetic-only',fetchImpl:async()=>Response.json({operation:'cleanup',paths:[base.path,`publications/${randomUUID()}/primary`]})});
    expect((await invalid(request({'X-CareMetric-Publication-Mode':'cleanup'}))).status).toBe(403);
  });
});
