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
/**
 * What the search provider says this key may still use, read from the rate-limit headers of its last answer: the allowance of its
 * longest window (a month, on the plans that have one), how many requests are left in it, and the window's length in days. Null
 * when the answer carries no such headers or they are not in the expected shape (`X-RateLimit-Policy: 1;w=1, 2000;w=2592000` beside
 * `X-RateLimit-Remaining: 1, 1984`), so nothing is ever guessed. Numbers only: never the key.
 */
export function searchAllowance(headers) {
  const read=name=>String(headers?.get?.(name)??'').split(',').map(part=>part.trim()).filter(Boolean);
  const windows=read('x-ratelimit-policy').map(part=>{const match=/^(\d{1,12});w=(\d{1,9})$/.exec(part.replace(/\s+/g,''));return match?{limit:Number(match[1]),seconds:Number(match[2])}:null;});
  const left=read('x-ratelimit-remaining').map(part=>/^\d{1,12}$/.test(part)?Number(part):null);
  if(!windows.length||windows.includes(null)||left.length!==windows.length||left.includes(null))return null;
  const longest=windows.reduce((best,window,index)=>window.seconds>windows[best].seconds?index:best,0);
  if(windows[longest].seconds<86_400)return null;
  return {limit:windows[longest].limit,left:left[longest],days:Math.round(windows[longest].seconds/86_400)};
}
const whole=(value,least,most,fallback)=>Number.isInteger(value)&&value>=least&&value<=most?value:fallback;
export function growthResearch({ apiKey, fetchImpl=fetch, paceMs=1100 }) {
  // The provider serves one request a second on its entry plan: callers that make several calls in one run wait this long between them.
  let allowance=null;
  return { configured:Boolean(apiKey), paceMs, allowance:()=>allowance, async search(product,{domain=null,topic=null,query=null,count=10,offset=0,signal}={}) {
    if (!apiKey || !playbooks[product]) return [];
    const q=domain?`site:${domain} ${playbooks[product].audience}`:topic?`${playbooks[product].audience} ${topic}`:query?String(query).slice(0,300):playbooks[product].query;
    const size=whole(count,1,searchResultLimit,10),page=whole(offset,0,9,0);
    const response=await fetchImpl(`https://api.search.brave.com/res/v1/web/search?count=${size}${page?`&offset=${page}`:''}&q=${encodeURIComponent(q)}`,{
      headers:{Accept:'application/json','X-Subscription-Token':apiKey},redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000),
    });
    allowance=searchAllowance(response.headers)??allowance;
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
