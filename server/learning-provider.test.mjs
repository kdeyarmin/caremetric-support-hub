import {expect,it,vi} from 'vitest';
import {learningProvider} from './learning-provider.mjs';
import {providerContext,providerCourse} from '../src/learning/testFixtures/provider.ts';
const request={domain:'course.provider.v1',operation:'context',courseId:providerCourse};
function setup({revoked=false,tamper=false}={}){
  const query=vi.fn(async sql=>{
    if(sql.includes('select s.id,s.user_id'))return {rows:[{id:providerCourse,user_id:providerCourse}]};
    if(sql==='select hub.authorize_app_command() as actor'&&revoked)throw Object.assign(new Error('private details'),{code:'42501'});
    return {rows:[]};
  });
  const issue=vi.fn(async()=> 'cmh_'+'x'.repeat(43));
  const fetchImpl=vi.fn(async()=>Response.json(tamper?{...providerContext,privateKey:'hidden'}:providerContext));
  return {query,issue,fetchImpl,run:learningProvider({pool:{connect:async()=>({query,release:vi.fn()})},issue,fetchImpl})};
}
it('uses fixed native transport and rechecks current relational authority after native I/O',async()=>{
  const f=setup();expect(await f.run('x'.repeat(43),request)).toEqual(providerContext);
  expect(f.issue).toHaveBeenCalledWith('x'.repeat(43),'carebase.learning',request);
  expect(f.fetchImpl.mock.calls[0][0]).toBe('https://cmcarebase.com/api/learning-admin/provider');
  expect(f.fetchImpl.mock.calls[0][1].redirect).toBe('error');expect(Object.keys(f.fetchImpl.mock.calls[0][1].headers).sort()).toEqual(['Authorization','Content-Type']);
  expect(f.query).toHaveBeenCalledWith('select hub.authorize_app_command() as actor');
});
it('blocks domain confusion before issuing a ticket and hides revoked or unprojected responses',async()=>{
  const f=setup();await expect(f.run('x'.repeat(43),{operation:'apply',commandId:providerCourse,expectedDigest:'a'.repeat(64)})).rejects.toMatchObject({status:400});expect(f.issue).not.toHaveBeenCalled();
  await expect(setup({revoked:true}).run('x'.repeat(43),request)).rejects.toMatchObject({status:403});
  await expect(setup({tamper:true}).run('x'.repeat(43),request)).rejects.toMatchObject({status:503});
});
it('cancellation bounds ticket issuance and prevents a late network write',async()=>{
  let resolveIssue;const issue=new Promise(resolve=>{resolveIssue=resolve;});const fetchImpl=vi.fn();
  const run=learningProvider({pool:{},issue:()=>issue,fetchImpl}),controller=new AbortController();
  const pending=run('x'.repeat(43),request,controller.signal);controller.abort();await expect(pending).rejects.toMatchObject({status:503});
  resolveIssue('cmh_'+'x'.repeat(43));await Promise.resolve();expect(fetchImpl).not.toHaveBeenCalled();
});
