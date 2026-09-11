import { useEffect, useRef, useState } from 'react';
import { appRequest } from '../lib/appSession';
import { onboardingPreview, onboardingRequest, onboardingResult, onboardingProducts, type OnboardingPreview } from './onboardingProtocol';

const labels = {carebase:'CareBase',breathe:'CareMetric Breathe','caremetric-emr':'CareMetric EMR','caremetric-go':'CareMetric Go',pennsync:'PennSync',intel:'CareMetric Intel'};
const send = (body:unknown,signal:AbortSignal) => appRequest('admin/onboarding',body,signal);
export interface OnboardingInitial {product:typeof onboardingProducts[number];sourceUserId:string;sourceAccountId:string;hubUserId:string;tenantName:string;}
export function CustomerOnboarding({onLinked,request=send,initial}:{onLinked:()=>void;request?:typeof send;initial?:OnboardingInitial}) {
  const [product,setProduct]=useState<typeof onboardingProducts[number]>(initial?.product??'breathe');
  const [user,setUser]=useState(initial?.sourceUserId??''),[account,setAccount]=useState(initial?.sourceAccountId??''),[hubUser,setHubUser]=useState(initial?.hubUserId??''),[name,setName]=useState(initial?.tenantName??'');
  const [preview,setPreview]=useState<OnboardingPreview|null>(null),[reviewed,setReviewed]=useState(false),[busy,setBusy]=useState(false);
  const [error,setError]=useState(''),[message,setMessage]=useState(''),[expired,setExpired]=useState(false);
  const active=useRef<AbortController|null>(null),requestId=useRef<string|null>(null);
  useEffect(()=>()=>active.current?.abort(),[]);
  useEffect(()=>{
    if(!preview)return;
    const timer=setTimeout(()=>setExpired(true),Math.max(0,Date.parse(preview.expiresAt)-Date.now()));
    return()=>clearTimeout(timer);
  },[preview]);
  function clear(){setPreview(null);setReviewed(false);setExpired(false);setError('');setMessage('');requestId.current=null;}
  async function run(body:unknown,apply=false){
    const parsed=onboardingRequest.safeParse(body);
    if(!parsed.success){setError('Enter the exact native identifiers, an existing Hub user ID, and a customer account name.');return;}
    active.current?.abort();const controller=new AbortController();active.current=controller;setBusy(true);setError('');setMessage('');
    try {
      const value=await request(parsed.data,controller.signal);if(controller.signal.aborted)return;
      if(apply){onboardingResult.parse(value);setPreview(null);setReviewed(false);requestId.current=null;
        setMessage('Customer linked. Review customer intake below before enabling support cases.');onLinked();}
      else {setPreview(onboardingPreview.parse(value));setReviewed(false);setExpired(false);requestId.current=crypto.randomUUID();}
    } catch {if(!controller.signal.aborted)setError(apply?'The link could not be confirmed. Retry the same review, or load a fresh preview if it changed or expired.':'The native account or existing Hub SMS user could not be verified. Check the IDs and application connection.');}
    finally{if(!controller.signal.aborted)setBusy(false);}
  }
  return <section className="support-onboarding" aria-label="Link a customer account">
    <h3>Link a customer account</h3><p>Choose an existing app account and the person’s verified Hub SMS account. Review the exact pairing before granting access. For CareBase, employee completion records are configured separately in the course library.</p>
    <form onSubmit={event=>{event.preventDefault();void run({operation:'preview',product,sourceUserId:user.trim(),sourceAccountId:product==='intel'?user.trim():account.trim(),hubUserId:hubUser.trim(),tenantName:name});}}>
      <fieldset disabled={busy}><label>Application<select value={product} onChange={event=>{clear();setProduct(event.target.value as typeof product);setUser('');setAccount('');}}>{onboardingProducts.map(value=><option value={value} key={value}>{labels[value]}</option>)}</select></label>
        <label>Native app user ID<input required value={user} maxLength={128} onChange={event=>{clear();setUser(event.target.value);}} /></label>
        {product!=='intel' && <label>{product==='pennsync'?'Native agency ID':'Native organization ID'}<input required value={account} maxLength={128} onChange={event=>{clear();setAccount(event.target.value);}} /></label>}
        {product==='intel' && <p>Intel uses an individual account. Its user ID identifies the account.</p>}
        <label>Existing Hub user ID<input required value={hubUser} maxLength={36} onChange={event=>{clear();setHubUser(event.target.value);}} /></label>
        <label>Customer account name<input required value={name} maxLength={180} onChange={event=>{clear();setName(event.target.value);}} /></label>
        <button type="submit" className="button button-secondary">Verify and preview account link</button>
      </fieldset>
    </form>
    {preview && <div className="support-onboarding-review"><h4>Review this exact pairing</h4>
      <dl><dt>Application</dt><dd>{labels[preview.identity.product]}</dd><dt>Native user</dt><dd>{preview.identity.sourceUserId}</dd>
        <dt>Native {preview.identity.accountKind}</dt><dd>{preview.identity.sourceAccountId}</dd><dt>Verified relationship</dt><dd>{preview.identity.relationship.replaceAll('_',' ')}</dd>
        <dt>Hub member</dt><dd>{preview.hubDisplayName} · {preview.hubUserId}</dd><dt>Hub customer account</dt><dd>{preview.tenantName} · {preview.hubTenantId}</dd></dl>
      <p>Customer access to this app only, with access to their own cases. Case intake remains off. The app will verify this relationship again when you apply.</p>
      <label className="checkbox-label"><input type="checkbox" checked={reviewed} disabled={busy||expired} onChange={event=>setReviewed(event.target.checked)} />I verified that these two accounts belong to the same person and reviewed this customer account.</label>
      {expired && <p role="status">This review expired. Verify the accounts again.</p>}
      <button className="button button-primary" disabled={busy||!reviewed||expired} onClick={()=>void run({operation:'apply',intentId:preview.intentId,proofDigest:preview.proofDigest,requestId:requestId.current,reviewed:true},true)}>Confirm customer link</button>
    </div>}
    {error && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}
  </section>;
}
