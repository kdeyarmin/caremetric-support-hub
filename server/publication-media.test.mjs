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
        expect(options.redirect).toBe('manual');
        return Response.json(base);
      }
      expect(url).toBe(`https://xgauehtwksmnoqhgqegm.supabase.co/storage/v1/object/hub-publications/${base.path}`);
      expect(options.headers['x-upsert']).toBe('false'); expect(options.redirect).toBe('manual');
      expect(new Uint8Array(await new Response(options.body).arrayBuffer())).toEqual(bytes);
      return new Response('{}',{status:200});
    }});
    const response=await handler(request()); expect(response.status).toBe(200);
    expect(await response.json()).toEqual({uploaded:true,sha256:base.sha256,byteLength:bytes.length}); expect(calls).toHaveLength(2);
  });
  it.each([
    {...base,path:'publications/../../other/private'}, {...base,url:'https://caller.invalid'}, {...base,operation:'delete'},
    {...base,operation:'sign',range:'bytes=0-1'}, {...base,operation:'check',range:'bytes=0-1'},
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
  it.each([409,'legacy','code'])('reconciles a duplicate using exact immutable stored bytes (%s)',async duplicate=>{
    const calls=[];
    const handler=createPublicationMediaHandler({serviceKey:'synthetic-only',fetchImpl:async(url,options)=>{
      calls.push(url);
      if(calls.length===1) return Response.json(base);
      if(calls.length===2) return duplicate===409?new Response('{}',{status:409}):Response.json(duplicate==='legacy'
        ?{statusCode:'409',error:'Duplicate',message:'The resource already exists'}:{code:'ResourceAlreadyExists',message:'exists'},{status:400});
      expect(url).toBe(`https://xgauehtwksmnoqhgqegm.supabase.co/storage/v1/object/authenticated/hub-publications/${base.path}`);
      expect(options.method).toBeUndefined(); expect(options.headers.Authorization).toBe('Bearer synthetic-only');
      expect(options.signal).toBeInstanceOf(AbortSignal); expect(options.redirect).toBe('manual');
      return new Response(bytes,{headers:{'Content-Type':'text/markdown','Content-Length':String(bytes.length)}});
    }});
    const response=await handler(request()); expect(response.status).toBe(200);
    expect(await response.json()).toEqual({uploaded:true,sha256:base.sha256,byteLength:bytes.length}); expect(calls).toHaveLength(3);
  });
  it.each(['digest','length','oversized','truncated','type','missing','error','overflow'])('never accepts conflicting existing bytes (%s)',async fault=>{
    let calls=0;
    const handler=createPublicationMediaHandler({serviceKey:'synthetic-only',fetchImpl:async()=>{
      if(++calls===1) return Response.json(base);
      if(calls===2) return new Response('{}',{status:409});
      const stored=fault==='digest'?new Uint8Array(bytes.length):fault==='truncated'?bytes.slice(1):fault==='overflow'?new Uint8Array(bytes.length+1):bytes;
      const headers={'Content-Type':fault==='type'?'text/html':'text/markdown'};
      if(fault!=='missing') headers['Content-Length']=String(fault==='length'?bytes.length+1:fault==='oversized'?2097153:bytes.length);
      return new Response(stored,{status:fault==='error'?404:200,headers});
    }});
    expect((await handler(request())).status).toBe(503);
  });
  it.each([400,401,403,413,500])('does not reconcile unrelated storage errors (%s)',async status=>{
    let calls=0;
    const handler=createPublicationMediaHandler({serviceKey:'synthetic-only',fetchImpl:async()=>{
      if(++calls===1) return Response.json(base);
      return Response.json({code:'AccessDenied',message:'Asset Already Exists'},{status});
    }});
    expect((await handler(request())).status).toBe(503); expect(calls).toBe(2);
  });
  it('rejects an oversized compatibility error body before attempting a reconciliation read',async()=>{
    let calls=0;
    const handler=createPublicationMediaHandler({serviceKey:'synthetic-only',fetchImpl:async()=>{
      if(++calls===1) return Response.json(base);
      return Response.json({code:'ResourceAlreadyExists',message:'x'.repeat(9000)},{status:400});
    }});
    expect((await handler(request())).status).toBe(503); expect(calls).toBe(2);
  });
  it.each([{code:['ResourceAlreadyExists']},{code:'AccessDenied',error:'Duplicate',message:'The resource already exists',statusCode:409}])('does not coerce or override conflicting duplicate error codes (%o)',async error=>{
    let calls=0;
    const handler=createPublicationMediaHandler({serviceKey:'synthetic-only',fetchImpl:async()=>{
      if(++calls===1) return Response.json(base);
      return Response.json(error,{status:400});
    }});
    expect((await handler(request())).status).toBe(503); expect(calls).toBe(2);
  });
  it.each(['sign','check'])('%s returns only a one-time token for the exact authorized object, never overwriting it',async operation=>{
    const calls=[]; const token='eyJhbGciOiJIUzI1NiJ9.eyJ1cmwiOiJ4In0.c2lnbmVk';
    const route=operation==='sign'?'upload/sign':'sign';
    const handler=createPublicationMediaHandler({serviceKey:'synthetic-only',fetchImpl:async(url,options)=>{
      calls.push(url);
      if(calls.length===1) return Response.json({...base,operation});
      expect(url).toBe(`https://xgauehtwksmnoqhgqegm.supabase.co/storage/v1/object/${route}/hub-publications/${base.path}`);
      expect(options.method).toBe('POST'); expect(options.headers.Authorization).toBe('Bearer synthetic-only');
      expect(options.headers['x-upsert']).toBeUndefined(); expect(options.redirect).toBe('manual');
      expect(JSON.parse(options.body)).toEqual(operation==='sign'?{}:{expiresIn:600});
      const address=`/object/${route}/hub-publications/${base.path}?token=${token}`;
      return Response.json(operation==='sign'?{url:address}:{signedURL:address});
    }});
    const response=await handler(request({'Content-Type':'application/json'},'{}')); expect(response.status).toBe(200);
    expect(await response.json()).toEqual({token}); expect(calls).toHaveLength(2);
  });
  it.each([
    ['another object',{url:`/object/upload/sign/hub-publications/publications/${randomUUID()}/primary?token=eyJhbGciOiJIUzI1NiJ9.e30.c2ln`}],
    ['another bucket',{url:'/object/upload/sign/hub-learning/x?token=eyJhbGciOiJIUzI1NiJ9.e30.c2ln'}],
    ['an absolute address',{url:'https://attacker.invalid/object/upload/sign/hub-publications/x?token=eyJhbGciOiJIUzI1NiJ9.e30.c2ln'}],
    ['an unsafe token',{token:'<script>alert(1)</script>'}],
    ['no address',{}],
  ])('refuses a signing answer for %s',async(_name,answer)=>{
    let calls=0;
    const handler=createPublicationMediaHandler({serviceKey:'synthetic-only',fetchImpl:async()=>{
      if(++calls===1) return Response.json({...base,operation:'sign'});
      return Response.json(answer.token?{url:`/object/upload/sign/hub-publications/${base.path}?token=${answer.token}`}:answer);
    }});
    expect((await handler(request({'Content-Type':'application/json'},'{}'))).status).toBe(503); expect(calls).toBe(2);
  });
  it.each([409,'legacy'])('answers stored when Storage already holds the object, so a retry goes straight to the check (%s)',async duplicate=>{
    let calls=0;
    const handler=createPublicationMediaHandler({serviceKey:'synthetic-only',fetchImpl:async()=>{
      if(++calls===1) return Response.json({...base,operation:'sign'});
      return duplicate===409?new Response('{}',{status:409}):Response.json({statusCode:'409',error:'Duplicate',message:'The resource already exists'},{status:400});
    }});
    const response=await handler(request({'Content-Type':'application/json'},'{}'));
    expect(response.status).toBe(200); expect(await response.json()).toEqual({stored:true}); expect(calls).toBe(2);
  });
  it.each([[403,'sign'],[500,'sign'],[404,'check'],[409,'check']])('never reads %s from %s as a stored object',async(status,operation)=>{
    let calls=0;
    const handler=createPublicationMediaHandler({serviceKey:'synthetic-only',fetchImpl:async()=>{
      if(++calls===1) return Response.json({...base,operation});
      return Response.json({code:'AccessDenied'},{status});
    }});
    expect((await handler(request({'Content-Type':'application/json'},'{}'))).status).toBe(503); expect(calls).toBe(2);
  });
  it('public tickets use only their fixed audience and can never become uploads',async()=>{
    for(const operation of ['upload','download','sign','check']) {
      let calls=0;
      const handler=createPublicationMediaHandler({serviceKey:'synthetic-only',fetchImpl:async(url)=>{
        if(++calls===1) {
          expect(url).toBe('https://support-hub-web-production.up.railway.app/api/internal/publications/public/authorize');
          return Response.json({...base,operation});
        }
        expect(url).toContain('/object/authenticated/hub-publications/');
        return new Response(bytes,{headers:{'Content-Type':'text/markdown','Content-Length':String(bytes.length)}});
      }});
      const response=await handler(request({'X-CareMetric-Publication-Mode':'public'}));
      expect(response.status).toBe(operation==='download'?200:403); expect(calls).toBe(operation==='download'?2:1);
    }
  });
  it('requires the upstream range and length to exactly match the authorized range',async()=>{
    for(const malformed of [false,true]) {
      let calls=0;
      const handler=createPublicationMediaHandler({serviceKey:'synthetic-only',fetchImpl:async(_url,options)=>{
        if(++calls===1) return Response.json({...base,operation:'download',range:'bytes=1-3'});
        expect(options.headers.Range).toBe('bytes=1-3'); expect(options.redirect).toBe('manual');
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
      expect(options.redirect).toBe('manual');
      return new Response('[]');
    }});
    expect(await (await handler(request({'X-CareMetric-Publication-Mode':'cleanup'}))).json()).toEqual({cleaned:true});
    const invalid=createPublicationMediaHandler({serviceKey:'synthetic-only',fetchImpl:async()=>Response.json({operation:'cleanup',paths:[base.path,`publications/${randomUUID()}/primary`]})});
    expect((await invalid(request({'X-CareMetric-Publication-Mode':'cleanup'}))).status).toBe(403);
  });
  it('never follows a redirect from the gate or storage, and never serves redirect content',async()=>{
    // Every fetch in the handler runs with redirect 'manual': a 3xx comes
    // back as a response and is refused by the ordinary status checks, so
    // the credentialed request is never re-sent to a redirect target and a
    // redirect body is never treated as the capability or the media.
    const redirect=()=>new Response('redirected content',{status:302,headers:{Location:'https://attacker.invalid/media'}});
    const gateFetcher=vi.fn(async()=>redirect());
    const gated=createPublicationMediaHandler({serviceKey:'synthetic-only',fetchImpl:gateFetcher});
    expect((await gated(request())).status).toBe(401); expect(gateFetcher).toHaveBeenCalledOnce();
    let uploadCalls=0;
    const uploading=createPublicationMediaHandler({serviceKey:'synthetic-only',fetchImpl:async()=>{
      if(++uploadCalls===1) return Response.json(base);
      return redirect();
    }});
    expect((await uploading(request())).status).toBe(503); expect(uploadCalls).toBe(2);
    let downloadCalls=0;
    const downloading=createPublicationMediaHandler({serviceKey:'synthetic-only',fetchImpl:async()=>{
      if(++downloadCalls===1) return Response.json({...base,operation:'download'});
      return redirect();
    }});
    const response=await downloading(request());
    expect(response.status).toBe(503); expect(await response.text()).not.toContain('redirected content');
    expect(downloadCalls).toBe(2);
  });
});
