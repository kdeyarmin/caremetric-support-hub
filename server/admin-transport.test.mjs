import { describe,it,expect,vi } from 'vitest';
import { callNativeAdmin } from './admin-transport.mjs';
const target='https://caremetricai.base44.app/functions/centralAdminRead';
const capability='cmh_'+'x'.repeat(43);
const operation={operation:'overview'};
const call=(fetcher,project=value=>value,command=false)=>callNativeAdmin(fetcher,target,'X-CareMetric-Hub-Authorization',capability,operation,project,command);
describe('application server native transport',()=>{
  it('sends only the reviewed custom authorization header and operation',async()=>{
    const fetcher=vi.fn(async()=>Response.json({count:4,private:'discard'}));
    expect(await call(fetcher,value=>({count:value.count}))).toEqual({count:4});
    expect(fetcher.mock.calls[0]).toMatchObject([target,{method:'POST',redirect:'error',cache:'no-store',body:JSON.stringify(operation),headers:{'X-CareMetric-Hub-Authorization':`Bearer ${capability}`,'Content-Type':'application/json'}}]);
    expect(Object.keys(fetcher.mock.calls[0][1].headers)).toHaveLength(2);
  });
  it('stops oversized streamed responses before buffering their remainder',async()=>{
    const cancelled=vi.fn();
    const body=new ReadableStream({start(controller){controller.enqueue(new Uint8Array(1000001));},cancel:cancelled});
    const project=vi.fn();
    await expect(call(async()=>new Response(body),project)).rejects.toMatchObject({status:503,code:'upstream'});
    expect(cancelled).toHaveBeenCalledOnce(); expect(project).not.toHaveBeenCalled();
  });
  it.each([()=>Response.json({wrong:'contract'}),()=>new Response('private upstream error')])('hides malformed producer responses',async(makeResponse)=>{
    await expect(call(async()=>makeResponse(),()=>{throw new Error('private producer fields');})).rejects.toMatchObject({status:503,message:'Administrator connection is unavailable.'});
  });
  it('preserves an ambiguous command conflict without automatically issuing another request',async()=>{
    const fetcher=vi.fn(async()=>new Response('private stale target state',{status:409}));
    await expect(call(fetcher,undefined,true)).rejects.toMatchObject({status:409,code:'conflict'});
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each([401,403])('retains native authority denial %s without exposing its body',async status=>{
    await expect(call(async()=>new Response('private native identity',{status}))).rejects.toMatchObject({status,message:'Administrator access could not be verified.'});
  });
});
