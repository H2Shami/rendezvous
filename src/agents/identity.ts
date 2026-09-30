import { one, type Database, type Queryable } from "../db.js";
import { and, eq, gt } from "drizzle-orm";
import { agents, agentCredentials as credentials } from "../schema.js";
import type { Security } from "../security.js";
import { exactFields, requireThat, secret, uuid } from "../validation.js";

export type AgentRecord = Omit<typeof agents.$inferSelect, "owner_id">;
export type CredentialRecord = Omit<
  typeof credentials.$inferSelect,
  "secret_hash"
>;
export interface AgentPrincipal {
  agent_id: string;
  credential_id: string;
  display_name: string;
}
/** Future lease/session changes must occur in this same transaction. Do not send
 * external notifications here: a hook failure rolls back the credential mutation. */
export type IdentityInvalidation =
  | { kind: "credential_revoked"; agent_id: string; credential_id: string }
  | { kind: "agent_disabled"; agent_id: string };
export type IdentityHooks = {
  invalidate?: (tx: Queryable, event: IdentityInvalidation) => Promise<void>;
};
const agentColumns = {
  id: agents.id,
  display_name: agents.display_name,
  created_at: agents.created_at,
  updated_at: agents.updated_at,
  disabled_at: agents.disabled_at,
};
const credentialColumns = {
  id: credentials.id,
  agent_id: credentials.agent_id,
  created_at: credentials.created_at,
  revoked_at: credentials.revoked_at,
  last_used_at: credentials.last_used_at,
};
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function agentId(value: string) {
  requireThat(uuidPattern.test(value), "INVALID_REQUEST", "Expected a UUID.");
  return value.toLowerCase();
}
function nameInput(body: unknown) {
  exactFields(body, ["display_name"]);
  const name = body.display_name;
  requireThat(
    typeof name === "string" &&
      name.trim().length > 0 &&
      [...name.trim()].length <= 100 &&
      !/[\u0000-\u001f\u007f]/.test(name),
    "INVALID_REQUEST",
    "display_name must contain 1–100 characters without control characters.",
  );
  return name.trim();
}
export interface IdentityPage {
  after?: string;
  limit: number;
}
export function identityPage(query: unknown): IdentityPage {
  exactFields(query, ["after", "limit"]);
  requireThat(
    query.limit === undefined ||
      (typeof query.limit === "string" &&
        /^(?:[1-9]\d?|100)$/.test(query.limit)),
    "INVALID_REQUEST",
    "limit must be 1–100.",
  );
  requireThat(
    query.after === undefined || typeof query.after === "string",
    "INVALID_REQUEST",
    "after must be a UUID.",
  );
  return {
    after: query.after === undefined ? undefined : agentId(query.after),
    limit: Number(query.limit ?? 50),
  };
}

export class AgentIdentityService {
  constructor(
    readonly db: Database,
    private auth: Security,
    private clock = Date.now,
    private hooks: IdentityHooks = {},
  ) {}
  private async owned(tx: Queryable, owner: string, id: string, lock = false) {
    const query = tx.orm
      .select(agentColumns)
      .from(agents)
      .where(and(eq(agents.id, agentId(id)), eq(agents.owner_id, owner)));
    const [agent] = await (lock ? query.for("update") : query);
    requireThat(agent, "NOT_FOUND", "Agent not found.", 404);
    return agent;
  }
  async create(owner: string, body: unknown) {
    const name = nameInput(body),
      now = new Date(this.clock());
    return (
      await this.db.orm
        .insert(agents)
        .values({
          id: uuid(),
          owner_id: owner,
          display_name: name,
          created_at: now,
          updated_at: now,
        })
        .returning(agentColumns)
    )[0];
  }
  async list(owner: string, page: IdentityPage) {
    const rows = await this.db.orm
      .select(agentColumns)
      .from(agents)
      .where(
        and(
          eq(agents.owner_id, owner),
          page.after ? gt(agents.id, page.after) : undefined,
        ),
      )
      .orderBy(agents.id)
      .limit(page.limit + 1);
    return {
      agents: rows.slice(0, page.limit),
      next_cursor: rows.length > page.limit ? rows[page.limit - 1].id : null,
    };
  }
  get(owner: string, id: string) {
    return this.owned(this.db, owner, id);
  }
  async update(owner: string, id: string, body: unknown) {
    const name = nameInput(body);
    return this.db.transaction(async (tx) => {
      await this.owned(tx, owner, id, true);
      return (
        await tx.orm
          .update(agents)
          .set({ display_name: name, updated_at: new Date(this.clock()) })
          .where(eq(agents.id, agentId(id)))
          .returning(agentColumns)
      )[0];
    });
  }
  async disable(owner: string, id: string) {
    return this.db.transaction(async (tx) => {
      const agent = await this.owned(tx, owner, id, true);
      if (agent.disabled_at) return agent;
      const now = new Date(this.clock());
      const [result] = await tx.orm
        .update(agents)
        .set({ disabled_at: now, updated_at: now })
        .where(eq(agents.id, agent.id))
        .returning(agentColumns);
      await this.hooks.invalidate?.(tx, {
        kind: "agent_disabled",
        agent_id: agent.id,
      });
      return result;
    });
  }
  async credentials(owner: string, id: string, page: IdentityPage) {
    const agent = await this.owned(this.db, owner, id);
    const rows = await this.db.orm
      .select(credentialColumns)
      .from(credentials)
      .where(
        and(
          eq(credentials.agent_id, agent.id),
          page.after ? gt(credentials.id, page.after) : undefined,
        ),
      )
      .orderBy(credentials.id)
      .limit(page.limit + 1);
    return {
      credentials: rows.slice(0, page.limit),
      next_cursor: rows.length > page.limit ? rows[page.limit - 1].id : null,
    };
  }
  private async issue(tx: Queryable, agent: AgentRecord) {
    requireThat(
      !agent.disabled_at,
      "AGENT_DISABLED",
      "Agent is disabled.",
      409,
    );
    const id = uuid(),
      value = secret();
    const [credential] = await tx.orm
      .insert(credentials)
      .values({
        id,
        agent_id: agent.id,
        secret_hash: this.auth.digest(`agent:credential:${id}:${value}`),
        created_at: new Date(this.clock()),
      })
      .returning(credentialColumns);
    return { credential, api_key: `agk_${id}.${value}` };
  }
  issueKey(owner: string, id: string) {
    return this.db.transaction(async (tx) =>
      this.issue(tx, await this.owned(tx, owner, id, true)),
    );
  }
  private async revoke(
    tx: Queryable,
    agent: AgentRecord,
    credentialId: string,
    rotating = false,
  ) {
    const [credential] = await tx.orm
      .select(credentialColumns)
      .from(credentials)
      .where(
        and(
          eq(credentials.id, agentId(credentialId)),
          eq(credentials.agent_id, agent.id),
        ),
      );
    requireThat(credential, "NOT_FOUND", "Credential not found.", 404);
    requireThat(
      !rotating || !credential.revoked_at,
      "CREDENTIAL_REVOKED",
      "Credential has already been revoked.",
      409,
    );
    if (credential.revoked_at) return credential;
    const [result] = await tx.orm
      .update(credentials)
      .set({ revoked_at: new Date(this.clock()) })
      .where(eq(credentials.id, credential.id))
      .returning(credentialColumns);
    await this.hooks.invalidate?.(tx, {
      kind: "credential_revoked",
      agent_id: agent.id,
      credential_id: credential.id,
    });
    return result;
  }
  revokeKey(owner: string, id: string, credentialId: string) {
    return this.db.transaction(async (tx) =>
      this.revoke(tx, await this.owned(tx, owner, id, true), credentialId),
    );
  }
  rotateKey(owner: string, id: string, credentialId: string) {
    return this.db.transaction(async (tx) => {
      const agent = await this.owned(tx, owner, id, true);
      await this.revoke(tx, agent, credentialId, true);
      return this.issue(tx, agent);
    });
  }
  async authenticate(token: string): Promise<AgentPrincipal> {
    const match = /^agk_([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/.exec(token);
    requireThat(
      match && uuidPattern.test(match[1]),
      "UNAUTHORIZED",
      "Invalid agent credential.",
      401,
    );
    const [credential] = await this.db.orm
      .select({ secret_hash: credentials.secret_hash })
      .from(credentials)
      .where(eq(credentials.id, match[1]));
    requireThat(
      this.auth.matches(
        `agent:credential:${match[1]}:${match[2]}`,
        credential?.secret_hash ?? "0".repeat(64),
      ),
      "UNAUTHORIZED",
      "Invalid agent credential.",
      401,
    );
    // Recheck all revocation/disable predicates when recording use, so a revoke
    // committed after the initial hash lookup cannot authenticate a new request.
    const principal = await one<AgentPrincipal>(
      this.db,
      `UPDATE agent_credentials c SET last_used_at=$2 FROM agents a,owners o
       WHERE c.id=$1 AND c.agent_id=a.id AND a.owner_id=o.id
       AND c.revoked_at IS NULL AND a.disabled_at IS NULL AND o.disabled_at IS NULL
       RETURNING a.id AS agent_id,c.id AS credential_id,a.display_name`,
      [match[1], new Date(this.clock())],
    );
    requireThat(principal, "UNAUTHORIZED", "Invalid agent credential.", 401);
    return principal;
  }
}
