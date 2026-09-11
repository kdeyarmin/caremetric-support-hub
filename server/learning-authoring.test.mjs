import { expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { digest } from './sms-auth.mjs';
import { learningAuthoring } from './learning-authoring.mjs';
const source=JSON.parse(readFileSync(new URL('../src/imports/fixtures/governedCourse.json',import.meta.url)));
const payload=JSON.stringify(source), revision=digest(payload), id='bbbbbbbb-0000-0000-0000-000000000001', hash='b'.repeat(64);
const preview={commandId:id,courseId:source.sourceCourseId,action:'learning.cloneVersion',reason:'Reviewed native source for the next revision',previewDigest:hash,
  expiresAt:new Date(Date.now()+240000).toISOString(),before:{courseId:source.sourceCourseId,versionId:source.sourceVersionId,sourceRevision:revision,status:'published',versionNumber:2,title:'Original',currentVersionId:source.sourceVersionId},
  after:{status:'draft',versionNumber:3,title:'New draft',sourceVersionId:source.sourceVersionId}};
const outcome={commandId:id,courseId:source.sourceCourseId,action:preview.action,versionId:id,versionNumber:3,status:'draft',appliedAt:new Date().toISOString(),replayed:false};
const request={operation:'preview',courseId:source.sourceCourseId,requestId:id,action:preview.action,reason:preview.reason,parameters:{versionId:source.sourceVersionId,sourceRevision:revision,title:'New draft'}};
function setup({head=revision,revoked=false,cached=false,sourceChanged=false}={}) {
  const query=vi.fn(async(sql)=>{
    if(sql.includes('select s.id,s.user_id'))return {rows:[{id,user_id:id}]};
    if(sql==='select hub.authorize_app_command() as actor') {if(revoked)throw Object.assign(new Error('private detail'),{code:'42501'});return {rows:[{actor:{user_id:id,session_id:id}}]};}
    if(sql.includes('list_learning_source_heads'))return {rows:[{value:head?[{sourceCourseId:source.sourceCourseId,sourceRevision:head,snapshotId:id}]:[]}]};
    if(sql.includes('remember_learning_authoring_preview'))return {rows:[{value:preview}]};
    if(sql.includes('get_learning_authoring_intent'))return {rows:[{value:{preview,result:cached?outcome:null}}]};
    if(sql.includes('record_learning_authoring_result'))return {rows:[{value:outcome}]};
    if(sql.includes('stage_learning_source'))return {rows:[{value:{snapshotId:id,sourceRevision:revision,headRevision:revision,sequence:1,replayed:false}}]};
    return {rows:[]};
  });
  const issue=vi.fn(async()=> 'cmh_'+'x'.repeat(43));
  const fetchImpl=vi.fn(async(_url,options)=>{
    const op=JSON.parse(options.body);
    if(op.operation==='source') {const p=sourceChanged?payload+' ':payload;return Response.json({courseId:source.sourceCourseId,versionId:source.sourceVersionId,payload:p,sourceRevision:digest(p)});}
    return Response.json(op.operation==='preview'?preview:outcome);
  });
  return {query,issue,fetchImpl,run:learningAuthoring({pool:{connect:async()=>({query,release:vi.fn()})},issue,fetchImpl})};
}
it('refuses an unpreserved source before native preview and cannot proxy arbitrary fields',async()=>{
  const f=setup({head:null});await expect(f.run('x'.repeat(43),request)).rejects.toMatchObject({status:409});expect(f.fetchImpl).not.toHaveBeenCalled();
  await expect(f.run('x'.repeat(43),{...request,actor:id})).rejects.toMatchObject({status:400});
});
it('pins the verified preview through current local authority and fixed native operation',async()=>{
  const f=setup();expect(await f.run('x'.repeat(43),request)).toEqual(preview);
  expect(f.issue).toHaveBeenCalledWith('x'.repeat(43),'carebase.learning',request);
  expect(f.fetchImpl.mock.calls[0][0]).toBe('https://cmcarebase.com/api/learning-admin/authoring');
  expect(f.fetchImpl.mock.calls[0][1].redirect).toBe('error');expect(f.fetchImpl.mock.calls[0][1].headers.Cookie).toBeUndefined();
  expect(f.query.mock.calls.filter(c=>c[0]==='select hub.authorize_app_command() as actor')).toHaveLength(2);
});
it('a cached completion still reauthorizes the native administrator on retry',async()=>{
  const f=setup({cached:true});expect(await f.run('x'.repeat(43),{operation:'apply',commandId:id,expectedDigest:hash})).toEqual(outcome);
  expect(f.issue).toHaveBeenCalledTimes(1);expect(f.fetchImpl).toHaveBeenCalledTimes(1);
});
it('source preservation refetches exact bytes and rejects changes since review',async()=>{
  const f=setup({sourceChanged:true});await expect(f.run('x'.repeat(43),{operation:'preserve_source',courseId:source.sourceCourseId,versionId:source.sourceVersionId,sourceRevision:revision,expectedHeadRevision:null,reviewed:true})).rejects.toMatchObject({status:409});
  expect(f.query.mock.calls.some(c=>c[0].includes('stage_learning_source'))).toBe(false);
});
it('current Hub revocation prevents both fresh and cached native apply',async()=>{
  const f=setup({revoked:true,cached:true});await expect(f.run('x'.repeat(43),{operation:'apply',commandId:id,expectedDigest:hash})).rejects.toMatchObject({status:403,code:'forbidden'});
  expect(f.issue).not.toHaveBeenCalled();
});
it('cancellation bounds a connection that never resolves',async()=>{
  const controller=new AbortController();const run=learningAuthoring({pool:{connect:()=>new Promise(()=>{})},issue:vi.fn(),fetchImpl:vi.fn()});
  const result=run('x'.repeat(43),request,controller.signal);controller.abort();await expect(result).rejects.toMatchObject({status:503});
});
