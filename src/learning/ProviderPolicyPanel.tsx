import {useRef,useState} from "react";
import {requestAdmin} from "../admin/transport";
import {providerCommandsSchema,providerContextSchema,providerDateFields,providerFields,providerFormPatch,providerLabels,providerOperationSchema,providerStatusSchema,
  projectProviderResult,verifyProviderPreview,verifyProviderResult,type ProviderContext,type ProviderField,type ProviderOperation,type ProviderPreview,type ProviderResult} from "./providerPolicyProtocol";

const domain="course.provider.v1" as const;
async function run(input:ProviderOperation) {
  const operation=providerOperationSchema.parse(input);
  return projectProviderResult(await requestAdmin("learning-provider",operation,new AbortController().signal),operation);
}
export function ProviderPolicyPanel({courseId,onApplied}:{courseId:string;onApplied:()=>void}) {
  const [context,setContext]=useState<ProviderContext|null>(null);
  const [values,setValues]=useState<Partial<Record<ProviderField,string>>>({});
  const [selected,setSelected]=useState<Set<ProviderField>>(new Set());
  const [cleared,setCleared]=useState<Set<ProviderField>>(new Set());
  const [reason,setReason]=useState("");
  const [preview,setPreview]=useState<ProviderPreview|null>(null);
  const [result,setResult]=useState<ProviderResult|null>(null);
  const [canApply,setCanApply]=useState(false);
  const [reviewed,setReviewed]=useState(false);
  const [applyStarted,setApplyStarted]=useState(false);
  const [commands,setCommands]=useState<ReturnType<typeof providerCommandsSchema.parse>|null>(null);
  const [offset,setOffset]=useState(0);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const pending=useRef(false);
  const requests=useRef(new Map<string,string>());
  const locked=busy||applyStarted||result!==null;
  function clearPreview(){setPreview(null);setResult(null);setCanApply(false);setReviewed(false);}
  async function action(work:()=>Promise<void>){
    if(pending.current)return;
    pending.current=true;setBusy(true);setError("");
    try{await work();}
    catch(caught){
      const code=caught&&typeof caught==="object"&&"code" in caught?caught.code:null;
      setError(code==="401"||code==="403"?"A current administrator session in the Hub and CareBase is required.":code==="conflict"?
        "The provider details or review changed. Check the saved result, then reload the current details before preparing another change.":
        "The request was not confirmed. Check the selected fields and connection. If you applied a change, check its saved result before preparing another request.");
    }finally{pending.current=false;setBusy(false);}
  }
  async function load(){
    const [current,page]=await Promise.all([run({domain,operation:"context",courseId}),run({domain,operation:"commands",courseId,offset:0})]);
    const loaded=providerContextSchema.parse(current);
    setContext(loaded);setCommands(providerCommandsSchema.parse(page));setOffset(0);
    setValues(Object.fromEntries(providerFields.map(field=>[field,loaded.profile?.[field]??""])));
    setSelected(new Set(loaded.profile?[]:["providerFullName"]));setCleared(new Set());setReason("");clearPreview();setApplyStarted(false);
  }
  async function status(commandId:string,expectedDigest:string){
    const saved=providerStatusSchema.parse(await run({domain,operation:"status",commandId,expectedDigest}));
    setPreview(saved.preview);setReviewed(false);setCanApply(saved.canApplyThisSession);setApplyStarted(false);
    setResult(saved.result?verifyProviderResult(saved.result,saved.preview):null);
    if(saved.result)onApplied();
  }
  const legacyNameChanges=preview?.changes.some(change=>change.field==="providerFullName")&&preview.impact.legacyFallbackCertificates!=="0";
  return <section className="admin-authoring" aria-label="Course provider details">
    <h3>Provider details for this course</h3>
    <p>These details apply across course versions. Saving them updates the provider documentation and clears affected draft content approvals.</p>
    <button type="button" className="button button-secondary" disabled={busy||applyStarted} onClick={()=>void action(load)}>Load provider details and saved requests</button>
    {error&&<p role="alert">{error}</p>}
    {context&&<>
      <p><strong>{context.courseTitle}</strong> · {context.impact.versionCount} versions</p>
      {!context.profile&&<p>This course has no saved provider profile. Enter its provider name to create one.</p>}
      <p>Select each field you intend to change. Unselected fields retain their saved value.</p>
      <div className="admin-provider-fields">{providerFields.map(field=><fieldset key={field} disabled={locked}>
        <legend>{providerLabels[field]}</legend>
        <p>Saved: {context.profile?.[field]??"Not recorded"}</p>
        <label><input type="checkbox" checked={selected.has(field)} onChange={event=>{const next=new Set(selected);if(event.target.checked)next.add(field);else next.delete(field);setSelected(next);clearPreview();}}/>Change {providerLabels[field].toLowerCase()}</label>
        {selected.has(field)&&<>
          {field!=="providerFullName"&&<label><input type="checkbox" checked={cleared.has(field)} onChange={event=>{const next=new Set(cleared);if(event.target.checked)next.add(field);else next.delete(field);setCleared(next);clearPreview();}}/>Clear this field</label>}
          <label>New {providerLabels[field].toLowerCase()}{field==="reviewNotes"?<textarea disabled={cleared.has(field)} value={values[field]??""} maxLength={12000} onChange={event=>{setValues({...values,[field]:event.target.value});clearPreview();}}/>:
            <input type={providerDateFields.has(field)?"date":"text"} disabled={cleared.has(field)} value={values[field]??""} maxLength={field==="contentVersion"?300:500} onChange={event=>{setValues({...values,[field]:event.target.value});clearPreview();}}/>}</label>
        </>}
      </fieldset>)}</div>
      <p>Recorded signature time: {context.profile?.signatureRecordedAt?new Date(context.profile.signatureRecordedAt).toLocaleString():"Not recorded"}. CareBase records that time when the signature name changes.</p>
      <label>Reason for changing provider details<textarea value={reason} disabled={locked} minLength={10} maxLength={500} onChange={event=>{setReason(event.target.value);clearPreview();}}/></label>
      <button type="button" className="button button-secondary" disabled={locked||selected.size===0||reason.trim().length<10} onClick={()=>void action(async()=>{
        const patch=providerFormPatch(selected,values,cleared);
        const request={domain,operation:"preview" as const,courseId,providerContextRevision:context.providerContextRevision,patch,reason:reason.trim()};
        const key=JSON.stringify(request);let requestId=requests.current.get(key);if(!requestId){requestId=crypto.randomUUID();requests.current.set(key,requestId);}
        const next=verifyProviderPreview(await run({...request,requestId}),context,patch,request.reason);
        setPreview(next);setResult(null);setReviewed(false);setCanApply(true);
      })}>Preview provider changes</button>
    </>}
    {preview&&<div className="learning-notice">
      <h4>Review the provider change</h4>
      <table><thead><tr><th>Field</th><th>Saved value</th><th>New value</th></tr></thead><tbody>{preview.changes.map(change=><tr key={change.field}><th>{providerLabels[change.field]}</th><td>{change.before??"Not recorded"}</td><td>{change.after??"Clear this field"}</td></tr>)}</tbody></table>
      <p>{preview.reason}</p>
      <p>Signature time: {preview.signatureTimestampAction==="retain"?"keep the saved time":preview.signatureTimestampAction==="clear"?"clear the saved time":"record the time CareBase saves the change"}.</p>
      <p>{preview.impact.governedDrafts.filter(draft=>draft.reviewInvalidated).length} draft approvals will be cleared.</p>
      {preview.impact.governedDrafts.length>0&&<ul>{preview.impact.governedDrafts.map(draft=><li key={draft.versionId}>{draft.title}{draft.reviewInvalidated?" · approval cleared":" · no current approval to clear"}</li>)}</ul>}
      {legacyNameChanges&&<p role="note"><strong>{preview.impact.legacyFallbackCertificates} older certificates use the current provider name. Their displayed provider name will change. Their issuance records are not rewritten.</strong></p>}
      <p>Previously captured certificate provider snapshots stay intact. This action does not certify or approve a provider.</p>
      <p>Review expires {new Date(preview.expiresAt).toLocaleString()}.</p>
      {!result&&<>
        {canApply&&!applyStarted?<><label className="learning-checkbox"><input type="checkbox" checked={reviewed} disabled={busy} onChange={event=>setReviewed(event.target.checked)}/>I reviewed these exact changes and their effect on drafts and certificate display.</label>
          <button type="button" className="button button-primary" disabled={busy||!reviewed} onClick={()=>void action(async()=>{
            setApplyStarted(true);
            const saved=verifyProviderResult(await run({domain,operation:"apply",commandId:preview.commandId,expectedDigest:preview.previewDigest}),preview);
            setResult(saved);setCanApply(false);setApplyStarted(false);onApplied();
          })}>Confirm provider changes</button></>:<p>{applyStarted?"The saved result must be checked before starting another change.":"This session cannot apply that review. Check its saved result, then load the current provider details for a new review."}</p>}
        <button type="button" className="button button-secondary" disabled={busy} onClick={()=>void action(()=>status(preview.commandId,preview.previewDigest))}>Check saved provider result</button>
      </>}
      {result&&<p role="status">CareBase confirmed this provider change at {new Date(result.appliedAt).toLocaleString()}{result.replayed?" (previously completed)":""}. Reload course material to review its current policy evidence.</p>}
    </div>}
    {commands&&<details><summary>Saved provider requests</summary>
      {commands.items.length===0?<p>No saved requests on this page.</p>:<ul>{commands.items.map(command=><li key={command.commandId}>{command.appliedAt?`Applied ${new Date(command.appliedAt).toLocaleString()}`:`Review expires ${new Date(command.expiresAt).toLocaleString()}`} <button type="button" disabled={busy||applyStarted} onClick={()=>void action(()=>status(command.commandId,command.expectedDigest))}>Review saved provider request</button></li>)}</ul>}
      <button type="button" disabled={busy||applyStarted||offset===0} onClick={()=>void action(async()=>{setCommands(providerCommandsSchema.parse(await run({domain,operation:"commands",courseId,offset:0})));setOffset(0);})}>First requests</button>
      <button type="button" disabled={busy||applyStarted||commands.nextOffset===null} onClick={()=>void action(async()=>{if(commands.nextOffset===null)return;const next=commands.nextOffset;setCommands(providerCommandsSchema.parse(await run({domain,operation:"commands",courseId,offset:next})));setOffset(next);})}>More requests</button>
    </details>}
  </section>;
}
