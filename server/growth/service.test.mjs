import {it,expect,vi} from 'vitest';
import {createHmac} from 'node:crypto';
import {growthService} from './service.mjs';
import {customerActivityClient} from './event-client.mjs';
const key='synthetic-key-for-tests-only-32-characters';
const now=Date.parse('2026-11-03T12:00:00Z');
const event={tenantId:'11111111-1111-4111-8111-111111111111',eventKey:'event-1',kind:'first_value',occurredAt:new Date(now).toISOString(),facts:{}};
const fixture=()=>{const store={event:vi.fn(async()=>({replay:false})),unsubscribe:vi.fn(async()=>true),manage:vi.fn()};return {store,service:growthService({store,features:new Set(['platform.agents.customer-growth.v1']),eventKeys:{carebase:key},signingKey:key})};};
const signed=(raw,product='carebase',stamp=String(now/1000))=>({'x-caremetric-timestamp':stamp,'x-caremetric-signature':createHmac('sha256',key).update(`${stamp}.${product}.`).update(raw).digest('hex')});
it('accepts scoped signed activity and rejects tampering, expired signatures and product swaps',async()=>{
 const {store,service}=fixture();const raw=Buffer.from(JSON.stringify(event));await service.activity('carebase',raw,signed(raw),now);expect(store.event).toHaveBeenCalledWith('carebase',event);
 for(const [product,body,headers,at] of [['carebase',Buffer.from('{}'),signed(raw),now],['caremetric-intel',raw,signed(raw),now],['carebase',raw,signed(raw),now+301000]])await expect(service.activity(product,body,headers,at)).rejects.toMatchObject({status:401});
 expect(store.event).toHaveBeenCalledTimes(1);
});
it('rejects free text and patient fields even on an authenticated product feed',async()=>{
 const {store,service}=fixture();const raw=Buffer.from(JSON.stringify({...event,facts:{patientName:'synthetic'}}));await expect(service.activity('carebase',raw,signed(raw),now)).rejects.toMatchObject({status:400});expect(store.event).not.toHaveBeenCalled();
});
it('link scanners cannot unsubscribe contacts',async()=>{
 const {store,service}=fixture();const token=service.unsubscribeToken('work-1');await service.unsubscribe(token,false);expect(store.unsubscribe).not.toHaveBeenCalled();await service.unsubscribe(token,true);expect(store.unsubscribe).toHaveBeenCalledWith(service.hash(token));
});
it('preserves the native event ID across retries and interoperates with ingress verification',async()=>{
 const {service,store}=fixture();const fetchImpl=vi.fn(async(url,request)=>({ok:true,json:()=>service.activity('carebase',Buffer.from(request.body),Object.fromEntries(Object.entries(request.headers).map(([k,v])=>[k.toLowerCase(),v])),now)}));
 const client=customerActivityClient({origin:'https://hub.example.org',product:'carebase',key,fetchImpl,now:()=>now});await client.report(event);await client.report(event);expect(store.event).toHaveBeenCalledTimes(2);expect(store.event.mock.calls[0][1].eventKey).toBe(store.event.mock.calls[1][1].eventKey);
});
it('refuses Breathe and unknown administration fields',async()=>{
 const {service,store}=fixture();await expect(service.admin('token',{operation:'create',data:{name:'Example',domain:'example.org',product:'breathe',email:'',contactName:'',role:'',goal:''}})).rejects.toMatchObject({status:400});expect(store.manage).not.toHaveBeenCalled();
});
