import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  integer,
  bigint,
  boolean,
  timestamp,
  json,
  jsonb,
  index,
  uniqueIndex,
  unique,
  primaryKey,
  check,
} from "drizzle-orm/pg-core";

const time = (name: string) =>
  timestamp(name, { withTimezone: true, mode: "date" });

export const owners = pgTable(
  "owners",
  {
    id: uuid().primaryKey(),
    issuer: text().notNull(),
    subject: text().notNull(),
    created_at: time("created_at").notNull().defaultNow(),
    disabled_at: time("disabled_at"),
  },
  (t) => [unique().on(t.issuer, t.subject)],
);

export const ownerLoginAttempts = pgTable(
  "owner_login_attempts",
  {
    state_hash: text().primaryKey(),
    browser_hash: text().notNull(),
    expires_at: time("expires_at").notNull(),
    flow: text().notNull().default("workos"),
  },
  (t) => [index("owner_login_expiry").on(t.expires_at)],
);

export const agents = pgTable(
  "agents",
  {
    id: uuid().primaryKey(),
    owner_id: uuid()
      .notNull()
      .references(() => owners.id),
    display_name: text().notNull(),
    created_at: time("created_at").notNull().defaultNow(),
    updated_at: time("updated_at").notNull().defaultNow(),
    disabled_at: time("disabled_at"),
  },
  (t) => [
    index("agents_owner").on(t.owner_id, t.id),
    check(
      "agents_display_name_check",
      sql`char_length(${t.display_name}) BETWEEN 1 AND 100`,
    ),
  ],
);

export const agentCredentials = pgTable(
  "agent_credentials",
  {
    id: uuid().primaryKey(),
    agent_id: uuid()
      .notNull()
      .references(() => agents.id),
    secret_hash: text().notNull(),
    created_at: time("created_at").notNull().defaultNow(),
    revoked_at: time("revoked_at"),
    last_used_at: time("last_used_at"),
  },
  (t) => [index("agent_credentials_agent").on(t.agent_id, t.id)],
);

export const sessions = pgTable(
  "sessions",
  {
    id: uuid().primaryKey(),
    status: text()
      .$type<"WAITING" | "ACTIVE" | "CLOSED">()
      .notNull()
      .default("WAITING"),
    owner_hash: text(),
    created_at: time("created_at").notNull().defaultNow(),
    expires_at: time("expires_at").notNull(),
    max_participants: integer().notNull(),
    next_sequence: integer().notNull().default(1),
  },
  (t) => [
    check(
      "sessions_status_check",
      sql`${t.status} IN ('WAITING','ACTIVE','CLOSED')`,
    ),
    check(
      "sessions_max_participants_check",
      sql`${t.max_participants} BETWEEN 1 AND 10`,
    ),
  ],
);

export const invites = pgTable(
  "invites",
  {
    id: uuid().primaryKey(),
    session_id: uuid()
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    secret_hash: text().notNull(),
    max_uses: integer().notNull(),
    use_count: integer().notNull().default(0),
    expires_at: time("expires_at").notNull(),
    revoked_at: time("revoked_at"),
    created_at: time("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("invites_session").on(t.session_id),
    check("invites_max_uses_check", sql`${t.max_uses} BETWEEN 1 AND 10`),
  ],
);

export const participants = pgTable(
  "participants",
  {
    id: uuid().primaryKey(),
    session_id: uuid()
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    credential_hash: text(),
    display_name: text(),
    metadata_json: json()
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    joined_at: time("joined_at").notNull().defaultNow(),
    revoked_at: time("revoked_at"),
    left_at: time("left_at"),
    last_seen_at: time("last_seen_at"),
    agent_id: uuid().references(() => agents.id),
  },
  (t) => [
    index("participants_session").on(t.session_id),
    uniqueIndex("participants_credential").on(t.session_id, t.credential_hash),
    uniqueIndex("participants_session_agent")
      .on(t.session_id, t.agent_id)
      .where(sql`${t.agent_id} IS NOT NULL`),
  ],
);

export const messages = pgTable(
  "messages",
  {
    id: uuid().primaryKey(),
    session_id: uuid()
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    sender_participant_id: uuid().references(() => participants.id),
    sender_owner_id: uuid().references(() => owners.id),
    sequence: integer().notNull(),
    content: text().notNull(),
    created_at: time("created_at").notNull().defaultNow(),
    client_message_id: uuid(),
  },
  (t) => [
    uniqueIndex("messages_session_sequence").on(t.session_id, t.sequence),
    uniqueIndex("messages_client_id")
      .on(t.session_id, t.sender_participant_id, t.client_message_id)
      .where(sql`${t.client_message_id} IS NOT NULL`),
    check(
      "messages_one_sender",
      sql`${t.sender_participant_id} IS NULL OR ${t.sender_owner_id} IS NULL`,
    ),
  ],
);

export const securityEvents = pgTable(
  "security_events",
  {
    id: bigint({ mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(),
    event: text().notNull(),
    session_id: uuid().references(() => sessions.id, { onDelete: "cascade" }),
    participant_id: uuid(),
    created_at: time("created_at").notNull().defaultNow(),
  },
  (t) => [index("security_events_time").on(t.created_at)],
);

export const agentReceivers = pgTable(
  "agent_receivers",
  {
    agent_id: uuid()
      .primaryKey()
      .references(() => agents.id, { onDelete: "cascade" }),
    lease_id: uuid().notNull().unique(),
    generation: bigint({ mode: "bigint" }).notNull(),
    credential_id: uuid()
      .notNull()
      .references(() => agentCredentials.id),
    expires_at: time("expires_at").notNull(),
    last_heartbeat_at: time("last_heartbeat_at").notNull(),
    accepting_sessions: boolean().notNull().default(true),
    ended_at: time("ended_at"),
  },
  (t) => [
    check("agent_receivers_generation_check", sql`${t.generation} > 0`),
    index("agent_receivers_expiry")
      .on(t.expires_at)
      .where(sql`${t.ended_at} IS NULL`),
  ],
);

export const agentConnections = pgTable(
  "agent_connections",
  {
    agent_id: uuid()
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    connection_id: uuid().notNull(),
    credential_id: uuid()
      .notNull()
      .references(() => agentCredentials.id),
    lease_id: uuid().notNull().unique(),
    generation: bigint({ mode: "bigint" }).notNull(),
    takeover: boolean().notNull(),
    ended_at: time("ended_at"),
  },
  (t) => [
    primaryKey({ columns: [t.agent_id, t.connection_id] }),
    index("agent_connections_ended")
      .on(t.ended_at)
      .where(sql`${t.ended_at} IS NOT NULL`),
  ],
);

export const agentSessions = pgTable(
  "agent_sessions",
  {
    id: uuid()
      .primaryKey()
      .references(() => sessions.id, { onDelete: "cascade" }),
    initiator_agent_id: uuid()
      .notNull()
      .references(() => agents.id),
    recipient_agent_id: uuid()
      .notNull()
      .references(() => agents.id),
    state: text()
      .$type<"pending" | "active" | "closed" | "expired">()
      .notNull(),
    version: integer().notNull().default(1),
    created_at: time("created_at").notNull(),
    offer_expires_at: time("offer_expires_at").notNull(),
    expires_at: time("expires_at").notNull(),
    idle_expires_at: time("idle_expires_at"),
    closed_at: time("closed_at"),
    close_reason: text(),
    limits_json: jsonb().notNull(),
    history_purged_at: time("history_purged_at"),
  },
  (t) => [
    check(
      "agent_sessions_state_check",
      sql`${t.state} IN ('pending','active','closed','expired')`,
    ),
    check(
      "agent_sessions_distinct_agents",
      sql`${t.initiator_agent_id} <> ${t.recipient_agent_id}`,
    ),
    index("agent_sessions_policy_pair")
      .on(t.initiator_agent_id, t.recipient_agent_id, t.id)
      .where(sql`${t.state} IN ('pending','active')`),
    index("agent_sessions_terminal")
      .on(t.closed_at)
      .where(sql`${t.closed_at} IS NOT NULL`),
  ],
);

export const agentSessionBindings = pgTable(
  "agent_session_bindings",
  {
    session_id: uuid()
      .notNull()
      .references(() => agentSessions.id, { onDelete: "cascade" }),
    agent_id: uuid()
      .notNull()
      .references(() => agents.id),
    lease_id: uuid().notNull(),
    generation: bigint({ mode: "bigint" }).notNull(),
    participant_id: uuid().references(() => participants.id, {
      onDelete: "cascade",
    }),
    binding_id: uuid(),
    stopped_at: time("stopped_at"),
  },
  (t) => [
    primaryKey({ columns: [t.session_id, t.agent_id] }),
    check("agent_bindings_generation_check", sql`${t.generation} > 0`),
    index("agent_bindings_receiver")
      .on(t.agent_id, t.lease_id, t.generation)
      .where(sql`${t.stopped_at} IS NULL`),
  ],
);

export const agentPeerPolicies = pgTable(
  "agent_peer_policies",
  {
    agent_id: uuid()
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    peer_agent_id: uuid()
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    allow_inbound: boolean().notNull().default(false),
    allow_outbound: boolean().notNull().default(false),
    created_at: time("created_at").notNull(),
    updated_at: time("updated_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.agent_id, t.peer_agent_id] }),
    check(
      "agent_peer_policies_distinct_agents",
      sql`${t.agent_id} <> ${t.peer_agent_id}`,
    ),
    index("agent_peer_policies_peer").on(t.peer_agent_id),
  ],
);

export const agentOperations = pgTable(
  "agent_operations",
  {
    agent_id: uuid()
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    idempotency_key: uuid().notNull(),
    fingerprint: text().notNull(),
    session_id: uuid()
      .notNull()
      .references(() => agentSessions.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.agent_id, t.idempotency_key] })],
);

export const agentMessageReceipts = pgTable(
  "agent_message_receipts",
  {
    session_id: uuid()
      .notNull()
      .references(() => agentSessions.id, { onDelete: "cascade" }),
    participant_id: uuid()
      .notNull()
      .references(() => participants.id, { onDelete: "cascade" }),
    client_message_id: uuid().notNull(),
    fingerprint: text().notNull(),
    id: uuid().notNull().unique(),
    sequence: integer().notNull(),
    sender_agent_id: uuid()
      .notNull()
      .references(() => agents.id),
    lease_id: uuid().notNull(),
    generation: bigint({ mode: "bigint" }).notNull(),
    created_at: time("created_at").notNull(),
  },
  (t) => [
    primaryKey({
      columns: [t.session_id, t.participant_id, t.client_message_id],
    }),
  ],
);
