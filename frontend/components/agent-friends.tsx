"use client";

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { agentRequest, AgentApiError, type PeerPolicy, type PeerPolicyPage } from '../lib/agents-api';

export default function AgentFriends({ agentId, csrf, disabled, expired }: {
  agentId: string; csrf: string; disabled: boolean; expired: () => void;
}) {
  const [policies, setPolicies] = useState<PeerPolicy[]>([]), [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [stale, setStale] = useState(false);
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [peer, setPeer] = useState(''), [editing, setEditing] = useState<PeerPolicy | null>(null);
  const [inbound, setInbound] = useState(false), [outbound, setOutbound] = useState(false);
  const fail = useCallback((e: unknown) => {
    if (e instanceof AgentApiError && e.status === 401) { expired(); return; }
    const messages: Record<number, string> = {
      0: 'The result could not be confirmed. Refresh friends before trying again.',
      400: 'Check the friend’s agent ID and permissions, then try again.',
      403: 'Permission change rejected. Check the agent ID, or reload to refresh your sign-in.',
      404: 'This agent or permission is unavailable. Refresh friends to check its current state.',
    };
    setError(e instanceof AgentApiError ? messages[e.status] ?? e.message : 'Unable to load friend permissions. Refresh to try again.');
  }, [expired]);
  const load = useCallback(async (after?: string, signal?: AbortSignal) => {
    setLoading(true); setError('');
    try {
      const page = await agentRequest<PeerPolicyPage>(`/${agentId}/peers?limit=50${after ? `&after=${encodeURIComponent(after)}` : ''}`, { signal });
      if (!signal?.aborted) { setPolicies(old => after ? [...old, ...page.policies] : page.policies); setCursor(page.next_cursor); setStale(false); }
    } catch (e) { if (!signal?.aborted) { setStale(true); fail(e); } }
    finally { if (!signal?.aborted) setLoading(false); }
  }, [agentId, fail]);
  useEffect(() => { const abort = new AbortController(); void load(undefined, abort.signal); return () => abort.abort(); }, [load]);
  function reset() { setEditing(null); setPeer(''); setInbound(false); setOutbound(false); }
  async function save(event: FormEvent) {
    event.preventDefault(); setError(''); setNotice('');
    const id = peer.trim().toLowerCase();
    if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id)) { setError('Enter a valid agent UUID, not an API key or agent name.'); return; }
    if (id === agentId.toLowerCase()) { setError('Choose a different agent. An agent cannot add itself.'); return; }
    if (!editing && policies.some(p => p.peer_agent_id === id)) { setError('This friend is already listed. Use Edit permissions below.'); return; }
    if (editing && ((editing.allow_inbound && !inbound) || (editing.allow_outbound && !outbound)) &&
      !window.confirm('Remove these permissions? Pending and active sessions that depend on them will close immediately.')) return;
    setBusy(true);
    try {
      // An existing policy may be on another page: never overwrite it from the add form.
      if (!editing) {
        try {
          const { policy } = await agentRequest<{ policy: PeerPolicy }>(`/${agentId}/peers/${id}`);
          setEditing(policy); setPeer(id); setInbound(policy.allow_inbound); setOutbound(policy.allow_outbound);
          setNotice('This friend already exists. Review and edit its saved permissions.'); return;
        } catch (e) { if (!(e instanceof AgentApiError && e.status === 404)) throw e; }
      }
      await agentRequest(`/${agentId}/peers/${id}`, { method: 'PUT', csrf, body: { allow_inbound: inbound, allow_outbound: outbound } });
      reset(); setNotice('Friend permissions saved for your agent. The other owner must configure their side too.'); await load();
    } catch (e) { setStale(true); fail(e); } finally { setBusy(false); }
  }
  async function remove(policy: PeerPolicy) {
    if (!window.confirm('Remove this friend? All pending and active sessions between these agents will close immediately.')) return;
    setBusy(true); setError(''); setNotice('');
    try {
      await agentRequest(`/${agentId}/peers/${policy.peer_agent_id}`, { method: 'DELETE', csrf });
      reset(); setNotice('Friend removed. Your agent no longer permits conversations with this agent.'); await load();
    } catch (e) { setStale(true); fail(e); } finally { setBusy(false); }
  }
  const locked = busy || loading || stale;
  return <section className="agents-panel agent-friends" aria-labelledby="friends-title">
    <div className="agents-section-title"><h2 id="friends-title">Friends</h2><button className="secondary" disabled={busy || loading} onClick={() => { reset(); setNotice(''); void load(); }}>Refresh friends</button></div>
    <p>Choose which agents may start conversations with yours, and which agents yours may contact. These permissions apply to your agent only.</p>
    <p>For your agent to start a conversation, allow outgoing conversations here and ask the other owner to allow incoming conversations from your agent ID. Reverse those permissions for them to start. This list does not confirm their permissions.</p>
    {error && <p className="agents-error" role="alert">{error}</p>}
    {notice && <p className="agents-notice" role="status">{notice}</p>}
    {disabled && <p>This agent is disabled. You can still remove friends, but it cannot participate in conversations.</p>}
    <form onSubmit={save}>
      <fieldset disabled={locked || disabled}>
        <legend>{editing ? 'Edit friend permissions' : 'Add a friend'}</legend>
        <label htmlFor="friend-agent-id">Friend’s agent ID<input id="friend-agent-id" value={peer} readOnly={!!editing} onChange={e => setPeer(e.target.value)} placeholder="Paste their agent UUID" required autoComplete="off" spellCheck={false} /></label>
        <label className="friend-permission"><input type="checkbox" checked={inbound} onChange={e => setInbound(e.target.checked)} />Allow incoming conversations<span>This friend may start a conversation with your agent.</span></label>
        <label className="friend-permission"><input type="checkbox" checked={outbound} onChange={e => setOutbound(e.target.checked)} />Allow outgoing conversations<span>Your agent may start a conversation with this friend.</span></label>
        <p>Turning off a permission closes sessions that depend on it. With both off, neither agent can start a conversation with the other.</p>
        <div className="agents-actions"><button disabled={!peer.trim()}>{busy ? 'Saving…' : editing ? 'Save permissions' : 'Add friend'}</button>{editing && <button type="button" className="secondary" onClick={reset}>Cancel editing</button>}</div>
      </fieldset>
    </form>
    {loading && <p role="status">Loading friends…</p>}
    {!loading && !error && !policies.length && <p className="agents-empty">No friends yet. Ask the other owner for their agent ID to get started.</p>}
    {stale && <p>Permissions may be out of date. Refresh friends before making changes.</p>}
    <ul className="friend-list">{policies.map(policy => <li key={policy.peer_agent_id}>
      <code>{policy.peer_agent_id}</code>
      <p>Incoming: {policy.allow_inbound ? 'Allowed by you' : 'Not allowed'} · Outgoing: {policy.allow_outbound ? 'Allowed by you' : 'Not allowed'}</p>
      <div className="agents-actions"><button className="secondary" disabled={locked || disabled} onClick={() => { setEditing(policy); setPeer(policy.peer_agent_id); setInbound(policy.allow_inbound); setOutbound(policy.allow_outbound); setError(''); setNotice(''); document.getElementById('friend-agent-id')?.focus(); }}>Edit permissions</button><button className="danger" disabled={locked} onClick={() => void remove(policy)}>Remove friend</button></div>
    </li>)}</ul>
    {cursor && <button className="secondary" disabled={locked} onClick={() => void load(cursor)}>More friends</button>}
  </section>;
}
