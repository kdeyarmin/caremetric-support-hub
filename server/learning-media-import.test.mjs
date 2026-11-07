import { createHash, randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { DEFAULT_MEDIA_IMPORT_HOSTS, learningMediaImport, mediaImportHosts } from './learning-media-import.mjs';

const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
// A 24-byte ftyp box (isom, compatible isom/mp41) followed by synthetic payload: enough for the MP4 signature check.
const mp4=label=>Buffer.concat([Buffer.from([0,0,0,24]),Buffer.from('ftypisom'),Buffer.from([0,0,2,0]),Buffer.from('isommp41'),Buffer.from(`synthetic ${label}`)]);
const captions='WEBVTT\n\n00:00.000 --> 00:01.500\nWelcome to the lesson.\n';
const transcript='Welcome to the lesson.\n';
const manifestSha256='a'.repeat(64);
const row=(n,overrides={})=>({product:'pennsync',courseTitle:'Infection control',lessonTitle:`Lesson ${n}`,
  sourceRecord:`65f1a2b3c4d5e6f708192a3${n}`,durationSeconds:2,mp4Url:`https://resource2.heygen.ai/video/${n}.mp4`,posterUrl:null,
  captionsFile:`captions/${n}.vtt`,transcriptFile:`transcripts/${n}.txt`,heygenVideoId:`render${n}abc`,...overrides});
const stage=(r,extra={})=>({operation:'stage',manifestSha256,row:r,captions,transcript,...extra});

/** An in-memory stand-in for the private SQL functions: identity, leases and states as the migration defines them. */
function fakeDatabase() {
  const items=new Map(),calls=[];
  const view=item=>({itemKey:item.key,product:item.row.product,courseTitle:item.row.courseTitle,lessonTitle:item.row.lessonTitle,
    sourceRecord:item.row.sourceRecord,heygenVideoId:item.row.heygenVideoId,durationSeconds:item.row.durationSeconds,mp4Url:item.row.mp4Url,
    captionsFile:item.row.captionsFile,transcriptFile:item.row.transcriptFile,state:item.state,failureCode:item.failureCode,mediaId:item.mediaId,
    sourceSha256:item.sourceSha256,byteSize:item.byteSize,attempts:item.attempts,updatedAt:new Date(0).toISOString(),
    target:{state:'missing_draft',itemId:null,draftTitle:null,unitId:null,unitTitle:null}});
  const uuid=seed=>{const h=digest(seed);return `${h.slice(0,8)}-${h.slice(8,12)}-8${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;};
  const query=vi.fn(async(sql,values=[])=>{
    if(sql.includes('select s.id,s.user_id'))return {rows:[{id:randomUUID(),user_id:randomUUID()}]};
    const call=/private\.learning_media_import_(\w+)\(/.exec(sql)?.[1];
    if(!call)return {rows:[]};
    calls.push(call);
    let value;
    if(call==='begin'){
      const r=JSON.parse(values[0]),key=`${r.product}:${r.sourceRecord}:${r.heygenVideoId}`,item=items.get(key);
      const same=item&&item.row.mp4Url===r.mp4Url&&item.captionsSha256===values[1]&&item.transcriptSha256===values[3];
      if(item&&(item.state==='staged'||item.state==='registered')&&same)value={action:'done',item:view(item)};
      else{
        const next={key,row:r,captionsSha256:values[1],transcriptSha256:values[3],state:'fetching',lease:randomUUID(),attempts:(item?.attempts??0)+1,
          failureCode:null,mediaId:null,sourceSha256:null,byteSize:null};
        items.set(key,next);value={action:'fetch',lease:next.lease};
      }
    }
    if(call==='prepare'){
      const item=items.get(values[0]);if(item.lease!==values[1])throw Object.assign(new Error('stale'),{code:'40001'});
      Object.assign(item,{sourceSha256:values[2],byteSize:values[3],mediaId:uuid(`${item.key}:${values[2]}:${item.captionsSha256}:${item.transcriptSha256}`)});
      value=item.mediaId;
    }
    if(call==='finish'){const item=items.get(values[0]);Object.assign(item,{state:'staged',lease:null});value=view(item);}
    if(call==='fail'){const item=items.get(values[0]);if(item.lease===values[1])Object.assign(item,{state:'failed',failureCode:values[2],lease:null});value=view(item);}
    if(call==='list')value={items:[...items.values()].map(view)};
    return {rows:[{value}]};
  });
  return {items,calls,query,pool:{connect:async()=>({query,release:vi.fn()})}};
}
function fakeStorage({tamper=null,refuse=false}={}) {
  const objects=new Map(),uploads=[];
  return {objects,uploads,
    upload:vi.fn(async(_session,path,body,contentType)=>{
      uploads.push(path);
      // Production app-media reports Storage's 400 "Duplicate" answer for an existing object as 503.
      if(objects.has(path)||refuse)return Response.json({error:'Upload failed'},{status:503});
      const bytes=Buffer.from(await new Response(body).arrayBuffer());
      objects.set(path,{bytes,contentType});return Response.json({uploaded:true});
    }),
    download:vi.fn(async(_session,path)=>{
      const object=objects.get(path);if(!object)return new Response(null,{status:404});
      return new Response(tamper&&path.endsWith(tamper)?Buffer.concat([object.bytes.subarray(0,-1),Buffer.from('X')]):object.bytes);
    })};
}
/** Each URL maps to a response factory; anything else is a 404. */
function source(routes) {
  return vi.fn(async(url,options)=>{
    expect(options.redirect).toBe('manual');expect(options.credentials).toBe('omit');
    const route=routes[url];return route?route():new Response('missing',{status:404});
  });
}
const video=(bytes,headers={})=>()=>new Response(bytes,{status:200,headers:{'Content-Type':'video/mp4','Content-Length':String(bytes.length),...headers}});
const redirect=location=>()=>new Response(null,{status:302,headers:{Location:location}});
function setup({routes={},hosts=DEFAULT_MEDIA_IMPORT_HOSTS,tamper=null,refuse=false,enabled=true}={}) {
  const db=fakeDatabase(),storage=fakeStorage({tamper,refuse}),fetchImpl=source(routes);
  return {db,storage,fetchImpl,run:input=>learningMediaImport({pool:db.pool,storage,hosts,fetchImpl,enabled})('session-token',input)};
}

it('reads exact allowlisted hosts and refuses a setting it cannot use', () => {
  expect(mediaImportHosts(undefined)).toEqual(DEFAULT_MEDIA_IMPORT_HOSTS);
  expect(mediaImportHosts(' Media.Example.com , cdn.example.org ')).toEqual(['media.example.com','cdn.example.org']);
  for(const value of ['*.heygen.ai','https://resource2.heygen.ai','resource2.heygen.ai:443','localhost',','])expect(mediaImportHosts(value)).toBeNull();
});

it('refuses an MP4 URL outside the allowlist before recording or fetching anything', async () => {
  const f=setup();
  await expect(f.run(stage(row(1,{mp4Url:'https://videos.example.com/1.mp4'})))).rejects.toMatchObject({status:422,code:'host_not_allowed'});
  await expect(f.run(stage(row(1,{mp4Url:'https://resource2.heygen.ai.example.com/1.mp4'})))).rejects.toMatchObject({status:422,code:'host_not_allowed'});
  const unconfigured=setup({hosts:null});
  await expect(unconfigured.run(stage(row(1)))).rejects.toMatchObject({status:422,code:'host_not_allowed'});
  for(const fixture of [f,unconfigured]){expect(fixture.fetchImpl).not.toHaveBeenCalled();expect(fixture.db.calls).toEqual([]);}
  // A non-https URL never reaches the server's host check: the request schema rejects it.
  await expect(f.run(stage(row(1,{mp4Url:'http://resource2.heygen.ai/1.mp4'})))).rejects.toMatchObject({status:400,code:'invalid_request'});
});

it('follows redirects only to allowlisted https hosts and records a refused hop as the row failure', async () => {
  const bytes=mp4('one');
  const allowed=setup({routes:{'https://resource2.heygen.ai/video/1.mp4':redirect('https://files2.heygen.ai/a/1.mp4'),'https://files2.heygen.ai/a/1.mp4':video(bytes)}});
  const staged=await allowed.run(stage(row(1)));
  expect(staged.item).toMatchObject({state:'staged',sourceSha256:digest(bytes),byteSize:bytes.length});
  expect(allowed.fetchImpl).toHaveBeenCalledTimes(2);
  for(const location of ['https://cdn.example.net/1.mp4','http://files2.heygen.ai/a/1.mp4','https://user:pass@files2.heygen.ai/a/1.mp4']){
    const refused=setup({routes:{'https://resource2.heygen.ai/video/1.mp4':redirect(location)}});
    const result=await refused.run(stage(row(1)));
    expect(result.item).toMatchObject({state:'failed',failureCode:'redirect_not_allowed'});
    expect(refused.fetchImpl).toHaveBeenCalledTimes(1);expect(refused.storage.upload).not.toHaveBeenCalled();
  }
  const looping=setup({routes:{'https://resource2.heygen.ai/video/1.mp4':redirect('https://resource2.heygen.ai/video/1.mp4')}});
  expect((await looping.run(stage(row(1)))).item.failureCode).toBe('redirect_not_allowed');
  expect(looping.fetchImpl).toHaveBeenCalledTimes(4);
});

it('stores the MP4, captions and transcript and stages only after the stored copies hash to the verified source', async () => {
  const bytes=mp4('one'),f=setup({routes:{'https://resource2.heygen.ai/video/1.mp4':video(bytes)}});
  const result=await f.run(stage(row(1)));
  expect(result).toMatchObject({replayed:false,item:{state:'staged',sourceSha256:digest(bytes),byteSize:bytes.length}});
  const prefix=`learning/${result.item.mediaId}/`;
  expect([...f.storage.objects.keys()]).toEqual([prefix+'video.mp4',prefix+'captions.vtt',prefix+'transcript.txt']);
  expect(f.storage.objects.get(prefix+'video.mp4')).toMatchObject({bytes,contentType:'video/mp4'});
  expect(f.storage.objects.get(prefix+'captions.vtt').bytes.toString()).toBe(captions);
  expect(f.storage.download).toHaveBeenCalledTimes(3);
  expect(f.db.calls).toEqual(['begin','prepare','finish']);
});

it('fails a row whose stored copy does not match the downloaded source, and never stages it', async () => {
  for(const part of ['video.mp4','captions.vtt','transcript.txt']){
    const f=setup({routes:{'https://resource2.heygen.ai/video/1.mp4':video(mp4('one'))},tamper:part});
    const result=await f.run(stage(row(1)));
    expect(result.item).toMatchObject({state:'failed',failureCode:'hash_mismatch'});
    expect(f.db.calls).toEqual(['begin','prepare','fail']);
  }
});

it('checks the declared type, the MP4 signature and the size before storing anything', async () => {
  const bytes=mp4('one'),url='https://resource2.heygen.ai/video/1.mp4';
  const cases=[
    [video(bytes,{'Content-Type':'text/html'}),'invalid_type'],
    [()=>new Response(Buffer.from('<html>not a video</html>'),{status:200,headers:{'Content-Type':'video/mp4'}}),'invalid_type'],
    [video(bytes,{'Content-Encoding':'gzip'}),'invalid_type'],
    [video(bytes,{'Content-Length':String(bytes.length+10)}),'size_mismatch'],
    [video(bytes,{'Content-Length':String(268435457)}),'too_large'],
    [()=>new Response('gone',{status:410}),'source_unavailable'],
  ];
  for(const [response,code] of cases){
    const f=setup({routes:{[url]:response}});
    expect((await f.run(stage(row(1)))).item).toMatchObject({state:'failed',failureCode:code});
    expect(f.storage.upload).not.toHaveBeenCalled();
  }
  const octet=setup({routes:{[url]:video(bytes,{'Content-Type':'application/octet-stream'})}});
  expect((await octet.run(stage(row(1)))).item.state).toBe('staged');
});

it('keeps going after one row fails: the others stage and the failed row records why', async () => {
  const f=setup({routes:{'https://resource2.heygen.ai/video/1.mp4':video(mp4('one')),'https://resource2.heygen.ai/video/3.mp4':video(mp4('three'))}});
  const results=[];
  for(const n of [1,2,3])results.push(await f.run(stage(row(n))));
  expect(results.map(r=>[r.item.lessonTitle,r.item.state,r.item.failureCode])).toEqual([
    ['Lesson 1','staged',null],['Lesson 2','failed','source_unavailable'],['Lesson 3','staged',null]]);
  expect(new Set([...f.storage.objects.keys()].map(key=>key.split('/')[1])).size).toBe(2);
  const listed=await f.run({operation:'list'});
  expect(listed.items.map(item=>item.state).sort()).toEqual(['failed','staged','staged']);
});

it('retries without duplicating: identical content is not fetched again and the same bytes reuse one storage prefix', async () => {
  const bytes=mp4('one'),url='https://resource2.heygen.ai/video/1.mp4';
  let available=false;
  const f=setup({routes:{[url]:()=>available?video(bytes)():new Response('later',{status:503})}});
  const failed=await f.run(stage(row(1)));
  expect(failed.item).toMatchObject({state:'failed',failureCode:'source_unavailable',attempts:1});
  available=true;
  const staged=await f.run(stage(row(1)));
  expect(staged).toMatchObject({replayed:false,item:{state:'staged',attempts:2}});
  const fetches=f.fetchImpl.mock.calls.length,uploads=f.storage.uploads.length;
  const replay=await f.run(stage(row(1)));
  expect(replay).toMatchObject({replayed:true,item:{state:'staged',mediaId:staged.item.mediaId}});
  expect(f.fetchImpl.mock.calls.length).toBe(fetches);expect(f.storage.uploads.length).toBe(uploads);
  // A lost response after storage: the next attempt's uploads are refused (503, as app-media answers a duplicate)
  // and the stored bytes are verified instead.
  f.db.items.get(`pennsync:${row(1).sourceRecord}:${row(1).heygenVideoId}`).state='failed';
  const recovered=await f.run(stage(row(1)));
  expect(recovered.item).toMatchObject({state:'staged',mediaId:staged.item.mediaId});
  expect(f.storage.objects.size).toBe(3);
  // Corrected captions are new content: a new prefix, never an overwrite of stored objects.
  const corrected=await f.run(stage(row(1),{captions:captions.replace('Welcome','Hello')}));
  expect(corrected.item.state).toBe('staged');expect(corrected.item.mediaId).not.toBe(staged.item.mediaId);
  expect(f.storage.objects.size).toBe(6);
});

it('fails a row as storage_unavailable when Storage refuses an upload and nothing was stored', async () => {
  const f=setup({routes:{'https://resource2.heygen.ai/video/1.mp4':video(mp4('one'))},refuse:true});
  expect((await f.run(stage(row(1)))).item).toMatchObject({state:'failed',failureCode:'storage_unavailable'});
  expect(f.storage.upload).toHaveBeenCalledTimes(3);expect(f.db.calls).toEqual(['begin','prepare','fail']);
});

it('refuses unusable captions or transcripts before any transfer', async () => {
  const f=setup({routes:{'https://resource2.heygen.ai/video/1.mp4':video(mp4('one'))}});
  await expect(f.run(stage(row(1),{captions:'not captions'}))).rejects.toMatchObject({status:422,code:'invalid_captions'});
  await expect(f.run(stage(row(1),{captions:'WEBVTT\n\n00:00.000 --> 00:09.000\nRuns past the video.\n'}))).rejects.toMatchObject({status:422,code:'invalid_captions'});
  await expect(f.run(stage(row(1),{transcript:'See https://example.com for more.'}))).rejects.toMatchObject({status:422,code:'invalid_transcript'});
  expect(f.fetchImpl).not.toHaveBeenCalled();expect(f.db.calls).toEqual([]);
});

it('refuses malformed requests and stays closed until the database declares the feature', async () => {
  const f=setup();
  await expect(f.run({operation:'stage',row:row(1)})).rejects.toMatchObject({status:400,code:'invalid_request'});
  await expect(f.run({operation:'register',mediaId:randomUUID(),reviewed:false})).rejects.toMatchObject({status:400,code:'invalid_request'});
  await expect(f.run(stage(row(1,{product:'carebase'})))).rejects.toMatchObject({status:400,code:'invalid_request'});
  const off=setup({enabled:false});
  await expect(off.run({operation:'list'})).rejects.toMatchObject({status:503,code:'unavailable'});
  expect(off.db.calls).toEqual([]);
});
