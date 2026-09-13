from pathlib import Path

def replace(path,old,new):
 p=Path(path);t=p.read_text();assert t.count(old)==1,(path,old[:80]);p.write_text(t.replace(old,new))
replace('server/operational-configuration.mjs',"import {withSession,HttpError} from './sms-auth.mjs';", "import {HttpError} from './sms-auth.mjs';\nimport {boundedSession} from './bounded-session.mjs';")
replace('server/operational-configuration.mjs', 'await withSession(pool,sessionToken,async db=>', 'await boundedSession(pool,sessionToken,signal,async db=>')
replace('src/learning/DistributionPanel.tsx', 'documentId: block.documentId, videoLocatorSha256: block.videoLocatorSha256', 'documentId: block.documentId, videoLocatorSha256: block.videoLocatorSha256, mediaAsset: block.mediaAsset')
replace('server/learning-media.mjs',"if(!intent.canFinishThisSession||intent.sourceRevision!==current.sourceRevision||current.block.generationState==='pending')", "if(!intent.canFinishThisSession||intent.sourceRevision!==current.sourceRevision||current.block.generationState==='pending'||(current.block.type==='pdf')!==(intent.mimeType==='application/pdf'))")
replace('supabase/functions/_shared/portfolioProtocol.ts','value !== "learning.media.v1" && !learningPackageCapabilities', 'value !== "learning.media.v1" && value !== "operations.config.v1" && !learningPackageCapabilities')
with Path('server/operational-configuration.test.mjs').open('a') as f:f.write('''
it('cancels final authority pool acquisition without late queries or commit',async()=>{
  let acquire,waiting;const started=new Promise(resolve=>{waiting=resolve;});
  const query=vi.fn(),release=vi.fn(),controller=new AbortController();
  const issue=vi.fn(async()=> 'cmh_'+'x'.repeat(43));
  const run=operationalConfiguration({pool:{connect:()=>{waiting();return new Promise(resolve=>{acquire=resolve;});}},issue,
    fetchImpl:vi.fn(async()=>Response.json(configurationContext))});
  const pending=run('x'.repeat(43),request,controller.signal);
  await started;controller.abort();await expect(pending).rejects.toMatchObject({status:503});
  acquire({query,release});await new Promise(resolve=>setTimeout(resolve,0));
  expect(release).toHaveBeenCalledExactlyOnceWith(true);expect(query).not.toHaveBeenCalled();
  expect(issue).toHaveBeenCalledTimes(1);
});
it('destroys a stalled final authority transaction and never commits after cancellation',async()=>{
  let finishQuery,waiting;const started=new Promise(resolve=>{waiting=resolve;});
  const release=vi.fn(),controller=new AbortController();
  const query=vi.fn(async sql=>{
    if(sql.includes('select s.id,s.user_id'))return {rows:[{id:'11111111-1111-4111-8111-111111111111',user_id:'11111111-1111-4111-8111-111111111111'}]};
    if(sql==='select hub.authorize_app_command() as actor'){waiting();return new Promise(resolve=>{finishQuery=resolve;});}
    return {rows:[]};
  });
  const run=operationalConfiguration({pool:{connect:async()=>({query,release})},issue:async()=> 'cmh_'+'x'.repeat(43),
    fetchImpl:async()=>Response.json(configurationContext)});
  const pending=run('x'.repeat(43),request,controller.signal);
  await started;controller.abort();await expect(pending).rejects.toMatchObject({status:503});
  expect(release).toHaveBeenCalledExactlyOnceWith(true);
  finishQuery({rows:[{actor:'11111111-1111-4111-8111-111111111111'}]});await new Promise(resolve=>setTimeout(resolve,0));
  expect(query.mock.calls.some(([sql])=>sql==='commit')).toBe(false);
  expect(release).toHaveBeenCalledTimes(1);
});
''')
with Path('src/admin/portfolioProtocol.test.ts').open('a') as f:f.write('''
it.each(['breathe','pennsync','intel','caremetric-emr','caremetric-go'])('never projects native configuration capabilities to %s',product=>{
  expect(parse('capabilities',{apiVersion:1,operations:['users.list','operations.config.v1','learning.media.v1'],sourceRevision:null},product).data)
    .toEqual({apiVersion:1,operations:['users.list'],sourceRevision:null});
});
it('retains reviewed configuration and media capabilities for CareBase',()=>{
  expect(parse('capabilities',{apiVersion:1,operations:['users.list','operations.config.v1','learning.media.v1'],sourceRevision:null},'carebase').data)
    .toEqual({apiVersion:1,operations:['users.list','operations.config.v1','learning.media.v1'],sourceRevision:null});
});
''')
with Path('src/learning/DistributionPanel.test.tsx').open('a') as f:f.write('''
it('shows every immutable media identity field in the published-material review',async()=>{
  const mediaAsset={id:'d1900000-0000-4000-8000-000000000004',contentSha256:'d'.repeat(64),mimeType:'application/pdf',byteSize:12345,fileName:'Reviewed-training.pdf'};
  const payload={...fixture,blocks:fixture.blocks.map(block=>block.type==='pdf'?{...block,documentId:null,videoLocatorSha256:null,mediaAsset}:block)};
  const value=context();value.native.source={payload:JSON.stringify(payload),sourceRevision:sha};setup(value);
  await screen.findByText('Published version 2 · Original version title');
  const review=screen.getByText((_text,element)=>element?.tagName==='PRE'&&element.textContent?.includes(mediaAsset.id)===true);
  expect(JSON.parse(review.textContent!).mediaAsset).toEqual(mediaAsset);
  expect(JSON.parse(review.textContent!).documentId).toBeNull();
});
''')
# The fixture context shares the exact nested block with the returned fixture.
with Path('server/learning-media.test.mjs').open('a') as f:f.write('''
it.each([['pdf','video/mp4'],['video','application/pdf']])('rejects finishing %s with incompatible staged %s',async(type,mimeType)=>{
  const f=setup();f.context.block.type=type;f.intent.mimeType=mimeType;
  f.intent.fileName=mimeType==='application/pdf'?'lesson.pdf':'lesson.mp4';
  await expect(f.run(token,{...mediaBase,operation:'media.finish',operationId:f.intent.operationId})).rejects.toMatchObject({status:409});
  expect(f.writes()).toBe(0);
});
it.each([['pdf','application/pdf'],['video','video/mp4']])('finishes %s only with compatible staged %s',async(type,mimeType)=>{
  const f=setup();f.context.block.type=type;f.intent.mimeType=f.receipt.mimeType=mimeType;
  f.intent.fileName=f.receipt.fileName=mimeType==='application/pdf'?'lesson.pdf':'lesson.mp4';
  expect(await f.run(token,{...mediaBase,operation:'media.finish',operationId:f.intent.operationId})).toEqual(f.receipt);
  expect(f.writes()).toBe(1);
});
''')
