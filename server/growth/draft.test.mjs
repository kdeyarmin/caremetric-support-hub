import {it,expect,vi} from 'vitest';
import {draftMessage} from './draft.mjs';
import {assessProspect} from './assessment.mjs';
const now=new Date().toISOString();
const opportunity={id:'o',product:'carebase',version:1,contact_id:'c',goal:'Staff training',policy:{approved_claim:'CareBase supports facility training.',booking_url:'https://example.org/book'},evidence:[{id:'source-1',source_url:'https://example.org',observed_at:now,claim:'A personal-care facility',confidence:'high'}],events:[]};
const work={kind:'outreach',action:'Offer a conversation',success:'Qualified response'};
it('never invents a product claim when the policy has none',async()=>{expect(await draftMessage({opportunity:{...opportunity,policy:{}},work,task:{}})).toBeNull();});
it('a template contains only reviewed product facts and an approved booking URL',async()=>{const draft=await draftMessage({opportunity,work,task:{}});expect(draft).toMatchObject({modelGenerated:false,citations:['source-1']});expect(draft.body).toContain(opportunity.policy.approved_claim);expect(draft.body).not.toMatch(/guarantee|discount/i);});
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
 expect(request.promptVersion).toBe('growth.5');
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
it('never offers a call, a meeting or a demo: templates point to the free trial and invite a reply (owner decision 2026-11-08)',async()=>{
 const outreach=await draftMessage({opportunity,work,task:{}});
 expect(outreach.body).toContain('https://cmcarebase.com/signup');
 expect(outreach.body).not.toContain(opportunity.policy.booking_url);
 for(const kind of ['onboarding','activation','trial','adoption','renewal','support','recovery','expansion']){
  const draft=await draftMessage({opportunity,work:{kind,action:'x',success:'y'},task:{}});
  expect(draft.body,kind).not.toMatch(/conversation|call|meeting|demo|a suitable time|https?:/i);
 }
 const model={configured:true,run:vi.fn(async()=>({outcome:'completed',output:{subject:'Training',body:'Would it help?',citations:['source-1'],needsHuman:false}}))};
 await draftMessage({opportunity,work,task:{},model});
 expect(model.run.mock.calls[0][1].system[0].text).toContain('never offer or suggest a phone call, a sales call, a meeting or a demo');
 expect(model.run.mock.calls[0][1].system[0].text).toContain('Never offer or suggest a demo, a sales call or a meeting.');
});
it('tags every product page it writes with growth-<product>-touch<n> and the variant, and a customer email with its moment',async()=>{
 const tags=touch=>`utm_source=caremetric&utm_medium=email&utm_campaign=growth-carebase-touch${touch}&utm_content=control`;
 // The template: the free-trial page carries the outreach tags; the booking page never appears.
 const template=await draftMessage({opportunity:{...opportunity,touches:1},work,task:{}});
 expect(template.body).toContain(`https://cmcarebase.com/signup?${tags(2)}`);
 // The model is given the plain addresses; its product pages are tagged (its own tags replaced), the booking page left alone.
 const model={configured:true,run:vi.fn(async()=>({outcome:'completed',output:{subject:'Staff training records',body:'How do you track annual training hours today?\n\nhttps://cmcarebase.com/signup?utm_source=google\n\nOr pick a time: https://example.org/book',citations:['source-1'],needsHuman:false}}))};
 const draft=await draftMessage({opportunity,work,task:{},model});
 expect(draft.body).toBe(`How do you track annual training hours today?\n\nhttps://cmcarebase.com/signup?${tags(1)}\n\nOr pick a time: https://example.org/book`);
 expect(JSON.parse(model.run.mock.calls[0][1].user).links.map(link=>link.url)).toContain('https://cmcarebase.com/signup');
 model.run.mockResolvedValue({outcome:'completed',output:{subject:'Before your trial ends',body:'What is left to decide?\n\nhttps://cmcarebase.com/faq',citations:[],needsHuman:false}});
 expect((await draftMessage({opportunity:{...opportunity,stage:'trial'},work:{kind:'trial',action:'x',success:'y'},task:{},model})).body)
  .toBe('What is left to decide?\n\nhttps://cmcarebase.com/faq?utm_source=caremetric&utm_medium=email&utm_campaign=success-carebase-trial');
});
it('refuses a tag that carries another host, path or parameter, and tags on the booking page',async()=>{
 const run=body=>draftMessage({opportunity,work,task:{},model:{configured:true,run:async()=>({outcome:'completed',output:{subject:'Training',citations:['source-1'],needsHuman:false,body}})}});
 expect(await run('Try it: https://cmcarebase.com/signup?utm_source=a&next=https://evil.test')).toBeNull();
 expect(await run('Try it: https://cmcarebase.com/admin?utm_source=caremetric')).toBeNull();
 expect(await run('Try it: https://evil.test/signup?utm_source=caremetric')).toBeNull();
 expect(await run('Try it: https://cmcarebase.com/signup?utm_source=evil.test')).toBeNull();
 expect(await run('Book: https://example.org/book?utm_source=caremetric')).toBeNull();
});
