import {it,expect,vi} from 'vitest';
import {growthExecutors,growthHandlers} from './worker.mjs';
const base={id:'opp',product:'carebase',stage:'qualified',owner_agent:'marketing_manager',internal:false,next_at:'2026-01-01T00:00:00Z',touches:0,work:[],events:[],eligibility:'review'};
it('Observe inspects but creates no work or proposals',async()=>{
 const store={snapshot:vi.fn(async()=>({total:1,items:[base]})),plan:vi.fn(),propose:vi.fn()};
 const handler=growthHandlers({growth:{store}})['growth.pipeline'];
 expect(await handler({agent:{autonomy:'observe'},kind:'growth.pipeline'})).toMatchObject({result:{inspected:1,planned:0,drafted:0}});expect(store.plan).not.toHaveBeenCalled();
});
it('creates outcome-based work without contacting unverified prospects',async()=>{
 const store={snapshot:vi.fn(async()=>({total:1,items:[base]})),plan:vi.fn(async()=> 'work'),draft:vi.fn()};
 await growthHandlers({growth:{store}})['growth.pipeline']({id:'task',agent:{autonomy:'propose'},kind:'growth.pipeline'});expect(store.plan).toHaveBeenCalled();expect(store.draft).not.toHaveBeenCalled();
});
it('an abort prevents new work',async()=>{
 const store={snapshot:vi.fn()};await expect(growthHandlers({growth:{store}})['growth.pipeline']({},{signal:AbortSignal.abort()})).rejects.toBeDefined();expect(store.snapshot).not.toHaveBeenCalled();
});
it('saves the exact contact and policy versions used to write a draft',async()=>{
 const o={...base,version:4,contact_id:'contact',contact_version:7,eligibility:'permitted',policy:{version:9,approved_claim:'Discuss staff training.'},evidence:[{id:'source',source_url:'https://example.org',claim:'Care operator.',observed_at:new Date().toISOString()}]};
 const store={snapshot:vi.fn(async()=>({total:1,items:[o]})),plan:vi.fn(async()=> 'work'),draft:vi.fn(async()=>({id:'message',status:'draft'})),propose:vi.fn()};
 const growth={store,signingReady:true,hash:x=>x,unsubscribeToken:()=> 'token'};
 await growthHandlers({growth})['growth.pipeline']({id:'task',agent:{autonomy:'propose'},kind:'growth.pipeline'});
 expect(store.draft).toHaveBeenCalledWith('opp','work',expect.objectContaining({version:4,contactVersion:7,policyVersion:9}));
 expect(store.propose).toHaveBeenCalledWith('task','message');
});
it('discards a stale draft and continues the sweep when an owner edits its context during generation',async()=>{
 const o={...base,version:4,contact_id:'contact',contact_version:7,eligibility:'permitted',policy:{version:9,approved_claim:'Discuss staff training.'},evidence:[{id:'source',source_url:'https://example.org',claim:'Care operator.',observed_at:new Date().toISOString()}]};
 const store={snapshot:vi.fn(async()=>({total:2,items:[o,{...o,id:'next'}]})),plan:vi.fn(async()=> 'work'),draft:vi.fn().mockRejectedValueOnce(Object.assign(new Error('Changed'),{code:'40001'})).mockResolvedValue({id:'message',status:'draft'}),propose:vi.fn()};
 const growth={store,signingReady:true,hash:x=>x,unsubscribeToken:()=> 'token'};
 expect(await growthHandlers({growth})['growth.pipeline']({id:'task',agent:{autonomy:'propose'},kind:'growth.pipeline'})).toMatchObject({result:{inspected:2,drafted:1}});
 expect(store.propose).toHaveBeenCalledTimes(1);
});
it('sending disabled defers before claiming a message',async()=>{
 const store={claim:vi.fn()},growth={store,configured:()=>false};const exec=growthExecutors({growth,mail:{configured:true}})['growth.message'];await expect(exec({input:{messageId:'m'}})).rejects.toMatchObject({code:'action_deferred'});expect(store.claim).not.toHaveBeenCalled();
});
it('only sends a claimed message, distinguishes acceptance and never retries an uncertain outcome',async()=>{
 const store={claim:vi.fn(async()=>({send:true,to:'synthetic@example.org',id:'m',workId:'w',subject:'Hello',body:'Approved message'})),finish:vi.fn()};
 const growth={store,configured:()=>true,unsubscribeToken:()=> 'token'},mail={configured:true,send:vi.fn(async()=>({delivery:'sent',id:'provider'}))};
 const exec=growthExecutors({growth,mail,publicOrigin:'https://hub.example.org',postalAddress:'Synthetic address'})['growth.message'];
 expect(await exec({id:'a',input:{messageId:'m'}})).toEqual({delivery:'accepted'});expect(mail.send.mock.calls[0][0].text).toContain('/api/growth/unsubscribe/token');expect(store.finish).toHaveBeenCalledWith('m','accepted','provider');
 store.claim.mockResolvedValue({send:false,status:'unknown'});await exec({id:'a',input:{messageId:'m'}});expect(mail.send).toHaveBeenCalledTimes(1);
});
it('transport exceptions record uncertainty and surface the failed action',async()=>{
 const store={claim:vi.fn(async()=>({send:true,id:'m',workId:'w',subject:'Hello',body:'Approved message'})),finish:vi.fn()};
 const exec=growthExecutors({growth:{store,configured:()=>true,unsubscribeToken:()=> 't'},mail:{configured:true,send:vi.fn(async()=>{throw new Error('timeout');})},publicOrigin:'https://hub.example.org',postalAddress:'Test address'})['growth.message'];
 await expect(exec({id:'a',input:{messageId:'m'}})).rejects.toMatchObject({code:'delivery_unknown'});expect(store.finish).toHaveBeenCalledWith('m','unknown',null);
});
