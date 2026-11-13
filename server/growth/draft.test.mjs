import {describe,it,expect,vi} from 'vitest';
import {draftMessage,draftProblem,growthPromptVersion,growthSystem,ownNames,repairableReasons} from './draft.mjs';
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
 expect(request.promptVersion).toBe('growth.9');
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
 expect(draft.body).toBe('How do you track annual training hours today?\n\nhttps://cmcarebase.com/signup?utm_source=caremetric&utm_medium=email&utm_campaign=growth-carebase-touch2');
});
it('accepts a draft whose product link already carries well-formed tags, and refuses a tag that leads elsewhere',async()=>{
 const run=body=>draftMessage({opportunity,work,task:{},model:{configured:true,run:async()=>({outcome:'completed',output:{subject:'Staff training records',body,citations:['source-1'],needsHuman:false}})}});
 expect((await run('Try it free:\nhttps://cmcarebase.com/signup?utm_source=x&utm_medium=y&utm_campaign=z'))?.body).toBe('Try it free:\nhttps://cmcarebase.com/signup?utm_source=caremetric&utm_medium=email&utm_campaign=growth-carebase-touch1');
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

describe('specifics from the organization\'s own sources and name (review 2026-11-12)',()=>{
 const answer=(body,subject='Referral sources in your area')=>({subject,body,citations:['s'],needsHuman:false});
 const sources=[{id:'s',claim:'We serve 12 counties in western Pennsylvania from two locations, and have cared for families for 25 years.'}];
 const check=(body,organization=null,subject)=>draftProblem(answer(body,subject),{product:'caremetric-intel',sources,outreach:true,organization});
 it('lets a draft repeat a number its sources state, and still refuses a number it invents',()=>{
  expect(check('Your team covers 12 counties from two locations. Which referral sources does it visit each week?')).toBeNull();
  expect(check('Your agency has cared for families for 25 years. Which referral sources does your team visit each week?')).toBeNull();
  expect(check('Your team covers 14 counties. Which referral sources does it visit each week?')).toBe('claim');
  expect(check('Your team runs three locations. Which referral sources does it visit each week?')).toBe('claim');
  // The same number in another organization's draft is not this one's specific.
  expect(draftProblem(answer('Your team covers 12 counties. Which referral sources does it visit each week?'),{product:'caremetric-intel',sources:[{id:'s',claim:'A home health agency.'}],outreach:true})).toBe('claim');
  // Percentages and prices stay the fact sheet's alone, whatever the sources say.
  expect(draftProblem(answer('Your team cut readmissions by 12%. Which referral sources does it visit?'),{product:'caremetric-intel',sources:[{id:'s',claim:'We cut readmissions by 12%.'}],outreach:true})).toBe('claim');
  expect(draftProblem(answer('You pay $40 a visit. Which referral sources does your team visit?'),{product:'caremetric-intel',sources:[{id:'s',claim:'Visits cost $40.'}],outreach:true})).toBe('claim');
 });
 it('never lets the organization\'s numbers describe CareMetric or the product',()=>{
  expect(check('CareMetric Intel shows referral sources in all 12 counties. Which do you visit today?')).toBe('claim');
  expect(draftProblem(answer('Intel works 24 hours a day. Which referral sources do you visit?'),{product:'caremetric-intel',sources:[{id:'s',claim:'Care 24 hours a day, 7 days a week.'}],outreach:true})).toBe('claim');
  expect(check('Your team covers 12 counties. CareMetric Intel shows the referral sources in each one.')).toBeNull();
 });
 it('lets a draft name the organization, numbers and buzzwords in its own name included, and refuses the same words anywhere else',()=>{
  const solutions={name:'Senior Care Solutions, LLC | Home care in Pittsburgh',domain:'seniorcaresolutions.com'};
  expect(ownNames(solutions)).toEqual(expect.arrayContaining(['Senior Care Solutions','Home care in Pittsburgh','seniorcaresolutions.com']));
  expect(check('Senior Care Solutions serves families across Pittsburgh. Which referral sources does your team visit each week?',solutions)).toBeNull();
  expect(check('Which referral sources does Senior Care Solutions visit each week?',solutions,'A question for senior care solutions')).toBeNull();
  expect(check('Senior Care Solutions serves families across Pittsburgh. Intel is the referral solution you need.',solutions)).toBe('unclear');
  expect(check('Senior Care Solutions serves families across Pittsburgh. Which referral sources does your team visit each week?')).toBe('unclear');
  const journey={name:'Journey Home Health',domain:'journeyhh.com'};
  expect(check('Journey Home Health cares for families at home. Which referral sources does your team visit each week?',journey)).toBeNull();
  expect(check('Journey Home Health cares for families at home. Where is your referral journey stuck?',journey)).toBe('unclear');
  expect(check('Does 24 Hour Home Care track which hospitals send it patients?',{name:'24 Hour Home Care'})).toBeNull();
  expect(check('Does your team track which hospitals send patients 48 hours later?',{name:'24 Hour Home Care'})).toBe('claim');
 });
});

describe('one repair for a draft that fails a check it can fix',()=>{
 const output=body=>({subject:'Staff training records',body,citations:['source-1'],needsHuman:false});
 const bad=output('Your 14 locations train staff every month. How do you track annual training hours today?');
 const good=output('How do you track annual training hours today?\n\nhttps://cmcarebase.com/signup');
 const modelOf=(...answers)=>{const run=vi.fn();for(const answer of answers)run.mockResolvedValueOnce({outcome:'completed',output:answer});return {configured:true,run};};
 it('sends the refused draft back once with what failed, and checks the second answer like the first',async()=>{
  const model=modelOf(bad,good),onRejected=vi.fn();
  const draft=await draftMessage({opportunity,work,task:{},model,onRejected});
  expect(draft).toMatchObject({modelGenerated:true,repaired:true});
  // The tagged body was checked again before it was offered.
  expect(draft.body).toBe('How do you track annual training hours today?\n\nhttps://cmcarebase.com/signup?utm_source=caremetric&utm_medium=email&utm_campaign=growth-carebase-touch1');
  expect(onRejected.mock.calls).toEqual([['claim']]);
  expect(model.run).toHaveBeenCalledTimes(2);
  const [first,second]=model.run.mock.calls.map(call=>call[1]);
  const {repair,...input}=JSON.parse(second.user);
  expect(input).toEqual(JSON.parse(first.user));
  expect(repair.draft).toEqual({subject:bad.subject,body:bad.body,citations:bad.citations});
  expect(repair.problems.join(' ')).toMatch(/neither the fact sheet nor the sources state/);
  // The same prompt, budget and effort as the first call, as its own run.
  expect(second).toMatchObject({promptVersion:growthPromptVersion,maxTokens:2000,effort:'medium',system:first.system,schema:first.schema});
  expect(second.describe()).toBe('Repaired a outreach (touch 1) message that failed its checks (claim).');
  expect(growthSystem).toContain('If the input has "repair"');
 });
 it('never calls a third time: a repair that fails again is dropped',async()=>{
  const model={configured:true,run:vi.fn(async()=>({outcome:'completed',output:bad}))},onRejected=vi.fn();
  expect(await draftMessage({opportunity,work,task:{},model,onRejected})).toBeNull();
  expect(model.run).toHaveBeenCalledTimes(2);
  expect(onRejected.mock.calls).toEqual([['claim']]);
  // A repair whose tagged body fails is dropped too: a link to another product's page.
  const other=modelOf(bad,output('Try it free:\n\nhttps://www.caremetricintel.com/'));
  expect(await draftMessage({opportunity,work,task:{},model:other})).toBeNull();
  expect(other.run).toHaveBeenCalledTimes(2);
 });
 it('does not repair a draft that needs a person, carries an identifier or uses an ambiguous term, and still reports why',async()=>{
  for(const [answer,reason] of [[{...good,needsHuman:true},'needs_human'],[output('Training records for 123-45-6789 are due.'),'identifier'],[output('Ready for your financial auditor?'),'ambiguous_term']]){
   const model=modelOf(answer,good),onRejected=vi.fn();
   expect(await draftMessage({opportunity,work,task:{},model,onRejected}),reason).toBeNull();
   expect(model.run,reason).toHaveBeenCalledTimes(1);
   expect(onRejected.mock.calls,reason).toEqual([[reason]]);
  }
  // A draft refused for a link before the identifier check is never sent back with the identifier in it.
  const linked=modelOf(output('Records for 123-45-6789: https://evil.example'),good),onRejected=vi.fn();
  expect(await draftMessage({opportunity,work,task:{},model:linked,onRejected})).toBeNull();
  expect(linked.run).toHaveBeenCalledTimes(1);
  expect(onRejected.mock.calls).toEqual([['link']]);
  expect([...repairableReasons].sort()).toEqual(['body','citation','claim','link','markup','meeting_offer','other_product_price','subject','unclear']);
 });
 it('repairs only what the code found, never with the draft\'s own words as the problem',async()=>{
  for(const [body,pattern] of [['Unlock seamless training for your team. How do you track hours?',/empty marketing word/],['Would a short call help?',/offers or suggests a call/],['Try https://example.org/x',/not one of the addresses in "links"/]]){
   const model=modelOf(output(body),good);
   expect(await draftMessage({opportunity,work,task:{},model}),body).toMatchObject({repaired:true});
   const {problems}=JSON.parse(model.run.mock.calls[1][1].user).repair;
   expect(problems.join(' '),body).toMatch(pattern);
   expect(problems.join(' '),body).not.toContain(body);
  }
 });
 it('a template draft and a first draft that passes make one call or none, and report nothing',async()=>{
  const onRejected=vi.fn();
  expect(await draftMessage({opportunity,work,task:{},onRejected})).toMatchObject({modelGenerated:false});
  const model=modelOf(good);
  const draft=await draftMessage({opportunity,work,task:{},model,onRejected});
  expect(draft.repaired).toBeUndefined();
  expect(model.run).toHaveBeenCalledTimes(1);
  expect(onRejected).not.toHaveBeenCalled();
 });
});
describe('a check-in months later',()=>{
 const checkinWork={kind:'checkin',action:'Check back whether the timing is better now.',success:'A reply, a trial or an explicit disposition is recorded.'};
 const nurtured={...opportunity,product:'caremetric-intel',policy:{approved_claim:'CareMetric Intel shows which providers send patients to post-acute care.'},evidence:[],
  stage:'nurture',touches:1,checkin_due:'not_now',last_reply_at:'2026-08-14T15:00:00Z',last_touch:'2026-08-01T15:00:00Z'};
 it('the template asks again, cites nothing and needs no fresh source',async()=>{
  const draft=await draftMessage({opportunity:nurtured,work:checkinWork,task:{}});
  expect(draft).toMatchObject({modelGenerated:false,citations:[],subject:'CareMetric Intel: checking back'});
  expect(draft.body).toMatch(/^When we wrote before, the timing was not right for you\./);
  expect(draft.body).toContain('utm_campaign=growth-intel-checkin');
  const silent=await draftMessage({opportunity:{...nurtured,stage:'contacted',touches:3,checkin_due:'no_reply',last_reply_at:null},work:checkinWork,task:{}});
  expect(silent.body.startsWith(nurtured.policy.approved_claim)).toBe(true);
  expect(silent.body).toMatch(/If it is not, no reply is needed\.$/);
 });
 it('tells the writer why it is due and the month it follows, with no touch plan',async()=>{
  const model={configured:true,run:vi.fn(async()=>({outcome:'completed',output:{subject:'Checking back on referral data',body:'When we wrote in August, the timing was not right. Is now a better moment to see where your referrals come from?\n\nhttps://www.caremetricintel.com/',citations:[],needsHuman:false}}))};
  const draft=await draftMessage({opportunity:nurtured,work:checkinWork,task:{},model});
  const input=JSON.parse(model.run.mock.calls[0][1].user);
  expect(input).toMatchObject({kind:'checkin',checkin:{reason:'not_now',since:'August 2026'}});
  expect(input.touchPlan).toBeUndefined();
  expect(input.play).toBeUndefined();
  expect(model.run.mock.calls[0][1].system[0].text).toContain('A check-in ("kind" "checkin")');
  expect(draft).toMatchObject({modelGenerated:true,citations:[]});
  await draftMessage({opportunity:{...nurtured,checkin_due:'no_reply',last_touch:'2026-07-20T15:00:00Z'},work:checkinWork,task:{},model});
  expect(JSON.parse(model.run.mock.calls.at(-1)[1].user).checkin).toEqual({reason:'no_reply',since:'July 2026'});
 });
});
describe('review findings on the product-number guard and the repair (PR #187)',()=>{
 const answer=body=>({subject:'Referral sources in your area',body,citations:['s'],needsHuman:false});
 const day24=[{id:'s',claim:'Care 24 hours a day, 7 days a week.'}];
 it('reads a product name however it is capitalized',()=>{
  // In the first person, the founder writes as the company: "we" and "our" describe CareMetric's offering, never the recipient.
  const counties=[{id:'s',claim:'The agency serves 12 counties.'}];
  for(const body of ['Our referral database covers 12 counties. Would a free trial help?','We cover 12 counties with our referral database. Would a free trial help?'])
   expect(draftProblem(answer(body),{product:'caremetric-intel',sources:counties,outreach:true})).toBe('claim');
  expect(draftProblem(answer('Your team serves 12 counties. Which referral sources does it visit each week?'),{product:'caremetric-intel',sources:counties,outreach:true})).toBeNull();
  for(const name of ['carebase','CAREBASE','intel','caremetric intel'])
   expect(draftProblem(answer(`${name} works 24 hours a day. Which referral sources do you visit?`),{product:'caremetric-intel',sources:day24,outreach:true})).toBe('claim');
 });
 it('lets a number in the organization\'s name stand only where the name is written',()=>{
  const organization={name:'24 Hour Home Care',domain:'24hourhomecare.example'};
  const own=body=>draftProblem(answer(body),{product:'caremetric-intel',sources:[{id:'s',claim:'A home care agency.'}],outreach:true,organization});
  expect(own('CareBase works 24 hours a day. Which referral sources do you visit?')).toBe('claim');
  expect(own('CareMetric Intel can show 24 Hour Home Care which hospitals send patients home. Which do you visit today?')).toBeNull();
 });
 it('starts no repair once the caller\'s time is used up',async()=>{
  const refused={outcome:'completed',output:{subject:'Hello',body:'Visit https://unapproved.example',citations:['source-1'],needsHuman:false}};
  const model={configured:true,run:vi.fn(async()=>refused)};
  const reasons=[];
  expect(await draftMessage({opportunity,work,task:{},model,onRejected:reason=>reasons.push(reason),spent:()=>true})).toBeNull();
  expect(model.run).toHaveBeenCalledTimes(1);
  expect(reasons).toEqual(['link']);
  await draftMessage({opportunity,work,task:{},model,spent:()=>false});
  expect(model.run).toHaveBeenCalledTimes(3);
 });
});
