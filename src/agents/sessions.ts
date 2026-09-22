import { SessionEngine } from '../session-engine.js';
import { createHash } from 'node:crypto';
import { one, type Database, type Queryable } from '../db.js';
import { exactFields, HttpError, integer, requireThat, uuid } from '../validation.js';
import { agentId, type AgentPrincipal } from './identity.js';
import type { AgentPolicyService } from './policies.js';
import { DEFAULT_AGENT_LIMITS, receiverReference, type ReceiverService } from './receivers.js';
import { closeAgentSession } from './session-lifecycle.js';
import { AGENT_FRIENDS_PROTOCOL as protocol, type CloseReason, type ReceiverReference, type SessionLimits, type SessionState } from './protocol.js';

export const TRANSCRIPT_MS = 86400000, SESSION_RETENTION_MS = 7 * TRANSCRIPT_MS;
interface SessionRow {
  id: string; initiator_agent_id: string; recipient_agent_id: string; state: SessionState; version: number;
  created_at: Date; offer_expires_at: Date; expires_at: Date; idle_expires_at: Date | null;
  closed_at: Date | null; close_reason: CloseReason | null; limits_json: SessionLimits; history_purged_at: Date | null;
}
interface Binding extends ReceiverReference { agent_id: string; participant_id: string; binding_id: string | null; stopped_at: Date | null }
interface Lease extends ReceiverReference { credential_id: string; accepting_sessions: boolean }
interface Receipt { id: string; sequence: number; sender_agent_id: string; client_message_id: string; created_at: Date;
  fingerprint: string; lease_id: string; generation: string; content: string | null }
const snapshot = ({ limits_json, history_purged_at: _purged, ...s }: SessionRow) => ({ ...s, limits: limits_json });
const fingerprint = (parts: unknown[]) => createHash('sha256').update(JSON.stringify(parts), 'utf8').digest('hex');
const idInput = (v: unknown) => { requireThat(typeof v === 'string', 'INVALID_REQUEST', 'Expected a UUID.'); return agentId(v); };
type SessionActor = AgentPrincipal | { owner_id: string };
const terminal = (s: SessionRow) => s.state === 'closed' || s.state === 'expired';

export class AgentSessionService {
  get waiters() { return this.engine.waiters; }
  constructor(readonly db: Database, private receivers: ReceiverService, private policies: AgentPolicyService,
    private clock = Date.now, private log: (event: string, fields: Record<string, unknown>) => void = () => {}, readonly engine = new SessionEngine()) {}
  notify(id: string) { this.engine.notify(id); }
  private changed(id: string) { this.notify(id); this.receivers.notify(); }
  shutdown() { this.engine.shutdown(); }
  private async auth(tx: Queryable, p: SessionActor) {
    if ('owner_id' in p) {
      requireThat(await one(tx, 'SELECT id FROM owners WHERE id=$1 AND disabled_at IS NULL', [p.owner_id]), 'OWNER_UNAUTHORIZED', 'Sign in to continue.', 401);
      return;
    }
    const valid = await one(tx, `SELECT c.id FROM agent_credentials c JOIN agents a ON a.id=c.agent_id JOIN owners o ON o.id=a.owner_id
      WHERE c.id=$1 AND a.id=$2 AND c.revoked_at IS NULL AND a.disabled_at IS NULL AND o.disabled_at IS NULL`, [p.credential_id, p.agent_id]);
    requireThat(valid, 'UNAUTHORIZED', 'Invalid agent credential.', 401);
  }
  private async row(tx: Queryable, id: string, lock = false) {
    const s = await one<SessionRow>(tx, `SELECT * FROM agent_sessions WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [id]);
    requireThat(s, 'NOT_FOUND', 'Session not found.', 404); return s;
  }
  private async member(tx: Queryable, s: SessionRow, p: SessionActor) {
    if ('owner_id' in p) {
      requireThat(await one(tx, 'SELECT id FROM agents WHERE id IN ($1,$2) AND owner_id=$3', [s.initiator_agent_id, s.recipient_agent_id, p.owner_id]), 'NOT_FOUND', 'Session not found.', 404);
    } else requireThat(p.agent_id === s.initiator_agent_id || p.agent_id === s.recipient_agent_id, 'NOT_FOUND', 'Session not found.', 404);
  }
  private async binding(tx: Queryable, id: string, agent: string) {
    const b = await one<Binding>(tx, `SELECT agent_id,participant_id,binding_id,lease_id,generation::text,stopped_at
      FROM agent_session_bindings WHERE session_id=$1 AND agent_id=$2`, [id, agent]);
    requireThat(b, 'NOT_FOUND', 'Session not found.', 404); return b;
  }
  private same(b: ReceiverReference, r: ReceiverReference) {
    requireThat(b.lease_id === r.lease_id && b.generation === r.generation, 'STALE_RECEIVER', 'Session belongs to another listener.', 409);
  }
  private async bound(tx: Queryable, s: SessionRow, p: AgentPrincipal, r: ReceiverReference) {
    const b = await this.binding(tx, s.id, p.agent_id); this.same(b, r);
    await this.receivers.requireCurrent(tx, p, r); return b;
  }
  private async live(tx: Queryable, agent: string) {
    return one<Lease>(tx, `SELECT r.lease_id,r.generation::text,r.credential_id,r.accepting_sessions FROM agent_receivers r
      JOIN agent_credentials c ON c.id=r.credential_id JOIN agents a ON a.id=r.agent_id JOIN owners o ON o.id=a.owner_id
      WHERE r.agent_id=$1 AND r.ended_at IS NULL AND r.expires_at>$2 AND c.revoked_at IS NULL AND a.disabled_at IS NULL AND o.disabled_at IS NULL`, [agent, new Date(this.clock())]);
  }
  private async reconcile(tx: Queryable, s: SessionRow) {
    if (terminal(s)) return s;
    const now = this.clock();
    let reason: CloseReason | undefined;
    let expired = false;
    if (s.expires_at.getTime() <= now) { reason = 'LIFETIME_EXCEEDED'; expired = true; }
    else if (s.state === 'pending' && s.offer_expires_at.getTime() <= now) { reason = 'OFFER_TIMEOUT'; expired = true; }
    else if (s.idle_expires_at && s.idle_expires_at.getTime() <= now) { reason = 'IDLE_TIMEOUT'; expired = true; }
    else {
      for (const id of [s.initiator_agent_id, s.recipient_agent_id]) {
        const b = await this.binding(tx, s.id, id), r = await this.live(tx, id);
        if (!r || r.lease_id !== b.lease_id || r.generation !== b.generation) { reason = 'RECEIVER_LOST'; break; }
      }
    }
    if (reason) { await closeAgentSession(tx, s.id, reason, new Date(now), expired); return this.row(tx, s.id); }
    return s;
  }
  /** All session operations acquire agent locks before the session lock. Expected
   * rejections commit lifecycle reconciliation; unexpected DB failures roll back. */
  private async run<T>(p: SessionActor, id: string, mutate: boolean, fn: (tx: Queryable, s: SessionRow) => Promise<T>) {
    id = agentId(id);
    const result = await this.db.transaction(async tx => {
      const initial = await this.row(tx, id); await this.member(tx, initial, p);
      await this.policies.lockPair(tx, initial.initiator_agent_id, initial.recipient_agent_id);
      await this.auth(tx, p);
      const locked = await this.row(tx, id, true), s = await this.reconcile(tx, locked);
      const changed = mutate || s.version !== locked.version;
      try { return { value: await fn(tx, s), changed }; }
      catch (error) { if (error instanceof HttpError) return { error, changed }; throw error; }
    });
    if (result.changed) this.changed(id);
    if ('error' in result) throw result.error;
    return result.value;
  }
  async open(p: AgentPrincipal, body: unknown) {
    exactFields(body, ['receiver', 'idempotency_key', 'recipient_agent_id', 'binding_id']);
    const r = receiverReference(body.receiver), peer = idInput(body.recipient_agent_id), key = idInput(body.idempotency_key), binding = idInput(body.binding_id);
    const hash = fingerprint([peer, r.lease_id, r.generation, binding]);
    const result = await this.db.transaction(async tx => {
      await this.policies.lockPair(tx, p.agent_id, peer); await this.auth(tx, p);
      const old = await one<{ fingerprint: string; session_id: string }>(tx, 'SELECT fingerprint,session_id FROM agent_operations WHERE agent_id=$1 AND idempotency_key=$2', [p.agent_id, key]);
      if (old) {
        requireThat(old.fingerprint === hash, 'IDEMPOTENCY_CONFLICT', 'Operation ID was used with different input.', 409);
        const s = await this.reconcile(tx, await this.row(tx, old.session_id, true));
        return { replay: true, body: { protocol, session: snapshot(s) } };
      }
      await this.policies.requireAllowed(tx, p.agent_id, peer);
      await this.receivers.requireCurrent(tx, p, r);
      const recipient = await this.live(tx, peer);
      requireThat(recipient, 'AGENT_OFFLINE', 'Peer is offline.', 409);
      requireThat(recipient.accepting_sessions, 'AGENT_PAUSED', 'Peer is paused.', 409);
      for (const id of [p.agent_id, peer]) {
        const count = await one<{ n: string }>(tx, 'SELECT count(*)::text AS n FROM agent_session_bindings WHERE agent_id=$1 AND stopped_at IS NULL', [id]);
        requireThat(Number(count!.n) < DEFAULT_AGENT_LIMITS.max_concurrent_sessions, 'AGENT_BUSY', 'Agent capacity is reserved.', 409);
      }
      const id = uuid(), now = new Date(this.clock()), expires = new Date(now.getTime() + DEFAULT_AGENT_LIMITS.max_session_seconds * 1000);
      const { max_message_bytes, idle_timeout_seconds, max_session_seconds, message_budget } = DEFAULT_AGENT_LIMITS;
      const limits = { max_message_bytes, idle_timeout_seconds, max_session_seconds, message_budget };
      await tx.query('INSERT INTO sessions(id,owner_hash,created_at,expires_at,max_participants) VALUES($1,NULL,$2,$3,2)', [id, now, expires]);
      await tx.query(`INSERT INTO agent_sessions(id,initiator_agent_id,recipient_agent_id,state,created_at,offer_expires_at,expires_at,limits_json)
        VALUES($1,$2,$3,'pending',$4,$5,$6,$7)`, [id, p.agent_id, peer, now, new Date(now.getTime() + 30000), expires, limits]);
      for (const [agent, lease, localBinding] of [[p.agent_id, r, binding], [peer, recipient, null]] as const) {
        const participant = uuid();
        await tx.query('INSERT INTO participants(id,session_id,agent_id,joined_at) VALUES($1,$2,$3,$4)', [participant, id, agent, now]);
        await tx.query(`INSERT INTO agent_session_bindings(session_id,agent_id,participant_id,lease_id,generation,binding_id)
          VALUES($1,$2,$3,$4,$5,$6)`, [id, agent, participant, lease.lease_id, lease.generation, localBinding]);
      }
      await tx.query('INSERT INTO agent_operations(agent_id,idempotency_key,fingerprint,session_id) VALUES($1,$2,$3,$4)', [p.agent_id, key, hash, id]);
      return { replay: false, body: { protocol, session: snapshot(await this.row(tx, id)) } };
    });
    this.changed(result.body.session.id);
    if (!result.replay) this.log('agent.session.opened', { session_id: result.body.session.id });
    return result;
  }
  async accept(p: AgentPrincipal, id: string, body: unknown) {
    exactFields(body, ['receiver', 'binding_id']); const r = receiverReference(body.receiver), binding = idInput(body.binding_id);
    return this.run(p, id, true, async (tx, s) => {
      requireThat(p.agent_id === s.recipient_agent_id, 'ACCESS_DENIED', 'Only the recipient can accept.', 403);
      const b = await this.bound(tx, s, p, r);
      requireThat(!b.binding_id || b.binding_id === binding, 'BINDING_CONFLICT', 'Session is bound to another conversation.', 409);
      if (b.binding_id === binding) return { protocol, session: snapshot(s) };
      requireThat(!terminal(s), 'SESSION_TERMINAL', 'Session has ended.', 409);
      await this.policies.requireAllowed(tx, s.initiator_agent_id, s.recipient_agent_id);
      const now = this.clock();
      await tx.query('UPDATE agent_session_bindings SET binding_id=$3 WHERE session_id=$1 AND agent_id=$2', [id, p.agent_id, binding]);
      await tx.query("UPDATE agent_sessions SET state='active',idle_expires_at=$2,version=version+1 WHERE id=$1", [id, new Date(Math.min(s.expires_at.getTime(), now + s.limits_json.idle_timeout_seconds * 1000))]);
      await tx.query("UPDATE sessions SET status='ACTIVE' WHERE id=$1", [id]);
      return { protocol, session: snapshot(await this.row(tx, id)) };
    });
  }
  async close(p: AgentPrincipal, id: string, body: unknown, reject = false) {
    exactFields(body, ['receiver']); const r = receiverReference(body.receiver);
    return this.run(p, id, true, async (tx, s) => {
      await this.bound(tx, s, p, r);
      if (reject) {
        requireThat(p.agent_id === s.recipient_agent_id, 'ACCESS_DENIED', 'Only the recipient can reject.', 403);
        requireThat(s.state !== 'active', 'SESSION_NOT_ACTIVE', 'An accepted session must be closed instead.', 409);
      }
      await closeAgentSession(tx, id, reject ? 'REJECTED' : 'COMPLETED', new Date(this.clock()));
      return { protocol, session: snapshot(await this.row(tx, id)) };
    });
  }
  async stoppedAck(p: AgentPrincipal, id: string, body: unknown) {
    exactFields(body, ['receiver', 'binding_id']); const r = receiverReference(body.receiver), binding = idInput(body.binding_id);
    return this.run(p, id, true, async (tx, s) => {
      const b = await this.bound(tx, s, p, r);
      requireThat(b.binding_id === binding, 'BINDING_CONFLICT', 'Conversation binding does not match.', 409);
      requireThat(terminal(s), 'SESSION_NOT_ACTIVE', 'Close the session before acknowledging stop.', 409);
      await tx.query('UPDATE agent_session_bindings SET stopped_at=COALESCE(stopped_at,$3) WHERE session_id=$1 AND agent_id=$2', [id, p.agent_id, new Date(this.clock())]);
      return { protocol, acknowledged: true as const };
    });
  }
  async send(p: AgentPrincipal, id: string, body: unknown) {
    exactFields(body, ['receiver', 'client_message_id', 'content']); const r = receiverReference(body.receiver), clientId = idInput(body.client_message_id);
    requireThat(typeof body.content === 'string' && body.content.trim().length > 0, 'INVALID_REQUEST', 'content must be nonempty text.');
    const content = body.content, hash = fingerprint([content]);
    return this.run(p, id, true, async (tx, s) => {
      const b = await this.binding(tx, id, p.agent_id); this.same(b, r);
      const old = await one<Receipt>(tx, `SELECT r.id,r.sequence,r.sender_agent_id,r.client_message_id,r.created_at,r.fingerprint,r.lease_id,r.generation::text,m.content
        FROM agent_message_receipts r LEFT JOIN messages m ON m.id=r.id WHERE r.session_id=$1 AND r.participant_id=$2 AND r.client_message_id=$3`, [id, b.participant_id, clientId]);
      if (old) {
        this.same(old, r); requireThat(old.fingerprint === hash, 'IDEMPOTENCY_CONFLICT', 'Message ID was used with different content.', 409);
        const { fingerprint: _hash, lease_id: _lease, generation: _gen, content: text, ...message } = old;
        const purged = s.history_purged_at || (s.closed_at && s.closed_at.getTime() + TRANSCRIPT_MS <= this.clock());
        return { replay: true, body: { protocol, message: purged || text === null ? { ...message, sender_type: 'agent' as const, payload_expired: true as const } : { ...message, sender_type: 'agent' as const, content: text } } };
      }
      await this.bound(tx, s, p, r);
      requireThat(s.state === 'active', terminal(s) ? 'SESSION_TERMINAL' : 'SESSION_NOT_ACTIVE', 'Session is not active.', 409);
      requireThat(b.binding_id && !b.stopped_at, 'BINDING_CONFLICT', 'No active conversation binding.', 409);
      requireThat(Buffer.byteLength(content, 'utf8') <= s.limits_json.max_message_bytes, 'REQUEST_TOO_LARGE', 'Message exceeds session byte limit.', 413);
      const nextSequence = await this.engine.sequence(tx, id, true);
      if (nextSequence > s.limits_json.message_budget) {
        await closeAgentSession(tx, id, 'MESSAGE_BUDGET', new Date(this.clock()));
        throw new HttpError('SESSION_TERMINAL', 'Session message budget exhausted.', 409);
      }
      const now = new Date(this.clock());
      const { id: messageId, sequence } = await this.engine.append(tx, id, { participantId: b.participant_id, clientId, content, now });
      await tx.query(`INSERT INTO agent_message_receipts(session_id,participant_id,client_message_id,fingerprint,id,sequence,sender_agent_id,lease_id,generation,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [id, b.participant_id, clientId, hash, messageId, sequence, p.agent_id, r.lease_id, r.generation, now]);
      await tx.query('UPDATE agent_sessions SET idle_expires_at=$2,version=version+1 WHERE id=$1', [id, new Date(Math.min(s.expires_at.getTime(), now.getTime() + s.limits_json.idle_timeout_seconds * 1000))]);
      if (sequence === s.limits_json.message_budget) await closeAgentSession(tx, id, 'MESSAGE_BUDGET', now);
      return { replay: false, body: { protocol, message: { id: messageId, sequence, sender_agent_id: p.agent_id, sender_type: 'agent' as const, client_message_id: clientId, content, created_at: now } } };
    });
  }
  private async read(p: SessionActor, id: string, after: number, messages: boolean) {
    return this.run(p, id, false, async (tx, s) => {
      if (!messages) {
        requireThat(after <= s.version, 'INVALID_REQUEST', 'Version is ahead of session state.');
        return { body: { protocol, session: snapshot(s) }, ready: s.version > after || terminal(s) };
      }
      requireThat(!s.history_purged_at && !(s.closed_at && s.closed_at.getTime() + TRANSCRIPT_MS <= this.clock()), 'HISTORY_EXPIRED', 'Session transcript has expired.', 410);
      const nextSequence = await this.engine.sequence(tx, id);
      requireThat(after < nextSequence, 'INVALID_REQUEST', 'Cursor is ahead of session history.');
      const rows = (await this.engine.read(tx, id, after)).map(m => ({ id: m.id, sequence: m.sequence, sender_agent_id: m.sender_agent_id,
        sender_type: m.sender_owner_id ? 'human' as const : 'agent' as const, client_message_id: m.client_message_id, content: m.content, created_at: m.created_at }));
      return { body: { protocol, session: snapshot(s), messages: rows, cursor: rows.at(-1)?.sequence ?? after }, ready: rows.length > 0 || terminal(s) };
    });
  }
  async poll(p: SessionActor, id: string, after: number, wait: number, messages: boolean, signal?: AbortSignal) {
    integer(after, 0, 2147483647, 'cursor'); integer(wait, 0, 20, 'wait');
    // Authenticate/membership-check before allocating a waiter. Register before the next read to avoid lost wakeups.
    const first = await this.read(p, id, after, messages);
    if (first.ready || wait === 0) return first.body;
    return this.engine.poll(id, 'owner_id' in p ? `account:${p.owner_id}` : `agent:${p.agent_id}`, wait, async () => {
      const result = await this.read(p, id, after, messages); return { value: result.body, ready: result.ready };
    }, signal);
  }

  async ownerList(owner: string, after?: string, limit = 50) {
    await this.auth(this.db, { owner_id: owner });
    const rows = (await this.db.query<{ id: string; state: string; created_at: Date; initiator_name: string; recipient_name: string }>(`SELECT s.id,s.state,s.created_at,a.display_name AS initiator_name,b.display_name AS recipient_name
      FROM agent_sessions s JOIN agents a ON a.id=s.initiator_agent_id JOIN agents b ON b.id=s.recipient_agent_id
      WHERE (a.owner_id=$1 OR b.owner_id=$1) AND ($2::uuid IS NULL OR s.id>$2) ORDER BY s.id LIMIT $3`, [owner, after ?? null, limit + 1])).rows;
    return { sessions: rows.slice(0, limit), next_cursor: rows.length > limit ? rows[limit - 1].id : null };
  }
  async ownerRoom(owner: string, id: string) {
    return this.run({ owner_id: owner }, id, false, async (tx, s) => {
      const participants = (await tx.query<{ id: string; display_name: string }>('SELECT id,display_name FROM agents WHERE id IN ($1,$2) ORDER BY id', [s.initiator_agent_id, s.recipient_agent_id])).rows;
      return { status: s.state.toUpperCase(), expires_at: s.expires_at, max_participants: 2,
        participants: participants.map(p => ({ ...p, left_at: null, revoked_at: null })), invites: [] };
    });
  }
  async ownerMessages(owner: string, id: string, after: number, wait: number, signal?: AbortSignal) {
    const page = await this.poll({ owner_id: owner }, id, after, wait, true, signal);
    const room = await this.ownerRoom(owner, id);
    const messages = ('messages' in page ? page.messages : []) ?? [];
    return { messages: messages.map(m => ({ ...m, sender_id: m.sender_agent_id ?? 'owner' })),
      cursor: 'cursor' in page ? page.cursor : after, session_status: page.session.state, participants: room.participants };
  }
  async ownerSend(owner: string, id: string, body: unknown) {
    exactFields(body, ['content']);
    requireThat(typeof body.content === 'string' && body.content.trim().length > 0, 'INVALID_REQUEST', 'content must be nonempty text.');
    const content = body.content;
    return this.run({ owner_id: owner }, id, true, async (tx, s) => {
      requireThat(!terminal(s), 'SESSION_TERMINAL', 'Session has ended.', 409);
      requireThat(Buffer.byteLength(content) <= s.limits_json.max_message_bytes, 'REQUEST_TOO_LARGE', 'Message exceeds session byte limit.', 413);
      const next = await this.engine.sequence(tx, id, true);
      if (next > s.limits_json.message_budget) {
        await closeAgentSession(tx, id, 'MESSAGE_BUDGET', new Date(this.clock()));
        throw new HttpError('SESSION_TERMINAL', 'Session message budget exhausted.', 409);
      }
      const now = new Date(this.clock());
      const message = await this.engine.append(tx, id, { ownerId: owner, content, now });
      await tx.query('UPDATE agent_sessions SET version=version+1,idle_expires_at=$2 WHERE id=$1', [id,
        s.state === 'active' ? new Date(Math.min(s.expires_at.getTime(), now.getTime() + s.limits_json.idle_timeout_seconds * 1000)) : null]);
      if (message.sequence === s.limits_json.message_budget) await closeAgentSession(tx, id, 'MESSAGE_BUDGET', now);
      return { ...message, content, sender_id: 'owner', sender_type: 'human' };
    });
  }
  async ownerClose(owner: string, id: string) {
    return this.run({ owner_id: owner }, id, true, async (tx, s) => {
      await closeAgentSession(tx, id, 'COMPLETED', new Date(this.clock()));
      return { status: 'CLOSED', session: snapshot(await this.row(tx, s.id)) };
    });
  }
  async cleanup() {
    // Receiver cleanup runs first; reconcile every live session for deadline/lease loss.
    const rows = await this.db.query<{ id: string; initiator_agent_id: string; recipient_agent_id: string }>(`SELECT id,initiator_agent_id,recipient_agent_id FROM agent_sessions
      WHERE state IN ('pending','active') OR closed_at<=$1 ORDER BY id`, [new Date(this.clock() - TRANSCRIPT_MS)]);
    for (const item of rows.rows) {
      const changed = await this.db.transaction(async tx => {
        await this.policies.lockPair(tx, item.initiator_agent_id, item.recipient_agent_id);
        const initial = await one<SessionRow>(tx, 'SELECT * FROM agent_sessions WHERE id=$1 FOR UPDATE', [item.id]);
        if (!initial) return false;
        const s = await this.reconcile(tx, initial), now = this.clock();
        if (s.closed_at && s.closed_at.getTime() + SESSION_RETENTION_MS <= now) {
          await this.engine.remove(tx, s.id); return true;
        }
        if (s.closed_at && !s.history_purged_at && s.closed_at.getTime() + TRANSCRIPT_MS <= now) {
          await this.engine.purgeTranscript(tx, s.id);
          await tx.query('UPDATE agent_sessions SET history_purged_at=$2 WHERE id=$1', [s.id, new Date(now)]); return true;
        }
        return s.version !== initial.version;
      });
      if (changed) this.changed(item.id);
    }
  }
}
