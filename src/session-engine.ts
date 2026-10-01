import { type Queryable } from "./db.js";
import { and, eq, gt, sql } from "drizzle-orm";
import { sessions, messages, participants } from "./schema.js";
import { requireThat, uuid } from "./validation.js";

export interface StoredMessage {
  id: string;
  sequence: number;
  sender_participant_id: string | null;
  sender_owner_id: string | null;
  sender_agent_id: string | null;
  client_message_id: string | null;
  content: string;
  created_at: Date;
}
export async function closeStoredSession(tx: Queryable, id: string) {
  await tx.orm
    .update(sessions)
    .set({ status: "CLOSED" })
    .where(eq(sessions.id, id));
}
/** Shared durable log and bounded read machinery. Authorization/admission stay in
 * the room and agent services; callers hold their required locks/transactions. */
export class SessionEngine {
  readonly waiters = new Map<string, Set<() => void>>();
  private counts = new Map<string, number>();
  private total = 0;
  private stopped = false;
  constructor(private maxWaiters = 1000) {}
  notify(id: string) {
    for (const wake of this.waiters.get(id) ?? []) wake();
  }
  shutdown() {
    this.stopped = true;
    for (const id of this.waiters.keys()) this.notify(id);
  }
  async sequence(tx: Queryable, id: string, lock = false) {
    const query = tx.orm
      .select({ next_sequence: sessions.next_sequence })
      .from(sessions)
      .where(eq(sessions.id, id));
    return (await (lock ? query.for("update") : query))[0].next_sequence;
  }
  async append(
    tx: Queryable,
    id: string,
    input: {
      participantId?: string | null;
      ownerId?: string | null;
      clientId?: string | null;
      content: string;
      now: Date;
    },
  ) {
    const sequence = await this.sequence(tx, id, true),
      messageId = uuid();
    await tx.orm
      .insert(messages)
      .values({
        id: messageId,
        session_id: id,
        sender_participant_id: input.participantId ?? null,
        sender_owner_id: input.ownerId ?? null,
        client_message_id: input.clientId ?? null,
        sequence,
        content: input.content,
        created_at: input.now,
      });
    await tx.orm
      .update(sessions)
      .set({ next_sequence: sql`${sessions.next_sequence} + 1` })
      .where(eq(sessions.id, id));
    return { id: messageId, sequence, created_at: input.now };
  }
  async read(tx: Queryable, id: string, after: number) {
    return tx.orm
      .select({
        id: messages.id,
        sequence: messages.sequence,
        sender_participant_id: messages.sender_participant_id,
        sender_owner_id: messages.sender_owner_id,
        sender_agent_id: participants.agent_id,
        client_message_id: messages.client_message_id,
        content: messages.content,
        created_at: messages.created_at,
      })
      .from(messages)
      .leftJoin(
        participants,
        eq(participants.id, messages.sender_participant_id),
      )
      .where(and(eq(messages.session_id, id), gt(messages.sequence, after)))
      .orderBy(messages.sequence)
      .limit(100);
  }
  async close(tx: Queryable, id: string) {
    await closeStoredSession(tx, id);
  }
  async purgeTranscript(tx: Queryable, id: string) {
    await tx.orm.delete(messages).where(eq(messages.session_id, id));
  }
  async remove(tx: Queryable, id: string) {
    await tx.orm.delete(sessions).where(eq(sessions.id, id));
  }
  async poll<T>(
    id: string,
    key: string,
    wait: number,
    read: () => Promise<{ value: T; ready: boolean; expiresIn?: number }>,
    signal?: AbortSignal,
    limitCode = "RATE_LIMITED",
  ) {
    requireThat(
      this.total < this.maxWaiters && (this.counts.get(key) ?? 0) < 3,
      limitCode,
      "Too many concurrent reads; retry later.",
      429,
    );
    let pending = false,
      resume: (() => void) | undefined;
    const wake = () => {
      pending = true;
      resume?.();
    };
    const listeners = this.waiters.get(id) ?? new Set<() => void>();
    listeners.add(wake);
    this.waiters.set(id, listeners);
    this.total++;
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
    signal?.addEventListener("abort", wake, { once: true });
    const deadline = Date.now() + wait * 1000;
    try {
      while (true) {
        signal?.throwIfAborted();
        requireThat(
          !this.stopped,
          "SERVICE_UNAVAILABLE",
          "Server is shutting down.",
          503,
        );
        pending = false;
        const result = await read();
        const remaining = Math.min(
          deadline - Date.now(),
          result.expiresIn ?? Infinity,
        );
        if (result.ready || remaining <= 0) return result.value;
        if (pending) continue;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(
            () => {
              resume = undefined;
              resolve();
            },
            Math.min(1000, remaining),
          );
          resume = () => {
            clearTimeout(timer);
            resume = undefined;
            resolve();
          };
          if (pending || signal?.aborted) resume();
        });
      }
    } finally {
      signal?.removeEventListener("abort", wake);
      listeners.delete(wake);
      if (!listeners.size) this.waiters.delete(id);
      this.total--;
      const count = this.counts.get(key)! - 1;
      if (count) this.counts.set(key, count);
      else this.counts.delete(key);
    }
  }
}
