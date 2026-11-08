import { useState, type FormEvent } from 'react';
import { CircleHelp, LoaderCircle, LockKeyhole, Mail, Phone, ShieldCheck } from 'lucide-react';
import { appSession } from '../lib/appSession';
import { config } from '../lib/config';
import { SmsSignIn } from './SmsSignIn';

export function PasswordSignIn({ rememberPath }: { rememberPath:(path?:string) => void }) {
  const [username,setUsername] = useState('');
  const [password,setPassword] = useState('');
  const [busy,setBusy] = useState(false);
  const [message,setMessage] = useState('');
  const [recovery,setRecovery] = useState(false);
  async function submit(event:FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setMessage('');
    try { rememberPath(); await appSession.signInWithPassword(username,password); }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Sign-in could not be completed.'); }
    finally { setPassword(''); setBusy(false); }
  }
  if (recovery) return <SmsSignIn rememberPath={() => rememberPath('/security')} onBack={() => setRecovery(false)} />;
  return <main className="sign-in-page"><section className="sign-in-panel">
    <div className="brand-lockup brand-lockup-large"><span className="brand-icon"><CircleHelp size={25} /></span><span><strong>CareMetric</strong><small>Support Hub</small></span></div>
    <div className="sign-in-copy"><span className="eyebrow">Private owner access</span><h1>Sign in to CareMetric.</h1><p>Enter your email or username and password to open your Support Hub.</p></div>
    <form onSubmit={submit} className="sign-in-form">
      <label htmlFor="sign-in-username">Email or username</label><input id="sign-in-username" name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} value={username} onChange={event => setUsername(event.target.value)} maxLength={254} disabled={busy} required autoFocus />
      <label htmlFor="sign-in-password">Password</label><input id="sign-in-password" name="password" type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} maxLength={128} disabled={busy} required />
      <button className="button button-primary" disabled={busy}>{busy ? <LoaderCircle className="spin" size={17} /> : <LockKeyhole size={17} />}{busy ? 'Signing in…' : 'Sign in'}</button>
      <button type="button" className="button button-secondary" disabled={busy} onClick={() => { setPassword(''); setMessage(''); setRecovery(true); }}>Set up or reset your password</button>
      {message && <p className="form-message" role="alert">{message}</p>}
    </form>
    <div className="sign-in-support" aria-label="Central support contacts"><a href={`tel:${config.centralSupportPhone}`}><Phone size={17} /><span><small>Call central support</small><strong>{config.centralSupportPhoneDisplay}</strong></span></a><a href={`mailto:${config.centralSupportEmail}`}><Mail size={17} /><span><small>Email central support</small><strong>{config.centralSupportEmail}</strong></span></a></div>
    <div className="privacy-note"><ShieldCheck size={16} /> Keep your password private. You can save it in your password manager.</div>
  </section><aside className="sign-in-aside" aria-label="CareMetric learning"><div className="aside-orbit orbit-one" /><div className="aside-orbit orbit-two" /><div className="capability-card card-one"><ShieldCheck /><span>Secure access in your app</span></div></aside></main>;
}
