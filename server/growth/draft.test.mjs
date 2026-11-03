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
