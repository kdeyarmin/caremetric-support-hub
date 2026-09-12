import { expect,it,vi } from 'vitest';
import { distributionObserver,observerQuery } from './distribution-observer.mjs';
const id='d1000000-0000-4000-8000-000000000001',lease='d1000000-0000-4000-8000-000000000002',token='synthetic_'.padEnd(43,'a');
function envelope(){return {contractVersion:1,product:'carebase',domain:'course.distribution.status.v1',operation:'status',generatedAt:new Date().toISOString(),
  data:{items:[{courseId:id,publicationState:'missing',currentVersionId:null,currentVersionState:null,sourceRevision:null}]}};}
it('uses a dedicated fixed read-only transport and cannot request source payloads or arbitrary IDs',async()=>{
  const fetchImpl=vi.fn(async()=>Response.json(envelope())),observer=distributionObserver({pool:{},token,fetchImpl});
  expect((await observer.read([id])).items[0].publicationState).toBe('missing');
  expect(fetchImpl).toHaveBeenCalledWith('https://cmcarebase.com/api/internal/learning/distribution-status',expect.objectContaining({method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},redirect:'error',cache:'no-store'}));
  expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({domain:'course.distribution.status.v1',operation:'status',courseIds:[id]});
  await expect(observer.read(Array(11).fill(id))).rejects.toThrow();expect(fetchImpl).toHaveBeenCalledOnce();
});
it('stays disabled without a bounded opaque credential and does not infer readiness from missing responses',async()=>{
  const fetchImpl=vi.fn(),pool={query:vi.fn()},observer=distributionObserver({pool,fetchImpl});
  expect(await observer.tick()).toEqual({batches:0,courses:0});await expect(observer.read([id])).rejects.toMatchObject({code:'unconfigured'});
  expect(fetchImpl).not.toHaveBeenCalled();expect(pool.query).not.toHaveBeenCalled();
});
it('rejects oversized, stale or private native responses before recording an observation',async()=>{
  for(const response of [new Response('x'.repeat(16385)),Response.json({...envelope(),generatedAt:'2000-01-01T00:00:00Z'}),Response.json({...envelope(),data:{items:[{...envelope().data.items[0],payload:'private'}]}})]){
    const observer=distributionObserver({pool:{},token,fetchImpl:async()=>response});await expect(observer.read([id])).rejects.toThrow();
  }
});
it('drains bounded leases and prevents concurrent local workers from duplicating a lease request',async()=>{
  let resolve;const pending=new Promise(done=>{resolve=done;});
  const query=vi.fn().mockResolvedValueOnce({rows:[{value:{leaseId:lease,courseIds:[id]}}]}).mockResolvedValueOnce({rows:[{value:1}]}).mockResolvedValueOnce({rows:[{value:{leaseId:lease,courseIds:[]}}]});
  const pool={connect:async()=>({query:async(sql,args)=>sql.startsWith('select private.')?query(sql,args):{},release:vi.fn()})};
  const observer=distributionObserver({pool,token,fetchImpl:async()=>{await pending;return Response.json(envelope());}});
  const first=observer.tick();await Promise.resolve();expect(await observer.tick()).toEqual({batches:0,courses:0});resolve();
  expect(await first).toEqual({batches:1,courses:1});expect(query).toHaveBeenCalledTimes(3);
  expect(query.mock.calls[1][0]).toContain('record_distribution_status_batch');
});

it('continues after a failed lease so healthy courses are not starved',async()=>{
  const query=vi.fn().mockResolvedValueOnce({rows:[{value:{leaseId:lease,courseIds:[id]}}]}).mockResolvedValueOnce({})
    .mockResolvedValueOnce({rows:[{value:{leaseId:lease,courseIds:[id]}}]}).mockResolvedValueOnce({rows:[{value:1}]}).mockResolvedValueOnce({rows:[{value:{courseIds:[]}}]});
  const pool={connect:async()=>({query:async(sql,args)=>sql.startsWith('select private.')?query(sql,args):{},release:vi.fn()})};let calls=0;
  const observer=distributionObserver({pool,token,fetchImpl:async()=>++calls===1?Response.json({},{status:503}):Response.json(envelope())});
  expect(await observer.tick()).toEqual({batches:1,courses:1});expect(query.mock.calls[1][0]).toContain('release_distribution_status_batch');
});
it('destroys a stalled database connection and releases the running operation on cancellation',async()=>{
  const controller=new AbortController(),release=vi.fn();let entered;
  const started=new Promise(resolve=>{entered=resolve;});
  const pool={connect:async()=>({release,query:async(sql)=>{if(sql==='select stuck'){entered();return new Promise(()=>{});}return {};}})};
  const pending=observerQuery(pool,'select stuck',[],controller.signal);await started;controller.abort();
  await expect(pending).rejects.toThrow();expect(release).toHaveBeenCalledExactlyOnceWith(true);
});
it('releases a connection acquired after cancellation rather than leaking pool capacity',async()=>{
  const controller=new AbortController(),release=vi.fn();let connect;
  const pool={connect:()=>new Promise(resolve=>{connect=resolve;})};const pending=observerQuery(pool,'select never',[],controller.signal);
  controller.abort();await expect(pending).rejects.toThrow();connect({release,query:vi.fn()});await Promise.resolve();await Promise.resolve();
  expect(release).toHaveBeenCalledExactlyOnceWith(true);
});
