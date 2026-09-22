import { one, type Queryable } from './db.js';
import { requireThat, uuid } from './validation.js';

export interface StoredMessage {
  id: string; sequence: number; sender_participant_id: string | null; sender_owner_id: string | null;
  sender_agent_id: string | null; client_message_id: string | null; content: string; created_at: Date;
}
export async function closeStoredSession(tx: Queryable, id: string) {
  await tx.query("UPDATE sessions SET status='CLOSED' WHERE id=$1", [id]);
}
/** Shared durable log and bounded read machinery. Authorization/admission stay in
 * the room and agent services; callers hold their required locks/transactions. */
export class SessionEngine {
  readonly waiters = new Map<string, Set<() => void>>();
  private counts = new Map<string, number>();
  private total = 0;
  private stopped = false;
  constructor(private maxWaiters = 1000) {}
  notify(id: string) { for (const wake of this.waiters.get(id) ?? []) wake(); }
  shutdown() { this.stopped = true; for (const id of this.waiters.keys()) this.notify(id); }
  async sequence(tx: Queryable, id: string, lock = false) {
    return (await one<{ next_sequence: number }>(tx, `SELECT next_sequence FROM sessions WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [id]))!.next_sequence;
  }
  async append(tx: Queryable, id: string, input: { participantId?: string | null; ownerId?: string | null; clientId?: string | null; content: string; now: Date }) {
    const sequence = await this.sequence(tx, id, true), messageId = uuid();
    await tx.query(`INSERT INTO messages(id,session_id,sender_participant_id,sender_owner_id,client_message_id,sequence,content,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [messageId, id, input.participantId ?? null, input.ownerId ?? null, input.clientId ?? null, sequence, input.content, input.now]);
    await tx.query('UPDATE sessions SET next_sequence=next_sequence+1 WHERE id=$1', [id]);
    return { id: messageId, sequence, created_at: input.now };
  }
  async read(tx: Queryable, id: string, after: number) {
    return (await tx.query<StoredMessage>(`SELECT m.id,m.sequence,m.sender_participant_id,m.sender_owner_id,p.agent_id AS sender_agent_id,
      m.client_message_id,m.content,m.created_at FROM messages m LEFT JOIN participants p ON p.id=m.sender_participant_id
      WHERE m.session_id=$1 AND m.sequence>$2 ORDER BY m.sequence LIMIT 100`, [id, after])).rows;
  }
  async close(tx: Queryable, id: string) { await closeStoredSession(tx, id); }
  async purgeTranscript(tx: Queryable, id: string) { await tx.query('DELETE FROM messages WHERE session_id=$1', [id]); }
  async remove(tx: Queryable, id: string) { await tx.query('DELETE FROM sessions WHERE id=$1', [id]); }
  async poll<T>(id: string, key: string, wait: number, read: () => Promise<{ value: T; ready: boolean; expiresIn?: number }>, signal?: AbortSignal, limitCode = 'RATE_LIMITED') {
    requireThat(this.total < this.maxWaiters && (this.counts.get(key) ?? 0) < 3, limitCode, 'Too many concurrent reads; retry later.', 429);
    let pending = false, resume: (() => void) | undefined;
    const wake = () => { pending = true; resume?.(); };
    const listeners = this.waiters.get(id) ?? new Set<() => void>(); listeners.add(wake); this.waiters.set(id, listeners);
    this.total++; this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
    signal?.addEventListener('abort', wake, { once: true }); const deadline = Date.now() + wait * 1000;
    try {
      while (true) {
        signal?.throwIfAborted(); requireThat(!this.stopped, 'SERVICE_UNAVAILABLE', 'Server is shutting down.', 503);
        pending = false; const result = await read();
        const remaining = Math.min(deadline - Date.now(), result.expiresIn ?? Infinity);
        if (result.ready || remaining <= 0) return result.value;
        if (pending) continue;
        await new Promise<void>(resolve => {
          const timer = setTimeout(() => { resume = undefined; resolve(); }, Math.min(1000, remaining));
          resume = () => { clearTimeout(timer); resume = undefined; resolve(); };
          if (pending || signal?.aborted) resume();
        });
      }
    } finally {
      signal?.removeEventListener('abort', wake); listeners.delete(wake); if (!listeners.size) this.waiters.delete(id);
      this.total--; const count = this.counts.get(key)! - 1; if (count) this.counts.set(key, count); else this.counts.delete(key);
    }
  }
}
