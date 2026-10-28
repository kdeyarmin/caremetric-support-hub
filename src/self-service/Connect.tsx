import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { appRequest, appSession } from '../lib/appSession';
import { selfServiceClient } from './client';

const storageKey = 'caremetric.pendingConnection';
function takeConnection() {
  const fragment = window.location.hash.slice(1);
  window.history.replaceState(null, '', window.location.pathname);
  if (/^cmc_[A-Za-z0-9_-]{43}$/.test(fragment)) { window.sessionStorage.setItem(storageKey, fragment); return fragment; }
  return window.sessionStorage.getItem(storageKey) ?? '';
}
export function Connect({ authenticated }: { authenticated: boolean }) {
  const [token] = useState(takeConnection);
  const [phone, setPhone] = useState('');
  const [consent, setConsent] = useState(false);
  const [challenge, setChallenge] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  async function complete(work: () => Promise<unknown>) {
    setBusy(true); setError('');
    try { await work(); window.sessionStorage.removeItem(storageKey); window.dispatchEvent(new Event('caremetric:session')); navigate('/self-service', { replace: true }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'The account could not be connected.'); }
    finally { setBusy(false); }
  }
  return <main className="sign-in-page"><section className="sign-in-panel"><div className="brand-lockup"><strong>CareMetric Support Hub</strong></div><h1>Connect your application account</h1><p>Keep your training, facility self-service, and support together. This links the account you just opened in your application.</p>
    {!token ? <p role="alert">Open customer self-service from your CareMetric application to get a new connection link.</p> : authenticated ? <button className="button button-primary" disabled={busy} onClick={() => void complete(() => selfServiceClient.connect(token))}>{busy ? 'Connecting…' : 'Connect to my signed-in Hub account'}</button> : <form className="sign-in-form" onSubmit={async event => {
      event.preventDefault(); if (busy) return;
      if (challenge) { await complete(() => appRequest('self-service/connect/verify', { challenge_id: challenge, code }).then(() => appSession.current())); return; }
      setBusy(true); setError('');
      try { const response = await appRequest<{ challenge_id: string }>('self-service/connect/start', { token, phone: phone.replace(/[\s()-]/g, ''), consent }); setChallenge(response.challenge_id); }
      catch (cause) { setError(cause instanceof Error ? cause.message : 'The code could not be sent.'); } finally { setBusy(false); }
    }}><label>Mobile number, including country code<input type="tel" required placeholder="+15555550123" value={phone} disabled={busy || !!challenge} onChange={event => setPhone(event.target.value)} /></label>
      <label className="learning-check"><input type="checkbox" checked={consent} disabled={busy || !!challenge} onChange={event => setConsent(event.target.checked)} />Text me a code to verify this mobile number and connect my application account.</label>
      {challenge && <label>Verification code<input required inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} value={code} onChange={event => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))} /></label>}
      <button className="button button-primary" disabled={busy || !consent || (!!challenge && code.length !== 6)}>{busy ? 'Working…' : challenge ? 'Verify and connect' : 'Text me a verification code'}</button>
    </form>}{error && <p role="alert">{error}</p>}</section></main>;
}
