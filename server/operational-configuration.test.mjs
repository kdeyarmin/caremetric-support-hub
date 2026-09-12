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
  const f=setup(),controller=new AbortController();
  expect(await f.run('x'.repeat(43),request,controller.signal)).toEqual(configurationContext);
  expect(f.issue).toHaveBeenCalledWith('x'.repeat(43),'carebase.command',request,expect.any(AbortSignal));
  const issueSignal=f.issue.mock.calls[0][3],nativeSignal=f.fetchImpl.mock.calls[0][1].signal;
  expect(nativeSignal).toBeInstanceOf(AbortSignal);
  expect(issueSignal.aborted).toBe(false);expect(nativeSignal.aborted).toBe(false);
  // Native transport composes another deadline, but must inherit cancellation.
  controller.abort();expect(issueSignal.aborted).toBe(true);expect(nativeSignal.aborted).toBe(true);
  expect(f.fetchImpl.mock.calls[0][0]).toBe('https://cmcarebase.com/api/platform-admin/configuration');
  expect(f.fetchImpl.mock.calls[0][1].redirect).toBe('error');expect(Object.keys(f.fetchImpl.mock.calls[0][1].headers).sort()).toEqual(['Authorization','Content-Type']);
  expect(f.query).toHaveBeenCalledWith('select hub.authorize_app_command() as actor');
});
it('blocks domain confusion before issuing a ticket and hides revoked or unprojected responses',async()=>{
  const f=setup();await expect(f.run('x'.repeat(43),{...request,domain:'course.provider.v1'})).rejects.toMatchObject({status:400});expect(f.issue).not.toHaveBeenCalled();
  await expect(setup({revoked:true}).run('x'.repeat(43),request)).rejects.toMatchObject({status:403});
  await expect(setup({tamper:true}).run('x'.repeat(43),request)).rejects.toMatchObject({status:503});
});
it('cancellation reaches ticket issuance and prevents a late network write',async()=>{
  let resolveIssue;const pendingIssue=new Promise(resolve=>{resolveIssue=resolve;});const fetchImpl=vi.fn();
  const issue=vi.fn(()=>pendingIssue);
  const run=operationalConfiguration({pool:{},issue,fetchImpl}),controller=new AbortController();
  const pending=run('x'.repeat(43),request,controller.signal);
  const signal=issue.mock.calls[0][3];expect(signal).toBeInstanceOf(AbortSignal);expect(signal.aborted).toBe(false);
  controller.abort();await expect(pending).rejects.toMatchObject({status:503});expect(signal.aborted).toBe(true);
  resolveIssue('cmh_'+'x'.repeat(43));await Promise.resolve();expect(fetchImpl).not.toHaveBeenCalled();
});
it('never starts ticket issuance when the caller is already cancelled',async()=>{
  const f=setup(),controller=new AbortController();controller.abort();
  await expect(f.run('x'.repeat(43),request,controller.signal)).rejects.toMatchObject({status:503});
  expect(f.issue).not.toHaveBeenCalled();expect(f.fetchImpl).not.toHaveBeenCalled();
});
