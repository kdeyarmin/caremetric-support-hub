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
  const logs=[];
  return {query,issue,fetchImpl,logs,run:learningGeneration({pool:{connect:async()=>({query,release:vi.fn()})},issue,fetchImpl,log:line=>logs.push(JSON.parse(line))})};
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
const options={operation:'video.options',request:{}};
it('loads HeyGen avatars and voices that arrive without a name, gender or language',async()=>{
  // The shape CareBase's list-heygen-options sends: fields HeyGen left out are undefined there, so they are absent here.
  const listed={operation:'video.options',result:{success:true,avatars:[{id:'look-1',avatar_type:'instant_avatar',group_name:null,is_ai_twin:true,is_private:true,default_voice_id:null}],
    voices:[{voice_id:'v1',gender:'male'}]}};
  const f=setup({respond:()=>Response.json(listed)});
  expect(await f.run('x'.repeat(43),options)).toEqual({avatars:[{id:'look-1',name:null,gender:null,aiTwin:true,private:true,defaultVoiceId:null}],voices:[{id:'v1',name:null,language:null,gender:'male'}]});
  expect(f.logs).toEqual([]);
});
it('says why in one line whenever it answers 503, and logs nothing CareBase, HeyGen or the administrator wrote',async()=>{
  const event='hub_learning_generation_unavailable';
  const cases=[
    [{respond:()=>Response.json({error:{code:'provider_runtime_busy',message:'Two generations are already running for Dr. Private.'}},{status:503})},{status:503,code:'provider_runtime_busy'},
      {event,operation:'video.options',status:503,reason:'carebase_status',carebaseCode:'provider_runtime_busy'}],
    [{respond:()=>Response.json({error:{code:'Not a code! private',message:'secret'}},{status:500})},{status:503,code:'upstream'},
      {event,operation:'video.options',status:500,reason:'carebase_status',carebaseCode:null}],
    [{respond:()=>Response.json({operation:'video.options',result:{success:true,avatars:[{name:'Dr. Private',is_ai_twin:false,is_private:true}],voices:[]}})},{status:503,code:'upstream'},
      {event,operation:'video.options',status:200,reason:'invalid_result',issue:'avatars.0.id: invalid_type'}],
    [{respond:()=>Response.json({operation:'video.options',result:{success:true,avatars:[],voices:[]},note:'private'})},{status:503,code:'upstream'},
      {event,operation:'video.options',status:200,reason:'invalid_result',issue:'(root): unrecognized_keys note'}],
    [{respond:()=>new Response('<html>private</html>',{status:200})},{status:503,code:'upstream'},
      {event,operation:'video.options',status:200,reason:'invalid_result',issue:'not_json'}],
    [{respond:()=>new Response('x'.repeat(1100001),{status:200})},{status:503,code:'upstream'},
      {event,operation:'video.options',status:200,reason:'response_too_large',limit:1100000}],
  ];
  for(const [options_,expected,line] of cases){
    const f=setup(options_);
    await expect(f.run('x'.repeat(43),options),line.reason).rejects.toMatchObject(expected);
    expect(f.logs,line.reason).toEqual([line]);
    expect(JSON.stringify(f.logs)).not.toMatch(/private|secret|Private/i);
  }
  const unreachable=setup();unreachable.fetchImpl.mockRejectedValue(new TypeError('fetch failed',{cause:Object.assign(new Error('socket hang up at 10.0.0.1'),{code:'ECONNRESET'})}));
  await expect(unreachable.run('x'.repeat(43),options)).rejects.toMatchObject({status:503,code:'upstream'});
  expect(unreachable.logs).toEqual([{event,operation:'video.options',status:null,reason:'carebase_unreachable',error:'ECONNRESET'}]);
  const delegation=setup();delegation.issue.mockRejectedValue(Object.assign(new Error('connection to db.private.example refused'),{code:'08006'}));
  await expect(delegation.run('x'.repeat(43),options)).rejects.toMatchObject({status:503,code:'upstream'});
  expect(delegation.logs).toEqual([{event,operation:'video.options',status:null,reason:'delegation_failed',error:'08006'}]);
  const recheck=setup({respond:()=>Response.json({operation:'video.options',result:{success:true,avatars:[],voices:[]}})});
  recheck.query.mockImplementation(async sql=>{if(sql.includes('select s.id,s.user_id'))return {rows:[{id,user_id:id}]};if(sql==='select hub.authorize_app_command() as actor')throw Object.assign(new Error('private details'),{code:'57P01'});return {rows:[]};});
  await expect(recheck.run('x'.repeat(43),options)).rejects.toMatchObject({status:503,code:'upstream'});
  expect(recheck.logs).toEqual([{event,operation:'video.options',status:200,reason:'session_recheck_failed',error:'57P01'}]);
});
it('writes no line for an answer that is not a 503',async()=>{
  for(const [status,error] of [[403,{code:'forbidden'}],[409,{code:'conflict'}],[504,{code:'timeout'}],[502,{code:'upstream'}],[404,{code:'invalid_request'}]]){
    const f=setup({respond:()=>Response.json({error},{status})});
    await expect(f.run('x'.repeat(43),regenerate),String(status)).rejects.toBeDefined();
    expect(f.logs,String(status)).toEqual([]);
  }
  const revoked=setup({revoked:true});await expect(revoked.run('x'.repeat(43),regenerate)).rejects.toMatchObject({status:403});expect(revoked.logs).toEqual([]);
  const ok=setup();await ok.run('x'.repeat(43),regenerate);expect(ok.logs).toEqual([]);
});
