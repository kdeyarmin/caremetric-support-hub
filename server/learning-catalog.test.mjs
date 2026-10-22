import {expect,it,vi} from 'vitest';
import {learningCatalog} from './learning-catalog.mjs';
const id='cccccccc-0000-0000-0000-000000000001',course='cccccccc-0000-0000-0000-000000000002';
const kit={id,revision:3,name:'New PCH hire',description:'First 30 days',items:[{courseId:course,isRequired:true}],published:true};
const save={operation:'starterKits.save',requestId:id,kit};
const stored={kit:{...kit,revision:4,updatedAt:'2026-10-22T12:00:00Z'}};
function setup({revoked=false,respond=()=>Response.json(stored)}={}){
  const query=vi.fn(async sql=>{
    if(sql.includes('select s.id,s.user_id'))return {rows:[{id,user_id:id}]};
    if(sql==='select hub.authorize_app_command() as actor'&&revoked)throw Object.assign(new Error('private details'),{code:'42501'});
    return {rows:[]};
  });
  const issue=vi.fn(async()=> 'cmh_'+'x'.repeat(43));
  const fetchImpl=vi.fn(async()=>respond());
  return {query,issue,fetchImpl,run:learningCatalog({pool:{connect:async()=>({query,release:vi.fn()})},issue,fetchImpl})};
}
it('issues a ticket for the exact save and rechecks current authority after CareBase answers',async()=>{
  const f=setup();expect(await f.run('x'.repeat(43),save)).toEqual(stored);
  expect(f.issue).toHaveBeenCalledWith('x'.repeat(43),'carebase.learning',save);
  expect(f.fetchImpl.mock.calls[0][0]).toBe('https://cmcarebase.com/api/learning-admin/catalog');
  expect(JSON.parse(f.fetchImpl.mock.calls[0][1].body)).toEqual(save);
  expect(f.fetchImpl.mock.calls[0][1].redirect).toBe('error');expect(Object.keys(f.fetchImpl.mock.calls[0][1].headers).sort()).toEqual(['Authorization','Content-Type']);
  expect(f.query).toHaveBeenCalledWith('select hub.authorize_app_command() as actor');
});
it('refuses an invalid record before issuing a ticket',async()=>{
  for(const input of [{...save,kit:{...kit,items:[]}},{...save,kit:{...kit,unknown:true}},{...save,actor:id},{operation:'catalog.read',section:'users',after:null},
    {operation:'collections.save',requestId:id,collection:{id,title:'Elective',description:'',interests:[],jobTitles:[],published:false,courseIds:[],signed_url:'https://x.invalid'}}]) {
    const f=setup();await expect(f.run('x'.repeat(43),input)).rejects.toMatchObject({status:400,code:'invalid_request'});expect(f.issue).not.toHaveBeenCalled();
  }
});
it('maps CareBase refusals and hides results it cannot verify',async()=>{
  await expect(setup({respond:()=>Response.json({error:{code:'invalid_request'}},{status:400})}).run('x'.repeat(43),save)).rejects.toMatchObject({status:400,code:'invalid_request'});
  await expect(setup({respond:()=>Response.json({error:{code:'conflict'}},{status:409})}).run('x'.repeat(43),save)).rejects.toMatchObject({status:409,code:'conflict'});
  await expect(setup({respond:()=>Response.json({error:{code:'unconfigured'}},{status:503})}).run('x'.repeat(43),save)).rejects.toMatchObject({status:503,code:'upstream'});
  await expect(setup({respond:()=>Response.json({kit:{...stored.kit,id:course}})}).run('x'.repeat(43),save)).rejects.toMatchObject({status:503});
  await expect(setup({revoked:true}).run('x'.repeat(43),save)).rejects.toMatchObject({status:403});
});
it('cancellation bounds ticket issuance and prevents a late network write',async()=>{
  let resolveIssue;const issue=new Promise(resolve=>{resolveIssue=resolve;});const fetchImpl=vi.fn();
  const run=learningCatalog({pool:{},issue:()=>issue,fetchImpl}),controller=new AbortController();
  const pending=run('x'.repeat(43),save,controller.signal);controller.abort();await expect(pending).rejects.toMatchObject({status:503});
  resolveIssue('cmh_'+'x'.repeat(43));await new Promise(resolve=>setTimeout(resolve,0));expect(fetchImpl).not.toHaveBeenCalled();
});
