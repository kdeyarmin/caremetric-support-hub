import { useEffect, useState, type FormEvent } from 'react';
import { appSession } from '../lib/appSession';

type Settings = Awaited<ReturnType<typeof appSession.passwordSettings>>;
export function PasswordSettings() {
  const [settings,setSettings] = useState<Settings|null>(null);
  const [username,setUsername] = useState('');
  const [password,setPassword] = useState('');
  const [confirm,setConfirm] = useState('');
  const [currentPassword,setCurrentPassword] = useState('');
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState('');
  const [notice,setNotice] = useState('');
  const [reload,setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    appSession.passwordSettings(controller.signal).then(value => {
      if (!controller.signal.aborted) { setSettings(value); setUsername(value.username); setError(''); }
    }).catch(() => { if (!controller.signal.aborted) setError('Password settings could not be loaded. Please try again.'); });
    return () => controller.abort();
  },[reload]);
  async function submit(event:FormEvent) {
    event.preventDefault();
    if (busy || !settings) return;
    setError(''); setNotice('');
    if (password !== confirm) { setError('The new passwords do not match.'); return; }
    setBusy(true);
    try {
      await appSession.savePassword({ username,password,...(settings.configured && !settings.can_reset ? {currentPassword} : {}) });
      setSettings({ username:username.trim().toLowerCase(),configured:true,can_reset:false });
      setUsername(username.trim().toLowerCase());
      setNotice('Your username and password are saved. Other sessions have been signed out. Use your password the next time you sign in.');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Your password could not be saved.');
      if (settings.can_reset) {
        // Recovery may expire while the form is open. Keep the entered username
        // and rejection visible, but expose current-password entry when needed.
        try { setSettings(await appSession.passwordSettings()); }
        catch { setSettings({ ...settings,can_reset:false }); }
      }
    }
    finally { setPassword(''); setConfirm(''); setCurrentPassword(''); setBusy(false); }
  }
  async function signOut() {
    if (busy) return;
    setBusy(true); setError('');
    try { await appSession.signOut(); }
    catch { setError('Sign-out could not be completed. Please try again.'); }
    finally { setBusy(false); }
  }
  return <section className="panel security-factor-panel"><h2>Username and password</h2>
    {!settings ? <><p>{error || 'Loading password settings…'}</p>{error && <button className="button button-secondary" onClick={() => setReload(value => value+1)}>Try again</button>}</> : <>
      <p>{settings.configured ? 'Change your username or password below.' : 'Choose your username and password. You can then sign in without requesting an SMS code.'} Saving signs out your other sessions.</p>
      <form className="sign-in-form" onSubmit={submit}>
        <label htmlFor="password-username">Username</label><input id="password-username" name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} value={username} onChange={event => setUsername(event.target.value)} minLength={3} maxLength={64} pattern="[a-zA-Z0-9][a-zA-Z0-9._\-]{2,63}" disabled={busy} required aria-describedby="username-help" />
        <p id="username-help" className="muted">3–64 letters, numbers, dots, underscores or hyphens. Usernames are not case sensitive.</p>
        {settings.configured && !settings.can_reset && <><label htmlFor="password-current">Current password</label><input id="password-current" name="currentPassword" type="password" autoComplete="current-password" value={currentPassword} onChange={event => setCurrentPassword(event.target.value)} maxLength={128} disabled={busy} required /><p className="muted">Forgot your password? Sign out and choose “Set up or reset your password” to verify your mobile number.</p></>}
        <label htmlFor="password-new">New password</label><input id="password-new" name="newPassword" type="password" autoComplete="new-password" value={password} onChange={event => setPassword(event.target.value)} minLength={15} maxLength={128} disabled={busy} required aria-describedby="password-help" />
        <p id="password-help" className="muted">Use 15–128 characters. A unique passphrase or a password manager works well.</p>
        <label htmlFor="password-confirm">Confirm new password</label><input id="password-confirm" name="confirmPassword" type="password" autoComplete="new-password" value={confirm} onChange={event => setConfirm(event.target.value)} minLength={15} maxLength={128} disabled={busy} required />
        <button className="button button-primary" disabled={busy}>{busy ? 'Saving…' : settings.configured ? 'Save username and password' : 'Set username and password'}</button>
        {error && <p className="form-message" role="alert">{error}</p>}
        {notice && <p className="form-message" role="status">{notice}</p>}
      </form>
    </>}
    <button className="button button-secondary" disabled={busy} onClick={() => void signOut()}>Sign out</button>
  </section>;
}
