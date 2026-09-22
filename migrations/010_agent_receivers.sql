CREATE TABLE IF NOT EXISTS agent_receivers (
  agent_id uuid PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  lease_id uuid NOT NULL UNIQUE,
  generation bigint NOT NULL CHECK (generation > 0),
  credential_id uuid NOT NULL REFERENCES agent_credentials(id),
  expires_at timestamptz NOT NULL,
  last_heartbeat_at timestamptz NOT NULL,
  accepting_sessions boolean NOT NULL DEFAULT true,
  ended_at timestamptz
);
CREATE INDEX IF NOT EXISTS agent_receivers_expiry ON agent_receivers(expires_at) WHERE ended_at IS NULL;
CREATE TABLE IF NOT EXISTS agent_connections (
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL,
  credential_id uuid NOT NULL REFERENCES agent_credentials(id),
  lease_id uuid NOT NULL UNIQUE,
  generation bigint NOT NULL,
  takeover boolean NOT NULL,
  ended_at timestamptz,
  PRIMARY KEY (agent_id, connection_id)
);
CREATE INDEX IF NOT EXISTS agent_connections_ended ON agent_connections(ended_at) WHERE ended_at IS NOT NULL;
-- Shared offer/binding foundation. REN-10 supplies admission and message routes.
CREATE TABLE IF NOT EXISTS agent_sessions (
  id uuid PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  initiator_agent_id uuid NOT NULL REFERENCES agents(id),
  recipient_agent_id uuid NOT NULL REFERENCES agents(id),
  state text NOT NULL CHECK (state IN ('pending','active','closed','expired')),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL,
  offer_expires_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  idle_expires_at timestamptz,
  closed_at timestamptz,
  close_reason text,
  limits_json jsonb NOT NULL,
  CHECK (initiator_agent_id <> recipient_agent_id)
);
CREATE TABLE IF NOT EXISTS agent_session_bindings (
  session_id uuid NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agents(id),
  lease_id uuid NOT NULL,
  generation bigint NOT NULL CHECK (generation > 0),
  participant_id uuid REFERENCES participants(id),
  binding_id uuid,
  stopped_at timestamptz,
  PRIMARY KEY (session_id, agent_id)
);
CREATE INDEX IF NOT EXISTS agent_bindings_receiver ON agent_session_bindings(agent_id,lease_id,generation) WHERE stopped_at IS NULL;
