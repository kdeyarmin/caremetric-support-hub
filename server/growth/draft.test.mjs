import {it,expect,vi} from 'vitest';
import {draftMessage,draftProblem,growthSystem,messageArms} from './draft.mjs';
import {assessProspect} from './assessment.mjs';
const now=new Date().toISOString();
const opportunity={id:'o',product:'carebase',version:1,contact_id:'c',goal:'Staff training',policy:{approved_claim:'CareBase supports facility training.',booking_url:'https://example.org/book'},evidence:[{id:'source-1',source_url:'https://example.org',observed_at:now,claim:'A personal-care facility',confidence:'high'}],events:[]};
const work={kind:'outreach',action:'Offer a conversation',success:'Qualified response'};
it('never invents a product claim when the policy has none',async()=>{expect(await draftMessage({opportunity:{...opportunity,policy:{}},work,task:{}})).toBeNull();});
it('a template contains only reviewed product facts',async()=>{const draft=await draftMessage({opportunity,work,task:{}});expect(draft).toMatchObject({modelGenerated:false,citations:['source-1']});expect(draft.body).toContain(opportunity.policy.approved_claim);expect(draft.body).not.toMatch(/guarantee|discount/i);});
it('rejects model citations and links outside its evidence',async()=>{
 const model={configured:true,run:vi.fn(async()=>({outcome:'completed',output:{subject:'Hello',body:'Visit https://unapproved.example',citations:['source-1'],needsHuman:false}}))};
 expect(await draftMessage({opportunity,work,task:{},model})).toBeNull();
 model.run.mockResolvedValue({outcome:'completed',output:{subject:'Hello',body:'A useful next step?',citations:['invented'],needsHuman:false}});expect(await draftMessage({opportunity,work,task:{},model})).toBeNull();
});
it('model-generated drafts are labeled for mandatory human review',async()=>{
 const model={configured:true,run:vi.fn(async()=>({outcome:'completed',output:{subject:'Training',body:'Would a conversation help?',citations:['source-1'],needsHuman:false}}))};
 expect(await draftMessage({opportunity,work,task:{},model})).toMatchObject({modelGenerated:true});
});
it('fit assessment cannot turn model opinion into buying intent',async()=>{
 const model={configured:true,run:vi.fn(async()=>({outcome:'completed',output:{fit:70,rationale:'Evidence fits the product audience.',citations:['source-1'],nextAction:'Verify the buyer role.'}}))};
 expect(await assessProspect(opportunity,{},model)).toMatchObject({fit:70,intent:null});
 expect(await assessProspect({...opportunity,events:[{kind:'positive_reply'}]}, {},model)).toMatchObject({intent:75});
});
it('tells the writer which touch it is writing, the playbook angle for it and the pages it may link to',async()=>{
 const model={configured:true,run:vi.fn(async()=>({outcome:'completed',output:{subject:'Staff training records',body:'How do you track annual training hours today?\n\nhttps://cmcarebase.com/signup',citations:['source-1'],needsHuman:false}}))};
 const draft=await draftMessage({opportunity:{...opportunity,touches:1,policy:{...opportunity.policy,max_touches:3}},work,task:{},model});
 expect(draft).toMatchObject({modelGenerated:true});
 const request=model.run.mock.calls[0][1];
 const input=JSON.parse(request.user);
 expect(input).toMatchObject({touch:2,maxTouches:3});
 expect(input.touchPlan).toMatch(/different angle/);
 expect(input.links.map(link=>link.url)).toContain('https://cmcarebase.com/signup');
 expect(input.links.map(link=>link.url)).not.toContain('https://www.caremetricintel.com/');
 expect(request.system[0].text).toContain('CareMetric fact sheet');
 expect(request.system[0].text).toContain('sales playbook');
 expect(request.promptVersion).toBe('growth.14');
 // No booking page is ever offered to the writer (no personal demos with anyone, owner decision 2026-11-09).
 expect(input.bookingUrl).toBeUndefined();
 expect(input.links.map(link=>link.url)).not.toContain(opportunity.policy.booking_url);
});
it('gives a customer-success message the play for its moment instead of a touch',async()=>{
 const model={configured:true,run:vi.fn(async()=>({outcome:'completed',output:{subject:'Before your trial ends',body:'What is left to decide before your trial ends?',citations:[],needsHuman:false}}))};
 expect(await draftMessage({opportunity:{...opportunity,stage:'trial'},work:{kind:'trial',action:'Review trial progress',success:'Decision'},task:{},model})).toMatchObject({modelGenerated:true});
 const input=JSON.parse(model.run.mock.calls[0][1].user);
 expect(input.play).toMatch(/Founders Sale/);
 expect(input.touch).toBeUndefined();
});
it('refuses drafts that break the fact sheet or claim rules, and fixes the vocabulary it can',async()=>{
 const run=output=>draftMessage({opportunity,work,task:{},model:{configured:true,run:async()=>({outcome:'completed',output:{subject:'Training',citations:['source-1'],needsHuman:false,...output}})}});
 expect(await run({body:'CareBase is $59 per facility. Interested?'})).toBeNull();
 expect(await run({body:'CareBase ensures compliance with every survey.'})).toBeNull();
 expect(await run({body:'Better than Yardi for your home. Interested?'})).toBeNull();
 expect(await run({body:'Start here: https://www.caremetricintel.com/'})).toBeNull();
 expect(await run({subject:'Re: training',body:'Would a free trial help?'})).toBeNull();
 expect(await run({body:'Would a **free trial** help?'})).toBeNull();
 expect((await run({body:'Built for every Assisted Living Residence and ready for the auditor.'}))?.body).toBe('Built for every Assisted Living Facility and ready for the surveyor.');
 expect((await run({body:'CareBase Core is $199 per facility per month, with a 30-day free trial.\n\nhttps://cmcarebase.com/signup.'}))?.modelGenerated).toBe(true);
});
it('never offers a call, a meeting or a demo: templates point to the free trial and invite a reply (owner decisions 2026-11-08 and 2026-11-09)',async()=>{
 const outreach=await draftMessage({opportunity,work,task:{}});
 expect(outreach.body).toContain('https://cmcarebase.com/signup');
 expect(outreach.body).not.toContain(opportunity.policy.booking_url);
 for(const kind of ['onboarding','activation','trial','adoption','renewal','support','recovery','expansion']){
  const draft=await draftMessage({opportunity,work:{kind,action:'x',success:'y'},task:{}});
  expect(draft.body,kind).not.toMatch(/conversation|call|meeting|demo|a suitable time|https?:/i);
 }
 const model={configured:true,run:vi.fn(async()=>({outcome:'completed',output:{subject:'Training',body:'Would it help?',citations:['source-1'],needsHuman:false}}))};
 await draftMessage({opportunity,work,task:{},model});
 expect(model.run.mock.calls[0][1].system[0].text).toContain('never offer or suggest a phone call, a sales call, a meeting, a conversation, a chat or a demo, and never ask for a time to talk. CareMetric does no personal demos with anyone.');
 expect(model.run.mock.calls[0][1].system[0].text).not.toContain('bookingUrl');
 expect(model.run.mock.calls[0][1].system[0].text).toContain('Never offer or suggest a demo, a sales call or a meeting.');
});
it('tags the product links of a passing outreach draft with its touch',async()=>{
 const model={configured:true,run:vi.fn(async()=>({outcome:'completed',output:{subject:'Staff training records',body:'How do you track annual training hours today?\n\nhttps://cmcarebase.com/signup',citations:['source-1'],needsHuman:false}}))};
 const draft=await draftMessage({opportunity:{...opportunity,touches:1},work,task:{},model});
 expect(draft.body).toBe('How do you track annual training hours today?\n\nhttps://cmcarebase.com/signup?utm_source=caremetric&utm_medium=email&utm_campaign=growth-carebase-touch2&utm_content=web');
});
it('accepts a draft whose product link already carries well-formed tags, and refuses a tag that leads elsewhere',async()=>{
 const run=body=>draftMessage({opportunity,work,task:{},model:{configured:true,run:async()=>({outcome:'completed',output:{subject:'Staff training records',body,citations:['source-1'],needsHuman:false}})}});
 expect((await run('Try it free:\nhttps://cmcarebase.com/signup?utm_source=x&utm_medium=y&utm_campaign=z'))?.body).toBe('Try it free:\nhttps://cmcarebase.com/signup?utm_source=caremetric&utm_medium=email&utm_campaign=growth-carebase-touch1&utm_content=web');
 expect(await run('Try it free:\nhttps://evil.example/?utm_source=x&utm_medium=y&utm_campaign=z')).toBeNull();
 expect(await run('Try it free:\nhttps://cmcarebase.com/signup?utm_source=x&utm_medium=y&utm_campaign=z&next=https://evil.example')).toBeNull();
});
it('refuses a tag that carries another host, path or parameter, and any booking page',async()=>{
 const run=body=>draftMessage({opportunity,work,task:{},model:{configured:true,run:async()=>({outcome:'completed',output:{subject:'Training',citations:['source-1'],needsHuman:false,body}})}});
 expect(await run('Try it: https://cmcarebase.com/signup?utm_source=a&next=https://evil.test')).toBeNull();
 expect(await run('Try it: https://cmcarebase.com/admin?utm_source=caremetric')).toBeNull();
 expect(await run('Try it: https://evil.test/signup?utm_source=caremetric')).toBeNull();
 expect(await run('Try it: https://cmcarebase.com/signup?utm_source=evil.test')).toBeNull();
 expect(await run('Book: https://example.org/book?utm_source=caremetric')).toBeNull();
 expect(await run('Book: https://example.org/book')).toBeNull();
});
it('refuses a draft that offers a conversation, a call, a meeting or a demo, and accepts one that declines a demo (owner decision 2026-11-09)',async()=>{
 const run=body=>draftMessage({opportunity,work,task:{},model:{configured:true,run:async()=>({outcome:'completed',output:{subject:'Training',citations:['source-1'],needsHuman:false,body}})}});
 for(const body of ['Would a short conversation about training help?','Happy to set up a quick call this week.','Would you be open to a live demo?','Pick a time that suits you to talk.','You can speak with our team any time.'])
  expect(await run(body),body).toBeNull();
 expect((await run('CareMetric does not do live demos. The free trial shows every step:\n\nhttps://cmcarebase.com/signup'))?.modelGenerated).toBe(true);
 expect((await run('Hold a short monthly meeting with your staff to review training. Would a free trial help?'))?.modelGenerated).toBe(true);
});
it('tags the template and a customer message with the Account Manager campaign for the moment',async()=>{
 const template=await draftMessage({opportunity,work,task:{}});
 expect(template.body).toContain('https://cmcarebase.com/signup?utm_source=caremetric&utm_medium=email&utm_campaign=growth-carebase-touch1');
 const model={configured:true,run:vi.fn(async()=>({outcome:'completed',output:{subject:'Your first setup step',body:'Where are you in setup?\n\nhttps://cmcarebase.com/how-it-works',citations:[],needsHuman:false}}))};
 const draft=await draftMessage({opportunity:{...opportunity,stage:'trial',owner_agent:'account_manager'},work:{kind:'onboarding',action:'Agree the goal',success:'First value'},task:{},model});
 expect(draft.body).toContain('https://cmcarebase.com/how-it-works?utm_source=caremetric&utm_medium=email&utm_campaign=account-carebase-onboarding');
});
it('writes prospect outreach as the founder, with the founder\'s story in touch 1, and refuses copy that is hard to read (owner direction 2026-11-12)',()=>{
 expect(growthSystem).toContain('written as CareMetric\'s founder');
 expect(growthSystem).toMatch(/In touch 1, after the sentence about the organization, tell the founder's story/);
 expect(growthSystem).toContain('never write the name in the body');
 expect(growthSystem).toContain('never email campaigns as the point');
 expect(growthSystem).toContain('I run a home health and hospice agency and a healthcare consulting company.');
 const answer=body=>({subject:'Referral sources in your county',body,citations:['s'],needsHuman:false});
 const sources=[{id:'s'}];
 expect(draftProblem(answer('I run a home health and hospice agency. Which referral sources does your team visit each week?'),{product:'caremetric-intel',sources,outreach:true})).toBeNull();
 expect(draftProblem(answer('Unlock seamless referral growth for your agency.'),{product:'caremetric-intel',sources,outreach:true})).toBe('unclear');
});
it('lets a draft state the numbers and percentages its own cited sources state, and ignores the prospect\'s own name in the word checks',()=>{
 const sources=[{id:'s',claim:'The agency serves 12 counties and grew 15% last year.'}];
 const answer=body=>({subject:'Your counties',body,citations:['s'],needsHuman:false});
 expect(draftProblem(answer('You serve 12 counties and grew 15% last year.'),{product:'caremetric-intel',sources,outreach:true})).toBeNull();
 expect(draftProblem(answer('You serve 14 counties.'),{product:'caremetric-intel',sources,outreach:true})).toBe('claim');
 expect(draftProblem(answer('Hospice Solutions of Erie cares for families.'),{product:'caremetric-intel',sources,outreach:true})).toBe('unclear');
 expect(draftProblem(answer('Hospice Solutions of Erie cares for families.'),{product:'caremetric-intel',sources,outreach:true,organization:'Hospice Solutions of Erie'})).toBeNull();
});
it('keeps the organization\'s numbers in sentences about the organization, never in one about CareMetric or in the first person',()=>{
 const sources=[{id:'s',claim:'The agency serves 12 counties and grew 15% last year.'}];
 const answer=body=>({subject:'Your counties',body,citations:['s'],needsHuman:false});
 const check=body=>draftProblem(answer(body),{product:'caremetric-intel',sources,outreach:true,organization:'Valley Hospice'});
 expect(check('Your team serves 12 counties. Intel shows the referral sources in each one.')).toBeNull();
 expect(check('Intel covers your 12 counties.')).toBe('claim');
 expect(check('CAREMETRIC INTEL grew 15% last year.')).toBe('claim');
 expect(check('We cover 12 counties for agencies like yours.')).toBe('claim');
 expect(check('I see you serve 12 counties.')).toBe('claim');
 expect(check('Our data covers 12 counties.')).toBe('claim');
 // The country and a sentence with no number are not product claims.
 expect(check('Your team serves 12 counties in the US.')).toBeNull();
 expect(check('I built Intel to find every referral source.')).toBeNull();
 // A number inside the organization's own name is part of the name.
 expect(draftProblem(answer('I wrote to 24 Hour Home Care because Intel maps referral sources.'),{product:'caremetric-intel',sources,outreach:true,organization:'24 Hour Home Care'})).toBeNull();
});
it('lets a message state the numbers its own product\'s catalog states, and gives its writer that catalog (owner direction 2026-11-16)',async()=>{
 const sources=[{id:'s',claim:'The agency serves 12 counties.'}];
 const answer=body=>({subject:'Referral sources in your county',body,citations:['s'],needsHuman:false});
 const intel=body=>draftProblem(answer(body),{product:'caremetric-intel',sources,outreach:true,organization:'Valley Hospice'});
 const carebase=body=>draftProblem(answer(body),{product:'carebase',sources,outreach:true,organization:'Valley Home'});
 // Intel: the site's own figures about its data ("By the numbers") and a feature's number, in a sentence about Intel or in the first person.
 expect(intel('Intel draws on 150+ public healthcare datasets, linked by county and ZIP.')).toBeNull();
 expect(intel('I built Intel on more than 150 public healthcare datasets.')).toBeNull();
 expect(intel('Our data covers 33,000+ ZIP areas and 3,200+ counties.')).toBeNull();
 expect(intel('Intel lists the accounts that go 45 days without a visit.')).toBeNull();
 // CareBase: the requirements its own site states, such as a personal care home's 12 annual training hours and an ALF's 16.
 expect(carebase('CareBase tracks the 12 hours of training a year each direct care worker needs.')).toBeNull();
 expect(carebase('In an ALF, CareBase tracks 16 annual hours per direct care worker.')).toBeNull();
 // A figure the catalog does not state is refused, and so is the organization's own figure in a sentence about the product.
 expect(intel('Intel draws on 200+ public healthcare datasets.')).toBe('claim');
 expect(intel('Intel covers your 12 counties.')).toBe('claim');
 expect(carebase('CareBase tracks 20 hours of training a year.')).toBe('claim');
 // Each product's catalog is its own: neither message may state the other product's numbers.
 expect(carebase('CareBase draws on 150+ public healthcare datasets.')).toBe('claim');
 expect(intel('Intel tracks the 16 annual hours each direct care worker needs.')).toBe('claim');
 // The writer gets the message's own product's catalog as its own cached block after the instructions, and no other.
 expect(growthSystem).toContain('one the product\'s catalog states');
 const model={configured:true,run:vi.fn(async()=>({outcome:'completed',output:{subject:'Your first setup step',body:'Where are you in setup?',citations:[],needsHuman:false}}))};
 const customer={kind:'onboarding',action:'Agree the goal',success:'First value'};
 for (const [product,heading,phrase,other] of [['caremetric-intel',/^CareMetric Intel features and data/,'150+ public healthcare datasets',/^CareMetric CareBase capabilities/m],
   ['carebase',/^CareMetric CareBase capabilities/,'12 hours of training a year',/^CareMetric Intel features and data/m]]) {
  model.run.mockClear();
  await draftMessage({opportunity:{...opportunity,product,stage:'trial',owner_agent:'account_manager'},work:customer,task:{},model});
  const system=model.run.mock.calls[0][1].system;
  expect(system,product).toHaveLength(2);
  expect(system.every(block=>block.cache)).toBe(true);
  expect(system[0].text).toBe(growthSystem);
  expect(system[1].text).toMatch(heading);
  expect(system[1].text).toContain(phrase);
  expect(system[1].text).not.toMatch(other);
 }
});
it('repairs a draft once, telling the writer what to fix, and reports why one was refused',async()=>{
 const bad={outcome:'completed',output:{subject:'Training',body:'A seamless way to train staff.',citations:['source-1'],needsHuman:false}};
 const good={outcome:'completed',output:{subject:'Training',body:'How do you track training hours today?',citations:['source-1'],needsHuman:false}};
 const model={configured:true,run:vi.fn().mockResolvedValueOnce(bad).mockResolvedValueOnce(good)};
 const reasons=[];
 const draft=await draftMessage({opportunity,work,task:{},model,onReject:code=>reasons.push(code)});
 expect(draft).toMatchObject({modelGenerated:true,body:'How do you track training hours today?'});
 const repair=model.run.mock.calls[1][1];
 expect(repair.promptVersion).toBe('growth.14-r');
 expect(repair.system[0].text).toBe(growthSystem);
 expect(JSON.parse(repair.user)).toMatchObject({previousDraft:{body:'A seamless way to train staff.'},fix:expect.stringMatching(/plain words/)});
 expect(reasons).toEqual([]);
 const twice={configured:true,run:vi.fn(async()=>bad)};
 expect(await draftMessage({opportunity,work,task:{},model:twice,onReject:code=>reasons.push(code)})).toBeNull();
 expect(reasons).toEqual(['unclear_then_unclear']);
 expect(twice.run).toHaveBeenCalledTimes(2);
});
it('records the arms a message was written under and follows a website lead or a re-ask with their own plan',async()=>{
 const run=vi.fn(async()=>({outcome:'completed',output:{subject:'Your county report',body:'Thank you for asking for the report.',citations:['source-1'],needsHuman:false}}));
 const model={configured:true,run};
 const lead={...opportunity,product:'caremetric-intel',policy:{...opportunity.policy,experiment_enabled:true},memory:{lead:{kind:'county_report',place:'Allegheny, PA',at:now}}};
 const draft=await draftMessage({opportunity:lead,work,task:{},model});
 expect(draft.arms).toMatchObject({trigger:'inbound'});
 expect(['referral_sources','territory','competitors','visit_prep','hospital_outcomes','slipping_sources']).toContain(draft.arms.angle);
 const input=JSON.parse(run.mock.calls[0][1].user);
 expect(input).toMatchObject({lead:{kind:'county_report',place:'Allegheny, PA'},focus:draft.arms.angle.replace(/_/g,' ')});
 expect(input.touchPlan).toMatch(/They asked for it/);
 const reask={...opportunity,touches:3,memory:{reengagedAt:now,touchesBefore:3,reengageReason:'not_now'}};
 await draftMessage({opportunity:reask,work,task:{},model});
 const asked=JSON.parse(run.mock.calls[1][1].user);
 expect(asked).toMatchObject({reask:true,maxTouches:1,touch:1});
 expect(asked.touchPlan).toMatch(/One brief, friendly check-in/);
});
it('writes outreach with the owner-approved memo as a last cached block, after the product\'s catalog, and records its version',async()=>{
 const model={configured:true,run:vi.fn(async()=>({outcome:'completed',output:{subject:'Staff training records',body:'How do you track annual training hours today?\n\nhttps://cmcarebase.com/signup',citations:['source-1'],needsHuman:false}}))};
 const memo={version:3,memo:'- The owner turned down recent drafts with these notes: "Too long".'};
 const draft=await draftMessage({opportunity,work,task:{},model,memo});
 const request=model.run.mock.calls[0][1];
 expect(request.system).toHaveLength(3);
 expect(request.system.every(block=>block.cache)).toBe(true);
 expect(request.system[0].text).toBe(growthSystem);
 expect(request.system[1].text).toMatch(/^CareMetric CareBase capabilities/);
 expect(request.system[2].text).toContain('memo 3');
 expect(request.system[2].text).toContain('Too long');
 expect(request.promptVersion).toBe('growth.14-m3');
 expect(draft.memoVersion).toBe(3);
 // A customer's message and an unusable memo are written without it.
 model.run.mockClear();
 const customer=await draftMessage({opportunity,work:{kind:'onboarding',action:'Help',success:'Set up'},task:{},model,memo});
 expect(model.run.mock.calls[0][1].system).toHaveLength(2);
 expect(model.run.mock.calls[0][1].system.some(block=>block.text.includes('memo 3'))).toBe(false);
 expect(customer?.memoVersion).toBeUndefined();
 model.run.mockClear();
 await draftMessage({opportunity,work,task:{},model,memo:{version:'3',memo:'x'}});
 expect(model.run.mock.calls[0][1].promptVersion).toBe('growth.14');
});

it('records the applied report length without changing angle, subject or ordinary length treatments', async () => {
 const o={...opportunity,product:'caremetric-intel',policy:{...opportunity.policy,experiment_enabled:true}};
 const ordinary=messageArms(o,o.evidence);
 expect(messageArms(o,o.evidence,{reportLed:true})).toEqual({...ordinary,length:'report'});
 for(const context of [{touches:1},{memory:{lead:{kind:'report'}}},{memory:{reengagedAt:'2026-11-15'}}]) {
  const draft=await draftMessage({opportunity:{...o,...context},work,task:{}});
  expect(draft.arms.length).toBe(ordinary.length);
 }
 expect((await draftMessage({opportunity:o,work,task:{}})).arms.length).toBe('report');
 expect((await draftMessage({opportunity:o,work:{kind:'trial'},task:{}})).arms.length).toBe(ordinary.length);
 expect(ordinary.length_basis).toBe('applied_v1');
});
