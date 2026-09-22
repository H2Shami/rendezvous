import { closeAgentSession } from './session-lifecycle.js';
import { one, type Database, type Queryable } from '../db.js';
import { exactFields, requireThat } from '../validation.js';
import { agentId, type IdentityPage } from './identity.js';

export interface PeerPolicyRecord {
  agent_id: string; peer_agent_id: string; allow_inbound: boolean; allow_outbound: boolean;
  created_at: Date; updated_at: Date;
}
const columns = 'agent_id,peer_agent_id,allow_inbound,allow_outbound,created_at,updated_at';
const denied = () => requireThat(false, 'ACCESS_DENIED', 'Agent contact is not permitted.', 403);

export class AgentPolicyService {
  constructor(readonly db: Database, private clock = Date.now, private notify: (sessions: string[]) => void = () => {}) {}
  private pair(id: string, peer: string) {
    const ids = [agentId(id), agentId(peer)] as const;
    requireThat(ids[0] !== ids[1], 'INVALID_REQUEST', 'A peer must be a different agent.');
    return ids;
  }
  /** Acquire BEFORE session locks or individual agent locks, in every open/accept transaction. */
  async lockPair(tx: Queryable, id: string, peer: string) {
    const ids = this.pair(id, peer);
    await tx.query('SELECT id FROM agents WHERE id IN ($1,$2) ORDER BY id FOR UPDATE', [...ids]);
    return ids;
  }
  private async owned(tx: Queryable, owner: string, id: string) {
    const found = await one(tx, 'SELECT id FROM agents WHERE id=$1 AND owner_id=$2', [agentId(id), owner]);
    requireThat(found, 'NOT_FOUND', 'Agent not found.', 404);
  }
  /** Caller derives initiator from authenticated identity (open) or stored session (accept).
   * Holds both agent locks until the surrounding admission/accept transaction commits.
   * Still check credentials, leases, membership, session state and deadlines separately. */
  async requireAllowed(tx: Queryable, initiator: string, recipient: string) {
    const [a, b] = await this.lockPair(tx, initiator, recipient);
    const allowed = await one(tx, `SELECT p.agent_id FROM agent_peer_policies p
      JOIN agent_peer_policies q ON q.agent_id=p.peer_agent_id AND q.peer_agent_id=p.agent_id
      JOIN agents a ON a.id=p.agent_id JOIN owners ao ON ao.id=a.owner_id
      JOIN agents b ON b.id=p.peer_agent_id JOIN owners bo ON bo.id=b.owner_id
      WHERE p.agent_id=$1 AND p.peer_agent_id=$2 AND p.allow_outbound AND q.allow_inbound
      AND a.disabled_at IS NULL AND b.disabled_at IS NULL AND ao.disabled_at IS NULL AND bo.disabled_at IS NULL`, [a, b]);
    if (!allowed) denied(); // Same response for missing, disabled and ungranted peers. No presence lookup.
  }
  async list(owner: string, id: string, page: IdentityPage) {
    id = agentId(id); await this.owned(this.db, owner, id);
    const rows = (await this.db.query<PeerPolicyRecord>(`SELECT ${columns} FROM agent_peer_policies
      WHERE agent_id=$1 AND ($2::uuid IS NULL OR peer_agent_id>$2) ORDER BY peer_agent_id LIMIT $3`,
      [id, page.after ?? null, page.limit + 1])).rows;
    return { policies: rows.slice(0, page.limit), next_cursor: rows.length > page.limit ? rows[page.limit - 1].peer_agent_id : null };
  }
  async get(owner: string, id: string, peer: string) {
    [id, peer] = this.pair(id, peer); await this.owned(this.db, owner, id);
    const policy = await one<PeerPolicyRecord>(this.db, `SELECT ${columns} FROM agent_peer_policies WHERE agent_id=$1 AND peer_agent_id=$2`, [id, peer]);
    requireThat(policy, 'NOT_FOUND', 'Policy not found.', 404);
    return policy;
  }
  private async closeDenied(tx: Queryable, id: string, peer: string, inbound: boolean, outbound: boolean) {
    const sessions = await tx.query<{ id: string; state: string; recipient_agent_id: string }>(`SELECT id,state,recipient_agent_id FROM agent_sessions
      WHERE state IN ('pending','active') AND
      ((initiator_agent_id=$1 AND recipient_agent_id=$2 AND NOT $4::boolean) OR
       (initiator_agent_id=$2 AND recipient_agent_id=$1 AND NOT $3::boolean)) ORDER BY id FOR UPDATE`, [id, peer, inbound, outbound]);
    const now = new Date(this.clock());
    for (const s of sessions.rows) {
      await closeAgentSession(tx, s.id, 'ACCESS_REVOKED', now);
    }
    return sessions.rows.map(s => s.id);
  }
  async put(owner: string, id: string, peer: string, body: unknown) {
    [id, peer] = this.pair(id, peer);
    exactFields(body, ['allow_inbound', 'allow_outbound']);
    requireThat(typeof body.allow_inbound === 'boolean' && typeof body.allow_outbound === 'boolean',
      'INVALID_REQUEST', 'allow_inbound and allow_outbound must be booleans.');
    const { allow_inbound: inbound, allow_outbound: outbound } = body;
    const result = await this.db.transaction(async tx => {
      await this.owned(tx, owner, id);
      await this.lockPair(tx, id, peer); await this.owned(tx, owner, id);
      // No public peer profile or presence is returned by policy management.
      const exists = await one(tx, 'SELECT id FROM agents WHERE id=$1', [peer]);
      if (!exists) denied();
      const policy = (await one<PeerPolicyRecord>(tx, `INSERT INTO agent_peer_policies(agent_id,peer_agent_id,allow_inbound,allow_outbound,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,$5) ON CONFLICT(agent_id,peer_agent_id) DO UPDATE SET allow_inbound=$3,allow_outbound=$4,updated_at=$5 RETURNING ${columns}`,
        [id, peer, inbound, outbound, new Date(this.clock())]))!;
      return { policy, sessions: await this.closeDenied(tx, id, peer, inbound, outbound) };
    });
    this.notify(result.sessions); return result.policy;
  }
  async delete(owner: string, id: string, peer: string) {
    [id, peer] = this.pair(id, peer);
    const sessions = await this.db.transaction(async tx => {
      await this.owned(tx, owner, id);
      await this.lockPair(tx, id, peer); await this.owned(tx, owner, id);
      await tx.query('DELETE FROM agent_peer_policies WHERE agent_id=$1 AND peer_agent_id=$2', [id, peer]);
      return this.closeDenied(tx, id, peer, false, false);
    });
    this.notify(sessions); return { deleted: true as const };
  }
}
