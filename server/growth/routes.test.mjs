import {afterAll,beforeAll,it,expect,vi} from 'vitest';
import {once} from 'node:events';
import {appServer} from '../http.mjs';
let server,base;const origin='https://hub.example.org';
const growth={appActivity:vi.fn(async()=>({replay:false})),admin:vi.fn(async()=>({ok:true})),activity:vi.fn(async()=>({ok:true})),delivery:vi.fn(async()=>({ok:true})),unsubscribe:vi.fn(async()=>'<p>Unsubscribe</p>')};
beforeAll(async()=>{server=appServer({growth,origins:[origin],gateway:{},auth:{},delegations:{}});server.listen(0,'127.0.0.1');await once(server,'listening');base=`http://127.0.0.1:${server.address().port}`;});
afterAll(()=>new Promise(r=>server.close(r)));
it('owner mutations require same-origin requests',async()=>{for(const headers of [{},{Origin:'https://other.example'}])expect((await fetch(base+'/api/admin/growth',{method:'POST',headers:{'Content-Type':'application/json',...headers},body:'{}'})).status).toBe(403);expect(growth.admin).not.toHaveBeenCalled();});
it('product feeds reject browser credentials and preserve exact signed bytes',async()=>{
 expect((await fetch(base+'/api/growth/events/carebase',{method:'POST',headers:{Origin:origin},body:'{}'})).status).toBe(403);
 expect((await fetch(base+'/api/growth/events/carebase',{method:'POST',body:'{ "event": 1 }'})).status).toBe(200);expect(growth.activity.mock.calls[0][1].toString()).toBe('{ "event": 1 }');
 expect((await fetch(base+'/api/growth/events/carebase',{method:'POST',body:'x'.repeat(9000)})).status).toBe(413);
});
it('GET unsubscribe only previews while POST confirms',async()=>{
 const path='/api/growth/unsubscribe/'+'a'.repeat(64);await fetch(base+path);expect(growth.unsubscribe).toHaveBeenLastCalledWith('a'.repeat(64),false);await fetch(base+path,{method:'POST'});expect(growth.unsubscribe).toHaveBeenLastCalledWith('a'.repeat(64),true);
});
it('the opt-out address growth emails now carry reaches the same handler as the old one',async()=>{
 const path='/api/growth/preferences/'+'b'.repeat(64);await fetch(base+path);expect(growth.unsubscribe).toHaveBeenLastCalledWith('b'.repeat(64),false);
 await fetch(base+path,{method:'POST'});expect(growth.unsubscribe).toHaveBeenLastCalledWith('b'.repeat(64),true);
});

it('native application activity uses only server credentials and a bounded body',async()=>{
 const headers={Authorization:'Bearer cmb_'+'x'.repeat(43),'Content-Type':'application/json'};
 for(const [suffix,extra,method] of [['',{Origin:origin},'POST'],['',{Cookie:'session=x'},'POST'],['?x=1',{},'POST'],['',{},'GET']]) {
  expect((await fetch(base+'/api/apps/growth'+suffix,{method,headers:{...headers,...extra},...(method==='POST'?{body:'{}'}:{})})).status).toBe(403);
 }
 expect(growth.appActivity).not.toHaveBeenCalled();
 expect((await fetch(base+'/api/apps/growth',{method:'POST',headers,body:'{}'})).status).toBe(200);
 expect(growth.appActivity).toHaveBeenCalledWith(headers.Authorization,{});
 expect((await fetch(base+'/api/apps/growth',{method:'POST',headers,body:'x'.repeat(9000)})).status).toBe(413);
});
