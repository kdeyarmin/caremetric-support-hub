import {useState} from 'react';
import {pennsyncMigrationResult} from '../imports/pennsyncLearningSource';
import type {z} from 'zod';
import {PennsyncCourseReviewPanel} from './PennsyncCourseReviewPanel';
type Result=z.infer<typeof pennsyncMigrationResult>;
async function migrate(input:unknown):Promise<Result>{
  const response=await fetch('/api/admin/pennsync-migration',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});
  if(!response.ok)throw new Error(response.status===409?'The source changed. Inspect PennSync again before preserving.':'PennSync migration is unavailable. Check your administrator connection and try again.');
  return pennsyncMigrationResult.parse(await response.json());
}
export function PennsyncMigrationPanel(){
  const [result,setResult]=useState<Result|null>(null),[busy,setBusy]=useState(false),[reviewed,setReviewed]=useState(false),[error,setError]=useState(''),[status,setStatus]=useState('');
  async function run(preserve=false){
    if(preserve&&(!result||!reviewed))return;
    setBusy(true);setError('');setStatus('');
    try{
      const next=await migrate(preserve?{operation:'preserve',sourceRevision:result!.sourceRevision,expectedHeadRevision:result!.headRevision,reviewed:true}:{operation:'inspect'});
      setResult(next);setReviewed(false);
      if(preserve)setStatus(next.replayed?'This source revision is already preserved.':'PennSync source preserved, including original course policy and learning history.');
    }catch(caught){setError(caught instanceof Error?caught.message:'Source migration did not complete.');setReviewed(false);}
    finally{setBusy(false);}
  }
  return <section className="panel lesson-panel"><h2>PennSync course migration</h2>
    <p>Bring PennSync course material, standalone modules, learning plans, and historical evidence into the Hub for review. Preserved source material stays private until its audience, assessment, and learner mappings are reconciled.</p>
    <button className="button button-secondary" disabled={busy} onClick={()=>void run()}>Inspect current PennSync source</button>
    {result&&<><p>{result.summary.courses} courses · {result.summary.standaloneModules} standalone modules · {result.summary.questions} questions · {result.summary.plans} learning plans · {result.summary.historyRecords} history records</p>
      <p>{result.summary.unmatchedLegacyLearners} unmatched legacy learners · {result.summary.ambiguousLegacyLearners} ambiguous learner references · {result.summary.sourceReferences} external references · {result.summary.brokenReferences} missing source references</p>
      {result.summary.unmatchedLegacyLearners>0&&<p>Unmatched learner history remains preserved without linking it to another person.</p>}
      <details><summary>Review source catalog and migration requirements</summary>{result.summary.catalog.map(row=><article key={row.kind+row.id}><h3>{row.title}</h3><p>{row.kind==='course'?'Course':'Standalone module'} · {row.status} · {row.modules} lessons · {row.questions} questions</p><ul>{row.issues.map(issue=><li key={issue}>{issue}</li>)}</ul></article>)}</details>
      <label className="learning-check"><input type="checkbox" checked={reviewed} disabled={busy} onChange={event=>setReviewed(event.target.checked)}/>I reviewed the source counts and migration requirements.</label>
      <button className="button button-primary" disabled={busy||!reviewed} onClick={()=>void run(true)}>Preserve current source</button>
      {result.snapshotId&&<PennsyncCourseReviewPanel key={result.sourceRevision} sourceRevision={result.sourceRevision}/>}
    </>}{status&&<p role="status">{status}</p>}{error&&<p role="alert" className="learning-error">{error}</p>}
  </section>;
}
