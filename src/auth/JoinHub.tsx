import { useEffect,useState,type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { CircleHelp,Phone,ShieldCheck } from 'lucide-react';
import { appSession } from '../lib/appSession';
import { registrationStart,normalizeRegistrationPhone } from '../support/registrationProtocol';
export function JoinHub({authenticated=false}:{authenticated?:boolean}) {
  const [invitation,setInvitation]=useState(''),[phone,setPhone]=useState(''),[consent,setConsent]=useState(false);
  const [challenge,setChallenge]=useState(''),[code,setCode]=useState(''),[busy,setBusy]=useState(false),[remaining,setRemaining]=useState(0);
  const [message,setMessage]=useState(''),[complete,setComplete]=useState(false);
  useEffect(()=>{if(remaining<=0)return;const timer=setTimeout(()=>setRemaining(value=>Math.max(0,value-1)),1000);return()=>clearTimeout(timer);},[remaining]);
  async function send(){
    const input=registrationStart.safeParse({claimCode:invitation.trim(),phone:normalizeRegistrationPhone(phone),consent});
    if(!input.success){setMessage('Enter your invitation code and mobile number, then confirm you want a verification text.');return;}
    setBusy(true);setMessage('');
    try{const result=await appSession.startInvitation(input.data);setChallenge(result.challengeId);setRemaining(result.retryAfter);setCode('');setMessage('If the invitation and number match, a code has been sent. Enter it below.');}
    catch(error){setMessage(error instanceof Error?error.message:'The text could not be sent.');}finally{setBusy(false);}
  }
  async function submit(event:FormEvent){event.preventDefault();if(!challenge){await send();return;}setBusy(true);setMessage('');
    try{await appSession.verifyInvitation(challenge,code);setComplete(true);setInvitation('');setCode('');}
    catch(error){setMessage(error instanceof Error?error.message:'The code could not be verified.');}finally{setBusy(false);}
  }
  return <main className="sign-in-page"><section className="sign-in-panel">
    <div className="brand-lockup brand-lockup-large"><span className="brand-icon"><CircleHelp size={25}/></span><span><strong>CareMetric</strong><small>Support Hub</small></span></div>
    {complete||authenticated?<><h1>{complete?'Your phone is verified.':'You’re signed in.'}</h1><p>{complete?'Your Hub account is ready. Your administrator can now review and connect your app account.':'Open the Hub to see your current app access.'}</p><Link className="button button-primary" to="/">Open Support Hub</Link></>:<>
      <div className="sign-in-copy"><span className="eyebrow">Your CareMetric invitation</span><h1>Join the Support Hub.</h1><p>Use the invitation from your administrator and the mobile number they reviewed with you. We’ll verify it with a text message.</p></div>
      <form className="sign-in-form" onSubmit={event=>void submit(event)}>
        <label htmlFor="join-invitation">Invitation code</label><input id="join-invitation" value={invitation} onChange={e=>setInvitation(e.target.value)} required maxLength={43} autoComplete="off" spellCheck={false} disabled={busy||!!challenge}/>
        <label htmlFor="join-phone">Mobile number</label><input id="join-phone" type="tel" value={phone} onChange={e=>setPhone(e.target.value)} required maxLength={32} autoComplete="tel" disabled={busy||!!challenge}/>
        {!challenge&&<label className="checkbox-label"><input type="checkbox" checked={consent} onChange={e=>setConsent(e.target.checked)} disabled={busy}/>Text me a code to verify this number and create my CareMetric Hub account.</label>}
        {challenge&&<><label htmlFor="join-code">SMS code</label><input id="join-code" value={code} onChange={e=>setCode(e.target.value.replace(/\D/g,'').slice(0,6))} required pattern="[0-9]{6}" inputMode="numeric" autoComplete="one-time-code" maxLength={6}/></>}
        <button className="button button-primary" disabled={busy||(!challenge&&!consent)||(!!challenge&&code.length!==6)}><Phone size={17}/>{busy?'Please wait…':challenge?'Verify and create account':'Text me a verification code'}</button>
        {challenge&&<><button type="button" className="button button-secondary" disabled={busy||remaining>0} onClick={()=>void send()}>{remaining>0?`Resend in ${remaining}s`:'Send a new code'}</button><button type="button" className="text-link" disabled={busy} onClick={()=>{setChallenge('');setCode('');setMessage('');}}>Review invitation and number</button></>}
        {message&&<p role="status">{message}</p>}
      </form><p>Your administrator will review app access after you verify your phone.</p><Link className="text-link" to="/">Already registered? Sign in</Link>
    </>}
    <div className="privacy-note"><ShieldCheck size={16}/>Enter your SMS code only here. Never share it with anyone.</div>
  </section><aside className="sign-in-aside" aria-label="CareMetric support"><div className="aside-orbit orbit-one"/><div className="capability-card card-one"><ShieldCheck/><span>Support and learning for your CareMetric apps</span></div></aside></main>;
}
