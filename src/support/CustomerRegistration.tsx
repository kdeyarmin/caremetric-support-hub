import { useCallback,useEffect,useRef,useState } from 'react';
import { appRequest } from '../lib/appSession';
import { registrationProducts,registrationAdminRequest,registrationPreview,registrationInvitation,registrationList,normalizeRegistrationPhone,type RegistrationPreview,type RegistrationInvitation } from './registrationProtocol';
import { CustomerOnboarding } from './CustomerOnboarding';

const labels={carebase:'CareBase',breathe:'CareMetric Breathe','caremetric-emr':'CareMetric EMR','caremetric-go':'CareMetric Go',pennsync:'PennSync',intel:'CareMetric Intel'};
const send=(body:unknown,signal:AbortSignal)=>appRequest('admin/registration',body,signal);
const randomCode=()=>btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
const errorText=(error:unknown)=>error instanceof Error?error.message:'The invitation could not be confirmed.';
export function CustomerRegistration({onLinked,request=send}:{onLinked:()=>void;request?:typeof send}){
  const [product,setProduct]=useState<typeof registrationProducts[number]>('breathe');
  const [user,setUser]=useState(''),[account,setAccount]=useState(''),[phone,setPhone]=useState(''),[name,setName]=useState(''),[tenant,setTenant]=useState('');
  const [preview,setPreview]=useState<RegistrationPreview|null>(null),[reviewed,setReviewed]=useState(false),[expired,setExpired]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const [issued,setIssued]=useState<{invitation:RegistrationInvitation;code:string}|null>(null);
  const [list,setList]=useState<ReturnType<typeof registrationList.parse>|null>(null),[offset,setOffset]=useState(0),[listError,setListError]=useState('');
  const [selected,setSelected]=useState<RegistrationInvitation|null>(null),[revoking,setRevoking]=useState<RegistrationInvitation|null>(null),[revokeReviewed,setRevokeReviewed]=useState(false);
  const active=useRef<AbortController|null>(null),pending=useRef<{requestId:string;code:string}|null>(null);
  useEffect(()=>()=>active.current?.abort(),[]);
  useEffect(()=>{if(!preview)return;const timer=setTimeout(()=>setExpired(true),Math.max(0,Date.parse(preview.expiresAt)-Date.now()));return()=>clearTimeout(timer);},[preview]);
  const refresh=useCallback(async(signal:AbortSignal)=>{try{const data=registrationList.parse(await request({operation:'list',offset},signal));if(!signal.aborted){setList(data);setListError('');}}catch(error){if(!signal.aborted)setListError(errorText(error));}},[offset,request]);
  useEffect(()=>{const controller=new AbortController();request({operation:'list',offset},controller.signal).then(value=>{if(!controller.signal.aborted){setList(registrationList.parse(value));setListError('');}}).catch(error=>{if(!controller.signal.aborted)setListError(errorText(error));});return()=>controller.abort();},[offset,request]);
  function clear(){setPreview(null);setReviewed(false);setExpired(false);setIssued(null);setError('');pending.current=null;}
  async function run(input:unknown){
    const parsed=registrationAdminRequest.safeParse(input);if(!parsed.success){setError('Enter exact app identifiers, the reviewed mobile number, and account names.');return;}
    active.current?.abort();const controller=new AbortController();active.current=controller;setBusy(true);setError('');
    try{const data=await request(parsed.data,controller.signal);if(controller.signal.aborted)return;
      if(parsed.data.operation==='preview'){setPreview(registrationPreview.parse(data));setExpired(false);setReviewed(false);pending.current={requestId:crypto.randomUUID(),code:randomCode()};setIssued(null);}
      if(parsed.data.operation==='issue'){setIssued({invitation:registrationInvitation.parse(data),code:parsed.data.claimCode});setPreview(null);setReviewed(false);pending.current=null;await refresh(controller.signal);}
      if(parsed.data.operation==='revoke'){registrationInvitation.parse(data);setRevoking(null);setRevokeReviewed(false);await refresh(controller.signal);}
    }catch(error){if(!controller.signal.aborted)setError(errorText(error));}finally{if(!controller.signal.aborted)setBusy(false);}
  }
  return <section className="support-onboarding" aria-label="Invite a new Hub customer">
    <h3>Invite a new Hub customer</h3><p>Review an existing app account and the person’s mobile number. They verify their phone first; you then review and connect app access.</p>
    <form onSubmit={event=>{event.preventDefault();void run({operation:'preview',product,sourceUserId:user.trim(),sourceAccountId:product==='intel'?user.trim():account.trim(),phone:normalizeRegistrationPhone(phone),displayName:name,tenantName:tenant});}}>
      <fieldset disabled={busy}><label>Invitation application<select value={product} onChange={e=>{clear();setProduct(e.target.value as typeof product);setUser('');setAccount('');}}>{registrationProducts.map(value=><option key={value} value={value}>{labels[value]}</option>)}</select></label>
        <label>Invited app user ID<input value={user} maxLength={128} required onChange={e=>{clear();setUser(e.target.value);}}/></label>
        {product!=='intel'&&<label>Invited app {product==='pennsync'?'agency':'organization'} ID<input value={account} maxLength={128} required onChange={e=>{clear();setAccount(e.target.value);}}/></label>}
        <label>Customer mobile number<input type="tel" autoComplete="off" value={phone} maxLength={32} required onChange={e=>{clear();setPhone(e.target.value);}}/></label>
        <label>Customer display name<input value={name} maxLength={120} required onChange={e=>{clear();setName(e.target.value);}}/></label>
        <label>Invited customer account name<input value={tenant} maxLength={180} required onChange={e=>{clear();setTenant(e.target.value);}}/></label>
        <button className="button button-secondary" type="submit">Review new customer invitation</button>
      </fieldset>
    </form>
    {preview&&<div className="support-onboarding-review"><h4>Review invitation details</h4><dl><dt>Application</dt><dd>{labels[preview.identity.product]}</dd><dt>Native user</dt><dd>{preview.identity.sourceUserId}</dd><dt>Native account</dt><dd>{preview.identity.sourceAccountId}</dd><dt>Customer</dt><dd>{preview.displayName} · {preview.tenantName}</dd><dt>Mobile number</dt><dd>{preview.phone}</dd></dl>
      <p>The invitation lasts 15 minutes and needs your current administrator session. It creates no app access and sends no message automatically.</p>
      <label className="checkbox-label"><input type="checkbox" checked={reviewed} disabled={busy||expired} onChange={e=>setReviewed(e.target.checked)}/>I verified this person’s app account and mobile number and authorize this invitation.</label>
      {expired&&<p role="status">This review expired. Review the invitation again.</p>}
      <button className="button button-primary" disabled={busy||!reviewed||expired} onClick={()=>void run({operation:'issue',reviewId:preview.reviewId,proofDigest:preview.proofDigest,requestId:pending.current?.requestId,claimCode:pending.current?.code,reviewed:true})}>Create invitation code</button>
    </div>}
    {issued&&<div className="support-onboarding-review"><h4>Invitation ready for {issued.invitation.displayName}</h4><p>Give this code to the person you reviewed. They enter it at <a href="/join">Support Hub account setup</a> with the mobile number ending {issued.invitation.phoneEnding}. Expires {new Date(issued.invitation.expiresAt).toLocaleTimeString()}.</p><label>New invitation code<input readOnly autoComplete="off" spellCheck={false} value={issued.code}/></label><p>The code is shown only in this view. If lost, revoke the invitation and create another.</p></div>}
    {error&&<p role="alert">{error}</p>}
    <div className="panel-heading"><h4>Customer invitations</h4><button className="button button-secondary button-small" disabled={busy} onClick={()=>void refresh(new AbortController().signal)}>Refresh invitations</button></div>
    {listError&&<p role="alert">{listError}</p>}{!list&&!listError&&<p role="status">Loading invitations…</p>}
    {list&&<>{!list.rows.length?<p>No customer invitations yet.</p>:<div className="support-readiness-table"><table><thead><tr><th>Customer</th><th>App</th><th>Phone</th><th>Status</th><th>Next step</th></tr></thead><tbody>{list.rows.map(invitation=><tr key={invitation.invitationId}><th scope="row">{invitation.displayName}<small>{invitation.tenantName}</small></th><td>{labels[invitation.identity.product]}</td><td>Ending {invitation.phoneEnding}</td><td>{invitation.state==='claimed'?'Phone verified':invitation.state}</td><td>{invitation.state==='claimed'?<button className="button button-secondary button-small" onClick={()=>setSelected(invitation)}>Review app access</button>:invitation.state==='pending'?<button className="button button-secondary button-small" disabled={busy} onClick={()=>{setRevoking(invitation);setRevokeReviewed(false);}}>Revoke invitation</button>:null}</td></tr>)}</tbody></table></div>}
      <div className="support-intake-pagination"><button className="button button-secondary button-small" disabled={busy||offset===0} onClick={()=>setOffset(Math.max(0,offset-20))}>Previous invitations</button><span>{list.total} invitations</span><button className="button button-secondary button-small" disabled={busy||offset+list.rows.length>=list.total} onClick={()=>setOffset(offset+20)}>Next invitations</button></div></>}
    {revoking&&<div className="support-onboarding-review"><h4>Revoke {revoking.displayName}’s invitation</h4><label className="checkbox-label"><input type="checkbox" checked={revokeReviewed} disabled={busy} onChange={e=>setRevokeReviewed(e.target.checked)}/>Cancel this unclaimed invitation.</label><button className="button button-primary" disabled={busy||!revokeReviewed} onClick={()=>void run({operation:'revoke',invitationId:revoking.invitationId,reviewed:true})}>Confirm invitation revocation</button><button className="button button-secondary" onClick={()=>setRevoking(null)} disabled={busy}>Cancel</button></div>}
    {selected?.hubUserId&&<CustomerOnboarding key={selected.invitationId} initial={{product:selected.identity.product,sourceUserId:selected.identity.sourceUserId,sourceAccountId:selected.identity.sourceAccountId,hubUserId:selected.hubUserId,tenantName:selected.tenantName}} onLinked={()=>{setSelected(null);onLinked();void refresh(new AbortController().signal);}}/>}
  </section>;
}
