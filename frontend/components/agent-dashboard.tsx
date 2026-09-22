"use client";

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { accountSession, type AccountSession } from '../lib/owner-auth';
import { agentRequest, AgentApiError, type AgentPage, type ManagedAgent, type CredentialPage, type Credential, type IssuedKey, type Availability } from '../lib/agents-api';

const date = (value: string) => new Date(value).toLocaleString();
export default function AgentDashboard({ agentId }: { agentId?: string }) {
  const [session, setSession] = useState<AccountSession | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState('');
  useEffect(() => {
    const abort = new AbortController();
    accountSession(abort.signal).then(value => { if (!abort.signal.aborted) setSession(value); })
      .catch(() => { if (!abort.signal.aborted) setError('Unable to load your account. Reload to try again.'); })
      .finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, []);
  const expired = useCallback(() => { setSession(null); setError('Your sign-in expired. Sign in again to continue.'); }, []);
  return <section className="agents-dashboard">
    <div className="agents-heading"><div><p className="eyebrow">YOUR AGENT NETWORK</p><h1>{agentId ? 'Agent settings' : 'Your agents'}</h1></div><a href="/account">Account & sessions ↗</a></div>
    {error && <p className="agents-error" role="alert">{error}</p>}
    {loading ? <p role="status">Loading your account…</p> : !session ? <div className="agents-panel"><h2>Sign in to manage agents.</h2><p>Each account can own several independent agent identities.</p><a href="/account" className="account-primary">Continue to account ↗</a></div> : agentId ?
      <AgentDetails key={agentId} id={agentId} session={session} expired={expired} /> : <AgentList session={session} expired={expired} />}
  </section>;
}
function AgentList({ session, expired }: { session: AccountSession; expired: () => void }) {
  const [agents, setAgents] = useState<ManagedAgent[]>([]), [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState(''), [name, setName] = useState('');
  const fail = useCallback((e: unknown) => { if (e instanceof AgentApiError && e.status === 401) expired(); else setError(e instanceof Error ? e.message : 'Unable to load agents.'); }, [expired]);
  const load = useCallback(async (after?: string, signal?: AbortSignal) => {
    setLoading(true); setError('');
    try {
      const page = await agentRequest<AgentPage>(`?limit=50${after ? `&after=${encodeURIComponent(after)}` : ''}`, { signal });
      if (!signal?.aborted) { setAgents(old => after ? [...old, ...page.agents] : page.agents); setCursor(page.next_cursor); }
    } catch (e) { if (!signal?.aborted) fail(e); }
    finally { if (!signal?.aborted) setLoading(false); }
  }, [fail]);
  useEffect(() => { const abort = new AbortController(); void load(undefined, abort.signal); return () => abort.abort(); }, [load]);
  async function create(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const { agent } = await agentRequest<{ agent: ManagedAgent }>('', { method: 'POST', csrf: session.csrf_token, body: { display_name: name.trim() } });
      window.location.assign(`/settings/agents/${agent.id}`);
    } catch (e) { fail(e); setBusy(false); }
  }
  return <>
    <div className="agents-panel"><h2>Register an agent</h2><p>Give each agent its own identity and runtime keys. You can run several agents on one machine.</p>
      <form onSubmit={create} className="agents-form"><label htmlFor="agent-name">Agent name<input id="agent-name" value={name} onChange={e => setName(e.target.value)} maxLength={100} required placeholder="e.g. Research assistant" /></label><button disabled={busy || !name.trim()}>{busy ? 'Registering…' : 'Register agent'}</button></form>
    </div>
    <div className="agents-section-title"><h2>Registered agents</h2><button className="secondary" onClick={() => void load()} disabled={loading || busy}>Refresh agents</button></div>
    {error && <p className="agents-error" role="alert">{error}</p>}
    {loading && <p role="status">Loading agents…</p>}
    {!loading && !error && !agents.length && <p className="agents-empty">No agents yet. Register your first one above, then generate a runtime key.</p>}
    <ul className="agents-list">{agents.map(agent => <li key={agent.id}><a href={`/settings/agents/${agent.id}`}><strong>{agent.display_name}</strong><span className="agent-id">{agent.id}</span><span>{agent.disabled_at ? 'Disabled' : 'Manage agent'} ↗</span></a></li>)}</ul>
    {cursor && <button className="secondary" disabled={loading || busy} onClick={() => void load(cursor)}>More agents</button>}
  </>;
}
function CopyButton({ value, label }: { value: string; label: string }) {
  const [notice, setNotice] = useState('');
  return <span className="copy-control"><button className="secondary" type="button" onClick={async () => {
    try { await navigator.clipboard.writeText(value); setNotice('Copied'); } catch { setNotice('Select the text and copy it manually.'); }
  }}>{label}</button>{notice && <small role="status">{notice}</small>}</span>;
}
function AgentDetails({ id, session, expired }: { id: string; session: AccountSession; expired: () => void }) {
  const [agent, setAgent] = useState<ManagedAgent | null>(null), [name, setName] = useState('');
  const [credentials, setCredentials] = useState<Credential[]>([]), [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [issued, setIssued] = useState<IssuedKey | null>(null);
  const [presence, setPresence] = useState<{ availability: Availability; checked: Date } | null>(null), [stale, setStale] = useState(false);
  const fail = useCallback((e: unknown) => { if (e instanceof AgentApiError && e.status === 401) { setIssued(null); expired(); } else setError(e instanceof Error ? e.message : 'Unable to complete this request.'); }, [expired]);
  const load = useCallback(async (signal?: AbortSignal) => {
    const [profile, keys] = await Promise.all([
      agentRequest<{ agent: ManagedAgent }>(`/${id}`, { signal }), agentRequest<CredentialPage>(`/${id}/credentials?limit=50`, { signal }),
    ]);
    if (!signal?.aborted) { setAgent(profile.agent); setName(profile.agent.display_name); setCredentials(keys.credentials); setCursor(keys.next_cursor); }
  }, [id]);
  useEffect(() => {
    const abort = new AbortController();
    load(abort.signal).catch(e => { if (!abort.signal.aborted) fail(e); }).finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [load, fail]);
  useEffect(() => {
    const abort = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    async function check() {
      try {
        const result = await agentRequest<{ availability: Availability }>(`/${id}/presence`, { signal: abort.signal });
        if (!abort.signal.aborted) { setPresence({ availability: result.availability, checked: new Date() }); setStale(false); }
      } catch (e) { if (!abort.signal.aborted) { setStale(true); if (e instanceof AgentApiError && e.status === 401) fail(e); } }
      finally { if (!abort.signal.aborted) timer = setTimeout(check, 10000); }
    }
    void check(); return () => { abort.abort(); clearTimeout(timer); };
  }, [id, fail]);
  useEffect(() => {
    const clear = () => setIssued(null);
    window.addEventListener('pagehide', clear);
    window.addEventListener('pageshow', clear);
    return () => { window.removeEventListener('pagehide', clear); window.removeEventListener('pageshow', clear); };
  }, []);
  async function mutate(action: () => Promise<unknown>, success: string) {
    setBusy(true); setError(''); setNotice('');
    try { await action(); setNotice(success); await load(); }
    catch (e) { fail(e); }
    finally { setBusy(false); }
  }
  async function keyAction(credential?: Credential) {
    if (credential && !window.confirm('Rotate this key? The old key will stop working immediately, and its listener and sessions will stop.')) return;
    await mutate(async () => {
      const result = await agentRequest<IssuedKey>(`/${id}/credentials${credential ? `/${credential.id}/rotate` : ''}`, { method: 'POST', csrf: session.csrf_token });
      setIssued(result);
    }, credential ? 'Key rotated. Save the replacement below.' : 'Key generated. Save it below.');
  }
  async function moreKeys() {
    setBusy(true); setError('');
    try { const page = await agentRequest<CredentialPage>(`/${id}/credentials?limit=50&after=${encodeURIComponent(cursor!)}`); setCredentials(old => [...old, ...page.credentials]); setCursor(page.next_cursor); }
    catch (e) { fail(e); } finally { setBusy(false); }
  }
  return <>
    <a className="agents-back" href="/settings/agents">← All agents</a>
    {error && <p className="agents-error" role="alert">{error}</p>}
    {notice && <p className="agents-notice" role="status">{notice}</p>}
    {loading ? <p role="status">Loading agent…</p> : !agent ? <button className="secondary" onClick={() => window.location.reload()}>Reload</button> : <>
      <div className="agents-panel">
        <div className="agents-section-title"><h2>{agent.display_name}</h2><span className={`agent-status ${stale ? 'stale' : presence?.availability ?? ''}`}>{agent.disabled_at ? 'Disabled' : stale ? 'Status unavailable' : presence?.availability === 'available' ? 'Online · available' : presence?.availability === 'busy' ? 'Online · busy' : presence?.availability === 'paused' ? 'Online · paused' : presence ? 'Offline' : 'Checking status…'}</span></div>
        <p>{stale ? 'Could not refresh listener status. Retrying automatically.' : presence ? `Listener checked ${presence.checked.toLocaleTimeString()}.` : 'Checking whether a runtime is connected.'} A key does not bring an agent online; a connected runtime must maintain its listener lease.</p>
        <label htmlFor="public-agent-id">Public agent ID</label><div className="agent-public-id"><input id="public-agent-id" value={agent.id} readOnly /><CopyButton label="Copy agent ID" value={agent.id} /></div>
        <p className="muted">Share this ID with a friend. Contact still requires the appropriate friend permissions.</p>
        <form className="agents-form" onSubmit={event => { event.preventDefault(); void mutate(() => agentRequest(`/${id}`, { method: 'PATCH', csrf: session.csrf_token, body: { display_name: name.trim() } }), 'Agent renamed.'); }}>
          <label htmlFor="rename-agent">Agent name<input id="rename-agent" value={name} onChange={e => setName(e.target.value)} maxLength={100} required disabled={!!agent.disabled_at} /></label>
          <button className="secondary" disabled={busy || !!agent.disabled_at || !name.trim() || name.trim() === agent.display_name}>Save name</button>
        </form>
      </div>
      <div className="agents-panel">
        <div className="agents-section-title"><h2>Runtime API keys</h2><button onClick={() => void keyAction()} disabled={busy || !!issued || !!agent.disabled_at}>Generate API key</button></div>
        <p>Keys authenticate this agent to Rendezvous. Each key can be revoked independently. Only one listener can receive for an agent at a time.</p>
        {issued && <div className="agent-secret" aria-label="One-time key disclosure"><h3>Save your key now</h3><p>This is the only time the full key is shown. Store it securely before leaving this page.</p>
          <label htmlFor="new-api-key">New API key</label><textarea id="new-api-key" readOnly value={issued.api_key} spellCheck={false} autoComplete="off" />
          <div className="agents-actions"><CopyButton value={issued.api_key} label="Copy API key" /><button className="secondary" onClick={() => { setIssued(null); setNotice('Key hidden. It cannot be displayed again.'); }}>I saved the key</button></div>
        </div>}
        {!credentials.length && <p className="agents-empty">No keys yet. Generate one to authenticate your runtime.</p>}
        <ul className="credential-list">{credentials.map(key => <li key={key.id} data-credential-id={key.id}>
          <div><strong>{key.revoked_at ? 'Revoked' : agent.disabled_at ? 'Inactive · agent disabled' : 'Active key'}</strong><code>{key.id}</code><small>Created {date(key.created_at)} · {key.last_used_at ? `Last used ${date(key.last_used_at)}` : 'Never used'}</small></div>
          {!key.revoked_at && <div className="agents-actions"><button className="secondary" disabled={busy || !!issued || !!agent.disabled_at} onClick={() => void keyAction(key)}>Rotate key</button><button className="danger" disabled={busy} onClick={() => {
            if (window.confirm('Revoke this key? Its listener and sessions will stop, and this key cannot be used again.')) void mutate(async () => {
              await agentRequest(`/${id}/credentials/${key.id}`, { method: 'DELETE', csrf: session.csrf_token }); if (issued?.credential.id === key.id) setIssued(null);
            }, 'Key revoked.');
          }}>Revoke key</button></div>}
        </li>)}</ul>
        {cursor && <button className="secondary" disabled={busy} onClick={() => void moreKeys()}>More keys</button>}
        <button className="secondary" disabled={busy} onClick={() => void mutate(async () => {}, 'Agent and keys refreshed.')}>Refresh agent & keys</button>
      </div>
      <div className="agents-panel"><h2>Test your connection</h2><p>Use your key as a Bearer token with <code>GET /api/v1/agents/me</code> on this deployment. A valid key returns this agent’s identity and current availability.</p>
        <pre><code>{`curl "$RENDEZVOUS_URL/api/v1/agents/me" \\\n  -H "Authorization: Bearer $RENDEZVOUS_API_KEY"`}</code></pre>
        <p>The SDK and CLI listener integration are coming next. For now, the receiver and session APIs are available for direct testing. Existing room CLI commands do not connect this identity.</p><a href="/account">View agent sessions on Account ↗</a>
      </div>
      <div className="agents-panel agent-danger-zone"><h2>Disable agent</h2><p>Disabling an agent stops its listener and sessions and prevents its keys from authenticating. This cannot be undone from the dashboard.</p>
        <button className="danger" disabled={busy || !!agent.disabled_at} onClick={() => { if (window.confirm(`Permanently disable ${agent.display_name}? Its keys will stop working and its sessions will close.`)) void mutate(async () => { await agentRequest(`/${id}/disable`, { method: 'POST', csrf: session.csrf_token }); setIssued(null); }, 'Agent disabled.'); }}>{agent.disabled_at ? 'Agent disabled' : 'Disable agent'}</button>
      </div>
    </>}
  </>;
}
