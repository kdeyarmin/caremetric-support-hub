import {it,expect,vi} from 'vitest';
import {growthDay,growthEmail,growthExecutors,growthHandlers} from './worker.mjs';
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
 expect(await exec({id:'a',input:{messageId:'m'}})).toEqual({delivery:'accepted'});expect(mail.send.mock.calls[0][0].text).toContain('/api/growth/unsubscribe/token');expect(store.finish).toHaveBeenCalledWith('m','accepted','provider');
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
 expect(outcome.result).toEqual({candidates:2,contacts:{searched:3,found:1,none:2},qualified:1});
 expect(store.recordContact.mock.calls).toEqual([['org-a','info@a.example','https://a.example/contact'],['org-b',null,null],['org-c',null,null]]);
 expect(JSON.stringify(outcome)).not.toContain('@');
 // A refused address (the database's own domain check) is recorded as nothing found.
 store.recordContact.mockReset().mockRejectedValueOnce(Object.assign(new Error('off domain'),{code:'22023'})).mockResolvedValue({found:false});
 store.contactCandidates.mockResolvedValue([{id:'org-a',domain:'a.example'}]);
 expect((await growthHandlers({growth,features:autonomy})['growth.discovery']({id:'t',agent:{autonomy:'propose'}})).result.contacts).toEqual({searched:1,found:0,none:1});
 expect(store.recordContact.mock.calls[1]).toEqual(['org-a',null,null]);
 // Without the feature, or in Observe, no website is read.
 contacts.find.mockClear();
 await growthHandlers({growth})['growth.discovery']({id:'t',agent:{autonomy:'propose'}});
 await growthHandlers({growth,features:autonomy})['growth.discovery']({id:'t',agent:{autonomy:'observe'}});
 expect(contacts.find).not.toHaveBeenCalled();
});
it('discovery searches a new Pennsylvania place for CareBase each day instead of the same query',async()=>{
 const store={discover:vi.fn(async()=>0)};
 const search=vi.fn(async()=>[]);
 const handlers=growthHandlers({growth:{store,research:{configured:true,search}}});
 await handlers['growth.discovery']({id:'t',agent:{autonomy:'propose'}},{now:()=>new Date('2026-11-08T13:00:00Z')});
 await handlers['growth.discovery']({id:'t',agent:{autonomy:'propose'}},{now:()=>new Date('2026-11-09T13:00:00Z')});
 const queries=search.mock.calls.map(([product,options])=>[product,options.query]);
 expect(queries.filter(([product])=>product==='carebase').every(([,query])=>/ PA$/.test(query))).toBe(true);
 expect(new Set(queries.map(([,query])=>query)).size).toBe(4);
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
 expect(search.mock.calls.map(([product])=>product)).toEqual(['caremetric-intel']);
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
 expect(email.text).toBe(`Hello,\n\n${body}\n\nThe CareMetric Intel team\nhttps://www.caremetricintel.com\n\nCareMetric\n1 Main St, Altoona, PA\nUnsubscribe from these emails: https://hub.example.org/api/growth/unsubscribe/t`);
 expect(email.html).toContain('data-caremetric-email="letter"');
 expect(email.html).toContain('>Your agency covers three counties.&#847;');
 expect(email.html).toContain('<a href="https://www.caremetricintel.com/" target="_blank"');
 expect(email.html).toContain('<a href="https://hub.example.org/api/growth/unsubscribe/t" target="_blank"');
 // The company is named once when the postal address already begins with it.
 expect(growthEmail({product:'caremetric-intel',subject:'S',body:'B',postalAddress:'CareMetric, 1 Main St',unsubscribeUrl:'https://hub.example.org/u/t'}).text.endsWith('\n\nCareMetric, 1 Main St\nUnsubscribe from these emails: https://hub.example.org/u/t')).toBe(true);
 // A CareBase page in an Intel message is never made a link.
 expect(growthEmail({product:'caremetric-intel',subject:'S',body:'See https://cmcarebase.com/signup',postalAddress:'',unsubscribeUrl:'https://hub.example.org/u/t'}).html).not.toContain('href="https://cmcarebase.com/signup"');
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
