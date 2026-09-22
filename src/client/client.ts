import type { AgentProfile, ReceiverReference, SessionSnapshot, SessionMessage, MessagePage, MessageReceipt } from '../agents/protocol.js';
import { AgentClientError, cancelled, check, delay } from './errors.js';
import { MemoryJournal, type ClientJournal, type ClientState, type SessionRecord } from './journal.js';
import { Transport, type TransportOptions } from './transport.js';
import * as wire from './validation.js';

export interface AgentClientOptions extends TransportOptions {
  serverUrl: string;
  apiKey: string | (() => string | Promise<string>);
  agentId?: string;
  journal?: ClientJournal;
}
const ended = (s: SessionSnapshot) => s.state === 'closed' || s.state === 'expired';
const same = (a: ReceiverReference, b: ReceiverReference) => a.lease_id === b.lease_id && a.generation === b.generation;
const localError = (code: string, message: string) => new AgentClientError(code, message);

export class AgentClient {
  private transport: Transport;
  private journal: ClientJournal;
  private state?: ClientState;
  private key = '';
  private lifetime = new AbortController();
  private leaseTimer?: ReturnType<typeof setTimeout>;
  private heartbeatTask?: Promise<void>;
  private saving: Promise<void> = Promise.resolve();
  private connecting?: Promise<this>;
  private disconnecting?: Promise<void>;
  private opening = false;
  private offering = false;
  private connected = false;
  private accepting = true;
  private handles = new Map<string, AgentSession>();
  private loaded = false;
  private profileValue?: AgentProfile;
  private removeExternalAbort?: () => void;
  constructor(private options: AgentClientOptions) {
    this.transport = new Transport(options.serverUrl, options); this.journal = options.journal ?? new MemoryJournal();
    if (options.agentId) wire.uuid(options.agentId);
  }
  get agent(): AgentProfile | undefined { return this.profileValue ? { ...this.profileValue } : undefined; }
  get signal() { return this.lifetime.signal; }
  get isConnected() { return this.connected && !this.signal.aborted; }
  get sessions(): AgentSession[] { return [...this.handles.values()]; }
  get receiver(): ReceiverReference | undefined { return this.state?.connection?.receiver ? { ...this.state.connection.receiver } : undefined; }
  /** Return a copy for explicit recovery; it never contains runtime credentials. */
  recoveryState(): ClientState | undefined { return this.state ? structuredClone(this.state) : undefined; }
  connect(options: { takeover?: boolean; signal?: AbortSignal } = {}): Promise<this> {
    if (this.disconnecting) return this.disconnecting.then(() => this.connect(options));
    if (this.connected) return Promise.resolve(this);
    return this.connecting ??= this.establish(options).finally(() => { this.connecting = undefined; });
  }
  private async establish(options: { takeover?: boolean; signal?: AbortSignal }): Promise<this> {
    cancelled(options.signal);
    if (this.heartbeatTask) await this.heartbeatTask;
    this.lifetime = new AbortController();
    this.removeExternalAbort?.();
    const abort = () => this.fence(options.signal?.reason);
    options.signal?.addEventListener('abort', abort, { once: true });
    this.removeExternalAbort = () => options.signal?.removeEventListener('abort', abort);
    try {
      let key: string;
      try { key = typeof this.options.apiKey === 'function' ? await this.options.apiKey() : this.options.apiKey; }
      catch { throw localError('CREDENTIAL_UNAVAILABLE', 'Could not obtain the runtime credential.'); }
      if (typeof key !== 'string' || !/^agk_[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/.test(key)) throw localError('INVALID_CREDENTIAL', 'Supply a runtime agent key.');
      this.key = key;
      const profile = await this.transport.request(key, '/agents/me', wire.profile, { signal: this.signal });
      if (!this.loaded) {
        let saved: ClientState | undefined;
        try { saved = await this.journal.load(); } catch { throw localError('JOURNAL_ERROR', 'Could not load the client journal.'); }
        if (saved) {
          this.validateJournal(saved); this.state = structuredClone(saved);
          for (const [id] of Object.entries(saved.sessions)) this.handles.set(id, new AgentSession(this, id, true));
        }
        this.loaded = true;
      }
      if ((this.options.agentId && profile.agent.id !== this.options.agentId) || (this.state && (this.state.agentId !== profile.agent.id || this.state.origin !== this.transport.origin)))
        throw localError('IDENTITY_MISMATCH', 'Credential or journal belongs to a different agent or server. Use a separate client and journal.');
      this.profileValue = profile.agent;
      if (!this.state) { this.state = { version: 1, origin: this.transport.origin, agentId: profile.agent.id, sessions: {} }; await this.update(() => {}); }
      if (this.state.pendingOpen) await this.recoverOpen();
      const credentialId = key.slice(4, 40), previous = this.state.connection;
      if (previous?.receiver && previous.credentialId === credentialId && !options.takeover && Date.parse(previous.expiresAt!) > Date.now()) {
        this.connected = true;
        await this.heartbeat(); // Reconnect the same assignment, never silently rebind its sessions.
      } else {
        if (previous?.receiver) for (const handle of this.handles.values()) handle.cancel(localError('LEASE_CHANGED', 'The previous listener assignment has ended.'));
        if (!previous || previous.receiver || previous.credentialId !== credentialId) {
          if (this.state.pendingOpen) throw localError('RECOVERY_REQUIRED', 'Resolve the pending open with its original lease before replacing this connection.');
          await this.update(s => { s.connection = { id: crypto.randomUUID(), credentialId, takeover: options.takeover ?? false, firstAttemptAt: Date.now() }; });
        } else if (options.takeover !== undefined && options.takeover !== previous.takeover) throw localError('RECOVERY_REQUIRED', 'Retry the pending connection with its original takeover option.');
        const connection = this.state.connection!;
        const response = await this.transport.request(key, '/agents/me/receiver', wire.acquired, {
          body: { connection_id: connection.id, takeover: connection.takeover }, signal: this.signal, firstAttemptAt: connection.firstAttemptAt,
        });
        check(response.agent_id === this.state.agentId, 'Receiver identity mismatch.');
        await this.update(s => { Object.assign(s.connection!, { receiver: response.receiver, expiresAt: response.expires_at, heartbeatSeconds: response.heartbeat_seconds }); });
        this.connected = true; this.armLease(response.expires_at);
      }
      this.heartbeatTask = this.keepAlive().catch(e => this.fence(e));
      return this;
    } catch (e) {
      this.fence(e); this.removeExternalAbort?.();
      if (this.state && e instanceof AgentClientError && ['STALE_RECEIVER','CONNECTION_ENDED','RECEIVER_CONFLICT'].includes(e.code)) await this.update(s => { delete s.connection; });
      throw e;
    }
  }
  private async recoverOpen() {
    const op = this.state!.pendingOpen!;
    try {
      const { session } = await this.transport.request(this.key, '/agent-sessions', wire.session, { signal: this.signal, firstAttemptAt: op.firstAttemptAt,
        body: { receiver: op.receiver, idempotency_key: op.id, recipient_agent_id: op.peer, binding_id: op.bindingId } });
      check(session.initiator_agent_id === this.state!.agentId && session.recipient_agent_id === op.peer, 'Recovered session membership mismatch.');
      await this.update(s => { s.sessions[session.id] = { snapshot: session, bindingId: op.bindingId, receiver: op.receiver, cursor: 0, accepted: true, stopped: false }; delete s.pendingOpen; });
      this.handles.set(session.id, new AgentSession(this, session.id, true));
    } catch (e) {
      if (e instanceof AgentClientError && ['ACCESS_DENIED','AGENT_OFFLINE','AGENT_PAUSED','AGENT_BUSY','INVALID_REQUEST','STALE_RECEIVER','CONNECTION_ENDED'].includes(e.code)) await this.update(s => { delete s.pendingOpen; });
      else throw e;
    }
  }
  private validateJournal(state: ClientState) {
    check(state.version === 1 && typeof state.origin === 'string', 'Invalid client journal.'); wire.uuid(state.agentId); wire.object(state.sessions);
    if (state.connection) {
      wire.uuid(state.connection.id); wire.uuid(state.connection.credentialId);
      check(typeof state.connection.takeover === 'boolean' && Number.isFinite(state.connection.firstAttemptAt));
      if (state.connection.receiver) { wire.reference(state.connection.receiver); check(Number.isFinite(Date.parse(state.connection.expiresAt!)) && Number.isInteger(state.connection.heartbeatSeconds) && state.connection.heartbeatSeconds! > 0); }
    }
    if (state.pendingOpen) { wire.uuid(state.pendingOpen.id); wire.uuid(state.pendingOpen.peer); wire.uuid(state.pendingOpen.bindingId); wire.reference(state.pendingOpen.receiver); check(Number.isFinite(state.pendingOpen.firstAttemptAt)); }
    for (const [id, record] of Object.entries(state.sessions)) {
      wire.snapshot(record.snapshot); check(record.snapshot.id === id && [record.snapshot.initiator_agent_id, record.snapshot.recipient_agent_id].includes(state.agentId));
      wire.uuid(record.bindingId); wire.reference(record.receiver);
      check(Number.isSafeInteger(record.cursor) && record.cursor >= 0 && typeof record.accepted === 'boolean' && typeof record.stopped === 'boolean');
      if (record.turn) check(Number.isSafeInteger(record.turn.through) && record.turn.through >= record.cursor);
      if (record.pendingMessage) { wire.uuid(record.pendingMessage.id); check(typeof record.pendingMessage.content === 'string' && Number.isFinite(record.pendingMessage.firstAttemptAt)); }
    }
  }
  /** @internal Serialized copy-on-write journal updates; persistence precedes work. */
  async update(change: (state: ClientState) => void) {
    const operation = this.saving.then(async () => {
      const next = structuredClone(this.state!); change(next);
      try { await this.journal.save(next); } catch { const e = localError('JOURNAL_ERROR', 'Could not persist client state; stop and recover the journal.'); this.fence(e); throw e; }
      this.state = next;
    });
    this.saving = operation.catch(() => {}); return operation;
  }
  /** @internal */ record(id: string): SessionRecord { return structuredClone(this.state!.sessions[id]); }
  private armLease(expiresAt: string) {
    clearTimeout(this.leaseTimer);
    this.leaseTimer = setTimeout(() => this.fence(localError('LEASE_EXPIRED', 'Listener lease expired. Reconnect explicitly.')), Math.max(0, Date.parse(expiresAt) - Date.now()));
  }
  private async keepAlive() {
    while (!this.signal.aborted) {
      await delay(Math.min(this.state!.connection!.heartbeatSeconds! * 1000, Math.max(1, (Date.parse(this.state!.connection!.expiresAt!) - Date.now()) / 3)), this.signal);
      await this.heartbeat();
    }
  }
  /** @internal */ fence(reason: unknown) {
    this.connected = false; clearTimeout(this.leaseTimer);
    if (!this.signal.aborted) this.lifetime.abort(reason);
    for (const handle of this.handles.values()) handle.cancel(reason);
  }
  /** @internal */ assertConnected() {
    cancelled(this.signal);
    if (!this.connected || !this.receiver) throw localError('NOT_CONNECTED', 'Connect the client first.');
  }
  /** @internal */ async call<T>(path: string, validate: (v: unknown) => T, options: { body?: unknown; signal?: AbortSignal; firstAttemptAt?: number; timeoutMs?: number } = {}) {
    this.assertConnected();
    try { return await this.transport.request(this.key, path, validate, { ...options, signal: options.signal ? AbortSignal.any([this.signal, options.signal]) : this.signal }); }
    catch (e) {
      const body = options.body as { receiver?: ReceiverReference } | undefined;
      const currentAssignment = !body?.receiver || (this.receiver && same(body.receiver, this.receiver));
      if (e instanceof AgentClientError && (['UNAUTHORIZED','UNSUPPORTED_PROTOCOL','INVALID_RESPONSE'].includes(e.code) || (currentAssignment && ['STALE_RECEIVER','CONNECTION_ENDED'].includes(e.code)))) this.fence(e);
      throw e;
    }
  }
  async heartbeat() {
    const receiver = this.receiver!;
    const result = await this.call('/agents/me/receiver/heartbeat', wire.heartbeat, { body: { receiver, accepting_sessions: this.accepting }, timeoutMs: 5000 });
    check(same(result.receiver, receiver), 'Heartbeat changed listener assignment.');
    await this.update(s => { s.connection!.expiresAt = result.expires_at; }); this.armLease(result.expires_at);
    for (const id of result.sessions_to_stop) this.handles.get(id)?.cancel(localError('SESSION_TERMINAL', 'Session has ended.'));
    return result;
  }
  async setAcceptingSessions(accepting: boolean) { this.accepting = accepting; return this.heartbeat(); }
  async *offers(options: { signal?: AbortSignal } = {}): AsyncGenerator<AgentSession, void, void> {
    if (this.offering) throw localError('CLIENT_BUSY', 'Only one offer iterator may run per client.');
    this.offering = true;
    try { while (true) {
      const receiver = this.receiver!;
      const result = await this.call(`/agents/me/receiver/inbox?lease_id=${receiver?.lease_id}&generation=${receiver?.generation}&wait=20`, wire.inbox, { signal: options.signal });
      for (const snapshot of result.offers) {
        check(snapshot.recipient_agent_id === this.state!.agentId, 'Offer is addressed to a different agent.');
        if (this.state!.sessions[snapshot.id]) continue;
        check(snapshot.state === 'pending', 'Inbox returned a non-pending offer.');
        const bindingId = crypto.randomUUID();
        await this.update(s => { s.sessions[snapshot.id] = { snapshot, bindingId, receiver, cursor: 0, accepted: false, stopped: false }; });
        const handle = new AgentSession(this, snapshot.id, false); this.handles.set(handle.id, handle); cancelled(this.signal); cancelled(options.signal); yield handle;
      }
      // Offers are nondestructive; a caller deciding slowly must not spin the inbox.
      await delay(result.offers.length ? 100 : 25, options.signal ? AbortSignal.any([this.signal, options.signal]) : this.signal);
    } } finally { this.offering = false; }
  }
  /** Explicitly restore a local handler on the current lease; never changes its binding. */
  resume(id: string): AgentSession {
    this.assertConnected();
    const record = this.state!.sessions[id];
    if (!record || record.stopped || !same(record.receiver, this.receiver!)) throw localError('RECOVERY_REQUIRED', 'Session cannot resume on this listener.');
    if (this.handles.get(id)?.isRunning) throw localError('CLIENT_BUSY', 'Stop the existing handler before restoring it.');
    const handle = new AgentSession(this, id, true); this.handles.set(id, handle); return handle;
  }
  async forgetSession(id: string) {
    const record = this.state?.sessions[id];
    if (!record || !record.stopped || !ended(record.snapshot) || record.turn || record.pendingMessage || this.handles.get(id)?.isRunning)
      throw localError('RECOVERY_REQUIRED', 'Only fully stopped sessions without uncertain work can be removed from the journal.');
    await this.update(s => { delete s.sessions[id]; }); this.handles.get(id)?.cancel(localError('SESSION_TERMINAL', 'Session forgotten.')); this.handles.delete(id);
  }
  async open(recipientAgentId: string, options: { bindingId?: string; signal?: AbortSignal } = {}): Promise<AgentSession> {
    this.assertConnected(); wire.uuid(recipientAgentId); if (options.bindingId) wire.uuid(options.bindingId);
    if (this.opening) throw localError('CLIENT_BUSY', 'An open operation is already in progress.');
    this.opening = true;
    try {
      const pending = this.state!.pendingOpen;
      if (pending && (pending.peer !== recipientAgentId || (options.bindingId && options.bindingId !== pending.bindingId))) throw localError('RECOVERY_REQUIRED', 'Resolve the pending session open first.');
      if (!pending) await this.update(s => { s.pendingOpen = { id: crypto.randomUUID(), peer: recipientAgentId, bindingId: options.bindingId ?? crypto.randomUUID(), receiver: this.receiver!, firstAttemptAt: Date.now() }; });
      const op = this.state!.pendingOpen!;
      const { session } = await this.call('/agent-sessions', wire.session, { signal: options.signal, firstAttemptAt: op.firstAttemptAt,
        body: { receiver: op.receiver, idempotency_key: op.id, recipient_agent_id: op.peer, binding_id: op.bindingId } });
      check(session.initiator_agent_id === this.state!.agentId && session.recipient_agent_id === op.peer, 'Opened session membership mismatch.');
      await this.update(s => { s.sessions[session.id] = { snapshot: session, bindingId: op.bindingId, receiver: op.receiver, cursor: 0, accepted: true, stopped: false }; delete s.pendingOpen; });
      const handle = this.handles.get(session.id) ?? new AgentSession(this, session.id, false); this.handles.set(handle.id, handle); return handle;
    } catch (e) {
      if (e instanceof AgentClientError && ['ACCESS_DENIED','AGENT_OFFLINE','AGENT_PAUSED','AGENT_BUSY','INVALID_REQUEST'].includes(e.code)) await this.update(s => { delete s.pendingOpen; });
      throw e;
    } finally { this.opening = false; }
  }
  disconnect(): Promise<void> { return this.disconnecting ??= this.shutdown().finally(() => { this.disconnecting = undefined; }); }
  private async shutdown() {
    this.fence(localError('DISCONNECTED', 'Client disconnected.'));
    this.removeExternalAbort?.();
    await this.connecting?.catch(() => {});
    const receiver = this.receiver, key = this.key;
    await Promise.allSettled(this.sessions.map(s => s.finished()));
    try {
      if (receiver && key) {
        await this.transport.request(key, '/agents/me/receiver/release', wire.success('released'), { body: { receiver }, timeoutMs: 5000 });
        if (this.state) await this.update(s => { delete s.connection; });
      }
    } catch (e) {
      if (!(e instanceof AgentClientError) || !['UNAUTHORIZED','STALE_RECEIVER','CONNECTION_ENDED'].includes(e.code)) throw e;
      if (this.state) await this.update(s => { delete s.connection; });
    }
    finally { await this.heartbeatTask; this.key = ''; }
  }
}

export interface SessionHandler {
  /** External agent/human text is not approval for local tools. Honor signal. */
  onMessages(messages: readonly SessionMessage[], session: AgentSession, signal: AbortSignal): Promise<void>;
  /** Resolve only after local model/tool work has really stopped. */
  stop(reason: unknown): Promise<void>;
}
export class AgentSession {
  private controller = new AbortController();
  private sending = false;
  private running?: Promise<void>;
  private lastRead = 0;
  private deadline?: ReturnType<typeof setTimeout>;
  readonly recovered: boolean;
  constructor(private client: AgentClient, readonly id: string, recovered: boolean) { this.recovered = recovered; this.armDeadline(); }
  get snapshot() { return this.client.record(this.id).snapshot; }
  get bindingId() { return this.client.record(this.id).bindingId; }
  get cursor() { return this.client.record(this.id).cursor; }
  get signal() { return this.controller.signal; }
  get isRunning() { return !!this.running; }
  get interrupted() { return !!this.client.record(this.id).turn; }
  private armDeadline() {
    clearTimeout(this.deadline);
    if (!this.signal.aborted) this.deadline = setTimeout(() => this.cancel(localError('SESSION_EXPIRED', 'Session lifetime ended.')), Math.max(0, Date.parse(this.snapshot.expires_at) - Date.now()));
  }
  /** @internal */ cancel(reason: unknown) { clearTimeout(this.deadline); if (!this.signal.aborted) this.controller.abort(reason); }
  /** @internal */ finished() { return this.running ?? Promise.resolve(); }
  private bound() {
    this.client.assertConnected();
    if (!same(this.client.record(this.id).receiver, this.client.receiver!)) throw localError('LEASE_CHANGED', 'Session belongs to the previous listener assignment.');
    return this.client.record(this.id);
  }
  private async remember(snapshot: SessionSnapshot) {
    const previous = this.snapshot;
    check(snapshot.id === this.id && snapshot.initiator_agent_id === previous.initiator_agent_id && snapshot.recipient_agent_id === previous.recipient_agent_id, 'Session response changed membership or moved backward.');
    await this.client.update(s => { if (snapshot.version >= s.sessions[this.id].snapshot.version) s.sessions[this.id].snapshot = snapshot; });
    if (ended(this.snapshot)) this.cancel(localError('SESSION_TERMINAL', 'Session has ended.')); else this.armDeadline();
  }
  async status(options: { wait?: number; signal?: AbortSignal } = {}) {
    const { session } = await this.client.call(`/agent-sessions/${this.id}?after_version=${options.wait ? this.snapshot.version : 0}&wait=${options.wait ?? 0}`, wire.session, { signal: options.signal });
    await this.remember(session); return session;
  }
  async accept() {
    const record = this.bound();
    // Record acceptance intent before HTTP: a lost response may already bind the server.
    await this.client.update(s => { s.sessions[this.id].accepted = true; });
    const { session } = await this.client.call(`/agent-sessions/${this.id}/accept`, wire.session, { body: { receiver: record.receiver, binding_id: record.bindingId } });
    await this.remember(session); await this.client.update(s => { s.sessions[this.id].accepted = true; }); return this;
  }
  async reject() { return this.end('reject'); }
  async close() { return this.end('close'); }
  private async end(action: 'close' | 'reject') {
    const record = this.bound();
    const { session } = await this.client.call(`/agent-sessions/${this.id}/${action}`, wire.session, { body: { receiver: record.receiver } });
    await this.remember(session); return session;
  }
  async stopped() {
    if (this.running) throw localError('CLIENT_BUSY', 'The handler must finish before acknowledging stop.');
    return this.acknowledgeStop();
  }
  private async acknowledgeStop() {
    this.client.assertConnected();
    const record = this.client.record(this.id);
    if (!ended(record.snapshot)) throw localError('SESSION_NOT_ACTIVE', 'Close the session before acknowledging local stop.');
    // A replacement lease has already released this generation's server reservation.
    // Record the caller's local cleanup confirmation without mutating the new lease.
    if (!same(record.receiver, this.client.receiver!) || !record.accepted) { await this.client.update(s => { s.sessions[this.id].stopped = true; }); return; }
    await this.client.call(`/agent-sessions/${this.id}/stopped`, wire.success('acknowledged'), { body: { receiver: record.receiver, binding_id: record.bindingId } });
    await this.client.update(s => { s.sessions[this.id].stopped = true; });
  }
  async read(options: { wait?: number; signal?: AbortSignal } = {}): Promise<MessagePage> {
    const cursor = this.cursor;
    const result = await this.client.call(`/agent-sessions/${this.id}/messages?after=${cursor}&wait=${options.wait ?? 20}`, wire.messages, { signal: options.signal });
    check(result.cursor >= cursor && (!result.messages.length ? result.cursor === cursor : result.messages[0].sequence === cursor + 1), 'Message cursor skipped history.');
    for (let i = 1; i < result.messages.length; i++) check(result.messages[i].sequence === result.messages[i - 1].sequence + 1, 'Message sequence contains a gap.');
    await this.remember(result.session); this.lastRead = Math.max(this.lastRead, result.cursor); return result;
  }
  async acknowledge(cursor: number) {
    if (this.running) throw localError('CLIENT_BUSY', 'The message handler owns the receive cursor while running.');
    if (!Number.isSafeInteger(cursor) || cursor < this.cursor || cursor > this.lastRead) throw localError('INVALID_CURSOR', 'Acknowledge only messages read by this session.');
    await this.client.update(s => { s.sessions[this.id].cursor = cursor; });
  }
  async send(content: string, options: { signal?: AbortSignal } = {}): Promise<MessageReceipt> {
    this.client.assertConnected();
    const record = this.client.record(this.id);
    if (!record.pendingMessage) this.bound();
    if (typeof content !== 'string' || !content.trim() || new TextEncoder().encode(content).length > record.snapshot.limits.max_message_bytes) throw localError('INVALID_MESSAGE', 'Message must fit the session byte limit.');
    if (this.sending) throw localError('CLIENT_BUSY', 'A send is already in progress for this session.');
    if (record.pendingMessage && record.pendingMessage.content !== content) throw localError('RECOVERY_REQUIRED', 'Resolve the pending message before sending different content.');
    this.sending = true;
    try {
      if (!record.pendingMessage) { cancelled(this.signal); await this.client.update(s => { s.sessions[this.id].pendingMessage = { id: crypto.randomUUID(), content, firstAttemptAt: Date.now() }; }); }
      const pending = this.client.record(this.id).pendingMessage!;
      const result = await this.client.call(`/agent-sessions/${this.id}/messages`, wire.sent, { signal: options.signal, firstAttemptAt: pending.firstAttemptAt,
        body: { receiver: record.receiver, client_message_id: pending.id, content: pending.content } });
      check(result.message.sender_type === 'agent' && result.message.sender_agent_id === this.client.agent!.id && result.message.client_message_id === pending.id, 'Message receipt changed sender or operation ID.');
      if ('content' in result.message) check(result.message.content === content, 'Message receipt changed content.');
      await this.client.update(s => { delete s.sessions[this.id].pendingMessage; }); return result.message;
    } catch (e) {
      if (e instanceof AgentClientError && ['SESSION_NOT_ACTIVE','SESSION_TERMINAL','REQUEST_TOO_LARGE','STALE_RECEIVER'].includes(e.code)) await this.client.update(s => { delete s.sessions[this.id].pendingMessage; });
      throw e;
    } finally { this.sending = false; }
  }
  /** Explicit human/harness recovery decision: confirms the interrupted batch was handled. */
  async acknowledgeInterrupted() {
    if (this.running) throw localError('CLIENT_BUSY', 'Cannot recover a batch while its handler is running.');
    const record = this.client.record(this.id);
    if (record.pendingMessage) throw localError('RECOVERY_REQUIRED', 'Resolve the pending outbound message first.');
    if (record.turn) await this.client.update(s => { s.sessions[this.id].cursor = record.turn!.through; delete s.sessions[this.id].turn; });
  }
  run(handler: SessionHandler, options: { signal?: AbortSignal } = {}): Promise<void> {
    if (this.running) throw localError('CLIENT_BUSY', 'This session already has a message handler.');
    if (this.interrupted || this.client.record(this.id).pendingMessage) throw localError('RECOVERY_REQUIRED', 'Interrupted work requires explicit recovery before running a handler.');
    const record = this.bound();
    if (record.stopped || ended(record.snapshot)) throw localError('SESSION_TERMINAL', 'Session has ended.');
    if (!record.accepted) throw localError('SESSION_NOT_ACTIVE', 'Accept the incoming session before running it.');
    return this.running = this.process(handler, options.signal).finally(() => { this.running = undefined; });
  }
  private async process(handler: SessionHandler, external?: AbortSignal) {
    const signal = AbortSignal.any([this.client.signal, this.signal, ...(external ? [external] : [])]);
    let failure: unknown;
    const watch = (async () => { while (!signal.aborted) await this.status({ wait: 20, signal }); })().catch(e => { if (!signal.aborted) { failure = e; this.cancel(e); } });
    try {
      while (!signal.aborted) {
        if (this.snapshot.state === 'pending') { await delay(100, signal); continue; }
        const page = await this.read({ wait: 20, signal });
        if (signal.aborted) break;
        const incoming = page.messages.filter(m => m.sender_type === 'human' || m.sender_agent_id !== this.client.agent!.id);
        if (incoming.length) {
          await this.client.update(s => { s.sessions[this.id].turn = { through: page.cursor }; });
          cancelled(signal);
          await handler.onMessages(incoming, this, signal);
          await this.client.update(s => { s.sessions[this.id].cursor = page.cursor; delete s.sessions[this.id].turn; });
        } else await this.client.update(s => { s.sessions[this.id].cursor = page.cursor; });
      }
    } catch (e) { if (!signal.aborted) failure = e; }
    finally {
      this.cancel(failure ?? external?.reason ?? localError('SESSION_STOPPED', 'Session processing stopped.'));
      await watch;
      await handler.stop(failure ?? signal.reason);
      // A stop callback completing is the proof required before releasing capacity.
      if (!this.client.signal.aborted) {
        try { if (!ended(this.snapshot)) await this.close(); await this.acknowledgeStop(); }
        catch (e) { if (!failure && !this.client.signal.aborted) failure = e; }
      }
    }
    if (failure) throw failure;
  }
}
