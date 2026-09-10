import { generateKeyPairSync, createPrivateKey } from 'node:crypto';
import { readFile, writeFile, rename, mkdir, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { messageBytes, proofBytes, publicKey, secret, signBytes, uuid, verifyBytes } from '../src/protocol.js';
import { checkContext, contextId } from './context.js';

export async function saveState(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${uuid()}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' });
  await rename(tmp, path);
}
export async function readState(path) {
  const info = await stat(path);
  if ((info.mode & 0o077) !== 0) throw new Error('State file must be private: chmod 600 the file before continuing.');
  return JSON.parse(await readFile(path, 'utf8'));
}
export async function request(url, { method = 'GET', body, token } = {}) {
  let res;
  try { res = await fetch(url, { method, redirect: 'error', signal: AbortSignal.timeout(15000),
    headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); }
  catch (cause) {
    const e = new Error('NETWORK_UNREACHABLE: Could not reach the rendezvous service. In a sandbox, retry the HTTP request with approved network access. A failed sandbox request does not prove the server is stopped. Do not start a server or modify its database to join a room.', { cause });
    e.code = 'NETWORK_UNREACHABLE'; throw e;
  }
  const value = await res.json();
  if (!res.ok) { const e = new Error(`${value.error?.code || res.status}: ${value.error?.message || 'Request failed'}`); e.code = value.error?.code; throw e; }
  return value;
}
export function parseInvite(invite) {
  const url = new URL(invite.trim());
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('Invites must use HTTPS (HTTP allowed on loopback).');
  if (url.search || url.username || url.password) throw new Error('Invitation must not contain query credentials or userinfo.');
  const match = url.pathname.match(/^\/join\/([0-9a-f-]{36})$/i);
  if (!match || !/^[A-Za-z0-9_-]{43}$/.test(url.hash.slice(1))) throw new Error('Keep the full invitation URL, including its #secret fragment.');
  return { base: url.origin, session_id: match[1], invite_token: url.hash.slice(1) };
}
export class Agent {
  constructor(state, path) { this.state = state; this.path = path; this.keys = new Map(Object.entries(state.peer_keys || {})); this.outbox = Promise.resolve(); this.saving = Promise.resolve(); }
  static async connect(invite, path, name = 'Agent', { context = contextId(), adopt = false } = {}) {
    const location = parseInvite(invite);
    // Reading discovery is part of bootstrap; do not trust a document to redirect credentials.
    const d = await request(`${location.base}/join/${location.session_id}`);
    if (d.protocol !== 'agent-rendezvous' || d.version !== '1' || d.session_id !== location.session_id) throw new Error('Unsupported rendezvous protocol.');
    let state;
    try { state = await readState(path); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (state) {
      checkContext(state, context, adopt);
      if (!state.client_context && state.participant_id && !adopt) throw new Error('STATE_ALREADY_JOINED: This file already contains a participant. Use chat/read/wait to resume your own identity, or choose a new path for a different agent. --adopt-state explicitly takes over an existing identity.');
    }
    if (state && (state.base !== location.base || state.session_id !== location.session_id)) throw new Error('State belongs to another session. Choose another --state file.');
    if (!state) {
      const { privateKey, publicKey: pub } = generateKeyPairSync('ed25519');
      state = { ...location, private_key: privateKey.export({ format: 'pem', type: 'pkcs8' }),
        public_key: pub.export({ format: 'der', type: 'spki' }).toString('base64url'), metadata: { name, runtime: 'node' }, cursor: 0, next_sequence: 1, client_context: context };
      await saveState(path, state);
    }
    const agent = new Agent(state, path);
    state.client_context = checkContext(state, context, adopt);
    if (state.participant_id) { await agent.renew(); return agent; }
    const challenge = await agent.call('/challenge', { method: 'POST', body: {} });
    const body = { session_id: state.session_id, public_key: state.public_key, invite_token: location.invite_token,
      client_nonce: secret(), server_nonce: challenge.server_nonce, metadata: state.metadata };
    body.signature = signBytes(proofBytes('join', body), agent.privateKey());
    Object.assign(state, await agent.call('/join', { method: 'POST', body })); delete state.invite_token;
    await agent.save(); return agent;
  }
  static async load(path, { context = contextId(), adopt = false } = {}) {
    const state = await readState(path);
    if (context && !state.client_context && state.participant_id && !adopt) throw new Error('STATE_ALREADY_JOINED: This legacy state has no runtime binding. Use --adopt-state only if this is your own identity; otherwise join with a new path.');
    state.client_context = checkContext(state, context, adopt);
    const agent = new Agent(state, path); await agent.save(); return agent;
  }
  privateKey() { return createPrivateKey(this.state.private_key); }
  save() {
    const operation = this.saving.then(() => saveState(this.path, this.state));
    this.saving = operation.catch(() => {}); return operation;
  }
  call(path, opts = {}) { return request(`${this.state.base}/api/v1/sessions/${this.state.session_id}${path}`, { token: this.state.credential, ...opts }); }
  async renew() {
    if (!this.state.participant_id) throw new Error('Join did not finish. Re-run connect with the original invitation.');
    const challenge = await this.call('/challenge', { method: 'POST', body: {} });
    const body = { session_id: this.state.session_id, participant_id: this.state.participant_id, client_nonce: secret(), server_nonce: challenge.server_nonce };
    body.signature = signBytes(proofBytes('renew', body), this.privateKey());
    Object.assign(this.state, await this.call('/renew', { method: 'POST', body })); await this.save();
  }
  async ready() { if (!this.state.credential || Date.parse(this.state.credential_expires_at) < Date.now() + 30000) await this.renew(); }
  async refreshKeys() {
    await this.ready(); const info = await this.call('');
    for (const p of info.participants) {
      if (this.keys.has(p.id) && this.keys.get(p.id) !== p.public_key) throw new Error('Participant key changed unexpectedly.');
      this.keys.set(p.id, p.public_key);
    }
    this.state.peer_keys = Object.fromEntries(this.keys); await this.save();
    return info;
  }
  send(payload, type = 'message') {
    const operation = this.outbox.then(async () => {
      await this.ready();
      if (this.state.pending) throw new Error('An earlier send is pending. Run retry before sending another message.');
      const m = { id: uuid(), session_id: this.state.session_id, sender_id: this.state.participant_id,
        sequence: this.state.next_sequence, created_at: new Date().toISOString(), type, content_type: 'application/json', payload };
      m.signature = signBytes(messageBytes(m), this.privateKey()); this.state.pending = m; await this.save();
      return this.retry();
    });
    this.outbox = operation.catch(() => {}); return operation;
  }
  async retry() {
    await this.ready();
    const m = this.state.pending; if (!m) throw new Error('No pending message.');
    const ack = await this.call('/messages', { method: 'POST', body: m });
    this.state.next_sequence = Math.max(this.state.next_sequence, m.sequence + 1); delete this.state.pending; await this.save(); return ack;
  }
  async receive(row, onMessage) {
    if (row.offset <= this.state.cursor) return;
    if (row.offset !== this.state.cursor + 1) throw new Error('Delivery gap detected. Reconnect from the saved cursor.');
    const m = row.message;
    if (m.session_id !== this.state.session_id) throw new Error('Wrong session in received message.');
    if (!this.keys.has(m.sender_id)) await this.refreshKeys();
    verifyBytes(messageBytes(m), m.signature, publicKey(this.keys.get(m.sender_id)));
    await onMessage(row); this.state.cursor = row.offset; await this.save();
  }
  async read(onMessage = row => console.log(JSON.stringify(row))) {
    await this.ready(); let page;
    do {
      page = await this.call(`/messages?after=${this.state.cursor}`);
      for (const row of page.messages) await this.receive(row, onMessage);
    } while (page.has_more);
    return this.state.cursor;
  }
  async wait({ timeoutSeconds = 55, signal, onMessage = row => console.log(JSON.stringify(row)), pollMs = 1000 } = {}) {
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 55) throw new Error('timeout must be an integer from 1 to 55 seconds.');
    const deadline = Date.now() + timeoutSeconds * 1000;
    let count = 0;
    do {
      if (signal?.aborted) return { status: 'cancelled', cursor: this.state.cursor, received: count };
      await this.read(async row => {
        // Own echoes advance the cursor but must not end a wait for a peer.
        if (row.message.sender_id !== this.state.participant_id) { await onMessage(row); count++; }
      });
      if (count) return { status: 'messages', cursor: this.state.cursor, received: count };
      const info = await this.call('');
      if (info.status === 'CLOSED') return { status: 'closed', cursor: this.state.cursor, received: 0 };
      if (Date.now() >= deadline) break;
      await pause(Math.min(pollMs, deadline - Date.now()), signal);
    } while (Date.now() < deadline);
    return { status: signal?.aborted ? 'cancelled' : 'timeout', cursor: this.state.cursor, received: 0 };
  }
  async watch({ transport = 'ws', signal, onMessage = row => console.log(JSON.stringify(row)), onStatus = () => {} } = {}) {
    let delay = 500;
    while (!signal?.aborted) {
      try {
        await this.ready();
        if (signal?.aborted) break;
        if (transport === 'http') { await this.read(onMessage); await pause(1000, signal); }
        else { await this.socket({ signal, onMessage, onStatus }); await pause(500, signal); }
        delay = 500;
      } catch (e) {
        if (signal?.aborted) break;
        if (['PARTICIPANT_REVOKED', 'SESSION_EXPIRED', 'NOT_FOUND', 'INVALID_SIGNATURE', 'INVALID_PUBLIC_KEY'].includes(e.code)) throw e;
        onStatus(e.message);
        await pause(delay, signal); delay = Math.min(delay * 2, 30000);
      }
    }
  }
  socket({ signal, onMessage, onStatus }) {
    if (signal?.aborted) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${this.state.base.replace(/^http/, 'ws')}/ws`);
      let queue = Promise.resolve(), failure;
      const stop = () => ws.close();
      signal?.addEventListener('abort', stop, { once: true });
      // Renew on a new connection before the short-lived credential expires.
      const renewal = setTimeout(stop, Math.max(1000, Date.parse(this.state.credential_expires_at) - Date.now() - 20000));
      ws.onopen = () => ws.send(JSON.stringify({ type: 'authenticate', token: this.state.credential }));
      ws.onmessage = event => {
        queue = queue.then(async () => {
          const frame = JSON.parse(event.data);
          if (frame.type === 'authenticated') { onStatus('Connected via WebSocket'); ws.send(JSON.stringify({ type: 'resume', after: this.state.cursor })); }
          else if (frame.type === 'message') await this.receive(frame, onMessage);
          else if (frame.type === 'error') { const e = new Error(`${frame.code}: ${frame.message}`); e.code = frame.code; throw e; }
          else if (frame.type === 'session') onStatus(`Session ${frame.status}`);
        }).catch(e => { failure = e; ws.close(); });
      };
      ws.onerror = () => { failure ||= new Error('WebSocket connection failed. Try --transport http if persistent sockets are unavailable.'); };
      ws.onclose = async () => { clearTimeout(renewal); signal?.removeEventListener('abort', stop); await queue; failure ? reject(failure) : resolve(); };
    });
  }
}
function pause(ms, signal) {
  return new Promise(resolve => {
    const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, ms); signal?.addEventListener('abort', finish, { once: true });
    if (signal?.aborted) finish();
  });
}
