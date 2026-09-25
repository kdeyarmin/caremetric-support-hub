import {expect,it,vi} from 'vitest';
import {trainingAdministration} from './training.mjs';
const id='11111111-1111-4111-8111-111111111111';
const request={domain:'training.v1',operation:'facilities.list',organizationId:id,search:'',limit:20,offset:0};
const result={items:[{id,name:'Test facility',facilityType:'PCH',isActive:true}],total:1,limit:20,offset:0};
function setup({revoked=false,response=result,status=200}={}){
  const query=vi.fn(async sql=>{
    if(sql.includes('select s.id,s.user_id'))return {rows:[{id,user_id:id}]};
    if(sql==='select hub.authorize_app_command() as actor'&&revoked)throw Object.assign(new Error('private detail'),{code:'42501'});
    return {rows:[]};
  });
  const issue=vi.fn(async()=> 'cmh_'+'x'.repeat(43));
  const fetchImpl=vi.fn(async()=>Response.json(response,{status}));
  return {query,issue,fetchImpl,run:trainingAdministration({pool:{connect:async()=>({query,release:vi.fn()})},issue,fetchImpl})};
}
it('uses the fixed CareBase destination, command session and projected result',async()=>{
  const f=setup({response:{...result,secret:'not returned'}}),controller=new AbortController();
  expect(await f.run('x'.repeat(43),request,controller.signal)).toEqual(result);
  expect(f.issue).toHaveBeenCalledWith('x'.repeat(43),'carebase.command',request,expect.any(AbortSignal));
  expect(f.fetchImpl.mock.calls[0][0]).toBe('https://cmcarebase.com/api/platform-admin/training');
  expect(f.query).toHaveBeenCalledWith('select hub.authorize_app_command() as actor');
  const options=f.fetchImpl.mock.calls[0][1];expect(options.redirect).toBe('error');expect(options.cache).toBe('no-store');
  expect(Object.keys(options.headers).sort()).toEqual(['Authorization','Content-Type']);
  controller.abort();expect(options.signal.aborted).toBe(true);
});
it('rejects domain confusion before ticket issuance and rechecks revocation after the native read',async()=>{
  const f=setup();await expect(f.run('x'.repeat(43),{...request,actor:id})).rejects.toMatchObject({status:400});expect(f.issue).not.toHaveBeenCalled();
  await expect(setup({revoked:true}).run('x'.repeat(43),request)).rejects.toMatchObject({status:403});
  await expect(setup({response:{...result,total:2}}).run('x'.repeat(43),request)).rejects.toMatchObject({status:503});
});
it('conveys an explicit export cap and conflict without native error detail',async()=>{
  await expect(setup({status:413,response:{secret:'private'}}).run('x'.repeat(43),request)).rejects.toMatchObject({status:413,code:'report_too_large'});
  await expect(setup({status:409,response:{secret:'private'}}).run('x'.repeat(43),request)).rejects.toMatchObject({status:409,code:'conflict'});
});
it('cancellation during ticket issuance cannot start a late native mutation',async()=>{
  let resolve;const issue=vi.fn(()=>new Promise(done=>{resolve=done;})),fetchImpl=vi.fn(),controller=new AbortController();
  const run=trainingAdministration({pool:{},issue,fetchImpl});const pending=run('x'.repeat(43),request,controller.signal);
  controller.abort();await expect(pending).rejects.toMatchObject({status:503});resolve('cmh_'+'x'.repeat(43));await Promise.resolve();expect(fetchImpl).not.toHaveBeenCalled();
});
