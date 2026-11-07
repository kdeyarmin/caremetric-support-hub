import { useState } from 'react';
import { appSession } from '../lib/appSession';

export function SignOutButton() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function signOut() {
    setBusy(true); setError('');
    try { await appSession.signOut(); }
    catch { setError('Sign-out could not complete. Please try again.'); }
    finally { setBusy(false); }
  }
  return <div className="sign-out-control">
    <button type="button" className="button button-secondary" disabled={busy} onClick={() => void signOut()}>{busy ? 'Signing out…' : 'Sign out'}</button>
    {error && <p role="alert">{error}</p>}
  </div>;
}
