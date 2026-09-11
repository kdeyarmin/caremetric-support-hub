import {useEffect,useRef,useState} from 'react';
import {Link} from 'react-router-dom';
import {appRequest} from '../lib/appSession';
import {commandSchema,type Command,type Draft,type Intent,type Project,type Readiness,type Receipt} from './protocol';
import {publicationClient} from '../imports/publicationClient';
import {publicationActionLabel,publicationConfirmationIds,type PublicationStage,type PublicationReceipt} from '../imports/publicationProtocol';
import './docstudio.css';

const blank=(kind:'article'|'video'):Draft=>({kind,title:'',summary:'',locale:'en-US',accessLevel:'customer',products:[],markdown:'',assets:[],scenes:kind==='video'?[{order:1,title:'',type:'intro',durationSeconds:10,narration:'',captionText:''}]:[]});
const message=(error:unknown)=>error instanceof Error?error.message:'DocStudio could not complete this request.';
function PublicationReview({stage}:{stage:PublicationStage}) {
 const [checked,setChecked]=useState<string[]>([]),[reviewed,setReviewed]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[receipt,setReceipt]=useState<PublicationReceipt|null>(null);
 const request=useRef(crypto.randomUUID());
 if(!stage.plan)return null;
 const required=publicationConfirmationIds(stage.plan);
 async function publish(){
  if(!stage.plan || !reviewed || required.some(id=>!checked.includes(id)))return;
  setBusy(true);setError('');
  try {setReceipt(await publicationClient.commit(stage.id,{planIdentity:stage.plan.planIdentity,idempotencyKey:request.current,confirmedActions:required,reviewConfirmed:true}));}
  catch(error){setError(message(error));}finally{setBusy(false);}
 }
 return <section className="panel studio-export"><h2>{receipt?'Publication complete':'Review shared publication'}</h2>
  {receipt?<p role="status">Revision {receipt.revision} is recorded in the shared catalog. <Link to="/knowledge">Open knowledge</Link></p>:<>
   <p>{stage.manifest.content.title} · {stage.manifest.content.access_level} access</p>
   <ul>{stage.plan.actions.map((action,index)=><li key={index}>{publicationActionLabel(action)}{'productSlug' in action?` · ${action.productSlug}`:''}</li>)}</ul>
   {required.map(id=><label className="studio-check" key={id}><input type="checkbox" disabled={busy} checked={checked.includes(id)} onChange={event=>setChecked(event.target.checked?[...checked,id]:checked.filter(value=>value!==id))}/>I approve: {publicationActionLabel(stage.plan!.actions[Number(id.split(':')[0])])}</label>)}
   <label className="studio-check"><input type="checkbox" checked={reviewed} disabled={busy} onChange={event=>setReviewed(event.target.checked)}/>I reviewed the exact content, access level, and product placements and approve publishing this revision.</label>
   <button className="button button-primary" disabled={busy || !reviewed || required.some(id=>!checked.includes(id))} onClick={()=>void publish()}>{busy?'Publishing…':'Publish reviewed revision'}</button>
  </>}{error&&<p role="alert">{error}</p>}
 </section>;
}

export function DocStudioWorkspace() {
 const [ready,setReady]=useState<Readiness|null>(null),[project,setProject]=useState<Project|null>(null),[draft,setDraft]=useState<Draft|null>(null);
 const [intent,setIntent]=useState<Intent|null>(null),[reviewed,setReviewed]=useState(false),[phi,setPhi]=useState(false),[busy,setBusy]=useState(''),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const [stage,setStage]=useState<PublicationStage|null>(null),[conflict,setConflict]=useState(false),[attempted,setAttempted]=useState(false);
 const alive=useRef(true),generation=useRef(0),exportKey=useRef<string|null>(null);
 const saved=project?.draft;const dirty=!!draft && JSON.stringify(draft)!==JSON.stringify(saved);
 useEffect(()=>{alive.current=true;const controller=new AbortController();const currentGeneration=generation;appRequest<Readiness>('docstudio',undefined,controller.signal).then(setReady).catch(error=>{if(!controller.signal.aborted)setError(message(error));});return()=>{alive.current=false;controller.abort();currentGeneration.current++;};},[]);
 useEffect(()=>{
  if(!project || !project.jobs.some(job=>job.status==='queued'||job.status==='running'))return;
  const controller=new AbortController(),current=project.id;
  const timer=setInterval(()=>{void appRequest<Project>(`docstudio/projects/${current}`,undefined,controller.signal).then(value=>{
    if(value.revision!==project.revision){setConflict(true);return;}
    setProject(previous=>previous?.id===current?{...previous,jobs:value.jobs}:previous);
  }).catch(()=>{});},5000);
  return()=>{clearInterval(timer);controller.abort();};
 },[project]);
 async function run(label:string,action:()=>Promise<void>){setBusy(label);setError('');try{await action();}catch(error){if(alive.current)setError(message(error));}finally{if(alive.current)setBusy('');}}
 async function reload(id?:string){
  const current=++generation.current;
  const [data,next]=await Promise.all([appRequest<Readiness>('docstudio'),id?appRequest<Project>(`docstudio/projects/${id}`):Promise.resolve(null)]);
  if(!alive.current || current!==generation.current)return;
  setReady(data);setProject(next);setDraft(next?.draft??null);setConflict(false);setIntent(null);setStage(null);exportKey.current=null;setAttempted(false);
 }
 function newDraft(kind:'article'|'video'){generation.current++;setProject(null);setDraft(blank(kind));setIntent(null);setStage(null);setError('');setNotice('');setConflict(false);exportKey.current=null;}
 async function preview(operation:Command['operation']){
  if(!draft)return;
  const input={operation,requestId:crypto.randomUUID(),projectId:project?.id??crypto.randomUUID(),expectedRevision:project?.revision??0,...(['create','edit'].includes(operation)?{draft}:{})};
  const parsed=commandSchema.safeParse(input);
  if(!parsed.success){setError('Complete the title, summary, product selection, and content. Videos need ordered scenes with captions and narration text.');return;}
  await run('Preparing review…',async()=>{const value=await appRequest<Intent>('docstudio/preview',parsed.data);if(alive.current){setIntent(value);setReviewed(false);setPhi(false);setAttempted(false);}});
 }
 async function apply(){
  if(!intent || !reviewed || (intent.operation==='approve'&&!phi))return;
  setAttempted(true);
  await run('Saving reviewed action…',async()=>{
    const receipt=await appRequest<Receipt>('docstudio/apply',{intentId:intent.id,requestId:intent.requestId,reviewConfirmed:true,phiConfirmed:phi});
    await reload(receipt.projectId);if(alive.current)setNotice(receipt.operation==='render'?'Rendering is queued. Progress will update here.':`Saved revision ${receipt.revision}.`);
  });
 }
 async function upload(file:File|undefined){
  if(!file || !project)return;
  if(!['image/png','image/jpeg','audio/mpeg','audio/wav','audio/x-wav'].includes(file.type)||!file.size||file.size>32*1024*1024){setError('Choose a PNG, JPEG, MP3, or WAV file up to 32 MiB.');return;}
  await run('Verifying private asset…',async()=>{
   const hash=await crypto.subtle.digest('SHA-256',await file.arrayBuffer()),sha256=Array.from(new Uint8Array(hash),byte=>byte.toString(16).padStart(2,'0')).join('');
   const asset={id:crypto.randomUUID(),sha256,byteLength:file.size,mediaType:file.type==='audio/x-wav'?'audio/wav':file.type};
   await appRequest(`docstudio/projects/${project.id}/assets`,asset);
   const response=await fetch(`/api/docstudio/projects/${project.id}/assets/${asset.id}`,{method:'POST',credentials:'same-origin',redirect:'error',headers:{'Content-Type':asset.mediaType},body:file});
   if(!response.ok)throw new Error('Asset transfer was not confirmed. Upload the same file again.');
   const next=await appRequest<Project>(`docstudio/projects/${project.id}`);if(alive.current)setProject(previous=>previous?.id===next.id?{...previous,assets:next.assets}:previous);
  });
 }
 function editScene(index:number,change:Partial<Draft['scenes'][number]>){if(draft)setDraft({...draft,scenes:draft.scenes.map((scene,i)=>i===index?{...scene,...change}:scene)});}
 function assetsFor(value:Draft):Draft {
  const used=value.scenes.flatMap(scene=>scene.screenshotAssetId?[scene.screenshotAssetId]:[]).concat(value.narrationAssetId?[value.narrationAssetId]:[]);
  return {...value,assets:(project?.assets??[]).filter(asset=>used.includes(asset.id))};
 }
 async function exportDraft(){if(!project)return;exportKey.current??=crypto.randomUUID();await run('Preparing the exact publication files…',async()=>{
  const value=await appRequest<PublicationStage>('docstudio/export',{projectId:project.id,expectedRevision:project.revision,requestId:exportKey.current,reviewConfirmed:true});if(alive.current)setStage(value);
 });}
 const locked=!!busy || !!intent || conflict;
 return <div className="studio-workspace">
  <header className="page-heading"><div><p className="eyebrow">Shared content studio</p><h1>DocStudio</h1><p>Create articles and tutorial videos once, then publish them across your eligible CareMetric apps.</p></div><Link className="button button-secondary" to="/imports/docstudio">Import an existing export</Link></header>
  {error&&<p className="studio-notice" role="alert">{error}</p>}{notice&&<p className="studio-notice" role="status">{notice}</p>}{busy&&<p role="status">{busy}</p>}
  {!ready&&!error&&<p role="status">Loading the content studio…</p>}
  {ready&&<div className="studio-layout">
   <aside className="panel studio-sidebar"><h2>Saved drafts</h2><div className="studio-actions"><button className="button button-primary" disabled={locked} onClick={()=>newDraft('article')}>New article</button><button className="button button-secondary" disabled={locked} onClick={()=>newDraft('video')}>New video</button></div>
    <p>{ready.workerReady?'Video renderer is ready.':'Video renderer is currently unavailable.'} Video export limit: {ready.maxVideoBytes/1024/1024} MiB.</p>
    {ready.projects.length===0&&<p>No saved drafts yet.</p>}
    <ul>{ready.projects.map(item=><li key={item.id}><button disabled={locked} aria-current={project?.id===item.id?'page':undefined} onClick={()=>void run('Opening draft…',()=>reload(item.id))}><strong>{item.title}</strong><span>{item.kind} · revision {item.revision} · {item.status.replace('_',' ')}</span></button></li>)}</ul>
    {ready.nextCursor&&<button className="button button-secondary" disabled={locked} onClick={()=>void run('Loading older drafts…',async()=>{const next=await appRequest<Readiness>('docstudio/page',{cursor:ready.nextCursor});if(alive.current)setReady(previous=>previous?{...next,projects:[...previous.projects,...next.projects.filter(item=>!previous.projects.some(existing=>existing.id===item.id))]}:next);})}>Load older drafts</button>}
   </aside>
   <main className="studio-editor">
   {!draft?<section className="panel"><h2>Create shared help content</h2><p>Start an article or a video with scenes, captions, images, and optional recorded narration. Saved content requires an explicit review before publication.</p></section>:<>
    <section className="panel"><h2>{project?`${project.title} · revision ${project.revision}`:`New ${draft.kind}`}</h2>
     {conflict&&<p role="alert">A newer revision was saved. Reload the draft before another action.</p>}
     <fieldset disabled={locked} className="studio-fields"><label>Title<input value={draft.title} maxLength={180} onChange={event=>setDraft({...draft,title:event.target.value})}/></label><label>Summary<textarea value={draft.summary} maxLength={500} onChange={event=>setDraft({...draft,summary:event.target.value})}/></label>
      <label>Who can view published content?<select value={draft.accessLevel} onChange={event=>setDraft({...draft,accessLevel:event.target.value as Draft['accessLevel']})}><option value="customer">Signed-in customers</option><option value="staff">Staff</option><option value="public">Anyone</option></select></label>
      <fieldset className="studio-products"><legend>Publish in these apps</legend>{ready.products.map(product=><label className="studio-check" key={product.slug}><input type="checkbox" checked={draft.products.includes(product.slug)} onChange={event=>setDraft({...draft,products:event.target.checked?[...draft.products,product.slug]:draft.products.filter(slug=>slug!==product.slug)})}/>{product.name}</label>)}</fieldset>
      {draft.kind==='article'?<label>Article (Markdown)<textarea className="studio-markdown" value={draft.markdown} maxLength={120000} onChange={event=>setDraft({...draft,markdown:event.target.value})}/></label>:<>
       {project?<label>Add a private image or recorded narration<input type="file" accept="image/png,image/jpeg,audio/mpeg,audio/wav,.wav" onChange={event=>void upload(event.target.files?.[0])}/></label>:<p>Save the draft before attaching images or audio.</p>}
       {project&&<label>Recorded narration<select value={draft.narrationAssetId??''} onChange={event=>{const next={...draft};if(event.target.value)next.narrationAssetId=event.target.value;else delete next.narrationAssetId;setDraft(assetsFor(next));}}><option value="">No audio narration</option>{project.assets.filter(asset=>asset.mediaType.startsWith('audio/')).map((asset,index)=><option key={asset.id} value={asset.id}>Recording {index+1}</option>)}</select></label>}
       {project&&draft.narrationAssetId&&<audio controls preload="metadata" aria-label="Review recorded narration" src={`/api/docstudio/projects/${project.id}/assets/${draft.narrationAssetId}`}/>}
       {draft.scenes.map((scene,index)=><section className="studio-scene" key={index}><h3>Scene {index+1}</h3><label>Scene title<input value={scene.title} maxLength={180} onChange={event=>editScene(index,{title:event.target.value})}/></label><div className="studio-row"><label>Scene type<select value={scene.type} onChange={event=>editScene(index,{type:event.target.value as typeof scene.type})}><option value="intro">Introduction</option><option value="step">Instruction</option><option value="outro">Closing</option></select></label><label>Duration (seconds)<input type="number" min={3} max={120} value={scene.durationSeconds} onChange={event=>editScene(index,{durationSeconds:Number(event.target.value)})}/></label></div>
        <label>Narration / transcript<textarea value={scene.narration} maxLength={4000} onChange={event=>editScene(index,{narration:event.target.value})}/></label><label>On-screen captions<textarea value={scene.captionText} maxLength={2000} onChange={event=>editScene(index,{captionText:event.target.value})}/></label>
        {project&&<label>Scene image<select value={scene.screenshotAssetId??''} onChange={event=>{const scenes=draft.scenes.map((value,i)=>{if(i!==index)return value;const next={...value};if(event.target.value)next.screenshotAssetId=event.target.value;else delete next.screenshotAssetId;return next;});setDraft(assetsFor({...draft,scenes}));}}><option value="">Text scene</option>{project.assets.filter(asset=>asset.mediaType.startsWith('image/')).map((asset,i)=><option key={asset.id} value={asset.id}>Image {i+1}</option>)}</select></label>}
        {scene.screenshotAssetId&&project&&<img className="studio-source-image" alt={`Scene ${index+1} source`} src={`/api/docstudio/projects/${project.id}/assets/${scene.screenshotAssetId}`}/>}
        <button className="button button-secondary" disabled={draft.scenes.length===1} onClick={()=>setDraft(assetsFor({...draft,scenes:draft.scenes.filter((_,i)=>i!==index).map((value,i)=>({...value,order:i+1}))}))}>Remove scene</button>
       </section>)}
       <button className="button button-secondary" disabled={draft.scenes.length>=120} onClick={()=>setDraft({...draft,scenes:[...draft.scenes,{order:draft.scenes.length+1,title:'',type:'step',durationSeconds:10,narration:'',captionText:''}]})}>Add scene</button>
      </>}
     </fieldset>
     <div className="studio-actions"><button className="button button-primary" disabled={locked||!dirty} onClick={()=>void preview(project?'edit':'create')}>Review draft changes</button>
      {project&&<><button className="button button-secondary" disabled={!!busy||!!intent} onClick={()=>void run('Reloading draft…',()=>reload(project.id))}>Reload saved draft</button>
       {project.status==='draft'&&<button className="button button-secondary" disabled={locked||dirty} onClick={()=>void preview('submit')}>Submit for review</button>}
       {project.status==='in_review'&&<button className="button button-primary" disabled={locked||dirty} onClick={()=>void preview('approve')}>Review and approve content</button>}
       {project.status==='approved'&&<>
        {project.kind==='video'&&!project.jobs.some(job=>job.revision===project.revision&&['queued','running','completed'].includes(job.status))&&<button className="button button-primary" disabled={locked||dirty||!ready.workerReady} onClick={()=>void preview('render')}>Review render request</button>}
        {(project.kind==='article'||project.jobs.some(job=>job.revision===project.revision&&job.status==='completed'))&&<button className="button button-primary" disabled={locked||dirty||!!stage} onClick={()=>void exportDraft()}>Prepare shared publication</button>}
       </>}
      </>}
     </div>
    </section>
    {intent&&<section className="panel studio-review"><h2>Confirm {intent.operation==='approve'?'content approval':intent.operation==='render'?'video rendering':intent.operation==='cancel'?'render cancellation':intent.operation==='submit'?'review submission':'saved draft changes'}</h2><p>{intent.title} · {intent.expectedRevision?`saved revision ${intent.expectedRevision}`:'new draft'}</p><p>Apps: {intent.products.join(', ')}</p>
     <label className="studio-check"><input type="checkbox" checked={reviewed} disabled={!!busy||attempted} onChange={event=>setReviewed(event.target.checked)}/>I reviewed the exact content shown above and approve this action.</label>
     {intent.operation==='approve'&&<label className="studio-check"><input type="checkbox" checked={phi} disabled={!!busy||attempted} onChange={event=>setPhi(event.target.checked)}/>I reviewed all text, images, and recordings. This content contains no patient information, private customer data, or credentials and is approved for the selected audience.</label>}
     <div className="studio-actions"><button className="button button-primary" disabled={!!busy||!reviewed||(intent.operation==='approve'&&!phi)} onClick={()=>void apply()}>{attempted?'Retry the same reviewed action':'Confirm reviewed action'}</button><button className="button button-secondary" disabled={!!busy||attempted} onClick={()=>setIntent(null)}>Back to draft</button></div>
    </section>}
    {project?.jobs.length?<section className="panel"><h2>Video renders</h2>{project.jobs.map(job=><div key={job.id} className="studio-job"><strong>Revision {job.revision} · {job.status}</strong><progress value={job.progress} max={100} aria-label={`Revision ${job.revision} render progress`}/><span>{job.progress}%</span>
     {['queued','running'].includes(job.status)&&<button className="button button-secondary" disabled={locked||dirty} onClick={()=>void preview('cancel')}>Review cancellation</button>}
     {job.status==='completed'&&job.revision===project.revision&&project.status==='approved'&&<><video controls preload="metadata" src={`/api/docstudio/jobs/${job.id}/primary`} aria-label="Rendered tutorial preview"><track kind="captions" srcLang="en" label="English captions" src={`/api/docstudio/jobs/${job.id}/captions`} default/></video><a href={`/api/docstudio/jobs/${job.id}/transcript`} target="_blank" rel="noreferrer">Read transcript</a></>}
    </div>)}</section>:null}
    {stage&&<PublicationReview key={stage.id} stage={stage}/>}
   </>}
   </main>
  </div>}
 </div>;
}
