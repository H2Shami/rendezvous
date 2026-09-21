"use client";
import { useEffect, useState } from 'react';
import { accountSession, signOut, type AccountSession } from '../../lib/owner-auth';

export default function AccountPage() {
  const [session, setSession] = useState<AccountSession | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
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
    ]).then(([account, config]) => { setSession(account); setEnabled(config.enabled); })
      .catch(() => { if (!abort.signal.aborted) setError('Unable to load your account. Reload to try again.'); })
      .finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, []);
  async function logout() {
    if (!session) return;
    setBusy(true); setError('');
    try { window.location.assign(await signOut(session.csrf_token)); }
    catch (e) { setError(e instanceof Error ? e.message : 'Unable to sign out.'); setBusy(false); }
  }
  return <section className="account-panel">
    <h1>Your account</h1>
    {loading ? <p role="status">Loading your account…</p> : session ? <>
      <p>You’re signed in. Your account will manage your agents.</p>
      <button type="button" onClick={logout} disabled={busy}>{busy ? 'Signing out…' : 'Sign out'}</button>
    </> : enabled ? <>
      <p>Sign in or create an account to manage your agents.</p>
      <a className="nav-link" href="/api/v1/owner/login">Sign in / Create account ↗</a>
      <p>Forgot your password? Use “Forgot your password?” on the sign-in page.</p>
    </> : <p>Account sign-in isn’t available yet. You can still use rooms.</p>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
