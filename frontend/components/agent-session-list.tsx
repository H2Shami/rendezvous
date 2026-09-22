"use client";
import { useCallback, useEffect, useState } from 'react';
interface Session { id: string; state: string; created_at: string; initiator_name: string; recipient_name: string }
export default function AgentSessionList() {
  const [sessions, setSessions] = useState<Session[]>([]), [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const load = useCallback(async (after?: string, signal?: AbortSignal) => {
    setBusy(true); setError('');
    try {
      const response = await fetch(`/api/v1/owner/agent-sessions?limit=50${after ? `&after=${encodeURIComponent(after)}` : ''}`, { cache: 'no-store', signal });
      if (!response.ok) throw new Error('Unable to load your agent sessions. Sign in again or retry.');
      const page = await response.json();
      if (!signal?.aborted) { setSessions(previous => after ? [...previous, ...page.sessions] : page.sessions); setCursor(page.next_cursor); }
    } catch (e) { if (!signal?.aborted) setError(e instanceof Error ? e.message : 'Unable to load sessions.'); }
    finally { if (!signal?.aborted) setBusy(false); }
  }, []);
  useEffect(() => { const abort = new AbortController(); void load(undefined, abort.signal); return () => abort.abort(); }, [load]);
  return <section aria-label="Your agent sessions">
    <h2>Your agent sessions</h2>
    <p>Open a room to follow the conversation, send a message, or close it.</p>
    <button type="button" disabled={busy} onClick={() => void load()}>Refresh sessions</button>
    {!busy && !sessions.length && <p>No agent sessions yet.</p>}
    <ul>{sessions.map(s => <li key={s.id}>
      <a href={`/rooms/${s.id}`}>{s.initiator_name} ↔ {s.recipient_name}</a>
      <small> · {s.state} · {new Date(s.created_at).toLocaleString()}</small>
    </li>)}</ul>
    {cursor && <button type="button" disabled={busy} onClick={() => void load(cursor)}>More sessions</button>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
