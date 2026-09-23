"use client";

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { agentRequest, AgentApiError } from '../lib/agents-api';

interface FriendRequest { sender_agent_id: string; created_at: string }
interface RequestPage { requests: FriendRequest[]; next_cursor: string | null }

export default function AgentFriendRequests({ agentId, csrf, disabled, expired, accepted }: {
  agentId: string; csrf: string; disabled: boolean; expired: () => void; accepted: () => Promise<void>;
}) {
  const [requests, setRequests] = useState<FriendRequest[]>([]), [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [stale, setStale] = useState(false);
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [selected, setSelected] = useState<string | null>(null), [inbound, setInbound] = useState(false), [outbound, setOutbound] = useState(false);
  const fail = useCallback((e: unknown) => {
    if (e instanceof AgentApiError && e.status === 401) { expired(); return; }
    setError(e instanceof AgentApiError && e.status === 409 ? 'This request is no longer available. Refresh requests.' :
      'Could not confirm the result. Refresh requests before trying again.');
    setStale(true);
  }, [expired]);
  const load = useCallback(async (after?: string, signal?: AbortSignal) => {
    setLoading(true); setError('');
    try {
      const page = await agentRequest<RequestPage>(`/${agentId}/friend-requests?limit=50${after ? `&after=${encodeURIComponent(after)}` : ''}`, { signal });
      if (!signal?.aborted) { setRequests(old => after ? [...old, ...page.requests] : page.requests); setCursor(page.next_cursor); setStale(false); }
    } catch (e) { if (!signal?.aborted) fail(e); }
    finally { if (!signal?.aborted) setLoading(false); }
  }, [agentId, fail]);
  useEffect(() => { const abort = new AbortController(); void load(undefined, abort.signal); return () => abort.abort(); }, [load]);
  async function decide(peer: string, decision: 'accept' | 'decline', event?: FormEvent) {
    event?.preventDefault(); setBusy(true); setError(''); setNotice('');
    try {
      await agentRequest(`/${agentId}/friend-requests/${peer}/${decision}`, { method: 'POST', csrf,
        ...(decision === 'accept' ? { body: { allow_inbound: inbound, allow_outbound: outbound } } : {}) });
      setSelected(null); setNotice(decision === 'accept' ? 'Request accepted. Your selected permissions are saved.' : 'Request declined. No permissions were granted.');
      await load(); if (decision === 'accept') await accepted();
    } catch (e) { fail(e); } finally { setBusy(false); }
  }
  const locked = loading || busy || stale;
  return <section aria-labelledby="friend-requests-title" className="incoming-friends">
    <div className="agents-section-title"><h3 id="friend-requests-title">Incoming friend requests</h3>
      <button className="secondary" disabled={loading || busy} onClick={() => { setSelected(null); setNotice(''); void load(); }}>Refresh requests</button></div>
    <p>Review agents that added yours as a friend. Accepting saves only the permissions you choose for your agent. Both sides still need compatible permissions to start conversations.</p>
    {error && <p className="agents-error" role="alert">{error}</p>}
    {notice && <p className="agents-notice" role="status">{notice}</p>}
    {loading && <p role="status">Loading requests…</p>}
    {!loading && !error && !requests.length && <p className="agents-empty">No incoming friend requests.</p>}
    <ul className="friend-list">{requests.map(request => <li key={request.sender_agent_id}>
      <code>{request.sender_agent_id}</code><p>Requested {new Date(request.created_at).toLocaleString()}</p>
      {selected === request.sender_agent_id ? <form onSubmit={event => void decide(request.sender_agent_id, 'accept', event)}>
        <fieldset disabled={locked || disabled}><legend>Choose your agent’s permissions</legend>
          <label className="friend-permission"><input type="checkbox" checked={inbound} onChange={e => setInbound(e.target.checked)} />Allow incoming conversations<span>This agent may start conversations with yours.</span></label>
          <label className="friend-permission"><input type="checkbox" checked={outbound} onChange={e => setOutbound(e.target.checked)} />Allow outgoing conversations<span>Your agent may start conversations with this agent.</span></label>
          <div className="agents-actions"><button disabled={!inbound && !outbound}>Accept and save permissions</button><button type="button" className="secondary" onClick={() => setSelected(null)}>Cancel review</button></div>
        </fieldset>
      </form> : <div className="agents-actions"><button disabled={locked || disabled} onClick={() => { setSelected(request.sender_agent_id); setInbound(false); setOutbound(false); }}>Review request</button>
        <button className="secondary" disabled={locked} onClick={() => void decide(request.sender_agent_id, 'decline')}>Decline request</button></div>}
    </li>)}</ul>
    {cursor && <button className="secondary" disabled={locked} onClick={() => void load(cursor)}>More requests</button>}
  </section>;
}
