/** Server-only adapter for native CareBase/Intel applications. Never include the signing key in browser code. */
import { createHmac } from 'node:crypto';
import { activitySchema } from './protocol.mjs';
import { products } from './policy.mjs';
export function customerActivityClient({origin,product,key,fetchImpl=fetch,now=()=>Date.now()}) {
 const url=new URL(origin);
 if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||!products.includes(product)||typeof key!=='string'||key.length<32)throw new Error('Invalid customer activity configuration');
 return { async report(event,{signal}={}) {
   const payload=activitySchema.parse(event); // Caller supplies a stable eventKey from the native transaction/outbox.
   const raw=JSON.stringify(payload),stamp=String(Math.floor(now()/1000));
   const signature=createHmac('sha256',key).update(`${stamp}.${product}.`).update(raw).digest('hex');
   const response=await fetchImpl(new URL(`/api/growth/events/${product}`,url),{method:'POST',headers:{'Content-Type':'application/json','X-CareMetric-Timestamp':stamp,'X-CareMetric-Signature':signature},body:raw,redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000)});
   if(!response.ok)throw Object.assign(new Error('Customer activity was not acknowledged'),{status:response.status,retryable:response.status===429||response.status>=500});
   return response.json();
 }};
}
