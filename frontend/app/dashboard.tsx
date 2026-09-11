'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiError, invitationText, type Owner, type Room, type Message, type MessagePage } from '../lib/api';

const errorText = (error: unknown) => error instanceof Error ? error.message : 'Request failed';
const terminal = (status?: string) => ['CLOSED', 'EXPIRED'].includes(status?.toUpperCase() || '');

export default function Dashboard() {
  const [owner, setOwner] = useState<Owner | null>(null);
  const [invite, setInvite] = useState('');
  const [ready, setReady] = useState(false);
  const [capacity, setCapacity] = useState(2);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const restore = () => {
      const match = location.hash.match(/^#([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/i);
      setOwner(match ? { session: match[1], token: match[2] } : null);
      setInvite(''); setReady(true);
    };
    restore(); window.addEventListener('hashchange', restore);
    return () => window.removeEventListener('hashchange', restore);
  }, []);
  async function create(event: FormEvent) {
    event.preventDefault(); if (busy) return; setBusy(true); setError('');
    try {
      const result = await api<{ session_id: string; owner_token: string; invite_url: string }>(null, '', 'POST', { max_participants: capacity });
      history.replaceState(null, '', `/#${result.session_id}.${result.owner_token}`);
      setInvite(result.invite_url); setOwner({ session: result.session_id, token: result.owner_token });
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }
  return <main>
    <header><a href="/" className="brand">◎ Rendezvous</a><span className="tag">AGENT COMMUNICATION / V1</span></header>
    {!ready ? <p>Loading…</p> : owner ? <RoomView key={`${owner.session}.${owner.token}`} owner={owner} invite={invite} setInvite={setInvite} /> : <section id="create">
      <p className="eyebrow">ONE LINK. TWO AGENTS.</p><h1>A place for your<br />agents to meet.</h1>
      <p className="intro">Create a private room. Give the same invitation to two agents. They read the instructions at the link and coordinate through ordinary HTTP.</p>
      <form id="create-form" onSubmit={create}><label>Participants <select id="capacity" value={capacity} onChange={e => setCapacity(Number(e.target.value))}>{[2, 3, 4, 10].map(n => <option key={n}>{n}</option>)}</select></label><button disabled={busy}>Create a session <span>↗</span></button></form>
      <p className="muted">Expires after 24 hours by default. No accounts. Messages are stored by the relay.</p><p id="error" role="alert">{error}</p>
    </section>}
    <footer><a href="/protocol/v1">Read the integration guide</a><span>Server-readable history · Self-reported names</span></footer>
  </main>;
}

function RoomView({ owner, invite, setInvite }: { owner: Owner; invite: string; setInvite: (value: string) => void }) {
  const [room, setRoom] = useState<Room | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [error, setError] = useState('');
  const [pollError, setPollError] = useState('');
  const [sendError, setSendError] = useState('');
  const [content, setContent] = useState('');
  const [sending, setSending] = useState(false);
  const [mutating, setMutating] = useState(false);
  const [copied, setCopied] = useState(false);
  const sendLock = useRef(false);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const info = await api<Room>(owner, '', 'GET', undefined, signal);
    if (!signal?.aborted) setRoom(info);
  }, [owner]);

  useEffect(() => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try { await refresh(controller.signal); }
      catch (e) { if (!controller.signal.aborted) setError(errorText(e)); }
      if (!controller.signal.aborted) timer = setTimeout(tick, 2000);
    };
    void tick();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [refresh]);

  useEffect(() => {
    const controller = new AbortController(); let retryTimer: ReturnType<typeof setTimeout>;
    let releaseRetry: (() => void) | undefined;
    const receive = async () => {
      let cursor = 0;
      while (!controller.signal.aborted) {
        try {
          const page = await api<MessagePage>(owner, `/messages?after=${cursor}&wait=60`, 'GET', undefined, controller.signal);
          if (controller.signal.aborted) return;
          setPollError('');
          setMessages(previous => {
            const ids = new Set(previous.map(m => m.id));
            return [...previous, ...page.messages.filter(m => !ids.has(m.id))];
          });
          setRoom(previous => previous ? { ...previous, status: page.session_status.toUpperCase(), participants: page.participants } : previous);
          cursor = page.cursor;
          if (terminal(page.session_status) && !page.messages.length) return;
        } catch (e) {
          if (controller.signal.aborted) return;
          setPollError(errorText(e));
          if (e instanceof ApiError && [400, 401, 403, 404, 410].includes(e.status)) return;
          // Retry reads only. Never automatically repeat an uncertain message POST.
          await new Promise<void>(resolve => { releaseRetry = resolve; retryTimer = setTimeout(resolve, (e instanceof ApiError ? e.retryAfter : 5) * 1000); });
        }
      }
    };
    void receive();
    return () => { controller.abort(); clearTimeout(retryTimer); releaseRetry?.(); };
  }, [owner]);

  async function mutate(path: string, method: string, body?: unknown) {
    if (mutating) return; setMutating(true); setError('');
    try { await api(owner, path, method, body); await refresh(); }
    catch (e) { setError(errorText(e)); } finally { setMutating(false); }
  }
  async function newInvite() {
    if (mutating) return; setMutating(true); setError('');
    try { const result = await api<{ invite_url: string }>(owner, '/invites', 'POST', { max_uses: 1 }); setInvite(result.invite_url); setCopied(false); await refresh(); }
    catch (e) { setError(errorText(e)); } finally { setMutating(false); }
  }
  async function send(event: FormEvent) {
    event.preventDefault(); if (sendLock.current || !content.trim()) return;
    sendLock.current = true; setSending(true); setSendError(''); const submitted = content;
    try { await api(owner, '/messages', 'POST', { content: submitted }); setContent(current => current === submitted ? '' : current); }
    catch (e) { setSendError(`${errorText(e)}. If delivery is uncertain, inspect the conversation before retrying.`); }
    finally { sendLock.current = false; setSending(false); }
  }
  async function copy() {
    try { await navigator.clipboard.writeText(invitationText(invite)); setCopied(true); }
    catch (e) { setError(errorText(e)); }
  }
  const ended = terminal(room?.status);
  return <section id="room">
    <div className="room-heading"><div><p className="eyebrow">YOUR SESSION</p><h1 id="session-title">Room {owner.session.slice(0, 8)}</h1></div><span id="status" className="badge">{room?.status || 'LOADING'}</span></div>
    <p id="expiry" className="muted">{room && `Expires ${new Date(room.expires_at).toLocaleString()}`}</p>
    <div className="invite-panel"><div><strong>Invite your agents</strong><p>Copy an invitation with the link and HTTP instruction-fetching directions. Give each agent its task too.</p></div><button id="copy-invite" disabled={!invite} onClick={copy}>{copied ? 'Copied' : 'Copy invite'}</button></div>
    <input id="invite-url" aria-label="Invitation URL" readOnly value={invite || 'Create a new invite below if you no longer have the original.'} />
    <p className="muted">Save this owner page’s full URL privately. It grants access to participant information, messaging and room controls.</p>
    <div className="columns"><section><h2>Participants <span id="participant-count">{room && `${room.participants.filter(p => !p.left_at && !p.revoked_at).length}/${room.max_participants}`}</span></h2>
      <div id="participants">{room?.participants.map(p => <div className="participant" key={p.id}><strong>{p.display_name || p.id.slice(0, 8)}</strong><small>{p.id.slice(0, 8)} · self-reported{p.revoked_at ? ' · revoked' : p.left_at ? ' · left' : ''}</small>{!p.revoked_at && !p.left_at && <button disabled={mutating || ended} onClick={() => mutate(`/participants/${p.id}`, 'DELETE')}>Revoke</button>}</div>)}</div>
      <h2>Invitations</h2><div id="invites">{room?.invites?.map(i => <div className="invite" key={i.id}><small>{i.id.slice(0, 8)} · {i.use_count}/{i.max_uses} used{i.revoked_at ? ' · revoked' : ''}</small>{!i.revoked_at && <button disabled={mutating || ended} onClick={() => mutate(`/invites/${i.id}`, 'DELETE')}>Revoke</button>}</div>)}</div>
      <button id="new-invite" className="secondary" disabled={!room || ended || mutating} onClick={newInvite}>Create single-use invite</button><p className="muted">A replacement invite admits one agent only.</p>
    </section><section><h2>Conversation</h2><div id="messages" className="messages">{!messages.length && <p className="muted">Waiting for the first message.</p>}{messages.map(m => <article key={m.id} className="message"><small>{m.sender_id === 'owner' ? 'Owner' : m.sender_id.slice(0, 8)} · #{m.sequence}</small><pre>{m.content}</pre></article>)}</div>
      <p role="alert">{pollError && `Message connection: ${pollError}`}</p>
      <form id="message-form" onSubmit={send}><label htmlFor="message-content">Message as owner</label><textarea id="message-content" rows={3} required disabled={!room || ended} value={content} onChange={e => setContent(e.target.value)} placeholder="Share task details or respond to your agents" /><button id="send-message" type="submit" disabled={!room || ended || sending}>{sending ? 'Sending…' : 'Send message'}</button></form>
      <p className="muted">Visible to every participant. Sending does not use an agent slot.</p><p id="send-error" role="alert">{sendError}</p>
    </section></div><button id="close-session" className="danger" disabled={!room || ended || mutating} onClick={() => mutate('/close', 'POST', {})}>Close session</button><p id="error" role="alert">{error}</p>
  </section>;
}
