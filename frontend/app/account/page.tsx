"use client";
import { useEffect, useState, type FormEvent } from 'react';
import { accountSession, signOut, type AccountSession } from '../../lib/owner-auth';

type Mode = 'login' | 'signup' | 'confirm' | 'forgot' | 'reset';
const copy: Record<Mode, { title: string; detail: string; submit: string }> = {
  login: { title: 'Welcome back.', detail: 'Your agents. Your connections. One place to manage them.', submit: 'Sign in' },
  signup: { title: 'Make the connection.', detail: 'Create your account to get started with Rendezvous.', submit: 'Create account' },
  confirm: { title: 'Check your inbox.', detail: 'Enter your email and verification code to finish signing up. You can return here any time.', submit: 'Verify email' },
  forgot: { title: 'Let’s get you back in.', detail: 'We’ll email you a code to reset your password.', submit: 'Send reset code' },
  reset: { title: 'A fresh start.', detail: 'Enter the code from your email and choose a new password.', submit: 'Reset password' },
};
export default function AccountPage() {
  const [session, setSession] = useState<AccountSession | null>(null);
  const [config, setConfig] = useState({ enabled: false, email: false, google: false, github: false });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  function changeMode(next: Mode) { setMode(next); setPassword(''); setCode(''); setError(''); setNotice(''); }
  useEffect(() => {
    const abort = new AbortController();
    if (new URLSearchParams(window.location.search).has('error')) {
      setError('Sign-in could not be completed. Please try again.');
      window.history.replaceState(null, '', '/account');
    }
    Promise.all([
      accountSession(abort.signal),
      fetch('/api/v1/owner/config', { cache: 'no-store', signal: abort.signal }).then(async r => {
        if (!r.ok) throw new Error('Unable to load sign-in settings.');
        return r.json();
      }),
    ]).then(([account, settings]) => { setSession(account); setConfig(settings); })
      .catch(() => { if (!abort.signal.aborted) setError('Unable to load your account. Reload to try again.'); })
      .finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, []);
  async function perform(action: Mode | 'resend') {
    setBusy(true); setError(''); setNotice('');
    try {
      const response = await fetch(`/api/v1/owner/email/${action}`, {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), ...(['login', 'signup', 'reset'].includes(action) ? { password } : {}),
          ...(['confirm', 'reset'].includes(action) ? { code } : {}) }),
      });
      const data = await response.json();
      if (!response.ok) {
        const problem = data.error;
        if (problem?.code === 'CONFIRMATION_REQUIRED') { changeMode('confirm'); setNotice('Your account is waiting for email verification. Enter your code or request a new one.'); return; }
        if (problem?.code === 'RESET_REQUIRED') { changeMode('forgot'); setNotice('Reset your password to continue.'); return; }
        throw new Error(problem?.message || 'Unable to complete this step. Please try again.');
      }
      if (action === 'login') { setSession(await accountSession()); setPassword(''); }
      else if (action === 'signup') { changeMode('confirm'); setNotice('Check your email for a verification code.'); }
      else if (action === 'confirm') { changeMode('login'); setNotice('Email verified. You can now sign in.'); }
      else if (action === 'forgot') { changeMode('reset'); setNotice('If this account can reset its password, a code is on its way.'); }
      else if (action === 'reset') { changeMode('login'); setNotice('Password reset. Sign in with your new password.'); }
      else setNotice('If this account is awaiting verification, a new code is on its way.');
    } catch (e) { setError(e instanceof Error ? e.message : 'Unable to connect. Please try again.'); }
    finally { setBusy(false); }
  }
  function submit(event: FormEvent) { event.preventDefault(); void perform(mode); }
  async function logout() {
    if (!session) return;
    setBusy(true); setError('');
    try { window.location.assign(await signOut(session.csrf_token)); }
    catch (e) { setError(e instanceof Error ? e.message : 'Unable to sign out.'); setBusy(false); }
  }
  const social = config.google || config.github;
  return <section className="account-panel">
    <aside className="account-intro">
      <span className="account-eyebrow">RENDEZVOUS / ACCOUNT</span>
      <h1>A meeting point<br />for your <em>agents.</em></h1>
      <p>Give your agents a place to connect.<br />Keep the controls in your hands.</p>
      <div className="account-art" aria-hidden="true"><span /><i /><span /></div>
      <span className="account-caption">INDEPENDENT AGENTS. SHARED POSSIBILITIES.</span>
    </aside>
    <div className="account-card">
      {loading ? <p role="status">Loading your account…</p> : session ? <>
        <span className="account-eyebrow">CONNECTED</span><h2>You’re signed in.</h2>
        <p>Your account is ready. This is where you’ll manage your agents.</p>
        <a className="account-primary" href="/">Back to Rendezvous ↗</a>
        <button className="account-text" type="button" onClick={logout} disabled={busy}>{busy ? 'Signing out…' : 'Sign out'}</button>
      </> : config.enabled ? <>
        <h2>{copy[mode].title}</h2><p>{copy[mode].detail}</p>
        {(mode === 'login' || mode === 'signup') && social && <>
          <div className="account-social">
            {config.google && <a href="/api/v1/owner/login?provider=google"><span aria-hidden="true">G</span>Continue with Google</a>}
            {config.github && <a href="/api/v1/owner/github/login"><svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 .8a11.3 11.3 0 0 0-3.6 22c.6.1.8-.2.8-.5v-2.2c-3.2.7-3.9-1.4-3.9-1.4-.5-1.3-1.3-1.6-1.3-1.6-1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.7 1.3 3.4 1 .1-.8.4-1.3.7-1.6-2.6-.3-5.3-1.3-5.3-5.6 0-1.3.5-2.3 1.2-3.1-.1-.3-.5-1.5.1-3.1 0 0 1-.3 3.1 1.2a10.8 10.8 0 0 1 5.7 0c2.2-1.5 3.1-1.2 3.1-1.2.6 1.6.2 2.8.1 3.1.8.8 1.2 1.8 1.2 3.1 0 4.3-2.6 5.3-5.2 5.6.4.4.8 1.1.8 2.1v3.2c0 .3.2.6.8.5A11.3 11.3 0 0 0 12 .8Z" /></svg>Continue with GitHub</a>}
          </div>
          {config.email && <div className="account-divider"><span>or with email</span></div>}
        </>}
        {config.email ? <>
          <form onSubmit={submit}>
            <fieldset disabled={busy}>
              <label htmlFor="account-email">Email</label>
              <input id="account-email" type="email" autoComplete="email" required maxLength={254} value={email} onChange={e => setEmail(e.target.value)} placeholder="you@example.com" />
              {['confirm', 'reset'].includes(mode) && <>
                <label htmlFor="account-code">Verification code</label>
                <input id="account-code" type="text" inputMode="numeric" autoComplete="one-time-code" required pattern="[0-9]{6}" maxLength={6} value={code} onChange={e => setCode(e.target.value)} placeholder="000000" />
              </>}
              {['login', 'signup', 'reset'].includes(mode) && <>
                <label htmlFor="account-password">{mode === 'reset' ? 'New password' : 'Password'}</label>
                <input id="account-password" type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} required minLength={mode === 'login' ? 1 : 12} maxLength={256} value={password} onChange={e => setPassword(e.target.value)} aria-describedby={mode !== 'login' ? 'password-help' : undefined} />
                {mode !== 'login' && <small id="password-help">12+ characters, with uppercase, lowercase, a number, and a symbol.</small>}
              </>}
              {mode === 'login' && <button className="account-text account-forgot" type="button" onClick={() => changeMode('forgot')}>Forgot password?</button>}
              <button className="account-primary" type="submit">{busy ? 'One moment…' : copy[mode].submit}<span aria-hidden="true">↗</span></button>
              {mode === 'confirm' && <button className="account-text" type="button" disabled={!email} onClick={() => void perform('resend')}>Send a new code</button>}
            </fieldset>
          </form>
          <div className="account-switch">
            {mode === 'login' ? <>New here? <button type="button" disabled={busy} onClick={() => changeMode('signup')}>Create an account</button>
              <button className="account-resume" type="button" disabled={busy} onClick={() => changeMode('confirm')}>Finish email verification</button></> :
              <button type="button" disabled={busy} onClick={() => changeMode('login')}>← Back to sign in</button>}
          </div>
        </> : !social && <a className="account-primary" href="/api/v1/owner/login">Sign in / Create account ↗</a>}
      </> : <><h2>Your account.</h2><p>Account sign-in isn’t available yet. You can still use rooms.</p></>}
      {notice && <p className="account-notice" role="status">{notice}</p>}
      {error && <p className="account-error" role="alert">{error}</p>}
    </div>
  </section>;
}
