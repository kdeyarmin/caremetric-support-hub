import {expect,it,vi} from 'vitest';
import {learningGeneration} from './learning-generation.mjs';
const id='ffffffff-0000-0000-0000-000000000001',other='ffffffff-0000-0000-0000-000000000002';
const regenerate={operation:'ai.regenerateBlock',request:{course_block_id:id,feedback:'Shorter, with one example.'}};
const ok={operation:'ai.regenerateBlock',result:{success:true,course_block_id:id,generation_id:other}};
function setup({revoked=false,respond=()=>Response.json(ok)}={}){
  const query=vi.fn(async sql=>{
    if(sql.includes('select s.id,s.user_id'))return {rows:[{id,user_id:id}]};
    if(sql==='select hub.authorize_app_command() as actor'&&revoked)throw Object.assign(new Error('private details'),{code:'42501'});
    return {rows:[]};
  });
  const issue=vi.fn(async()=> 'cmh_'+'x'.repeat(43));
  const fetchImpl=vi.fn(async()=>respond());
  return {query,issue,fetchImpl,run:learningGeneration({pool:{connect:async()=>({query,release:vi.fn()})},issue,fetchImpl})};
}
it('issues a ticket for the exact operation and rechecks authority after CareBase answers',async()=>{
  const f=setup();expect(await f.run('x'.repeat(43),regenerate)).toEqual({blockId:id,generationId:other});
  expect(f.issue).toHaveBeenCalledWith('x'.repeat(43),'carebase.learning',regenerate);
  expect(f.fetchImpl.mock.calls[0][0]).toBe('https://cmcarebase.com/api/learning-generation/run');
  expect(JSON.parse(f.fetchImpl.mock.calls[0][1].body)).toEqual(regenerate);
  expect(f.fetchImpl.mock.calls[0][1].redirect).toBe('error');expect(Object.keys(f.fetchImpl.mock.calls[0][1].headers).sort()).toEqual(['Authorization','Content-Type']);
  expect(f.query).toHaveBeenCalledWith('select hub.authorize_app_command() as actor');
});
it('refuses training plans and malformed requests before issuing a ticket',async()=>{
  for(const input of [{operation:'ai.generateCourse',request:{generation_mode:'training_plan',organization_id:id,plan_name:'Onboarding'}},{...regenerate,actor:id},{operation:'video.run',request:{}}]){
    const f=setup();await expect(f.run('x'.repeat(43),input)).rejects.toMatchObject({status:400,code:'invalid_request'});expect(f.issue).not.toHaveBeenCalled();
  }
});
it('passes on administrator messages and maps CareBase statuses',async()=>{
  const refuse=(status,error)=>setup({respond:()=>Response.json({error},{status})}).run('x'.repeat(43),regenerate);
  await expect(refuse(403,{code:'forbidden',message:'AI course generation is currently disabled by the platform administrator.'}))
    .rejects.toMatchObject({status:403,code:'forbidden',publicMessage:'AI course generation is currently disabled by the platform administrator.'});
  await expect(refuse(409,{code:'conflict',message:'cannot regenerate content on a published course version',detail:'private'})).rejects.toMatchObject({status:409,code:'conflict'});
  await expect(refuse(404,{code:'invalid_request'})).rejects.toMatchObject({status:400,code:'invalid_request'});
  await expect(refuse(504,{code:'timeout'})).rejects.toMatchObject({status:504,code:'timeout'});
  await expect(refuse(503,{code:'provider_runtime_busy'})).rejects.toMatchObject({status:503,code:'provider_runtime_busy'});
  await expect(refuse(503,{code:'something_else'})).rejects.toMatchObject({status:503,code:'upstream'});
  await expect(refuse(502,{code:'upstream',message:{nested:'object'}})).rejects.toMatchObject({status:502,code:'upstream'});
  const unsafe=await refuse(502,{code:'upstream',message:'bad\u0007bell'}).catch(error=>error);expect(unsafe.publicMessage).toBeUndefined();
  await expect(setup({respond:()=>Response.json({operation:'video.status',result:{success:true,status:'processing'}})}).run('x'.repeat(43),regenerate)).rejects.toMatchObject({status:503});
  await expect(setup({revoked:true}).run('x'.repeat(43),regenerate)).rejects.toMatchObject({status:403});
});
it('reports a cancelled request as a timeout without a late network write',async()=>{
  let resolveIssue;const issue=new Promise(resolve=>{resolveIssue=resolve;});const fetchImpl=vi.fn();
  const run=learningGeneration({pool:{},issue:()=>issue,fetchImpl}),controller=new AbortController();
  const pending=run('x'.repeat(43),regenerate,controller.signal);controller.abort();resolveIssue('cmh_'+'x'.repeat(43));
  await expect(pending).rejects.toMatchObject({status:504,code:'timeout'});expect(fetchImpl).not.toHaveBeenCalled();
});
