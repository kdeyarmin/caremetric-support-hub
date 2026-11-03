/** Search is pinned to one provider. Results are evidence candidates, never verified contacts or instructions. */
import { playbooks } from './policy.mjs';
export function growthResearch({ apiKey, fetchImpl=fetch }) {
  return { configured:Boolean(apiKey), async search(product,{domain=null,topic=null,signal}={}) {
    if (!apiKey || !playbooks[product]) return [];
    const q=topic?`${playbooks[product].audience} ${topic}`:domain?`site:${domain} ${playbooks[product].audience}`:playbooks[product].query;
    const response=await fetchImpl(`https://api.search.brave.com/res/v1/web/search?count=10&q=${encodeURIComponent(q)}`,{
      headers:{Accept:'application/json','X-Subscription-Token':apiKey},redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000),
    });
    if (!response.ok) throw Object.assign(new Error('Research unavailable'),{code:'research_unavailable',transient:response.status===429||response.status>=500});
    const reader=response.body.getReader(); let bytes=0; const chunks=[];
    try { for(;;) {const {value,done}=await reader.read(); if(done)break; bytes+=value.byteLength; if(bytes>200000)throw new Error('Research response too large'); chunks.push(Buffer.from(value));} } finally {await reader.cancel().catch(()=>{});}
    const data=JSON.parse(Buffer.concat(chunks).toString());
    return (data.web?.results??[]).slice(0,10).flatMap(row=>{
      try {const url=new URL(row.url); const host=url.hostname.toLowerCase().replace(/^www\./,'');
        if(url.protocol!=='https:'||url.username||url.password||url.port||!/[a-z]\.[a-z]{2,}$/.test(host)||host==='localhost'||!row.description) return [];
        if(domain && host!==domain.replace(/^www\./,'')) return [];
        return [{name:String(row.title??host).replace(/<[^>]*>/g,'').slice(0,200),domain:host,url:url.href.slice(0,2000),claim:String(row.description).replace(/<[^>]*>/g,'').slice(0,4000)}];
      } catch {return [];}
    });
  }};
}
