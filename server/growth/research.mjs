/** Search is pinned to one provider. Results are evidence candidates, never verified contacts or instructions. */
import { playbooks } from './policy.mjs';
import { operatorHost } from './playbook.mjs';
/**
 * `query` is the discovery search for the day (playbook.mjs `discoveryQuery`); without one, a domain or a topic search is built, and
 * failing both the product's fixed audience query is used. Discovery and topic searches drop hosts that are never an operator
 * (directories, listing and review sites, social networks, job boards, government and school sites), so a directory is never
 * recorded as a prospect. A domain search keeps only that domain, as before.
 *
 * A discovery search may ask for more results in one call (`count`, at most 20) and for a later page of them (`offset`, pages 0 to 9),
 * which is how several searches a day keep finding organizations the day before did not. Every other search reads the first ten.
 */
export const searchResultLimit=20;
const whole=(value,least,most,fallback)=>Number.isInteger(value)&&value>=least&&value<=most?value:fallback;
export function growthResearch({ apiKey, fetchImpl=fetch, paceMs=1100 }) {
  // The provider serves one request a second on its entry plan: callers that make several calls in one run wait this long between them.
  return { configured:Boolean(apiKey), paceMs, async search(product,{domain=null,topic=null,query=null,count=10,offset=0,signal}={}) {
    if (!apiKey || !playbooks[product]) return [];
    const q=domain?`site:${domain} ${playbooks[product].audience}`:topic?`${playbooks[product].audience} ${topic}`:query?String(query).slice(0,300):playbooks[product].query;
    const size=whole(count,1,searchResultLimit,10),page=whole(offset,0,9,0);
    const response=await fetchImpl(`https://api.search.brave.com/res/v1/web/search?count=${size}${page?`&offset=${page}`:''}&q=${encodeURIComponent(q)}`,{
      headers:{Accept:'application/json','X-Subscription-Token':apiKey},redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000),
    });
    if (!response.ok) throw Object.assign(new Error('Research unavailable'),{code:'research_unavailable',transient:response.status===429||response.status>=500});
    const reader=response.body.getReader(); let bytes=0; const chunks=[];
    try { for(;;) {const {value,done}=await reader.read(); if(done)break; bytes+=value.byteLength; if(bytes>(size>10?600000:200000))throw new Error('Research response too large'); chunks.push(Buffer.from(value));} } finally {await reader.cancel().catch(()=>{});}
    const data=JSON.parse(Buffer.concat(chunks).toString());
    return (data.web?.results??[]).slice(0,size).flatMap(row=>{
      try {const url=new URL(row.url); const host=url.hostname.toLowerCase().replace(/^www\./,'');
        if(url.protocol!=='https:'||url.username||url.password||url.port||!/[a-z]\.[a-z]{2,}$/.test(host)||host==='localhost'||!row.description) return [];
        if(domain && host!==domain.replace(/^www\./,'')) return [];
        if(!domain && !operatorHost(host)) return [];
        return [{name:String(row.title??host).replace(/<[^>]*>/g,'').slice(0,200),domain:host,url:url.href.slice(0,2000),claim:String(row.description).replace(/<[^>]*>/g,'').slice(0,4000)}];
      } catch {return [];}
    });
  }};
}
