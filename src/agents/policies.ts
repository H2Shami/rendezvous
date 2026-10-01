import { closeAgentSession } from "./session-lifecycle.js";
import { one, type Database, type Queryable } from "../db.js";
import { exactFields, requireThat } from "../validation.js";
import { agentId, type IdentityPage } from "./identity.js";
import { and, eq, gt, inArray } from "drizzle-orm";
import { agents, agentPeerPolicies as policies } from "../schema.js";

export type PeerPolicyRecord = typeof policies.$inferSelect;
const denied = () =>
  requireThat(false, "ACCESS_DENIED", "Agent contact is not permitted.", 403);

export class AgentPolicyService {
  constructor(
    readonly db: Database,
    private clock = Date.now,
    private notify: (sessions: string[]) => void = () => {},
  ) {}
  private pair(id: string, peer: string) {
    const ids = [agentId(id), agentId(peer)] as const;
    requireThat(
      ids[0] !== ids[1],
      "INVALID_REQUEST",
      "A peer must be a different agent.",
    );
    return ids;
  }
  /** Acquire BEFORE session locks or individual agent locks, in every open/accept transaction. */
  async lockPair(tx: Queryable, id: string, peer: string) {
    const ids = this.pair(id, peer);
    await tx.orm
      .select({ id: agents.id })
      .from(agents)
      .where(inArray(agents.id, [...ids]))
      .orderBy(agents.id)
      .for("update");
    return ids;
  }
  private async owned(tx: Queryable, owner: string, id: string) {
    const [found] = await tx.orm
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, agentId(id)), eq(agents.owner_id, owner)));
    requireThat(found, "NOT_FOUND", "Agent not found.", 404);
  }
  /** Caller derives initiator from authenticated identity (open) or stored session (accept).
   * Holds both agent locks until the surrounding admission/accept transaction commits.
   * Still check credentials, leases, membership, session state and deadlines separately. */
  async requireAllowed(tx: Queryable, initiator: string, recipient: string) {
    const [a, b] = await this.lockPair(tx, initiator, recipient);
    const allowed = await one(
      tx,
      `SELECT p.agent_id FROM agent_peer_policies p
      JOIN agent_peer_policies q ON q.agent_id=p.peer_agent_id AND q.peer_agent_id=p.agent_id
      JOIN agents a ON a.id=p.agent_id JOIN owners ao ON ao.id=a.owner_id
      JOIN agents b ON b.id=p.peer_agent_id JOIN owners bo ON bo.id=b.owner_id
      WHERE p.agent_id=$1 AND p.peer_agent_id=$2 AND p.allow_outbound AND q.allow_inbound
      AND a.disabled_at IS NULL AND b.disabled_at IS NULL AND ao.disabled_at IS NULL AND bo.disabled_at IS NULL`,
      [a, b],
    );
    if (!allowed) denied(); // Same response for missing, disabled and ungranted peers. No presence lookup.
  }
  /** Runtime discovery exposes only peers this identity is mutually allowed to contact. */
  async contacts(id: string, page: IdentityPage) {
    const rows = (
      await this.db.query<{ id: string; display_name: string }>(
        `SELECT b.id,b.display_name
      FROM agent_peer_policies p
      JOIN agent_peer_policies q ON q.agent_id=p.peer_agent_id AND q.peer_agent_id=p.agent_id
      JOIN agents a ON a.id=p.agent_id JOIN owners ao ON ao.id=a.owner_id
      JOIN agents b ON b.id=p.peer_agent_id JOIN owners bo ON bo.id=b.owner_id
      WHERE p.agent_id=$1 AND p.allow_outbound AND q.allow_inbound
      AND a.disabled_at IS NULL AND b.disabled_at IS NULL AND ao.disabled_at IS NULL AND bo.disabled_at IS NULL
      AND ($2::uuid IS NULL OR b.id>$2) ORDER BY b.id LIMIT $3`,
        [agentId(id), page.after ?? null, page.limit + 1],
      )
    ).rows;
    return {
      peers: rows.slice(0, page.limit),
      next_cursor: rows.length > page.limit ? rows[page.limit - 1].id : null,
    };
  }
  async list(owner: string, id: string, page: IdentityPage) {
    id = agentId(id);
    await this.owned(this.db, owner, id);
    const rows = await this.db.orm
      .select()
      .from(policies)
      .where(
        and(
          eq(policies.agent_id, id),
          page.after ? gt(policies.peer_agent_id, page.after) : undefined,
        ),
      )
      .orderBy(policies.peer_agent_id)
      .limit(page.limit + 1);
    return {
      policies: rows.slice(0, page.limit),
      next_cursor:
        rows.length > page.limit ? rows[page.limit - 1].peer_agent_id : null,
    };
  }
  async get(owner: string, id: string, peer: string) {
    [id, peer] = this.pair(id, peer);
    await this.owned(this.db, owner, id);
    const [policy] = await this.db.orm
      .select()
      .from(policies)
      .where(and(eq(policies.agent_id, id), eq(policies.peer_agent_id, peer)));
    requireThat(policy, "NOT_FOUND", "Policy not found.", 404);
    return policy;
  }
  private async closeDenied(
    tx: Queryable,
    id: string,
    peer: string,
    inbound: boolean,
    outbound: boolean,
  ) {
    const sessions = await tx.query<{
      id: string;
      state: string;
      recipient_agent_id: string;
    }>(
      `SELECT id,state,recipient_agent_id FROM agent_sessions
      WHERE state IN ('pending','active') AND
      ((initiator_agent_id=$1 AND recipient_agent_id=$2 AND NOT $4::boolean) OR
       (initiator_agent_id=$2 AND recipient_agent_id=$1 AND NOT $3::boolean)) ORDER BY id FOR UPDATE`,
      [id, peer, inbound, outbound],
    );
    const now = new Date(this.clock());
    for (const s of sessions.rows) {
      await closeAgentSession(tx, s.id, "ACCESS_REVOKED", now);
    }
    return sessions.rows.map((s) => s.id);
  }
  async put(owner: string, id: string, peer: string, body: unknown) {
    [id, peer] = this.pair(id, peer);
    exactFields(body, ["allow_inbound", "allow_outbound"]);
    requireThat(
      typeof body.allow_inbound === "boolean" &&
        typeof body.allow_outbound === "boolean",
      "INVALID_REQUEST",
      "allow_inbound and allow_outbound must be booleans.",
    );
    const { allow_inbound: inbound, allow_outbound: outbound } = body;
    const result = await this.db.transaction(async (tx) => {
      await this.owned(tx, owner, id);
      await this.lockPair(tx, id, peer);
      await this.owned(tx, owner, id);
      // No public peer profile or presence is returned by policy management.
      const [exists] = await tx.orm
        .select({ id: agents.id })
        .from(agents)
        .where(eq(agents.id, peer));
      if (!exists) denied();
      const now = new Date(this.clock());
      const [policy] = await tx.orm
        .insert(policies)
        .values({
          agent_id: id,
          peer_agent_id: peer,
          allow_inbound: inbound,
          allow_outbound: outbound,
          created_at: now,
          updated_at: now,
        })
        .onConflictDoUpdate({
          target: [policies.agent_id, policies.peer_agent_id],
          set: {
            allow_inbound: inbound,
            allow_outbound: outbound,
            updated_at: now,
          },
        })
        .returning();
      return {
        policy,
        sessions: await this.closeDenied(tx, id, peer, inbound, outbound),
      };
    });
    this.notify(result.sessions);
    return result.policy;
  }
  async delete(owner: string, id: string, peer: string) {
    [id, peer] = this.pair(id, peer);
    const sessions = await this.db.transaction(async (tx) => {
      await this.owned(tx, owner, id);
      await this.lockPair(tx, id, peer);
      await this.owned(tx, owner, id);
      await tx.orm
        .delete(policies)
        .where(
          and(eq(policies.agent_id, id), eq(policies.peer_agent_id, peer)),
        );
      return this.closeDenied(tx, id, peer, false, false);
    });
    this.notify(sessions);
    return { deleted: true as const };
  }
}
