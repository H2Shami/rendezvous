import type { Queryable } from '../db.js';
import type { CloseReason } from './protocol.js';

/** Caller holds the session row lock. Both explicit closure and invalidation use
 * this transition so an unaccepted recipient never retains phantom capacity. */
export async function closeAgentSession(tx: Queryable, id: string, reason: CloseReason, now: Date, expired = false) {
  const result = await tx.query<{ recipient_agent_id: string }>(`UPDATE agent_sessions SET state=$2,closed_at=$3,close_reason=$4,version=version+1
    WHERE id=$1 AND state IN ('pending','active') RETURNING recipient_agent_id`, [id, expired ? 'expired' : 'closed', now, reason]);
  if (!result.rows.length) return;
  await tx.query("UPDATE sessions SET status='CLOSED' WHERE id=$1", [id]);
  await tx.query(`UPDATE agent_session_bindings SET stopped_at=$3 WHERE session_id=$1 AND agent_id=$2
    AND binding_id IS NULL AND stopped_at IS NULL`, [id, result.rows[0].recipient_agent_id, now]);
}
