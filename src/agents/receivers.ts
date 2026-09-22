import { closeAgentSession } from './session-lifecycle.js';
import { one, type Database, type Queryable } from '../db.js';
import { exactFields, HttpError, integer, requireThat, uuid } from '../validation.js';
import { agentId, type AgentPrincipal, type IdentityInvalidation } from './identity.js';
import { AGENT_FRIENDS_PROTOCOL as protocol, type AgentLimits, type Availability, type ReceiverReference, type SessionSnapshot } from './protocol.js';

export const LEASE_MS = 30_000;
export const CONNECTION_RETENTION_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_AGENT_LIMITS: Readonly<AgentLimits> = Object.freeze({
  inbound_sessions_per_hour: 10, max_concurrent_sessions: 1, messages_per_minute: 60,
  max_message_bytes: 32768, idle_timeout_seconds: 600, max_session_seconds: 3600, message_budget: 1000,
});
interface Receiver extends ReceiverReference {
  agent_id: string; credential_id: string; expires_at: Date; ended_at: Date | null; accepting_sessions: boolean;
}
const receiverColumns = 'agent_id,lease_id,generation::text,credential_id,expires_at,ended_at,accepting_sessions';
export function receiverReference(value: unknown): ReceiverReference {
  exactFields(value, ['lease_id', 'generation']);
  requireThat(typeof value.lease_id === 'string', 'INVALID_REQUEST', 'lease_id must be a UUID.');
  requireThat(typeof value.generation === 'string' && /^[1-9][0-9]{0,18}$/.test(value.generation) && BigInt(value.generation) <= 9223372036854775807n,
    'INVALID_REQUEST', 'generation must be a positive bigint string.');
  return { lease_id: agentId(value.lease_id), generation: value.generation };
}
const ref = (r: Receiver): ReceiverReference => ({ lease_id: r.lease_id, generation: r.generation });

export class ReceiverService {
  readonly waiters = new Map<string, Set<() => void>>();
  private waiterTotal = 0;
  private closed = false;
  constructor(readonly db: Database, private clock = Date.now) {}
  notify() { for (const listeners of this.waiters.values()) for (const wake of listeners) wake(); }
  shutdown() { this.closed = true; this.notify(); }
  private async lock(tx: Queryable, id: string) { await tx.query('SELECT id FROM agents WHERE id=$1 FOR UPDATE', [id]); }
  private async authorized(tx: Queryable, p: AgentPrincipal) {
    const valid = await one(tx, `SELECT c.id FROM agent_credentials c JOIN agents a ON c.agent_id=a.id JOIN owners o ON a.owner_id=o.id
      WHERE c.id=$1 AND a.id=$2 AND c.revoked_at IS NULL AND a.disabled_at IS NULL AND o.disabled_at IS NULL`, [p.credential_id, p.agent_id]);
    requireThat(valid, 'UNAUTHORIZED', 'Invalid agent credential.', 401);
  }
  private current(tx: Queryable, id: string) { return one<Receiver>(tx, `SELECT ${receiverColumns} FROM agent_receivers WHERE agent_id=$1`, [id]); }
  /** Caller holds the agent row lock. Future admission locks both agents before binding. */
  private async end(tx: Queryable, r: Receiver, now: Date) {
    if (r.ended_at) return;
    await tx.query('UPDATE agent_receivers SET ended_at=$2,accepting_sessions=false WHERE agent_id=$1', [r.agent_id, now]);
    await tx.query('UPDATE agent_connections SET ended_at=$2 WHERE lease_id=$1 AND ended_at IS NULL', [r.lease_id, now]);
    // Lock shared sessions in deterministic order; do not take a peer's agent lock.
    const sessions = await tx.query<{ id: string }>(`SELECT s.id FROM agent_sessions s JOIN agent_session_bindings b ON b.session_id=s.id
      WHERE b.agent_id=$1 AND b.lease_id=$2 AND b.generation=$3 AND s.state IN ('pending','active') ORDER BY s.id FOR UPDATE OF s`,
      [r.agent_id, r.lease_id, r.generation]);
    for (const s of sessions.rows) {
      await closeAgentSession(tx, s.id, 'RECEIVER_LOST', now);
    }
    // Lost generation releases its own reservations. The still-online peer must
    // acknowledge stopping before its capacity can be reused (REN-10).
    await tx.query('UPDATE agent_session_bindings SET stopped_at=$4 WHERE agent_id=$1 AND lease_id=$2 AND generation=$3 AND stopped_at IS NULL',
      [r.agent_id, r.lease_id, r.generation, now]);
    r.ended_at = now;
  }
  private async expire(tx: Queryable, r: Receiver | undefined, now: Date) {
    if (r && !r.ended_at && r.expires_at.getTime() <= now.getTime()) await this.end(tx, r, now);
  }
  async invalidate(tx: Queryable, event: IdentityInvalidation) {
    // Identity mutations already hold the same agent lock.
    const r = await this.current(tx, event.agent_id);
    if (r && (event.kind === 'agent_disabled' || r.credential_id === event.credential_id)) await this.end(tx, r, new Date(this.clock()));
  }
  async acquire(p: AgentPrincipal, body: unknown) {
    exactFields(body, ['connection_id', 'takeover']);
    requireThat(typeof body.connection_id === 'string' && typeof body.takeover === 'boolean', 'INVALID_REQUEST', 'connection_id and takeover are required.');
    const connectionId = agentId(body.connection_id), takeover = body.takeover;
    const result = await this.db.transaction(async tx => {
      await this.lock(tx, p.agent_id); await this.authorized(tx, p);
      const now = new Date(this.clock()), current = await this.current(tx, p.agent_id);
      await this.expire(tx, current, now);
      const receipt = await one<{ lease_id: string; credential_id: string; takeover: boolean }>(tx,
        'SELECT lease_id,credential_id,takeover FROM agent_connections WHERE agent_id=$1 AND connection_id=$2', [p.agent_id, connectionId]);
      if (receipt) {
        if (receipt.credential_id !== p.credential_id || receipt.takeover !== takeover) return { error: 'IDEMPOTENCY_CONFLICT' } as const;
        if (!current || current.ended_at || current.lease_id !== receipt.lease_id) return { error: 'CONNECTION_ENDED' } as const;
        return { receiver: current, replay: true };
      }
      if (current && !current.ended_at) {
        if (!takeover) return { error: 'RECEIVER_CONFLICT' } as const;
        await this.end(tx, current, now);
      }
      const lease = uuid(), generation = String(BigInt(current?.generation ?? '0') + 1n);
      const receiver = (await one<Receiver>(tx, `INSERT INTO agent_receivers(agent_id,lease_id,generation,credential_id,expires_at,last_heartbeat_at,accepting_sessions)
        VALUES($1,$2,$3,$4,$5,$6,true) ON CONFLICT(agent_id) DO UPDATE SET lease_id=$2,generation=$3,credential_id=$4,expires_at=$5,last_heartbeat_at=$6,accepting_sessions=true,ended_at=NULL
        RETURNING ${receiverColumns}`, [p.agent_id, lease, generation, p.credential_id, new Date(now.getTime() + LEASE_MS), now]))!;
      await tx.query('INSERT INTO agent_connections(agent_id,connection_id,credential_id,lease_id,generation,takeover) VALUES($1,$2,$3,$4,$5,$6)',
        [p.agent_id, connectionId, p.credential_id, lease, generation, takeover]);
      return { receiver, replay: false };
    });
    this.notify();
    if ('error' in result) throw new HttpError(result.error!, 'Listener acquisition conflicts with an existing or ended connection.', 409);
    return { replay: result.replay, body: { protocol, agent_id: p.agent_id, receiver: ref(result.receiver), expires_at: result.receiver.expires_at,
      heartbeat_seconds: 10, limits: DEFAULT_AGENT_LIMITS } };
  }
  /** Use this guard inside future accept/send transactions, after agent locking. */
  async requireCurrent(tx: Queryable, p: AgentPrincipal, reference: ReceiverReference) {
    await this.authorized(tx, p);
    const r = await this.current(tx, p.agent_id);
    requireThat(r && !r.ended_at && r.expires_at.getTime() > this.clock() && r.credential_id === p.credential_id &&
      r.lease_id === reference.lease_id && r.generation === reference.generation, 'STALE_RECEIVER', 'Listener lease is no longer current.', 409);
    return r;
  }
  private async withReceiver<T>(p: AgentPrincipal, reference: ReceiverReference, fn: (tx: Queryable, r: Receiver) => Promise<T>) {
    const result = await this.db.transaction(async tx => {
      await this.lock(tx, p.agent_id);
      await this.expire(tx, await this.current(tx, p.agent_id), new Date(this.clock()));
      // Return failures so expiry/session closure commits even when a stale caller is rejected.
      let current: Receiver;
      try { current = await this.requireCurrent(tx, p, reference); }
      catch (error) { if (error instanceof HttpError) return { error }; throw error; }
      return { value: await fn(tx, current) };
    });
    if ('error' in result) { this.notify(); throw result.error; }
    return result.value;
  }
  async heartbeat(p: AgentPrincipal, body: unknown) {
    exactFields(body, ['receiver', 'accepting_sessions']);
    const reference = receiverReference(body.receiver);
    requireThat(typeof body.accepting_sessions === 'boolean', 'INVALID_REQUEST', 'accepting_sessions must be boolean.');
    const result = await this.withReceiver(p, reference, async (tx, r) => {
      const now = new Date(this.clock()), expires = new Date(now.getTime() + LEASE_MS);
      await tx.query('UPDATE agent_receivers SET last_heartbeat_at=$2,expires_at=$3,accepting_sessions=$4 WHERE agent_id=$1', [p.agent_id, now, expires, body.accepting_sessions]);
      const stopped = await tx.query<{ id: string }>(`SELECT s.id FROM agent_sessions s JOIN agent_session_bindings b ON b.session_id=s.id
        WHERE b.agent_id=$1 AND b.lease_id=$2 AND b.generation=$3 AND b.stopped_at IS NULL AND s.state IN ('closed','expired') ORDER BY s.id`,
        [p.agent_id, r.lease_id, r.generation]);
      return { protocol, receiver: ref(r), expires_at: expires, sessions_to_stop: stopped.rows.map(s => s.id) };
    });
    this.notify(); return result;
  }
  async release(p: AgentPrincipal, body: unknown) {
    exactFields(body, ['receiver']); const reference = receiverReference(body.receiver);
    const result = await this.db.transaction(async tx => {
      await this.lock(tx, p.agent_id); await this.authorized(tx, p);
      const r = await this.current(tx, p.agent_id);
      if (!r || r.lease_id !== reference.lease_id || r.generation !== reference.generation || r.credential_id !== p.credential_id) return false;
      await this.end(tx, r, new Date(this.clock())); return true;
    });
    this.notify(); requireThat(result, 'STALE_RECEIVER', 'Listener lease is no longer current.', 409);
    return { protocol, released: true as const };
  }
  async presence(id: string): Promise<Availability> {
    return this.db.transaction(async tx => {
      await this.lock(tx, id); const r = await this.current(tx, id);
      await this.expire(tx, r, new Date(this.clock()));
      if (!r || r.ended_at) return 'offline';
      try { await this.authorized(tx, { agent_id: id, credential_id: r.credential_id, display_name: '' }); }
      catch (e) { if (!(e instanceof HttpError)) throw e; await this.end(tx, r, new Date(this.clock())); return 'offline'; }
      if (!r.accepting_sessions) return 'paused';
      const count = await one<{ count: string }>(tx, 'SELECT count(*)::text AS count FROM agent_session_bindings WHERE agent_id=$1 AND lease_id=$2 AND generation=$3 AND stopped_at IS NULL',
        [id, r.lease_id, r.generation]);
      return Number(count!.count) >= DEFAULT_AGENT_LIMITS.max_concurrent_sessions ? 'busy' : 'available';
    });
  }
  async inbox(p: AgentPrincipal, reference: ReceiverReference, wait: number, signal?: AbortSignal) {
    integer(wait, 0, 20, 'wait');
    await this.withReceiver(p, reference, async () => {});
    requireThat(this.waiterTotal < 1000 && (this.waiters.get(p.agent_id)?.size ?? 0) < 3, 'RATE_LIMITED', 'Too many concurrent inbox polls.', 429);
    let pending = false, resume: (() => void) | undefined;
    const wake = () => { pending = true; resume?.(); };
    const listeners = this.waiters.get(p.agent_id) ?? new Set<() => void>();
    listeners.add(wake); this.waiters.set(p.agent_id, listeners); this.waiterTotal++;
    signal?.addEventListener('abort', wake, { once: true });
    const deadline = Date.now() + wait * 1000;
    try {
      while (true) {
        signal?.throwIfAborted(); requireThat(!this.closed, 'SERVICE_UNAVAILABLE', 'Server is shutting down.', 503);
        pending = false;
        const snapshot = await this.withReceiver(p, reference, async (tx, r) => {
          const rows = await tx.query<Omit<SessionSnapshot, 'limits'> & { limits_json: SessionSnapshot['limits'] }>(`SELECT s.id,s.initiator_agent_id,s.recipient_agent_id,s.state,s.version,s.created_at,s.offer_expires_at,s.expires_at,s.idle_expires_at,s.closed_at,s.close_reason,s.limits_json FROM agent_sessions s JOIN agent_session_bindings b ON b.session_id=s.id
            WHERE b.agent_id=$1 AND b.lease_id=$2 AND b.generation=$3 AND b.stopped_at IS NULL
            AND s.recipient_agent_id=$1 AND s.state='pending' AND s.offer_expires_at>$4 AND s.expires_at>$4 ORDER BY s.created_at,s.id LIMIT 10`,
            [p.agent_id, r.lease_id, r.generation, new Date(this.clock())]);
          return { expires: r.expires_at.getTime(), offers: rows.rows.map(({ limits_json, ...s }) => ({ ...s, limits: limits_json })) };
        });
        const remaining = Math.min(deadline - Date.now(), snapshot.expires - this.clock());
        if (snapshot.offers.length || remaining <= 0) return { protocol, offers: snapshot.offers };
        if (pending) continue;
        await new Promise<void>(resolve => {
          // DB fallback makes revocation and offers visible across process restarts
          // or separate notification scopes. No transaction is held while waiting.
          const timer = setTimeout(() => { resume = undefined; resolve(); }, Math.min(remaining, 1000));
          resume = () => { clearTimeout(timer); resume = undefined; resolve(); };
          if (pending || signal?.aborted) resume();
        });
      }
    } finally {
      signal?.removeEventListener('abort', wake); listeners.delete(wake); this.waiterTotal--;
      if (!listeners.size) this.waiters.delete(p.agent_id);
    }
  }
  async cleanup() {
    const rows = await this.db.query<{ agent_id: string }>(`SELECT r.agent_id FROM agent_receivers r JOIN agents a ON r.agent_id=a.id
      JOIN owners o ON a.owner_id=o.id JOIN agent_credentials c ON r.credential_id=c.id
      WHERE r.ended_at IS NULL AND (r.expires_at<=$1 OR a.disabled_at IS NOT NULL OR o.disabled_at IS NOT NULL OR c.revoked_at IS NOT NULL) ORDER BY r.agent_id`, [new Date(this.clock())]);
    for (const { agent_id } of rows.rows) await this.db.transaction(async tx => {
      await this.lock(tx, agent_id); const r = await this.current(tx, agent_id);
      if (!r || r.ended_at) return;
      await this.expire(tx, r, new Date(this.clock()));
      try { await this.authorized(tx, { agent_id, credential_id: r.credential_id, display_name: '' }); }
      catch (e) { if (!(e instanceof HttpError)) throw e; await this.end(tx, r, new Date(this.clock())); }
    });
    await this.db.query('DELETE FROM agent_connections WHERE ended_at<=$1', [new Date(this.clock() - CONNECTION_RETENTION_MS)]);
    if (rows.rows.length) this.notify();
  }
}
