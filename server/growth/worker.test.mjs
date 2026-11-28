import {describe,it,expect,vi} from 'vitest';
import {assessLimit,assessRetryMs,colleagueLimit,colleagueUnsubscribeKey,contactSearchConcurrency,contactSearchLimit,growthColleaguesFeature,growthDay,growthEmail,growthExecutors,growthHandlers,sweepContactLimit,workBudgetMs} from './worker.mjs';
import {discoveryQueriesPerDay} from './playbook.mjs';
import {growthLearningFeature} from './learning.mjs';
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
it('keeps a first email\'s priority band with its arms once the database declares stage 2',async()=>{
 const o={...base,version:4,contact_id:'contact',contact_version:7,eligibility:'permitted',priority_band:2,policy:{version:9,approved_claim:'Discuss staff training.'},evidence:[{id:'source',source_url:'https://example.org',claim:'Care operator.',observed_at:new Date().toISOString()}]};
 for(const [features,band] of [[new Set(['platform.agents.growth-priority.v1']),'2'],[new Set(),undefined]]) {
  const store={snapshot:vi.fn(async()=>({total:1,items:[o]})),plan:vi.fn(async()=> 'work'),draft:vi.fn(async()=>({id:'message',status:'draft'})),propose:vi.fn()};
  const growth={store,signingReady:true,hash:x=>x,unsubscribeToken:()=> 'token'};
  await growthHandlers({growth,features})['growth.pipeline']({id:'task',agent:{autonomy:'propose'},kind:'growth.pipeline'});
  expect(store.draft.mock.calls[0][2].arms.band).toBe(band);
 }
});
describe('a prospect who replied and went quiet',()=>{
 const engaged={...base,product:'caremetric-intel',stage:'engaged',version:6,contact_id:'contact',contact_version:2,eligibility:'permitted',policy:{version:3,approved_claim:'Intel shows where referrals come from.'},
  evidence:[{id:'source',source_url:'https://example.org',claim:'Home health agency.',observed_at:new Date().toISOString()}]};
 const setup=({on=true,features=new Set(['platform.agents.growth-autonomy.v1','platform.agents.growth-priority.v1']),step=1}={})=>{
  const store={snapshot:vi.fn(async()=>({total:1,items:[engaged]})),plan:vi.fn(async()=> 'work'),autoQualify:vi.fn(),draft:vi.fn(async()=>({id:'message',status:'draft'})),propose:vi.fn(),
   quietCandidates:vi.fn(async()=>[{opportunityId:'opp',product:'caremetric-intel',step,eventId:'e1',key:`quiet:e1:${step}`}])};
  const growth={store,signingReady:true,hash:x=>x,unsubscribeToken:()=> 'token',priority:{quietFollowup:()=>on}};
  const run=()=>growthHandlers({growth,features,marketed:()=>['caremetric-intel']})['growth.pipeline']({id:'task',agent:{autonomy:'act'},kind:'growth.pipeline'});
  return {store,run};
 };
 it('drafts a short customer email for the quiet step, through the same draft and proposal as every growth email',async()=>{
  const {store,run}=setup();
  const {result}=await run();
  expect(store.plan).toHaveBeenCalledWith('opp',expect.objectContaining({key:'quiet:e1:1',kind:'reply',owner:'marketing_manager'}));
  expect(store.draft).toHaveBeenCalledWith('opp','work',expect.objectContaining({purpose:'success',version:6,contactVersion:2,policyVersion:3,arms:expect.objectContaining({quiet:'1'})}));
  expect(store.propose).toHaveBeenCalledWith('task','message');
  expect(result.quietFollowups).toBe(1);
 });
 it('does nothing while the switch is off or the database does not declare stage 2',async()=>{
  for(const options of [{on:false},{features:new Set(['platform.agents.growth-autonomy.v1'])}]) {
   const {store,run}=setup(options);
   await run();
   expect(store.quietCandidates).not.toHaveBeenCalled();
   expect(store.draft).not.toHaveBeenCalled();
  }
 });
});
it('discards a stale draft and continues the sweep when an owner edits its context during generation',async()=>{
 const o={...base,version:4,contact_id:'contact',contact_version:7,eligibility:'permitted',policy:{version:9,approved_claim:'Discuss staff training.'},evidence:[{id:'source',source_url:'https://example.org',claim:'Care operator.',observed_at:new Date().toISOString()}]};
 const store={snapshot:vi.fn(async()=>({total:2,items:[o,{...o,id:'next'}]})),plan:vi.fn(async()=> 'work'),draft:vi.fn().mockRejectedValueOnce(Object.assign(new Error('Changed'),{code:'40001'})).mockResolvedValue({id:'message',status:'draft'}),propose:vi.fn()};
 const growth={store,signingReady:true,hash:x=>x,unsubscribeToken:()=> 'token'};
 expect(await growthHandlers({growth})['growth.pipeline']({id:'task',agent:{autonomy:'propose'},kind:'growth.pipeline'})).toMatchObject({result:{inspected:2,drafted:1}});
 expect(store.propose).toHaveBeenCalledTimes(1);
});
it('skips one opportunity whose model answer is cut off and drafts the rest; a rate limit still stops the sweep for a retry',async()=>{
 const o={...base,version:4,contact_id:'contact',contact_version:7,eligibility:'permitted',policy:{version:9,approved_claim:'Discuss staff training.'},evidence:[{id:'source',source_url:'https://example.org',claim:'Care operator.',observed_at:new Date().toISOString()}]};
 const answer={outcome:'completed',output:{subject:'Staff training',body:'Discuss staff training.',citations:['source'],needsHuman:false}};
 const sweep=async model=>{
  const store={snapshot:vi.fn(async()=>({total:2,items:[o,{...o,id:'next'}]})),plan:vi.fn(async()=> 'work'),draft:vi.fn(async()=>({id:'message',status:'draft'})),propose:vi.fn()};
  const growth={store,signingReady:true,hash:x=>x,unsubscribeToken:()=> 'token'};
  return {store,run:growthHandlers({growth,model})['growth.pipeline']({id:'task',agent:{autonomy:'propose'},kind:'growth.pipeline'})};
 };
 const cut={configured:true,run:vi.fn().mockRejectedValueOnce(Object.assign(new Error('The model call could not be completed.'),{code:'output_truncated',transient:false})).mockResolvedValue(answer)};
 const first=await sweep(cut);
 expect(await first.run).toMatchObject({result:{inspected:2,drafted:1}});
 expect(first.store.draft).toHaveBeenCalledTimes(1);
 expect(first.store.draft).toHaveBeenCalledWith('next','work',expect.objectContaining({subject:'Staff training'}));
 const limited={configured:true,run:vi.fn().mockRejectedValue(Object.assign(new Error('The model call could not be completed.'),{code:'rate_limited',transient:true}))};
 await expect((await sweep(limited)).run).rejects.toMatchObject({code:'rate_limited'});
 const account={configured:true,run:vi.fn().mockRejectedValue(Object.assign(new Error('The model call could not be completed.'),{code:'ai_auth_failed',transient:false}))};
 await expect((await sweep(account)).run).rejects.toMatchObject({code:'ai_auth_failed'});
 expect(account.run).toHaveBeenCalledTimes(1);
});
it('does not pay again, sweep after sweep, for a draft that failed its checks; a changed opportunity, contact or policy is drafted at once',async()=>{
 const o={...base,version:4,contact_id:'contact',contact_version:7,eligibility:'permitted',policy:{version:9,approved_claim:'Discuss staff training.'},evidence:[{id:'source',source_url:'https://example.org',claim:'Care operator.',observed_at:new Date().toISOString()}]};
 let at=5_000_000,item=o;
 const store={snapshot:vi.fn(async()=>({total:1,items:[item]})),plan:vi.fn(async()=>'work'),draft:vi.fn(async()=>({id:'message',status:'draft'})),propose:vi.fn()};
 // Cites a source that was never supplied, so the draft is refused by the code checks.
 const model={configured:true,run:vi.fn(async()=>({outcome:'completed',output:{subject:'A question',body:'Would a free trial help?',citations:['invented'],needsHuman:false}}))};
 const handler=growthHandlers({growth:{store,signingReady:true,hash:x=>x,unsubscribeToken:()=>'token'},model,clock:()=>at})['growth.pipeline'];
 const sweep=()=>handler({id:'task',agent:{autonomy:'propose'},kind:'growth.pipeline'});
 // The draft and its one repair pass; the run says which check refused it.
 expect((await sweep()).result).toMatchObject({planned:1,drafted:0,undrafted:1,rejected:{citation_then_citation:1}});
 expect((await sweep()).result).toEqual({inspected:1,planned:1,drafted:0});
 expect(model.run).toHaveBeenCalledTimes(2);
 item={...o,policy:{...o.policy,version:10}}; await sweep();
 expect(model.run).toHaveBeenCalledTimes(4);
 at+=assessRetryMs; await sweep();
 expect(model.run).toHaveBeenCalledTimes(6);
 expect(store.draft).not.toHaveBeenCalled();
});
it('does not pay for a new draft of work whose last message was cancelled under the same context, unless it was withdrawn or something changed',async()=>{
 const o={...base,version:4,contact_id:'contact',contact_version:7,eligibility:'permitted',policy:{version:9,approved_claim:'Discuss staff training.'},evidence:[{id:'source',source_url:'https://example.org',claim:'Care operator.',observed_at:new Date().toISOString()}]};
 const cancelled={trigger_key:'outreach:0',status:'open',message_id:'old',message_status:'cancelled',message_withdrawn:false,message_opportunity_version:4,message_contact_version:7,message_policy_version:9};
 const run=async work=>{
  const store={snapshot:vi.fn(async()=>({total:1,items:[{...o,work:[work]}]})),plan:vi.fn(async()=> 'work'),draft:vi.fn(async()=>({id:'message',status:'draft'})),propose:vi.fn()};
  const model={configured:true,run:vi.fn(async()=>({outcome:'completed',output:{subject:'A question',body:'Would a free trial help?',citations:['source'],needsHuman:false}}))};
  await growthHandlers({growth:{store,signingReady:true,hash:x=>x,unsubscribeToken:()=> 'token'},model})['growth.pipeline']({id:'task',agent:{autonomy:'propose'},kind:'growth.pipeline'});
  return {drafted:store.draft.mock.calls.length,modelCalls:model.run.mock.calls.length};
 };
 expect(await run(cancelled)).toEqual({drafted:0,modelCalls:0});
 expect(await run({...cancelled,message_withdrawn:true})).toEqual({drafted:1,modelCalls:1});
 for(const change of [{message_opportunity_version:3},{message_contact_version:6},{message_policy_version:8}]) expect(await run({...cancelled,...change}),JSON.stringify(change)).toEqual({drafted:1,modelCalls:1});
 // A database that does not report the fields yet: drafted as before.
 const {message_withdrawn,message_opportunity_version,message_contact_version,message_policy_version,...older}=cancelled;
 expect(await run(older)).toEqual({drafted:1,modelCalls:1});
});
it('sending disabled defers before claiming a message',async()=>{
 const store={claim:vi.fn()},growth={store,configured:()=>false};const exec=growthExecutors({growth,mail:{configured:true}})['growth.message'];await expect(exec({input:{messageId:'m'}})).rejects.toMatchObject({code:'action_deferred'});expect(store.claim).not.toHaveBeenCalled();
});
it('a claim refused for the cap or the send hours waits with its reason, and nothing is sent',async()=>{
 for(const status of ['daily_limit','outside_hours','frequency_limited','paced']) {
  const store={claim:vi.fn(async()=>({send:false,status})),finish:vi.fn()},mail={configured:true,send:vi.fn()};
  const exec=growthExecutors({growth:{store,configured:()=>true},mail})['growth.message'];
  await expect(exec({input:{messageId:'m'},id:'a'})).rejects.toMatchObject({code:'action_deferred',reason:status});
  expect(mail.send).not.toHaveBeenCalled();
 }
});
it('only sends a claimed message, distinguishes acceptance and never retries an uncertain outcome',async()=>{
 const store={claim:vi.fn(async()=>({send:true,to:'synthetic@example.org',id:'m',workId:'w',subject:'Hello',body:'Approved message'})),finish:vi.fn()};
 const growth={store,configured:()=>true,unsubscribeToken:()=> 'token'},mail={configured:true,send:vi.fn(async()=>({delivery:'sent',id:'provider'}))};
 const exec=growthExecutors({growth,mail,publicOrigin:'https://hub.example.org',postalAddress:'Synthetic address'})['growth.message'];
 expect(await exec({id:'a',input:{messageId:'m'}})).toEqual({delivery:'accepted'});expect(mail.send.mock.calls[0][0].text).toContain('/api/growth/preferences/token');expect(store.finish).toHaveBeenCalledWith('m','accepted','provider');
 store.claim.mockResolvedValue({send:false,status:'unknown'});await exec({id:'a',input:{messageId:'m'}});expect(mail.send).toHaveBeenCalledTimes(1);
});
it('transport exceptions record uncertainty and surface the failed action',async()=>{
 const store={claim:vi.fn(async()=>({send:true,id:'m',workId:'w',subject:'Hello',body:'Approved message'})),finish:vi.fn()};
 const exec=growthExecutors({growth:{store,configured:()=>true,unsubscribeToken:()=> 't'},mail:{configured:true,send:vi.fn(async()=>{throw new Error('timeout');})},publicOrigin:'https://hub.example.org',postalAddress:'Test address'})['growth.message'];
 await expect(exec({id:'a',input:{messageId:'m'}})).rejects.toMatchObject({code:'delivery_unknown'});expect(store.finish).toHaveBeenCalledWith('m','unknown',null);
});
const autonomy=new Set(['platform.agents.growth-autonomy.v1']);
it('qualifies researched prospects before each sales sweep, only with the feature and never in Observe',async()=>{
 const store={snapshot:vi.fn(async()=>({total:0,items:[]})),autoQualify:vi.fn(async()=>({qualified:2}))};
 await growthHandlers({growth:{store},features:autonomy})['growth.pipeline']({id:'t',agent:{autonomy:'propose'},kind:'growth.pipeline'});
 expect(store.autoQualify).toHaveBeenCalledWith(100);
 store.autoQualify.mockClear();
 await growthHandlers({growth:{store},features:autonomy})['growth.pipeline']({id:'t',agent:{autonomy:'observe'},kind:'growth.pipeline'});
 await growthHandlers({growth:{store},features:autonomy})['growth.success']({id:'t',agent:{autonomy:'act'},kind:'growth.success'});
 await growthHandlers({growth:{store}})['growth.pipeline']({id:'t',agent:{autonomy:'propose'},kind:'growth.pipeline'});
 expect(store.autoQualify).not.toHaveBeenCalled();
});
it('discovery reads each new business\'s own site for one role address and records what it found, keeping only counts',async()=>{
 const store={discover:vi.fn(async()=>1),contactCandidates:vi.fn(async()=>[{id:'org-a',domain:'a.example'},{id:'org-b',domain:'b.example'},{id:'org-c',domain:'c.example'}]),
  recordContact:vi.fn(async(id,email)=>({found:Boolean(email)})),autoQualify:vi.fn(async()=>({qualified:1}))};
 const contacts={configured:true,find:vi.fn(async domain=>domain==='a.example'?{email:'info@a.example',sourceUrl:'https://a.example/contact'}:domain==='b.example'?{email:null,reason:'none'}:(()=>{throw new Error('unreachable');})())};
 const growth={store,research:{configured:true,search:vi.fn(async()=>[])},contacts};
 const outcome=await growthHandlers({growth,features:autonomy})['growth.discovery']({id:'t',agent:{autonomy:'propose'}});
 expect(outcome.result).toEqual({candidates:0,searches:2*discoveryQueriesPerDay,contacts:{searched:3,found:1,none:2,described:0},qualified:1});
 expect(store.contactCandidates).toHaveBeenCalledWith(contactSearchLimit);
 expect(store.recordContact.mock.calls).toEqual([['org-a','info@a.example','https://a.example/contact'],['org-b',null,null],['org-c',null,null]]);
 expect(JSON.stringify(outcome)).not.toContain('@');
 // A refused address (the database's own domain check) is recorded as nothing found.
 store.recordContact.mockReset().mockRejectedValueOnce(Object.assign(new Error('off domain'),{code:'22023'})).mockResolvedValue({found:false});
 store.contactCandidates.mockResolvedValue([{id:'org-a',domain:'a.example'}]);
 expect((await growthHandlers({growth,features:autonomy})['growth.discovery']({id:'t',agent:{autonomy:'propose'}})).result.contacts).toEqual({searched:1,found:0,none:1,described:0});
 expect(store.recordContact.mock.calls[1]).toEqual(['org-a',null,null]);
 // Without the feature, or in Observe, no website is read.
 contacts.find.mockClear();
 await growthHandlers({growth})['growth.discovery']({id:'t',agent:{autonomy:'propose'}});
 await growthHandlers({growth,features:autonomy})['growth.discovery']({id:'t',agent:{autonomy:'observe'}});
 expect(contacts.find).not.toHaveBeenCalled();
});
it('discovery runs several new searches for each product every day, CareBase always in Pennsylvania, twenty results each',async()=>{
 const store={discover:vi.fn(async()=>0)};
 const search=vi.fn(async()=>[]);
 const handlers=growthHandlers({growth:{store,research:{configured:true,search}}});
 await handlers['growth.discovery']({id:'t',agent:{autonomy:'propose'}},{now:()=>new Date('2026-11-12T13:00:00Z')});
 await handlers['growth.discovery']({id:'t',agent:{autonomy:'propose'}},{now:()=>new Date('2026-11-13T13:00:00Z')});
 const queries=search.mock.calls.map(([product,options])=>[product,options.query]);
 expect(queries.filter(([product])=>product==='carebase').every(([,query])=>/ PA$/.test(query))).toBe(true);
 expect(new Set(queries.map(([,query])=>query)).size).toBe(2*2*discoveryQueriesPerDay);
 expect(search.mock.calls.every(([,options])=>options.count===20&&options.offset===0)).toBe(true);
});
it('discovery records every result ten at a time, keeps what it found when a later search fails, and fails the run only when the first one does',async()=>{
 const row=index=>({name:`Operator ${index}`,domain:`operator${index}.example`,url:`https://operator${index}.example/`,claim:'A home health agency.'});
 const store={discover:vi.fn(async(_product,rows)=>rows.length)};
 const unavailable=()=>Object.assign(new Error('Research unavailable'),{code:'research_unavailable',transient:true});
 const search=vi.fn().mockResolvedValueOnce(Array.from({length:20},(_,index)=>row(index))).mockResolvedValueOnce(Array.from({length:3},(_,index)=>row(100+index))).mockRejectedValue(unavailable());
 const outcome=await growthHandlers({growth:{store,research:{configured:true,search}},marketed:['caremetric-intel']})['growth.discovery']({id:'t',agent:{autonomy:'propose'}});
 expect(outcome.result).toEqual({candidates:23,searches:2,stopped:'search_unavailable'});
 expect(store.discover.mock.calls.map(([product,rows])=>[product,rows.length])).toEqual([['caremetric-intel',10],['caremetric-intel',10],['caremetric-intel',3]]);
 expect(search).toHaveBeenCalledTimes(3);
 // Nothing found yet: the scheduler retries the run.
 const failing=vi.fn().mockRejectedValue(unavailable());
 await expect(growthHandlers({growth:{store,research:{configured:true,search:failing}},marketed:['caremetric-intel']})['growth.discovery']({id:'t',agent:{autonomy:'propose'}})).rejects.toMatchObject({transient:true});
 expect(failing).toHaveBeenCalledTimes(1);
});
it('a slow search provider cannot carry own-site research past the run\'s time: the searches not started wait for the next run',async()=>{
 const uncertain=index=>({...base,id:`slow-${index}`,product:'caremetric-intel',stage:'researched',fit:60,domain:`slow${index}.example`,tenant_id:null});
 const items=Array.from({length:10},(_,index)=>uncertain(index));
 const store={snapshot:vi.fn(async()=>({total:items.length,items})),discover:vi.fn(async(_product,rows)=>rows.length)};
 // Every answer arrives just inside the adapter's own fifteen-second limit.
 let at=0;
 const search=vi.fn(async(_product,options)=>{at+=14_500;return options.domain?[{name:'An operator',domain:options.domain,url:`https://${options.domain}/about`,claim:'Operates a hospice.'}]:[];});
 const outcome=await growthHandlers({growth:{store,research:{configured:true,search}},marketed:['caremetric-intel'],clock:()=>at})['growth.discovery']({id:'t',agent:{autonomy:'propose'}});
 // Six discovery searches (87 seconds), then own-site searches only until the 150 seconds are spent: five of the ten.
 expect(outcome.result).toEqual({candidates:0,searches:discoveryQueriesPerDay,stopped:'time',enrichment:{searched:5,evidenceRows:5}});
 expect(search).toHaveBeenCalledTimes(discoveryQueriesPerDay+5);
 expect(at).toBeLessThan(240_000);
});
it('discovery reports what the search provider says the key may still use this month, when it says so',async()=>{
 const store={discover:vi.fn(async()=>0)};
 const research={configured:true,search:vi.fn(async()=>[]),allowance:()=>({limit:2000,left:1500,days:30})};
 expect((await growthHandlers({growth:{store,research},marketed:['caremetric-intel']})['growth.discovery']({id:'t',agent:{autonomy:'propose'}})).result)
  .toEqual({candidates:0,searches:discoveryQueriesPerDay,searchAllowance:{limit:2000,left:1500,days:30}});
 research.allowance=()=>null;
 expect((await growthHandlers({growth:{store,research},marketed:['caremetric-intel']})['growth.discovery']({id:'t',agent:{autonomy:'propose'}})).result).toEqual({candidates:0,searches:discoveryQueriesPerDay});
});
it('discovery waits the search provider\'s own pace between calls and stops searching once its time is spent',async()=>{
 vi.useFakeTimers();
 try {
  const store={discover:vi.fn(async()=>0)};
  const search=vi.fn(async()=>[]);
  const run=growthHandlers({growth:{store,research:{configured:true,paceMs:1100,search}},marketed:['caremetric-intel']})['growth.discovery']({id:'t',agent:{autonomy:'propose'}});
  await vi.advanceTimersByTimeAsync(1099);
  expect(search).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(search).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1100*discoveryQueriesPerDay);
  expect((await run).result).toEqual({candidates:0,searches:discoveryQueriesPerDay});
 } finally {vi.useRealTimers();}
 let at=0;
 const search=vi.fn(async()=>{at+=workBudgetMs;return [];});
 const late=await growthHandlers({growth:{store:{discover:vi.fn(async()=>0)},research:{configured:true,search}},marketed:['caremetric-intel'],clock:()=>at})['growth.discovery']({id:'t',agent:{autonomy:'propose'}});
 expect(late.result).toEqual({candidates:0,searches:1,stopped:'time'});
});
it('keeps what a business\'s home page says it is as evidence for the products it is a prospect of, and reads a few sites at a time',async()=>{
 const targets=Array.from({length:6},(_,index)=>({id:`org-${index}`,domain:`site${index}.example`}));
 const prospect=(domain,extra={})=>({...base,id:domain,product:'caremetric-intel',stage:'researched',domain,...extra});
 const items=[prospect('site0.example'),prospect('site1.example'),prospect('site1.example',{product:'carebase'}),prospect('site2.example',{stage:'lost'}),prospect('site3.example',{owner_agent:'account_manager'})];
 const store={snapshot:vi.fn(async()=>({total:items.length,items})),discover:vi.fn(async(_product,rows)=>rows.length),contactCandidates:vi.fn(async()=>targets),
  recordContact:vi.fn(async(id,email)=>({found:Boolean(email)})),autoQualify:vi.fn(async()=>({qualified:0}))};
 let open=0,most=0;
 const contacts={configured:true,find:vi.fn(async domain=>{open++;most=Math.max(most,open);await Promise.resolve();open--;
  return {email:domain==='site0.example'?'info@site0.example':null,sourceUrl:`https://${domain}/contact`,site:{url:`https://${domain}/`,claim:`The organization's own home page. Title: ${domain}`}};})};
 const growth={store,research:{configured:true,search:vi.fn(async()=>[])},contacts};
 const outcome=await growthHandlers({growth,features:autonomy,marketed:['caremetric-intel']})['growth.discovery']({id:'t',agent:{autonomy:'propose'}});
 expect(outcome.result.contacts).toEqual({searched:6,found:1,none:5,described:2});
 // Only a marketed product the business is still a prospect of gets the evidence: never CareBase in its pilot, a lost deal or a customer.
 expect(store.discover.mock.calls).toEqual([
  ['caremetric-intel',[{name:'site0.example',domain:'site0.example',url:'https://site0.example/',claim:'The organization\'s own home page. Title: site0.example'}]],
  ['caremetric-intel',[{name:'site1.example',domain:'site1.example',url:'https://site1.example/',claim:'The organization\'s own home page. Title: site1.example'}]]]);
 expect(store.recordContact.mock.calls.map(([id])=>id)).toEqual(targets.map(target=>target.id));
 expect(most).toBe(contactSearchConcurrency);
 expect(JSON.stringify(outcome)).not.toContain('example');
 // A summary the database refuses is dropped; the contact is still recorded.
 store.discover.mockRejectedValue(Object.assign(new Error('Invalid discovery'),{code:'22023'}));
 expect((await growthHandlers({growth,features:autonomy,marketed:['caremetric-intel']})['growth.discovery']({id:'t',agent:{autonomy:'propose'}})).result.contacts).toEqual({searched:6,found:1,none:5,described:0});
 // Out of time after the first group: the rest wait for the pipeline sweeps.
 let at=0; contacts.find.mockImplementation(async()=>{at+=workBudgetMs;return {email:null};});
 expect((await growthHandlers({growth,features:autonomy,marketed:['caremetric-intel'],clock:()=>at})['growth.discovery']({id:'t',agent:{autonomy:'propose'}})).result.contacts.searched).toBe(contactSearchConcurrency);
});
it('each pipeline sweep reads a few more discovered businesses\' websites, only with the feature, the finder and a level above Observe',async()=>{
 const o={...base,id:'intel',product:'caremetric-intel',stage:'researched',domain:'site.example',assessed_at:'2026-11-01T00:00:00Z',evidence:[]};
 const store={snapshot:vi.fn(async()=>({total:1,items:[o]})),plan:vi.fn(async()=>'work'),autoQualify:vi.fn(async()=>({qualified:0})),discover:vi.fn(async()=>1),
  contactCandidates:vi.fn(async()=>[{id:'org',domain:'site.example'}]),recordContact:vi.fn(async(id,email)=>({found:Boolean(email)}))};
 const contacts={configured:true,find:vi.fn(async()=>({email:'info@site.example',sourceUrl:'https://site.example/contact',site:{url:'https://site.example/',claim:'A hospice agency.'}}))};
 const outcome=await growthHandlers({growth:{store,contacts},features:autonomy})['growth.pipeline']({id:'t',agent:{autonomy:'act'},kind:'growth.pipeline'});
 expect(store.contactCandidates).toHaveBeenCalledWith(sweepContactLimit);
 expect(outcome.result).toMatchObject({inspected:1,contacts:{searched:1,found:1,none:0,described:1}});
 expect(store.recordContact).toHaveBeenCalledWith('org','info@site.example','https://site.example/contact');
 expect(store.discover).toHaveBeenCalledWith('caremetric-intel',[expect.objectContaining({domain:'site.example',url:'https://site.example/',claim:'A hospice agency.'})]);
 store.contactCandidates.mockClear();
 await growthHandlers({growth:{store,contacts},features:autonomy})['growth.pipeline']({id:'t',agent:{autonomy:'observe'},kind:'growth.pipeline'});
 await growthHandlers({growth:{store,contacts},features:autonomy})['growth.success']({id:'t',agent:{autonomy:'act'},kind:'growth.success'});
 await growthHandlers({growth:{store,contacts}})['growth.pipeline']({id:'t',agent:{autonomy:'act'},kind:'growth.pipeline'});
 await growthHandlers({growth:{store},features:autonomy})['growth.pipeline']({id:'t',agent:{autonomy:'act'},kind:'growth.pipeline'});
 expect(store.contactCandidates).not.toHaveBeenCalled();
 // Nothing to read: the sweep's result stays as it was.
 store.contactCandidates.mockResolvedValue([]);
 expect((await growthHandlers({growth:{store,contacts},features:autonomy})['growth.pipeline']({id:'t',agent:{autonomy:'act'},kind:'growth.pipeline'})).result).toEqual({inspected:1,planned:0,drafted:0});
});
it('assesses a bounded number of prospects per sweep and does not pay again for an assessment the model could not give',async()=>{
 const evidence=[{id:'source',source_url:'https://example.org',claim:'A hospice agency.',observed_at:new Date().toISOString()}];
 const fresh=index=>({...base,id:`new-${index}`,product:'caremetric-intel',stage:'identified',assessed_at:null,version:1,evidence});
 const answer={outcome:'completed',output:{fit:80,rationale:'A hospice agency.',citations:['source'],nextAction:'Confirm the service area.'}};
 const many=Array.from({length:assessLimit+5},(_,index)=>fresh(index));
 const store={snapshot:vi.fn(async()=>({total:many.length,items:many})),plan:vi.fn(async()=>'work'),assess:vi.fn()};
 const model={configured:true,run:vi.fn(async()=>answer)};
 await growthHandlers({growth:{store},model})['growth.pipeline']({id:'task',agent:{autonomy:'propose'},kind:'growth.pipeline'});
 expect(model.run).toHaveBeenCalledTimes(assessLimit);
 expect(store.assess).toHaveBeenCalledTimes(assessLimit);
 // An answer that fails its checks is asked for once, then left for six hours; new evidence or a new version asks again at once.
 let at=1_000_000;
 const one={snapshot:vi.fn(async()=>({total:1,items:[fresh(0)]})),plan:vi.fn(async()=>'work'),assess:vi.fn()};
 const unusable={configured:true,run:vi.fn(async()=>({outcome:'completed',output:{...answer.output,citations:['invented']}}))};
 const handler=growthHandlers({growth:{store:one},model:unusable,clock:()=>at})['growth.pipeline'];
 const sweep=()=>handler({id:'task',agent:{autonomy:'propose'},kind:'growth.pipeline'});
 await sweep(); await sweep();
 expect(unusable.run).toHaveBeenCalledTimes(1);
 at+=assessRetryMs; await sweep();
 expect(unusable.run).toHaveBeenCalledTimes(2);
 one.snapshot.mockResolvedValue({total:1,items:[{...fresh(0),evidence:[...evidence,{...evidence[0],id:'second'}]}]}); await sweep();
 expect(unusable.run).toHaveBeenCalledTimes(3);
 expect(one.assess).not.toHaveBeenCalled();
 // Out of time: no model call is started, and the work is still planned for the next sweep.
 let now=0;
 const o={...base,version:4,contact_id:'contact',contact_version:7,eligibility:'permitted',policy:{version:9,approved_claim:'Discuss staff training.'},evidence};
 const late={snapshot:vi.fn(async()=>{now+=workBudgetMs;return {total:2,items:[o,fresh(1)]};}),plan:vi.fn(async()=>'work'),draft:vi.fn(),assess:vi.fn()};
 const idle={configured:true,run:vi.fn(async()=>answer)};
 expect((await growthHandlers({growth:{store:late,signingReady:true,hash:x=>x,unsubscribeToken:()=>'token'},model:idle,clock:()=>now})['growth.pipeline']({id:'task',agent:{autonomy:'propose'},kind:'growth.pipeline'})).result).toMatchObject({inspected:2,planned:2,drafted:0});
 expect(idle.run).not.toHaveBeenCalled();
});
it('dedupes growth notices on the Eastern day, including after UTC midnight, and tells the owner only when an email was written',async()=>{
 expect(growthDay(new Date('2026-11-08T03:30:00Z'))).toBe('2026-11-07');
 expect(growthDay(new Date('2026-07-15T03:30:00Z'))).toBe('2026-07-14');
 const o={...base,version:4,contact_id:'contact',contact_version:7,eligibility:'permitted',policy:{version:9,approved_claim:'Discuss staff training.'},evidence:[{id:'source',source_url:'https://example.org',claim:'Care operator.',observed_at:new Date().toISOString()}]};
 const store={snapshot:vi.fn(async()=>({total:1,items:[o]})),plan:vi.fn(async()=>'work'),draft:vi.fn(async()=>({id:'message',status:'draft'})),propose:vi.fn()};
 const notifier={send:vi.fn(async()=>[])};
 await growthHandlers({growth:{store,signingReady:true,hash:x=>x,unsubscribeToken:()=>'token'},notifier})['growth.pipeline']({id:'task',agent:{autonomy:'propose'},kind:'growth.pipeline'},{now:()=>new Date('2026-11-08T03:30:00Z')});
 expect(notifier.send.mock.calls[0][0]).toMatchObject({dedupeKey:'growth:marketing_manager:2026-11-07',subject:'Prospect emails are ready on Growth',
   body:'1 email written. Open Growth to approve it, unless you handed that kind of email over on the AI team page.'});
 // Work items planned again with nothing written: no email (email review 2026-11-17).
 const quiet={snapshot:vi.fn(async()=>({total:1,items:[base]})),plan:vi.fn(async()=>'work')};
 const silent={send:vi.fn(async()=>[])};
 expect((await growthHandlers({growth:{store:quiet},notifier:silent})['growth.pipeline']({id:'task',agent:{autonomy:'propose'},kind:'growth.pipeline'})).result).toMatchObject({planned:1,drafted:0});
 expect(silent.send).not.toHaveBeenCalled();
});
it('the daily evaluation records each product\'s guardrail check and warns the owner only when one fails',async()=>{
 const store={evaluate:vi.fn()},notifier={send:vi.fn(async()=>[])};
 const handlers=growthHandlers({growth:{store},notifier,features:autonomy});
 const outcome=await handlers['growth.evaluate']({id:'t',agentKey:'marketing_manager'});
 expect(outcome.result).toEqual({evaluated:2,passed:['carebase','caremetric-intel'],failed:[]});
 expect(store.evaluate.mock.calls.map(call=>[call[0],call[1],call[2]])).toEqual([['carebase','growth.1',true],['caremetric-intel','growth.1',true]]);
 expect(notifier.send).not.toHaveBeenCalled();
 expect(growthHandlers({growth:{store}})['growth.evaluate']).toBeUndefined();
 // A failed check is recorded as failed and the owner is told once that day; nothing about customers is in the email.
 const failing=growthHandlers({growth:{store},notifier,features:autonomy});
 // Evidence dated a day ahead of the clock fails the synthetic cases, which is enough to see the failure path.
 expect((await failing['growth.evaluate']({id:'t',agentKey:'marketing_manager'},{now:()=>new Date(Date.now()+86_400_000)})).result.failed).toEqual(['carebase','caremetric-intel']);
 expect(store.evaluate.mock.calls.slice(-2).map(call=>call[2])).toEqual([false,false]);
 expect(notifier.send).toHaveBeenCalledTimes(1);
 expect(notifier.send.mock.calls[0][0]).toMatchObject({severity:'warning',subject:'Outreach guardrail check failed',dedupeKey:expect.stringMatching(/^growth:evaluate:\d{4}-\d{2}-\d{2}$/)});
});
it('a withdrawn hand-over or an already contacted business fails the action instead of settling it',async()=>{
 const store={claim:vi.fn()},growth={store,configured:()=>true,unsubscribeToken:()=> 't'};
 const exec=growthExecutors({growth,mail:{configured:true,send:vi.fn()},publicOrigin:'https://hub.example.org',postalAddress:'Test address'})['growth.message'];
 for(const status of ['outreach_off','business_contacted']) {store.claim.mockResolvedValueOnce({send:false,status});await expect(exec({id:'a',input:{messageId:'m'}})).rejects.toMatchObject({code:status});}
 store.claim.mockResolvedValueOnce({send:false,status:'cancelled'});expect(await exec({id:'a',input:{messageId:'m'}})).toEqual({delivery:'cancelled'});
});
it('markets only the owner\'s products: a CareBase prospect gets no discovery, research, plan or content while CareBase is in its pilot',async()=>{
 const search=vi.fn(async()=>[]);
 const store={discover:vi.fn(async()=>0)};
 const intelOnly=['caremetric-intel'];
 await growthHandlers({growth:{store,research:{configured:true,search}},marketed:intelOnly})['growth.discovery']({id:'t',agent:{autonomy:'propose'}});
 expect(search.mock.calls.map(([product])=>product)).toEqual(Array(discoveryQueriesPerDay).fill('caremetric-intel'));
 expect((await growthHandlers({growth:{store,research:{configured:true,search}},marketed:[]})['growth.discovery']({id:'t',agent:{autonomy:'propose'}})).result).toEqual({skipped:'no_marketed_product'});
 const intel={...base,id:'intel',product:'caremetric-intel'};
 const unassessed={...base,id:'carebase-new',stage:'identified',assessed_at:null};
 const sweep={snapshot:vi.fn(async()=>({total:3,items:[base,unassessed,intel]})),plan:vi.fn(async()=>'work'),assess:vi.fn()};
 const model={configured:true,run:vi.fn()};
 await growthHandlers({growth:{store:sweep},model,marketed:intelOnly})['growth.pipeline']({id:'task',agent:{autonomy:'propose'},kind:'growth.pipeline'});
 expect(sweep.plan.mock.calls.map(([id])=>id)).toEqual(['intel']);
 expect(model.run).not.toHaveBeenCalled();
 expect(sweep.assess).not.toHaveBeenCalled();
 // Customers are not marketing: a pilot facility's onboarding goes on.
 const pilot={...base,id:'pilot',owner_agent:'account_manager',stage:'trial',created_at:'2026-01-01T00:00:00Z'};
 const success={snapshot:vi.fn(async()=>({total:1,items:[pilot]})),plan:vi.fn(async()=>'work')};
 await growthHandlers({growth:{store:success},marketed:intelOnly})['growth.success']({id:'task',agent:{autonomy:'propose'},kind:'growth.success'});
 expect(success.plan).toHaveBeenCalledWith('pilot',expect.objectContaining({kind:'onboarding'}));
 const content={contentContext:vi.fn(async()=>({planned:false,policies:[{product:'carebase',approved_claim:'Staff training in one place.'}]}))};
 const research={configured:true,search:vi.fn(async()=>[])};
 expect((await growthHandlers({growth:{store:content,research},marketed:intelOnly})['growth.content']({id:'t',agent:{autonomy:'propose'},sourceKind:'schedule'})).result).toMatchObject({proposals:0});
 expect(research.search).not.toHaveBeenCalled();
});
it('sends a growth message as a letter: Hello, the approved words, the product team\'s sign-off and website, a preview and the unsubscribe link',()=>{
 const body='Your agency covers three counties. How do your liaisons track which physicians they have reached?\n\nYou can try it with your own team:\nhttps://www.caremetricintel.com/';
 const email=growthEmail({product:'caremetric-intel',subject:'Physician outreach',body,postalAddress:'1 Main St, Altoona, PA',unsubscribeUrl:'https://hub.example.org/api/growth/unsubscribe/t'});
 expect(email.text).toBe(`Hello,\n\n${body}\n\nThe CareMetric Intel team\nhttps://www.caremetricintel.com\n\nCareMetric\n1 Main St, Altoona, PA\nOpt out of these emails: https://hub.example.org/api/growth/unsubscribe/t`);
 expect(email.html).toContain('data-caremetric-email="letter"');
 expect(email.html).toContain('>Your agency covers three counties.&#847;');
 expect(email.html).toContain('<a href="https://www.caremetricintel.com/" target="_blank"');
 expect(email.html).toContain('<a href="https://hub.example.org/api/growth/unsubscribe/t" target="_blank"');
 // The company is named once when the postal address already begins with it.
 expect(growthEmail({product:'caremetric-intel',subject:'S',body:'B',postalAddress:'CareMetric, 1 Main St',unsubscribeUrl:'https://hub.example.org/u/t'}).text.endsWith('\n\nCareMetric, 1 Main St\nOpt out of these emails: https://hub.example.org/u/t')).toBe(true);
 // A CareBase page in an Intel message is never made a link.
 expect(growthEmail({product:'caremetric-intel',subject:'S',body:'See https://cmcarebase.com/signup',postalAddress:'',unsubscribeUrl:'https://hub.example.org/u/t'}).html).not.toContain('href="https://cmcarebase.com/signup"');
});
it('a growth email, quoted under a reply, never reads as a request to stop: no opt-out word the database matches is in it',async()=>{
 // private.growth_reply_reading leaves quoted lines and this footer out; the footer still avoids its stop words in case a mail
 // program quotes it in a way the reading does not recognise.
 const stopWords=/\b(unsubscribe|do not contact|stop emailing|remove me)\b/i;
 const store={claim:vi.fn(async()=>({send:true,to:'info@operator.example',id:'m',workId:'w',product:'caremetric-intel',purpose:'marketing',subject:'A question',body:'Which counties does your team cover?'})),finish:vi.fn()};
 const mail={configured:true,send:vi.fn(async()=>({delivery:'sent',id:'provider'}))};
 await growthExecutors({growth:{store,configured:()=>true,unsubscribeToken:()=>'a'.repeat(64)},mail,publicOrigin:'https://hub.example.org',postalAddress:'CareMetric, 1 Main St, Altoona, PA'})['growth.message']({id:'a',input:{messageId:'m'}});
 const sent=mail.send.mock.calls[0][0];
 expect(sent.unsubscribeUrl).toBe(`https://hub.example.org/api/growth/preferences/${'a'.repeat(64)}`);
 expect(sent.text).toContain(`Opt out of these emails: ${sent.unsubscribeUrl}`);
 expect(stopWords.test(sent.text)).toBe(false);
 expect(stopWords.test(sent.html.replace(/<[^>]+>/g,' '))).toBe(false);
});
it('signs prospect outreach with the founder\'s name and title, and a customer message with the product team (owner direction 2026-11-12)',()=>{
 const outreach=growthEmail({product:'caremetric-intel',purpose:'marketing',subject:'S',body:'I manage a home health and hospice company.',postalAddress:'',unsubscribeUrl:'https://hub.example.org/u/t'});
 expect(outreach.text).toContain('I manage a home health and hospice company.\n\nDr. Kevin C. Deyarmin\nFounder, CareMetric\nhttps://www.caremetricintel.com');
 expect(outreach.text).not.toContain('The CareMetric Intel team');
 const customer=growthEmail({product:'caremetric-intel',purpose:'success',subject:'S',body:'B',postalAddress:'',unsubscribeUrl:'https://hub.example.org/u/t'});
 expect(customer.text).toContain('B\n\nThe CareMetric Intel team\n');
 expect(customer.text).not.toContain('Deyarmin');
});
it('links a product page with well-formed campaign tags in a growth email, and never a tag that leads elsewhere',()=>{
 const tagged='https://www.caremetricintel.com/county-report?utm_source=caremetric&utm_medium=email&utm_campaign=growth-intel-touch1';
 const html=growthEmail({product:'caremetric-intel',subject:'S',body:`See your county:\n${tagged}`,postalAddress:'',unsubscribeUrl:'https://hub.example.org/u/t'}).html;
 expect(html).toContain(`href="${tagged.replaceAll('&','&amp;')}"`);
 const smuggled=`${tagged}&next=https://evil.example`;
 const refused=growthEmail({product:'caremetric-intel',subject:'S',body:`See:\n${smuggled}`,postalAddress:'',unsubscribeUrl:'https://hub.example.org/u/t'}).html;
 expect(refused).not.toContain('evil.example"');
 expect(refused).not.toMatch(/href="[^"]*evil\.example/);
});
it('greets a named contact by first name, never a role address',async()=>{
 const {greetingName}=await import('./worker.mjs');
 expect(greetingName('jane doe','enriched')).toBe('Jane');
 expect(greetingName('Pat Reader','inbound')).toBe('Pat');
 expect(greetingName('Jane D***','enriched')).toBe('Jane');
 expect(greetingName('Public business address','role_address')).toBeNull();
 expect(greetingName('','imported')).toBeNull();
 expect(greetingName('Dr.','imported')).toBeNull();
 const email=growthEmail({product:'caremetric-intel',purpose:'marketing',subject:'S',body:'Body.',postalAddress:'CareMetric, 1 Main St',unsubscribeUrl:'https://hub.example/x',greeting:'Jane'});
 expect(email.text).toMatch(/^Hello Jane,/m);
});
it('drafts outreach with the active memo while the owner\'s setting is on, reading it once a sweep, and stores its version',async()=>{
 const o={...base,product:'caremetric-intel',version:4,contact_id:'contact',contact_version:7,eligibility:'permitted',policy:{version:9,approved_claim:'Intel shows referral sources.'},evidence:[{id:'source',source_url:'https://example.org',claim:'A hospice.',observed_at:new Date().toISOString()}]};
 const sweep=async(enabled)=>{
  const store={snapshot:vi.fn(async()=>({total:2,items:[o,{...o,id:'next',organization_id:'org2'}]})),plan:vi.fn(async()=> 'work'),draft:vi.fn(async()=>({id:'message',status:'draft'})),propose:vi.fn(),
   learningActive:vi.fn(async()=>({version:5,memo:'- Shorter emails drew more replies.'}))};
  // A first email to an Intel agency is a free report and no question (here Intel's free county report: it has no roster report).
  const model={configured:true,run:vi.fn(async()=>({outcome:'completed',output:{subject:'A free report on your county',citations:['source'],needsHuman:false,
   body:'A free report on your county, built from Medicare and Census data, is one step away. Choose the state and county and it is emailed to you as a PDF:\nhttps://www.caremetricintel.com/county-report\n\nIt shows the hospitals your county\'s residents use most.'}}))};
  const growth={store,signingReady:true,hash:x=>x,unsubscribeToken:()=> 'token',learning:{enabled}};
  const outcome=await growthHandlers({growth,model,features:new Set([growthLearningFeature])})['growth.pipeline']({id:'task',agent:{autonomy:'propose'},kind:'growth.pipeline'});
  expect(outcome.result.rejected).toBeUndefined();
  return {store,model};
 };
 const on=await sweep(true);
 expect(on.store.learningActive).toHaveBeenCalledTimes(1);
 expect(on.store.learningActive).toHaveBeenCalledWith('caremetric-intel');
 expect(on.model.run.mock.calls[0][1].promptVersion).toBe('growth.22-m5');
 expect(on.store.draft).toHaveBeenCalledWith('opp','work',expect.objectContaining({memoVersion:5}));
 // The report-only form needs no switch: the sweep hands the writer none, and the email records its form.
 expect(on.store.draft.mock.calls[0][2].arms).toMatchObject({form:'short',length:'report'});
 expect(JSON.parse(on.model.run.mock.calls[0][1].user).style).toBe('Write two or three sentences, never more than 120 words.');
 const off=await sweep(false);
 expect(off.store.learningActive).not.toHaveBeenCalled();
 expect(off.model.run.mock.calls[0][1].promptVersion).toBe('growth.22');
 expect(off.store.draft.mock.calls[0][2].memoVersion).toBeUndefined();
});

describe('each cold touch to the organization\'s other decision-makers (20261115230000_growth_colleagues.sql)',()=>{
 const features=new Set(['platform.agents.growth-autonomy.v1',growthColleaguesFeature]);
 const fixture=()=>{
  const store={snapshot:vi.fn(async()=>({total:0,items:[]})),autoQualify:vi.fn(async()=>({qualified:0})),propose:vi.fn(async()=>({id:'action'})),
   colleagueCandidates:vi.fn(async()=>[{primaryId:'touch',workId:'work',contactId:'owner',product:'caremetric-intel'},{primaryId:'touch',workId:'work',contactId:'admin',product:'caremetric-intel'},
    {primaryId:'pilot',workId:'work-2',contactId:'other',product:'carebase'},{primaryId:'touch',workId:'work',contactId:'waiting',product:'caremetric-intel'}]),
   colleagueDraft:vi.fn(async(primary,contact)=>contact==='waiting'?{created:false,id:'m-waiting',status:'proposed',actionId:'a'}:{created:true,id:`m-${contact}`,status:'draft',actionId:null})};
  return {store,growth:{store,signingReady:true,hash:value=>`hash(${value})`,unsubscribeToken:key=>`token-${key}`}};
 };
 const sweep=(growth,{autonomy='act',kind='growth.pipeline',on=features}={})=>growthHandlers({growth,features:on,marketed:['caremetric-intel']})[kind]({id:'task',agent:{autonomy},kind});
 it('records each person as their own email with their own signed opt-out and proposes it like any message',async()=>{
  const {store,growth}=fixture();
  expect((await sweep(growth)).result).toMatchObject({colleagues:2});
  expect(store.colleagueCandidates).toHaveBeenCalledWith(colleagueLimit);
  // A product the owner is not marketing is left alone; one already proposed is not proposed again.
  expect(store.colleagueDraft.mock.calls).toEqual([['touch','owner','hash(token-work:owner)'],['touch','admin','hash(token-work:admin)'],['touch','waiting','hash(token-work:waiting)']]);
  expect(store.propose.mock.calls).toEqual([['task','m-owner'],['task','m-admin']]);
  expect(colleagueUnsubscribeKey('work','owner')).not.toBe(colleagueUnsubscribeKey('work','admin'));
  expect(JSON.stringify((await sweep(fixture().growth)).result)).not.toContain('@');
 });
 it('only with the feature, the signing key and a level above Observe, and only on the Marketing Manager\'s sweep',async()=>{
  const {store,growth}=fixture();
  await sweep(growth,{autonomy:'observe'});
  await sweep({...growth,signingReady:false});
  await sweep(growth,{on:new Set(['platform.agents.growth-autonomy.v1'])});
  await sweep(growth,{kind:'growth.success'});
  expect(store.colleagueCandidates).not.toHaveBeenCalled();
  expect((await sweep(growth)).result.colleagues).toBe(2);
 });
 it('a person who stopped being eligible since the list was read is skipped, and the sweep goes on',async()=>{
  const {store,growth}=fixture();
  store.colleagueDraft.mockImplementation(async(primary,contact)=>contact==='owner'?Promise.reject(Object.assign(new Error('Changed'),{code:'40001'}))
   :contact==='admin'?{created:false,reason:'not_chosen'}:{created:false,id:'m-waiting',status:'proposed',actionId:'a'});
  expect((await sweep(growth)).result.colleagues).toBeUndefined();
  expect(store.propose).not.toHaveBeenCalled();
  store.colleagueDraft.mockRejectedValue(new Error('database down'));
  await expect(sweep(growth)).rejects.toThrow('database down');
 });
 it('sends a colleague\'s email with that person\'s own opt-out link and greeting, and the touch\'s approved words',async()=>{
  const claimed={send:true,to:'owen.owner@agency.example',id:'m-owner',workId:'work',unsubscribeKey:'work:owner',unsubscribeHash:'hash(token-work:owner)',colleague:true,
   subject:'Your county\'s referrals',body:'The approved words.',product:'caremetric-intel',purpose:'marketing',contactName:'Owen Owner',sourceKind:'enriched'};
  const store={claim:vi.fn(async()=>claimed),finish:vi.fn()};
  const growth={store,configured:()=>true,hash:value=>`hash(${value})`,unsubscribeToken:key=>`token-${key}`},mail={configured:true,send:vi.fn(async()=>({delivery:'sent',id:'provider'}))};
  const exec=growthExecutors({growth,mail,publicOrigin:'https://hub.example.org',postalAddress:'CareMetric, 1 Main St'})['growth.message'];
  expect(await exec({id:'a',input:{messageId:'m-owner'}})).toEqual({delivery:'accepted'});
  const sent=mail.send.mock.calls[0][0];
  expect([sent.to,sent.messageId,sent.unsubscribeUrl]).toEqual(['owen.owner@agency.example','m-owner','https://hub.example.org/api/growth/preferences/token-work:owner']);
  expect(sent.text).toMatch(/^Hello Owen,/m); expect(sent.text).toContain('The approved words.');
  expect(store.finish).toHaveBeenCalledWith('m-owner','accepted','provider');
  // A claim that names no key (a database before this feature) signs the work alone, as before.
  store.claim.mockResolvedValue({...claimed,unsubscribeKey:undefined,unsubscribeHash:'hash(token-work)'});
  await exec({id:'a',input:{messageId:'m-owner'}});
  expect(mail.send.mock.calls[1][0].unsubscribeUrl).toBe('https://hub.example.org/api/growth/preferences/token-work');
  // A key the hash does not match is never sent.
  store.claim.mockResolvedValue({...claimed,unsubscribeHash:'hash(token-work)'});
  await expect(exec({id:'a',input:{messageId:'m-owner'}})).rejects.toMatchObject({code:'unsubscribe_key_changed'});
  expect(mail.send).toHaveBeenCalledTimes(2);
 });
});

it('never sends an email whose words a newer rule refuses: it is withdrawn, so the work is written again (email review 2026-11-17)',async()=>{
 // Queued while an Intel trial needed a card (2026-11-14 to 2026-11-23); it needs none now.
 const claimed={send:true,to:'info@operator.example',id:'m',workId:'w',product:'caremetric-intel',purpose:'marketing',subject:'Which referral sources are slipping?',body:'Try it free for 30 days. Credit card required.\nhttps://www.caremetricintel.com/'};
 const mail={configured:true,send:vi.fn(async()=>({delivery:'sent',id:'provider'}))};
 const store={claim:vi.fn(async()=>claimed),finish:vi.fn(async()=>true),withdraw:vi.fn(async()=>true)};
 const run=growth=>growthExecutors({growth:{configured:()=>true,unsubscribeToken:()=>'a'.repeat(64),...growth},mail,publicOrigin:'https://hub.example.org',postalAddress:'CareMetric, 1 Main St, Altoona, PA'})['growth.message']({id:'a',input:{messageId:'m'}});
 await expect(run({store})).resolves.toEqual({delivery:'withdrawn',reason:'trial_terms'});
 expect(store.withdraw).toHaveBeenCalledWith('m','trial_terms');
 expect(store.finish).not.toHaveBeenCalled();
 // A database without the withdrawal: the email is marked failed for the owner to see, and still never sent.
 const older={claim:vi.fn(async()=>claimed),finish:vi.fn(async()=>true),withdraw:vi.fn(async()=>{throw Object.assign(new Error('missing'),{code:'42883'});})};
 await expect(run({store:older})).rejects.toMatchObject({code:'outdated_words'});
 expect(older.finish).toHaveBeenCalledWith('m','failed',null);
 expect(mail.send).not.toHaveBeenCalled();
 // Words that pass today go out as before.
 const fine={claim:vi.fn(async()=>({...claimed,body:'Which counties does your team cover today?'})),finish:vi.fn(async()=>true),withdraw:vi.fn()};
 await expect(run({store:fine})).resolves.toEqual({delivery:'accepted'});
 expect(fine.withdraw).not.toHaveBeenCalled();
 expect(mail.send).toHaveBeenCalledTimes(1);
});
it('withdraws a queued prospect email that brings up how an Intel trial bills, and sends one that says no card is needed and a customer message about its end (owner decision 2026-11-23)',async()=>{
 // A prospect email names no card terms (owner direction 2026-11-17); one that does is written again, not sent.
 const body='You can try Intel free for 30 days. Add a card in Billing before the trial ends to keep your plan; it then bills automatically after the trial unless you cancel:\nhttps://www.caremetricintel.com/';
 const claimed={send:true,to:'info@operator.example',id:'m',workId:'w',product:'caremetric-intel',purpose:'marketing',subject:'Which referral sources are slipping?',body};
 const mail={configured:true,send:vi.fn(async()=>({delivery:'sent',id:'provider'}))};
 const run=store=>growthExecutors({growth:{configured:()=>true,unsubscribeToken:()=>'a'.repeat(64),store},mail,publicOrigin:'https://hub.example.org',postalAddress:'CareMetric, 1 Main St, Altoona, PA'})['growth.message']({id:'a',input:{messageId:'m'}});
 const store={claim:vi.fn(async()=>claimed),finish:vi.fn(async()=>true),withdraw:vi.fn(async()=>true)};
 await expect(run(store)).resolves.toEqual({delivery:'withdrawn',reason:'card_terms'});
 expect(store.withdraw).toHaveBeenCalledWith('m','card_terms');
 expect(mail.send).not.toHaveBeenCalled();
   // The same offer without the terms goes out, with or without "No credit card needed to start", and so does a customer's message that
 // says what happens when its trial ends.
 for(const over of [{body:'You can try Intel free for 30 days on one county:\nhttps://www.caremetricintel.com/'},{body:'You can try Intel free for 30 days on one county. No credit card needed to start.\nhttps://www.caremetricintel.com/'},{purpose:'success'},{product:'carebase'}]) {
  const fine={claim:vi.fn(async()=>({...claimed,...over})),finish:vi.fn(async()=>true),withdraw:vi.fn()};
  await expect(run(fine),JSON.stringify(Object.keys(over))).resolves.toEqual({delivery:'accepted'});
  expect(fine.withdraw).not.toHaveBeenCalled();
 }
 expect(mail.send).toHaveBeenCalledTimes(4);
});
it('withdraws a queued Intel email that offers the retired market review or asks for an agency\'s certification number, so it is written again (owner direction 2026-11-19)',async()=>{
 // Every first email to an agency without its own report pointed to the market review until 2026-11-19; one approved before then is
 // written again around the county report, not sent to a page that no longer asks for a CCN.
 const body='A free market report for Riverbend Home Health, built from Medicare data, is one step away. Enter your CMS certification number on this page and it is emailed to you as a PDF:\nhttps://www.caremetricintel.com/market-review?utm_source=caremetric&utm_medium=email&utm_campaign=growth-intel-touch1\n\nDoes your team know which agencies lead Riverton County?';
 const claimed={send:true,to:'info@operator.example',id:'m',workId:'w',product:'caremetric-intel',purpose:'marketing',subject:'Your Riverbend Home Health market report',body};
 const mail={configured:true,send:vi.fn(async()=>({delivery:'sent',id:'provider'}))};
 const run=store=>growthExecutors({growth:{configured:()=>true,unsubscribeToken:()=>'a'.repeat(64),store},mail,publicOrigin:'https://hub.example.org',postalAddress:'CareMetric, 1 Main St, Altoona, PA'})['growth.message']({id:'a',input:{messageId:'m'}});
 for(const over of [{},{body:'Find your agency report\nSearch by agency name and state. We’ll email your report.\nhttps://www.caremetricintel.com/market-review'},{purpose:'success',body:'Your free market report:\nhttps://www.caremetricintel.com/market-review'}]) {
  const store={claim:vi.fn(async()=>({...claimed,...over})),finish:vi.fn(async()=>true),withdraw:vi.fn(async()=>true)};
  await expect(run(store)).resolves.toEqual({delivery:'withdrawn',reason:'retired_page'});
  expect(store.withdraw).toHaveBeenCalledWith('m','retired_page');
 }
 expect(mail.send).not.toHaveBeenCalled();
 // The same email around the county report goes out.
 const fine={claim:vi.fn(async()=>({...claimed,body:'A free report on your county is one step away.\nhttps://www.caremetricintel.com/county-report'})),finish:vi.fn(async()=>true),withdraw:vi.fn()};
 await expect(run(fine)).resolves.toEqual({delivery:'accepted'});
 expect(fine.withdraw).not.toHaveBeenCalled();
});
it('sends a founder-signed email from the founder\'s name, and a customer message without one (owner decision 2026-11-17)',async()=>{
 const send=async claim=>{
  const store={claim:vi.fn(async()=>({send:true,to:'info@operator.example',id:'m',workId:'w',product:'caremetric-intel',subject:'A question',body:'Which counties does your team cover?',...claim})),finish:vi.fn()};
  const mail={configured:true,send:vi.fn(async()=>({delivery:'sent',id:'provider'}))};
  await growthExecutors({growth:{store,configured:()=>true,unsubscribeToken:()=>'a'.repeat(64)},mail,publicOrigin:'https://hub.example.org',postalAddress:'CareMetric, 1 Main St, Altoona, PA'})['growth.message']({id:'a',input:{messageId:'m'}});
  expect(mail.send).toHaveBeenCalledTimes(1);
  return mail.send.mock.calls[0][0];
 };
 // The same rule as the signature: prospect outreach and a quiet follow-up to a prospect are the founder's letters.
 const outreach=await send({purpose:'marketing'});
 expect(outreach.fromName).toBe('Dr. Kevin Deyarmin, CareMetric');
 expect(outreach.text).toContain('Dr. Kevin C. Deyarmin\nFounder, CareMetric');
 const quiet=await send({purpose:'success',quiet:true});
 expect(quiet.fromName).toBe('Dr. Kevin Deyarmin, CareMetric');
 expect(quiet.text).toContain('Dr. Kevin C. Deyarmin\nFounder, CareMetric');
 expect((await send({purpose:'marketing',product:'carebase'})).fromName).toBe('Dr. Kevin Deyarmin, CareMetric');
 // A customer's message comes from the product team, under the sender's own name: it names none.
 for(const claim of [{purpose:'success'},{purpose:'success',quiet:false},{}]) {
  const customer=await send(claim);
  expect(customer).not.toHaveProperty('fromName');
  expect(customer.text).toContain('The CareMetric Intel team');
  expect(customer.text).not.toContain('Deyarmin');
 }
 // Nothing else about the send changes with the name.
 expect(outreach).toMatchObject({to:'info@operator.example',subject:'A question',messageId:'m',unsubscribeUrl:`https://hub.example.org/api/growth/preferences/${'a'.repeat(64)}`});
});
// What a sent email's links look like: the sweep tags every product page a draft links (links.mjs tagLinks), and an agency's report link
// carries its own signed token.
const rosterLine={id:'r',source_url:'https://data.cms.gov/provider-characteristics/hospitals-and-other-facilities/provider-of-services-file',observed_at:new Date().toISOString(),confidence:'high',
 claim:'CMS Provider of Services file, 2026Q3: Riverbend Home Health (CCN 397001) is a Medicare-certified home health agency in Riverton, PA; certified June 27, 2024.'};
const tagsOf=touch=>`utm_source=caremetric&utm_medium=email&utm_campaign=growth-intel-touch${touch}&utm_content=web`;
const anchorOf=(html,url)=>new RegExp(`<a href="${url.replaceAll('&','&amp;').replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}"[^>]*>([^<]*)</a>`).exec(html)?.[1]??null;
it('shows a link on a line of its own by a short label in the HTML part, and keeps the address in the text part (email review 2026-11-17)',async()=>{
 const {linkLabels}=await import('./worker.mjs');
 const {reportLinks}=await import('./report-link.mjs');
 const reports=reportLinks({key:'k'.repeat(40)});
 const link=reports.linkFor({id:'o1',product:'caremetric-intel',name:'Riverbend Home Health',evidence:[rosterLine]});
 const trial=`https://www.caremetricintel.com/?${tagsOf(2)}`;
 const body=`One page of the report lists the hospitals your county's residents use.\n${link.url}\n\nYou can try it free for 30 days on one county:\n${trial}`;
 const email=growthEmail({product:'caremetric-intel',purpose:'marketing',subject:'The hospitals your county uses',body,postalAddress:'',unsubscribeUrl:'https://hub.example.org/u/t',reports});
 // The report: what it is, never its 100 characters of token.
 expect(anchorOf(email.html,link.url)).toBe('Open your agency&#39;s market report (PDF)');
 expect(email.html).not.toContain(`>${link.url}<`);
 // The trial: the playbook's own name for the product's next step.
 expect(anchorOf(email.html,trial)).toBe('Start a CareMetric Intel free trial');
 expect(email.html).not.toContain('utm_campaign=growth-intel-touch2&amp;utm_content=web<');
 // The plain-text part keeps both addresses, bare, on their own lines.
 expect(email.text).toContain(`residents use.\n${link.url}\n\nYou can try it free for 30 days on one county:\n${trial}\n\nDr. Kevin C. Deyarmin`);
 expect(email.text).not.toMatch(/Open your agency|Start a CareMetric Intel free trial/);
 expect(linkLabels('caremetric-intel',body,reports)).toEqual({[link.url]:'Open your agency\'s market report (PDF)',[trial]:'Start a CareMetric Intel free trial'});
 // Any other product page by its own label: Intel's free county report among them. The retired market review is no page of Intel's
 // any more (2026-11-19), so it gets no label and no link.
 const review=`https://www.caremetricintel.com/market-review?${tagsOf(1)}`, county=`https://www.caremetricintel.com/county-report?${tagsOf(2)}`;
 const pages=growthEmail({product:'caremetric-intel',purpose:'marketing',subject:'S',body:`Get it here:\n${county}\n\nOr:\n${review}`,postalAddress:'',unsubscribeUrl:'https://hub.example.org/u/t'});
 expect(anchorOf(pages.html,county)).toBe('Free county report from CareMetric Intel');
 expect(pages.html).not.toContain(`href="${review.replaceAll('&','&amp;')}"`);
 expect(linkLabels('caremetric-intel',`${county}\n${review}`,null)).toEqual({[county]:'Free county report from CareMetric Intel'});
 const carebase=`https://cmcarebase.com/signup?utm_source=caremetric&utm_medium=email&utm_campaign=growth-carebase-touch1&utm_content=web`;
 expect(anchorOf(growthEmail({product:'carebase',purpose:'marketing',subject:'S',body:`Try it:\n${carebase}`,postalAddress:'',unsubscribeUrl:'https://hub.example.org/u/t'}).html,carebase)).toBe('Start a CareBase free trial');
 // A link inside a sentence keeps its address as its words, and a label never makes a link of an address the email may not link.
 const inline=growthEmail({product:'caremetric-intel',subject:'S',body:`See ${trial} today.`,postalAddress:'',unsubscribeUrl:'https://hub.example.org/u/t'}).html;
 expect(anchorOf(inline,trial)).toBe(trial.replaceAll('&','&amp;'));
 expect(linkLabels('caremetric-intel',`${link.url}\nhttps://cmcarebase.com/signup\nhttps://evil.example/`,null)).toEqual({});
 const unverified=growthEmail({product:'caremetric-intel',subject:'S',body:`Your report:\n${link.url}`,postalAddress:'',unsubscribeUrl:'https://hub.example.org/u/t'}).html;
 expect(unverified).not.toContain(`href="${link.url}"`);
 expect(unverified).not.toContain('Open your agency');
 const forged=growthEmail({product:'caremetric-intel',subject:'S',body:`Your report:\n${link.url.slice(0,-4)}AAAA`,postalAddress:'',unsubscribeUrl:'https://hub.example.org/u/t',reports}).html;
 expect(forged).not.toContain('Open your agency');
});
it('labels a product page written without campaign tags too',async()=>{
 // An email's product links are tagged when it is written, but one the owner edits, or wrote before tags, may carry a bare page.
 const {linkLabels}=await import('./worker.mjs');
 expect(linkLabels('caremetric-intel','Try it:\nhttps://www.caremetricintel.com/\n\nOr:\nhttps://www.caremetricintel.com/county-report',null))
  .toEqual({'https://www.caremetricintel.com/':'Start a CareMetric Intel free trial','https://www.caremetricintel.com/county-report':'Free county report from CareMetric Intel'});
 expect(linkLabels('carebase','https://cmcarebase.com/signup',null)).toEqual({'https://cmcarebase.com/signup':'Start a CareBase free trial'});
});
it('takes the inbox preview from the first real sentence, past an abbreviation in an agency\'s name (email review 2026-11-17)',async()=>{
 const {firstSentence}=await import('./worker.mjs');
 expect(firstSentence('I put together a free market report for St. Luke\'s Home Health from Medicare data. It opens as a PDF.')).toBe('I put together a free market report for St. Luke\'s Home Health from Medicare data.');
 expect(firstSentence('I wrote to Dr. Phillips Home Care, Inc. about its county. Second sentence.')).toBe('I wrote to Dr. Phillips Home Care, Inc. about its county.');
 expect(firstSentence('Mt. Carmel Hospice serves Erie County. Next.')).toBe('Mt. Carmel Hospice serves Erie County.');
 expect(firstSentence('A. J. Smith Home Health serves two counties. Next.')).toBe('A. J. Smith Home Health serves two counties.');
 expect(firstSentence('Does it match what your team sees? Reply either way.')).toBe('Does it match what your team sees?');
 // A line with no sentence end gives no preview, as before; so does nothing at all.
 expect(firstSentence('It opens as a PDF, with nothing to sign up for:')).toBe('');
 for(const nothing of ['',null,undefined])expect(firstSentence(nothing)).toBe('');
 // In the email: the first email's opening sentence, whole, is the line an inbox shows beside the subject.
 const body='I put together a free market report for St. Luke\'s Home Health, Inc. from Medicare data. It opens as a PDF, with nothing to sign up for:\nhttps://www.caremetricintel.com/county-report\n\nDoes it match what your team sees in the field?';
 const email=growthEmail({product:'caremetric-intel',purpose:'marketing',subject:'St. Luke\'s market report',body,postalAddress:'',unsubscribeUrl:'https://hub.example.org/u/t'});
 expect(email.html).toContain('>I put together a free market report for St. Luke&#39;s Home Health, Inc. from Medicare data.&#847;');
 expect(email.html).not.toContain('>I put together a free market report for St.&#847;');
});
// Email review 2026-11-17, the owner on the plain letter: "something that I'd throw away without even reading", "there's no explanation of
// what else the software does". The three emails to an agency are laid out in Intel's own look, with what the software does and the trial.
it('lays a marketing email to an Intel agency out in Intel\'s look, with what the software does and the trial, and keeps the text part the approved words',async()=>{
 const {reportLinks}=await import('./report-link.mjs');
 const {withCampaign,founderQuote,campaignCopy}=await import('./campaign.mjs');
 // Riverbend is a home health agency, so its emails are a home health agency's.
 const {featurePoints,weekSteps,shortPoints}=campaignCopy('home_health');
 const reports=reportLinks({key:'k'.repeat(40)});
 const link=reports.linkFor({id:'o1',product:'caremetric-intel',name:'Riverbend Home Health',evidence:[rosterLine]});
 const trialOf=touch=>`https://www.caremetricintel.com/?${tagsOf(touch)}`;
 const send=(body,over={})=>growthEmail({product:'caremetric-intel',purpose:'marketing',subject:'Riverbend Home Health\'s market report',body,postalAddress:'CareMetric, 100 Example Way',
  unsubscribeUrl:'https://hub.example.org/u/t',greeting:'Jane',reports,...over});
 const count=(text,part)=>text.split(part).length-1;
 const escaped=text=>text.replaceAll('\'','&#39;');

 // The first email: the report, then what the software does, the founder's words and the trial.
 const opening=`I put together a free market report for Riverbend Home Health from Medicare data. It shows where the agency stands in its county and who to call on next.\n${link.url}`;
 const body=withCampaign(opening,1,{trialUrl:trialOf(1),reportUrl:link.url,ownReport:true,setting:'home_health'});
 const first=send(body);
 expect(first.html).toContain('data-caremetric-email="branded"');
 expect(first.html).toContain('>YOUR FREE MARKET REPORT IS READY</p>');
 expect(first.html).toMatch(/<h1[^>]*>Riverbend Home Health&#39;s market report<\/h1>/);
 expect(first.html).toContain('Hello Jane,');
 expect(first.html).toContain('I put together a free market report for Riverbend Home Health from Medicare data.');
 // The report is a card with one button, never 100 characters of token in the text.
 expect(anchorOf(first.html,link.url)).toBe('Open your market report →');
 expect(count(first.html,`href="${link.url}"`)).toBe(1);
 expect(first.html).not.toContain(`>${link.url}<`);
 for(const tile of ['WHERE YOU STAND','WHO LEADS THE COUNTY','TOP HOSPITALS','TOP PHYSICIANS FOR OUTREACH'])expect(first.html).toContain(tile);
 for(const [title,text] of featurePoints){expect(first.html).toContain(escaped(title));expect(first.html).toContain(escaped(text));}
 for(const figure of ['150+','Every NPI','3,200+','Daily'])expect(first.html).toContain(`>${figure}</p>`);
 expect(first.html).toContain(`&ldquo;${founderQuote}&rdquo;`);
 expect(anchorOf(first.html,trialOf(1))).toBe('Start your free trial →');
 // The founder's words are signed once, under the quote.
 expect(count(first.html,'Dr. Kevin C. Deyarmin')).toBe(1);
 expect(first.html).toContain('CareMetric, 100 Example Way');
 expect(anchorOf(first.html,'https://hub.example.org/u/t')).not.toBeNull();
 // The text part is the email as it was approved, word for word, signed and with its links written out.
 expect(first.text.startsWith(`Hello Jane,\n\n${body}\n\nDr. Kevin C. Deyarmin\nFounder, CareMetric\n`)).toBe(true);
 expect(first.text).toContain(link.url);
 expect(first.text).toContain(trialOf(1));

 // The second email: a week of the work, the offer and the trial, with the report still one click away.
 const second=send(withCampaign('The market report I sent for Riverbend Home Health lists the hospitals its county\'s residents use.\n\nHow does your team decide who to visit each week?',2,
  {trialUrl:trialOf(2),reportUrl:link.url,ownReport:true,setting:'home_health'}),{subject:'From the report to a week\'s plan'});
 expect(second.html).toContain('>FROM YOUR MARKET REPORT TO A PLAN</p>');
 for(const step of weekSteps){expect(second.html).toContain(step.tag.toUpperCase());expect(second.html).toContain(escaped(step.title));}
 expect(second.html).toContain('>FOUNDING MEMBER PRICING</p>');
 expect(second.html).toContain('Your price never goes up');
 expect(anchorOf(second.html,trialOf(2))).toBe('Start your free trial →');
 expect(anchorOf(second.html,link.url)).toBe('Open your market report (PDF)');
 expect(count(second.html,'Dr. Kevin C. Deyarmin')).toBe(1);
 expect(second.html).not.toMatch(/opened|clicked|noticed/i);

 // The third email: short, with the report, three lines on the software and the trial as a link.
 const third=send(withCampaign('This is my last note. The market report for Riverbend Home Health stays where it is.',3,{trialUrl:trialOf(3),reportUrl:link.url,ownReport:true,setting:'home_health'}),{subject:'A last note'});
 expect(third.html).toContain('>A LAST NOTE</p>');
 expect(anchorOf(third.html,link.url)).toBe('Open your market report →');
 for(const [lead] of shortPoints)expect(third.html).toContain(escaped(lead));
 expect(anchorOf(third.html,trialOf(3))).toBe('start a 30-day free trial on one county');

 // An agency with no report of its own is sent to Intel's free county report (2026-11-19).
 const page='https://www.caremetricintel.com/county-report';
 const review=send(withCampaign(`A free report on the county Riverbend Home Health serves is one step away, built from Medicare and Census data.\n${page}`,1,{trialUrl:trialOf(1),reportUrl:page,ownReport:false}));
 expect(anchorOf(review.html,page)).toBe('Get your free county report →');
 expect(review.html).toContain('Choose your state and county and it is emailed to you as a PDF.');
 expect(review.html).not.toMatch(/certification number|market-review/i);

 // Each kind of business reads about its own: a home health agency about home health agencies, a hospice about hospices.
 expect(first.html).toContain('What CareMetric Intel does for your home health agency, every day');
 expect(first.html).toContain('>HOME HEALTH MARKET REPORT</p>');
 expect(first.html).toContain('Every home health agency in your territory, ranked by Medicare share.');
 const hospice=send(withCampaign(opening.replace('Riverbend Home Health','Riverbend Hospice'),1,{trialUrl:trialOf(1),reportUrl:link.url,ownReport:true,setting:'hospice'}));
 expect(hospice.html).toContain('What CareMetric Intel does for your hospice, every day');
 expect(hospice.html).toContain('>HOSPICE MARKET REPORT</p>');
 expect(hospice.html).toContain('Every hospice in your territory, ranked by Medicare share.');
 expect(hospice.html).not.toMatch(/home health agenc/i);
 // A nursing home's email has no report card or report button; the trial is its one bright button.
 const nursing=send(withCampaign('CareMetric Intel shows an admissions team which hospitals its county\'s residents use.\n\nHow does your team decide which hospitals to visit?',1,
  {trialUrl:trialOf(1),setting:'nursing_home'}),{subject:'Hospital sources for Sunrise Nursing Center'});
 expect(nursing.html).toContain('data-caremetric-email="branded"');
 expect(nursing.html).toContain('>FOR YOUR ADMISSIONS AND MARKETING TEAM</p>');
 expect(nursing.html).toContain('What CareMetric Intel does for your nursing home, every day');
 expect(nursing.html).toContain('Finds your hospital sources');
 expect(nursing.html).toContain('Every nursing home in your territory, ranked by Medicare share');
 expect(nursing.html).not.toMatch(/market report|MARKET REPORT|hospices? in your territory|home health agenc/);
 expect(anchorOf(nursing.html,trialOf(1))).toBe('Start your free trial \u2192');

 // Anything else stays the plain letter: sections someone edited, an email that is not marketing, another product, and a letter with no sections.
 const letterOf=email=>expect(email.html).toContain('data-caremetric-email="letter"');
 const edited=send(body.replace('Watches your competition','Beats your competition'));
 letterOf(edited);
 expect(edited.html).toContain('Beats your competition');
 letterOf(send(body,{purpose:'success'}));
 letterOf(send(body,{product:'carebase'}));
 letterOf(send(opening));
});
it('signs a quiet follow-up to a prospect as the founder, like the rest of the prospect\'s emails, and a customer email as the team',async()=>{
 const quiet=growthEmail({product:'caremetric-intel',purpose:'success',quiet:true,subject:'S',body:'Did our answer cover what you needed?',postalAddress:'',unsubscribeUrl:'https://hub.example.org/u/t'});
 expect(quiet.text).toContain('Did our answer cover what you needed?\n\nDr. Kevin C. Deyarmin\nFounder, CareMetric\n');
 expect(quiet.text).not.toContain('The CareMetric Intel team');
 // The send claim says which email is a quiet follow-up (20261117220000_email_review.sql); without it, the team signs as before.
 const store={claim:vi.fn(async()=>({send:true,to:'jane@operator.example',id:'m',workId:'w',product:'caremetric-intel',purpose:'success',quiet:true,subject:'S',body:'Did our answer cover what you needed?'})),finish:vi.fn(async()=>true)};
 const mail={configured:true,send:vi.fn(async()=>({delivery:'sent',id:'provider'}))};
 await growthExecutors({growth:{store,configured:()=>true,unsubscribeToken:()=>'a'.repeat(64)},mail,publicOrigin:'https://hub.example.org',postalAddress:'CareMetric, 1 Main St, Altoona, PA'})['growth.message']({id:'a',input:{messageId:'m'}});
 expect(mail.send.mock.calls[0][0].text).toContain('Dr. Kevin C. Deyarmin');
});
