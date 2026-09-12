import {expect,it,vi} from 'vitest';
import {operationalConfiguration} from './operational-configuration.mjs';
import {configurationContext} from '../src/admin/testFixtures/configuration.ts';
const request={domain:'operations.config.v1',operation:'context',target:configurationContext.target};
function setup({revoked=false,tamper=false}={}){
  const query=vi.fn(async sql=>{
    if(sql.includes('select s.id,s.user_id'))return {rows:[{id:'11111111-1111-4111-8111-111111111111',user_id:'11111111-1111-4111-8111-111111111111'}]};
    if(sql==='select hub.authorize_app_command() as actor'&&revoked)throw Object.assign(new Error('private details'),{code:'42501'});
    return {rows:[]};
  });
  const issue=vi.fn(async()=> 'cmh_'+'x'.repeat(43));
  const fetchImpl=vi.fn(async()=>Response.json(tamper?{...configurationContext,privateKey:'hidden'}:configurationContext));
  return {query,issue,fetchImpl,run:operationalConfiguration({pool:{connect:async()=>({query,release:vi.fn()})},issue,fetchImpl})};
}
it('uses fixed native transport and rechecks current relational authority after native I/O',async()=>{
  const f=setup();expect(await f.run('x'.repeat(43),request)).toEqual(configurationContext);
  expect(f.issue).toHaveBeenCalledWith('x'.repeat(43),'carebase.command',request);
  expect(f.fetchImpl.mock.calls[0][0]).toBe('https://cmcarebase.com/api/platform-admin/configuration');
  expect(f.fetchImpl.mock.calls[0][1].redirect).toBe('error');expect(Object.keys(f.fetchImpl.mock.calls[0][1].headers).sort()).toEqual(['Authorization','Content-Type']);
  expect(f.query).toHaveBeenCalledWith('select hub.authorize_app_command() as actor');
});
it('blocks domain confusion before issuing a ticket and hides revoked or unprojected responses',async()=>{
  const f=setup();await expect(f.run('x'.repeat(43),{...request,domain:'course.provider.v1'})).rejects.toMatchObject({status:400});expect(f.issue).not.toHaveBeenCalled();
  await expect(setup({revoked:true}).run('x'.repeat(43),request)).rejects.toMatchObject({status:403});
  await expect(setup({tamper:true}).run('x'.repeat(43),request)).rejects.toMatchObject({status:503});
});
it('cancellation bounds ticket issuance and prevents a late network write',async()=>{
  let resolveIssue;const issue=new Promise(resolve=>{resolveIssue=resolve;});const fetchImpl=vi.fn();
  const run=operationalConfiguration({pool:{},issue:()=>issue,fetchImpl}),controller=new AbortController();
  const pending=run('x'.repeat(43),request,controller.signal);controller.abort();await expect(pending).rejects.toMatchObject({status:503});
  resolveIssue('cmh_'+'x'.repeat(43));await Promise.resolve();expect(fetchImpl).not.toHaveBeenCalled();
});
it('cancellation bounds the final authority session before any late query runs',async()=>{
  let resolve,started;const query=vi.fn(),release=vi.fn(),controller=new AbortController();
  const waiting=new Promise(done=>{started=done;});
  const pool={connect:()=>{started();return new Promise(done=>{resolve=done;});}};
  const run=operationalConfiguration({pool,issue:async()=> 'cmh_'+'x'.repeat(43),fetchImpl:vi.fn(async()=>Response.json(configurationContext))});
  const pending=run('x'.repeat(43),request,controller.signal);await waiting;controller.abort();await expect(pending).rejects.toMatchObject({status:503});
  resolve({query,release});await new Promise(done=>setTimeout(done,0));expect(release).toHaveBeenCalledWith(true);expect(query).not.toHaveBeenCalled();
});
