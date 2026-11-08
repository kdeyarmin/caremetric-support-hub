import { useEffect, useState, type FormEvent } from 'react';
import { CircleHelp, LoaderCircle, Mail, Phone, ShieldCheck } from 'lucide-react';
import { appSession } from '../lib/appSession';
import { config } from '../lib/config';

export function SmsSignIn({ rememberPath,onBack }: { rememberPath:() => void; onBack?:() => void }) {
  const [phone,setPhone] = useState('');
  const [challengeId,setChallengeId] = useState('');
  const [code,setCode] = useState('');
  const [busy,setBusy] = useState(false);
  const [message,setMessage] = useState('');
  const [remaining,setRemaining] = useState(0);
  useEffect(() => {
    if (remaining <= 0) return;
    const timeout = window.setTimeout(() => setRemaining(value => Math.max(0,value-1)),1000);
    return () => window.clearTimeout(timeout);
  },[remaining]);
  async function send() {
    setBusy(true); setMessage('');
    try {
      rememberPath();
      const result = await appSession.start(phone);
      setChallengeId(result.challengeId); setCode(''); setRemaining(result.retryAfter);
      setMessage('If this is the owner’s registered number, a sign-in code has been sent. Enter it below.');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'The code could not be sent.'); }
    finally { setBusy(false); }
  }
  async function submit(event:FormEvent) {
    event.preventDefault();
    if (!challengeId) { await send(); return; }
    setBusy(true); setMessage('');
    try { await appSession.verify(challengeId,code); }
    catch (error) { setMessage(error instanceof Error ? error.message : 'The code could not be verified.'); }
    finally { setBusy(false); }
  }
  return <main className="sign-in-page"><section className="sign-in-panel">
    <div className="brand-lockup brand-lockup-large"><span className="brand-icon"><CircleHelp size={25} /></span><span><strong>CareMetric</strong><small>Support Hub</small></span></div>
    <div className="sign-in-copy"><span className="eyebrow">Private owner access</span><h1>{onBack ? 'Set up or reset your password.' : 'Sign in with a text message.'}</h1><p>{onBack ? 'Verify your registered mobile number with a text message, then choose your email or username and password on the Security page.' : 'This Hub is private: only the CareMetric owner can sign in. Enter your registered mobile number and we’ll text you a six-digit code.'}</p></div>
    <form onSubmit={submit} className="sign-in-form">
      <label htmlFor="sign-in-phone">Mobile number</label><input id="sign-in-phone" type="tel" autoComplete="tel" value={phone} onChange={event => setPhone(event.target.value)} placeholder="(555) 555-0123" maxLength={32} disabled={busy || Boolean(challengeId)} required />
      {challengeId && <><label htmlFor="sign-in-code">SMS code</label><input id="sign-in-code" value={code} onChange={event => setCode(event.target.value.replace(/\D/g,'').slice(0,6))} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} autoFocus required /></>}
      <button className="button button-primary" disabled={busy || (Boolean(challengeId) && code.length!==6)}>{busy ? <LoaderCircle className="spin" size={17} /> : <Phone size={17} />}{challengeId ? 'Verify and sign in' : 'Text me a code'}</button>
      {challengeId && <><button type="button" className="button button-secondary" disabled={busy || remaining>0} onClick={() => void send()}>{remaining>0 ? `Resend in ${remaining}s` : 'Send a new code'}</button><button type="button" className="text-link" disabled={busy} onClick={() => { setChallengeId(''); setCode(''); setMessage(''); }}>Use a different number</button></>}
      {message && <p className="form-message" role="status">{message}</p>}
      {onBack && <button type="button" className="text-link" disabled={busy} onClick={onBack}>Back to password sign-in</button>}
    </form>
    <div className="sign-in-support" aria-label="Central support contacts"><a href={`tel:${config.centralSupportPhone}`}><Phone size={17} /><span><small>Call central support</small><strong>{config.centralSupportPhoneDisplay}</strong></span></a><a href={`mailto:${config.centralSupportEmail}`}><Mail size={17} /><span><small>Email central support</small><strong>{config.centralSupportEmail}</strong></span></a></div>
    <div className="privacy-note"><ShieldCheck size={16} /> Your code signs you in to CareMetric. Never share it with anyone.</div>
  </section><aside className="sign-in-aside" aria-label="CareMetric learning"><div className="aside-orbit orbit-one" /><div className="aside-orbit orbit-two" /><div className="capability-card card-one"><ShieldCheck /><span>Secure access in your app</span></div></aside></main>;
}
