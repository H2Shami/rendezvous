CREATE TABLE IF NOT EXISTS agents (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES owners(id),
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz
);
CREATE INDEX IF NOT EXISTS agents_owner ON agents(owner_id, id);
CREATE TABLE IF NOT EXISTS agent_credentials (
  id uuid PRIMARY KEY,
  agent_id uuid NOT NULL REFERENCES agents(id),
  secret_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  last_used_at timestamptz
);
CREATE INDEX IF NOT EXISTS agent_credentials_agent ON agent_credentials(agent_id, id);
