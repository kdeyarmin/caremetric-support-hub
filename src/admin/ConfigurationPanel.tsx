import {useEffect,useRef,useState} from 'react';
import {configurationClient,type ConfigurationClient} from './configurationClient';
import {parseConfigurationOperation,sameConfigurationTarget,verifyConfigurationPreview,verifyConfigurationResult,type ConfigurationTarget,type ConfigurationContext,
  type ConfigurationParameters,type ConfigurationPreview,type ConfigurationStatus,type ConfigurationCommands,type ConfigurationState} from './configurationProtocol';
import {timeLabel} from './readState';
const domain='operations.config.v1' as const;
const labels:Record<string,string>={enabled:'Job stop switch',reason:'Reason',configured:'Configured',rolloutMode:'Rollout',isEnabled:'Release enabled',
  owner:'Owner',expiresAt:'Expires',changeReason:'Change reason',isDisabled:'Feature stopped'};
const text=(value:unknown)=>value===null?'Not recorded':typeof value==='boolean'?value?'Yes':'No':String(value);
function StateTable({before,after}:{before:ConfigurationState;after?:ConfigurationState}){
  return <table><thead><tr><th>Setting</th><th>{after?'Before':'Current'}</th>{after&&<th>After</th>}</tr></thead><tbody>{Object.entries(before).map(([key,value])=>
    <tr key={key}><th>{labels[key]??key}</th><td>{text(value)}</td>{after&&<td>{text((after as unknown as Record<string,unknown>)[key])}</td>}</tr>)}</tbody></table>;
}
export function ConfigurationPanel({target,label,client=configurationClient,onApplied,onClose}:{target:ConfigurationTarget;label:string;client?:ConfigurationClient;onApplied:()=>void;onClose:()=>void}){
  const [context,setContext]=useState<ConfigurationContext|null>(null),[preview,setPreview]=useState<ConfigurationPreview|null>(null);
  const [busy,setBusy]=useState(false),[uncertain,setUncertain]=useState(false),[completed,setCompleted]=useState(false),[canApply,setCanApply]=useState(false);
  const [error,setError]=useState(''),[message,setMessage]=useState(''),[confirmed,setConfirmed]=useState(false);
  const [reason,setReason]=useState(''),[enabled,setEnabled]=useState(false),[owner,setOwner]=useState(''),[expires,setExpires]=useState('');
  const [commands,setCommands]=useState<ConfigurationCommands|null>(null);
  const [clock,setClock]=useState(Date.now);
  useEffect(()=>{if(!preview)return;const timer=setInterval(()=>setClock(Date.now()),1000);return()=>clearInterval(timer);},[preview]);
  const expired=preview!==null&&clock>=Date.parse(preview.expiresAt);
  const requestIds=useRef(new Map<string,string>()); const [selected,setSelected]=useState<{commandId:string;expectedDigest:string}|null>(null);
  const locked=busy||uncertain||completed;
  const request=async(operation:Parameters<ConfigurationClient['request']>[0])=>client.request(operation,AbortSignal.timeout(15000));
  const load=async()=>{
    if(locked)return;setBusy(true);setError('');setMessage('');setPreview(null);setConfirmed(false);setCanApply(false);setSelected(null);
    try{const result=await request({domain,operation:'context',target}) as ConfigurationContext;setContext(result);
      setEnabled('enabled' in result.state?result.state.enabled:'isEnabled' in result.state?result.state.isEnabled??false:result.state.isDisabled);
      setOwner('owner' in result.state?result.state.owner??'':'');setExpires('expiresAt' in result.state?result.state.expiresAt??'':'');
      setCommands(await request({domain,operation:'commands',target,offset:0}) as ConfigurationCommands);
    }catch{setContext(null);setError('Current configuration could not be loaded. Retry after checking your connection and SMS session.');}finally{setBusy(false);}
  };
  const parameters=():ConfigurationParameters=>target.kind==='job'?{enabled}:target.kind==='release'
    ?{rolloutMode:enabled?'global':'off',isEnabled:enabled,owner:owner.trim(),expiresAt:expires.trim()||null}:{isDisabled:enabled,expiresAt:enabled?expires.trim()||null:null};
  const review=async()=>{
    if(!context||locked)return;setBusy(true);setError('');setMessage('');setPreview(null);setConfirmed(false);setCanApply(false);
    try{
      const params=parameters(),why=reason.trim();
      const intent=JSON.stringify({target,configurationRevision:context.configurationRevision,parameters:params,reason:why});
      let requestId=requestIds.current.get(intent);if(!requestId){requestId=crypto.randomUUID();requestIds.current.set(intent,requestId);}
      const op=parseConfigurationOperation({domain,operation:'preview',requestId,target,configurationRevision:context.configurationRevision,parameters:params,reason:why});
      const result=verifyConfigurationPreview(await request(op),context,params,why);setClock(Date.now());setPreview(result);setCanApply(true);
      setSelected({commandId:result.commandId,expectedDigest:result.previewDigest});
    }catch{setError('Review could not be prepared. Check the fields and current configuration. Retrying the same review keeps its request identity.');}finally{setBusy(false);}
  };
  const recover=async(command:{commandId:string;expectedDigest:string})=>{
    if(busy||(uncertain&&selected?.commandId!==command.commandId))return;setSelected(command);setBusy(true);setError('');setConfirmed(false);
    try{const status=await request({domain,operation:'status',...command}) as ConfigurationStatus;
      if(!sameConfigurationTarget(status.preview.target,target))throw Error('Saved configuration target changed.');
      setClock(Date.now());setPreview(status.preview);setCanApply(status.canApplyThisSession);setUncertain(false);
      if(status.result){verifyConfigurationResult(status.result,status.preview);setCompleted(true);setMessage('The saved change is complete. Reload the records to see current state.');onApplied();}
      else setMessage(status.canApplyThisSession?'This change has not been applied. Review it and confirm again before applying.':'This saved review belongs to an earlier session. It is read-only; load current settings for a new review.');
    }catch{setUncertain(true);setCanApply(false);setError('The saved result is still unavailable. Keep checking this command before starting another change.');}finally{setBusy(false);}
  };
  const apply=async()=>{
    if(!preview||!confirmed||!canApply||expired||Date.now()>=Date.parse(preview.expiresAt)||locked)return;setBusy(true);setError('');setCanApply(false);setConfirmed(false);
    try{verifyConfigurationResult(await request({domain,operation:'apply',commandId:preview.commandId,expectedDigest:preview.previewDigest}),preview);
      setCompleted(true);setMessage('The reviewed change is complete. Reload the records to see current state.');onApplied();
    }catch{setUncertain(true);setError('The response did not confirm the outcome. Check this saved command before making another change.');}finally{setBusy(false);}
  };
  const changed=()=>{setPreview(null);setConfirmed(false);setCanApply(false);setSelected(null);};
  return <section className="panel access-command" aria-label={`Configure ${label}`}><h2>Configure {label}</h2>
    <p>Review the current native settings and the exact change before applying it.</p>
    {target.kind==='featureKill'&&<p>Clearing a stop preserves its historical records and recorded expiry. Existing release rules still determine availability.</p>}
    {error&&<p role="alert">{error}</p>}{message&&<p role="status">{message}</p>}
    <div className="button-row"><button type="button" className="button button-secondary" disabled={locked} onClick={()=>void load()}>Load current settings</button>
      <button type="button" className="button button-secondary" disabled={busy||uncertain} onClick={onClose}>Close settings</button></div>
    {context&&<><h3>Current settings</h3><StateTable before={context.state}/>
      <div className="admin-explanation">{context.impact.kind==='job'?<p>Execution: {context.impact.executionKind.replaceAll('_',' ')}. Stop support: {context.impact.killSwitchCanStop?'Yes':'No'}. Job definition: {context.impact.isActive?'Active':'Inactive'}.</p>
        :<p>Scope: {context.impact.organizationName??'Global'}. Retained cohorts: {context.impact.retainedCohortCount}; memberships: {context.impact.retainedMembershipCount}. Organization stops: {context.impact.organizationKillSwitchCount}. Next scheduled boundary: {timeLabel(context.impact.nextBoundaryAt)}.</p>}</div>
      <fieldset disabled={locked}><legend>Proposed change</legend>
        <label><input type="checkbox" checked={enabled} onChange={event=>{setEnabled(event.target.checked);changed();}}/>{target.kind==='job'?'Set job stop switch':target.kind==='release'?'Enable release globally':'Stop this feature'}</label>
        {target.kind==='release'&&<label>Release owner<input value={owner} maxLength={200} onChange={event=>{setOwner(event.target.value);changed();}}/></label>}
        {(target.kind==='release'||(target.kind==='featureKill'&&enabled))&&<label>Expiry with time zone (optional)<input value={expires} placeholder="2026-10-01T17:00:00Z" onChange={event=>{setExpires(event.target.value);changed();}}/></label>}
        <label>Reason for change<textarea value={reason} minLength={10} maxLength={500} onChange={event=>{setReason(event.target.value);changed();}}/></label>
        <button type="button" className="button button-secondary" onClick={()=>void review()}>Review configuration change</button>
      </fieldset></>}
    {preview&&<><h3>Reviewed change</h3><p>{preview.reason}</p><StateTable before={preview.before} after={preview.after}/><p>Review expires: {timeLabel(preview.expiresAt)}</p>
      {expired&&!completed&&<p role="status">This review expired. Check its saved result, then load current settings for a new review.</p>}
      <label><input type="checkbox" checked={confirmed} disabled={locked||!canApply||expired} onChange={event=>setConfirmed(event.target.checked)}/>I reviewed this exact configuration change.</label>
      <button type="button" className="button button-primary" disabled={locked||!confirmed||!canApply||expired} onClick={()=>void apply()}>Apply reviewed configuration</button>
      <button type="button" className="button button-secondary" disabled={busy} onClick={()=>void recover({commandId:preview.commandId,expectedDigest:preview.previewDigest})}>Check saved result</button></>}
    {commands&&<div><h3>Saved changes</h3>{commands.items.length===0?<p>No saved changes for this setting.</p>:commands.items.map(command=><button type="button" className="button button-secondary" key={command.commandId}
      disabled={busy||completed||(uncertain&&selected?.commandId!==command.commandId)} onClick={()=>void recover(command)}>Check change {command.commandId} · {command.appliedAt?'Applied':'Pending'}</button>)}
      {commands.nextOffset!==null&&<button type="button" className="button button-secondary" disabled={locked} onClick={()=>{setBusy(true);void request({domain,operation:'commands',target,offset:commands.nextOffset!})
        .then(value=>setCommands(value as ConfigurationCommands)).catch(()=>setError('Saved changes could not be loaded.')).finally(()=>setBusy(false));}}>Older changes</button>}</div>}
  </section>;
}
