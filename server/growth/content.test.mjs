import { it, expect } from 'vitest';
import { contentBrief } from './content.mjs';
const input={product:'carebase',claim:'CareBase supports staff training.',bookingUrl:'https://example.org/book',sources:[{url:'https://example.org/research',claim:'Operators ask about reporting.'}],task:{}};
it('requires approved product facts and source evidence for a content proposal',async()=>{
 expect(await contentBrief({...input,claim:''})).toBeNull();expect(await contentBrief({...input,sources:[]})).toBeNull();expect(await contentBrief({...input,product:'breathe'})).toBeNull();
});
it('produces a reviewable outline without inventing search volume',async()=>{
 const brief=await contentBrief(input);expect(brief.citations).toEqual(['https://example.org/research']);expect(brief.outline).toHaveLength(3);expect(JSON.stringify(brief)).not.toMatch(/monthly searches|guaranteed|discount/);
});
it('rejects unsupported model sources and assertions of insufficient evidence',async()=>{
 const output={title:'Training reporting',keyword:'training reporting',outline:['Business problem','Verified workflow','Next step'],citations:['https://invented.example'],abstain:false};
 const model={configured:true,run:async()=>({outcome:'completed',output})};expect(await contentBrief({...input,model})).toBeNull();output.citations=['https://example.org/research'];output.abstain=true;expect(await contentBrief({...input,model})).toBeNull();
});
