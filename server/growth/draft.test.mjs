import {it,expect,vi} from 'vitest';
import {callsDataPublic,citesDataFile,criticMaxTokens,criticPromptVersion,criticRules,criticSchema,criticSystem,criticWeaknesses,draftMessage,draftProblem,growthPromptVersion,growthSystem,messageArms,namesCard,outdatedWords,problemHints,shortFormProblem,weaknessMeanings} from './draft.mjs';
import {nursingHomeAngles,offersMeeting,playbookFor,prospectKind,quietPlays,reasonNowRule,reportCloseAngle,reportTouchAngle,reviewFollowupAngle,reviewTouchAngle,shortFormLimits,touchAngle,unviewedTouchAngle,viewedTouchAngle} from './playbook.mjs';
import {readCampaign,founderQuote} from './campaign.mjs';
import {trialCardTerms} from '../agents/content/facts.mjs';
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
 expect(request.promptVersion).toBe('growth.21');
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
it('a follow-up to a prospect who replied and went quiet gets its own play for each step and a short body',async()=>{
 for(const step of [1,2]) {
  const model={configured:true,run:vi.fn(async()=>({outcome:'completed',output:{subject:'Following up',body:'Did our answer cover what you needed? Reply with anything still open.',citations:[],needsHuman:false}}))};
  const draft=await draftMessage({opportunity:{...opportunity,stage:'engaged'},work:{kind:'reply',action:'Follow up once',success:'An answer',quiet:{step}},task:{},model});
  expect(draft?.modelGenerated).toBe(true);
  const sent=JSON.parse(model.run.mock.calls[0][1].user);
  expect(sent.play).toBe(quietPlays[step]);
  expect(sent.style).toBe('Keep the body under eighty words.');
 }
 expect(quietPlays[1]).toMatch(/never say you noticed anything they did/);
 const template=await draftMessage({opportunity:{...opportunity,stage:'engaged'},work:{kind:'reply',action:'Follow up once',success:'An answer',quiet:{step:1}},task:{}});
 expect(template.body).toMatch(/did it cover what you needed\?/);
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
 // An agency's own rating or rank never goes in an email, even with no number the claim check would catch; asking where it stands does.
 expect(draftProblem(answer('Valley Home Health has a 4.5-star rating. Which referral sources does your team visit each week?'),{product:'caremetric-intel',sources,outreach:true})).toBe('own_standing');
 expect(draftProblem(answer('Your agency ranks ninth in Erie County. Which referral sources does your team visit each week?'),{product:'caremetric-intel',sources,outreach:true})).toBe('own_standing');
 expect(draftProblem(answer('Where does your agency rank in its county? Which referral sources does your team visit each week?'),{product:'caremetric-intel',sources,outreach:true})).toBeNull();
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
 // The catalog's figure, without the catalog's word "public": a prospect email names the data's source, never calls it public
 // (owner direction 2026-11-17).
 expect(intel('Intel draws on 150+ healthcare datasets, linked by county and ZIP.')).toBeNull();
 expect(intel('I built Intel on more than 150 healthcare datasets.')).toBeNull();
 expect(intel('Intel draws on 150+ public healthcare datasets, linked by county and ZIP.')).toBe('public_data');
 expect(intel('Our data covers 33,000+ ZIP areas and 3,200+ counties.')).toBeNull();
 expect(intel('Intel lists the accounts that go 45 days without a visit.')).toBeNull();
 // CareBase: the requirements its own site states, such as a personal care home's 12 annual training hours and an ALF's 16.
 expect(carebase('CareBase tracks the 12 hours of training a year each direct care worker needs.')).toBeNull();
 expect(carebase('In an ALF, CareBase tracks 16 annual hours per direct care worker.')).toBeNull();
 // A figure the catalog does not state is refused, and so is the organization's own figure in a sentence about the product.
 expect(intel('Intel draws on 200+ healthcare datasets.')).toBe('claim');
 expect(intel('Intel covers your 12 counties.')).toBe('claim');
 expect(carebase('CareBase tracks 20 hours of training a year.')).toBe('claim');
 // Each product's catalog is its own: neither message may state the other product's numbers.
 expect(carebase('CareBase draws on 150+ public healthcare datasets.')).toBe('claim');
 expect(intel('Intel tracks the 16 annual hours each direct care worker needs.')).toBe('claim');
 // The writer gets the message's own product's catalog as its own cached block after the instructions, and no other.
 expect(growthSystem).toContain('one the product\'s catalog states');
 const model={configured:true,run:vi.fn(async()=>({outcome:'completed',output:{subject:'Your first setup step',body:'Where are you in setup?',citations:[],needsHuman:false}}))};
 const customer={kind:'onboarding',action:'Agree the goal',success:'First value'};
 for (const [product,heading,phrase,other] of [['caremetric-intel',/^CareMetric Intel features and data/,'150+ healthcare datasets',/^CareMetric CareBase capabilities/m],
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
 expect(repair.promptVersion).toBe('growth.21-r');
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
 expect(request.promptVersion).toBe('growth.21-m3');
 expect(draft.memoVersion).toBe(3);
 // A customer's message and an unusable memo are written without it.
 model.run.mockClear();
 const customer=await draftMessage({opportunity,work:{kind:'onboarding',action:'Help',success:'Set up'},task:{},model,memo});
 expect(model.run.mock.calls[0][1].system).toHaveLength(2);
 expect(model.run.mock.calls[0][1].system.some(block=>block.text.includes('memo 3'))).toBe(false);
 expect(customer?.memoVersion).toBeUndefined();
 model.run.mockClear();
 await draftMessage({opportunity,work,task:{},model,memo:{version:'3',memo:'x'}});
 expect(model.run.mock.calls[0][1].promptVersion).toBe('growth.21');
});

it('records the applied report length without changing angle, subject or ordinary length treatments', async () => {
 const o={...opportunity,product:'caremetric-intel',policy:{...opportunity.policy,experiment_enabled:true}};
 const ordinary=messageArms(o,o.evidence);
 // A first email built around a market report records its form with its length; nothing else about the arms changes.
 expect(messageArms(o,o.evidence,{reportLed:true})).toEqual({...ordinary,length:'report',form:'short'});
 for(const context of [{touches:1},{memory:{lead:{kind:'report'}}},{memory:{reengagedAt:'2026-11-15'}}]) {
  const draft=await draftMessage({opportunity:{...o,...context},work,task:{}});
  expect(draft.arms.length).toBe(ordinary.length);
 }
 expect((await draftMessage({opportunity:o,work,task:{}})).arms.length).toBe('report');
 expect((await draftMessage({opportunity:o,work:{kind:'trial'},task:{}})).arms.length).toBe(ordinary.length);
 expect(ordinary.length_basis).toBe('applied_v1');
});

// The first email to a CareMetric Intel agency (owner decisions 2026-11-15 and 2026-11-17): its market report and nothing else, with the
// trial moved to the second email. The reader's review (critic.6) reads it under that rule.
const intel={id:'oi',organization_id:'gi',product:'caremetric-intel',name:'Valley Home Health',version:1,contact_id:'c',stage:'qualified',touches:0,memory:{},
 policy:{approved_claim:'Intel shows every referral source in your county.',max_touches:3},
 evidence:[{id:'e1',source_url:'https://valleyhh.org/about',observed_at:now,claim:'Valley Home Health serves Allegheny County.',confidence:'high'}],events:[]};
const report={label:'Free market report for Valley Home Health',url:'https://www.caremetricintel.com/report/abc.def'};
const trial=playbookFor('caremetric-intel').nextStep.url;
const reviewPage='https://www.caremetricintel.com/county-report';
const inside='It shows where your agency stands among the agencies located in Allegheny County, which agencies lead the county and the hospitals its residents use most. It also lists the highest-ranked physicians for home health outreach.';
const signed='I run a home health and hospice agency, and I built CareMetric Intel to see my own market this way.';
// A first email asks for one thing, the report (the Nov 24 measurement): its opening ends on a plain sentence, never a question.
const closing='It is a quick way to see who leads the county before you plan next month\'s visits.';
const firstBody=`I put together a free market report for Valley Home Health from Medicare data. It opens as a PDF, with nothing to sign up for:\n${report.url}\n\n${inside}\n\n${signed}\n\n${closing}`;
const firstDraft={subject:'Valley Home Health\'s Allegheny County market report',body:firstBody,citations:['e1'],needsHuman:false};
const countyInside='It shows the hospitals the county\'s residents use most and the nursing homes, home health agencies and hospices located there.';
const reviewDraft={...firstDraft,body:`A free report on Allegheny County, built from Medicare and Census data, is one step away. Choose the state and county and it is emailed to you as a PDF:\n${reviewPage}\n\n${countyInside}\n\n${signed}\n\n${closing}`};
const general={subject:'Referral sources in your county',body:'Your team plans which referral sources to visit each week.',citations:['e1'],needsHuman:false};
const firstEmail=async(o,{offered=report,output=firstDraft,critic=false,views=false,run=null}={})=>{
 const model={configured:true,run:run??vi.fn(async()=>({outcome:'completed',output}))};
 const result=await draftMessage({opportunity:o,work,task:{},model,report:offered,critic,views});
 return {result,model,input:JSON.parse(model.run.mock.calls[0]?.[1]?.user??'null')};
};
const wordsIn=text=>text.replace(/https?:\/\/\S+/g,' ').split(/\s+/).filter(word=>/[A-Za-z0-9]/.test(word)).length;

it('bumps the writer to growth.21 and the reader to critic.6, with a weakness code from a fixed list and a scale a good email can reach',()=>{
 expect(criticMaxTokens).toBe(4000);
 expect(growthPromptVersion).toBe('growth.21');
 expect(criticPromptVersion).toBe('critic.6');
 expect(criticWeaknesses).toEqual(['none','generic_opening','about_sender','too_long','too_many_asks','unclear_ask','wrong_problem','no_reason_now','reads_as_template']);
 expect(criticSchema.required).toEqual(['specific','relevant','clearAsk','wouldReply','weakness','weakestSentence']);
 expect(criticSchema.properties.weakness.enum).toEqual([...criticWeaknesses]);
 expect(criticSystem).not.toMatch(/deserves a 2 or 3/);
 for(const n of [1,2,3,4,5])expect(criticSystem).toMatch(new RegExp(`^- ${n}: `,'m'));
 expect(criticSystem).toMatch(/A careful, specific email earns a 4/);
 for(const code of criticWeaknesses)expect(criticSystem).toContain(`- ${code}: ${weaknessMeanings[code]}.`);
 expect(criticSystem).toMatch(/Keeping a rule is never a weakness/);
});

it('gives the reader the brief\'s writer part and the writer\'s rules, keeps all four scores and the weakness, and names the weakness in the one rewrite',async()=>{
 const brief={setting:'home_health',summary:'A family-owned home health agency in Allegheny County.',triggers:[],
  pains:[{question:'Do you know which physicians certify the most home health patients in Allegheny County?'}],angle:'referral_sources',
  hook:{sentence:'Valley Home Health serves Allegheny County.',sourceUrl:'https://valleyhh.org/about'}};
 // No roster report here, so the first email points to Intel's free county report page.
 const draft={subject:'Referral sources in Allegheny County',body:`A free report on Allegheny County, built from Medicare and Census data, is one step away. Choose the state and county and it is emailed to you as a PDF:\n${reviewPage}\n\nValley Home Health serves Allegheny County.\n\nThe report names the physicians who certify the most home health patients there.`,citations:['e1'],needsHuman:false};
 const better={...draft,subject:'Your Allegheny County referral map'};
 const run=vi.fn(async(_task,request)=>{
  if(request.promptVersion===criticPromptVersion)return {outcome:'completed',output:JSON.parse(request.user).email.subject===better.subject
   ?{specific:4,relevant:5,clearAsk:4,wouldReply:4,weakness:'none',weakestSentence:''}
   :{specific:2,relevant:3,clearAsk:4,wouldReply:2,weakness:'generic_opening',weakestSentence:'Valley Home Health serves Allegheny County.'}};
  return {outcome:'completed',output:request.promptVersion.endsWith('-c')?better:draft};
 });
 const o={...intel,touches:0};
 const result=await draftMessage({opportunity:o,work,task:{},model:{configured:true,run},brief,critic:true});
 expect(result.subject).toBe(better.subject);
 expect(result.arms).toMatchObject({critic:'4',criticSpecific:'4',criticRelevant:'5',criticAsk:'4',weakness:'none',rewritten:'1'});
 expect(result.arms.hold_review).toBeUndefined();
 const reads=run.mock.calls.filter(([,request])=>request.promptVersion===criticPromptVersion).map(([,request])=>JSON.parse(request.user));
 expect(reads[0]).toMatchObject({agency:{name:'Valley Home Health',summary:brief.summary},brief:{summary:brief.summary,pains:[brief.pains[0].question],angle:'referral_sources',hook:brief.hook.sentence}});
 // The writer's rules, then the one that says this first email is the report alone on purpose.
 expect(reads[0].rules.slice(0,criticRules.length)).toEqual([...criticRules]);
 expect(reads[0].rules).toHaveLength(criticRules.length+1);
 expect(JSON.stringify(reads[0].brief)).not.toMatch(/sourceUrl|@/);
 const rewrite=JSON.parse(run.mock.calls.find(([,request])=>request.promptVersion===`${growthPromptVersion}-c`)[1].user);
 expect(rewrite.fix).toContain(`What most held it back: ${weaknessMeanings.generic_opening}.`);
 expect(rewrite.fix).toContain('"Valley Home Health serves Allegheny County."');
 // The rewrite keeps the form: the report first and its one link.
 expect(rewrite.fix).toContain('keeping it to the opening the plan asks for and the report\'s one link');
 // A rewrite that scores lower keeps the first email and its scores.
 const worse=vi.fn(async(_task,request)=>{
  if(request.promptVersion===criticPromptVersion)return {outcome:'completed',output:JSON.parse(request.user).email.subject===better.subject
   ?{specific:1,relevant:1,clearAsk:1,wouldReply:1,weakness:'too_long',weakestSentence:'x'}
   :{specific:2,relevant:3,clearAsk:4,wouldReply:2,weakness:'no_reason_now',weakestSentence:''}};
  return {outcome:'completed',output:request.promptVersion.endsWith('-c')?better:draft};
 });
 const kept=await draftMessage({opportunity:o,work,task:{},model:{configured:true,run:worse},brief,critic:true});
 expect(kept.subject).toBe(draft.subject);
 expect(kept.arms).toMatchObject({critic:'2',criticSpecific:'2',criticRelevant:'3',criticAsk:'4',weakness:'no_reason_now',hold_review:'critic'});
 expect(kept.arms.rewritten).toBeUndefined();
});

it('adds the trial, the sale and one allowed fact only when those settings are on, and follows the brief\'s angle', async () => {
 const brief={setting:'home_health',summary:'A home health agency in Allegheny County.',triggers:[],pains:[],angle:'referral_sources',
  positiveFact:'Medicare\'s quality of patient care rating for this agency is 4.5 stars.',paymentCut:true,
  hook:{sentence:'Valley Home Health serves Allegheny County.',sourceUrl:'https://valleyhh.org/about'}};
 const quiet=await draftMessage({opportunity:intel,work,task:{},report,brief});
 expect(quiet.body).toContain('Who to call on in your county');
 expect(quiet.body).not.toContain('4.5 stars');
 expect(quiet.body).not.toContain('Founders Sale');
 expect(quiet.body).not.toContain('walkthrough');
 expect(quiet.arms.reason).toBe('payment');
 const loud=await draftMessage({opportunity:intel,work,task:{},report,brief,offers:{oneFact:true,oneOffer:true,bookingUrl:'https://cal.example/kevin'}});
 expect(loud.body).toContain('Medicare\'s quality of patient care rating for this agency is 4.5 stars.');
 expect(loud.body).toContain('Founders Sale: 75% off the first 12 months.');
 expect(loud.body).toContain('https://cal.example/kevin');
 expect(loud.body.indexOf('4.5 stars')).toBeLessThan(loud.body.indexOf('Who to call on in your county'));
 const read=readCampaign(loud.body,{reports:{accepts:url=>url===report.url}});
 expect(read).toMatchObject({angle:'referral_sources',version:3,touch:1});
 expect(offersMeeting(loud.body)).toBe(false);
});

it('keeps every arm, the reader\'s and the form\'s included, well inside the arms column\'s 600-byte limit',()=>{
 // 'standard' is the longest value the form arm ever held (emails written before 2026-11-17 keep it).
 const largest={length:'control',length_basis:'applied_v1',trigger:`reask_${'x'.repeat(20)}`,angle:'hospital_outcomes',subject:'question',angle_by:'brief',viewed:'yes',
  critic:'5',criticSpecific:'5',criticRelevant:'5',criticAsk:'5',weakness:'reads_as_template',rewritten:'1',form:'standard',band:'4',hold_review:'critic',reason:'payment'};
 expect(Buffer.byteLength(JSON.stringify(largest))).toBeLessThan(500);
});

it('writes every first email to a CareMetric Intel agency as its market report and nothing else, and no other email that way',async()=>{
 // Every agency, not half of them by a hash, and with no switch: the form goes with the report-led first email alone.
 for(let i=0;i<50;i+=1) {
  const o={...intel,id:`o${i}`,organization_id:`g${i}`};
  expect(messageArms(o,o.evidence,{reportLed:true}).form).toBe('short');
  expect(messageArms(o,o.evidence).form).toBeUndefined();
 }
 // With the agency's own report, and with Intel's free county report page for an agency that has no roster report.
 const own=await firstEmail(intel);
 expect(own.result).toMatchObject({modelGenerated:true,arms:{form:'short',length:'report'}});
 expect(own.input.touchPlan).toBe(reportTouchAngle);
 expect(own.input.report).toBe(true);
 const review=await firstEmail(intel,{offered:null,output:reviewDraft});
 expect(review.result).toMatchObject({modelGenerated:true,arms:{form:'short',length:'report'}});
 expect(review.input.touchPlan).toBe(reviewTouchAngle);
 expect(review.input.report).toBeUndefined();
 // Never a later touch, a re-ask, a website lead, a nursing home or CareBase.
 for(const [context,offered] of [[{touches:1},report],[{memory:{reengagedAt:now,touchesBefore:3},touches:3},report],[{memory:{lead:{kind:'county_report'}}},report],
   [{name:'Maple Grove Nursing and Rehabilitation Center'},null],[{product:'carebase'},report]]) {
  const {result,input}=await firstEmail({...intel,...context},{offered,output:general});
  expect(result,JSON.stringify(context)).toMatchObject({modelGenerated:true});
  expect(result.arms.form,JSON.stringify(context)).toBeUndefined();
  expect([reportTouchAngle,reviewTouchAngle]).not.toContain(input.touchPlan);
 }
 // The template (no model) records the form too, so a draft's arms never depend on whether a model answered.
 expect((await draftMessage({opportunity:intel,work,task:{},report})).arms.form).toBe('short');
 expect((await draftMessage({opportunity:intel,work,task:{}})).arms.form).toBe('short');
});

it('tells the first email\'s writer to write its opening, and holds that to a few sentences, the report\'s one link and no question',async()=>{
 const {result,input}=await firstEmail(intel);
 expect(shortFormLimits).toEqual({words:120,questions:1,firstQuestions:0});
 expect(input.touchPlan).toBe(reportTouchAngle);
 expect(input.style).toBe('Write two or three sentences, never more than 120 words.');
 // The plan: the writer writes the opening for this agency; the email adds what the software does, the founder's words and the trial
 // (campaign.mjs), so the plan names them and asks for none of them (email review 2026-11-17).
 expect(reportTouchAngle).toMatch(/^First email, built around the agency's own free market report\. You write only the opening of this email/);
 expect(reportTouchAngle).toMatch(/you put together a free market report for this agency, by name, from Medicare data/);
 expect(reportTouchAngle).toMatch(/compares agencies based in the area and suggests hospitals and clinicians to research/);
 // Without its own report, the agency is offered Intel's free county report, which asks for no name and no certification number
 // (owner direction 2026-11-19).
 expect(reviewTouchAngle).toMatch(/^First email, built around Intel's free county report/);
 expect(reviewTouchAngle).toMatch(/a free report on the county, built from Medicare and Census data, is one step away: the reader chooses the state and county and the report is emailed as a PDF/);
 expect(reviewTouchAngle).toMatch(/the hospitals the county's residents use and the providers of every kind located there/);
 expect(reviewTouchAngle).toMatch(/put the county report page's link on its own line/);
 expect(reviewTouchAngle).not.toMatch(/by name|certification number|\bCCN\b|market review/i);
 for(const plan of [reportTouchAngle,reviewTouchAngle]) {
  expect(plan).toMatch(/The email adds: the report button, three ways CareMetric Intel helps the team and a short founder quote\. The free trial comes in the second email\./);
  expect(plan).not.toMatch(/ranks? highest|ranked highest|\bpublic\b|credit card|You may end with one short question/);
  expect(plan).toMatch(/Two or three sentences, never more than 120 words, no question and exactly one link\./);
  expect(plan).toMatch(/Ask for one thing only: that the reader open the report\. Ask no question for them to answer by reply/);
  expect(plan).toContain(reasonNowRule);
  expect(plan).toMatch(/No other link, no free trial, no price and no story about yourself in your words\./);
 }
 expect(result).toMatchObject({modelGenerated:true});
 expect(result.body).toContain(report.url);
 expect(wordsIn(firstBody)).toBeLessThanOrEqual(shortFormLimits.words);
 // Too long, a second question, the trial's link, the trial in words, or no link at all: repaired once with the form's hint, then refused.
 const filler=' The report also lists the county\'s largest agencies and the hospitals its residents use.'.repeat(6);
 expect(wordsIn(`${firstBody}${filler}`)).toBeGreaterThan(shortFormLimits.words);
 for(const body of [`${firstBody}${filler}`,`${firstBody}\n\n${trial}`,
   firstBody.replace('from Medicare data.','from Medicare data, and the free trial shows the rest.'),firstBody.replace(`\n${report.url}`,'')]) {
  const reasons=[];
  const model={configured:true,run:vi.fn(async()=>({outcome:'completed',output:{...firstDraft,body}}))};
  expect(await draftMessage({opportunity:intel,work,task:{},model,report,onReject:code=>reasons.push(code)})).toBeNull();
  expect(reasons).toEqual(['short_form_then_short_form']);
  expect(JSON.parse(model.run.mock.calls[1][1].user).fix).toMatch(/You write only the opening of this first email: two or three sentences, at most 120 words, the report's link on its own line and no question\. No other link, no free trial and no price: the email adds what follows below your words\./);
 }
 // A question for the reader to answer is a second ask: repaired once with its own hint, then refused.
 {
  const reasons=[];
  const model={configured:true,run:vi.fn(async()=>({outcome:'completed',output:{...firstDraft,body:`${firstBody} Which county matters most to you?`}}))};
  expect(await draftMessage({opportunity:intel,work,task:{},model,report,onReject:code=>reasons.push(code)})).toBeNull();
  expect(reasons).toEqual(['first_question_then_first_question']);
  expect(JSON.parse(model.run.mock.calls[1][1].user).fix).toBe(problemHints.first_question);
 }
 // An agency without a roster report is held to the county report page the same way: the trial's link is not that page.
 expect(await draftMessage({opportunity:intel,work,task:{},model:{configured:true,run:async()=>({outcome:'completed',output:{...reviewDraft,body:reviewDraft.body.replace(reviewPage,trial)}})}})).toBeNull();
 expect(shortFormProblem(firstBody,{reportLinks:[report.url]})).toBeNull();
 // A later opening may ask one question; a first email's asks none (`firstQuestions`).
 expect(shortFormProblem(`I put together a free market report for Valley Home Health from Medicare data.\n${report.url}`,{reportLinks:[report.url]})).toBeNull();
 expect(shortFormProblem(`${firstBody} Or not?`,{reportLinks:[report.url]})).toBeNull();
 expect(shortFormProblem(`${firstBody} Or not?`,{reportLinks:[report.url],questions:shortFormLimits.firstQuestions})).toBe('questions');
 expect(shortFormProblem(`${firstBody} Or not? Really?`,{reportLinks:[report.url]})).toBe('questions');
 expect(shortFormProblem(`${firstBody}${filler}`,{reportLinks:[report.url]})).toBe('length');
 expect(shortFormProblem(firstBody.replace(`\n${report.url}`,''),{reportLinks:[report.url]})).toBe('link');
 expect(shortFormProblem(firstBody.replace(report.url,trial),{reportLinks:[report.url]})).toBe('link');
 expect(shortFormProblem(`${firstBody.replace(closing,'The free trial would help your team too.')}`,{reportLinks:[report.url]})).toBe('trial');
});

it('accepts the email review\'s example first email, and refuses it with the trial, a second link, two questions, no link or too many words',()=>{
 const sources=[{id:'e1',claim:'Valley Home Health is a Medicare-certified home health agency in Erie, Pennsylvania (CMS Provider of Services file).',source_url:'https://data.cms.gov/',observed_at:now},
  {id:'county',claim:'Erie County has 48 home health agencies, by CMS\'s count.',source_url:'https://data.cms.gov/',observed_at:now}];
 const example={subject:'Valley Home Health\'s Erie County market report',citations:['e1','county'],needsHuman:false,
  body:`I put together a free market report for Valley Home Health from Medicare data. It opens as a PDF, with nothing to sign up for:\n${report.url}\n\nCMS counts 48 home health agencies in Erie County. The report shows where yours stands among them, which agencies lead the county, the hospitals Erie County residents use most and the highest-ranked physicians for home health outreach. It ends with up to three moves to consider.\n\nI run a home health and hospice agency myself, and I built CareMetric Intel to see my own market this way.\n\nIt is yours to keep and share with your team.`};
 const check=(body,over={})=>draftProblem({...example,body},{product:'caremetric-intel',sources,outreach:true,organization:'Valley Home Health',extraLinks:[report.url],form:'short',formLinks:[report.url],...over});
 expect(check(example.body)).toBeNull();
 expect(example.subject.length).toBeLessThan(60);
 expect(wordsIn(example.body)).toBeLessThanOrEqual(120);
 expect(check(example.body.replace('It ends with up to three moves to consider.','A free trial of CareMetric Intel shows the rest.'))).toBe('short_form');
 expect(check(`${example.body}\n\n${trial}`)).toBe('short_form');
 // The trial however it is worded; the report itself is free, so "free" alone is not the trial.
 expect(check(example.body.replace('It ends with up to three moves to consider.','You can try CareMetric Intel free for 30 days.'))).toBe('short_form');
 expect(check(example.body.replace('It ends with up to three moves to consider.','You can also try it for free.'))).toBe('short_form');
 // A question is a second ask in a first email: the form refuses it, and the first email's own check names it.
 expect(check(`${example.body} Which county matters most to you?`)).toBe('short_form');
 expect(check(`${example.body} Which county matters most to you?`,{firstAsk:true})).toBe('first_question');
 expect(check(example.body,{firstAsk:true})).toBeNull();
 expect(check(example.body.replace(`\n${report.url}`,''))).toBe('short_form');
 expect(check(`${example.body}${' The report also lists the county\'s largest agencies and the hospitals its residents use.'.repeat(4)}`)).toBe('short_form');
 // The same words are not held to the form in a later email, and the county's figure needs its source.
 expect(check(`${example.body} Which county matters most to you?`,{form:null,formLinks:null})).toBeNull();
 expect(check(example.body,{sources:[sources[0]]})).toBe('citation');
 expect(draftProblem({...example,citations:['e1']},{product:'caremetric-intel',sources:[sources[0]],outreach:true,organization:'Valley Home Health',extraLinks:[report.url],form:'short',formLinks:[report.url]})).toBe('claim');
 // The words the writer's instructions once used for the physicians no longer fail as a rank (email review 2026-11-17).
 expect(check(example.body.replace('the highest-ranked physicians for home health outreach','the physicians Intel ranks highest as referral sources'))).toBeNull();
 expect(check(example.body.replace('The report shows where yours stands among them','Your agency ranks ninth among them'))).toBe('own_standing');
});

it('keeps the report-first shape without a model, in an email that passes the checks a written one gets',async()=>{
 for(const offered of [report,null]) {
  const link=offered?.url??reviewPage;
  const draft=await draftMessage({opportunity:intel,work,task:{},report:offered});
  expect(draft).toMatchObject({modelGenerated:false,subject:offered?'Your Valley Home Health market report':'A free report on your county',citations:['e1'],arms:{form:'short',length:'report'}});
  expect(draft.body.split('\n')[0]).toBe(offered?'I put together a free market report for Valley Home Health from Medicare data. It compares local agencies and shows hospitals and clinicians to research.'
   :'A free report on the county Valley Home Health serves is one step away, built from Medicare and Census data and emailed to you as a PDF. It shows the hospitals the county\'s residents use and the providers of every kind located there.');
  expect(draft.body).not.toMatch(/certification number|\bCCN\b|agency name|market-review/i);
  expect(draft.body.split('\n')[1].startsWith(link)).toBe(true);
  // The email's own sections follow the opening: what the software does and the founder's words (campaign.mjs). It asks for one thing,
  // the report: the trial comes in the second email (the Nov 24 measurement).
  // Written for this reader's kind of business: Valley Home Health is a home health agency.
  const { opening } = readCampaign(draft.body,{reports:{accepts:url=>url===report.url}});
  const sections = draft.body.slice(opening.length);
  expect(sections).toContain('For home health teams');
  expect(sections).toContain('Plan your outreach');
  expect(sections).not.toMatch(/free trial|signup=true/);
  expect(draft.body).not.toMatch(/credit card|ranks? highest|ranked highest|Any question, just reply|\bpublic\b/i);
  expect(sections).toContain('Compare home health agencies based in your market and research clinicians who certify home health.');
  expect(sections).not.toMatch(/\bhospices?\b in your territory/);
  expect(readCampaign(draft.body,{reports:{accepts:url=>url===report.url}})).toMatchObject({touch:1,setting:'home_health',ownReport:Boolean(offered),opening,version:3,trialUrl:null});
  // The opening is held to the checks a written one gets.
  expect(draftProblem({subject:draft.subject,body:opening,citations:draft.citations,needsHuman:false},
   {product:'caremetric-intel',sources:intel.evidence,outreach:true,organization:intel.name,extraLinks:offered?[offered.url]:[],form:'short',formLinks:[link]})).toBeNull();
 }
 // An agency with no name on record is "your agency"; a later touch and CareBase keep the general template.
 expect((await draftMessage({opportunity:{...intel,name:null},work,task:{},report})).body).toMatch(/^I put together a free market report for your agency from Medicare data\./);
 // The second and third emails keep their shape too: a short opening, then that email's own sections.
 const second=await draftMessage({opportunity:{...intel,touches:1},work,task:{},report});
 expect(second.body).toMatch(/^When you plan outreach for Valley Home Health, which accounts are worth a first visit/);
 expect(readCampaign(second.body,{reports:{accepts:url=>url===report.url}})).toMatchObject({touch:2,ownReport:true});
 expect(second.body).toContain('Start your 30-day free trial');
 const third=await draftMessage({opportunity:{...intel,touches:2},work,task:{},report});
 expect(third.body).toMatch(/^This is my last note\./);
 expect(readCampaign(third.body,{reports:{accepts:url=>url===report.url}})).toMatchObject({touch:3,ownReport:true});
 expect((await draftMessage({opportunity,work,task:{}})).body).toMatch(/^CareBase supports facility training\./);
});

it('gives the reader the whole email, and tells it which part the writer wrote',async()=>{
 const run=vi.fn(async(_task,request)=>request.promptVersion===criticPromptVersion
  ?{outcome:'completed',output:{specific:4,relevant:4,clearAsk:5,wouldReply:4,weakness:'none',weakestSentence:''}}
  :{outcome:'completed',output:firstDraft});
 const {result}=await firstEmail(intel,{critic:true,run});
 expect(result.arms).toMatchObject({form:'short',critic:'4',weakness:'none'});
 const read=JSON.parse(run.mock.calls.find(([,request])=>request.promptVersion===criticPromptVersion)[1].user);
 expect(read.rules.at(-1)).toMatch(/^The writer wrote only this email's opening, on purpose: a few sentences for this one organization, with its report link when it has one\. The sections below the opening are fixed for each kind of organization/);
 // The reader reads the email as the agency would: the opening and the sections the email adds.
 expect(read.email.body.startsWith(firstDraft.body)).toBe(true);
 expect(read.email.body).toContain('For home health teams');
 expect(result.body).toBe(read.email.body);
 // A nursing home's first email is written the same way, in a nursing home's own words: the reader is told so and reads its sections.
 const plain=vi.fn(async(_task,request)=>request.promptVersion===criticPromptVersion
  ?{outcome:'completed',output:{specific:4,relevant:4,clearAsk:5,wouldReply:4,weakness:'none',weakestSentence:''}}
  :{outcome:'completed',output:general});
 await firstEmail({...intel,name:'Maple Grove Nursing and Rehabilitation Center'},{offered:null,critic:true,run:plain});
 const nursingRead=JSON.parse(plain.mock.calls.find(([,request])=>request.promptVersion===criticPromptVersion)[1].user);
 expect(nursingRead.rules.slice(0,-1)).toEqual([...criticRules]);
 expect(nursingRead.rules.at(-1)).toMatch(/^The writer wrote only this email's opening, on purpose/);
 expect(nursingRead.email.body).toContain('What CareMetric Intel does for your nursing home, every day');
 expect(nursingRead.email.body).not.toMatch(/market report|home health agenc|hospices? in your/);
 expect(nursingRead.email.body).toContain('Every nursing home in your territory, ranked by Medicare share');
});

it('offers the trial in an agency\'s second email and leaves the report with it in the third, on every path',async()=>{
 const later=async(o,{offered=report,views=false}={})=>(await firstEmail(o,{offered,views,output:general})).input;
 const opened=[{kind:'report_viewed',occurred_at:now}];
 // The second email: how Intel turns a report into a plan after an open; otherwise a page of the report and its link again; Intel's
 // free county report page again for an agency that had no report of its own. An open is read only while the owner's setting is on.
 expect((await later({...intel,touches:1,events:opened},{views:true})).touchPlan).toBe(viewedTouchAngle);
 expect((await later({...intel,touches:1},{views:true})).touchPlan).toBe(unviewedTouchAngle);
 expect((await later({...intel,touches:1})).touchPlan).toBe(unviewedTouchAngle);
 expect((await later({...intel,touches:1,events:opened})).touchPlan).toBe(unviewedTouchAngle);
 expect((await later({...intel,touches:1},{offered:null})).touchPlan).toBe(reviewFollowupAngle);
 expect((await later({...intel,touches:1,events:opened},{offered:null,views:true})).touchPlan).toBe(reviewFollowupAngle);
 // It no longer depends on which form the first email took: every second email offers the trial.
 for(const first_form of ['short','standard',undefined]) expect((await later({...intel,touches:1,first_form})).touchPlan).toBe(unviewedTouchAngle);
 for(const plan of [viewedTouchAngle,unviewedTouchAngle,reviewFollowupAngle]) {
  // The writer writes the opening; the email adds a week of the work, the Founders Sale, the trial and the report's link.
  expect(plan).toMatch(/You write only the opening of this email/);
  expect(plan).toMatch(/The email adds: three steps for the week in CareMetric Intel, the Founders Sale, the 30-day free trial button, and a link back to the report\./);
  expect(plan).toMatch(/No link in your words, and nothing about the credit card or billing\./);
 }
 expect(viewedTouchAngle).toMatch(/^Second email to an agency whose market report was sent with the first\. Do not say or hint that you know whether anyone opened it\./);
 expect(unviewedTouchAngle).toMatch(/^Second email to an agency whose market report was sent with the first\. Do not say or hint that you know whether anyone opened it\./);
 // The third: a short close, with the report or the page it was offered on, and no new pitch.
 for(const offered of [report,null]) {
  const third=await later({...intel,touches:2},{offered});
  expect(third.touchPlan).toBe(reportCloseAngle);
  expect(third.style).toBe('Keep the body under seventy words.');
 }
 expect(reportCloseAngle).toMatch(/say this is your last note and that if someone else handles marketing/);
 expect(reportCloseAngle).toMatch(/if someone else handles marketing there they can forward this, or reply saying who, so the report reaches the right person/);
 expect(reportCloseAngle).toMatch(/The email adds: the report button and a link to the 30-day free trial\./);
 expect(reviewFollowupAngle).toMatch(/^Second email to an agency whose first email offered Intel's free county report\./);
 expect(reportCloseAngle).toMatch(/No link in your words, no new pitch and no question\./);
 // A nursing home, which an agency's own market report does not cover, has its own three plans (owner direction 2026-11-17: every email is written for
 // the reader's kind of business); CareBase keeps the general plan for each touch.
 const home={...intel,name:'Maple Grove Nursing and Rehabilitation Center'};
 for(const touches of [0,1,2]) {
  const nursing=await later({...home,touches},{offered:null});
  expect(nursing.touchPlan).toBe(nursingHomeAngles[touches]);
  expect(nursing.organization.setting).toBe('nursing home');
  expect(nursing.style).toBe(touches<2?'Write two or three sentences, never more than 120 words.':'Keep the body under seventy words.');
  expect((await later({...intel,product:'carebase',touches})).touchPlan).toBe(touchAngle(touches+1));
 }
 for(const plan of nursingHomeAngles) {
  expect(plan).toContain('You write only the opening of this email');
  expect(plan).toContain('Never mention a market report, home health or hospice agencies, or how any of them rank.');
  expect(plan).toMatch(/No link in your words/);
 }
});

it('names where Intel\'s data comes from without calling it public, in every prospect email and every plan for one (owner direction 2026-11-17)',()=>{
 const answer=body=>({subject:'Referral sources in your county',body,citations:['s'],needsHuman:false});
 const about=(product,body,outreach=true,organization=null)=>draftProblem(answer(body),{product,sources:[{id:'s'}],outreach,organization});
 const ask=' Which county comes first for your team?';
 expect(about('caremetric-intel',`The report is built from Medicare data.${ask}`)).toBeNull();
 for(const words of ['The report is built from public Medicare data.','It uses public CMS and Census data.','It is built on publicly available data.','It shows your county\'s public CMS ratings.',
   'It lists the public ratings of every agency in your county.','It is all free data.','It reads public records for you.'])
  expect(about('caremetric-intel',`${words}${ask}`),words).toBe('public_data');
 // Other uses of the word are not about the data, and the prospect's own name is theirs.
 expect(about('caremetric-intel',`The county health department refers patients to agencies like yours.${ask}`)).toBeNull();
 expect(callsDataPublic('caremetric-intel','Members of the public ask about hospice every week.')).toBe(false);
 expect(callsDataPublic('caremetric-intel','It is published by CMS each year.')).toBe(false);
 expect(about('caremetric-intel',`Erie Public Data Home Health serves Erie County.${ask}`,true,'Erie Public Data Home Health')).toBeNull();
 // CareBase email is not read for it. A message to an Intel customer is, since the owner asked for it everywhere the same day: every
 // surface reads it through the shared checks (content/validate.mjs `public_data`), so here it is a claim the fact sheet does not make.
 expect(callsDataPublic('carebase','public data')).toBe(false);
 expect(about('caremetric-intel','County Intelligence draws on public Medicare data. Where are you in setup?',false)).toBe('claim');
 expect(about('caremetric-intel','County Intelligence draws on Medicare data. Where are you in setup?',false)).toBeNull();
 // The writer is told the rule, and never to call the data proprietary; no plan or fallback for a prospect email uses the word.
 expect(growthSystem).toContain('leave out the word "public"');
 expect(growthSystem).toContain('Never call the data proprietary, exclusive or licensed either.');
 for(const plan of [reportTouchAngle,reviewTouchAngle,viewedTouchAngle,unviewedTouchAngle,reviewFollowupAngle,reportCloseAngle]) expect(plan).not.toMatch(/\bpublic/i);
 expect(problemHints.public_data).toContain('"Medicare data", not "public Medicare data"');
 // An email written under the old instructions is withdrawn when its turn to send comes: prospect email only.
 const waiting={product:'caremetric-intel',subject:'Your county market report',body:'I put together a free market report for your agency from public Medicare data.'};
 expect(outdatedWords({...waiting,purpose:'marketing'})).toBe('public_data');
 expect(outdatedWords({...waiting,purpose:'success'})).toBeNull();
 expect(outdatedWords({...waiting,product:'carebase',purpose:'marketing'})).toBeNull();
});

// The owner, 2026-11-17, on a block that told every reader about home health agencies and hospices alike: "Was this for a home health
// agency? If not, they don't care what the ranking is. Make the email customized to the recipient's business industry."
it('tells a prospect\'s kind of business from its Medicare record, its name, its brief and its research, in that order',()=>{
 const record=kind=>({claim:`CMS Provider of Services file, 2026Q3: Riverbend (CCN 397001) is a Medicare-certified ${kind} in Riverton, PA; certified June 27, 2024.`});
 // The Medicare record is a fact about the agency, so it decides, whatever the name says.
 expect(prospectKind({name:'Riverbend Care',evidence:[record('hospice')]})).toBe('hospice');
 expect(prospectKind({name:'Riverbend Home Health and Hospice',evidence:[record('home health agency')]})).toBe('home_health');
 expect(prospectKind({name:'Riverbend Nursing and Rehab',evidence:[record('home health agency')]})).toBe('home_health');
 // Then the name: one kind, both, or a nursing home.
 expect(prospectKind({name:'Valley Home Health'})).toBe('home_health');
 expect(prospectKind({name:'Valley Homecare'})).toBe('home_health');
 expect(prospectKind({name:'Valley Hospice'})).toBe('hospice');
 expect(prospectKind({name:'Valley Hospice & Home Health'})).toBe('both');
 expect(prospectKind({name:'Sunrise Nursing and Rehabilitation Center'})).toBe('nursing_home');
 // Then a brief written for a hospice, then what its research says; with nothing to go on, an agency of no named kind.
 expect(prospectKind({name:'Valley Care',briefSetting:'hospice'})).toBe('hospice');
 expect(prospectKind({name:'Valley Care',evidence:[{claim:'Valley Care provides hospice care in Erie County.'}]})).toBe('hospice');
 expect(prospectKind({name:'Valley Care',evidence:[{claim:'Valley Care is a skilled nursing facility in Erie County.'}]})).toBe('nursing_home');
 expect(prospectKind({name:'Valley Care',briefSetting:'home_health'})).toBe('agency');
 expect(prospectKind({name:'Valley Care'})).toBe('agency');
 expect(prospectKind()).toBe('agency');
 // The writer is told the kind, and to write only about it.
 expect(growthSystem).toContain('a hospice does not care how home health agencies rank, a home health agency does not care about hospices, and a nursing home competes with neither');
});
it('writes a hospice\'s email about hospices and a home health agency\'s about home health, with or without a model',async()=>{
 const base={...intel,evidence:[{id:'e1',source_url:'https://valley.example/about',observed_at:now,claim:'Valley serves Allegheny County.',confidence:'high'}]};
 const outreach=work;
 const hospice=await draftMessage({opportunity:{...base,name:'Valley Hospice'},work:outreach,task:{}});
 expect(hospice.body).toContain('For hospice teams');
 expect(hospice.body).toContain('Compare local hospices and research hospitals, nursing homes, and clinicians for hospice outreach.');
 expect(hospice.body).not.toMatch(/home health agenc/i);
 const home=await draftMessage({opportunity:{...base,name:'Valley Home Health'},work:outreach,task:{}});
 expect(home.body).toContain('Compare home health agencies based in your market and research clinicians who certify home health.');
 expect(home.body).not.toMatch(/\bhospices?\b in your territory|for your hospice/i);
 // A nursing home gets the same designed email in its own words, with no report and no ranking, on each of its three emails.
 for(const touches of [0,1,2]) {
  const nursing=await draftMessage({opportunity:{...base,name:'Sunrise Nursing and Rehabilitation Center',touches},work:outreach,task:{}});
  expect(readCampaign(nursing.body),`touch ${touches+1}`).toMatchObject({touch:touches+1,setting:'nursing_home',reportUrl:null});
  // The founder's own words name his agency; nothing else in a nursing home's email is about home health or hospice.
  expect(nursing.body.replace(founderQuote,''),`touch ${touches+1}`).not.toMatch(/market report|home health|hospice/i);
  expect(outdatedWords({product:'caremetric-intel',subject:nursing.subject,body:nursing.body,purpose:'marketing'}),`touch ${touches+1}`).toBeNull();
 }
 // The model is told the reader's kind of business.
 const run=vi.fn(async()=>({outcome:'completed',output:{subject:'Hospice referral sources in Erie County',body:'A free report on Erie County, built from Medicare and Census data, is one step away.\nhttps://www.caremetricintel.com/county-report',citations:['e1'],needsHuman:false}}));
 const written=await draftMessage({opportunity:{...base,name:'Valley Hospice'},work:outreach,task:{},model:{configured:true,run}});
 expect(JSON.parse(run.mock.calls[0][1].user).organization).toMatchObject({name:'Valley Hospice',setting:'hospice'});
 expect(written.body).toContain('For hospice teams');
});

// The owner on the emails, 2026-11-17: "I want this easy to read. I don't need full file names, years cited, or super formal sentences."
it('keeps a prospect email easy to read: no data file or its year cited, and the writer is told to write the way people talk',()=>{
 const answer=body=>({subject:'Referral sources in your county',body,citations:['s'],needsHuman:false});
 const sources=[{id:'s',claim:'48 home health agencies located in Erie County (CMS Post-Acute Care data, 2024).'}];
 const about=(body,outreach=true)=>draftProblem(answer(body),{product:'caremetric-intel',sources,outreach});
 const ask=' Which county comes first for your team?';
 // The county's figure, said the way a person would say it.
 expect(about(`Erie County has 48 home health agencies, by CMS's count.${ask}`)).toBeNull();
 expect(about(`CMS counts 48 home health agencies in Erie County.${ask}`)).toBeNull();
 for(const words of ['Erie County has 48 home health agencies (CMS, 2024).','Erie County has 48 home health agencies (2024).','CMS\'s 2024 file counts 48 home health agencies in Erie County.',
   'The 2024 data shows 48 home health agencies in Erie County.','The Provider of Services file lists your agency in Erie County.','The post-acute care file counts 48 home health agencies in Erie County.',
   'As of 2026Q3 your agency is listed in Erie County.'])
  expect(about(`${words}${ask}`),words).toBe('data_citation');
 // A year that is a plain fact about the organization is not a citation, and neither is anything in a message to a customer.
 expect(citesDataFile('Your agency opened a second office in Meadville in 2025.')).toBe(false);
 expect(citesDataFile('You have served Erie County since 1998.')).toBe(false);
 expect(about('Your report uses the 2024 data. Where are you in setup?',false)).toBeNull();
 expect(problemHints.data_citation).toContain('no year in brackets, no quarter and no file\'s name');
 // The writer is told, and so is the plan for the first email's opening.
 expect(growthSystem).toContain('Easy to read comes first. Write the way you would say it to another agency owner across a table');
 expect(growthSystem).toContain('Never cite where a figure comes from the way a report does');
 expect(growthSystem).toContain('Leave out what follows the figure in brackets (the file and its year)');
 expect(reportTouchAngle).toContain('without the file or year that follows it in brackets');
});

it('never brings up how an Intel trial bills in a prospect email, may say no card is needed to start it, and never that one is required (owner decision 2026-11-23)',()=>{
 const answer=body=>({subject:'Referral sources in your county',body,citations:['s'],needsHuman:false});
 const about=(product,body,outreach=true)=>draftProblem(answer(body),{product,sources:[{id:'s'}],outreach});
 const offer='You can try it free for 30 days on one county.';
 expect(about('caremetric-intel',`${offer} Which county comes first for your team?`)).toBeNull();
 // No card is needed to start an Intel trial, and a prospect email may say so (owner decision 2026-11-23).
 for(const words of ['No credit card needed to start.','No credit card is needed to start your trial.','You can try it with no credit card needed.'])
  expect(about('caremetric-intel',`${offer} ${words} Which county comes first for your team?`),words).toBeNull();
 for(const terms of ['Your card will be charged when the trial ends.','The plan you choose bills automatically when the trial ends.',
   'A payment card starts it.','The card terms are on the sign-up page.','Your card is not charged during the trial.',
   'Add a card in Billing before the trial ends to keep your plan.','The plan is billed automatically when it ends.'])
  expect(about('caremetric-intel',`${offer} ${terms} Which county comes first for your team?`),terms).toBe('card_terms');
 // Saying a card is required to start it is refused in any message about Intel, a prospect's or a customer's.
 for(const terms of ['A credit card is required to start the trial.','A card is required to start.','You will need a card to start.','Add a card to begin.'])
  expect(about('caremetric-intel',`${offer} ${terms} Which county comes first for your team?`),terms).not.toBeNull();
 expect(about('caremetric-intel','A credit card is required to start the trial, and the plan chosen at sign-up bills automatically when the trial ends unless it is canceled before then.',false)).toBe('claim');
 // A message to a customer may still say what happens when its trial ends, and CareBase's trial needs no card to speak of.
 expect(about('caremetric-intel',trialCardTerms,false)).toBeNull();
 expect(about('carebase','You can start a 30-day free trial online, and no credit card is needed. How do you track training hours today?')).toBeNull();
 expect(namesCard('caremetric-intel','Scan a business card after each visit.')).toBe(false);
 expect(namesCard('caremetric-intel','The pre-visit card lists what to bring up.')).toBe(false);
 expect(namesCard('caremetric-intel','Open the card before each visit, and add your notes after.')).toBe(false);
 expect(namesCard('caremetric-intel','No credit card needed to start.')).toBe(false);
 expect(namesCard('caremetric-intel','No credit card needed to start. Your card is charged when the trial ends.')).toBe(true);
 expect(namesCard('carebase','A credit card is required.')).toBe(false);
 // An email written under the old instructions is withdrawn when its turn to send comes: prospect email only, and any email that says a
 // card is required to start the trial.
 const waiting={product:'caremetric-intel',subject:'Which referral sources are slipping?',body:'You can try Intel free for 30 days (a credit card is required, and canceling before it ends avoids any charge).'};
 expect(outdatedWords({...waiting,purpose:'marketing'})).toBe('trial_terms');
 expect(outdatedWords({...waiting,purpose:'success'})).toBe('trial_terms');
 const billing={...waiting,body:'You can try Intel free for 30 days, and the plan you chose bills automatically when it ends.'};
 expect(outdatedWords({...billing,purpose:'marketing'})).toBe('card_terms');
 expect(outdatedWords({...billing,purpose:'success'})).toBeNull();
 expect(outdatedWords(billing)).toBeNull();
 expect(outdatedWords({...waiting,product:'carebase',purpose:'marketing'})).toBeNull();
 expect(outdatedWords({...waiting,body:offer,purpose:'marketing'})).toBeNull();
 expect(outdatedWords({...waiting,body:`${offer} No credit card needed to start.`,purpose:'marketing'})).toBeNull();
 // The instructions: the trial in plain words, no card needed to start, never how it bills; no touch plan asks for the terms.
 expect(growthSystem).toContain('For CareMetric Intel you may add that no credit card is needed to start ("No credit card needed to start.").');
 expect(growthSystem).toContain('Never bring up how billing works or what happens when the trial ends in a message to a prospect');
 expect(growthSystem).toContain('Never say that a card is required to start the trial, and never call the trial risk-free.');
 for(const plan of [reportTouchAngle,reviewTouchAngle,viewedTouchAngle,unviewedTouchAngle,reviewFollowupAngle,reportCloseAngle,touchAngle(1),touchAngle(2),touchAngle(3)])
  expect(plan).not.toMatch(/credit card is required|canceling before it ends|card terms|say (?:in one plain clause )?that a credit card/i);
 // The fact sheet and the playbook that follow the instructions hold the terms, as facts for a reader who asks.
 const instructions=growthSystem.slice(0,growthSystem.indexOf('CareMetric fact sheet'));
 expect(instructions.length).toBeGreaterThan(2000);
 expect(instructions).not.toMatch(/credit card is required|canceling before it ends|three questions and carry two links/);
 expect(growthSystem).toContain(trialCardTerms);
 expect(growthSystem).not.toMatch(/a credit card is required|never say that no card is needed/i);
 expect(growthSystem).toContain('How to offer the trial: Offer the free trial in plain words: its length and what it covers. You may add, asked or not, that no credit card is needed to start ("No credit card needed to start.").');
});

it('refuses a draft that implies we saw the reader open what we sent, or that uses Intel\'s own word "the book" (email review 2026-11-17)',()=>{
 const answer=body=>({subject:'Referral sources in your county',body,citations:['s'],needsHuman:false});
 const check=body=>draftProblem(answer(body),{product:'caremetric-intel',sources:[{id:'s'}],outreach:true});
 expect(growthSystem).toContain('never write as if they already have');
 expect(growthSystem).toContain('never "the book"');
 expect(check('Thanks for taking a look at the market report I sent last week. Which county matters most to your team?')).toBe('mentions_open');
 expect(check('Now that you have seen where your agency stands, which county matters most to your team?')).toBe('mentions_open');
 expect(check('When a top source sends fewer patients, Intel shows what the book says about why. Which counties does your team cover?')).toBe('jargon');
 expect(check('When a top source sends fewer patients, Intel shows what your records say about why. Which counties does your team cover?')).toBeNull();
 expect(check('You can open your market report any time. Which county matters most to your team?')).toBeNull();
});
it('reads an email written earlier against the rules added since, when it is about to be sent',()=>{
 const email=body=>outdatedWords({product:'caremetric-intel',subject:'Which referral sources are slipping?',body});
 // Since 2026-11-23 an Intel trial needs no card to start: an email queued while it needed one, saying so, is not sent.
 expect(email('You can try Intel free for 30 days (a credit card is required, and canceling before it ends avoids any charge).')).toBe('trial_terms');
 expect(email('Try it free for 30 days, no credit card:\nhttps://www.caremetricintel.com/')).toBeNull();
 expect(email('Intel flags a top source when its recent referrals fall and shows what the book says about why.')).toBe('jargon');
 expect(email('Thanks for opening the report I sent.')).toBe('mentions_open');
 expect(email('Which counties does your team cover today?')).toBeNull();
});

// Owner direction 2026-11-19: Intel is not just for home health agencies, nobody is asked for a CCN or an agency's name, and the free
// county report (any state and county, emailed as a PDF) replaced the agency market review, whose page now redirects to it.
it('never offers the retired market review or asks for an agency\'s certification number or name, in a new draft or one already written',async()=>{
 const retired='https://www.caremetricintel.com/market-review';
 const county='https://www.caremetricintel.com/county-report';
 // The page is gone from every Intel email's links, and the county report is offered in its place.
 const links=(await firstEmail(intel,{offered:null,output:reviewDraft})).input.links.map(link=>link.url);
 expect(links).toContain(county);
 expect(links.some(url=>url.includes('market-review'))).toBe(false);
 expect(playbookFor('caremetric-intel').pages).not.toContain('intel-market-review');
 // A model draft that links the retired page, or asks for the agency's number or name, is refused.
 const answer=body=>({subject:'A free report on your county',body,citations:['e1'],needsHuman:false});
 const check=body=>draftProblem(answer(body),{product:'caremetric-intel',sources:intel.evidence,outreach:true,organization:intel.name});
 expect(check(`Get your free market report:\n${retired}`)).toBe('link');
 for(const words of ['Enter your CMS certification number and it is emailed to you as a PDF.','Type your agency\'s CCN on this page.',
   'Search by agency name and state. We\'ll email your report.','Search for your agency by name and the report is emailed.',
   // A direct request for the name, as well as a search by it (Codex review on kdeyarmin/caremetric-support-hub#292).
   'Enter your agency\'s name and state to get your free report by email.','Just type your agency name and we will email it.',
   'Tell us the name of your agency and we will send it.','Provide the organization’s name below.'])
  expect(check(`${words}\n${county}`),words).toBe('retired_page');
 // Naming the agency the email is about is not asking the reader for it.
 expect(check(`Your agency name came up while I was researching Erie County.\n${county}`)).toBeNull();
 expect(check(`Enter your email address and the county report is emailed to you.\n${county}`)).toBeNull();
 expect(check(`Choose your state and county and it is emailed to you as a PDF.\n${county}`)).toBeNull();
 // Intel's own feature words ("search by name, city, tag, NPI or CCN") are not a request for the agency's number.
 expect(check('In Intel your team can search accounts by name, city, tag, NPI or CCN. Which referral sources does your team visit each week?')).toBeNull();
 expect(problemHints.retired_page).toMatch(/only a state, a county and an email address/);
 // An email written before then is withdrawn when it would be sent, and the next sweep writes it again.
 const waiting=body=>outdatedWords({product:'caremetric-intel',subject:'Your market report',body,purpose:'marketing'});
 expect(waiting(`A free market report for Valley Home Health, built from Medicare data, is one step away. Enter your CMS certification number on this page and it is emailed to you as a PDF:\n${retired}?utm_source=caremetric&utm_medium=email&utm_campaign=growth-intel-touch1`)).toBe('retired_page');
 expect(waiting(`Find your agency report\nSearch by agency name and state. We’ll email your report.\n${retired}`)).toBe('retired_page');
 expect(outdatedWords({product:'caremetric-intel',subject:'Your market report',body:`Your free market report:\n${retired}`,purpose:'success'})).toBe('retired_page');
 expect(waiting(`A free report on your county is one step away.\n${county}`)).toBeNull();
 expect(outdatedWords({product:'carebase',subject:'Training',body:`Enter your CCN.\n${retired}`,purpose:'marketing'})).toBeNull();
 // The writer is told the county report needs no name and no number, and never to call it the agency's own report.
 expect(growthSystem).toMatch(/Otherwise the email offers Intel's free county report, the page in "links" labelled "Free county report from CareMetric Intel"/);
 expect(growthSystem).toMatch(/never ask the reader for the agency's name or any identifier/);
 expect(growthSystem).not.toMatch(/market review|market-review|certification number\. The report|Search by agency name/i);
 // Every email the template writes for an agency without its own report, and every Intel email, is free of the retired page.
 for(const touches of [0,1,2]) {
  const draft=await draftMessage({opportunity:{...intel,touches},work,task:{}});
  expect(draft.body,`touch ${touches+1}`).toContain(county);
  expect(outdatedWords({product:'caremetric-intel',subject:draft.subject,body:draft.body,purpose:'marketing'}),`touch ${touches+1}`).toBeNull();
 }
});

it('never withholds the free county report from a nursing home: it serves every kind of organization (owner direction 2026-11-19)',async()=>{
 const county='https://www.caremetricintel.com/county-report';
 const home={...intel,name:'Maple Grove Nursing and Rehabilitation Center'};
 // A nursing home's own emails still carry no report (an agency's own market report covers home health and hospice), but the county
 // report page is among the links it may be offered, and a draft that links it passes the link check.
 const {input}=await firstEmail({...home,touches:1},{offered:null,output:general});
 expect(input.organization.setting).toBe('nursing home');
 expect(input.links.map(link=>link.url)).toContain(county);
 const answer={subject:'Hospital sources in your county',body:`A free report on your county shows the hospitals its residents use.\n${county}`,citations:['e1'],needsHuman:false};
 expect(draftProblem(answer,{product:'caremetric-intel',sources:home.evidence,outreach:true,organization:home.name})).toBeNull();
 // A website lead from a nursing home is followed up with the same pages, the county report among them.
 const lead=await firstEmail({...home,touches:1,memory:{lead:{kind:'county_report',place:'Erie County, PA'}}},{offered:null,output:general});
 expect(lead.input.links.map(link=>link.url)).toContain(county);
 expect(lead.input.touchPlan).toMatch(/If they asked for a county report, it was already emailed to them: never send them to a page to ask for it again or to enter anything more to get a report\./);
});
