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
it('dedupes growth notices on the Eastern day, including after UTC midnight',async()=>{
 expect(growthDay(new Date('2026-11-08T03:30:00Z'))).toBe('2026-11-07');
 expect(growthDay(new Date('2026-07-15T03:30:00Z'))).toBe('2026-07-14');
 const store={snapshot:vi.fn(async()=>({total:1,items:[base]})),plan:vi.fn(async()=>'work')};
 const notifier={send:vi.fn(async()=>[])};
 await growthHandlers({growth:{store},notifier})['growth.pipeline']({id:'task',agent:{autonomy:'propose'},kind:'growth.pipeline'},{now:()=>new Date('2026-11-08T03:30:00Z')});
 expect(notifier.send.mock.calls[0][0].dedupeKey).toBe('growth:marketing_manager:2026-11-07');
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
 const outreach=growthEmail({product:'caremetric-intel',purpose:'marketing',subject:'S',body:'I run a home health and hospice agency.',postalAddress:'',unsubscribeUrl:'https://hub.example.org/u/t'});
 expect(outreach.text).toContain('I run a home health and hospice agency.\n\nDr. Kevin C. Deyarmin\nFounder, CareMetric\nhttps://www.caremetricintel.com');
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
  const model={configured:true,run:vi.fn(async()=>({outcome:'completed',output:{subject:'Referral sources',body:'Which hospitals send your agency the most patients? Reply to this email and we will send the steps.',citations:['source'],needsHuman:false}}))};
  const growth={store,signingReady:true,hash:x=>x,unsubscribeToken:()=> 'token',learning:{enabled}};
  const outcome=await growthHandlers({growth,model,features:new Set([growthLearningFeature])})['growth.pipeline']({id:'task',agent:{autonomy:'propose'},kind:'growth.pipeline'});
  expect(outcome.result.rejected).toBeUndefined();
  return {store,model};
 };
 const on=await sweep(true);
 expect(on.store.learningActive).toHaveBeenCalledTimes(1);
 expect(on.store.learningActive).toHaveBeenCalledWith('caremetric-intel');
 expect(on.model.run.mock.calls[0][1].promptVersion).toBe('growth.14-m5');
 expect(on.store.draft).toHaveBeenCalledWith('opp','work',expect.objectContaining({memoVersion:5}));
 const off=await sweep(false);
 expect(off.store.learningActive).not.toHaveBeenCalled();
 expect(off.model.run.mock.calls[0][1].promptVersion).toBe('growth.14');
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
